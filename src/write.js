/**
 * Second pass: turns the already-selected stories into finished prose. The
 * provider has no say in selection — it receives the sections as decided and
 * writes them. Output is sanitized and URLs are restored from selection data,
 * so no provider's output is trusted structurally.
 */
export async function writeDigest(sections, { prompt, schema, provider, chain, usage, history, log }) {
  const providers = chain?.length ? chain : [provider];
  const threads = history?.threads ?? {};
  // "Too detailed" feedback, per category (src/feedback.js).
  const verbosity = history?.verbosityHints ?? {};

  const payload = sections.map((s) => ({
    section: s.section,
    label: s.label,
    // The writer needs this to know how much to write. Without it, every story
    // gets full treatment and the brief becomes a dashboard.
    detail: s.detail ?? 'full',
    stories: s.stories.map((story) => {
      // Same key the thread gate and updateThreads use: a story whose own
      // event_key is an open thread continues it even when the scorer did not
      // set continues_thread.
      const thread = threads[story.continues_thread ?? story.event_key];
      const last = thread?.beats?.[thread.beats.length - 1];
      return {
        event_key: story.event_key,
        title: story.clean_title,
        category: story.category,
        geography: story.geography,
        development_stage: story.development_stage,
        source: story.source,
        published: new Date(story.published_at).toISOString(),
        primary_url: story.url,
        supporting_urls: (story.supporting ?? []).map((x) => x.url).slice(0, 2),
        evidence_stage: story.evidence_stage,
        triage_note: story.why_it_matters,
        snippet: (story.snippet ?? '').slice(0, 1000),
        ...(verbosity[story.category] ? { verbosity: verbosity[story.category] } : {}),
        // Present only for stories continuing something already sent. This is
        // what lets the brief say what CHANGED rather than repeating itself.
        ...(thread
          ? {
              thread_context: {
                times_sent: thread.times_sent ?? 1,
                days_since_last: Math.floor((Date.now() - (thread.last_sent ?? Date.now())) / 86400e3),
                last_state: last?.state ?? '',
                last_stage: last?.stage ?? '',
              },
            }
          : {}),
      };
    }),
  }));

  let lastError;
  for (const p of providers) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const digest = sanitizeDigest(await p.writeDigest({ system: prompt, schema, payload, usage }), sections);
        const repaired = rebuildFromSelection(digest, sections, log);
        log(`digest written via ${p.label}: ${countWords(repaired)} words across ${repaired.sections.length} sections`);
        return { digest: repaired, usedProvider: p };
      } catch (err) {
        lastError = err;
        const msg = String(err.message ?? err);
        if (attempt < 2) {
          log(`digest ${p.name} attempt ${attempt} failed (${msg}); retrying`, 'warn');
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          log(`digest ${p.name} failed (${msg}); falling back`, 'warn');
        }
      }
    }
  }
  throw new Error(`digest writing failed on every provider: ${String(lastError?.message ?? lastError)}`);
}

const CONFIDENCE = new Set(['Certain', 'Likely', 'Guessing']);
const ACTION = new Set(['NONE', 'WATCH', 'RESEARCH', 'CONSIDER_ACTION']);
const HORIZON = new Set(['Immediate', 'Weeks', 'Months', 'Years']);
const EVIDENCE = new Set([
  'not_applicable', 'preclinical', 'observational', 'randomized_trial',
  'guideline', 'regulatory_action', 'unclear',
]);

function sanitizeDigest(digest, sections) {
  if (!digest || !Array.isArray(digest.sections)) throw new Error('digest missing sections array');

  // Source class per event, so the Certain guard below can be enforced.
  const classByKey = new Map();
  for (const sec of sections ?? []) {
    for (const st of sec.stories ?? []) {
      classByKey.set(st.event_key, st.source_classes ?? [st.source_class ?? 'established']);
    }
  }

  return {
    todays_signal: String(digest.todays_signal ?? ''),
    sections: digest.sections.map((s) => ({
      section: String(s.section ?? ''),
      label: String(s.label ?? ''),
      stories: (Array.isArray(s.stories) ? s.stories : []).map((st) => {
        const classes = classByKey.get(String(st.feedback_id ?? '')) ?? [];
        // The writer grades confidence on a 1,000-character excerpt, not the
        // article. 'Certain' is only honest when a primary source states the
        // fact outright, so anything else is capped at 'Likely'.
        let confidence = CONFIDENCE.has(st.confidence) ? st.confidence : 'Likely';
        if (confidence === 'Certain' && !classes.includes('primary')) confidence = 'Likely';

        const action = ACTION.has(st.action) ? st.action : 'NONE';
        return {
          feedback_id: String(st.feedback_id ?? ''),
          headline: String(st.headline ?? '').slice(0, 300),
          category: String(st.category ?? 'politics'),
          summary: String(st.summary ?? ''),
          why_it_matters: String(st.why_it_matters ?? ''),
          whats_new: String(st.whats_new ?? ''),
          thread_state: String(st.thread_state ?? '').slice(0, 200),
          confidence,
          action,
          action_reason: action === 'NONE' ? '' : String(st.action_reason ?? ''),
          time_horizon: HORIZON.has(st.time_horizon) ? st.time_horizon : 'Months',
          primary_url: String(st.primary_url ?? ''),
          supporting_urls: Array.isArray(st.supporting_urls) ? st.supporting_urls.map(String).slice(0, 2) : [],
          evidence_stage: EVIDENCE.has(st.evidence_stage) ? st.evidence_stage : 'not_applicable',
        };
      }),
    })),
  };
}

