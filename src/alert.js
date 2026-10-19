/**
 * Breaking-news path. Runs hourly during waking hours and stays SILENT unless
 * something genuinely urgent has appeared since the last check.
 *
 * The design constraint is trust: an alert channel that cries wolf gets muted
 * within a week and then never delivers the one that mattered. So the bar is
 * deliberately far higher than the daily brief's, it is rule-based (fast, free,
 * predictable), and it is hard-capped per day.
 */
import { canonicalUrl, stripHtml, titleFingerprint } from './normalize.js';

/** Only these feeds can trigger an alert — see `alert: true` in config/feeds.json. */
const REQUIRE_ALERT_FEED = true;

/** Never send more than this many alerts in one day, no matter what. */
export const MAX_ALERTS_PER_DAY = 3;

const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;

// ── How far back a check looks ──────────────────────────────────────────────

const MIN_WINDOW_H = 2;
const MAX_WINDOW_H = 18;
/** Feeds post late: an item stamped 10:58 can first appear at 11:10. */
const OVERLAP_H = 1;

/**
 * Hours this check looks back. The window starts at the last check that
 * finished cleanly, less an hour of overlap, so a run GitHub never started or
 * a send that failed loses nothing: the next run covers its window as well.
 * The old fixed two-hour window lost every item outside it, and GitHub fires
 * roughly one hourly cron in five (gaps of 3 to 18 hours were seen).
 *
 * No record (first run, evicted cache) or a timestamp from the future gives
 * the old two hours. Anything past 18 hours is clamped: that covers the
 * overnight gap with room to spare, and older news is not breaking. Reading
 * the overlap twice is harmless because sent alerts are deduped by key.
 */
export function alertWindowHours(lastCheckMs, nowMs = Date.now()) {
  if (!Number.isFinite(lastCheckMs) || lastCheckMs > nowMs) return MIN_WINDOW_H;
  const hours = (nowMs - lastCheckMs) / HOUR_MS + OVERLAP_H;
  return Math.min(MAX_WINDOW_H, Math.max(MIN_WINDOW_H, hours));
}

/** The owner's calendar day, which is what the daily cap counts. */
export function alertDay(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
}

// ── Home and world ──────────────────────────────────────────────────────────

/** Weather alerts worth waking up for. NWS publishes far more than these. */
const SEVERE_WEATHER =
  /\b(tornado warning|flash flood warning|blizzard warning|ice storm warning|hurricane warning|evacuation|extreme wind warning|severe thunderstorm warning)\b/i;

/**
 * NWS posts cancellations under the product's own name ("The Tornado Warning
 * has been cancelled."). The old title key happened to swallow repeats of
 * these; with NWS keyed by message id, each would be its own alert.
 */
const NWS_CANCELLED =
  /\b(?:has been|is|was) cancell?ed\b|\b(?:has|have) expired\b|\bwill (?:be allowed to )?expire\b|\bno longer in effect\b/i;

/**
 * Events that are major anywhere on Earth.
 * Earthquakes are NOT here: an M7.7 off Panama (2026-10-09) alerted though it
 * touched no one the reader knows. A quake alerts only through src/quakes.js, when
 * it is near a place in config/people.json; otherwise it waits for the brief.
 * "nuclear" alone is NOT here: on 2026-09-20 it matched a Reuters exclusive
 * about an Iran policy document and a North Korea missile test, neither of
 * which is an attack. The word has to be attached to one. Likewise a missile
 * strike counts when it lands on US territory — "missile attack rattles
 * historic region" is a daily headline from two wars and a travel advisory,
 * not a reason to interrupt the morning.
 *
 * Each has a name so two feeds can be checked for the same kind of event.
 */
const MAJOR_EVENTS = [
  ['mass-casualty', /\bmass casualt\w*/i],
  ['assassination', /\bassassinat\w*/i],
  ['coup', /\bcoup\b/i],
  ['nuclear', /\bnuclear (?:attack|strike|explosion|detonation|meltdown)/i],
  ['missile-us', /\b(?:missiles?|drones?) (?:strikes?|hits?|attacks?) (?:on |against )?(?:the )?(?:u\.?s\.?\b|united states|american soil|guam|hawaii|alaska)/i],
  ['war', /\bdeclares war\b/i],
  ['invasion', /\b(?:invades?\b|invasion of)/i],
  ['dam', /\bdam (?:failure|breach)/i],
];

