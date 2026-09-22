/**
 * Breaking-news path. Runs hourly during waking hours and stays SILENT unless
 * something genuinely urgent has appeared since the last check.
 *
 * The design constraint is trust: an alert channel that cries wolf gets muted
 * within a week and then never delivers the one that mattered. So the bar is
 * deliberately far higher than the daily brief's, it is rule-based (fast, free,
 * predictable), and it is hard-capped per day.
 */

/** Only these feeds can trigger an alert — see `alert: true` in config/feeds.json. */
const REQUIRE_ALERT_FEED = true;

/** Never send more than this many alerts in one day, no matter what. */
export const MAX_ALERTS_PER_DAY = 3;

/** Weather alerts worth waking up for. NWS publishes far more than these. */
const SEVERE_WEATHER =
  /\b(tornado warning|flash flood warning|blizzard warning|ice storm warning|hurricane warning|evacuation|extreme wind warning|severe thunderstorm warning)\b/i;

/**
 * Events that are major anywhere on Earth. These clear the bar on their own.
 * "nuclear" alone is NOT here: on 2026-09-20 it matched a Reuters exclusive
 * about an Iran policy document and a North Korea missile test, neither of
 * which is an attack. The word has to be attached to one. Likewise a missile
 * strike counts when it lands on US territory — "missile attack rattles
 * historic region" is a daily headline from two wars and a travel advisory,
 * not a reason to interrupt the morning.
 */
const MAJOR =
  /\b(magnitude [7-9]|mass casualt\w*|assassinat\w*|coup\b|nuclear (?:attack|strike|explosion|detonation|meltdown)|(?:missiles?|drones?) (?:strikes?|hits?|attacks?) (?:on |against )?(?:the )?(?:u\.?s\.?\b|united states|american soil|guam|hawaii|alaska)|declares war|invades?\b|invasion of|dam (?:failure|breach))/i;

/**
 * Coverage of a major event long after it happened: trials, suspects, plea
 * deals, anniversaries. "Suspects in Haitian president's assassination
 * transferred to Miami" cleared the bar on 2026-09-21 for a 2021 killing.
 */
const FOLLOW_UP =
  /\b(suspects?|trial|charged|sentenc\w*|convict\w*|arrest\w*|indict\w*|plea|pleads?|extradit\w*|transferred|anniversary|years? (?:after|since|ago)|inquiry|investigation into|report on|documentary|memoir|book)\b/i;

/**
 * A different story that cites a major event as background: a release date
 * moved "following" an assassination, a season delayed after a coup. The
 * event is context; the news is a schedule. On 2026-09-21 "Apple TV's The
 * Savant gets spring 2027 release date after postponing following Kirk
 * assassination" scored 90 and went out as Breaking. `premiere` only counts
 * with a date word after it, and any casualty or hazard term in the title
 * lifts the suppression, so a shooting at a premiere still alerts.
 */
const SCHEDULING_NEWS =
  /\b(release date|premiere date|premieres? (?:on|in|this)|gets? .{0,25}(?:release|premiere)|renewed for|new season|season \d|episode \d|trailer|teaser|box office|now streaming|streaming (?:debut|release)|delayed to|pushed (?:back )?to|rescheduled for)\b/i;

/**
 * Events that matter when they are close to home or come from a primary
 * source, and are routine national noise otherwise (a governor declares a
 * state of emergency somewhere most weeks; a plane crashes somewhere most
 * months). Base score leaves them 15 short of the bar; locality or a primary
 * source closes the gap, a wire story's freshness does not.
 */
const NOTABLE =
  /\b(state of emergency|emergency rate (?:cut|decision)|recall(?:s|ed)? .{0,30}(?:infant|baby|child|children)|nationwide recall|plane crash|derailment)\b/i;

/** Locality is what makes an alert actionable rather than merely dramatic. */
const LOCAL_TRACKS = new Set(['home_local', 'home_region', 'property_local']);

/*
 * ── Friends and family (config/people.json) ────────────────────────────────
 * A different question than home: not "is there a warning" but "did something
 * happen that could have hurt them". the bar is explicit: no warnings, only
 * real impact. So for these places, NWS products count only at the tier that
 * means the event is underway, and news counts only when a headline reports
 * damage, casualties or an area-wide hazard AND names the place.
 */

/** NWS products that mean impact is happening, not forecast. */
const NWS_IMPACT =
  /\b(tsunami warning|tornado emergency|flash flood emergency|evacuation immediate|evacuation order|civil danger warning|civil emergency message|shelter in place warning|hazardous materials warning|radiological hazard warning|nuclear power plant warning|fire warning|extreme wind warning|local area emergency)\b/i;

