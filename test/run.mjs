#!/usr/bin/env node
/**
 * Test suite for the deterministic parts of the pipeline — everything that must
 * behave identically given identical inputs. Runs offline in under a second: no
 * network, no API keys, no model calls.
 *
 *   npm test
 *
 * Cases marked REGRESSION guard a bug that actually shipped and was caught here.
 * Cases marked PROFILE assert a requirement stated in docs/PROFILE.md.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pickProvider } from '../src/providers/index.js';
import { extractJson } from '../src/providers/json-util.js';
import { toGeminiSchema } from '../src/providers/gemini.js';
import * as heuristic from '../src/providers/heuristic.js';
import { scoreCandidates, computeRelevance, computeQuality, computeIntegrity, computeScore, readEnums, DIMENSIONS } from '../src/score.js';
import { selectStories, corroborationBonus, allocationBonus, rollingMix, threadAdvanced } from '../src/select.js';
import { normalize, prefilter, canonicalUrl, titleFingerprint } from '../src/normalize.js';
import { renderHtml } from '../src/render.js';
import { openThreads, updateThreads, emptyWeights } from '../src/history.js';
import { urgencyScore, impactScore, selectAlerts, alertKey, alertRecord, renderAlert, MAX_ALERTS_PER_DAY, alertWindowHours, majorCorroboration, dedupeAlertItems } from '../src/alert.js';
import { quakeMattersTo, distanceKm, nearbyQuakes } from '../src/quakes.js';
import { maskAddress } from '../src/mail.js';
import { applyFeedbackForTest, SIGNAL_NAMES, collectFeedback, parseSubject } from '../src/feedback.js';
import { rebuildFromSelection, writeDigest } from '../src/write.js';
import { eventCoverage } from '../src/select.js';
import { lookbackFromHistory, loadHistory } from '../src/history.js';
import { runCli, cliEnv } from '../src/providers/claude-code.js';
import { historyBlock } from '../src/providers/format.js';
import { createUsageTracker } from '../src/usage.js';
import { mergeDuplicateEvents, applyGroups, lexicalGroups, salientTokens } from '../src/events.js';
import worker, { plan as plan0, dispatch as triggerDispatch, runJob as triggerRunJob } from '../cloudflare/trigger/src/index.js';
// The hour tests below are written in US Eastern (EDT/EST). The shipped Worker default is your own zone.
const triggerPlan = (d) => plan0(d, 'America/New_York');
import { writeFile as writeFileT, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = () => {};
let failures = 0;
let count = 0;

function ck(name, ok) {
  count++;
  if (!ok) failures++;
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
}
const section = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const threw = (fn) => { try { fn(); return false; } catch { return true; } };

const prefs = JSON.parse(await readFile(join(ROOT, 'config/preferences.json'), 'utf8'));
const feedsCfg = JSON.parse(await readFile(join(ROOT, 'config/feeds.json'), 'utf8'));
const scoringSchema = JSON.parse(await readFile(join(ROOT, 'schema/scoring_schema.json'), 'utf8'));
prefs._feedbackWeights = emptyWeights();

/** A dimension vector with everything at zero except what's named. */
const dims = (o = {}) => Object.fromEntries(DIMENSIONS.map((d) => [d, o[d] ?? 0]));
const rel = (o) => computeRelevance(dims(o), prefs.relevance);

// ─────────────────────────────────────────────────────── scoring shape
section('scoring: peak-blended relevance');

ck('PROFILE: one strong reason outranks several mediocre ones',
  rel({ property: 10 }) > rel({ financial_impact: 4, career_impact: 4, investment: 4, decision_change: 4, business_opportunity: 4, magnitude: 4 }));

ck('  (property-only ~59 vs broad-mediocre ~36)',
  Math.round(rel({ property: 10 })) === 59 && Math.round(rel({ financial_impact: 4, career_impact: 4, investment: 4, decision_change: 4, business_opportunity: 4, magnitude: 4 })) === 36);

ck('peak_gain=0 degenerates to a plain weighted sum', (() => {
  const cfg = { ...prefs.relevance, peak_gain: 0 };
  const story = dims({ financial_impact: 8, career_impact: 4, novelty: 6 });
  let wsum = 0, wtot = 0;
  for (const d of DIMENSIONS) wtot += cfg.dimensions[d].weight;
  for (const d of DIMENSIONS) wsum += (cfg.dimensions[d].weight / wtot) * story[d];
  return Math.abs(computeRelevance(story, cfg) - wsum * 10) < 0.001;
})());

ck('PROFILE: novelty alone can never justify inclusion (peak_eligibility 0)', rel({ novelty: 10 }) < 20);
ck('PROFILE: geography alone can never justify inclusion', rel({ geographic: 10 }) < 25);
ck('REGRESSION: magnitude alone cannot lead (the anti-anxiety rule)', rel({ magnitude: 10 }) < 25);
ck('fully peak-eligible single-dimension stories land in a tight band', (() => {
  const vals = DIMENSIONS
    .filter((d) => (prefs.relevance.dimensions[d].peak_eligibility ?? 1) === 1)
    .map((d) => rel({ [d]: 10 }));
  return Math.min(...vals) >= 57 && Math.max(...vals) <= 64;
})());
ck('partially eligible dimensions sit below the fully eligible ones',
  rel({ business_opportunity: 10 }) < rel({ property: 10 }));
ck('a strong broad story outranks every single-dimension story',
  rel(Object.fromEntries(DIMENSIONS.map((d) => [d, 7]))) > Math.max(...DIMENSIONS.map((d) => rel({ [d]: 10 }))));
ck('relevance is bounded at 100', rel(Object.fromEntries(DIMENSIONS.map((d) => [d, 10]))) <= 100);
ck('relevance is monotone — raising any dimension never lowers the score', (() => {
  const base = dims({ financial_impact: 5, career_impact: 3 });
  return DIMENSIONS.every((d) => computeRelevance({ ...base, [d]: (base[d] ?? 0) + 1 }, prefs.relevance) >= computeRelevance(base, prefs.relevance) - 1e-9);
})());
ck('empty vector scores zero', rel({}) === 0);

// ─────────────────────────────────────────────────── source quality
section('source quality');

const q = (classes, flags = []) => computeQuality({ sourcing_flags: flags }, { source_classes: classes }, prefs);
ck('primary beats aggregator', q(['primary']) > q(['aggregator']));
ck('PROFILE: a cluster takes the BEST class among its members',
  q(['aggregator', 'primary']) === q(['primary']));
ck('  (an aggregator that broke a story is lifted by real corroboration)',
  q(['aggregator']) === 0.6 && q(['aggregator', 'primary']) === 1.0);
ck('model flags can demote', q(['primary'], ['press_release']) < q(['primary']));
ck('model flags can never promote', q(['aggregator'], []) >= q(['aggregator'], ['press_release']));
ck('demotion is floored, so one flag cannot zero a source',
  q(['primary'], ['press_release', 'unnamed_sources_only', 'rehosted_social_claim', 'no_primary_link']) >= 1.0 * (prefs.source_quality.model_floor_ratio ?? 0.6) - 1e-9);
ck('unknown class falls back rather than crashing', q(['nonsense']) > 0);

