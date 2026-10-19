/**
 * One event, one key. The scorer sees candidates in independent batches of 25,
 * so two outlets' reports of one event can get two event_keys and both reach the
 * brief (2026-10-07: "FOMC minutes: officials expect another rate hike" and
 * "Fed minutes show little appetite for a series of hikes" both led). A repeat
 * of an event sent in the last few days can slip through the same way.
 *
 * After scoring, one small call groups the includable items that report the same
 * occurrence, with recently sent events listed alongside. The model only
 * PROPOSES; code merges only on clear evidence, and errs toward showing a
 * near-duplicate rather than hiding a story:
 *
 *   - a member must share the category and a rare, salient word with the
 *     group's strongest item (numbers alone never count);
 *   - a match to an earlier send needs a stricter overlap, and then the story
 *     must show a real stage change to be sent again;
 *   - a model-proposed merge removes the duplicate but never adds outlets,
 *     leans, source classes or links to the surviving story: corroboration
 *     comes from retrieval facts and the scorer's own keys, not from this call;
 *   - groups larger than MAX_GROUP are skipped, at most MAX_ABSORBED stories
 *     are absorbed per run, and every absorbed headline is logged.
 *
 * Reviewed 2026-10-07 by separate security and correctness passes; the
 * guardrails above answer their findings. Any failure falls back to word overlap.
 */

/** Includable items worth deduplicating; mirrors select.js's quality floor. */
const MIN_SCORE = 15;
/** Bounds the call: the includable pool is ~10-40 items on a normal day. */
const MAX_TODAY = 40;
const MAX_SENT = 60;
/** A group bigger than this is more likely a bad reply than one event. */
const MAX_GROUP = 6;
/** Total stories one run may absorb into others. */
const MAX_ABSORBED = 8;
/** Merges, sent matches and aliases all live inside this window. */
export const DEDUPE_WINDOW_MS = 96 * 3600e3;
/** A shared word counts only if it appears in at most this many of today's titles. */
const RARE_DF = 3;

export async function mergeDuplicateEvents(scored, history, { prompt, schema, chain, usage, log }) {
  const now = Date.now();
  const today = scored
    .filter((s) => s.include_candidate && !s.prompt_injection_attempt && s.total_score >= MIN_SCORE)
    .sort((a, b) => b.total_score - a.total_score)
    .slice(0, MAX_TODAY);
  // Only sends a match could be accepted for; older ones were dead weight in
  // the call and made the model propose groups code then had to reject.
  const sent = latestSends(history)
    .filter((e) => now - (e.sent_at ?? 0) <= DEDUPE_WINDOW_MS)
    .slice(0, MAX_SENT);
  if (today.length === 0 || (today.length < 2 && sent.length === 0)) {
    return { merged: 0, matchedSent: 0, via: null };
  }

  const payload = {
    today: today.map((s) => ({
      id: String(s.id),
      title: s.clean_title || s.title,
      source: s.source,
      category: s.category,
      published: new Date(Math.min(s.published_at ?? now, now)).toISOString().slice(0, 10),
      snippet: String(s.snippet ?? '').replace(/\s+/g, ' ').slice(0, 200),
    })),
    already_sent: sent.map((e) => ({
      id: `sent:${e.event_key}`,
      title: e.title,
      source: e.source,
      sent: new Date(e.sent_at).toISOString().slice(0, 10),
    })),
  };

  let groups = null;
  let via = null;
  for (const p of chain ?? []) {
    if (typeof p.groupEvents !== 'function' || p.name === 'heuristic') continue;
    try {
      const out = await p.groupEvents({ system: prompt, schema, payload, usage });
      groups = Array.isArray(out?.groups) ? out.groups : null;
      if (groups) {
        via = p.name;
        break;
      }
      log(`  event dedupe: ${p.name} returned no groups array; trying next`, 'warn');
    } catch (err) {
      log(`  event dedupe: ${p.name} failed (${String(err.message ?? err).slice(0, 200)}); trying next`, 'warn');
    }
  }
  if (!groups) {
    groups = lexicalGroups(payload);
    via = 'word overlap';
  }

  return applyGroups(groups, {
    today,
    scored,
    sent,
    historyKeys: recentKeys(history, now),
    log,
    via,
  });
}

/** Most recent send per event_key, newest first. */
function latestSends(history) {
  const seen = new Map();
  for (const e of history.entries ?? []) {
    if (!e?.event_key) continue;
    const prev = seen.get(e.event_key);
    if (!prev || (e.sent_at ?? 0) > (prev.sent_at ?? 0)) seen.set(e.event_key, e);
  }
  return [...seen.values()].sort((a, b) => (b.sent_at ?? 0) - (a.sent_at ?? 0));
}

