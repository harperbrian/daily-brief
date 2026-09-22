import Parser from 'rss-parser';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
});

/** Feeds that publish in bursts. An empty result is normal, not a failure worth reporting. */
const BURSTY = new Set([
  'fed_press', 'sec_press', 'nia_news', 'fda_press', 'delta_news', 'federal_register',
  // Weather and seismic alerts: empty is the normal, good case. Warning about
  // these every quiet day would train you to ignore the health footer entirely.
  'nws_home', 'nws_property', 'usgs_quakes',
  // Publish in irregular bursts: quarterly IR releases, layoff waves, weekly
  // essays, slow research feeds. Silence carries no signal about feed health.
  'layoffs_fyi', 'stratechery', 'sd_relationships', 'ars_tech_lab',
]);

const HARD_TIMEOUT_MS = 20000;

/**
 * rss-parser's own `timeout` covers connection setup but not a slow or stalled
 * response body, so a single wedged host can hang the whole run. In CI that means
 * a job that never finishes. This is the outer guarantee that it always ends.
 */
const withHardTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`hard timeout after ${ms}ms: ${label}`)), ms)),
  ]);

/**
 * Fetches every feed concurrently. Individual failures are collected, never thrown —
 * one dead feed must not take down the brief. Returns raw items plus a health report.
 */
export async function retrieveAll(feeds, { lookbackHours, log }) {
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  const settled = await Promise.all(
    feeds.map(async (feed) => {
      try {
        const parsed = await withHardTimeout(parser.parseURL(feed.url), HARD_TIMEOUT_MS, feed.id);
        const items = (parsed.items ?? [])
          .map((item) => shape(item, feed))
          .filter((item) => item && item.published_at >= cutoff);
        return { feed, items, ok: true };
      } catch (err) {
        return { feed, items: [], ok: false, error: String(err.message ?? err).slice(0, 120) };
      }
    })
  );

  const items = settled.flatMap((s) => s.items);
  const failures = settled.filter((s) => !s.ok);
  // Alert-only feeds run hourly on a two-hour window; a small-town paper
  // publishing nothing in that window is the normal case, not a health signal.
  const empty = settled.filter((s) => s.ok && s.items.length === 0 && !BURSTY.has(s.feed.id) && !s.feed.alert_only);

  log(`retrieved ${items.length} items from ${settled.length - failures.length}/${settled.length} feeds`);
  for (const f of failures) log(`  feed failed: ${f.feed.name} — ${f.error}`, 'warn');
  for (const e of empty) log(`  feed empty in window: ${e.feed.name}`, 'warn');

  return {
    items,
    health: {
      total: settled.length,
      ok: settled.length - failures.length,
      failed: failures.map((f) => ({ id: f.feed.id, name: f.feed.name, error: f.error })),
      empty: empty.map((e) => e.feed.id),
    },
  };
}

function shape(item, feed) {
  const url = item.link ?? item.guid;
  const title = (item.title ?? '').trim();
  if (!url || !title) return null;

  const ts = Date.parse(item.isoDate ?? item.pubDate ?? '');

  return {
    title,
    url,
    // Items with no parseable date are treated as "now" rather than dropped — some
    // feeds omit dates entirely, and dropping them would silently lose whole sources.
    published_at: Number.isFinite(ts) ? ts : Date.now(),
    snippet: item.contentSnippet ?? item.summary ?? item.content ?? '',
    source: feed.name,
    feed_id: feed.id,
    track: feed.track,
    tier: feed.tier,
    lean: feed.lean ?? 'center',
    source_class: feed.source_class ?? 'established',
    alert: feed.alert === true,
    // People place (config/people.json) this feed watches, if any.
    place: feed.place,
  };
}

/**
 * Targeted Tavily sweep. Only runs when TAVILY_API_KEY is set; failures degrade
 * to RSS-only and never throw.
 *
 * This is deliberately NOT a general news sweep — RSS does that better. It exists
 * because many town, county and state-legislature sites
 * all retired their RSS feeds, leaving the profile's highest-priority monitoring
 * area with no primary source. `include_domains` reaches those sites directly,
 * which is what makes a `source_class` of 'primary' honest for those queries.
 */
export async function retrieveTavily(queries, { apiKey, log }) {
  if (!apiKey) return { items: [], health: { skipped: true } };

  const results = await Promise.all(
    queries.map(async (q) => {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            query: q.query,
            search_depth: 'basic',
            max_results: q.max_results ?? 10,
            topic: q.topic ?? 'news',
            time_range: q.time_range ?? 'day',
            include_answer: false,
            include_raw_content: false,
            include_images: false,
            ...(q.include_domains ? { include_domains: q.include_domains } : {}),
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return (data.results ?? []).map((r) => ({
          title: (r.title ?? '').trim(),
          url: r.url,
          published_at: Date.parse(r.published_date ?? '') || Date.now(),
          snippet: r.content ?? '',
          source: new URL(r.url).hostname.replace(/^www\./, ''),
          feed_id: `tavily:${q.id}`,
          track: q.id,
          // A domain-scoped query lands on official sites, so tier 1 / primary is
          // earned. An open query returns an unverifiable outlet, so it stays
          // secondary no matter what the config says.
          tier: q.include_domains ? 1 : 2,
          source_class: q.include_domains ? (q.source_class ?? 'primary') : 'established',
          lean: q.lean ?? 'center',
          alert: false,
        }));
      } catch (err) {
        log(`  tavily query failed: ${q.id} — ${String(err.message ?? err)}`, 'warn');
        return [];
      }
    })
  );

  const items = results.flat().filter((i) => i.title && i.url);
  log(`tavily returned ${items.length} items across ${queries.length} queries`);
  return { items, health: { skipped: false, count: items.length } };
}
