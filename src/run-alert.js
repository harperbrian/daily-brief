#!/usr/bin/env node
/**
 * Hourly breaking-news check. Separate entry point from the daily brief: it
 * shares retrieval and history but skips scoring, selection and writing
 * entirely, so a quiet hour costs a few seconds and zero tokens.
 *
 *   npm run alert            # send if anything qualifies
 *   npm run alert -- --dry-run
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { retrieveAll } from './retrieve.js';
import { normalize } from './normalize.js';
import { loadHistory } from './history.js';
import { selectAlerts, renderAlert, renderAlertText, alertKey } from './alert.js';
import { sendMail } from './mail.js';
import { nearbyQuakes } from './quakes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => join(ROOT, ...parts);

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');

const started = Date.now();
const log = (msg, level = 'info') =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${level === 'info' ? '' : level.toUpperCase() + ': '}${msg}`);

async function main() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, BRIEF_TO } = process.env;

  const preferences = JSON.parse(await readFile(p('config/preferences.json'), 'utf8'));
  const { feeds } = JSON.parse(await readFile(p('config/feeds.json'), 'utf8'));
  const { places } = JSON.parse(await readFile(p('config/people.json'), 'utf8'));
  const placeById = new Map(places.map((pl) => [pl.id, pl]));
  const tz = preferences.timezone ?? 'America/Chicago';

  // Only alert-eligible feeds, and only a short window — this is about what is
  // happening now, not what happened today.
  const alertFeeds = feeds.filter((f) => f.alert);
  log(`checking ${alertFeeds.length} alert-eligible feeds`);

  const [{ items }, quakes] = await Promise.all([
    retrieveAll(alertFeeds, { lookbackHours: 2, log }),
    nearbyQuakes(places, { lookbackHours: 2, log }),
  ]);
  if (quakes.length) log(`USGS: ${quakes.length} quake(s) near someone`);
  if (items.length === 0 && quakes.length === 0) {
    log('nothing published in the window');
    return;
  }

  // Attach who lives there, so scoring can require the place be named and
  // the email can say who to text.
  const candidates = normalize([...items, ...quakes], { log }).map((c) => {
    const pl = c.place ? placeById.get(c.place) : null;
    return pl ? { ...c, place_match: pl.match, place_people: pl.people, place_name: pl.place } : c;
  });
  const historyPath = p('state/history.json');
  const history = await loadHistory(historyPath, { log });

  const picked = selectAlerts(candidates, history, { log });
  if (picked.length === 0) return;

  const html = renderAlert(picked, { tz });
  const text = renderAlertText(picked);

  if (DRY_RUN) {
    await writeFile(p('out/alert-preview.html'), html);
    log('dry run — wrote out/alert-preview.html, not sending');
    return;
  }
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !BRIEF_TO) {
    throw new Error('GMAIL_USER, GMAIL_APP_PASSWORD and BRIEF_TO must be set to send');
  }

  await sendMail({
    html,
    text,
    subject: `⚠ ${picked[0].place_people ? `Near ${picked[0].place_people}: ` : ''}${picked[0].title.slice(0, 70)}`,
    to: BRIEF_TO,
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
    log,
  });

  // Record only after a successful send, so a send failure retries next hour
  // rather than silently suppressing the alert forever.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const raw = JSON.parse(await readFile(historyPath, 'utf8'));
  raw.alerts = [
    ...(raw.alerts ?? []).filter((a) => Date.now() - (a.at ?? 0) < 14 * 24 * 3600e3),
    ...picked.map((i) => ({ key: alertKey(i), day, at: Date.now(), title: i.title })),
  ];
  await writeFile(historyPath, JSON.stringify(raw, null, 2) + '\n');
  log(`recorded ${picked.length} alert(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // Alerts fail quietly: a broken alert check must never generate its own
    // noise, and the daily brief still reports feed health.
    log(String(err.stack ?? err), 'error');
    process.exit(1);
  });