ck('REGRESSION: source_class did not skew the lean balance', (() => {
  const M = prefs.source_quality.multipliers;
  const L = new Set(['left', 'center-left']), R = new Set(['right', 'center-right']);
  const mean = (set) => {
    const v = feedsCfg.feeds.filter((f) => set.has(f.lean)).map((f) => M[f.source_class]);
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  return Math.abs(mean(L) - mean(R)) <= 0.1;
})());
ck('every feed carries a known source_class',
  feedsCfg.feeds.every((f) => prefs.source_quality.multipliers[f.source_class] != null));
ck('no feed sits below the aggregator floor',
  feedsCfg.feeds.every((f) => prefs.source_quality.multipliers[f.source_class] >= 0.6));

// ────────────────────────────────────────────────────────── integrity
section('integrity (framing penalties)');
const integ = (flags) => computeIntegrity({ framing_flags: flags }, prefs);
ck('clean story is unpenalized', integ([]) === 1);
ck('routine filler is heavily penalized', integ(['routine_filler']) < 0.6);
ck('penalties compound', integ(['sensationalism', 'opinion_only']) < integ(['sensationalism']));
ck('penalty is floored', integ(['routine_filler', 'engagement_bait', 'outrage_bait', 'sensationalism']) >= prefs.integrity.floor - 1e-9);
ck('REGRESSION: penalty is multiplicative, not subtractive', (() => {
  // The same flag must cost proportionally, not a flat number of points.
  const strong = computeScore({ ...dims({ financial_impact: 9, decision_change: 8 }), category: 'finance', geography: 'us', framing_flags: ['sensationalism'], sourcing_flags: [] }, { source_classes: ['primary'] }, prefs);
  const weak = computeScore({ ...dims({ financial_impact: 3 }), category: 'finance', geography: 'us', framing_flags: ['sensationalism'], sourcing_flags: [] }, { source_classes: ['primary'] }, prefs);
  const strongClean = computeScore({ ...dims({ financial_impact: 9, decision_change: 8 }), category: 'finance', geography: 'us', framing_flags: [], sourcing_flags: [] }, { source_classes: ['primary'] }, prefs);
  const weakClean = computeScore({ ...dims({ financial_impact: 3 }), category: 'finance', geography: 'us', framing_flags: [], sourcing_flags: [] }, { source_classes: ['primary'] }, prefs);
  return (strongClean.total_score - strong.total_score) > (weakClean.total_score - weak.total_score);
})());

// ──────────────────────────────────────────────────────── enum sourcing
section('schema as the single source of enum truth');
const enums = readEnums(scoringSchema);
ck('categories read off the schema', enums.categories.has('quality_of_life') && enums.categories.size === 7);
ck('geographies read off the schema', enums.geographies.has('property_area') && enums.geographies.size === 5);
ck('development stages read off the schema', enums.stages.has('proposed') && enums.stages.size === 5);
ck('REGRESSION: enums genuinely come from the schema, not a copy', (() => {
  // Editing the schema must change what the scorer accepts. A hardcoded copy
  // would ignore this and silently drift.
  const edited = structuredClone(scoringSchema);
  edited.properties.stories.items.properties.category.enum = ['only_this'];
  const e = readEnums(edited);
  return e.categories.has('only_this') && !e.categories.has('finance') && e.categories.size === 1;
})());
ck('flag enums are read from items, not the array property',
  enums.framingFlags.has('sensationalism') && enums.sourcingFlags.has('press_release'));

// ─────────────────────────────────────────────── untrusted model output
section('untrusted model output');
const stub = {
  name: 'stub', label: 'stub', concurrency: 2,
  scoreBatch: async ({ payload }) => [
    { id: payload[0].id, event_key: 'Fed Holds!! Rates', continues_thread: 'invented-thread', clean_title: 'x',
      category: 'INVALID', geography: 'mars', development_stage: 'vibes',
      financial_impact: 99, career_impact: -5, investment: 3, decision_change: 3,
      business_opportunity: 3, property: 3, home_purchase: 3, magnitude: 3, geographic: 3, novelty: 3,
      sourcing_flags: 'notarray', framing_flags: ['not_a_real_flag', 'sensationalism'],
      prompt_injection_attempt: 'yes', evidence_stage: 'nonsense', include_candidate: true, why_it_matters: 'w' },
    { id: 'hallucinated', event_key: 'x', continues_thread: null, clean_title: 'x', category: 'ai', geography: 'us',
      development_stage: 'occurred', ...dims({ financial_impact: 1 }),
      sourcing_flags: [], framing_flags: [], prompt_injection_attempt: false,
      evidence_stage: 'not_applicable', include_candidate: true, why_it_matters: '' },
  ],
};
const oneCandidate = [{ id: 'c1', title: 'T', url: 'https://e.com', snippet: '', source: 'S', feed_id: 'f', track: 'finance', tier: 1, lean: 'center', leans: ['center'], source_class: 'primary', source_classes: ['primary'], published_at: Date.now(), supporting: [] }];
const san = await scoreCandidates(oneCandidate, { prompt: 'p', schema: scoringSchema, preferences: prefs, historyText: '', historyKeys: new Set(), openThreads: [], provider: stub, chain: [stub], log });
ck('hallucinated story id is dropped', san.scored.length === 1);
ck('invalid category coerced', enums.categories.has(san.scored[0].category));
ck('invalid geography coerced', san.scored[0].geography === 'not_applicable');
ck('invalid development_stage coerced', enums.stages.has(san.scored[0].development_stage));
ck('event_key slugified', san.scored[0].event_key === 'fed-holds-rates');
ck('REGRESSION: invented thread key rejected', san.scored[0].continues_thread === null);
ck('out-of-range dimensions clamped', san.scored[0].financial_impact === 10 && san.scored[0].career_impact === 0);
ck('non-array flags coerced', Array.isArray(san.scored[0].sourcing_flags) && san.scored[0].sourcing_flags.length === 0);
ck('unknown flag values dropped, known ones kept', san.scored[0].framing_flags.join() === 'sensationalism');
ck('non-boolean injection flag coerced', san.scored[0].prompt_injection_attempt === false);
ck('top_dimension recorded for feedback routing', san.scored[0].top_dimension === 'financial_impact');

section('provider failure cascade');
let calls = 0;
const failing = { name: 'failing', label: 'failing', concurrency: 1, scoreBatch: async () => { calls++; throw new Error('boom'); } };
const rescued = await scoreCandidates(oneCandidate, { prompt: 'p', schema: scoringSchema, preferences: prefs, historyText: '', historyKeys: new Set(), openThreads: [], provider: failing, chain: [failing, heuristic], log, retryDelayMs: 0 });
ck('retries three times before falling back', calls === 3);
ck('failed batch is rescued, not dropped', rescued.scored.length === 1);
ck('fallback reported in meta', rescued.meta.rescued === 1);

// ────────────────────────────────────────────────────────── selection
section('selection');
const mkSel = (o) => ({
  ...dims(o.d ?? {}), category: 'politics', geography: 'us', development_stage: 'occurred',
  include_candidate: true, prompt_injection_attempt: false, sourcing_flags: [], framing_flags: [],
  evidence_stage: 'not_applicable', lean: 'center', leans: ['center'], source_classes: ['original_reporting'],
  supporting: [], snippet: '', published_at: Date.now(), source: 'X',
  url: 'https://e.com/' + (o.event_key ?? 'x'), clean_title: o.event_key, continues_thread: null,
  ...o,
});
const bigPool = [
  ...Array.from({ length: 10 }, (_, i) => mkSel({ event_key: `fin${i}`, category: 'finance', total_score: 90 - i })),
  ...Array.from({ length: 6 }, (_, i) => mkSel({ event_key: `ai${i}`, category: 'ai', total_score: 70 - i })),
  ...Array.from({ length: 4 }, (_, i) => mkSel({ event_key: `qol${i}`, category: 'quality_of_life', total_score: 40 - i })),
  ...Array.from({ length: 4 }, (_, i) => mkSel({ event_key: `mi${i}`, category: 'politics', geography: 'home_region', d: { geographic: 8 }, total_score: 38 - i })),
  ...Array.from({ length: 3 }, (_, i) => mkSel({ event_key: `br${i}`, category: 'finance', geography: 'property', total_score: 36 - i })),
  mkSel({ event_key: 'prop1', category: 'politics', development_stage: 'proposed', total_score: 60 }),
  mkSel({ event_key: 'prop2', category: 'ai', development_stage: 'pending', total_score: 55 }),
  mkSel({ event_key: 'inject', category: 'ai', total_score: 99, prompt_injection_attempt: true }),
  mkSel({ event_key: 'floor', category: 'ai', total_score: 3 }),
  mkSel({ event_key: 'dupe', category: 'finance', total_score: 88 }),
  mkSel({ event_key: 'dupe', category: 'finance', total_score: 80, url: 'https://other.com/dupe' }),
];
const emptyHistory = { entries: [], muted: {}, threads: {}, feedbackWeights: emptyWeights() };
const sel = selectStories(bigPool, emptyHistory, prefs, { log });
const flat = sel.flatMap((s) => s.stories);
const keys = flat.map((s) => s.event_key);

ck('no event appears twice', new Set(keys).size === keys.length);
ck('duplicate event_key collapsed', keys.filter((k) => k === 'dupe').length <= 1);
ck('prompt-injection story excluded', !keys.includes('inject'));
ck('below-floor story excluded', !keys.includes('floor'));
ck('PROFILE: daily category ceiling respected', (() => {
  const c = {};
  for (const s of flat) c[s.category] = (c[s.category] ?? 0) + 1;
  return Object.values(c).every((n) => n <= (prefs.allocation.daily_ceiling ?? 6));
})());
ck('REGRESSION: ceiling applies to the lead section too', (() => {
  const leadCats = (sel.find((s) => s.section === 'what_matters')?.stories ?? []).map((s) => s.category);
  const c = {};
  for (const k of leadCats) c[k] = (c[k] ?? 0) + 1;
  return Object.values(c).every((n) => n <= (prefs.allocation.daily_ceiling ?? 6));
})());
ck('PROFILE: quality_of_life gets its reserved slot',
  flat.filter((s) => s.category === 'quality_of_life').length >= 1);
ck('PROFILE: quality_of_life never exceeds its cap',
  flat.filter((s) => s.category === 'quality_of_life').length <= prefs.allocation.reserved_slots.quality_of_life.max);
ck('PROFILE: home_local gets its reserved slot',
  flat.filter((s) => s.geography === 'home_region' && (s.geographic ?? 0) >= 6).length >= 1);
ck('main brief respects target_stories', (() => {
  const main = sel.filter((s) => s.section !== 'watching').reduce((n, s) => n + s.stories.length, 0);
  return main <= prefs.delivery.target_stories;
})());
ck('proposed and pending route to Watching', (() => {
  const w = sel.find((s) => s.section === 'watching');
  return w && w.stories.every((s) => s.development_stage === 'proposed' || s.development_stage === 'pending');
})());
ck('REGRESSION: a proposed item never leads', (() => {
  const lead = sel.find((s) => s.section === 'what_matters');
  return !lead || lead.stories.every((s) => s.development_stage !== 'proposed');
})());
ck('sections come back in reading order',
  sel.map((s) => s.section).join(',') === 'what_matters,worth_knowing,watching');
ck('muted category suppressed',
  !selectStories(bigPool, { ...emptyHistory, muted: { finance: Date.now() + 86400e3 } }, prefs, { log })
    .flatMap((s) => s.stories).some((s) => s.category === 'finance'));
ck('PROFILE: no backfill — a thin pool yields a short brief', (() => {
  const thin = selectStories(bigPool.slice(0, 3), emptyHistory, prefs, { log }).flatMap((s) => s.stories);
  return thin.length <= 3;
})());

// ───────────────────────────────────────────────────────── allocation
section('allocation deficit');
const mix = { counts: { ai: 20, finance: 2 }, total: 22 };
ck('an under-represented category gets a positive nudge', allocationBonus('finance', mix, prefs.allocation) > 0);
ck('an over-represented category gets a negative nudge', allocationBonus('ai', mix, prefs.allocation) < 0);
ck('PROFILE: the nudge can never promote a weak story over a strong one',
  Math.abs(allocationBonus('finance', mix, prefs.allocation)) <= 10);
ck('a category with no target is untouched', allocationBonus('quality_of_life', mix, prefs.allocation) === 0);
ck('empty history yields no nudge', allocationBonus('ai', { counts: {}, total: 0 }, prefs.allocation) === 0);
ck('rollingMix counts only the window', (() => {
  const h = { entries: [{ category: 'ai', sent_at: Date.now() }, { category: 'ai', sent_at: Date.now() - 60 * 86400e3 }] };
  return rollingMix(h, 30).total === 1;
})());

// ─────────────────────────────────────────────────────────── threading
section('ongoing-story threading');
const thHistory = { entries: [], threads: {}, muted: {}, feedbackWeights: emptyWeights() };
updateThreads(thHistory, [{ event_key: 'str-cap', continues_thread: null, category: 'finance', development_stage: 'proposed', clean_title: 'STR cap introduced' }],
  { sections: [{ stories: [{ feedback_id: 'str-cap', thread_state: 'Council introduced a 1,200-license cap; first reading.' }] }] });
ck('a thread is created when a story is sent', !!thHistory.threads['str-cap']);
ck('the digest-written state is stored', thHistory.threads['str-cap'].beats[0].state.startsWith('Council introduced'));
ck('open threads are offered to the scorer', openThreads(thHistory).some((t) => t.key === 'str-cap'));
ck('a repeat at the same stage is suppressed',
  !threadAdvanced({ event_key: 'str-cap', continues_thread: 'str-cap', development_stage: 'proposed', novelty: 3 }, thHistory));
ck('PROFILE: a genuine development surfaces',
  threadAdvanced({ event_key: 'str-cap', continues_thread: 'str-cap', development_stage: 'occurred', novelty: 6 }, thHistory));
ck('a brand-new event always passes',
  threadAdvanced({ event_key: 'brand-new', continues_thread: null, development_stage: 'occurred', novelty: 9 }, thHistory));
ck('threads survive a save/load round trip', (() => {
  updateThreads(thHistory, [{ event_key: 'str-cap', continues_thread: 'str-cap', category: 'finance', development_stage: 'occurred', clean_title: 'passed' }], { sections: [] });
  return thHistory.threads['str-cap'].times_sent === 2 && thHistory.threads['str-cap'].beats.length === 2;
})());

// ───────────────────────────────────────────── normalization & balance
section('normalization, dedupe, lean balance');
ck('strips utm params', canonicalUrl('https://e.com/a?utm_source=x&id=5') === 'https://e.com/a?id=5');
ck('drops www and trailing slash', canonicalUrl('https://www.e.com/a/') === 'https://e.com/a');
ck('fingerprints ignore stopwords', titleFingerprint('The Fed Holds Rates') === titleFingerprint('Fed Holds the Rates'));
const dupes = normalize([
  { title: 'Fed holds rates steady', url: 'https://a.com/x?utm_source=t', snippet: '', source: 'A', feed_id: 'a', track: 'finance', tier: 2, lean: 'left', source_class: 'aggregator', published_at: Date.now() },
  { title: 'Fed holds rates steady', url: 'https://a.com/x', snippet: '', source: 'A2', feed_id: 'a2', track: 'finance', tier: 1, lean: 'right', source_class: 'primary', published_at: Date.now() },
], { log });
ck('tracking-param twin collapses to one', dupes.length === 1);
ck('merged item records both leans', dupes[0].leans.includes('left') && dupes[0].leans.includes('right'));
ck('REGRESSION: merged item records both source classes',
  dupes[0].source_classes.includes('aggregator') && dupes[0].source_classes.includes('primary'));
ck('REGRESSION: tier-1 source promoted on an exact-URL duplicate', dupes[0].tier === 1);

const mkItem = (lean, i) => ({ id: `x${i}`, title: `Story ${lean} ${i}`, url: `https://e.com/${lean}${i}`, snippet: '', source: lean, feed_id: `f-${lean}`, track: 'us', tier: 1, lean, leans: [lean], source_class: 'original_reporting', source_classes: ['original_reporting'], alert: false, published_at: Date.now() - i * 1000, supporting: [] });
const balanced = prefilter([...Array.from({ length: 40 }, (_, i) => mkItem('center-left', i)), ...Array.from({ length: 4 }, (_, i) => mkItem('right', i))], { junkPatterns: [], log });
const mixCount = {};
for (const c of balanced) mixCount[c.lean] = (mixCount[c.lean] ?? 0) + 1;
ck('minority lean fully survives a 10:1 skew', mixCount['right'] === 4);
ck('majority lean is capped', mixCount['center-left'] <= 40);
ck('junk patterns drop obvious non-news', prefilter([{ ...mkItem('center', 1), title: 'Horoscope for Tuesday' }], { junkPatterns: [], log }).length === 0);

section('cross-spectrum corroboration');
const cb = (leans) => corroborationBonus({ leans });
ck('left + right is the strongest signal', cb(['left', 'right']) === 8);
ck('one side plus a wire', cb(['left', 'center']) === 4);
ck('same-side pair is weak', cb(['left', 'center-left']) === 2);
ck('single source earns nothing', cb(['center']) === 0);
ck('primary adds on top', cb(['left', 'right', 'primary']) === 12);

// ─────────────────────────────────────────────────── heuristic provider
section('rule-based provider');
const hPayload = [
  { id: 'c1', title: 'Federal Reserve holds interest rates steady', source: 'Fed', track: 'finance', snippet: 'Deadline for comment is Friday.' },
  { id: 'c2', title: 'Opinion: Why I love casseroles', source: 'Blog', track: 'us', snippet: '' },
  { id: 'c3', title: 'Madison school bond vote set for November', source: 'Channel 3000', track: 'home_local', snippet: 'Voters will decide.' },
  { id: 'c4', title: 'Deschutes County proposes short-term rental license cap', source: 'KTVZ', track: 'property_local', snippet: 'A proposed ordinance.' },
  { id: 'c5', title: 'Ribbon-cutting for new downtown remodel', source: 'Channel 3000', track: 'home_local', snippet: '' },
];
const hs = await heuristic.scoreBatch({ payload: hPayload, historyKeys: new Set(), preferences: prefs });
ck('returns all items', hs.length === 5);
ck('emits every relevance dimension', DIMENSIONS.every((d) => typeof hs[0][d] === 'number'));
ck('opinion flagged and excluded', hs[1].framing_flags.includes('opinion_only') && !hs[1].include_candidate);
ck('REGRESSION: filler flagged and excluded', hs[4].framing_flags.includes('routine_filler') && !hs[4].include_candidate);
ck('hyperlocal boosts the geographic dimension', hs[2].geographic === 10);
ck('REGRESSION: a property-area story is not forced into quality_of_life', hs[3].category !== 'quality_of_life');
ck('  (category comes from the strongest dimension, not the track)', hs[3].category === 'finance');
ck('property-area geography sets the property dimension', hs[3].property >= 5);
ck('a proposal is staged as proposed', hs[3].development_stage === 'proposed');
ck('never claims a thread it cannot verify', hs.every((h) => h.continues_thread === null));

// ─────────────────────────────────────────────────────────── feedback
section('feedback tuning');
const fbHistory = {
  entries: [{ event_key: 'ev1', title: 'A home-state politics story', category: 'politics', source: 'Wisconsin Examiner', geography: 'home_region', top_dimension: 'financial_impact', sent_at: Date.now() }],
  feedbackWeights: emptyWeights(), muted: {}, feedbackLog: [],
};
applyFeedbackForTest(fbHistory, { action: 'less', eventKey: 'ev1' }, log);
ck('one click moves all three dimensions',
  fbHistory.feedbackWeights.sources['Wisconsin Examiner'] === -3 && fbHistory.feedbackWeights.categories.politics === -2 && fbHistory.feedbackWeights.geographies.home_region === -1);
ck('source moves more than category',
  Math.abs(fbHistory.feedbackWeights.sources['Wisconsin Examiner']) > Math.abs(fbHistory.feedbackWeights.categories.politics));
ck('signal is logged for review', fbHistory.feedbackLog.length === 1);
for (let i = 0; i < 20; i++) applyFeedbackForTest(fbHistory, { action: 'less', eventKey: 'ev1' }, log);
ck('adjustments are capped', fbHistory.feedbackWeights.sources['Wisconsin Examiner'] === -15);
applyFeedbackForTest(fbHistory, { action: 'mute', eventKey: 'ev1' }, log);
ck('mute sets an expiry', fbHistory.muted.politics > Date.now());
applyFeedbackForTest(fbHistory, { action: 'less', eventKey: 'nope' }, log);
ck('unknown event ignored safely', !fbHistory.feedbackWeights.sources['undefined']);

// PROFILE: each signal must act where its complaint originated. Routing them all
// into the ranking sum would make every complaint say "less of this topic",
// which is the one thing none of them said.
const fb = () => ({
  entries: [{ event_key: 'ev1', title: 'T', category: 'finance', source: 'MarketWatch', feed_id: 'marketwatch', geography: 'us', top_dimension: 'financial_impact', sent_at: Date.now() }],
  feedbackWeights: emptyWeights(), muted: {}, feedbackLog: [],
});
const send = (action) => { const h = fb(); applyFeedbackForTest(h, { action, eventKey: 'ev1' }, log); return h; };

ck('all eight signals plus mute are recognized', SIGNAL_NAMES.length === 9);
ck('PROFILE: "already knew this" does NOT touch the category — timing, not topic',
  Object.keys(send('known').feedbackWeights.categories).length === 0);
ck('  it marks the thread quiet instead', !!send('known').quietThreads?.ev1);
ck('PROFILE: "too detailed" has zero selection effect', (() => {
  const h = send('too_long');
  return Object.keys(h.feedbackWeights.sources).length === 0 && Object.keys(h.feedbackWeights.categories).length === 0;
})());
ck('  it sets a writer verbosity hint instead', send('too_long').verbosityHints?.finance === 'brief');
ck('PROFILE: "bad source" demotes the feed, not the topic', (() => {
  const h = send('bad_source');
  return h.sourceOverrides?.marketwatch === 1 && Object.keys(h.feedbackWeights.categories).length === 0;
})());
ck('  source demotion is capped at two rungs', (() => {
  const h = fb();
  for (let i = 0; i < 5; i++) applyFeedbackForTest(h, { action: 'bad_source', eventKey: 'ev1' }, log);
  return h.sourceOverrides.marketwatch === 2;
})());
ck('"very important" moves twice as far as "more"',
  send('important').feedbackWeights.sources.MarketWatch === send('more').feedbackWeights.sources.MarketWatch * 2);
ck('  and records the dimension for weight calibration',
  send('important').importantDimensions?.financial_impact === 1);
ck('"irrelevant" is a stronger negative and logs a feed complaint', (() => {
  const h = send('irrelevant');
  return h.feedbackWeights.sources.MarketWatch === -6 && h.feedComplaints?.marketwatch === 1;
})());
ck('"actionable" records Action-classifier feedback', send('actionable').actionFeedback?.length === 1);
ck('an unknown signal is ignored safely', (() => {
  const h = fb();
  applyFeedbackForTest(h, { action: 'nonsense', eventKey: 'ev1' }, log);
  return Object.keys(h.feedbackWeights.sources).length === 0;
})());

ck('feedback weights reach the score', (() => {
  const tuned = { ...prefs, _feedbackWeights: { categories: { ai: -10 }, sources: { Techmeme: -5 }, geographies: {} } };
  const story = { ...dims({ financial_impact: 8 }), category: 'ai', geography: 'us', sourcing_flags: [], framing_flags: [] };
  return computeScore(story, { source: 'Techmeme', source_classes: ['primary'] }, prefs).total_score -
         computeScore(story, { source: 'Techmeme', source_classes: ['primary'] }, tuned).total_score === 15;
})());

// ───────────────────────────────────────────────────── provider cascade
section('provider cascade');
const P = (e) => pickProvider(e, log);
const names = (e) => P(e).chain.map((p) => p.name).join(',');
ck('no credentials → heuristic only', names({}) === 'heuristic');
ck('claude leads, then gemini, then anthropic', names({ CLAUDE_CODE_OAUTH_TOKEN: 'x', GEMINI_API_KEY: 'y', ANTHROPIC_API_KEY: 'z' }) === 'claude-code,gemini,anthropic,heuristic');
ck('REGRESSION: the CLI child never inherits a metered credential (API-credit drain, 2026-10-18)',
  (() => {
    const e = cliEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_OAUTH_TOKEN: 'o', PATH: '/bin' });
    return !('ANTHROPIC_API_KEY' in e) && !('ANTHROPIC_AUTH_TOKEN' in e) && !('CLAUDE_CODE_USE_BEDROCK' in e) && !('CLAUDE_CODE_USE_VERTEX' in e);
  })());
