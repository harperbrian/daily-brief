/**
 * Triage. The provider returns ten independent relevance dimensions per item;
 * this module turns them into a score. The model never computes a total —
 * models are unreliable at arithmetic under a schema, and a wrong sum silently
 * corrupts ranking.
 *
 * The scoring shape is the load-bearing decision here. See computeRelevance().
 *
 * Resilience: batches run with limited concurrency, cascade through every
 * configured provider, and a batch that still fails is rescored by the
 * rule-based provider rather than dropped — a degraded batch beats 25 silently
 * missing stories.
 */
import * as heuristic from './providers/heuristic.js';

const BATCH_SIZE = 25;

export async function scoreCandidates(
  candidates,
  { prompt, schema, preferences, historyText, historyKeys, openThreads, provider, chain, usage, log }
) {
  const providers = chain?.length ? chain : [provider];
  const batches = chunk(candidates, BATCH_SIZE);
  log(`scoring ${candidates.length} candidates in ${batches.length} batches via ${providers[0].label}`);

  let rescued = 0;
  const usedProviders = new Set();
  const results = await mapLimit(batches, providers[0].concurrency ?? 3, async (batch, i) => {
    const { stories, usedName, wasRescued } = await scoreBatchWithRetry(providers, batch, {
      prompt, schema, historyText, historyKeys, openThreads, preferences, usage, log, index: i,
    });
    if (wasRescued) rescued++;
    if (usedName) usedProviders.add(usedName);
    return stories;
  });

  const enums = readEnums(schema);
  const threadKeys = new Set((openThreads ?? []).map((t) => t.key));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const scored = [];

  for (const raw of results.flat()) {
    const story = sanitizeStory(raw, enums, threadKeys);
    const candidate = story && byId.get(story.id);
    if (!candidate) continue; // invented or mangled id; drop rather than trust
    scored.push({ ...candidate, ...story, ...computeScore(story, candidate, preferences) });
  }

  scored.sort((a, b) => b.total_score - a.total_score);
  log(`scored ${scored.length} candidates; ${scored.filter((s) => s.include_candidate).length} marked includable`);
  return { scored, meta: { batches: batches.length, rescued, providers: [...usedProviders] } };
}

/**
 * Enum values are read off the schema rather than restated here. The schema JSON
 * is the single source of truth, which makes drift between the two structurally
 * impossible — previously this file carried verbatim copies that had to be kept
 * in sync by hand.
 */
export function readEnums(schema) {
  const props = schema?.properties?.stories?.items?.properties ?? {};
  // For array-typed properties the enum lives on `items`, not the property.
  // Reading `.enum` directly returned undefined and silently discarded every
  // sourcing and framing flag the model reported.
  const pick = (name, fallback) =>
    new Set(props[name]?.enum ?? props[name]?.items?.enum ?? fallback);
  return {
    categories: pick('category', ['ai', 'finance', 'career', 'entrepreneurship', 'politics', 'parenting', 'quality_of_life']),
    geographies: pick('geography', ['home_region', 'us', 'global', 'property_area', 'not_applicable']),
    stages: pick('development_stage', ['proposed', 'pending', 'occurred', 'ongoing', 'retrospective']),
    evidence: pick('evidence_stage', ['not_applicable', 'preclinical', 'observational', 'randomized_trial', 'guideline', 'regulatory_action', 'unclear']),
    sourcingFlags: pick('sourcing_flags', []),
    framingFlags: pick('framing_flags', []),
  };
}

export const DIMENSIONS = [
  'financial_impact', 'career_impact', 'investment', 'decision_change',
  'business_opportunity', 'property', 'home_purchase', 'magnitude',
  'geographic', 'novelty',
];