/** Hazards that are impact by definition. Alone, from a headline. */
const IMPACT_HAZARD =
  /\b(evacuat(?:ion|ions|ed|ing)\b(?! drill| plan| route| map)|shelter[- ]in[- ]place|boil[- ]water|chemical (?:spill|leak|release|plume)|gas leak|hazmat|explosion|explodes?\b|building collapse|bridge collapse|derail(?:s|ed|ment)|active shooter|mass shooting|mass casualt\w*|tsunami|landslide|mudslide|dam (?:fails?|failure|breach)|levee (?:fails?|failure|breach)|sinkhole swallows|state of emergency|death toll|(?:\d+|two|three|four|five|six|seven|eight|nine|ten|dozens?|several|multiple) (?:people |residents |students )?(?:dead|killed|injured|hospitali[sz]ed|missing)\b|kills (?:\d+|two|three|four|five|several|multiple|dozens))/i;

/** Events that are impact only when a damage word rides along. */
const IMPACT_EVENT = /\b(wildfire|brush ?fire|grass fire|tornado|earthquake|quake|flash flood(?:ing)?|flooding|storm surge|hurricane|typhoon|blizzard|ice storm|derecho|microburst|power outage|water main|structure fire|apartment fire|house fire)\b/i;
const IMPACT_DAMAGE =
  /\b(damag\w*|destroy\w*|injur\w*|killed|dead|deaths?|fatal\w*|homes|structures|rescue[sd]?|evacuat\w*|acres|collapse\w*|magnitude [5-9]|thousands without|without power|swept away|trapped|missing|hospital\w*)\b/i;

/** Headlines that use the words above without anything happening. */
const IMPACT_EXCLUDE =
  /\b(drill|preparedness|prepare[sd]? for|readiness|anniversary|years? (?:after|since|ago)|remember\w*|simulat\w*|exercise|lawsuit|sues?\b|study|report finds|survey|op-ed|opinion|editorial|column|podcast|recap|explainer|how to|what to know|guide|history|museum|documentary|film|movie|book|game|season|playoff|training|mock)\b/i;

const PLACE_MATCH = new Map();
/** Compile once; the same regex runs against every item every hour. */
function placeMatcher(item) {
  if (!item.place_match) return null;
  let re = PLACE_MATCH.get(item.place_match);
  if (!re) {
    re = new RegExp(item.place_match, 'i');
    PLACE_MATCH.set(item.place_match, re);
  }
  return re;
}

/**
 * Impact score for an item from a people-place feed, or 0. Exported so the
 * regression tests can pin real headlines to it.
 */
export function impactScore(item) {
  const title = item.title ?? '';
  const text = `${title} ${item.snippet ?? ''}`;

  // A quake candidate is synthesized by src/quakes.js only when it already
  // clears the distance/magnitude bar; nothing else to check.
  if (item.quake) return 85;

  // The place has to be named. A metro feed reports on the whole metro.
  const re = placeMatcher(item);
  if (re && !re.test(text)) return 0;

  if (item.lean === 'primary') {
    // NWS: the product name is the whole signal, and only the impact tier.
    return NWS_IMPACT.test(title) ? 80 : 0;
  }

  if (IMPACT_EXCLUDE.test(title)) return 0;
  if (IMPACT_HAZARD.test(title)) return 75;
  if (IMPACT_EVENT.test(title) && IMPACT_DAMAGE.test(title)) return 72;
  return 0;
}

/**
 * Rule-based urgency. No model call: alerts must be fast and free, and "is this
 * a tornado warning" does not need a language model. Returns 0-100.
 */
export function urgencyScore(item) {
  if (item.track === 'people') return impactScore(item);

  // Weather products name the event in the title; wire stories bury "nuclear"
  // and "invasion" in their snippets constantly. Event words count from the
  // title only for news; NWS titles carry the event name anyway.
  const title = item.title ?? '';
  const text = `${title} ${item.snippet ?? ''}`;

  // An alert REQUIRES an actual urgent event. The boosts below are modifiers,
  // never grounds on their own — without this gate, a routine local item from a
  // primary source scored 70 on locality and freshness alone and would have been
  // emailed as "Breaking". Nothing destroys an alert channel faster.
  const severe = SEVERE_WEATHER.test(text);
  const referenced = SCHEDULING_NEWS.test(title) && !IMPACT_HAZARD.test(title);
  const major = MAJOR.test(title) && !FOLLOW_UP.test(title) && !referenced;
  const notable = !major && NOTABLE.test(title) && !FOLLOW_UP.test(title) && !referenced;
  if (!severe && !major && !notable) return 0;

  let score = 0;
  if (severe) score += 60;
  if (major) score += 70;
  if (notable) score += 55;

  // A weather warning in your own county matters more than one four states away.
  if (LOCAL_TRACKS.has(item.track)) score += 25;
  if (item.track === 'home_local') score += 10;

  // Primary sources (NWS, USGS, FDA, CDC, Fed) are stating facts, not framing.
  if (item.lean === 'primary') score += 15;
  if (item.tier === 1) score += 5;

  // Freshness ranks qualifiers against each other; it never lifts an item
  // over the bar. Before this, any fresh tier-1 wire story with a pattern hit
  // scored 55 + 5 + 15 = 75 and went out as Breaking.
  if (score >= URGENCY_THRESHOLD) {
    const ageMin = (Date.now() - item.published_at) / 60000;
    if (ageMin <= 60) score += 15;
    else if (ageMin <= 180) score += 5;
  }

  return Math.min(100, score);
}

