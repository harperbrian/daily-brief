#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { retrieveAll, retrieveTavily } from './retrieve.js';
import { normalize, prefilter } from './normalize.js';
import { loadHistory, saveHistory, recentEventSummary, openThreads, updateThreads } from './history.js';
import { scoreCandidates } from './score.js';
import { selectStories } from './select.js';
import { writeDigest } from './write.js';
import { renderHtml, renderText } from './render.js';
import { sendMail, sendFailureNotice } from './mail.js';
import { ingestFeedback, markFeedbackSeen } from './feedback.js';
import { pickProvider } from './providers/index.js';
import { createUsageTracker, appendUsage } from './usage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => join(ROOT, ...parts);

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const DUMP_CANDIDATES = args.has('--dump-candidates');
const NO_SEND = DRY_RUN || args.has('--no-send');

const started = Date.now();
function log(msg, level = 'info') {
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${level === 'info' ? '' : level.toUpperCase() + ': '}${msg}`);
}

const DIMS = [
  'financial_impact', 'career_impact', 'investment', 'decision_change',
  'business_opportunity', 'property', 'home_purchase', 'magnitude',
  'geographic', 'novelty',
];

const readJson = async (rel) => JSON.parse(await readFile(p(rel), 'utf8'));
const readText = async (rel) => readFile(p(rel), 'utf8');

async function main() {
  const { TAVILY_API_KEY, GMAIL_USER, GMAIL_APP_PASSWORD, BRIEF_TO, LOOKBACK_HOURS } = process.env;

  // No key of any kind is required: with none set this runs in rule-based mode.
  // `chain` is the ordered fallback list, always ending in the rule-based provider.
  const { primary: provider, chain } = pickProvider(process.env, log);
  const usage = createUsageTracker();
  let modeNote = provider.name === 'heuristic' ? 'rule-based mode — no AI model configured' : null;

  const preferences = await readJson('config/preferences.json');
  const { feeds } = await readJson('config/feeds.json');
  // Friends-and-family local feeds exist for the hourly impact check only;
  // Their local traffic and council votes have no business in the brief.
  const briefFeeds = feeds.filter((f) => !f.alert_only);
  const scoringSchema = await readJson('schema/scoring_schema.json');
  const digestSchema = await readJson('schema/digest_schema.json');
  const scoringPrompt = await readText('prompts/scoring_prompt.txt');
  const digestPrompt = await readText('prompts/digest_prompt.txt');

  const tz = preferences.timezone ?? 'America/Chicago';
  const owner = preferences.owner ?? 'Your';
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  // Monday reaches back further so the slow-moving weekly tracks are not empty
  // after a quiet weekend.
  const isMonday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date()) === 'Mon';
  const lookbackHours = Number(LOOKBACK_HOURS) || (isMonday ? 72 : 30);
  log(`starting brief for ${dateLabel} (lookback ${lookbackHours}h)`);

  // 1. Retrieve
  const { items: rssItems, health } = await retrieveAll(briefFeeds, { lookbackHours, log });
  const { items: tavilyItems } = TAVILY_API_KEY
    ? await retrieveTavily((await readJson('config/search_queries.json')).queries ?? [], {
        apiKey: TAVILY_API_KEY,
        log,
      })
    : { items: [] };
  const allItems = [...rssItems, ...tavilyItems];

  if (allItems.length === 0) throw new Error('no items retrieved from any source');

  // 2. Normalize, then budget per track — both happen before any tokens are spent
  const normalized = normalize(allItems, { log });
  const candidates = prefilter(normalized, { junkPatterns: preferences.junk_patterns ?? [], log });

  // 3. History, then fold in any feedback clicked since the last run. Feedback
  //    emails are NOT marked processed yet — that happens only after history is
  //    safely persisted (step 9), so a crash cannot silently eat a signal.
  const historyPath = p('state/history.json');
  const history = await loadHistory(historyPath, { log });
  let pendingFeedbackUids = [];
  if (!NO_SEND) {
    ({ uids: pendingFeedbackUids } = await ingestFeedback(history, {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
      log,
    }));
  }
  preferences._feedbackWeights = history.feedbackWeights;

  // 4. Score. Individual failed batches are rescored by rules inside
  //    scoreCandidates; meta reports how many needed rescue.
  const { scored, meta } = await scoreCandidates(candidates, {
    prompt: scoringPrompt,
    schema: scoringSchema,
    preferences,
    historyText: recentEventSummary(history),
    historyKeys: new Set(history.entries.map((e) => e.event_key)),
    openThreads: openThreads(history),
    provider,
    chain,
    usage,
    log,
  });
  if (scored.length === 0) throw new Error('scoring returned nothing');
  if (meta.rescued > 0 && provider.name !== 'heuristic') {
    modeNote =
      meta.rescued === meta.batches
        ? 'AI scoring unavailable today — rule-based scoring used'
        : modeNote;
  }

  // 5. Select
  const sections = selectStories(scored, history, preferences, { log });
  const selectedCount = sections.reduce((n, s) => n + s.stories.length, 0);
  if (selectedCount === 0) throw new Error('no stories cleared the quality floor');

  // 6. Write. The cascade handles fallback internally and reports who succeeded,
  //    so a degraded day is disclosed in the email rather than passing silently.
  const { digest, usedProvider } = await writeDigest(sections, {
    prompt: digestPrompt,
    schema: digestSchema,
    provider,
    chain,
    usage,
    history,
    log,
  });
  if (usedProvider.name === 'heuristic' && provider.name !== 'heuristic') {
    modeNote ??= 'AI writing unavailable today — summaries are source excerpts';
  }

  // 7. Render. Feedback replies must go to GMAIL_USER — the mailbox IMAP reads —
  //    never BRIEF_TO, or the loop silently breaks when the two differ.
  health.modeNote = modeNote;
  const feedbackAddress = NO_SEND ? null : GMAIL_USER;
  // Corroboration claims are only trustworthy when event keys were matched
  // semantically by a model; rule-based keys are lexical and under-merge.
  const corroborationReliable = !meta.providers.includes('heuristic') && usedProvider.name !== 'heuristic';
  const html = renderHtml(digest, {
    owner, dateLabel, feedbackAddress, health, corroborationReliable });
  const text = renderText(digest, { dateLabel, owner });

  await mkdir(p('out'), { recursive: true });
  // Local date, not UTC — an evening local run would otherwise write
  // tomorrow's filename while the brief says today. en-CA formats as YYYY-MM-DD.
  const stamp = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  await writeFile(p(`out/brief-${stamp}.html`), html);
  await writeFile(p(`out/brief-${stamp}.json`), JSON.stringify({ digest, sections, health, meta }, null, 2));
  log(`wrote out/brief-${stamp}.html`);

  // The full scored pool, for recalibrating thresholds against a real
  // distribution rather than guessing at one. Only selected stories are kept in
  // the brief file, so without this there is nothing to calibrate against.
  if (DUMP_CANDIDATES) {
    await writeFile(
      p(`out/candidates-${stamp}.json`),
      JSON.stringify(
        scored.map((c) => ({
          title: c.clean_title, event_key: c.event_key,
          source: c.source, source_class: c.source_class,
          category: c.category, geography: c.geography, stage: c.development_stage,
          relevance: c.relevance, quality: c.quality, integrity: c.integrity,
          total: c.total_score, top: c.top_dimension, include: c.include_candidate,
          // url and snippet are here so the labeling worksheet can show enough
          // to judge a story without opening ten tabs. See npm run label.
          url: c.url, snippet: (c.snippet ?? '').slice(0, 220),
          why: c.why_it_matters,
          dims: Object.fromEntries(DIMS.map((d) => [d, c[d]])),
        })),
        null, 2
      )
    );
    log(`wrote out/candidates-${stamp}.json (${scored.length} scored candidates)`);
  }

  // 8. Send
  if (NO_SEND) {
    log('dry run — not sending email, not writing history');
    return;
  }
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !BRIEF_TO) {
    throw new Error('GMAIL_USER, GMAIL_APP_PASSWORD and BRIEF_TO must be set to send');
  }

  await sendMail({
    html,
    text,
    subject: `${owner}'s Daily Brief — ${dateLabel}`,
    to: BRIEF_TO,
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
    log,
  });

  // 9. Persist — only after a successful send, so a send failure does not burn
  //    today's stories out of tomorrow's brief. Feedback messages are flagged
  //    processed last, once their effects are safely on disk.
  const selected = sections.flatMap((s) => s.stories);
  updateThreads(history, selected, digest);
  await saveHistory(historyPath, history, selected, { log });
  if (!usage.isEmpty()) {
    await appendUsage(p('state/usage.json'), {
      provider: usedProvider.name,
      snapshot: usage.snapshot(),
      candidates: candidates.length,
      stories: selected.length,
    });
    const t = usage.snapshot().total;
    log(`tokens this run: ${t.input + t.cacheRead} in, ${t.output} out across ${t.calls} calls`);
  }
  await markFeedbackSeen(pendingFeedbackUids, { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD, log });
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .then(() => {
    // Explicit exit is load-bearing: feeds that hit the hard timeout leave
    // dangling sockets that keep the event loop alive, and in CI a process that
    // never exits hangs the job until the runner kills it — which marks the run
    // failed and skips the history commit. Do not remove.
    process.exit(0);
  })
  .catch(async (err) => {
    log(String(err.stack ?? err), 'error');
    const { GMAIL_USER, GMAIL_APP_PASSWORD, BRIEF_TO } = process.env;
    if (!NO_SEND && GMAIL_USER && GMAIL_APP_PASSWORD && BRIEF_TO) {
      await sendFailureNotice({ error: err, to: BRIEF_TO, user: GMAIL_USER, pass: GMAIL_APP_PASSWORD, log });
    }
    process.exit(1);
  });
