/**
 * Feedback ingestion. The email buttons produce messages with a subject of
 *   "brief-feedback: <action> <event_key>"
 * sent to the pipeline's own Gmail account (GMAIL_USER — the mailbox IMAP reads,
 * NOT the delivery address). This reads them on the next run and folds them into
 * history.json.
 *
 * Two-phase on purpose: ingestFeedback() only reads and applies signals in
 * memory; markFeedbackSeen() flags the messages as processed and is called only
 * AFTER history is safely written. If the run crashes in between, the worst case
 * is a signal applied twice (a ±2 nudge), never a signal silently lost.
 *
 * Deliberately gradual, per the original build pack: one click nudges a weight,
 * it does not rewrite preferences. Large shifts require repeated signals.
 */
import { ImapFlow } from 'imapflow';

/**
 * One click nudges three dimensions at once, weighted by how specific each is.
 * The source moves most: "less like this" on a home-state politics story most
 * likely means that outlet, not all politics everywhere. Category moves less,
 * and geography barely — it is the broadest and easiest signal to over-apply.
 */
const STEP = { source: 3, category: 2, geography: 1 };

/** Ceilings, so feedback tunes ranking without ever dominating it. */
const MAX_ADJUSTMENT = { source: 15, category: 12, geography: 8 };

const MUTE_DAYS = 30;

/**
 * The eight signals, and where each one acts.
 *
 * The generalizing principle: a signal should act at the stage its complaint
 * came from. Routing all eight into the ranking sum is the easy implementation
 * and the wrong one — it makes every complaint say "less of this topic", which
 * is the one thing none of them said. "Already knew this" is a complaint about
 * timing, not topic; "too detailed" is about the writer, not selection; "bad
 * source" is about believability, which should multiply rather than add.
 */
const SIGNALS = {
  more:        { rank: +1, note: 'more of this' },
  less:        { rank: -1, note: 'less of this' },
  irrelevant:  { rank: -2, feedComplaint: true, note: 'should not have been selected' },
  important:   { rank: +2, calibrate: true, note: 'very important' },
  bad_source:  { demoteSource: true, note: 'source is not believable' },
  known:       { staleThread: true, slowFeed: true, note: 'already knew this' },
  too_long:    { verbosity: true, note: 'useful but too detailed' },
  actionable:  { rank: +1, actionCalibrate: true, note: 'useful and actionable' },
  mute:        { mute: true, note: 'mute this category' },
};
export const SIGNAL_NAMES = Object.keys(SIGNALS);

function connect(user, pass) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
}

export async function ingestFeedback(history, { user, pass, log }) {
  if (!user || !pass) return { uids: [] };

  let client;
  const uids = [];
  try {
    client = connect(user, pass);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 7 * 24 * 3600e3);
      // seen:false — anything already processed was flagged by markFeedbackSeen.
      const found = await client.search({ since, subject: 'brief-feedback:', seen: false });
      if (!found || found.length === 0) {
        log('feedback: none pending');
        return { uids: [] };
      }

      let applied = 0;
      for await (const msg of client.fetch(found, { envelope: true, uid: true })) {
        const parsed = parseSubject(msg.envelope?.subject ?? '');
        if (!parsed) continue;
        applyFeedback(history, parsed, log);
        uids.push(msg.uid);
        applied++;
      }
      log(`feedback: applied ${applied} signal(s)`);
    } finally {
      lock.release();
    }
  } catch (err) {
    // Feedback is a nicety; never let it break the brief.
    log(`feedback ingestion skipped: ${String(err.message ?? err)}`, 'warn');
  } finally {
    try {
      await client?.logout();
    } catch {}
  }

  return { uids };
}

/** Call only after history has been persisted. Reconnects briefly to set flags. */
export async function markFeedbackSeen(uids, { user, pass, log }) {
  if (!uids.length || !user || !pass) return;
  let client;
  try {
    client = connect(user, pass);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      log(`feedback: marked ${uids.length} message(s) processed`);
    } finally {
      lock.release();
    }
  } catch (err) {
    // Worst case the same nudge applies again tomorrow — acceptable.
    log(`could not mark feedback processed: ${String(err.message ?? err)}`, 'warn');
  } finally {
    try {
      await client?.logout();
    } catch {}
  }
}

function parseSubject(subject) {
  const m = new RegExp(`brief-feedback:\\s*(${SIGNAL_NAMES.join('|')})\\s+(\\S+)`, 'i').exec(subject);
  return m ? { action: m[1].toLowerCase(), eventKey: m[2] } : null;
}