/**
 * Peak-blended weighted mean — the core of the whole redesign.
 *
 *   breadth   = Σ wᵢ·dᵢ                    the weighted average
 *   peak      = max(πᵢ·dᵢ)                 the strongest ELIGIBLE single reason
 *   relevance = 10·(breadth + λ·(peak − breadth))
 *
 * Why not a plain weighted sum: the dimensions are sparse. Most stories score
 * zero on the property, home purchase, and career. Under a plain sum a
 * a property-area STR ordinance scoring 10 on property alone gets 0.10×10 = 1.0
 * and loses to a forgettable story scoring 4 across six dimensions. The profile
 * explicitly requires the opposite: "A story with very high relevance in one
 * area should be able to outrank mediocre stories touching several categories."
 *
 * λ (peak_gain) interpolates between the weighted mean and the max. At λ=0 this
 * degenerates to exactly the plain weighted sum, which makes that its own
 * regression test.
 *
 * πᵢ (peak_eligibility) is the second knob and the one that encodes the
 * anti-engagement rule as arithmetic rather than prompt English. novelty has
 * π=0 and geography π=0.3, so neither can ever be GROUNDS for inclusion — only
 * a modifier. Nothing is worth reading merely because it is new, or merely
 * because it happened nearby. This generalizes the gate already proven in
 * src/alert.js, where locality plus freshness summing to the alert threshold
 * with no actual event was a real bug caught by a test.
 *
 * The blend stays monotone in every dimension (∂/∂dᵢ = (1−λ)wᵢ > 0), so no
 * dimension is ever fully ignored — which matters because feedback weights need
 * a gradient to act on.
 */
export function computeRelevance(story, relevanceConfig) {
  const cfg = relevanceConfig ?? {};
  const dims = cfg.dimensions ?? {};
  const lambda = cfg.peak_gain ?? 0.55;

  // Weights are relative and normalized here, so config stays human-readable and
  // editing one weight does not require rebalancing the rest to sum to 1.
  let weightTotal = 0;
  for (const d of DIMENSIONS) weightTotal += dims[d]?.weight ?? 0;
  if (weightTotal <= 0) return 0;

  let breadth = 0;
  let peak = 0;
  for (const d of DIMENSIONS) {
    const value = clamp(story[d], 0, 10);
    const w = (dims[d]?.weight ?? 0) / weightTotal;
    const pi = dims[d]?.peak_eligibility ?? 1;
    breadth += w * value;
    peak = Math.max(peak, pi * value);
  }

  return 10 * (breadth + lambda * Math.max(0, peak - breadth));
}

/**
 * Source quality, deterministic from config. A cluster's effective quality is
 * the BEST class among everything that covered the story: an aggregator that
 * breaks a story is lifted when a primary source actually corroborates it —
 * lifted by a corroborating article arriving, never by a model's belief that one
 * probably exists.
 *
 * The model's sourcing_flags can lower this within a floor, and can never raise
 * it. Model reports observations; code sets prices.
 */
export function computeQuality(story, candidate, preferences) {
  const cfg = preferences.source_quality ?? {};
  const multipliers = cfg.multipliers ?? {};
  const classes = candidate?.source_classes?.length
    ? candidate.source_classes
    : [candidate?.source_class ?? 'established'];

  const base = Math.max(...classes.map((c) => multipliers[c] ?? 0.8));

  let deduction = 1;
  for (const flag of story.sourcing_flags ?? []) {
    deduction *= cfg.model_deductions?.[flag] ?? 1;
  }
  const floor = cfg.model_floor_ratio ?? 0.6;
  return base * Math.max(floor, deduction);
}

/**
 * Framing penalties, multiplicative rather than subtractive. A flat 15-point
 * deduction is 17% of a 90 and 50% of a 30 — subtracting punishes weak stories
 * harder than strong ones for the same offense, which is backwards.
 */
export function computeIntegrity(story, preferences) {
  const cfg = preferences.integrity ?? {};
  const deductions = cfg.deductions ?? {};
  let value = 1;
  for (const flag of story.framing_flags ?? []) value *= deductions[flag] ?? 1;
  return Math.max(cfg.floor ?? 0.35, value);
}

