const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_/i, /^ref$/i, /^ref_src$/i,
  /^igshid$/i, /^s$/i, /^cmpid$/i, /^smid$/i, /^partner$/i, /^__twitter_impression$/i,
];

/** Strips tracking noise so the same article from two feeds collapses to one URL. */
export function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
    }
    // Trailing slash is not meaningful for identity.
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

const STOPWORDS = new Set(
  'a an the and or but of to in on for with at by from as is are was were be been it its this that has have had after over into new says say said report reports'.split(' ')
);

/**
 * Title fingerprint for catching the same story syndicated under near-identical
 * headlines. Also used by the heuristic provider as its event_key.
 */
export function titleFingerprint(title) {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].sort().slice(0, 8).join('-');
}

function stripHtml(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes raw retrieved items into scoring candidates, collapsing exact-URL and
 * near-identical-title duplicates before they ever reach the model. Every duplicate
 * removed here is one fewer item to pay tokens for.
 */
export function normalize(rawItems, { log }) {
  const byUrl = new Map();
  const byTitle = new Map();
  let urlDupes = 0;
  let titleDupes = 0;

  for (const item of rawItems) {
    const url = canonicalUrl(item.url);
    const fp = titleFingerprint(item.title);

    const existingByUrl = byUrl.get(url);
    if (existingByUrl) {
      urlDupes++;
      mergeSupporting(existingByUrl, item);
      continue;
    }

    const existingByTitle = fp && byTitle.get(fp);
    if (existingByTitle) {
      titleDupes++;
      mergeSupporting(existingByTitle, item);
      continue;
    }

    const candidate = {
      id: `c${byUrl.size + 1}`,
      title: stripHtml(item.title).slice(0, 300),
      url,
      snippet: stripHtml(item.snippet).slice(0, 1200),
      source: item.source,
      feed_id: item.feed_id,
      track: item.track,
      tier: item.tier,
      lean: item.lean ?? 'center',
      source_class: item.source_class ?? 'established',
      alert: item.alert === true,
      place: item.place,
      quake: item.quake === true,
      // Every lean that has covered this story. Grows as duplicates merge in; a
      // wide spread is the corroboration signal applied in src/select.js.
      leans: [item.lean ?? 'center'],
      // Every source class that has covered it. The cluster's effective quality
      // is the BEST of these — an aggregator that breaks a story is lifted when
      // a primary source actually corroborates it, not when a model guesses one
      // might. Resolved in src/score.js.
      source_classes: [item.source_class ?? 'established'],
      published_at: item.published_at,
      supporting: [],
    };
    byUrl.set(url, candidate);
    if (fp) byTitle.set(fp, candidate);
  }

  const candidates = [...byUrl.values()].sort((a, b) => b.published_at - a.published_at);
  log(
    `normalized to ${candidates.length} candidates (dropped ${urlDupes} url dupes, ${titleDupes} title dupes)`
  );
  return candidates;
}

/**
 * Budget per track. Without this, high-volume feeds (MLive, wire services) crowd out
 * the sparse-but-high-weight tracks — 129 home-state items against 7 home-town items
 * means the model spends its attention in the wrong place, and you pay for it.
 * Budgets are roughly proportional to how many slots a track can actually win.
 */
const TRACK_BUDGET = {
  home_local: 25,
  home_region: 32,
  property_local: 26,
  us: 44,
  global: 36,
  ai: 28,
  finance: 24,
  career: 22,
  entrepreneurship: 14,
  science_environment: 16,
  health: 20,
  parenting: 14,
  travel: 12,
};

/** No single feed may occupy more than this many slots within its track. */
const PER_FEED_CAP = 10;

/**
 * Lean buckets used for balanced budgeting. 'primary' is deliberately its own
 * bucket and is never traded against the others — government and scientific
 * records are not a "side", and they should never be crowded out by an
 * argument about balance.
 */
const LEAN_BUCKETS = ['primary', 'center', 'center-left', 'center-right', 'left', 'right'];

/**
 * Obvious non-news that no amount of scoring will rescue. Deliberately narrow —
 * a broad filter here would silently drop real stories, which is far worse than
 * paying to score a few duds. Edit config/preferences.json `junk_patterns` to tune.
 */
const DEFAULT_JUNK = [
  /\b(box score|final score|game recap|injury report|starting lineup)\b/i,
  /\b(red carpet|dating rumors|breakup|engagement ring|baby bump)\b/i,
  /\b(horoscope|zodiac|astrology)\b/i,
  /^(watch|listen|photos|in pictures|video):/i,
];

export function prefilter(candidates, { junkPatterns = [], log }) {
  const patterns = [...DEFAULT_JUNK, ...junkPatterns.map((p) => new RegExp(p, 'i'))];

  const beforeJunk = candidates.length;
  let pool = candidates.filter((c) => !patterns.some((re) => re.test(c.title)));
  const junked = beforeJunk - pool.length;

  // Cap per feed within each track, favoring recency.
  const perFeed = new Map();
  pool = pool
    .slice()
    .sort((a, b) => b.published_at - a.published_at)
    .filter((c) => {
      const n = (perFeed.get(c.feed_id) ?? 0) + 1;
      perFeed.set(c.feed_id, n);
      return n <= PER_FEED_CAP;
    });

  // Then cap per track. Tier-1 sources get a mild recency bonus rather than
  // absolute priority, so a fresh tier-2 scoop still gets through.
  const byTrack = new Map();
  for (const c of pool) {
    if (!byTrack.has(c.track)) byTrack.set(c.track, []);
    byTrack.get(c.track).push(c);
  }

  const kept = [];
  for (const [track, items] of byTrack) {
    kept.push(...allocateAcrossLeans(items, TRACK_BUDGET[track] ?? 15));
  }

  kept.sort((a, b) => b.published_at - a.published_at);
  kept.forEach((c, i) => (c.id = `c${i + 1}`));

  const leanMix = {};
  for (const c of kept) leanMix[c.lean] = (leanMix[c.lean] ?? 0) + 1;
  log(
    `prefiltered ${beforeJunk} → ${kept.length} candidates (${junked} junk, ${beforeJunk - junked - kept.length} over budget)`
  );
  log(`  candidate lean mix: ${LEAN_BUCKETS.filter((l) => leanMix[l]).map((l) => `${l} ${leanMix[l]}`).join(', ')}`);
  return kept;
}

/**
 * Spends a track's budget evenly across the lean buckets that actually have
 * supply, instead of handing it all to whichever outlets published most.
 *
 * This is the load-bearing anti-bias step. The US track has 26 center-left items
 * on a busy day and 6 from the right; a pure recency sort would hand the scorer
 * a pool that is already one-sided, and no prompt can recover balance from input
 * that never contained it. Leftover capacity from thin buckets is redistributed,
 * so a quiet bucket costs coverage rather than wasting slots.
 */
function allocateAcrossLeans(items, budget) {
  const buckets = new Map();
  for (const item of items) {
    const lean = LEAN_BUCKETS.includes(item.lean) ? item.lean : 'center';
    if (!buckets.has(lean)) buckets.set(lean, []);
    buckets.get(lean).push(item);
  }

  // Mild tier-1 preference, then recency, within each bucket.
  const rank = (x) => x.published_at + (x.tier === 1 ? 6 * 3600e3 : 0);
  for (const list of buckets.values()) list.sort((a, b) => rank(b) - rank(a));

  const taken = [];
  let remaining = budget;
  let active = [...buckets.keys()];

  // Round-robin: each pass gives every bucket with supply an equal share, and
  // repeats with whatever is left over until the budget or the supply runs out.
  while (remaining > 0 && active.length > 0) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    const stillActive = [];
    for (const lean of active) {
      if (remaining <= 0) break;
      const list = buckets.get(lean);
      const n = Math.min(share, list.length, remaining);
      taken.push(...list.splice(0, n));
      remaining -= n;
      if (list.length) stillActive.push(lean);
    }
    if (stillActive.length === active.length && share === 0) break; // no progress
    active = stillActive;
  }

  return taken;
}