/** Below this, it waits for the morning brief. */
export const URGENCY_THRESHOLD = 70;

/**
 * Picks what to alert on, given fresh candidates and the alert history.
 * Returns [] on any quiet hour, which is the overwhelmingly common case.
 */
export function selectAlerts(candidates, history, { log }) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const sentToday = (history.alerts ?? []).filter((a) => a.day === todayKey);
  if (sentToday.length >= MAX_ALERTS_PER_DAY) {
    log(`alert cap reached for today (${sentToday.length}/${MAX_ALERTS_PER_DAY})`);
    return [];
  }

  const alreadyAlerted = new Set((history.alerts ?? []).map((a) => a.key));
  // An event already covered in a morning brief is not breaking news.
  const alreadyBriefed = new Set(history.entries.map((e) => e.event_key));

  const scored = candidates
    .filter((c) => !REQUIRE_ALERT_FEED || c.alert)
    .map((c) => ({ ...c, urgency: urgencyScore(c) }))
    .filter((c) => c.urgency >= URGENCY_THRESHOLD)
    .filter((c) => !alreadyAlerted.has(alertKey(c)) && !alreadyBriefed.has(alertKey(c)))
    .sort((a, b) => b.urgency - a.urgency);

  const room = MAX_ALERTS_PER_DAY - sentToday.length;
  const picked = dedupeByKey(scored).slice(0, room);

  if (picked.length) {
    log(`ALERT: ${picked.length} item(s) cleared the urgency bar`);
    for (const a of picked) log(`  [${a.urgency}] ${a.title.slice(0, 80)}`);
  } else {
    log('no alert-worthy items this hour');
  }
  return picked;
}

/** Stable key for an alert, so the same warning is never sent twice. */
export function alertKey(item) {
  return `alert:${(item.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('-')}`;
}

function dedupeByKey(items) {
  const seen = new Set();
  return items.filter((i) => {
    const k = alertKey(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const safeUrl = (u) => {
  try {
    const p = new URL(String(u));
    return ['http:', 'https:'].includes(p.protocol) ? p.toString() : null;
  } catch {
    return null;
  }
};

/** Deliberately plain. An alert is read on a phone in three seconds. */
export function renderAlert(items, { tz }) {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date());

  const rows = items
    .map((i) => {
      const url = safeUrl(i.url);
      const title = url
        ? `<a href="${esc(url)}" style="color:#b3261e;text-decoration:none;">${esc(i.title)}</a>`
        : esc(i.title);
      const snippet = (i.snippet ?? '').slice(0, 320);
      const near = i.place_people
        ? `<div style="font-size:13px;font-weight:650;color:#b3261e;margin-bottom:6px;">Near ${esc(i.place_people)} — ${esc(i.place_name ?? '')}</div>`
        : '';
      return `<tr><td style="padding:16px 22px;border-bottom:1px solid #eee;">
        ${near}
        <div style="font-size:17px;font-weight:650;line-height:1.35;">${title}</div>
        <div style="font-size:12px;color:#8a8a8a;margin-top:4px;">${esc(i.source)}</div>
        ${snippet ? `<div style="font-size:14px;line-height:1.55;color:#333;margin-top:8px;">${esc(snippet)}</div>` : ''}
      </td></tr>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Brief Alert</title></head>
<body style="margin:0;background:#f4f4f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:18px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<tr><td style="padding:18px 22px;background:#b3261e;">
  <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#ffd9d6;">Breaking</div>
  <div style="font-size:18px;font-weight:700;color:#fff;margin-top:3px;">${esc(time)}</div>
</td></tr>
${rows}
<tr><td style="padding:14px 22px;background:#fafaf8;">
  <div style="font-size:11px;color:#9a9a9a;line-height:1.6;">
    Sent because this cleared the urgency threshold. Capped at ${MAX_ALERTS_PER_DAY} alerts a day.
    Everything else waits for the 6:30 AM brief.
  </div>
</td></tr>
</table></td></tr></table></body></html>`;
}

export function renderAlertText(items) {
  return items
    .map((i) => `${i.place_people ? `Near ${i.place_people} — ${i.place_name}\n` : ''}${i.title}\n${i.source}\n${(i.snippet ?? '').slice(0, 300)}\n${i.url}`)
    .join('\n\n---\n\n');
}
