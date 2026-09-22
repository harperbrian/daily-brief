#!/usr/bin/env node
/**
 * Validates every feed in config/feeds.json: fetches it, confirms it parses as
 * RSS/Atom, and reports how many items are from the last 48 hours.
 *
 * Run this after editing feeds.json, and occasionally thereafter — feeds rot.
 *   npm run check-feeds
 */
import { readFile } from 'node:fs/promises';
import Parser from 'rss-parser';

// A browser User-Agent is required, not cosmetic: several of these hosts 403 any
// client that looks automated. Verified during feed selection.
const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
  },
});

const { feeds } = JSON.parse(
  await readFile(new URL('../config/feeds.json', import.meta.url), 'utf8')
);

const TWO_DAYS = 48 * 60 * 60 * 1000;

async function check(feed) {
  const started = Date.now();
  try {
    const parsed = await parser.parseURL(feed.url);
    const items = parsed.items ?? [];
    const recent = items.filter((i) => {
      const d = Date.parse(i.isoDate ?? i.pubDate ?? '');
      return Number.isFinite(d) && Date.now() - d < TWO_DAYS;
    }).length;
    return { ...feed, ok: true, items: items.length, recent, ms: Date.now() - started };
  } catch (err) {
    return { ...feed, ok: false, error: String(err.message ?? err).slice(0, 90) };
  }
}

const results = await Promise.all(feeds.map(check));

const live = results.filter((r) => r.ok);
const dead = results.filter((r) => !r.ok);
const stale = live.filter((r) => r.recent === 0);

for (const track of [...new Set(feeds.map((f) => f.track))]) {
  console.log(`\n\x1b[1m${track}\x1b[0m`);
  for (const r of results.filter((x) => x.track === track)) {
    if (!r.ok) {
      console.log(`  \x1b[31m✗\x1b[0m ${r.name.padEnd(32)} ${r.error}`);
    } else {
      const flag = r.recent === 0 ? '\x1b[33m~\x1b[0m' : '\x1b[32m✓\x1b[0m';
      console.log(`  ${flag} ${r.name.padEnd(32)} ${String(r.items).padStart(3)} items, ${r.recent} in 48h`);
    }
  }
}

console.log(
  `\n${live.length}/${results.length} live · ${stale.length} live-but-quiet · ${dead.length} dead`
);
if (dead.length) {
  console.log('\nDead feeds must be replaced or removed from config/feeds.json:');
  for (const d of dead) console.log(`  ${d.id}  ${d.url}`);
}
process.exit(0);
