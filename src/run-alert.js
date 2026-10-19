#!/usr/bin/env node
/**
 * Hourly breaking-news check. Separate entry point from the daily brief: it
 * shares retrieval and history but skips scoring, selection and writing
 * entirely, so a quiet hour costs a few seconds and zero tokens.
 *
 *   npm run alert            # send if anything qualifies
 *   npm run alert -- --dry-run
 *
 * ALERT_LAST_CHECK_FILE names a small JSON file ({ "at": <ms> }) holding the
 * start time of the last check that finished cleanly. CI keeps it in
 * actions/cache (see .github/workflows/breaking-alert.yml). When it is unset,
 * as on a laptop, the check looks back the default two hours and writes
 * nothing, so a local run can never move CI's window.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { retrieveAll } from './retrieve.js';
import { loadHistory } from './history.js';
import {
  selectAlerts, renderAlert, renderAlertText, alertRecord, alertWindowHours, alertDay, dedupeAlertItems,
} from './alert.js';
import { sendMail } from './mail.js';
import { nearbyQuakes } from './quakes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => join(ROOT, ...parts);

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');

const started = Date.now();
const log = (msg, level = 'info') =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${level === 'info' ? '' : level.toUpperCase() + ': '}${msg}`);

const LAST_CHECK_FILE = process.env.ALERT_LAST_CHECK_FILE ? resolve(ROOT, process.env.ALERT_LAST_CHECK_FILE) : null;

/** Start time of the last clean check, or null when there is no usable record. */
async function readLastCheck() {
  if (!LAST_CHECK_FILE) return null;
  try {
    const { at } = JSON.parse(await readFile(LAST_CHECK_FILE, 'utf8'));
    return Number.isFinite(at) ? at : null;
  } catch (err) {
    if (err.code !== 'ENOENT') log(`last-check record unreadable, using the default window: ${err.message}`, 'warn');
    return null;
  }
}

async function check(lastCheck) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, BRIEF_TO } = process.env;

  const preferences = JSON.parse(await readFile(p('config/preferences.json'), 'utf8'));
  const { feeds } = JSON.parse(await readFile(p('config/feeds.json'), 'utf8'));
  const { places } = JSON.parse(await readFile(p('config/people.json'), 'utf8'));
  const placeById = new Map(places.map((pl) => [pl.id, pl]));
  const tz = preferences.timezone ?? 'America/Chicago';

  // Only alert-eligible feeds, and only what is new since the last check that
  // finished: this is about what is happening now, not what happened today.
  const alertFeeds = feeds.filter((f) => f.alert);
  const windowHours = alertWindowHours(lastCheck, started);
  log(`checking ${alertFeeds.length} alert-eligible feeds over the last ${windowHours.toFixed(1)} h ` +
    `(${lastCheck ? `last clean check ${new Date(lastCheck).toISOString()}` : 'no record of a previous check'})`);

  const [{ items }, quakes] = await Promise.all([
    retrieveAll(alertFeeds, { lookbackHours: windowHours, log }),
    nearbyQuakes(places, { lookbackHours: windowHours, log }),
  ]);
  if (quakes.length) log(`USGS: ${quakes.length} quake(s) near someone`);
  if (items.length === 0 && quakes.length === 0) {
    log('nothing published in the window');
    return;
  }

  // Attach who lives there, so scoring can require the place be named and
  // the email can say who to text.
  const candidates = dedupeAlertItems([...items, ...quakes], { log }).map((c) => {
    const pl = c.place ? placeById.get(c.place) : null;
    return pl ? { ...c, place_match: pl.match, place_people: pl.people, place_name: pl.place } : c;
  });
  const historyPath = p('state/history.json');
  const history = await loadHistory(historyPath, { log });

  const picked = selectAlerts(candidates, history, { log, tz });
  if (picked.length === 0) return;

  const html = renderAlert(picked, { tz });
  const text = renderAlertText(picked);

  if (DRY_RUN) {
    await mkdir(p('out'), { recursive: true });
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

  // Record only after a successful send, so a send failure retries on the next
  // run rather than silently suppressing the alert forever.
  const now = Date.now();
  const day = alertDay(now, tz);
  const raw = JSON.parse(await readFile(historyPath, 'utf8'));
  raw.alerts = [
    ...(raw.alerts ?? []).filter((a) => now - (a.at ?? 0) < 14 * 24 * 3600e3),
    ...picked.map((i) => alertRecord(i, { day, now })),
  ];
  await writeFile(historyPath, JSON.stringify(raw, null, 2) + '\n');
  log(`recorded ${picked.length} alert(s)`);
}

async function main() {
  const lastCheck = await readLastCheck();
  await check(lastCheck);

  // Reached only when the check finished: sent and recorded, or nothing to
  // send. Any throw above (a feed parse crash, a Gmail outage) skips this, so
  // the next run's window still starts at the last clean check and covers
  // this run's items again. A dry run never moves the window.
  if (DRY_RUN || !LAST_CHECK_FILE) return;
  await mkdir(dirname(LAST_CHECK_FILE), { recursive: true });
  await writeFile(LAST_CHECK_FILE, JSON.stringify({ at: started }) + '\n');
  log(`next window starts at this check (${new Date(started).toISOString()})`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // Alerts fail quietly: a broken alert check must never generate its own
    // noise, and the daily brief still reports feed health. The non-zero exit
    // also keeps CI from saving the last-check record.
    log(String(err.stack ?? err), 'error');
    process.exit(1);
  });
