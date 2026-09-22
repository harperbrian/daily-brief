/**
 * Fixed HTML template. The model never produces markup — it returns structured
 * data and this file renders it, so a bad generation cannot break the email or
 * inject anything into it. Every interpolated value goes through esc().
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Only http(s) links are emitted; anything else becomes an inert span. */
const safeUrl = (u) => {
  try {
    const parsed = new URL(String(u));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
};

const SECTION_ACCENT = {
  what_matters: '#b3261e',
  worth_knowing: '#1a4f8a',
  watching: '#7a5200',
};

/** Only actions that ask something of the reader get a visible badge. */
const ACTION_STYLE = {
  CONSIDER_ACTION: { label: 'Consider action', bg: '#fde7e6', fg: '#8c1d18' },
  RESEARCH: { label: 'Worth researching', bg: '#e8eefb', fg: '#1a3f7a' },
  WATCH: { label: 'Watch', bg: '#fdf3d0', fg: '#5a4a00' },
};

const EVIDENCE_LABEL = {
  preclinical: 'Preclinical (animal or lab only)',
  observational: 'Observational — cannot show cause',
  randomized_trial: 'Randomized trial',
  guideline: 'Clinical guideline',
  regulatory_action: 'Regulatory action',
  unclear: 'Evidence stage unclear',
};

export function renderHtml(digest, { dateLabel, feedbackAddress, health, corroborationReliable = true, owner = 'Your' }) {
  const sections = (digest.sections ?? []).filter((s) => (s.stories ?? []).length);
  const storyCount = sections.reduce((n, s) => n + s.stories.length, 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(owner)}'s Daily Brief — ${esc(dateLabel)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f2;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(digest.todays_signal ?? '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:20px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">

  <tr><td style="padding:26px 28px 18px;border-bottom:3px solid #1a1a1a;">
    <div style="font-size:21px;font-weight:700;color:#1a1a1a;letter-spacing:-0.3px;">${esc(owner)}'s Daily Brief</div>
    <div style="font-size:13px;color:#6b6b6b;margin-top:5px;">${esc(dateLabel)} &middot; ${storyCount} ${storyCount === 1 ? 'story' : 'stories'}</div>
  </td></tr>

  ${sections.map((s) => renderSection(s, feedbackAddress, corroborationReliable)).join('')}

  ${
    digest.todays_signal
      ? `<tr><td style="padding:20px 28px;background:#1a1a1a;">
           <div style="font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f;">Today's signal</div>
           <div style="font-size:15px;line-height:1.55;color:#ffffff;margin-top:7px;">${esc(digest.todays_signal)}</div>
         </td></tr>`
      : ''
  }

  ${renderFooter(feedbackAddress, health)}

</table>
</td></tr>
</table>
</body>
</html>`;
}

function renderSection(section, feedbackAddress, corroborationReliable) {
  const accent = SECTION_ACCENT[section.section] ?? '#1a1a1a';
  return `<tr><td style="padding:24px 28px 6px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${accent};">${esc(section.label)}</div>
  </td></tr>
  ${section.stories
    .map((story) =>
      (section.detail ?? 'full') === 'line'
        ? renderLine(story, accent)
        : renderStory(story, accent, feedbackAddress, corroborationReliable, section.detail ?? 'full')
    )
    .join('')}`;
}

/**
 * One-line treatment for Things I'm Watching. These are unresolved situations,
 * not developments — a paragraph each would imply more has happened than has.
 */
function renderLine(story, accent) {
  const url = safeUrl(story.primary_url);
  const text = esc(story.headline);
  const linked = url ? `<a href="${esc(url)}" style="color:#1a1a1a;text-decoration:none;">${text}</a>` : text;
  const when = story.time_horizon ? `<span style="color:#8a8a8a;font-size:12px;"> · ${esc(story.time_horizon)}</span>` : '';
  return `<tr><td style="padding:7px 28px;border-bottom:1px solid #f2f2f0;">
    <div style="font-size:14px;line-height:1.5;color:#1a1a1a;border-left:3px solid ${accent};padding-left:10px;">
      ${linked}${when}
      ${story.summary ? `<div style="font-size:13px;color:#5a5a5a;margin-top:2px;">${esc(story.summary)}</div>` : ''}
    </div>
  </td></tr>`;
}

function renderStory(story, accent, feedbackAddress, corroborationReliable, detail) {
  const url = safeUrl(story.primary_url);
  const headline = url
    ? `<a href="${esc(url)}" style="color:#1a1a1a;text-decoration:none;">${esc(story.headline)}</a>`
    : esc(story.headline);

  const supporting = (story.supporting_urls ?? [])
    .map(safeUrl)
    .filter(Boolean)
    .map(
      (u, i) =>
        `<a href="${esc(u)}" style="color:#5a5a5a;text-decoration:underline;font-size:12px;">more coverage ${i + 1}</a>`
    )
    .join(' &middot; ');

  const evidence =
    story.evidence_stage && story.evidence_stage !== 'not_applicable'
      ? `<div style="display:inline-block;font-size:11px;color:#5a4a00;background:#fdf3d0;border-radius:3px;padding:3px 7px;margin-top:9px;">${esc(
          EVIDENCE_LABEL[story.evidence_stage] ?? story.evidence_stage
        )}</div>`
      : '';

  // 'Likely' is the honest default and gets no badge; only a weaker or stronger
  // claim is worth calling out.
  const confidence =
    story.confidence === 'Guessing'
      ? `<span style="font-size:11px;color:#8a6a00;font-weight:600;"> &middot; uncertain</span>`
      : story.confidence === 'Certain'
        ? `<span style="font-size:11px;color:#1b5e20;font-weight:600;"> &middot; confirmed</span>`
        : '';

  const corroboration = renderCorroboration(story.source_leans, corroborationReliable);

  const action = ACTION_STYLE[story.action];
  const actionBadge = action
    ? `<div style="display:inline-block;font-size:11px;font-weight:600;color:${action.fg};background:${action.bg};border-radius:3px;padding:3px 8px;margin-top:9px;">${esc(action.label)}${
        story.action_reason ? ` — ${esc(story.action_reason)}` : ''
      }</div>`
    : '';

  const horizon =
    detail === 'full' && story.time_horizon
      ? `<span style="font-size:11px;color:#8a8a8a;"> · ${esc(story.time_horizon)}</span>`
      : '';

  // A distinct line, never folded into the summary — the whole point is that it
  // stands out from what he already read.
  const whatsNew = story.whats_new
    ? `<div style="font-size:13.5px;line-height:1.55;color:#1a4f8a;background:#f4f7fd;border-radius:4px;padding:8px 10px;margin-top:9px;">
         <strong style="font-weight:650;">Since last time:</strong> ${esc(story.whats_new)}
       </div>`
    : '';

  return `<tr><td style="padding:${detail === 'brief' ? '10px 28px 14px' : '12px 28px 20px'};border-bottom:1px solid #ececea;">
    <div style="font-size:${detail === 'brief' ? '15.5' : '17'}px;font-weight:650;line-height:1.35;color:#1a1a1a;">${headline}</div>
    <div style="font-size:12px;color:#8a8a8a;margin-top:4px;">${esc(story.source_name ?? '')}${confidence}${horizon}</div>
    <div style="font-size:${detail === 'brief' ? '14' : '14.5'}px;line-height:1.62;color:#333333;margin-top:8px;">${esc(story.summary)}</div>
    ${whatsNew}
    ${
      story.why_it_matters
        ? `<div style="font-size:14px;line-height:1.55;color:#1a1a1a;margin-top:9px;padding-left:11px;border-left:3px solid ${accent};">
      <strong style="font-weight:650;">Why it matters:</strong> ${esc(story.why_it_matters)}
    </div>`
        : ''
    }
    ${actionBadge}${evidence}${corroboration}
    ${supporting ? `<div style="margin-top:9px;">${supporting}</div>` : ''}
    ${detail === 'full' ? renderFeedback(story, feedbackAddress) : ''}
  </td></tr>`;
}

/**
 * Shows how broadly a story was corroborated. Only the two states worth acting on
 * are labelled: reported across the spectrum (trust it more) and single-outlet
 * (trust it less). Everything in between gets no badge, so the badges stay
 * meaningful instead of decorating every story.
 */
function renderCorroboration(leans, reliable) {
  if (!Array.isArray(leans) || leans.length === 0) return '';
  const has = (set) => leans.some((l) => set.has(l));
  const left = has(new Set(['left', 'center-left']));
  const right = has(new Set(['right', 'center-right']));

  // A positive badge is always safe: opposing outlets really did both cover it.
  if (left && right) {
    return `<div style="display:inline-block;font-size:11px;color:#1b5e20;background:#e3f2e4;border-radius:3px;padding:3px 7px;margin-top:9px;margin-left:6px;">Reported across the spectrum</div>`;
  }
  // The negative badge is only honest when events were matched semantically. In
  // rule-based mode event keys are lexical, so two outlets wording a headline
  // differently never merge — badging every story "single source" would assert
  // a check that did not actually happen.
  if (reliable && leans.length === 1 && leans[0] !== 'primary') {
    return `<div style="display:inline-block;font-size:11px;color:#6a6a6a;background:#f0f0ee;border-radius:3px;padding:3px 7px;margin-top:9px;margin-left:6px;">Single source so far</div>`;
  }
  return '';
}

/**
 * Feedback via mailto rather than a webhook: no public endpoint to host, no
 * signing secret, no attack surface. Replies land in a label the pipeline reads
 * on the next run (see src/feedback.js).
 */
function renderFeedback(story, feedbackAddress) {
  if (!feedbackAddress) return '';
  const link = (action, label, hint) => {
    const subject = encodeURIComponent(`brief-feedback: ${action} ${story.feedback_id}`);
    const body = encodeURIComponent(
      `Send this email as-is to record your feedback.\n\nStory: ${story.headline}\nSignal: ${action}${hint ? ` (${hint})` : ''}\n`
    );
    return `<a href="mailto:${esc(feedbackAddress)}?subject=${subject}&amp;body=${body}" style="color:#7a7a7a;text-decoration:none;font-size:11px;border:1px solid #dcdcda;border-radius:11px;padding:3px 9px;">${label}</a>`;
  };

  // Four visible buttons, not eight. Eight per story across fifteen stories is
  // 120 mailto links, which pushes the email toward Gmail's 102KB clip
  // threshold — and a wall of buttons gets used less, not more. The rest live
  // behind one link whose body lists them.
  const others = ['irrelevant', 'known', 'bad_source', 'too_long', 'mute']
    .map((a) => `  brief-feedback: ${a} ${story.feedback_id}`)
    .join('\n');
  const otherSubject = encodeURIComponent(`brief-feedback: less ${story.feedback_id}`);
  const otherBody = encodeURIComponent(
    `Replace the subject line with ONE of these, then send:\n\n${others}\n\n` +
      `  irrelevant  should not have been selected at all\n` +
      `  known       I already knew this — right topic, wrong timing\n` +
      `  bad_source  I do not trust this outlet\n` +
      `  too_long    useful, but too detailed\n` +
      `  mute        stop sending this category for 30 days\n`
  );

  return `<div style="margin-top:12px;">
    ${link('more', '&#43; More like this')}
    &nbsp;${link('less', '&minus; Less like this')}
    &nbsp;${link('important', 'Very important')}
    &nbsp;${link('actionable', 'Actionable')}
    &nbsp;<a href="mailto:${esc(feedbackAddress)}?subject=${otherSubject}&amp;body=${otherBody}" style="color:#9a9a9a;text-decoration:none;font-size:11px;padding:3px 4px;">More options&hellip;</a>
  </div>`;
}

function renderFooter(feedbackAddress, health) {
  const notes = [];
  if (health?.modeNote) notes.push(health.modeNote);
  if (health?.failed?.length) {
    notes.push(`${health.failed.length} feed${health.failed.length === 1 ? '' : 's'} unreachable today`);
  }
  // Plain '·' here, not the &middot; entity — esc() would double-escape an entity
  // into visible literal text.
  return `<tr><td style="padding:18px 28px 26px;background:#fafaf8;">
    <div style="font-size:11px;line-height:1.6;color:#9a9a9a;">
      Generated from ${esc(health?.ok ?? '?')} sources. Not investment or medical advice.
      ${notes.length ? `<br>${esc(notes.join(' · '))}` : ''}
      ${feedbackAddress ? `<br>Feedback buttons send a pre-filled email; nothing changes until you hit send.` : ''}
    </div>
  </td></tr>`;
}

/** Plain-text alternative, for clients that refuse HTML. */
export function renderText(digest, { dateLabel, owner = 'Your' }) {
  const lines = [`${owner.toUpperCase()}'S DAILY BRIEF — ${dateLabel}`, ''];
  for (const section of digest.sections ?? []) {
    if (!(section.stories ?? []).length) continue;
    lines.push(section.label.toUpperCase(), '');
    for (const story of section.stories) {
      if ((section.detail ?? 'full') === 'line') {
        lines.push(`* ${story.headline}${story.time_horizon ? ` (${story.time_horizon})` : ''}`);
        lines.push(`  ${story.primary_url}`, '');
        continue;
      }
      lines.push(`* ${story.headline}`);
      lines.push(`  ${story.summary}`);
      if (story.whats_new) lines.push(`  Since last time: ${story.whats_new}`);
      if (story.why_it_matters) lines.push(`  Why it matters: ${story.why_it_matters}`);
      if (story.action && story.action !== 'NONE') {
        lines.push(`  Action: ${story.action}${story.action_reason ? ` — ${story.action_reason}` : ''}`);
      }
      if (story.evidence_stage && story.evidence_stage !== 'not_applicable') {
        lines.push(`  Evidence: ${EVIDENCE_LABEL[story.evidence_stage] ?? story.evidence_stage}`);
      }
      lines.push(`  ${story.primary_url}`, '');
    }
  }
  if (digest.todays_signal) lines.push(`TODAY'S SIGNAL: ${digest.todays_signal}`);
  return lines.join('\n');
}