/**
 * The same words about something that did not happen, or happened long ago.
 * From the 2026-10 review: "character assassination", "could invade a NATO
 * country", "mass casualty drill", "How the ... assassination reshaped",
 * "... dam failure: five years later". Figurative uses with no tell ("Bird
 * flu invades dairy herds", "Hollywood coup") are left to the two-feed rule
 * in majorCorroboration.
 */
const MAJOR_NOT_EVENT =
  /\bcharacter assassination\b|\b(?:drills?|exercises?|simulat\w*|war ?games?|tabletop|rehears\w*|scenario|plot(?:s|ted|ting)?|(?:years?|decades?) later)\b|^\s*how\b/i;
/** Hypotheticals. Only before the event word: "coup, and the army could..." is still a coup. */
const MAJOR_HYPOTHETICAL = /\b(?:could|would|might|threaten(?:s|ed|ing)? to|vows? to)\b/i;

/**
 * Coverage of a major event long after it happened: trials, suspects, plea
 * deals, anniversaries. "Suspects in Haitian president's assassination
 * transferred to Miami" cleared the bar on 2026-09-21 for a 2021 killing.
 *
 * Words that always mean "later" suppress anywhere in the title. Words a
 * breaking story uses too ("killed in apparent assassination; suspect at
 * large", "announce coup, president under house arrest") suppress only when
 * they come first, as in "Suspects in ... assassination".
 */
const FOLLOW_UP_ALWAYS =
  /\b(trial|sentenc\w*|convict\w*|indict\w*|plea|pleads?|extradit\w*|arraign\w*|verdict|jury|anniversary|years? (?:after|since|ago)|inquiry|report on|documentary|memoir|book)\b/i;
const FOLLOW_UP_BEFORE = /\b(suspects?|charged|charges|arrest\w*|investigat\w*|probe|transferred|accused|detained)\b/i;

function isFollowUp(title, eventIndex) {
  if (FOLLOW_UP_ALWAYS.test(title)) return true;
  const m = FOLLOW_UP_BEFORE.exec(title);
  return !!m && m.index < eventIndex;
}

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
const SCHEDULING_LIFT =
  /\b(evacuat(?:ion|ions|ed|ing)\b|shelter[- ]in[- ]place|chemical (?:spill|leak|release|plume)|gas leak|hazmat|explosion|explodes?\b|building collapse|bridge collapse|derail(?:s|ed|ment)|active shooter|mass shooting|mass casualt\w*|tsunami|death toll|(?:\d+|two|three|four|five|six|seven|eight|nine|ten|dozens?|several|multiple) (?:people |residents |students )?(?:dead|killed|injured|hospitali[sz]ed|missing)\b|kills (?:\d+|two|three|four|five|several|multiple|dozens))/i;

const isReferenced = (title) => SCHEDULING_NEWS.test(title) && !SCHEDULING_LIFT.test(title);

/**
 * The world event a headline reports, or null. Title only: wire snippets
 * mention "invasion" and "nuclear" constantly.
 */
function majorEvent(title) {
  let hit = null;
  for (const [name, re] of MAJOR_EVENTS) {
    const m = re.exec(title);
    if (m && (!hit || m.index < hit.index)) hit = { name, index: m.index };
  }
  if (!hit) return null;
  if (MAJOR_NOT_EVENT.test(title)) return null;
  const hypothetical = MAJOR_HYPOTHETICAL.exec(title);
  if (hypothetical && hypothetical.index < hit.index) return null;
  if (isFollowUp(title, hit.index) || isReferenced(title)) return null;
  return hit;
}

