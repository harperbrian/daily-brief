/**
 * Deterministic selection. No model involved: given the same scores this always
 * produces the same brief, which is what makes the pipeline debuggable.
 *
 * Order matters here and is deliberate:
 *   1. filter          quality floor, muting, injection
 *   2. cluster         one story per event, unioning leans and source classes
 *   3. corroborate     cross-spectrum agreement bonus
 *   4. allocate        long-run category deficit, bounded
 *   5. thread gate     suppress repeats that carry nothing new
 *   6. lead            fill What Actually Matters Today on merit alone
 *   7. reserve         guarantee the standing-priority buckets
 *   8. fill            the rest, respecting the daily category ceiling
 *   9. watch           unresolved and forthcoming items
 */

const LEFTISH = new Set(['left', 'center-left']);
const RIGHTISH = new Set(['right', 'center-right']);

/**
 * Absolute floors. Deliberately permissive: the peak-blend distribution differs
 * sharply by provider (the rule-based scorer's keyword dimensions are far
 * sparser than a model's, so its median lands near 8 where a model's lands much
 * higher), and a floor tuned to one provider would silently gut the other. The
 * real limiter is structural — target_stories, the daily category ceiling, and
 * the reserved caps. These floors exist only to stop a genuinely dead news day
 * being padded with junk.
 *
 * Recalibrate against a live model run with:
 *   node src/index.js --dry-run --dump-candidates
 */
const MIN_SCORE = 15;

/** A lead story has to actually lead. */
const LEAD_MIN_SCORE = 30;