/** Keys (and recent aliases) already sent: a member already tied to history keeps that tie. */
export function recentKeys(history, now = Date.now()) {
  const keys = new Set();
  for (const e of history.entries ?? []) {
    if (e.event_key) keys.add(e.event_key);
    if (now - (e.sent_at ?? 0) <= DEDUPE_WINDOW_MS) for (const a of e.aliases ?? []) keys.add(a);
  }
  return keys;
}

/**
 * Pure: validates proposed groups and rewrites keys in place on the scored
 * objects. Exported for tests.
 *   today        includable items offered to the call
 *   scored       every scored item (siblings under an absorbed key follow it)
 *   sent         recent history entries offered to the call
 *   historyKeys  keys already sent
 */
export function applyGroups(groups, { today, scored = today, sent = [], historyKeys = new Set(), log = () => {}, via = 'test' }) {
  const byId = new Map(today.map((s) => [String(s.id), s]));
  const sentById = new Map(sent.map((e) => [`sent:${e.event_key}`, e]));
  const df = documentFrequency(today.map((s) => s.clean_title || s.title));
  const used = new Set();
  let merged = 0;
  let matchedSent = 0;
  let absorbedTotal = 0;

  for (const raw of Array.isArray(groups) ? groups : []) {
    if (!Array.isArray(raw)) continue;
    const ids = [...new Set(raw.map(String))].filter((id) => !used.has(id));
    const members = ids
      .filter((id) => byId.has(id))
      .map((id) => byId.get(id))
      .sort((a, b) => b.total_score - a.total_score);
    if (members.length === 0) continue;

    // Today's members are checked against today's strongest item, never against
    // an earlier send: an old or unrelated sent id must not cancel today's merge.
    const top = members[0];
    const keep = [top, ...members.slice(1).filter((m) => sameEvent(m, top, df))];
    if (keep.length > MAX_GROUP) {
      log(`  event dedupe: skipped a ${keep.length}-item group (more than ${MAX_GROUP} reads as a bad reply)`, 'warn');
      continue;
    }

    // An earlier send is linked through the strongest item only, on a stricter test.
    const sentHit = ids
      .filter((id) => sentById.has(id))
      .map((id) => sentById.get(id))
      .find((e) => sameAsSent(top, e, df));
    if (keep.length < 2 && !sentHit) continue;

    const key =
      sentHit?.event_key ?? keep.find((m) => historyKeys.has(m.event_key))?.event_key ?? top.event_key;
    const absorbed = new Set();
    for (const m of keep) {
      if (m.event_key !== key) absorbed.add(m.event_key);
      for (const k of m.merged_keys ?? []) absorbed.add(k);
    }
    absorbed.delete(key);
    // Stories that will disappear into another: every scored item under an
    // absorbed key, so a sibling the scorer keyed alike follows its copy.
    const moving = scored.filter((s) => absorbed.has(s.event_key));
    const lost = keep.length - 1;
    if (absorbedTotal + lost > MAX_ABSORBED) {
      log(`  event dedupe: absorb budget (${MAX_ABSORBED}) reached; left a group of ${keep.length} apart`, 'warn');
      continue;
    }
    absorbedTotal += lost;
    for (const m of keep) used.add(String(m.id));
    if (sentHit) used.add(`sent:${sentHit.event_key}`);

    const survivorTitle = (sentHit ? sentHit.title : top.clean_title || top.title) ?? key;
    for (const s of moving) {
      if (keep.includes(s)) log(`  merged "${s.clean_title || s.title}" into "${survivorTitle}"`);
      s.event_key = key;
      // Removes the duplicate but adds nothing to the survivor (select.js
      // honours this): a model judgment is never corroboration.
      s.model_grouped = true;
      merged++;
    }
    const holders = scored.filter((s) => s.event_key === key);
    for (const s of holders) s.merged_keys = [...new Set([...(s.merged_keys ?? []), ...absorbed])];

    if (sentHit) {
      // A repeat of something already sent: tie it to the original thread so
      // "already knew this" and stage tracking apply, and require a real stage
      // change before it goes out again (select.js threadAdvanced).
      for (const s of holders) {
        s.repeat_of = sentHit.event_key;
        s.continues_thread ??= sentHit.thread ?? sentHit.event_key;
      }
      matchedSent += holders.filter((s) => keep.includes(s)).length;
      log(`  "${top.clean_title || top.title}" repeats "${sentHit.title}" (sent ${new Date(sentHit.sent_at).toISOString().slice(0, 10)})`);
    }
  }

  if (merged || matchedSent) {
    log(`event dedupe (${via}): merged ${merged} item key(s); ${matchedSent} item(s) matched an earlier send`);
  } else {
    log(`event dedupe (${via}): no duplicates`);
  }
  return { merged, matchedSent, via };
}