/**
 * For each kind of world event, the feeds with a headline reporting one right
 * now. A news item that qualifies only on a world-event word needs two feeds
 * to agree: rhetoric ("Hollywood coup", "Bird flu invades ...") is one
 * writer's phrase, while an assassination is on every wire within the hour.
 * Counts feeds, not items, so one outlet's three headlines are one outlet.
 * Primary sources (USGS, NWS) do not need this.
 */
export function majorCorroboration(candidates) {
  const feeds = new Map();
  for (const c of candidates) {
    if (c.track === 'people') continue;
    const ev = majorEvent(c.title ?? '');
    if (!ev) continue;
    if (!feeds.has(ev.name)) feeds.set(ev.name, new Set());
    feeds.get(ev.name).add(c.feed_id ?? c.source ?? c.url);
  }
  return feeds;
}

function awaitingCorroboration(item, corroboration) {
  if (item.track === 'people' || item.lean === 'primary') return false;
  const ev = majorEvent(item.title ?? '');
  return !!ev && (corroboration.get(ev.name)?.size ?? 0) < 2;
}

/**
 * Events that matter when they are close to home or come from a primary
 * source, and are routine national noise otherwise (a governor declares a
 * state of emergency somewhere most weeks; a plane crashes somewhere most
 * months). Base score leaves them 15 short of the bar; locality or a primary
 * source closes the gap, a wire story's freshness does not.
 */
const NOTABLE =
  /\b(state of emergency|emergency rate (?:cut|decision)|recall(?:s|ed)? .{0,30}(?:infant|baby|child|children)|nationwide recall|plane crash|derailment)\b/i;

function notableEvent(title) {
  const m = NOTABLE.exec(title);
  return !!m && !isFollowUp(title, m.index) && !isReferenced(title);
}

/** Locality is what makes an alert actionable rather than merely dramatic. */
const LOCAL_TRACKS = new Set(['home_local', 'home_region', 'property_local']);

/*
 * ── Friends and family (config/people.json) ────────────────────────────────
 * A different question than home: not "is there a warning" but "could this
 * have hit them". The bar is hazards that can reach the WHOLE area (a
 * hurricane, a city-wide boil-water notice, a quake), never a single-site
 * incident. A building fire or collapse, a shooting, a crash or an explosion
 * is news about someone else's street, not a reason to text a friend who
 * lives across town. So: NWS products at the tier that means the event is
 * underway (plus hurricane/typhoon/storm-surge warnings), and news only when
 * the headline names the place AND reports an area-wide hazard.
 */

/** NWS products that mean impact is happening, not forecast. */
const NWS_IMPACT =
  /\b(hurricane warning|typhoon warning|storm surge warning|tsunami warning|tornado emergency|flash flood emergency|evacuation immediate|evacuation order|civil danger warning|civil emergency message|shelter in place warning|hazardous materials warning|radiological hazard warning|nuclear power plant warning|fire warning|extreme wind warning|local area emergency)\b/i;
/**
 * NWS upgrades a Tornado or Flash Flood Warning to an Emergency inside the
 * warning text. The product title still says "Warning".
 */
const NWS_EMERGENCY_IN_TEXT = /\b(?:tornado emergency|flash flood emergency)\b/i;

const IMPACT_DAMAGE =
  /\b(damag\w*|destroy\w*|injur\w*|killed|dead|deaths?|fatal\w*|homes|structures|rescue[sd]?|acres|collapse\w*|magnitude [5-9]|thousands without|without power|swept away|trapped|missing|hospital\w*)\b/i;

/**
 * Headlines that use the words above without anything happening. Kept
 * narrow: bare "season", "training", "history" and "what to know" hid
 * "fire season", "training range explosion injures 4", "largest wildfire in
 * state history" and "what to know about evacuations ordered tonight".
 */