ck('  and still carries the subscription token and PATH', (() => { const e = cliEnv({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o', PATH: '/bin' }); return e.CLAUDE_CODE_OAUTH_TOKEN === 'o' && e.PATH === '/bin'; })());
ck('  and does not mutate the caller\'s environment', (() => { const src = { ANTHROPIC_API_KEY: 'k' }; cliEnv(src); return src.ANTHROPIC_API_KEY === 'k'; })());
ck('MODEL_PROVIDER promotes but keeps fallbacks', names({ MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'y', CLAUDE_CODE_OAUTH_TOKEN: 'x' }) === 'gemini,claude-code,heuristic');
ck('chain always ends in heuristic', P({ ANTHROPIC_API_KEY: 'z' }).chain.at(-1).name === 'heuristic');
ck('forced provider without credential throws', threw(() => P({ MODEL_PROVIDER: 'anthropic' })));

section('json salvage and schema conversion');
ck('plain object', extractJson('{"a":1}').a === 1);
ck('fenced block', extractJson('```json\n{"a":2}\n```').a === 2);
ck('garbage throws', threw(() => extractJson('no json here')));
const gs = toGeminiSchema(scoringSchema);
ck('strips additionalProperties', !JSON.stringify(gs).includes('additionalProperties'));
ck('strips $comment', !JSON.stringify(gs).includes('$comment'));
ck('preserves the new enums', JSON.stringify(gs).includes('quality_of_life'));

// ────────────────────────────────────────────────────────── alert path
section('breaking-news alerts');
// Every day key in these tests is computed in an explicit zone, never the
// machine's: `TZ=Pacific/Kiritimati npm test` must pass as well as plain CI.
const TZ_TEST = 'America/New_York';
const localDay = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ_TEST }).format(new Date(ms));
const SA = (cands, hist = {}, extra = {}) => selectAlerts(cands, { entries: [], alerts: [], ...hist }, { log, tz: TZ_TEST, ...extra });
/** Runs fn with Date and Date.now() pinned to `iso`, whatever the code under test reads. */
function atClock(iso, fn) {
  const RealDate = Date;
  const fixed = RealDate.parse(iso);
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  };
  try { return fn(); } finally { globalThis.Date = RealDate; }
}
const base = { title: '', snippet: '', track: 'us', tier: 2, lean: 'center', published_at: Date.now(), alert: true, feed_id: 'wire_a', url: 'https://a.example/1' };
/**
 * Scores an item as if a second wire feed carried the same headline. A
 * world-event word alone needs two feeds before it alerts (pinned below), so
 * the other rules are tested with that already satisfied.
 */
const U = (o) => {
  const item = { ...base, ...o };
  const twin = { ...item, feed_id: 'wire_b', url: 'https://b.example/1' };
  return urgencyScore(item, { corroboration: majorCorroboration([item, twin]) });
};
/** The same item seen in one feed only. */
const U1 = (o) => urgencyScore({ ...base, ...o }, { corroboration: majorCorroboration([{ ...base, ...o }]) });
ck('local tornado warning qualifies', U({ title: 'Tornado Warning issued for Dane County', track: 'home_local', lean: 'primary', tier: 1 }) >= 70);
ck('REGRESSION: routine local item from a primary source scores 0', U({ title: 'City council reviews parking study', track: 'home_local', lean: 'primary', tier: 1 }) === 0);
// 2026-09-20: world stories went out as Breaking from a loose word list.
// The first two are the real titles that fired.
ck('REGRESSION: "nuclear" in a policy story does not alert', U({ title: 'EXCLUSIVE: Russian document reveals sweeping Iran plan spanning nuclear, finance and aviation', tier: 1 }) < 70);
ck('REGRESSION: a missile test is not an attack', U({ title: 'North Korea launches missiles as it dials up pressure against U.S.', snippet: 'nuclear-armed North Korea fired ballistic missiles', tier: 1 }) < 70);
ck('REGRESSION: pattern words in the snippet alone do not alert', U({ title: 'Markets steady ahead of Fed', snippet: 'analysts fear an invasion could trigger a coup', tier: 1 }) === 0);
ck('REGRESSION: a missile strike abroad does not alert', U({ title: 'Americans warned again to rethink travel as missile attack rattles historic region', tier: 1 }) < 70);
ck('a missile strike on US territory does', U({ title: 'North Korean missile strikes Guam, officials say', tier: 1 }) >= 70);
ck('REGRESSION: follow-up coverage of an old assassination does not alert', U({ title: "Suspects in Haitian president's assassination transferred to Miami, accused of plotting", tier: 1 }) < 70);
ck('a fresh assassination still does', U({ title: 'Prime minister assassinated at campaign rally', tier: 1 }) >= 70);
ck('REGRESSION: a release date that cites an assassination does not alert', U({ title: "Apple TV's The Savant gets spring 2027 release date after postponing following Kirk assassination", tier: 1 }) === 0);
ck('REGRESSION: a season delayed after a coup does not alert', U({ title: 'Drama series pushed to 2027 after coup in filming location', tier: 1 }) === 0);
ck('mass casualties at a premiere still alert', U({ title: 'Mass casualties at film premiere as gunman opens fire', tier: 1 }) >= 70);
ck('a hazard term lifts the scheduling suppression', U({ title: 'Premiere on Friday canceled after explosion, 4 dead, as coup unfolds', tier: 1 }) >= 70);
ck('a nuclear strike anywhere still alerts', U({ title: 'North Korea launches nuclear strike on Guam', tier: 1 }) >= 70);
ck('REGRESSION: a magnitude-7 quake far from anyone waits for the brief', U({ title: 'Magnitude 7.4 earthquake hits off Japan', lean: 'primary', tier: 1 }) === 0);
ck('a non-local plane crash on the wires does not alert', U({ title: 'Small plane crash kills two in Nevada', tier: 1 }) < 70);
ck('a local plane crash does', U({ title: 'F-16 from Texas crashes in Wisconsin, evacuation order lifted', track: 'home_region', tier: 1 }) >= 70);
ck('a nationwide child-product recall from FDA still alerts', U({ title: 'FDA announces nationwide recall of infant formula', lean: 'primary', tier: 1 }) >= 70);
ck('freshness never lifts an item over the bar', U({ title: 'State of emergency declared in Oregon', tier: 1, published_at: Date.now() }) < 70);
const urgent = { title: 'Tornado Warning issued for Dane County', snippet: '', url: 'https://e.com/t', source: 'NWS', track: 'home_local', tier: 1, lean: 'primary', alert: true, published_at: Date.now() };
ck('only the urgent item is selected', SA([urgent, { ...urgent, title: 'Library book sale Saturday' }]).length === 1);
ck('same alert never sent twice', SA([urgent], { alerts: [{ key: alertKey(urgent), day: '2000-01-01', at: Date.now() }] }).length === 0);
// ── friends and family: impact only, never warnings ──────────────────────
const DENVER = { place: 'denver', place_match: 'denver|denver county|aurora|lakewood' };
const PHOENIX = { place: 'phoenix', place_match: 'phoenix|scottsdale|tempe|mesa' };
const COOS_BAY = { place: 'coos_bay', place_match: 'coos bay|north bend' };
const PP = (o) => urgencyScore({ title: '', snippet: '', track: 'people', tier: 2, lean: 'center', published_at: Date.now(), ...DENVER, ...o });
ck('people: a warning is not impact', PP({ title: 'Severe Thunderstorm Warning issued for Denver County', lean: 'primary', tier: 1 }) === 0);
ck('people: a tornado WATCH is not impact', PP({ title: 'Tornado watch issued for Denver area until 9 PM' }) === 0);
ck('people: NWS tornado emergency is', PP({ title: 'Tornado Emergency issued for Denver County', lean: 'primary', tier: 1 }) >= 70);
ck('people: NWS tsunami warning is', PP({ title: 'Tsunami Warning issued for Coos Bay', lean: 'primary', tier: 1, place_match: 'coos bay|north bend' }) >= 70);
ck('people: evacuation order in the place fires', PP({ title: 'Evacuation orders issued as brush fire spreads toward Denver suburb' }) >= 70);
ck('people: tornado with damage fires', PP({ title: 'Tornado tears through Denver neighborhood, homes destroyed' }) >= 70);
ck('people: tornado with no damage word does not', PP({ title: 'Tornado spotted briefly west of Denver' }) === 0);
ck('REGRESSION 2026-10-10: a single-site casualty count no longer alerts (area-wide only)', PP({ title: '3 dead, 12 injured after Denver apartment explosion' }) === 0);
ck('people: boil-water notice fires', PP({ title: 'Boil water notice issued for parts of Denver after main break' }) >= 70);
ck('people: single fatal crash does not', PP({ title: 'Driver killed in crash on Denver expressway' }) === 0);
ck('people: ordinary shooting does not', PP({ title: 'Man shot on Denver east side' }) === 0);
ck('REGRESSION 2026-10-10: a shooting, even a mass shooting, is not an area-wide hazard', PP({ title: 'Mass shooting at Denver parade leaves 6 dead' }) === 0);
ck('people: impact elsewhere in the feed does not', PP({ title: 'Evacuations ordered as wildfire spreads near Pueblo' }) === 0);
ck('people: preparedness stories excluded', PP({ title: 'Denver earthquake drill: how the city prepares for disaster' }) === 0);
ck('people: anniversary stories excluded', PP({ title: 'Ten years after the Denver derailment, residents remember' }) === 0);
ck('people: metro item must name the suburb', PP({ title: 'Evacuation orders lifted in Yarnell fire', place: 'phoenix', place_match: 'phoenix|scottsdale|tempe|mesa' }) === 0);
ck('people: a fire that does name it fires', PP({ title: 'Scottsdale wildfire forces evacuations, homes burn', place: 'phoenix', place_match: 'phoenix|scottsdale|tempe|mesa' }) >= 70);
ck('people: synthesized quake candidate fires', PP({ title: 'M6.1 earthquake 18 mi from Ridgecrest, CA', quake: true, lean: 'primary', tier: 1, place: 'ridgecrest', place_match: 'ridgecrest' }) >= 70);
ck('people: impactScore ignores the home-track patterns', impactScore({ title: 'Flash Flood Warning issued for Denver County', lean: 'primary', place_match: 'denver|denver county', snippet: 'Denver' }) === 0);
ck('people: rendered alert says who is near', (() => { const html = renderAlert([{ title: 'T', url: 'https://e.com', source: 'S', snippet: '', place_people: 'Sam and Jordan', place_name: 'Denver, CO' }], { tz: TZ_TEST }); return html.includes('Near Sam and Jordan') && html.includes('Denver, CO'); })());
const anchor = { lat: 35.7736, lng: -117.6716 };
ck('quake: M6 within 100 mi matters', !!quakeMattersTo({ mag: 6.0, lat: 35.8987, lng: -117.5522 }, anchor));
ck('quake: M4.6 under the city does not', !quakeMattersTo({ mag: 4.6, lat: 35.7787, lng: -117.6722 }, anchor));
ck('quake: M7 in Japan does not', !quakeMattersTo({ mag: 7.0, lat: 35, lng: 139 }, anchor));
ck('quake: USGS yellow impact within 300 km does', !!quakeMattersTo({ mag: 5.2, alert: 'yellow', lat: 35.8987, lng: -117.8522 }, anchor));
ck('quake: distance sanity (anchor to LA is about 198 km)', Math.abs(distanceKm(35.7736, -117.6716, 34.0522, -118.2437) - 198) < 5);
ck('maskAddress tells similar senders apart without printing them',
  maskAddress('alex.reader54321@gmail.com') === 'ale***21@gmail.com' && maskAddress('alex.reader5@gmail.com') === 'ale***r5@gmail.com');
ck('maskAddress survives a short or missing address', maskAddress('a@b.com') === 'a***@b.com' && maskAddress(undefined) === '***@');
const fullDay = (day) => Array.from({ length: MAX_ALERTS_PER_DAY }, (_, i) => ({ key: `k${i}`, day, at: Date.now() }));
ck('daily cap enforced', SA([urgent], { alerts: fullDay(localDay()) }).length === 0);

// ── 2026-10 alert review ─────────────────────────────────────────────────
// Each block below pins one confirmed finding. Real headlines were rewritten
// onto the fixture places (Denver, Phoenix, Coos Bay, Ridgecrest).

// Lost alerts: the window starts at the last successful check. GitHub ran
// about one hourly cron in five (gaps 2.8-17.8 h), and a fixed 2 h window
// dropped everything published in between.
const H = 3600e3;
const NOW = Date.parse('2026-10-07T18:00:00Z');
ck('window: no record of a previous check looks back 2 h', alertWindowHours(null, NOW) === 2);
ck('window: a check 30 min ago still looks back 2 h', alertWindowHours(NOW - 0.5 * H, NOW) === 2);
ck('window: a 5 h gap looks back to the last check, plus an hour of overlap', alertWindowHours(NOW - 5 * H, NOW) === 6);
ck('window: a two-day gap is clamped to 18 h', alertWindowHours(NOW - 48 * H, NOW) === 18);
ck('window: a timestamp from the future falls back to 2 h', alertWindowHours(NOW + H, NOW) === 2);
const RIDGECREST = { id: 'ridgecrest', place: 'Ridgecrest, CA', people: 'Sam', lat: 35.7736, lng: -117.6716 };
const usgsFeature = (o = {}) => ({
  id: 'ci40000001', geometry: { coordinates: [-117.60, 35.85, 8] },
  properties: { mag: 5.8, place: '9 km N of Ridgecrest, CA', time: Date.now() - 10 * H, updated: Date.now() - 1 * H, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/ci40000001', alert: null, tsunami: 0, ...o },
});
let usgsOpts = null;
const fakeUsgs = (features) => async (_url, opts) => { usgsOpts = opts; return { ok: true, json: async () => ({ features }) }; };
const revised = await nearbyQuakes([RIDGECREST], { lookbackHours: 2, log, fetchImpl: fakeUsgs([usgsFeature()]) });
ck('quake: a revision inside the window counts even when the origin is older', revised.length === 1);
ck('  and carries the USGS event id', revised[0]?.usgs_id === 'ci40000001');
ck('quake: the USGS fetch has a timeout', usgsOpts?.signal instanceof AbortSignal);
ck('quake: nothing new since the window is still skipped',
  (await nearbyQuakes([RIDGECREST], { lookbackHours: 2, log, fetchImpl: fakeUsgs([usgsFeature({ updated: Date.now() - 5 * H })]) })).length === 0);

// Daily cap: the day is the owner's local day. 20:00-23:59 Eastern is already
// tomorrow in UTC, and the cap counted the wrong day for those hours.
ck('REGRESSION: daily cap counts the local day, not the UTC one', atClock('2026-10-08T00:05:00Z', () =>
  SA([{ ...urgent, published_at: Date.now() }], { alerts: fullDay('2026-10-07') }).length === 0));
ck('  and the next local day starts fresh', atClock('2026-10-08T04:05:00Z', () =>
  SA([{ ...urgent, published_at: Date.now() }], { alerts: fullDay('2026-10-07') }).length === 1));

// Friends and family: impact, not crime blotter. These are what the people
// feeds actually returned in one week, plus the synthetic set.
ck('REGRESSION: people: two dead in a shooting is not area-wide impact', PP({ title: '2 dead, 1 injured in Denver shooting' }) === 0);
ck('REGRESSION: people: one injured on the interstate is not', PP({ title: '1 injured in early morning shooting on I-25 near Denver' }) === 0);
ck('REGRESSION: people: an after-action fire report is not', PP({ title: 'Botched Denver evacuations left residents stranded: long-awaited fire report' }) === 0);
ck('REGRESSION: people: evacuation WARNINGS are a warning', PP({ title: 'Evacuation warnings issued for 6-acre fire near Denver' }) === 0);
ck('  even for a brush fire', PP({ title: 'Evacuation warnings issued for 6-acre brush fire near Denver' }) === 0);
ck('REGRESSION: people: a place named only in the snippet does not count', PP({ title: '4 injured in drive-by shooting', snippet: 'Police said the shooting happened in Denver late Sunday.' }) === 0);
ck('  and naming it in the headline does not make a drive-by area-wide', PP({ title: '4 injured in Denver drive-by shooting' }) === 0);
ck('people: "explosion of new restaurants" is figurative', PP({ title: 'Denver sees explosion of new restaurants' }) === 0);
ck('people: a Title Case "Explosion In" is figurative too', PP({ title: 'Denver Sees Explosion In Short-Term Rentals' }) === 0);
ck('people: "home prices explode" is figurative', PP({ title: 'Denver home prices explode' }) === 0);
ck('people: a landslide vote is not a landslide', PP({ title: 'Denver voters approve transit tax in landslide' }) === 0);
ck('people: two killed in a crash is not area-wide impact', PP({ title: '2 killed in crash on Denver highway' }) === 0);
ck('people: "explosion in gas prices" is figurative', PP({ title: 'Denver sees explosion in gas prices' }) === 0);
ck('people: a child\'s age is not a casualty count', PP({ title: '3 year old dies in Denver house fire' }) === 0);
ck('people: officials reviewing damage do not make an evacuation a report', PP({ title: 'Evacuation orders issued in Denver as officials review damage' }) >= 70);
ck('people: four hospitalized is under the bar', PP({ title: '4 hospitalized after carbon monoxide leak at Denver school' }) === 0);
ck('  a leak at one building is single-site, whatever the count', PP({ title: '5 hospitalized after carbon monoxide leak at Denver school' }) === 0);
ck('REGRESSION 2026-10-10: a building collapse is single-site', PP({ title: 'Denver building collapse leaves 3 dead' }) === 0);
ck('REGRESSION 2026-10-10: an apartment explosion is single-site', PP({ title: 'Explosion in Denver apartment building injures 6' }) === 0);
ck('people: a wildfire that destroys homes fires', PP({ title: 'Wildfire destroys 40 homes near Denver' }) >= 70);
ck('REGRESSION 2026-10-10: an apartment fire is single-site', PP({ title: '3 dead in Denver apartment fire' }) === 0);
ck('people: a real landslide fires', PP({ title: 'Landslide buries homes near Coos Bay', ...COOS_BAY }) >= 70);
ck('REGRESSION: people: an NWS tsunami warning fires though its title names the warning center', PP({ title: 'Tsunami Warning issued October 7 at 9:14AM PDT until October 7 at 3:00PM PDT by NWS National Tsunami Warning Center', lean: 'primary', tier: 1, ...COOS_BAY }) >= 70);

// NWS identity: one tornado warning used to block every other zone's tornado
// warning that day ("tornado-warning-issued-october-7-at").
const nws = (o) => ({ ...base, track: 'us', lean: 'primary', tier: 1, source: 'NWS', ...o });
const capUrl = (id) => `https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.${id}.001.1.cap`;
const twA = nws({ title: 'Tornado Warning issued October 7 at 3:15PM MDT until October 7 at 3:45PM MDT by NWS Pueblo CO', url: capUrl('aaa'), feed_id: 'nws_zone_a' });
const twB = nws({ title: 'Tornado Warning issued October 7 at 5:02PM MST until October 7 at 5:30PM MST by NWS Phoenix AZ', url: capUrl('bbb'), feed_id: 'nws_zone_b' });
ck('REGRESSION: two tornado warnings for different zones on one day both alert', SA([twA, twB]).length === 2);
ck('  and one already sent does not block the other', SA([twB], { alerts: [alertRecord(twA, { day: '2000-01-01', now: Date.now() })] }).length === 1);
ck('the same NWS product twice is one alert', SA([twA, { ...twA }]).length === 1);
const twAUpdate = { ...twA, title: twA.title.replace('3:15PM', '3:29PM'), url: capUrl('aaa2') };
ck('an update to the same warning is not a second alert', SA([twA, twAUpdate]).length === 1);
ck('  nor after the first was sent', SA([twAUpdate], { alerts: [alertRecord(twA, { day: '2000-01-01', now: Date.now() - H })] }).length === 0);
ck('REGRESSION: an NWS cancellation never alerts', U1({ title: 'The Tornado Warning has been cancelled.', lean: 'primary', tier: 1 }) === 0);

// Alert-path dedupe is by URL only. The brief's headline-fingerprint merge
// folded people items into wire items and swallowed NWS products.
const wireFire = { ...base, title: 'Wildfire destroys 40 homes near Denver', url: 'https://wire.example/fire', source: 'Wire', tier: 1 };
const localFire = { ...wireFire, url: 'https://denver-news.example/fire', feed_id: 'denver_local', source: 'Local', track: 'people', place: 'denver', tier: 2 };
ck('REGRESSION: a people item is not folded into a wire item with the same headline', (() => {
  const out = dedupeAlertItems([wireFire, localFire], { log });
  return out.length === 2 && out.some((c) => c.track === 'people' && c.place === 'denver');
})());
ck('REGRESSION: a tornado watch does not swallow a warning issued the same minute', (() => {
  const watch = nws({ title: 'Tornado Watch issued October 7 at 3:15PM MST until October 7 at 9:00PM MST by NWS Phoenix AZ', url: capUrl('ccc'), feed_id: 'nws_zone_b' });
  const warning = { ...watch, title: 'Tornado Warning issued October 7 at 3:15PM MST until October 7 at 9:00PM MST by NWS Phoenix AZ', url: capUrl('ddd') };
  // The brief's normalize() no longer title-merges two items from one feed
  // (fixed separately on 2026-10-07), so both paths now keep both products.
  const brief = normalize([watch, warning], { log });
  const out = dedupeAlertItems([watch, warning], { log });
  return brief.length === 2 && out.length === 2 && out.some((c) => c.title.startsWith('Tornado Warning'));
})());
ck('the same URL from two feeds is still one candidate', dedupeAlertItems([wireFire, { ...wireFire, feed_id: 'wire_b', url: `${wireFire.url}?utm_source=rss` }], { log }).length === 1);

// World-event words fired on rhetoric. The first is the real 85; the rest
// are the synthetic set.
ck('REGRESSION: an investigation that mentions an attack method does not alert', U({ title: 'Chinese AI model investigated after researcher says it provided instructions for assassinations', tier: 1 }) < 70);
ck('major: "character assassination" is rhetoric', U({ title: "Senator decries 'character assassination' by rivals", tier: 1 }) < 70);
ck('major: "could invade" is a hypothetical', U({ title: 'Russia could invade a NATO country within five years, general warns', tier: 1 }) < 70);
ck('major: a mass casualty drill is a drill', U({ title: 'Hospitals hold mass casualty drill ahead of marathon', tier: 1 }) < 70);
ck('major: a "How the ..." retrospective is not news', U({ title: 'How the Kirk assassination reshaped campus politics', tier: 1 }) < 70);
ck('major: "fifty years later" is a retrospective', U({ title: 'Teton Dam failure: fifty years later, survivors look back', tier: 1 }) < 70);
// No negation catches these. They are caught because only one outlet writes them.
ck('major: one wire feed alone cannot raise a world-event alert', U1({ title: 'Prime minister assassinated at campaign rally', tier: 1 }) < 70);
ck('  the same event in a second feed can', U({ title: 'Prime minister assassinated at campaign rally', tier: 1 }) >= 70);
ck('  an "evacuation" in its snippet does not stand in for the second feed', U1({ title: 'Prime minister assassinated at campaign rally', snippet: 'Police ordered an evacuation of the square.', tier: 1 }) < 70);
ck('  a primary source needs no second feed', U1({ title: 'Prime minister assassinated at campaign rally', lean: 'primary', tier: 1 }) >= 70);
ck('major: "Bird flu invades dairy herds" from one feed does not alert', U1({ title: 'Bird flu invades Idaho dairy herds', tier: 1 }) < 70);
ck('major: "declares war on drug cartels" from one feed does not', U1({ title: 'Governor declares war on drug cartels', tier: 1 }) < 70);
ck('major: a "Hollywood coup" from one feed does not', U1({ title: 'Hollywood coup: streamer poaches top showrunner', tier: 1 }) < 70);
ck('major: two items from one feed are still one feed', (() => {
  const a = { ...base, title: 'Prime minister assassinated at campaign rally', tier: 1 };
  const b = { ...a, title: 'Gunman assassinates prime minister at rally', url: 'https://a.example/2' };
  return urgencyScore(a, { corroboration: majorCorroboration([a, b]) }) < 70;
})());
ck('major: rhetoric never corroborates', (() => {
  const a = { ...base, title: 'Prime minister assassinated at campaign rally', tier: 1 };
  const b = { ...base, title: "Senator decries 'character assassination' by rivals", feed_id: 'wire_b', url: 'https://b.example/2' };
  return urgencyScore(a, { corroboration: majorCorroboration([a, b]) }) < 70;
})());
ck('major: two feeds on one event are one alert, not two', SA([
  { ...base, title: 'Prime minister assassinated at campaign rally', tier: 1 },
  { ...base, title: 'Gunman assassinates prime minister during election rally', feed_id: 'wire_b', url: 'https://b.example/1', tier: 1 },
]).length === 1);

// Follow-up words only suppress when they come first ("Suspects in ...").
ck('follow-up: "suspect at large" after a fresh assassination still alerts', U({ title: 'Nevada lawmaker killed in apparent assassination; suspect at large', tier: 1 }) >= 70);
ck('follow-up: "under house arrest" after a coup still alerts', U({ title: 'Niger military officers announce coup, president under house arrest', tier: 1 }) >= 70);
ck('follow-up: a suspect killed at the scene still alerts', U({ title: 'Assassination attempt on senator at rally; suspect killed by Secret Service', tier: 1 }) >= 70);
ck('follow-up: a charge that comes first is a follow-up', U({ title: 'Man charged in assassination of city council member', tier: 1 }) < 70);
ck('follow-up: a trial is always a follow-up', U({ title: 'Coup leaders go on trial in capital', tier: 1 }) < 70);

// One event, one alert.
const quakeItem = (mag) => ({ ...base, track: 'people', lean: 'primary', tier: 1, quake: true, usgs_id: 'ci40000001', place: 'ridgecrest', feed_id: 'usgs_geojson', title: `M${mag} earthquake 6 mi from Ridgecrest, CA`, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/ci40000001' });
ck('REGRESSION: a magnitude revision is the same quake', alertKey(quakeItem('5.6')) === alertKey(quakeItem('5.8')));
ck('  and is not sent again', SA([quakeItem('5.8')], { alerts: [{ key: alertKey(quakeItem('5.6')), day: '2000-01-01', at: Date.now() }] }).length === 0);
const ppItem = (o) => ({ ...base, track: 'people', ...DENVER, place_people: 'Sam', ...o });
const fireHeadlines = [
  ppItem({ title: 'Wildfire destroys 3 homes near Denver', url: 'https://l.example/1', feed_id: 'local_a' }),
  ppItem({ title: 'Denver wildfire: evacuation orders issued for two neighborhoods', url: 'https://l.example/2', feed_id: 'local_b' }),
  ppItem({ title: 'Crews battle Denver wildfire that destroyed homes overnight', url: 'https://l.example/3', feed_id: 'local_a' }),
];
ck('REGRESSION: three headlines about one fire are one alert', SA(fireHeadlines).length === 1);
ck('  a later headline within a day is not a second', SA([fireHeadlines[2]], { alerts: [alertRecord(fireHeadlines[0], { day: '2000-01-01', now: Date.now() - 2 * H })] }).length === 0);
ck('  a day later the same kind of event can alert again', SA([fireHeadlines[2]], { alerts: [alertRecord(fireHeadlines[0], { day: '2000-01-01', now: Date.now() - 25 * H })] }).length === 1);
ck('  a different kind of event in the same place still alerts', SA([ppItem({ title: 'Boil water notice issued across Denver', url: 'https://l.example/4' })], { alerts: [alertRecord(fireHeadlines[0], { day: '2000-01-01', now: Date.now() - 2 * H })] }).length === 1);
ck('  the same kind of event in another place still alerts', SA([ppItem({ title: 'Wildfire destroys 12 homes near Scottsdale', url: 'https://l.example/5', ...PHOENIX })], { alerts: [alertRecord(fireHeadlines[0], { day: '2000-01-01', now: Date.now() - 2 * H })] }).length === 1);

// Low-severity cleanups.
ck('REGRESSION: a USGS M7.7 in Panama (2026-10-09) does not alert', U1({ title: 'M 7.7 - 12 km WSW of Pitaloza Arriba, Panama', lean: 'primary', tier: 1, feed_id: 'usgs_quakes' }) === 0);
ck('  nor does "7.4-magnitude" on the wires', U({ title: 'Powerful 7.4-magnitude earthquake strikes off Japan', tier: 1 }) === 0);
const phxTornado = { title: 'Tornado Warning issued October 7 at 4:02PM MST until October 7 at 4:45PM MST by NWS Phoenix AZ', lean: 'primary', tier: 1, ...PHOENIX };
ck('REGRESSION: people: a tornado emergency inside a warning\'s text fires', PP({ ...phxTornado, snippet: 'This is a TORNADO EMERGENCY for central Phoenix. Take cover now.' }) >= 70);
ck('  the plain warning does not', PP({ ...phxTornado, snippet: 'At 4:02 PM MST, a severe thunderstorm capable of producing a tornado was located near Tempe.' }) === 0);
ck('REGRESSION: people: "fire season" no longer hides a fire', PP({ title: 'Wildfire destroys 12 homes as Denver fire season intensifies' }) >= 70);
ck('a training-range explosion is single-site', PP({ title: 'Training range explosion injures 4 near Denver' }) === 0);
ck('REGRESSION 2026-10-10: a building-fire story ("residents displaced, building collapse") no longer alerts',
  PP({ title: 'Fallen Denver firefighter helps save 14 residents displaced after massive blaze, building collapse' }) === 0);
ck('a single-building evacuation is not an area evacuation', PP({ title: 'Residents evacuated after Denver apartment fire' }) === 0);
ck('a hurricane making landfall on the place alerts', PP({ title: 'Hurricane Delta makes landfall near Denver' }) >= 70);
ck('an NWS hurricane warning for the place alerts', PP({ title: 'Hurricane Warning issued October 10 by NWS', lean: 'primary', tier: 1 }) >= 70);
ck('thousands without power is area-wide', PP({ title: '80,000 Denver customers without power after storm' }) >= 70);
ck('a city-wide boil-water notice alerts', PP({ title: 'Boil water notice issued for all of Denver' }) >= 70);
ck('mandatory neighborhood evacuations alert', PP({ title: 'Mandatory evacuation ordered for Denver neighborhoods along creek' }) >= 70);
ck('REGRESSION: people: "what to know" no longer hides an evacuation', PP({ title: 'What to know about evacuation orders tonight in Denver' }) >= 70);
ck('people: "in Denver history" is a superlative, not a history piece', PP({ title: 'Largest wildfire in Denver history destroys 500 homes' }) >= 70);
ck('people: a training exercise is still excluded', PP({ title: 'Training exercise simulates Denver chemical spill' }) === 0);
ck('REGRESSION: an item already in a morning brief does not alert', SA([twA], { entries: [{ event_key: 'some-model-key', url: twA.url, sent_at: Date.now() }] }).length === 0);
ck('  an item the brief did not carry still does', SA([twA], { entries: [{ event_key: 'some-model-key', url: 'https://other.example/x', sent_at: Date.now() }] }).length === 1);
ck('REGRESSION: the alert footer names no stale brief time', (() => {
  const html = renderAlert([{ title: 'T', url: 'https://e.com', source: 'S', snippet: '', place_people: 'Sam', place_name: 'Denver, CO' }], { tz: TZ_TEST });
  return !html.includes('6:30') && html.includes('morning brief');
})());

// ─────────────────────────────────────────────────────────── rendering
section('rendering');
const mkStory = (o = {}) => ({
  feedback_id: 'k', headline: 'H', category: 'finance', summary: 'S', why_it_matters: 'W',
  whats_new: '', thread_state: '', confidence: 'Likely', action: 'NONE', action_reason: '',
  time_horizon: 'Months', primary_url: 'https://ok.com/a', supporting_urls: [],
  evidence_stage: 'not_applicable', source_name: 'Src', source_leans: ['center'], ...o,
});
const hostile = renderHtml({
  todays_signal: 'Signal',
  sections: [{ section: 'what_matters', label: 'What Actually Matters Today', detail: 'full', stories: [
    mkStory({ headline: '<script>alert(1)</script> & "quotes"', primary_url: 'javascript:alert(1)', supporting_urls: ['https://ok.com/b'], evidence_stage: 'observational', source_leans: ['left', 'right'], action: 'CONSIDER_ACTION', action_reason: 'deadline Friday', whats_new: 'Second reading passed.' }),
  ] }],
}, { dateLabel: 'Monday, January 1', feedbackAddress: 'x@y.com', health: { ok: 73, failed: [] } });
ck('script tags escaped', !hostile.includes('<script>alert'));
ck('javascript: url dropped', !/href="javascript:/.test(hostile));
ck('https supporting link preserved', hostile.includes('https://ok.com/b'));
ck('evidence badge rendered', hostile.includes('cannot show cause'));
ck('cross-spectrum badge rendered', hostile.includes('Reported across the spectrum'));
ck('action badge rendered with reason', hostile.includes('Consider action') && hostile.includes('deadline Friday'));
ck('"Since last time" rendered as its own line', hostile.includes('Since last time'));
ck('no double-escaped entities', !hostile.includes('&amp;middot;') && !hostile.includes('&amp;#'));

const tiered = renderHtml({
  todays_signal: 'S',
  sections: [
    { section: 'what_matters', label: 'Lead', detail: 'full', stories: [mkStory({ feedback_id: 'a' })] },
    { section: 'worth_knowing', label: 'Body', detail: 'brief', stories: [mkStory({ feedback_id: 'b' })] },
    { section: 'watching', label: 'Watch', detail: 'line', stories: [mkStory({ feedback_id: 'c', why_it_matters: '' })] },
  ],
}, { dateLabel: 'D', feedbackAddress: 'x@y.com', health: { ok: 73, failed: [] } });
ck('PROFILE: feedback buttons only on full-detail stories',
  (tiered.match(/More like this/g) ?? []).length === 1);
ck('watching entries render as one line', !tiered.includes('Why it matters:</strong> W</div>\n    <div style="font-size:14px'));

ck('PROFILE: a full 15-story brief stays well under the Gmail clip limit', (() => {
  const big = renderHtml({
    todays_signal: 'S',
    sections: [
      { section: 'what_matters', label: 'Lead', detail: 'full', stories: Array.from({ length: 5 }, (_, i) => mkStory({ feedback_id: `a${i}`, summary: 'x'.repeat(400), why_it_matters: 'y'.repeat(160), action: 'RESEARCH', action_reason: 'z'.repeat(60) })) },
      { section: 'worth_knowing', label: 'Body', detail: 'brief', stories: Array.from({ length: 10 }, (_, i) => mkStory({ feedback_id: `b${i}`, summary: 'x'.repeat(200) })) },
      { section: 'watching', label: 'Watch', detail: 'line', stories: Array.from({ length: 4 }, (_, i) => mkStory({ feedback_id: `c${i}`, why_it_matters: '' })) },
    ],
  }, { dateLabel: 'D', feedbackAddress: 'x@y.com', health: { ok: 73, failed: [] } });
  return big.length < 90_000;
})());


// ─────────────────────────────────────────────── 2026-10-07 review fixes
section('2026-10-07 review fixes: scoring');
const scoringSchemaT = JSON.parse(await readFile(join(ROOT, 'schema/scoring_schema.json'), 'utf8'));
const mkCand = (i, o = {}) => ({
  id: `c${i}`, title: `Story ${i} about rates`, url: `https://ok.example/${i}`, source: 'Src', feed_id: 'src',
  track: 'finance', tier: 1, lean: 'center', leans: ['center'], source_class: 'established',
  source_classes: ['established'], published_at: Date.now(), snippet: 'The Fed held rates.', supporting: [], ...o,
});
const fakeProvider = (fn, name = 'fake') => ({ name, label: name, concurrency: 1, scoreBatch: fn, writeDigest: async () => ({}) });
const scoreWith = (cands, prov) => scoreCandidates(cands, {
  prompt: 'p', schema: scoringSchemaT, preferences: prefs, historyText: '', historyKeys: new Set(), openThreads: [],
  provider: prov, chain: [prov, heuristic], usage: null, log, retryDelayMs: 0,
});

const hostileProv = fakeProvider(async (args) => (await heuristic.scoreBatch(args)).map((s) => ({
  ...s, url: 'https://evil.example/x', leans: ['left', 'right'], source_classes: ['primary'], source: 'Evil',
})));
const hostileOut = await scoreWith([mkCand(1)], hostileProv);
ck('REGRESSION: model output cannot replace a story\'s url, leans, source class or source',
  hostileOut.scored[0].url === 'https://ok.example/1' && hostileOut.scored[0].leans.join() === 'center'
  && hostileOut.scored[0].source_classes.join() === 'established' && hostileOut.scored[0].source === 'Src');

const wrongKey = fakeProvider(async () => []); // e.g. {"results":[...]} parsed to stories ?? []
const wrongOut = await scoreWith([1, 2, 3, 4, 5].map((i) => mkCand(i)), wrongKey);
ck('REGRESSION: a reply covering none of the batch falls back instead of dropping 5 stories',
  wrongOut.scored.length === 5 && wrongOut.meta.rescued === 1);

const partial = fakeProvider(async (args) => (await heuristic.scoreBatch(args)).slice(0, 4));
const partialOut = await scoreWith([1, 2, 3, 4, 5].map((i) => mkCand(i)), partial);
ck('a reply missing 1 of 5 items keeps the 4 and scores the missing one by rules',
  partialOut.scored.length === 5 && partialOut.meta.filled === 1 && partialOut.meta.rescued === 0);

const dupesR = fakeProvider(async (args) => {
  const out = await heuristic.scoreBatch(args);
  return [...out, { ...out[0], event_key: 'some-other-key' }];
});
const dupeOut = await scoreWith([1, 2].map((i) => mkCand(i)), dupesR);
ck('REGRESSION: a duplicated id is counted once', dupeOut.scored.filter((s) => s.id === 'c1').length === 1);

let brokenCalls = 0;
const broken = fakeProvider(async () => { brokenCalls++; throw new Error('boom'); });
await scoreWith(Array.from({ length: 75 }, (_, i) => mkCand(i)), broken);
ck('a provider that fails two batches in a row is skipped for the rest of the run (6 calls, not 9)', brokenCalls === 6);

let timeoutCalls = 0;
const slow = fakeProvider(async () => { timeoutCalls++; const e = new Error('timed out'); e.timeout = true; throw e; });
await scoreWith([mkCand(1)], slow);
ck('a timed-out call is retried once, not twice', timeoutCalls === 2);

ck('"bad source" feedback demotes that feed one quality rung',
  computeQuality({}, mkCand(1, { feed_id: 'meh' }), { ...prefs, _sourceOverrides: { meh: 1 } })
    < computeQuality({}, mkCand(1, { feed_id: 'meh' }), prefs)
  && computeQuality({}, mkCand(1, { feed_id: 'other' }), { ...prefs, _sourceOverrides: { meh: 1 } })
    === computeQuality({}, mkCand(1, { feed_id: 'other' }), prefs));

section('2026-10-07 review fixes: selection');
const dayMs = 24 * 3600e3;
const oneDay = { entries: Array.from({ length: 12 }, (_, i) => ({ event_key: `e${i}`, category: 'ai', sent_at: Date.now() - dayMs })) };
ck('REGRESSION: rollingMix counts distinct days, so one 12-story brief is 1 day', rollingMix(oneDay, 30).days === 1);
ck('REGRESSION: one day of history does not switch on the allocation bonus', (() => {
  const pool = [mkCand(1, { category: 'finance', include_candidate: true, total_score: 50, event_key: 'f1', development_stage: 'occurred', clean_title: 'F' })];
  const out = selectStories(pool, { ...oneDay, threads: {} }, prefs, { log });
  const s = out.flatMap((x) => x.stories).find((x) => x.event_key === 'f1');
  return s && !s.allocation_bonus;
})());
ck('REGRESSION: a not-includable copy of the same event still counts toward corroboration', (() => {
  const base = { category: 'politics', development_stage: 'occurred', clean_title: 'X', event_key: 'same-event', total_score: 52 };
  const scored = [
    mkCand(1, { ...base, include_candidate: true, lean: 'left', leans: ['left'] }),
    mkCand(2, { ...base, include_candidate: false, lean: 'center-right', leans: ['center-right'], url: 'https://other.example/2' }),
  ];
  const s = selectStories(scored, { entries: [], threads: {} }, prefs, { log }).flatMap((x) => x.stories)[0];
  return s && s.leans.includes('center-right') && s.supporting.some((x) => x.url === 'https://other.example/2');
})());
ck('eventCoverage skips injection attempts', eventCoverage([mkCand(1, { event_key: 'k', prompt_injection_attempt: true })]).size === 0);
const threadHist = { entries: [], threads: { t1: { times_sent: 1, last_sent: Date.now() - dayMs, beats: [{ stage: 'occurred', state: 's' }] } } };
ck('REGRESSION: a linked development at novelty 6 passes the thread gate (prompt band 5-7)',
  threadAdvanced({ continues_thread: 't1', event_key: 'x', development_stage: 'occurred', novelty: 6 }, threadHist));
ck('"already knew this" thread needs a real stage change, novelty alone is not enough',
  !threadAdvanced({ continues_thread: 't1', event_key: 'x', development_stage: 'occurred', novelty: 9 }, { ...threadHist, quietThreads: { t1: Date.now() } }));

section('2026-10-07 review fixes: writer output');
const selSections = [
  { section: 'what_matters', label: 'Lead', detail: 'full', stories: [
    mkCand(1, { event_key: 'a', clean_title: 'A', why_it_matters: 'w' }),
    mkCand(2, { event_key: 'b', clean_title: 'B', snippet: 'First sentence. Second one. Third.' }),
  ] },
  { section: 'watching', label: 'Watch', detail: 'line', stories: [mkCand(3, { event_key: 'c', clean_title: 'C' })] },
];
const wrote = (fid, o = {}) => ({ feedback_id: fid, headline: fid.toUpperCase(), summary: 's', primary_url: 'https://evil.example', ...o });
const rebuilt = rebuildFromSelection({ todays_signal: 'S', sections: [
  { section: 'what_matters', label: 'X', stories: [wrote('a'), wrote('a', { headline: 'dupe' }), wrote('c'), wrote('zzz')] },
] }, selSections, log);
const flatR = rebuilt.sections.flatMap((s) => s.stories);
ck('REGRESSION: a story the writer dropped still appears, from its excerpt', flatR.some((s) => s.feedback_id === 'b' && s.summary.startsWith('First sentence.')));
ck('REGRESSION: a duplicated story renders once', flatR.filter((s) => s.feedback_id === 'a').length === 1);
ck('REGRESSION: the writer cannot move a Watching story into the lead', rebuilt.sections[1].section === 'watching' && rebuilt.sections[1].stories[0].feedback_id === 'c' && rebuilt.sections[1].detail === 'line');
ck('selection decides links even for written stories', flatR.every((s) => !s.primary_url.includes('evil')));
ck('a writer that covered under half the stories fails instead of being papered over',
  threw(() => rebuildFromSelection({ sections: [{ stories: [wrote('a')] }] }, selSections, log)));
ck('REGRESSION: thread context reaches the writer when the story\'s own key is the thread', await (async () => {
  let seen;
  const cap = { name: 'cap', label: 'cap', writeDigest: async ({ payload }) => {
    seen = payload;
    return { todays_signal: 'S', sections: payload.map((s) => ({ section: s.section, stories: s.stories.map((st) => wrote(st.event_key)) })) };
  } };
  const secs = [{ section: 'what_matters', label: 'L', detail: 'full', stories: [mkCand(1, { event_key: 't1', clean_title: 'T' })] }];
  await writeDigest(secs, { prompt: 'p', schema: {}, provider: cap, chain: [cap], usage: null, history: threadHist, log });
  return Boolean(seen?.[0]?.stories?.[0]?.thread_context);
})());

section('2026-10-07 review fixes: dedupe');
const raw = (title, url, o = {}) => ({ title, url, snippet: '', source: 'S', feed_id: 'f1', track: 'home_local', tier: 2, lean: 'center', published_at: Date.now(), ...o });
ck('REGRESSION: "I-96 closed" and "I-75 closed" stay two stories', normalize([
  raw('I-90 closed in Townville after crash', 'https://a.example/1', { feed_id: 'f1' }),
  raw('I-94 closed in Townville after crash', 'https://b.example/2', { feed_id: 'f2' }),
], { log }).length === 2);
ck('two same-fingerprint titles from ONE feed are not merged', normalize([
  raw('Open Thread', 'https://a.example/1'), raw('Open Thread', 'https://a.example/2'),
], { log }).length === 2);
ck('cross-feed syndication copies still merge', normalize([
  raw('Fed holds rates steady again', 'https://a.example/1', { feed_id: 'f1' }),
  raw('Fed holds rates steady again', 'https://b.example/2', { feed_id: 'f2' }),
], { log }).length === 1);
ck('REGRESSION: a promoted primary URL is registered, so its later copy is not a second story', (() => {
  const out = normalize([
    raw('Fed holds rates steady again', 'https://agg.example/1', { feed_id: 'agg', tier: 2 }),
    raw('Fed holds rates steady again', 'https://wire.example/2', { feed_id: 'wire', tier: 1 }),
    raw('A different headline, same wire article', 'https://wire.example/2', { feed_id: 'f3' }),
  ], { log });
  return out.length === 1 && out[0].url === 'https://wire.example/2';
})());

section('2026-10-07 review fixes: history and feedback');
const hrs = (h) => ({ entries: [{ sent_at: Date.now() - h * 3600e3 }] });
ck('lookback: 30 h with no history, 30 h after a normal day, 56 h after 50 h, capped at 72',
  lookbackFromHistory({ entries: [] }) === 30 && lookbackFromHistory(hrs(24)) === 30
  && lookbackFromHistory(hrs(50)) === 56 && lookbackFromHistory(hrs(300)) === 72);
const tmp = await mkdtemp(join(tmpdir(), 'brief-test-'));
await writeFileT(join(tmp, 'bad.json'), '{ "entries": [ <<<<<<< HEAD');
ck('REGRESSION: an unreadable history.json throws instead of silently starting fresh',
  await loadHistory(join(tmp, 'bad.json'), { log }).then(() => false, () => true));
ck('a missing history.json is a normal first run', (await loadHistory(join(tmp, 'none.json'), { log })).entries.length === 0);

const fbHist = () => ({
  entries: [
    { event_key: 'k1', category: 'ai', source: 'Old', geography: 'us', sent_at: 1 },
    { event_key: 'k1', category: 'ai', source: 'New', geography: 'us', sent_at: 2 },
  ],
  feedbackWeights: { categories: {}, sources: {}, geographies: {} }, feedbackLog: [],
});
const h1 = fbHist();
const r1 = collectFeedback(h1, [{ uid: 1, subject: 'brief-feedback: less k1', messageId: '<m1>' }], log);
const r2 = collectFeedback(h1, [{ uid: 1, subject: 'Re: brief-feedback: less k1', messageId: '<m1>' }], log);
ck('a feedback message is applied exactly once by Message-ID', r1.applied === 1 && r2.applied === 0 && r2.skipped === 1 && h1.feedbackWeights.categories.ai === -2);
ck('REGRESSION: feedback credits the most recent send of a repeated event', h1.feedbackWeights.sources.New === -3 && !h1.feedbackWeights.sources.Old);
const r3 = collectFeedback(fbHist(), [{ uid: 9, subject: 'brief-feedback: less gone-key', messageId: '<m9>' }], log);
ck('REGRESSION: a signal for an event no longer in history is not marked processed', r3.applied === 0 && r3.uids.length === 0);
ck('subjects that are not feedback are ignored', parseSubject('Your Google account') === null);

section('2026-10-07 review fixes: CLI provider and usage');
const fakeBin = join(tmp, 'fake-claude.mjs');
await writeFileT(fakeBin, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const a = process.argv.slice(2);
  const ok = a.includes('--system-prompt') && a[a.indexOf('--tools') + 1] === '' && !a.some((x) => x.includes('UNTRUSTED'));
  process.stdout.write(JSON.stringify({ result: JSON.stringify({ ok, stdin: input.includes('UNTRUSTED') }), usage: { input_tokens: 1, output_tokens: 7, output_tokens_details: { thinking_tokens: 5 }, cache_creation_input_tokens: 3 }, num_turns: 1 }));
});
`);
await chmod(fakeBin, 0o755);
ck('the CLI gets instructions as --system-prompt, data on stdin, and no tools', await (async () => {
  const out = JSON.parse(await runCli(fakeBin, ['-p', '--system-prompt', 'SYS', '--tools', ''], '=== BEGIN UNTRUSTED ARTICLE DATA ===', process.env));
  const res = JSON.parse(out.result);
  return res.ok && res.stdin;
})());
ck('a hung CLI call times out and says so', await runCli('sleep', ['5'], '', process.env, 200).then(() => false, (e) => e.timeout === true));
const ut = createUsageTracker();
ut.record('haiku', { input_tokens: 1, output_tokens: 7, output_tokens_details: { thinking_tokens: 5 }, cache_creation_input_tokens: 3, num_turns: 1 });
ck('usage records thinking tokens and cache writes', ut.snapshot().total.thinking === 5 && ut.snapshot().total.cacheWrite === 3);
ck('REGRESSION: open threads are actually sent to the scorer',
  historyBlock('', [{ key: 'fed-path', stage: 'pending', days_since: 2, times_sent: 1, state: 'Fed paused' }]).includes('fed-path | pending | 2 | 1 | Fed paused'));


section('event dedupe: one event, one key');
const evSchema = JSON.parse(await readFile(join(ROOT, 'schema/event_groups_schema.json'), 'utf8'));
const evItem = (i, o = {}) => mkCand(i, { include_candidate: true, total_score: 60 - i, development_stage: 'occurred', category: 'finance', novelty: 8, ...o });
const fomc = () => [
  evItem(1, { event_key: 'fomc-minutes-hike-expected', clean_title: 'FOMC minutes: officials expect another rate hike will be needed this year', lean: 'primary', leans: ['primary'], source: 'Fed', url: 'https://fed.example/minutes' }),
  evItem(2, { event_key: 'fed-minutes-little-appetite', clean_title: 'Fed minutes show little appetite for a series of hikes after September increase', lean: 'right', leans: ['right'], source: 'Wire', url: 'https://wire.example/minutes' }),
  evItem(3, { event_key: 'treasury-auction-solid', clean_title: 'Treasury yields ease after solid 10-year auction', url: 'https://wire.example/auction' }),
];
const grouping = (groups, onCall = () => {}) => ({ name: 'g', label: 'g', groupEvents: async (args) => { onCall(args); return { groups }; } });
const runMerge = (scored, prov, hist = { entries: [] }) =>
  mergeDuplicateEvents(scored, hist, { prompt: 'p', schema: evSchema, chain: [prov], usage: null, log });
const pair = (t1, t2, o1 = {}, o2 = {}) => {
  const a = evItem(1, { event_key: 'k-a', clean_title: t1, ...o1 });
  const b = evItem(2, { event_key: 'k-b', clean_title: t2, ...o2 });
  applyGroups([['c1', 'c2']], { today: [a, b] });
  return a.event_key === b.event_key;
};

const evA = fomc();
await runMerge(evA, grouping([['c1', 'c2']]));
ck('REGRESSION: two outlets\' reports of the same Fed minutes get one key', evA[0].event_key === evA[1].event_key && evA[0].event_key === 'fomc-minutes-hike-expected');
ck('the absorbed key is remembered for history', evA[0].merged_keys.includes('fed-minutes-little-appetite'));
ck('a different event in the same batch keeps its own key', evA[2].event_key === 'treasury-auction-solid');
ck('REGRESSION: the merged event appears once in the brief', selectStories(evA, { entries: [], threads: {} }, prefs, { log })
  .flatMap((x) => x.stories).filter((x) => x.event_key === 'fomc-minutes-hike-expected').length === 1);
ck('a model-proposed merge adds no lean, link or corroboration to the survivor', (() => {
  const st = selectStories(evA, { entries: [], threads: {} }, prefs, { log }).flatMap((x) => x.stories).find((x) => x.event_key === 'fomc-minutes-hike-expected');
  return st.leans.join() === 'primary' && !st.supporting.some((x) => x.url === 'https://wire.example/minutes');
})());

ck('guardrail: same category, no rare shared word -> not merged (minutes vs auction)', !pair(fomc()[0].clean_title, 'Treasury yields ease after solid 10-year auction'));
ck('guardrail: a shared word across categories is not enough', !pair('Storm leaves 3 dead across the county', 'Study finds 3 cups of coffee a day is fine', { category: 'politics' }, { category: 'quality_of_life' }));
ck('guardrail: numbers alone never count ("2 million" vs "2 billion")', !pair('Ford recalls 2 million vehicles', 'Apple raises 2 billion in bond sale'));
ck('guardrail: one short common name is not enough (two different Trump stories)', !pair('Trump signs order on tariffs', 'Trump visits factory', { category: 'politics' }, { category: 'politics' }));
ck('acronyms count as strong evidence (CPI)', pair('CPI rises 0.3% in September', 'CPI report shows inflation cooling'));
ck('plurals fold together (rates/rate, raises/raise)', pair('Fed raises rates by a quarter point', 'Fed rate raise: quarter point increase'));
ck('salientTokens: acronyms marked, bare numbers dropped', (() => { const t = salientTokens('UAW strikes GM over 25 plants'); return t.has('#uaw') && t.has('#gm') && t.has('strike') && !t.has('25'); })());
ck('a word in more than 3 of today\'s titles is not rare enough', (() => {
  const items = ['Wisconsin Senate passes budget', 'Wisconsin State wins opener', 'Wisconsin gas prices climb', 'Wisconsin schools add staff']
    .map((t, i) => evItem(i + 1, { event_key: `m${i}`, clean_title: t, category: 'politics' }));
  applyGroups([['c1', 'c2']], { today: items });
  return items[0].event_key !== items[1].event_key;
})());

const sentRecent = { event_key: 'fed-minutes-released', thread: 'fed-path-2026', title: 'Fed releases September meeting minutes showing hike debate', category: 'finance', sent_at: Date.now() - 20 * 3600e3 };
const evB = fomc();
applyGroups([['c1', 'c2', 'sent:unrelated']], { today: evB, sent: [{ event_key: 'unrelated', title: 'Ski resort opens early', category: 'finance', sent_at: Date.now() - 3600e3 }] });
ck('REGRESSION: an unrelated sent id in the group does not cancel today\'s merge', evB[0].event_key === evB[1].event_key && evB[0].event_key === 'fomc-minutes-hike-expected');
const evC = fomc();
applyGroups([['c2', 'sent:fed-minutes-released']], { today: evC, sent: [sentRecent] });
ck('a repeat of an event sent yesterday takes the original key and thread', evC[1].event_key === 'fed-minutes-released' && evC[1].repeat_of === 'fed-minutes-released' && evC[1].continues_thread === 'fed-path-2026');
ck('REGRESSION: a matched repeat is held back even with scorer novelty 8 (needs a stage change)',
  !threadAdvanced(evC[1], { entries: [sentRecent], threads: { 'fed-path-2026': { times_sent: 1, last_sent: sentRecent.sent_at, beats: [{ stage: 'occurred', state: 's' }] } } }));
ck('  and with no thread on record it is held back too', !threadAdvanced(evC[1], { entries: [sentRecent], threads: {} }));
const evD = fomc();
applyGroups([['c2', 'sent:fed-minutes-released']], { today: evD, sent: [{ ...sentRecent, title: 'Fed chair speaks at conference' }] });
ck('a weak overlap with an earlier send is not treated as a repeat', evD[1].event_key === 'fed-minutes-little-appetite' && !evD[1].repeat_of);

const evE = fomc();
const sibling = evItem(9, { event_key: 'fed-minutes-little-appetite', include_candidate: false, clean_title: 'Fed minutes: little appetite for hikes', lean: 'left', leans: ['left'], url: 'https://left.example/minutes' });
applyGroups([['c1', 'c2']], { today: evE, scored: [...evE, sibling] });
ck('REGRESSION: a copy the scorer keyed with an absorbed item follows it, and adds no lean', sibling.event_key === 'fomc-minutes-hike-expected' && sibling.model_grouped
  && !selectStories([...evE, sibling], { entries: [], threads: {} }, prefs, { log }).flatMap((x) => x.stories).find((x) => x.event_key === 'fomc-minutes-hike-expected').leans.includes('left'));
const evF = fomc();
applyGroups([['c1', 'c2']], { today: evF, historyKeys: new Set(['fed-minutes-little-appetite']) });
ck('REGRESSION: a member already tied to history keeps that key for the group', evF[0].event_key === 'fed-minutes-little-appetite');
ck('a group larger than 6 is skipped entirely', (() => {
  const many = Array.from({ length: 8 }, (_, i) => evItem(i + 1, { event_key: `k${i}`, clean_title: `Fed minutes hike debate item ${i}` }));
  applyGroups([many.map((x) => x.id)], { today: many });
  return new Set(many.map((x) => x.event_key)).size === 8;
})());
ck('at most 8 stories are absorbed per run', (() => {
  const items = Array.from({ length: 20 }, (_, i) => evItem(i + 1, { event_key: `k${i}`, clean_title: `Topic${Math.floor(i / 2)} quarterly earnings beat` }));
  applyGroups(Array.from({ length: 10 }, (_, g) => [`c${2 * g + 1}`, `c${2 * g + 2}`]), { today: items });
  return 20 - new Set(items.map((x) => x.event_key)).size === 8;
})());
const evG = fomc();
evG[1].prompt_injection_attempt = true;
await runMerge(evG, grouping([['c1', 'c2']]));
ck('an item flagged as a prompt injection is never offered for merging', evG[1].event_key === 'fed-minutes-little-appetite');
let seenPayload;
await runMerge(fomc(), grouping([], (args) => { seenPayload = args.payload; }), { entries: [{ ...sentRecent }, { event_key: 'old', title: 'Old', category: 'ai', sent_at: Date.now() - 6 * 24 * 3600e3 }] });
ck('the grouping call gets no links, no sent categories, and only sends from the last 96 h',
  seenPayload && !JSON.stringify(seenPayload).includes('https://') && seenPayload.already_sent.length === 1 && !('category' in seenPayload.already_sent[0]));
const evH = fomc();
evH[1].clean_title = 'FOMC minutes: officials expect another rate hike will be needed this year, report says';
await runMerge(evH, { name: 'boom', label: 'boom', groupEvents: async () => { throw new Error('down'); } });
ck('a failed grouping call falls back to word overlap (syndicated rewrite still merges)', evH[0].event_key === evH[1].event_key);
ck('word overlap does not merge a reframed report (that needs the model)', lexicalGroups({ today: [
  { id: 'a', title: 'FOMC minutes: officials expect another rate hike', category: 'finance' },
  { id: 'b', title: 'Fed minutes show little appetite for a series of hikes', category: 'finance' }] }).length === 0);
ck('history aliases count as sent for 96 h, then expire', (() => {
  const st = { event_key: 'old-alias', development_stage: 'occurred', novelty: 2 };
  const fresh = !threadAdvanced(st, { entries: [{ event_key: 'canonical', aliases: ['old-alias'], sent_at: Date.now() - 3600e3 }], threads: {} });
  const stale = threadAdvanced(st, { entries: [{ event_key: 'canonical', aliases: ['old-alias'], sent_at: Date.now() - 5 * 24 * 3600e3 }], threads: {} });
  return fresh && stale;
})());

section('on-time trigger (Cloudflare Worker)');
const at = (iso) => new Date(iso);
const trigNames = (p) => p.jobs.map((j) => j.workflow).join(',');
ck('3 AM EDT starts the brief only (alerts wait for 7 AM)', trigNames(triggerPlan(at('2026-10-08T07:01:00Z'))) === 'daily-brief.yml');
ck('3 AM EST (winter) also starts the brief, no second cron line needed', trigNames(triggerPlan(at('2026-12-15T08:01:00Z'))) === 'daily-brief.yml');
ck('2 AM starts nothing', trigNames(triggerPlan(at('2026-12-15T07:01:00Z'))) === '');
ck('7 AM starts the first alert check of the day', trigNames(triggerPlan(at('2026-10-08T11:01:00Z'))) === 'breaking-alert.yml');
ck('10 PM starts the last alert check of the day', trigNames(triggerPlan(at('2026-10-09T02:01:00Z'))) === 'breaking-alert.yml');
ck('11 PM starts nothing', trigNames(triggerPlan(at('2026-10-09T03:01:00Z'))) === '');
ck('across the DST change (Nov 1) 3 AM still means 3 AM local',
  trigNames(triggerPlan(at('2026-11-01T07:01:00Z'))) === '' && trigNames(triggerPlan(at('2026-11-01T08:01:00Z'))) === 'daily-brief.yml');
ck('4 AM adds a catch-up brief that only fires if no brief run started in the last 2 h', (() => {
  const p4 = triggerPlan(at('2026-10-08T08:01:00Z'));
  return trigNames(p4) === 'daily-brief.yml' && p4.jobs[0].unlessRunWithinMs === 2 * 3600e3 && !triggerPlan(at('2026-10-08T07:01:00Z')).jobs[0].unlessRunWithinMs;
})());
ck('every dispatch says scheduled=true so the workflow applies its own checks', [...triggerPlan(at('2026-10-08T07:01:00Z')).jobs, ...triggerPlan(at('2026-10-08T11:01:00Z')).jobs].every((j) => j.inputs.scheduled === 'true'));

const env = { GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_REF: 'main', GITHUB_TOKEN: 'tok-SECRET-123' };
const fakeFetch = (statuses, seen = []) => async (url, init) => {
  seen.push({ url, init });
  const status = statuses.shift() ?? 204;
  return { status, text: async () => (status === 204 ? '' : `{"message":"error ${status}"}`) };
};
const seen1 = [];
const trigR1 = await triggerDispatch({ workflow: 'daily-brief.yml', inputs: { scheduled: 'true' } }, env, fakeFetch([204], seen1));
ck('dispatch posts to the workflow_dispatch endpoint with ref and inputs', trigR1.ok && seen1[0].url === 'https://api.github.com/repos/o/r/actions/workflows/daily-brief.yml/dispatches'
  && JSON.parse(seen1[0].init.body).ref === 'main' && JSON.parse(seen1[0].init.body).inputs.scheduled === 'true' && seen1[0].init.method === 'POST');
ck('a GitHub 5xx is retried once', (await triggerDispatch({ workflow: 'w', inputs: {} }, env, fakeFetch([502, 204]), { retryDelayMs: 0 })).attempts === 2);
const seen401 = [];
const r401 = await triggerDispatch({ workflow: 'w', inputs: {} }, env, fakeFetch([401, 204], seen401), { retryDelayMs: 0 });
ck('a 401 (expired token) is not retried and is reported', !r401.ok && r401.status === 401 && seen401.length === 1);
ck('the token never appears in the reported error', !JSON.stringify(r401).includes('tok-SECRET-123'));
const logged = [];
const realFetch = globalThis.fetch;
const origErr = console.error, origLog = console.log;
console.error = (...a) => logged.push(a.join(' ')); console.log = (...a) => logged.push(a.join(' '));
globalThis.fetch = fakeFetch([403, 403]);
try {
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-08T08:01:00Z') }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-08T08:01:00Z') }, { ...env, GITHUB_TOKEN: '' }, { waitUntil: () => {} });
} finally {
  globalThis.fetch = realFetch; console.error = origErr; console.log = origLog;
}
ck('the Worker logs a failed dispatch with its HTTP status, without the token',
  logged.some((l) => l.includes('daily-brief.yml dispatch failed (HTTP 403)')) && !logged.some((l) => l.includes('tok-SECRET-123')));
ck('a missing token is reported instead of calling GitHub', logged.some((l) => l.includes('GITHUB_TOKEN secret is not set')));
const catchup = { workflow: 'daily-brief.yml', inputs: { scheduled: 'true' }, unlessRunWithinMs: 2 * 3600e3 };
const lookup = (total, seen = []) => async (url, init = {}) => {
  seen.push({ url, method: init.method ?? 'GET' });
  if ((init.method ?? 'GET') === 'GET') return { status: total === 'err' ? 500 : 200, json: async () => ({ total_count: total }), text: async () => '' };
  return { status: 204, text: async () => '' };
};
const quiet = async (fn) => { const e = console.error, l = console.log; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; } };
const seenA = [], seenB = [], seenC = [];
await quiet(() => triggerRunJob(catchup, env, 8, { fetchImpl: lookup(1, seenA), retryDelayMs: 0 }));
await quiet(() => triggerRunJob(catchup, env, 8, { fetchImpl: lookup(0, seenB), retryDelayMs: 0 }));
await quiet(() => triggerRunJob(catchup, env, 8, { fetchImpl: lookup('err', seenC), retryDelayMs: 0 }));
ck('catch-up: a brief already started today -> no second dispatch', seenA.length === 1 && seenA[0].method === 'GET' && seenA[0].url.includes('/actions/workflows/daily-brief.yml/runs?created=%3E%3D'));
ck('catch-up: no brief run in 2 h -> dispatches', seenB.some((x) => x.method === 'POST'));
ck('catch-up: a failed lookup never dispatches (never risk a second full brief)', !seenC.some((x) => x.method === 'POST'));
let trigCalls = 0;
const flaky = async () => { trigCalls++; if (trigCalls === 1) throw new Error('socket hang up'); return { status: 204, text: async () => '' }; };
ck('a network error is retried like a 5xx', (await triggerDispatch({ workflow: 'w', inputs: {} }, env, flaky, { retryDelayMs: 0 })).ok && trigCalls === 2);
ck('one job that throws cannot skip the next', await quiet(async () => {
  const r = await triggerRunJob({ workflow: 'w', inputs: {} }, env, 7, { fetchImpl: async () => { throw new Error('boom'); }, retryDelayMs: 0 });
  return r.ok === false;
}));

console.log(failures ? `\n\x1b[31m${failures} of ${count} failed\x1b[0m` : `\n\x1b[32mall ${count} passed\x1b[0m`);
process.exit(failures ? 1 : 0);