/** Exported for tests: the weighting logic is worth verifying without IMAP. */
export const applyFeedbackForTest = applyFeedback;

function applyFeedback(history, { action, eventKey }, log) {
  // Resolve the event back to what it actually was, via history.
  const entry = history.entries.find((e) => e.event_key === eventKey);
  if (!entry) {
    log(`  feedback for unknown event_key ${eventKey}; ignored`, 'warn');
    return;
  }

  history.feedbackWeights ??= { categories: {}, sources: {}, geographies: {} };
  history.muted ??= {};
  history.feedbackLog ??= [];

  history.feedbackLog.push({
    at: Date.now(),
    action,
    event_key: eventKey,
    title: entry.title,
    category: entry.category,
    source: entry.source,
    geography: entry.geography,
  });

  const signal = SIGNALS[action];
  if (!signal) {
    log(`  unknown feedback signal "${action}"; ignored`, 'warn');
    return;
  }

  if (signal.mute) {
    if (!entry.category) return;
    history.muted[entry.category] = Date.now() + MUTE_DAYS * 24 * 3600e3;
    log(`  muted category "${entry.category}" for ${MUTE_DAYS} days`);
    return;
  }

  const applied = [];

  // Ranking weights — only for signals that are actually about relevance.
  if (signal.rank) {
    const sign = Math.sign(signal.rank);
    const scale = Math.abs(signal.rank);
    for (const [bucket, key, step, cap] of [
      ['sources', entry.source, STEP.source, MAX_ADJUSTMENT.source],
      ['categories', entry.category, STEP.category, MAX_ADJUSTMENT.category],
      ['geographies', entry.geography, STEP.geography, MAX_ADJUSTMENT.geography],
    ]) {
      if (!key || key === 'not_applicable') continue;
      const next = clamp((history.feedbackWeights[bucket][key] ?? 0) + sign * step * scale, -cap, cap);
      history.feedbackWeights[bucket][key] = next;
      applied.push(`${key} ${next > 0 ? '+' : ''}${next}`);
    }
  }

  // "bad source" is about believability, not topic — it multiplies quality
  // rather than adding to rank. Capped at two rungs, so one irritated morning
  // cannot silently retire a whole outlet.
  if (signal.demoteSource && entry.feed_id) {
    history.sourceOverrides ??= {};
    const n = Math.min(2, (history.sourceOverrides[entry.feed_id] ?? 0) + 1);
    history.sourceOverrides[entry.feed_id] = n;
    applied.push(`${entry.feed_id} demoted ${n} rung(s)`);
  }

  // "already knew this" is a complaint about TIMING, not topic. It must not
  // touch the category — the subject was fine, the moment was wrong.
  if (signal.staleThread) {
    history.quietThreads ??= {};
    history.quietThreads[entry.event_key] = Date.now();
    applied.push(`thread "${entry.event_key}" resurfaces only on a stage change`);
  }
  if (signal.slowFeed && entry.feed_id) {
    history.slowFeeds ??= {};
    history.slowFeeds[entry.feed_id] = (history.slowFeeds[entry.feed_id] ?? 0) + 1;
  }

  // "too detailed" is a note to the writer, with zero selection effect.
  if (signal.verbosity && entry.category) {
    history.verbosityHints ??= {};
    history.verbosityHints[entry.category] = 'brief';
    applied.push(`${entry.category} summaries shortened`);
  }

  // A feed repeatedly called irrelevant becomes a removal candidate, surfaced in
  // `npm run tuning` and never acted on automatically.
  if (signal.feedComplaint && entry.feed_id) {
    history.feedComplaints ??= {};
    history.feedComplaints[entry.feed_id] = (history.feedComplaints[entry.feed_id] ?? 0) + 1;
  }

  // The only signal allowed to inform the dimension weights, and only as a
  // printed suggestion. Auto-tuning ten weights from a handful of clicks
  // overfits badly and destroys any ability to explain a ranking.
  if (signal.calibrate && entry.top_dimension) {
    history.importantDimensions ??= {};
    history.importantDimensions[entry.top_dimension] =
      (history.importantDimensions[entry.top_dimension] ?? 0) + 1;
    applied.push(`dimension "${entry.top_dimension}" noted`);
  }

  if (signal.actionCalibrate) {
    history.actionFeedback ??= [];
    history.actionFeedback.push({ at: Date.now(), event_key: entry.event_key, category: entry.category });
  }

  log(`  ${action} (${signal.note}): ${applied.join(', ') || 'recorded'}`);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