export function selectStories(scored, history, preferences, { log }) {
  const cfg = preferences.allocation ?? {};
  const sectionCfg = preferences.sections ?? [];
  const target = preferences.delivery?.target_stories ?? 15;
  const now = Date.now();
  const mutedUntil = history.muted ?? {};

  // 1. Filter.
  let pool = scored.filter((s) => {
    if (s.prompt_injection_attempt) {
      log(`  dropped (injection attempt): ${s.clean_title}`, 'warn');
      return false;
    }
    if (!s.include_candidate) return false;
    if (s.total_score < MIN_SCORE) return false;
    const expiry = mutedUntil[s.category];
    return !(expiry && expiry > now);
  });

  // 2. Cluster.
  pool = collapseByEventKey(pool);

  // 3. Cross-spectrum corroboration. When outlets that disagree editorially both
  //    report something, it is far more likely to be a fact than a framing
  //    exercise — the cheapest reliable bias filter short of reading the articles.
  for (const s of pool) s.total_score += corroborationBonus(s);

  // 4. Long-run allocation deficit, bounded so it can reorder near-ties but can
  //    never promote a weak story over a strong one.
  const mix = rollingMix(history, cfg.window_days ?? 30);
  const warm = mix.total >= (cfg.warmup_days ?? 10);
  if (warm) {
    for (const s of pool) {
      s.allocation_bonus = allocationBonus(s.category, mix, cfg);
      s.total_score += s.allocation_bonus;
    }
  }

  // 5. Thread gate. A story on an open thread survives only if it actually moved.
  const before = pool.length;
  pool = pool.filter((s) => threadAdvanced(s, history));
  if (before !== pool.length) log(`  suppressed ${before - pool.length} repeat(s) with no new development`);

  pool.sort((a, b) => b.total_score - a.total_score);

  const used = new Set();
  const counts = {};
  // Applied in EVERY fill loop, not just the main one. A category that genuinely
  // owns the day still yields its seventh-best story to tomorrow — that is the
  // point of a reader-protection ceiling rather than a target.
  const ceiling = cfg.daily_ceiling ?? 6;
  const take = (story) => {
    used.add(story.event_key);
    counts[story.category] = (counts[story.category] ?? 0) + 1;
  };
  const available = (story) => !used.has(story.event_key);
  const underCeiling = (story) => (counts[story.category] ?? 0) < ceiling;

  const lead = section(sectionCfg, 'what_matters');
  const knowing = section(sectionCfg, 'worth_knowing');
  const watching = section(sectionCfg, 'watching');
  const reserved = cfg.reserved_slots ?? {};

  // 6. Lead. Merit alone — reserved buckets get no shortcut into this section.
  const leadStories = [];
  for (const s of pool) {
    if (leadStories.length >= (lead.max ?? 5)) break;
    if (!available(s) || s.total_score < LEAD_MIN_SCORE) continue;
    if (s.development_stage === 'proposed') continue; // not yet a development
    if (!underCeiling(s)) continue;
    if (overReservedCap(s, leadStories, reserved)) continue;
    if (violatesSectionBalance(s, leadStories, lead.max ?? 5)) continue;
    leadStories.push(s);
    take(s);
  }

  // 7. Reserved standing priorities. These bypass ranking but never the floor,
  //    and never expand past their cap however many good candidates exist.
  const body = [];
  for (const [bucket, rule] of Object.entries(reserved)) {
    const min = rule.min ?? 0;
    if (min === 0) continue;
    let filled = countMatching(leadStories.concat(body), bucket);
    for (const s of pool) {
      if (filled >= min) break;
      if (!available(s) || !matchesBucket(s, bucket) || !underCeiling(s)) continue;
      body.push(s);
      take(s);
      filled++;
    }
    if (filled < min) log(`  reserved bucket "${bucket}" underfilled (${filled}/${min}) — nothing qualified`);
  }

  // 8. Fill the remainder. No backfill: if nothing clears the bar, send fewer.
  for (const s of pool) {
    if (leadStories.length + body.length >= target) break;
    if (!available(s) || !underCeiling(s)) continue;
    if (isWatchable(s)) continue; // save unresolved items for the watching section
    if (overReservedCap(s, leadStories.concat(body), reserved)) continue;
    body.push(s);
    take(s);
  }

  // 9. Watching: unresolved and forthcoming. A development-stage question, not an
  //    Action question — Action is a recommendation the writer makes later.
  const watchStories = [];
  for (const s of pool) {
    if (watchStories.length >= (watching.max ?? 4)) break;
    if (!available(s) || !isWatchable(s)) continue;
    if (!underCeiling(s)) continue;
    if (overReservedCap(s, leadStories.concat(body, watchStories), reserved)) continue;
    watchStories.push(s);
    take(s);
  }

  const out = [
    { section: 'what_matters', label: lead.label ?? 'What Actually Matters Today', detail: lead.detail ?? 'full', slots: lead.max ?? 5, stories: leadStories },
    { section: 'worth_knowing', label: knowing.label ?? 'Worth Knowing', detail: knowing.detail ?? 'brief', slots: target, stories: body },
    { section: 'watching', label: watching.label ?? "Things I'm Watching", detail: watching.detail ?? 'line', slots: watching.max ?? 4, stories: watchStories },
  ].filter((s) => s.stories.length);

  const main = leadStories.length + body.length;
  log(`selected ${main}/${target} stories + ${watchStories.length} watch items (pool of ${pool.length})`);
  for (const s of out) log(`  ${s.label}: ${s.stories.length}`);
  log(`  category mix: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  return out;
}

const section = (cfgs, id) => cfgs.find((s) => s.id === id) ?? {};

/** Unresolved and forthcoming — the actual definition of the Watching section. */
const isWatchable = (s) => s.development_stage === 'proposed' || s.development_stage === 'pending';

function matchesBucket(story, bucket) {
  if (bucket === 'quality_of_life') return story.category === 'quality_of_life';
  if (bucket === 'property') return story.geography === 'property_area';
  // Home region with a real local signal, not merely a home-state dateline.
  if (bucket === 'home_local') return story.geography === 'home_region' && (story.geographic ?? 0) >= 6;
  return false;
}
const countMatching = (stories, bucket) => stories.filter((s) => matchesBucket(s, bucket)).length;

/** Stops a reserved bucket from quietly taking over the main fill. */
function overReservedCap(story, chosen, reserved) {
  for (const [bucket, rule] of Object.entries(reserved)) {
    if (rule.max == null || !matchesBucket(story, bucket)) continue;
    if (countMatching(chosen, bucket) >= rule.max) return true;
  }
  return false;
}

/**
 * Share of recent briefs by category, used for the allocation deficit. Reads the
 * history entries the pipeline already writes, so this needs no new persistence.
 */
export function rollingMix(history, windowDays) {
  const cutoff = Date.now() - windowDays * 24 * 3600e3;
  const recent = (history.entries ?? []).filter((e) => (e.sent_at ?? 0) >= cutoff);
  const counts = {};
  for (const e of recent) counts[e.category] = (counts[e.category] ?? 0) + 1;
  return { counts, total: recent.length };
}

/**
 * Bounded tie-break toward the long-run targets. Capped at roughly ±9 on a
 * 0-100 scale: enough to reorder near-ties over weeks, never enough to promote a
 * 40 over a 70. That is what "approximate long-run targets" means without
 * mechanically forcing daily percentages.
 */
export function allocationBonus(category, mix, cfg) {
  const target = cfg.category_targets?.[category];
  if (target == null || mix.total === 0) return 0;
  const share = (mix.counts[category] ?? 0) / mix.total;
  const maxDeficit = cfg.max_deficit ?? 0.15;
  const deficit = Math.max(-maxDeficit, Math.min(maxDeficit, target - share));
  return Math.round((cfg.gain ?? 0.6) * deficit * 100);
}

/**
 * True if this story is worth sending given what has already been sent. A brand
 * new event always passes. A story continuing an open thread passes only if its
 * development stage actually moved past the thread's last beat — which is a real
 * answer to "is this new", rather than the blunt novelty proxy it replaces.
 */
export function threadAdvanced(story, history) {
  const threads = history.threads ?? {};
  const key = story.continues_thread ?? story.event_key;
  const thread = threads[key];
  if (!thread) {
    // No thread, but the event may still have been sent inside the 14-day window.
    const seen = (history.entries ?? []).some((e) => e.event_key === story.event_key);
    return !seen || (story.novelty ?? 0) >= 5;
  }
  const last = thread.beats?.[thread.beats.length - 1];
  if (!last) return true;
  return STAGE_ORDER[story.development_stage] > STAGE_ORDER[last.stage] || (story.novelty ?? 0) >= 7;
}

const STAGE_ORDER = { retrospective: 0, proposed: 1, ongoing: 2, pending: 3, occurred: 4 };

/**
 * How broadly a story is corroborated across the political spectrum. Opposing
 * agreement is worth far more than two outlets on the same side, because the
 * failure mode being guarded against is a story that is real only inside one
 * worldview.
 */
export function corroborationBonus(story) {
  const leans = new Set(story.leans ?? [story.lean ?? 'center']);
  let bonus = 0;
  const hasLeft = [...leans].some((l) => LEFTISH.has(l));
  const hasRight = [...leans].some((l) => RIGHTISH.has(l));

  if (hasLeft && hasRight) bonus += 8;
  else if ((hasLeft || hasRight) && leans.has('center')) bonus += 4;
  else if (leans.size >= 2) bonus += 2;

  if (leans.has('primary') && leans.size >= 2) bonus += 4;
  return bonus;
}

const side = (lean) => (LEFTISH.has(lean) ? 'left' : RIGHTISH.has(lean) ? 'right' : 'neutral');

/**
 * Stops the lead section being filled entirely from one side of the spectrum
 * when an alternative exists. Applied only where the day's framing is set.
 */
function violatesSectionBalance(story, picked, slots) {
  if (picked.length < slots - 1) return false;
  const partisan = picked.map((p) => side(p.lean ?? 'center')).filter((s) => s !== 'neutral');
  if (partisan.length < slots - 1) return false;
  return partisan.every((s) => s === partisan[0]) && side(story.lean ?? 'center') === partisan[0];
}

function collapseByEventKey(pool) {
  const groups = new Map();
  for (const story of pool) {
    const key = story.event_key || story.id;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...story, supporting: [...(story.supporting ?? [])] });
      continue;
    }
    const [winner, loser] = story.total_score > existing.total_score ? [story, existing] : [existing, story];
    const merged = { ...winner, supporting: [...(winner.supporting ?? [])] };
    // Union both — two outlets the scorer gave different event_keys still count
    // as corroboration once they merge here, and the cluster's quality is the
    // best class present.
    merged.leans = [...new Set([...(winner.leans ?? []), ...(loser.leans ?? [])])];
    merged.source_classes = [...new Set([...(winner.source_classes ?? []), ...(loser.source_classes ?? [])])];
    if (merged.supporting.length < 2 && loser.url !== merged.url) {
      merged.supporting.push({ url: loser.url, source: loser.source, lean: loser.lean, source_class: loser.source_class });
    }
    groups.set(key, merged);
  }
  return [...groups.values()];
}
