/**
 * Second pass: turns the already-selected stories into finished prose. The
 * provider has no say in selection — it receives the sections as decided and
 * writes them. Output is sanitized and URLs are restored from selection data,
 * so no provider's output is trusted structurally.
 */
export async function writeDigest(sections, { prompt, schema, provider, chain, usage, history, log }) {
  const providers = chain?.length ? chain : [provider];
  const threads = history?.threads ?? {};

  const payload = sections.map((s) => ({
    section: s.section,
    label: s.label,
    // The writer needs this to know how much to write. Without it, every story
    // gets full treatment and the brief becomes a dashboard.
    detail: s.detail ?? 'full',
    stories: s.stories.map((story) => {
      const thread = threads[story.continues_thread ?? ''];
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
        const repaired = enforceUrls(digest, sections, log);
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
 * URLs are the one thing a model must never paraphrase. Rather than trust the
 * output, every link is restored from the selection data by event_key.
 */
function enforceUrls(digest, sections, log) {
  const byKey = new Map();
  for (const s of sections) {
    for (const story of s.stories) {
      byKey.set(story.event_key, story);
    }
  }

  // Detail level is decided by selection, not by the writer.
  const detailBySection = new Map((sections ?? []).map((s) => [s.section, s.detail ?? 'full']));

  let repaired = 0;
  for (const section of digest.sections) {
    section.detail = detailBySection.get(section.section) ?? 'full';
    section.stories = section.stories.filter((story) => {
      const source = byKey.get(story.feedback_id);
      if (!source) {
        log(`  dropped written story with unknown feedback_id: ${story.headline}`, 'warn');
        return false;
      }
      if (story.primary_url !== source.url) {
        story.primary_url = source.url;
        repaired++;
      }
      story.supporting_urls = (source.supporting ?? []).map((x) => x.url).slice(0, 2);
      story.source_name = source.source;
      // Corroboration is derived from retrieval facts, never from model output —
      // a claim about who else reported something must not be generated text.
      story.source_leans = source.leans ?? [source.lean ?? 'center'];
      return true;
    });
  }

  if (repaired) log(`  restored ${repaired} altered URL(s) from selection data`, 'warn');
  return digest;
}

function countWords(digest) {
  return digest.sections
    .flatMap((s) => s.stories)
    .reduce((n, st) => n + `${st.summary} ${st.why_it_matters}`.split(/\s+/).length, 0);
}