/** Two of today's reports of one event: same category and a rare, salient shared word. */
function sameEvent(item, top, df) {
  if (!item.category || item.category !== top.category) return false;
  if (Math.abs(clampNow(item.published_at) - clampNow(top.published_at)) > DEDUPE_WINDOW_MS) return false;
  const shared = sharedTokens(item.clean_title || item.title, top.clean_title || top.title);
  return strongOverlap(shared, df);
}

/**
 * Today's item repeats an earlier send: same category, close in time, and a
 * real overlap (Jaccard >= 0.25 on salient words, plus a rare shared word).
 * Stricter than sameEvent because the effect is stronger: the story can only
 * go out again on a stage change.
 */
function sameAsSent(item, entry, df) {
  if (!entry?.title || !item.category || item.category !== entry.category) return false;
  if (Math.abs(clampNow(item.published_at) - (entry.sent_at ?? 0)) > DEDUPE_WINDOW_MS) return false;
  const a = salientTokens(item.clean_title || item.title);
  const b = salientTokens(entry.title);
  const shared = [...a].filter((w) => b.has(w));
  const jaccard = shared.length / (a.size + b.size - shared.length || 1);
  return jaccard >= 0.25 && strongOverlap(shared, df);
}

/** Two shared words, or one long (6+) word or acronym; at least one must be rare today. */
function strongOverlap(shared, df) {
  if (shared.length === 0) return false;
  if (!shared.some((w) => (df.get(w) ?? 0) <= RARE_DF)) return false;
  return shared.length >= 2 || shared.some((w) => w.length >= 6 || w.startsWith('#'));
}

function sharedTokens(t1, t2) {
  const a = salientTokens(t1);
  return [...salientTokens(t2)].filter((w) => a.has(w));
}

function documentFrequency(titles) {
  const df = new Map();
  for (const t of titles) for (const w of salientTokens(t)) df.set(w, (df.get(w) ?? 0) + 1);
  return df;
}

const clampNow = (t) => Math.min(Number.isFinite(t) ? t : Date.now(), Date.now());

const STOP = new Set(
  'about above after again against also amid among another around back before being below between both could during each from have here into just make more most much must news other over said says should some such than that their them then there these they this those through today under until very what when where which while will with would year years your'.split(' ')
);

/**
 * Words that identify an event. Acronyms (FOMC, CPI, UAW) are kept, marked
 * with '#' so they count as strong even at 3 letters; plurals are folded
 * ("rates"/"rate"); bare numbers never count ("3 dead" vs "3 cups" share
 * nothing that matters).
 */
export function salientTokens(title) {
  const raw = String(title ?? '');
  const out = new Set();
  for (const a of raw.match(/\b[A-Z]{2,6}\b/g) ?? []) out.add(`#${a.toLowerCase()}`);
  for (let w of raw.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/)) {
    if (!w || /^\d+$/.test(w) || STOP.has(w)) continue;
    if (w.length < 4 && !/\d/.test(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

/** @deprecated kept for callers outside this file; same as salientTokens without acronym marks. */
export const contentWords = (title) => new Set([...salientTokens(title)].filter((w) => !w.startsWith('#')));

/**
 * Fallback when no model is available or every call failed: near-identical
 * headlines only (Jaccard >= 0.5 on salient words among today's items; 0.6
 * against an earlier send), same category. Conservative on purpose; it catches
 * syndicated rewrites, not reframings.
 */
export function lexicalGroups(payload) {
  const today = payload.today ?? [];
  const sent = payload.already_sent ?? [];
  const all = [...today, ...sent];
  const words = new Map(all.map((x) => [x.id, salientTokens(x.title)]));
  const cat = new Map(all.map((x) => [x.id, x.category]));
  const parent = new Map(all.map((x) => [x.id, x.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const union = (a, b) => parent.set(find(a), find(b));
  const jaccard = (a, b) => {
    const A = words.get(a), B = words.get(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    return n / (A.size + B.size - n);
  };
  for (let i = 0; i < today.length; i++) {
    for (let j = i + 1; j < today.length; j++) {
      if (cat.get(today[i].id) === cat.get(today[j].id) && jaccard(today[i].id, today[j].id) >= 0.5) union(today[i].id, today[j].id);
    }
    for (const e of sent) {
      if (cat.get(today[i].id) === cat.get(e.id) && jaccard(today[i].id, e.id) >= 0.6) union(today[i].id, e.id);
    }
  }
  const groups = new Map();
  for (const x of all) {
    const root = find(x.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(x.id);
  }
  return [...groups.values()].filter((g) => g.length >= 2 && g.some((id) => !id.startsWith('sent:')));
}