function mergeSupporting(target, item) {
  const url = canonicalUrl(item.url);

  // Record the lean even when the URL is an exact duplicate or the supporting
  // list is already full — corroboration breadth is tracked independently of
  // the two available link slots.
  const lean = item.lean ?? 'center';
  if (!target.leans.includes(lean)) target.leans.push(lean);
  const cls = item.source_class ?? 'established';
  if (!target.source_classes.includes(cls)) target.source_classes.push(cls);
  // Alert eligibility is a union: if any feed carrying this story can raise an
  // alert, the story can.
  if (item.alert) target.alert = true;

  if (url === target.url) {
    // Same article reached us through two feeds. There is no second link to add,
    // but the more credible attribution should still win — otherwise a wire story
    // picked up by an aggregator first keeps the aggregator's weaker tier.
    promoteSource(target, item);
    return;
  }
  if (target.supporting.length >= 2) return;
  if (target.supporting.some((s) => s.url === url)) return;
  // Prefer a tier-1 source as primary; demote the current primary to supporting.
  if (item.tier === 1 && target.tier === 2) {
    target.supporting.unshift({ url: target.url, source: target.source, lean: target.lean, source_class: target.source_class });
    target.url = url;
    promoteSource(target, item);
  } else {
    target.supporting.push({ url, source: item.source, lean: item.lean, source_class: item.source_class });
  }
}

/** Adopts a more credible source's attribution without changing the story. */
function promoteSource(target, item) {
  if (item.tier !== 1 || target.tier === 1) return;
  target.tier = 1;
  target.source = item.source;
  target.feed_id = item.feed_id;
  target.lean = item.lean ?? target.lean;
  target.source_class = item.source_class ?? target.source_class;
}