const IMPACT_EXCLUDE =
  /\b(drill|preparedness|prepare[sd]? for|readiness|anniversary|years? (?:after|since|ago)|remember\w*|simulat\w*|exercise|lawsuit|sues?|study|report finds|survey|op-ed|opinion|editorial|column|podcast|recap|explainer|how to|guide|museum|documentary|film|movie|book|game|playoff|mock|after[- ]action|lessons learned|long[- ]awaited|botched|season (?:premiere|finale|opener)|training (?:session|course|class|camp))\b|(?<!\bin (?:[\w'-]+ )?)\bhistory\b/i;

const EVACUATION_REPORT =
  /\b(report|after[- ]action|review (?:of|finds|found|faults)|audit|lessons|botched|criticized|criticism|probe|inquiry|lawsuit|investigation (?:into|finds|found|identifies))\b/i;
/** After "evacuation": the levels before an order, and the end of one. */
const EVACUATION_NOT_ORDER =
  /^\s+(?:orders?\s+)?(?:warnings?|watch(?:es)?|advisor(?:y|ies)|ready|set|drills?|plans?|routes?|maps?|lifted|rescinded|ended|canceled|cancelled|downgraded)\b/i;

/**
 * True when a headline says people are being moved out now. An evacuation
 * warning ("be ready") is a warning, and an after-action report about an old
 * evacuation is a report.
 */
function evacuationUnderway(title) {
  if (EVACUATION_REPORT.test(title)) return false;
  if (/\b(?:upgraded|elevated) to (?:an? )?(?:evacuation )?orders?\b|\bmandatory evacuat\w*|\bordered to evacuate\b/i.test(title)) return true;
  for (const m of title.matchAll(/\bevacuat\w*/gi)) {
    if (!EVACUATION_NOT_ORDER.test(title.slice(m.index + m[0].length))) return true;
  }
  return false;
}

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

  // A quake candidate is synthesized by src/quakes.js only when it already
  // clears the distance/magnitude bar; nothing else to check.
  if (item.quake) return 85;

  if (item.lean === 'primary') {
    // NWS: the feed URL is already scoped to the place's zones, and the title
    // names the issuing office or tsunami center, never the town. Requiring
    // the place name here returned 0 for every tsunami warning.
    if (NWS_CANCELLED.test(title)) return 0;
    return NWS_IMPACT.test(title) || NWS_EMERGENCY_IN_TEXT.test(item.snippet ?? '') ? 80 : 0;
  }

  // News: the headline has to name the place. A metro feed covers the whole
  // metro, and a snippet that mentions the city let through a drive-by that
  // happened elsewhere.
  const re = placeMatcher(item);
  if (re && !re.test(title)) return 0;

  if (IMPACT_EXCLUDE.test(title)) return 0;
  if (AREA_HAZARD.test(title)) return 75;
  if (AREA_EVENT.test(title) && (IMPACT_DAMAGE.test(title) || evacuationUnderway(title))) return 72;
  if (WIDE_OUTAGE.test(title)) return 72;
  if (AREA_EVACUATION.test(title) && evacuationUnderway(title)) return 72;
  return 0;
}

/** Hazards that reach a whole city or county by their nature. */
const AREA_HAZARD =
  /\b(shelter[- ]in[- ]place|boil[- ]water|tsunami|dam (?:fails?|failure|breach\w*)|levee (?:fails?|failure|breach\w*)|state of (?:local )?emergency|(?:hurricane|typhoon|tropical storm) \w+ (?:makes? landfall|slams|batters|pounds|hits)|(?:hurricane|typhoon|tropical storm)[- ]force)\b/i;
/** Area-scale events: they count with a damage word or an evacuation under way. */
const AREA_EVENT =
  /\b(wildfires?|brush ?fires?|grass fires?|tornado(?:es)?|earthquake|quake|flash flood(?:ing)?|flooding|floods?|storm surge|hurricane|tropical storm|typhoon|blizzard|ice storm|derecho|wind ?storm|landslides?|mudslides?)\b/i;
/** Thousands without power is area-wide whatever caused it. */
const WIDE_OUTAGE =
  /\b(?:\d{1,3}(?:,\d{3})+|\d+k|thousands|tens of thousands|hundreds of thousands)\s+(?:[a-z]+\s+){0,2}without (?:power|electricity|water)\b/i;
/** An evacuation of an area (orders, zones, neighborhoods), not of one building. */
const AREA_EVACUATION =
  /\b(mandatory evacuat\w*|evacuation (?:orders?|zones?)|ordered to evacuate|neighborhoods? (?:evacuated|ordered)|county[- ]wide|city[- ]wide)\b/i;

/**
 * Rule-based urgency. No model call: alerts must be fast and free, and "is this
 * a tornado warning" does not need a language model. Returns 0-100.
 *
 * `corroboration` comes from majorCorroboration() over the whole batch;
 * without it a news item cannot qualify on a world-event word alone.
 */
export function urgencyScore(item, { corroboration, now = Date.now() } = {}) {
  if (item.track === 'people') return impactScore(item);

  // Weather products name the event in the title; wire stories bury "nuclear"
  // and "invasion" in their snippets constantly. Event words count from the
  // title only for news; NWS titles carry the event name anyway.
  const title = item.title ?? '';
  const text = `${title} ${item.snippet ?? ''}`;
  const primary = item.lean === 'primary';
  if (primary && NWS_CANCELLED.test(title)) return 0;

  // An alert REQUIRES an actual urgent event. The boosts below are modifiers,
  // never grounds on their own — without this gate, a routine local item from a
  // primary source scored 70 on locality and freshness alone and would have been
  // emailed as "Breaking". Nothing destroys an alert channel faster.
  const severe = SEVERE_WEATHER.test(text);
  const event = majorEvent(title);
  // A world-event word from a news feed counts only once a second feed
  // reports the same kind of event (majorCorroboration).
  const major = !!event && (primary || (corroboration?.get(event.name)?.size ?? 0) >= 2);
  const notable = !event && notableEvent(title);
  if (!severe && !major && !notable) return 0;

  let score = 0;
  if (severe) score += 60;
  if (major) score += 70;
  if (notable) score += 55;

  // A weather warning in your own county matters more than one four states away.
  if (LOCAL_TRACKS.has(item.track)) score += 25;
  if (item.track === 'home_local') score += 10;

  // Primary sources (NWS, USGS, FDA, CDC, Fed) are stating facts, not framing.
  if (primary) score += 15;
  if (item.tier === 1) score += 5;

  // Freshness ranks qualifiers against each other; it never lifts an item
  // over the bar. Before this, any fresh tier-1 wire story with a pattern hit
  // scored 55 + 5 + 15 = 75 and went out as Breaking.
  if (score >= URGENCY_THRESHOLD) {
    const ageMin = (now - item.published_at) / 60000;
    if (ageMin <= 60) score += 15;
    else if (ageMin <= 180) score += 5;
  }

  return Math.min(100, score);
}

/** Below this, it waits for the morning brief. */
export const URGENCY_THRESHOLD = 70;

// ── One event, one alert ────────────────────────────────────────────────────

/** Rough hazard kind, so three headlines about one fire are one alert. */
const HAZARD_CLASSES = [
  ['tsunami', /\btsunami/i],
  ['quake', /\b(?:earthquake|quake)/i],
  ['tornado', /\btornado/i],
  ['violence', /\b(?:shoot\w*|shot|gunman|gunfire|drive-by|stabb\w*)\b/i],
  ['flood', /\b(?:flood\w*|dam (?:fails?|failure|breach)|levee|boil[- ]water|water main|mudslide|landslide|storm surge)\b/i],
  ['fire', /\b(?:wildfire|brush ?fire|fires?|blaze|burn\w*)\b/i],
  ['storm', /\b(?:hurricane|typhoon|blizzard|ice storm|derecho|microburst|extreme wind|power outage|without power)\b/i],
  ['hazmat', /\b(?:chemical|gas leak|hazmat|hazardous materials|shelter[- ]in[- ]place|radiological|nuclear power plant|carbon monoxide|explosions?|blast)\b/i],
  ['collapse', /\bcollapse/i],
  ['transport', /\b(?:derail\w*|crash\w*|collision|plane)\b/i],
  ['evacuation', /\bevacuat/i],
];

function hazardClass(text) {
  return HAZARD_CLASSES.find(([, re]) => re.test(text))?.[0] ?? null;
}

const NWS_TITLE = /^(.+?) issued (.+?) by NWS\b/i;
/** "Tornado Warning issued <when> until <end> by NWS <office>" → its parts. */
function nwsProduct(item) {
  if (item.lean !== 'primary') return null;
  const m = NWS_TITLE.exec(item.title ?? '');
  if (!m) return null;
  const until = /\buntil (.+)$/i.exec(m[2]);
  return { product: m[1].trim().toLowerCase(), until: until ? until[1].trim().toLowerCase() : '' };
}

/**
 * The event an item is part of, and how long a sent alert for it suppresses
 * the next one. null when there is nothing to group by.
 *  - People: place + hazard kind for a day. One small fire produced three
 *    headlines and would have been three alerts.
 *  - NWS: feed + product + end time. Every update to a warning is a new CAP
 *    message (new URL) with the same "until"; a different warning has a
 *    different end time. Without an end time, a day.
 *  - World events: the kind of event for a day, so the second wire's
 *    headline on the same assassination is not a second alert.
 */
export function alertClass(item) {
  const title = item.title ?? '';
  if (item.track === 'people') {
    const hazard = item.quake ? 'quake' : hazardClass(title);
    if (hazard) return { key: `place:${item.place ?? 'unknown'}:${hazard}`, ms: DAY_MS };
  }
  const nws = nwsProduct(item);
  if (nws) {
    return nws.until
      ? { key: `nws:${item.feed_id}:${nws.product}:${nws.until}`, ms: 14 * DAY_MS }
      : { key: `nws:${item.feed_id}:${nws.product}`, ms: DAY_MS };
  }
  if (item.track !== 'people') {
    const ev = majorEvent(title);
    if (ev) return { key: `major:${ev.name}`, ms: DAY_MS };
  }
  return null;
}

/**
 * Stable identity for an alert, so the same thing is never sent twice.
 *  - Quakes: the USGS event id. A revision (M5.6 to M5.8) is the same quake.
 *  - Primary feeds: the item URL, which for NWS is the CAP message id. The
 *    title ("Tornado Warning issued October 7 at ...") is identical for every
 *    zone's warning that day and blocked all but the first.
 *  - News: the first six title words, so a re-syndicated headline matches.
 * People items carry their place: one item near two people is two alerts.
 */
export function alertKey(item) {
  const at = item.place ? `@${item.place}` : '';
  if (item.quake && item.usgs_id) return `quake:${item.usgs_id}${at}`;
  if (item.lean === 'primary' && item.url) return `url:${canonicalUrl(item.url)}${at}`;
  return `alert:${(item.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('-')}${at}`;
}

/** Outlets rewrite headlines; the URL survives the edit. */
const urlKey = (x) => (x.url ? `${canonicalUrl(x.url)}${x.place ? `@${x.place}` : ''}` : null);

/** What run-alert.js stores in history.alerts for a sent item. */
export function alertRecord(item, { day, now = Date.now() }) {
  return {
    key: alertKey(item),
    url: item.url ? canonicalUrl(item.url) : null,
    place: item.place ?? null,
    cls: alertClass(item)?.key ?? null,
    day,
    at: now,
    title: item.title,
  };
}

/**
 * Collapses exact duplicates (same canonical URL, same place) and nothing
 * else. The daily brief's normalize() also merges by headline fingerprint,
 * which here folded a people-feed item into a wire item with the same
 * headline (losing who lives there) and merged different NWS products issued
 * the same minute (the fingerprint keeps only 8 sorted words).
 */
export function dedupeAlertItems(rawItems, { log } = {}) {
  const byKey = new Map();
  let dupes = 0;
  for (const item of rawItems) {
    const url = canonicalUrl(item.url);
    const key = `${url}@${item.place ?? ''}`;
    const seen = byKey.get(key);
    if (seen) {
      dupes++;
      if (item.alert) seen.alert = true;
      continue;
    }
    byKey.set(key, {
      ...item,
      url,
      title: stripHtml(item.title ?? '').slice(0, 300),
      snippet: stripHtml(item.snippet ?? '').slice(0, 1200),
      lean: item.lean ?? 'center',
      alert: item.alert === true,
    });
  }
  log?.(`alert candidates: ${byKey.size} (dropped ${dupes} same-URL duplicates)`);
  return [...byKey.values()];
}

/**
 * Picks what to alert on, given fresh candidates and the alert history.
 * Returns [] on any quiet hour, which is the overwhelmingly common case.
 * `tz` is the owner's timezone: the cap counts their day, and run-alert.js
 * records each alert's day the same way (alertDay).
 */
export function selectAlerts(candidates, history, { log, tz, now = Date.now() }) {
  if (!tz) throw new Error('selectAlerts needs the owner timezone: the daily cap counts local days');
  const past = history.alerts ?? [];
  const today = alertDay(now, tz);
  const sentToday = past.filter((a) => a.day === today);
  if (sentToday.length >= MAX_ALERTS_PER_DAY) {
    log(`alert cap reached for today (${sentToday.length}/${MAX_ALERTS_PER_DAY})`);
    return [];
  }

  const sentKeys = new Set(past.map((a) => a.key));
  const sentUrls = new Set(past.map(urlKey).filter(Boolean));
  const classSentRecently = (cls) => past.some((a) => a.cls === cls.key && now - (a.at ?? 0) < cls.ms);
  // An event already covered in a morning brief is not breaking news. Brief
  // entries store the story's canonical URL; in rule-based mode their event
  // key is the headline fingerprint.
  const entries = history.entries ?? [];
  const briefUrls = new Set(entries.map((e) => e.url && canonicalUrl(e.url)).filter(Boolean));
  const briefKeys = new Set(
    entries.flatMap((e) => [e.event_key, ...(Date.now() - (e.sent_at ?? 0) <= 96 * 3600e3 ? e.aliases ?? [] : [])]).filter(Boolean)
  );

  const eligible = candidates.filter((c) => !REQUIRE_ALERT_FEED || c.alert);
  const corroboration = majorCorroboration(eligible);
  const scored = [];
  for (const c of eligible) {
    const urgency = urgencyScore(c, { corroboration, now });
    if (urgency >= URGENCY_THRESHOLD) scored.push({ ...c, urgency });
    else if (awaitingCorroboration(c, corroboration)) log(`  one feed only, waiting for a second: ${(c.title ?? '').slice(0, 80)}`);
  }
  scored.sort((a, b) => b.urgency - a.urgency);

  const picked = [];
  const taken = new Set();
  for (const c of scored) {
    const key = alertKey(c);
    const url = urlKey(c);
    const cls = alertClass(c);
    let skip = null;
    if (sentKeys.has(key) || (url && sentUrls.has(url))) skip = 'already alerted';
    else if (briefUrls.has(canonicalUrl(c.url ?? '')) || briefKeys.has(titleFingerprint(c.title ?? ''))) skip = 'already in a brief';
    else if (cls && classSentRecently(cls)) skip = `already alerted on this event (${cls.key})`;
    else if (taken.has(key) || (url && taken.has(url)) || (cls && taken.has(cls.key))) skip = 'same event as another item this hour';
    if (skip) {
      log(`  skip [${c.urgency}] ${(c.title ?? '').slice(0, 80)} — ${skip}`);
      continue;
    }
    for (const k of [key, url, cls?.key]) if (k) taken.add(k);
    picked.push(c);
  }

  const room = MAX_ALERTS_PER_DAY - sentToday.length;
  const out = picked.slice(0, room);
  if (out.length) {
    log(`ALERT: ${out.length} item(s) cleared the urgency bar`);
    for (const a of out) log(`  [${a.urgency}] ${a.title.slice(0, 80)}`);
  } else {
    log('no alert-worthy items this hour');
  }
  return out;
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
    Other news waits for the morning brief. Friends-and-family alerts only come here.
  </div>
</td></tr>
</table></td></tr></table></body></html>`;
}

export function renderAlertText(items) {
  return items
    .map((i) => `${i.place_people ? `Near ${i.place_people} — ${i.place_name}\n` : ''}${i.title}\n${i.source}\n${(i.snippet ?? '').slice(0, 300)}\n${i.url}`)
    .join('\n\n---\n\n');
}
