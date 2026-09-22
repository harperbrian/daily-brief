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
import { urgencyScore, impactScore, selectAlerts, alertKey, renderAlert, MAX_ALERTS_PER_DAY } from '../src/alert.js';
import { quakeMattersTo, distanceKm } from '../src/quakes.js';
import { applyFeedbackForTest, SIGNAL_NAMES } from '../src/feedback.js';

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
const rescued = await scoreCandidates(oneCandidate, { prompt: 'p', schema: scoringSchema, preferences: prefs, historyText: '', historyKeys: new Set(), openThreads: [], provider: failing, chain: [failing, heuristic], log });
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
const U = (o) => urgencyScore({ title: '', snippet: '', track: 'us', tier: 2, lean: 'center', published_at: Date.now(), ...o });
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
ck('a magnitude-7 quake anywhere still alerts', U({ title: 'Magnitude 7.4 earthquake hits off Japan', lean: 'primary', tier: 1 }) >= 70);
ck('a non-local plane crash on the wires does not alert', U({ title: 'Small plane crash kills two in Nevada', tier: 1 }) < 70);
ck('a local plane crash does', U({ title: 'F-16 from Texas crashes in Wisconsin, evacuation order lifted', track: 'home_region', tier: 1 }) >= 70);
ck('a nationwide child-product recall from FDA still alerts', U({ title: 'FDA announces nationwide recall of infant formula', lean: 'primary', tier: 1 }) >= 70);
ck('freshness never lifts an item over the bar', U({ title: 'State of emergency declared in Oregon', tier: 1, published_at: Date.now() }) < 70);
const urgent = { title: 'Tornado Warning issued for Dane County', snippet: '', url: 'https://e.com/t', source: 'NWS', track: 'home_local', tier: 1, lean: 'primary', alert: true, published_at: Date.now() };
ck('only the urgent item is selected', selectAlerts([urgent, { ...urgent, title: 'Library book sale Saturday' }], { entries: [], alerts: [] }, { log }).length === 1);
ck('same alert never sent twice', selectAlerts([urgent], { entries: [], alerts: [{ key: alertKey(urgent), day: '2000-01-01', at: Date.now() }] }, { log }).length === 0);
// ── friends and family: impact only, never warnings ──────────────────────
const PP = (o) => urgencyScore({ title: '', snippet: '', track: 'people', tier: 2, lean: 'center', published_at: Date.now(), place: 'denver', place_match: 'denver|denver county', ...o });
ck('people: a warning is not impact', PP({ title: 'Severe Thunderstorm Warning issued for Denver County', lean: 'primary', tier: 1 }) === 0);
ck('people: a tornado WATCH is not impact', PP({ title: 'Tornado watch issued for Denver area until 9 PM' }) === 0);
ck('people: NWS tornado emergency is', PP({ title: 'Tornado Emergency issued for Denver County', lean: 'primary', tier: 1 }) >= 70);
ck('people: NWS tsunami warning is', PP({ title: 'Tsunami Warning issued for Coos Bay', lean: 'primary', tier: 1, place_match: 'coos bay|north bend' }) >= 70);
ck('people: evacuation order in the place fires', PP({ title: 'Evacuation orders issued as brush fire spreads toward Denver suburb' }) >= 70);
ck('people: tornado with damage fires', PP({ title: 'Tornado tears through Denver neighborhood, homes destroyed' }) >= 70);
ck('people: tornado with no damage word does not', PP({ title: 'Tornado spotted briefly west of Denver' }) === 0);
ck('people: casualty count fires', PP({ title: '3 dead, 12 injured after Denver apartment explosion' }) >= 70);
ck('people: boil-water notice fires', PP({ title: 'Boil water notice issued for parts of Denver after main break' }) >= 70);
ck('people: single fatal crash does not', PP({ title: 'Driver killed in crash on Denver expressway' }) === 0);
ck('people: ordinary shooting does not', PP({ title: 'Man shot on Denver east side' }) === 0);
ck('people: mass shooting does', PP({ title: 'Mass shooting at Denver parade leaves 6 dead' }) >= 70);
ck('people: impact elsewhere in the feed does not', PP({ title: 'Evacuations ordered as wildfire spreads near Pueblo' }) === 0);
ck('people: preparedness stories excluded', PP({ title: 'Denver earthquake drill: how the city prepares for disaster' }) === 0);
ck('people: anniversary stories excluded', PP({ title: 'Ten years after the Denver derailment, residents remember' }) === 0);
ck('people: metro item must name the suburb', PP({ title: 'Evacuation orders lifted in Yarnell fire', place: 'phoenix', place_match: 'phoenix|scottsdale|tempe|mesa' }) === 0);
ck('people: a fire that does name it fires', PP({ title: 'Scottsdale fire forces evacuations, homes burn', place: 'phoenix', place_match: 'phoenix|scottsdale|tempe|mesa' }) >= 70);
ck('people: synthesized quake candidate fires', PP({ title: 'M6.1 earthquake 18 mi from Ridgecrest, CA', quake: true, lean: 'primary', tier: 1, place: 'ridgecrest', place_match: 'ridgecrest' }) >= 70);
ck('people: impactScore ignores the home-track patterns', impactScore({ title: 'Flash Flood Warning issued for Denver County', lean: 'primary', place_match: 'denver|denver county', snippet: 'Denver' }) === 0);
ck('people: rendered alert says who is near', (() => { const html = renderAlert([{ title: 'T', url: 'https://e.com', source: 'S', snippet: '', place_people: 'Sam and Jordan', place_name: 'Denver, CO' }], { tz: 'America/Chicago' }); return html.includes('Near Sam and Jordan') && html.includes('Denver, CO'); })());
const anchor = { lat: 35.7736, lng: -117.6716 };
ck('quake: M6 within 100 mi matters', !!quakeMattersTo({ mag: 6.0, lat: 35.8987, lng: -117.5522 }, anchor));
ck('quake: M4.6 under the city does not', !quakeMattersTo({ mag: 4.6, lat: 35.7787, lng: -117.6722 }, anchor));
ck('quake: M7 in Japan does not', !quakeMattersTo({ mag: 7.0, lat: 35, lng: 139 }, anchor));
ck('quake: USGS yellow impact within 300 km does', !!quakeMattersTo({ mag: 5.2, alert: 'yellow', lat: 35.8987, lng: -117.8522 }, anchor));
ck('quake: distance sanity (anchor to LA is about 198 km)', Math.abs(distanceKm(35.7736, -117.6716, 34.0522, -118.2437) - 198) < 5);
ck('daily cap enforced', selectAlerts([urgent], { entries: [], alerts: Array.from({ length: MAX_ALERTS_PER_DAY }, (_, i) => ({ key: `k${i}`, day: new Intl.DateTimeFormat('en-CA').format(new Date()), at: Date.now() })) }, { log }).length === 0);

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

console.log(failures ? `\n\x1b[31m${failures} of ${count} failed\x1b[0m` : `\n\x1b[32mall ${count} passed\x1b[0m`);
process.exit(failures ? 1 : 0);
