import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETENTION_DAYS = 14;
/**
 * Threads outlive entries by a lot. A property-area ordinance moves on a
 * multi-month clock — first reading, second reading, final vote — and a 14-day
 * memory would forget the beginning and report the ending as brand new.
 */
const THREAD_RETENTION_DAYS = 90;
/** Beyond this a thread is closed: nothing has moved, so stop offering it. */
const THREAD_STALE_DAYS = 45;

/**
 * The 14-day event memory. This is what makes `repeat_stories` work: without durable
 * state the brief re-sends the same ongoing story every morning. Committed back to
 * the repo by the workflow so it survives between runs.
 */
export async function loadHistory(path, { log }) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const entries = (raw.entries ?? []).filter((e) => e.sent_at >= cutoff);
    log(`history: ${entries.length} events in last ${RETENTION_DAYS} days`);
    return {
      entries,
      feedbackWeights: normalizeWeights(raw.feedbackWeights),
      muted: pruneMuted(raw.muted ?? {}),
      alerts: (raw.alerts ?? []).filter((a) => (a.at ?? 0) >= cutoff),
      threads: pruneThreads(raw.threads ?? {}),
      // State written by the non-ranking feedback signals. Each acts at a
      // different pipeline stage, so each is stored separately rather than
      // collapsed into the weight table.
      sourceOverrides: raw.sourceOverrides ?? {},
      quietThreads: raw.quietThreads ?? {},
      slowFeeds: raw.slowFeeds ?? {},
      verbosityHints: raw.verbosityHints ?? {},
      feedComplaints: raw.feedComplaints ?? {},
      importantDimensions: raw.importantDimensions ?? {},
      actionFeedback: (raw.actionFeedback ?? []).slice(-200),
      // Full signal log, kept longer than events so long-run patterns stay
      // visible in `npm run tuning`.
      feedbackLog: raw.feedbackLog ?? [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') log(`history unreadable, starting fresh: ${err.message}`, 'warn');
    return {
      entries: [], feedbackWeights: emptyWeights(), muted: {}, alerts: [], threads: {},
      sourceOverrides: {}, quietThreads: {}, slowFeeds: {}, verbosityHints: {},
      feedComplaints: {}, importantDimensions: {}, actionFeedback: [], feedbackLog: [],
    };
  }
}

export async function saveHistory(path, history, selected, { log }) {
  const now = Date.now();
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // Source and geography are recorded so feedback can act on more than the
  // category — "less like this" on a home-state politics story should not dampen
  // every political story you get.
  const fresh = selected.map((s) => ({
    event_key: s.event_key,
    top_dimension: s.top_dimension,
    title: s.clean_title,
    url: s.url,
    category: s.category,
    geography: s.geography,
    source: s.source,
    feed_id: s.feed_id,
    total_score: s.total_score,
    sent_at: now,
  }));

  const merged = [...history.entries.filter((e) => e.sent_at >= cutoff), ...fresh];

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(
      {
        updated_at: new Date(now).toISOString(),
        entries: merged,
        feedbackWeights: normalizeWeights(history.feedbackWeights),
        muted: pruneMuted(history.muted),
        // Preserved so the daily brief never clobbers alert state written by the
        // hourly workflow between runs.
        alerts: (history.alerts ?? []).filter((a) => (a.at ?? 0) >= cutoff),
        threads: pruneThreads(history.threads ?? {}),
        sourceOverrides: history.sourceOverrides ?? {},
        quietThreads: history.quietThreads ?? {},
        slowFeeds: history.slowFeeds ?? {},
        verbosityHints: history.verbosityHints ?? {},
        feedComplaints: history.feedComplaints ?? {},
        importantDimensions: history.importantDimensions ?? {},
        actionFeedback: (history.actionFeedback ?? []).slice(-200),
        feedbackLog: (history.feedbackLog ?? []).slice(-500),
      },
      null,
      2
    ) + '\n'
  );
  log(`history: saved ${fresh.length} new events (${merged.length} total retained)`);
}

export const emptyWeights = () => ({ categories: {}, sources: {}, geographies: {} });

function pruneThreads(threads) {
  const cutoff = Date.now() - THREAD_RETENTION_DAYS * 24 * 3600e3;
  return Object.fromEntries(
    Object.entries(threads)
      .filter(([, t]) => (t.last_sent ?? 0) >= cutoff)
      .map(([k, t]) => [k, { ...t, beats: (t.beats ?? []).slice(-6) }])
  );
}

/**
 * Records what was sent as thread beats. `state` is the one-line summary the
 * digest model wrote — it has already synthesized the story, so a durable
 * one-liner is nearly free there and far better than the cheap scorer's guess.
 */
export function updateThreads(history, selected, digest) {
  const now = Date.now();
  const threads = history.threads ?? {};
  const states = new Map();
  for (const sec of digest?.sections ?? []) {
    for (const st of sec.stories ?? []) {
      if (st.thread_state) states.set(st.feedback_id, String(st.thread_state).slice(0, 200));
    }
  }

  for (const s of selected) {
    const key = s.continues_thread ?? s.event_key;
    const t = (threads[key] ??= {
      first_seen: now,
      times_sent: 0,
      category: s.category,
      beats: [],
    });
    t.last_sent = now;
    t.times_sent += 1;
    t.beats.push({
      at: now,
      stage: s.development_stage,
      state: states.get(s.event_key) || s.clean_title.slice(0, 200),
    });
    t.beats = t.beats.slice(-6);
  }
  history.threads = threads;
  return threads;
}

/**
 * Open threads offered to the scorer so it can say "this continues that". Sent
 * as key + one-line state; the scorer may only echo a key back, never invent
 * one, so code retains ownership of thread identity.
 */
export function openThreads(history, limit = 40) {
  const cutoff = Date.now() - THREAD_STALE_DAYS * 24 * 3600e3;
  return Object.entries(history.threads ?? {})
    .filter(([, t]) => (t.last_sent ?? 0) >= cutoff)
    .sort((a, b) => (b[1].last_sent ?? 0) - (a[1].last_sent ?? 0))
    .slice(0, limit)
    .map(([key, t]) => ({
      key,
      state: t.beats?.[t.beats.length - 1]?.state ?? '',
      stage: t.beats?.[t.beats.length - 1]?.stage ?? 'occurred',
      days_since: Math.floor((Date.now() - (t.last_sent ?? Date.now())) / 86400e3),
      times_sent: t.times_sent ?? 1,
    }));
}

/**
 * Accepts both the original flat shape ({ ai: -2 }) and the current
 * three-dimension shape, so an existing history.json keeps its learned weights
 * across the upgrade instead of silently resetting to zero.
 */
function normalizeWeights(raw) {
  if (!raw || typeof raw !== 'object') return emptyWeights();
  if (raw.categories || raw.sources || raw.geographies) {
    return { categories: raw.categories ?? {}, sources: raw.sources ?? {}, geographies: raw.geographies ?? {} };
  }
  return { categories: { ...raw }, sources: {}, geographies: {} };
}

function pruneMuted(muted) {
  const now = Date.now();
  return Object.fromEntries(Object.entries(muted).filter(([, until]) => until > now));
}

/** Compact digest of recent events, passed to the scorer so it can judge novelty. */
export function recentEventSummary(history, limit = 60) {
  return history.entries
    .slice(-limit)
    .map((e) => `${new Date(e.sent_at).toISOString().slice(0, 10)} :: ${e.event_key} :: ${e.title}`)
    .join('\n');
}