/**
 * The selection decides which stories appear, in which section, in what order
 * and at what detail; the writer only supplies prose. The digest is rebuilt
 * from `sections`, taking each story's text from the first written entry with a
 * matching feedback_id. Before 2026-10-07 the writer's own structure was kept,
 * so a story it dropped vanished silently but was still recorded as sent (and
 * suppressed for 14 days), a duplicate rendered twice, and a renamed section
 * could promote a Watching item into the lead.
 *
 * URLs are the one thing a model must never paraphrase, so every link and every
 * corroboration fact also comes from selection data.
 */
export function rebuildFromSelection(digest, sections, log) {
  const written = new Map();
  for (const sec of digest.sections ?? []) {
    for (const st of sec.stories ?? []) {
      if (st.feedback_id && !written.has(st.feedback_id)) written.set(st.feedback_id, st);
    }
  }

  const selected = sections.flatMap((s) => s.stories);
  const covered = selected.filter((st) => written.has(st.event_key)).length;
  // A writer that matched less than half the stories did not do the job; let
  // the cascade retry or fall back rather than paper over it with excerpts.
  if (selected.length > 0 && covered < Math.ceil(selected.length / 2)) {
    throw new Error(`writer covered only ${covered} of ${selected.length} stories`);
  }

  const unknown = [...written.keys()].filter((k) => !selected.some((st) => st.event_key === k));
  if (unknown.length) log(`  ignored ${unknown.length} written story/ies with unknown feedback_id`, 'warn');

  let repaired = 0;
  let filled = 0;
  const out = sections.map((sec) => ({
    section: sec.section,
    label: sec.label,
    detail: sec.detail ?? 'full',
    stories: sec.stories.map((source) => {
      let story = written.get(source.event_key);
      if (story) {
        story = { ...story };
        if (story.primary_url !== source.url) repaired++;
        if (!story.headline) story.headline = source.clean_title || source.title || '';
      } else {
        story = excerptStory(source);
        filled++;
      }
      story.primary_url = source.url;
      story.supporting_urls = (source.supporting ?? []).map((x) => x.url).slice(0, 2);
      story.source_name = source.source;
      // Corroboration is derived from retrieval facts, never from model output —
      // a claim about who else reported something must not be generated text.
      story.source_leans = source.leans ?? [source.lean ?? 'center'];
      return story;
    }),
  }));

  if (repaired) log(`  restored ${repaired} altered URL(s) from selection data`, 'warn');
  if (filled) log(`  writer omitted ${filled} selected story/ies; used the source excerpt instead`, 'warn');
  return { ...digest, sections: out };
}

/** Plain, honest stand-in for a story the writer skipped. */
function excerptStory(source) {
  const text = String(source.snippet ?? '').replace(/\s+/g, ' ').trim();
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  return {
    feedback_id: source.event_key,
    headline: String(source.clean_title || source.title || '').slice(0, 300),
    category: source.category ?? 'politics',
    summary: sentences.slice(0, 2).join(' ').slice(0, 400),
    why_it_matters: String(source.why_it_matters ?? ''),
    whats_new: '',
    thread_state: '',
    confidence: 'Likely',
    action: 'NONE',
    action_reason: '',
    time_horizon: 'Months',
    evidence_stage: source.evidence_stage ?? 'not_applicable',
  };
}

function countWords(digest) {
  return digest.sections
    .flatMap((s) => s.stories)
    .reduce((n, st) => n + `${st.summary} ${st.why_it_matters}`.split(/\s+/).length, 0);
}