/** Full score. allocationBonus is applied later, in select.js, where the set is known. */
export function computeScore(story, candidate, preferences) {
  const relevance = computeRelevance(story, preferences.relevance);
  const quality = computeQuality(story, candidate, preferences);
  const integrity = computeIntegrity(story, preferences);

  const fw = preferences._feedbackWeights ?? {};
  const feedbackAdj =
    (fw.categories?.[story.category] ?? 0) +
    (fw.sources?.[candidate?.source] ?? 0) +
    (fw.geographies?.[story.geography] ?? 0);

  // Which dimension actually drove the RANKING — weighted by peak eligibility,
  // not the raw maximum. Novelty is 8-10 on anything new, so a raw argmax names
  // it constantly while it contributes nothing to rank (peak_eligibility 0).
  // That would mislead both the golden-set diagnosis and the "very important"
  // weight calibration, which are the two things this field exists to feed.
  const dimCfg = preferences.relevance?.dimensions ?? {};
  let topDimension = null;
  let topValue = -1;
  for (const d of DIMENSIONS) {
    const contribution = clamp(story[d], 0, 10) * (dimCfg[d]?.peak_eligibility ?? 1);
    if (contribution > topValue) { topValue = contribution; topDimension = d; }
  }

  return {
    relevance: Math.round(relevance * 10) / 10,
    quality: Math.round(quality * 100) / 100,
    integrity: Math.round(integrity * 100) / 100,
    top_dimension: topDimension,
    total_score: Math.max(0, Math.round(relevance * quality * integrity + feedbackAdj)),
  };
}

/**
 * Providers without hard schema enforcement can return slightly-off values.
 * Coerce rather than crash: bad enums degrade to safe defaults, numbers are
 * clamped, and only an unusable record is dropped.
 */
function sanitizeStory(raw, enums, threadKeys) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;

  const category = enums.categories.has(raw.category) ? raw.category : 'politics';
  const out = {
    ...raw,
    id: String(raw.id),
    event_key: slug(raw.event_key || raw.id),
    clean_title: String(raw.clean_title ?? '').slice(0, 300),
    category,
    geography: enums.geographies.has(raw.geography) ? raw.geography : 'not_applicable',
    development_stage: enums.stages.has(raw.development_stage) ? raw.development_stage : 'occurred',
    evidence_stage: enums.evidence.has(raw.evidence_stage)
      ? raw.evidence_stage
      : category === 'quality_of_life'
        ? 'unclear'
        : 'not_applicable',
    // Only a thread the pipeline already knows about is accepted. The model
    // judges which thread a story continues; code owns thread identity, so an
    // invented key cannot silently fork a thread.
    continues_thread:
      typeof raw.continues_thread === 'string' && threadKeys.has(raw.continues_thread)
        ? raw.continues_thread
        : null,
    sourcing_flags: filterEnum(raw.sourcing_flags, enums.sourcingFlags),
    framing_flags: filterEnum(raw.framing_flags, enums.framingFlags),
    prompt_injection_attempt: raw.prompt_injection_attempt === true,
    include_candidate: raw.include_candidate === true,
    why_it_matters: String(raw.why_it_matters ?? ''),
  };
  for (const d of DIMENSIONS) out[d] = clamp(raw[d], 0, 10);
  return out;
}

const filterEnum = (arr, allowed) =>
  Array.isArray(arr) ? arr.filter((f) => typeof f === 'string' && allowed.has(f)) : [];

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'unknown';

async function scoreBatchWithRetry(providers, batch, ctx) {
  const payload = batch.map((c) => ({
    id: c.id,
    title: c.title,
    source: c.source,
    track: c.track,
    published: new Date(c.published_at).toISOString(),
    snippet: c.snippet.slice(0, 900),
  }));

  const args = {
    system: ctx.prompt,
    schema: ctx.schema,
    historyText: ctx.historyText,
    historyKeys: ctx.historyKeys,
    openThreads: ctx.openThreads,
    preferences: ctx.preferences,
    usage: ctx.usage,
    payload,
  };

  for (const provider of providers) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const stories = await provider.scoreBatch(args);
        return { stories, usedName: provider.name, wasRescued: provider.name === 'heuristic' && providers.length > 1 };
      } catch (err) {
        const msg = String(err.message ?? err);
        if (attempt < 3) {
          ctx.log(`  batch ${ctx.index} ${provider.name} attempt ${attempt} failed (${msg}); retrying`, 'warn');
          await sleep(1500 * attempt);
          continue;
        }
        ctx.log(`  batch ${ctx.index} ${provider.name} failed 3 attempts (${msg}); falling back`, 'warn');
      }
    }
  }

  // Unreachable in practice: the cascade always ends in heuristic, which has no
  // network dependency and cannot fail.
  ctx.log(`  batch ${ctx.index} exhausted every provider`, 'error');
  return { stories: [], usedName: null, wasRescued: false };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Concurrency-limited map that preserves order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
