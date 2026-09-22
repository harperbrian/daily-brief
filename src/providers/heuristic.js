/**
 * Rule-based provider — the $0-forever floor, and the automatic fallback when a
 * model provider fails mid-run. No network, no keys, cannot fail.
 *
 * What you give up without a model: dimensions are keyword-deep rather than
 * understood, event_keys are title fingerprints rather than semantic (so two
 * differently-worded headlines about one event may not merge), and thread
 * continuation is never detected. The structure — curation, dedupe, budgets,
 * quotas, reserved slots, history — is unchanged, and that structure is most of
 * the value.
 *
 * Track priors come from config/preferences.json rather than being hardcoded
 * here, so the $0 path is config-driven like the rest of the pipeline.
 */
import { titleFingerprint } from '../normalize.js';

export const name = 'heuristic';
export const label = 'rule-based (no model, $0)';
export const concurrency = 8;

/** Keyword evidence per relevance dimension. Deliberately readable over clever. */
const SIGNALS = {
  financial_impact: /\b(tax(es|ed|ation)?|tariff|inflation|interest rates?|federal reserve|rate (cut|hike|decision)|price increase|cost of living|wages?|salary|fees?|refund|rebate|subsid(y|ies)|premium|deductible|recession|layoffs?|unemployment)\b/i,
  career_impact: /\b(layoffs?|hiring|job (market|cuts|openings)|salary|compensation|remote work|return to office|saas|enterprise software|customer success|solution architect|implementation|professional services|workforce|reskilling|automation replac\w*|headcount)\b/i,
  investment: /\b(earnings|revenue|guidance|valuation|market cap|acquisition|merger|ipo|antitrust|balance sheet|margin|competitive position|market share|capital allocation|buyback|dividend|bankruptc\w*)\b/i,
  decision_change: /\b(deadline|effective (date|immediately)|takes effect|enroll\w*|apply by|expires?|vote|ballot|recall|closure|road clos\w*|permit required|must file|register by|last day|cutoff)\b/i,
  business_opportunity: /\b(small business|smb|franchise|acquisition of|owner-operator|recurring revenue|consulting|freelance|contractor|startup cost|customer acquisition|pricing (model|strategy)|margin|bootstrap\w*)\b/i,
  property: /\b(short.?term rental|str\b|vacation rental|lodging tax|occupancy|zoning|licen[cs]\w*|property (tax|value)|hoa|homeowners? association|insurance (cost|premium)|wildfire|flood zone)\b/i,
  home_purchase: /\b(mortgage|home price|housing (market|supply|inventory|starts)|first.?time buyer|down payment|closing costs|homeowners insurance|property tax|refinanc\w*|treasury yield|affordability|rent vs buy)\b/i,
  magnitude: /\b(war|invasion|ceasefire|nuclear|state of emergency|mass casualt\w*|supreme court|federal reserve|shutdown|indict\w*|verdict|pandemic|magnitude [6-9]|evacuat\w*|coup)\b/i,
};

const OPINION = /\b(opinion|op-ed|editorial|column(?:ist)?|commentary|letters to)\b/i;
const FILLER = /\b(remodel|renovation|grand opening|ribbon.?cutting|now open|nearing completion|groundbreaking|celebrates? \d+ years|anniversary|fundraiser|bake sale|book sale|craft fair|parade|festival|blotter|obituar\w*|honor roll|dean's list|named .{0,30}of the (month|year)|employee of the|citizen of the|scholarship (winner|recipient)|ranks? among the best|named to the .{0,20}list)\b/i;
const HYPE = /\b(game.?chang\w*|revolutionar\w*|breakthrough|will replace|the end of|you won't believe|shocking|insane|mind.?blowing|everything you need to know)\b/i;
const PRESS_RELEASE = /\b(announces?|announced|unveils?|introduces?|is proud to|today released)\b/i;

const PROPOSED = /\b(propos\w*|draft|introduc\w*|considering|floated|would (require|allow|ban)|bill\b|first reading)\b/i;
const PENDING = /\b(will take effect|scheduled|upcoming|set for|final vote|expected (to|in)|beginning (in|on)|starts? (in|on)|deadline)\b/i;

/**
 * Place names that mean "right where you live", which the geographic dimension
 * rewards most. Read from preferences.heuristic_priors.hyperlocal_terms so the
 * fallback provider is configured in the same file as everything else; the
 * default below only exists so the tests run without config.
 */
const DEFAULT_HYPERLOCAL = ['madison', 'dane county'];
const termsRegex = (terms) => new RegExp(`\\b(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

/**
 * Same idea for the rental property: local names, the resort or attraction
 * that drives demand, the road that reaches it. Extends the generic property
 * signals above, which cover regulation, taxes, insurance and HOAs anywhere.
 */

const DEFAULT_TRACK_CATEGORY = {
  ai: 'ai', finance: 'finance', career: 'career', entrepreneurship: 'entrepreneurship',
  us: 'politics', global: 'politics', home_region: 'politics', home_local: 'politics',
  property_local: 'quality_of_life', health: 'quality_of_life', travel: 'quality_of_life',
  parenting: 'parenting', science_environment: 'ai',
};
const DEFAULT_DIMENSION_CATEGORY = {
  financial_impact: 'finance', investment: 'finance', home_purchase: 'finance',
  property: 'finance', career_impact: 'career', business_opportunity: 'entrepreneurship',
};
const DEFAULT_TRACK_GEOGRAPHY = {
  home_local: 'home_region', home_region: 'home_region',
  property_local: 'property', us: 'us', global: 'global',
};

const GEO_BASE = { home_region: 6, property_area: 8, us: 4, global: 2, not_applicable: 3 };

export async function scoreBatch({ payload, historyKeys, preferences }) {
  const priors = preferences?.heuristic_priors ?? {};
  const trackCategory = priors.track_category ?? DEFAULT_TRACK_CATEGORY;
  const trackGeography = priors.track_geography ?? DEFAULT_TRACK_GEOGRAPHY;
  const HYPERLOCAL = termsRegex(priors.hyperlocal_terms ?? DEFAULT_HYPERLOCAL);
  const PROPERTY_LOCAL = priors.property_terms?.length ? termsRegex(priors.property_terms) : null;

  return payload.map((item) => {
    const text = `${item.title} ${item.snippet ?? ''}`;
    const title = item.title ?? '';
    const event_key = titleFingerprint(title) || item.id;

    const geography = trackGeography[item.track] ?? 'not_applicable';

    // Each dimension: keyword hit in the body is worth less than one in the
    // headline, which is a crude but honest proxy for what a story is actually about.
    const dim = (key) => {
      const re = SIGNALS[key];
      if (!re) return 0;
      const extra = key === 'property' ? PROPERTY_LOCAL : null;
      if (re.test(title) || extra?.test(title)) return 8;
      if (re.test(text) || extra?.test(text)) return 4;
      return 0;
    };

    let geographic = GEO_BASE[geography] ?? 3;
    if (HYPERLOCAL.test(text)) geographic = 10;

    // Category comes from the strongest dimension, falling back to the track. A
    // track is a retrieval budget key, not a reason a story matters — deriving
    // category from it directly made every property-area item 'quality_of_life'.
    const dimCategory = priors.dimension_category ?? DEFAULT_DIMENSION_CATEGORY;
    const scoredDims = Object.keys(SIGNALS)
      .map((k) => [k, dim(k)])
      .filter(([k, v]) => v > 0 && dimCategory[k])
      .sort((a, b) => b[1] - a[1]);
    const category = scoredDims.length
      ? dimCategory[scoredDims[0][0]]
      : (trackCategory[item.track] ?? 'politics');

    const framing_flags = [];
    if (OPINION.test(title)) framing_flags.push('opinion_only');
    if (FILLER.test(title)) framing_flags.push('routine_filler');
    if (HYPE.test(title)) framing_flags.push('hype_without_substance');

    const sourcing_flags = [];
    if (PRESS_RELEASE.test(title) && item.track !== 'us') sourcing_flags.push('press_release');

    const development_stage = PROPOSED.test(text)
      ? 'proposed'
      : PENDING.test(text)
        ? 'pending'
        : 'occurred';

    const include = framing_flags.length === 0;

    return {
      id: item.id,
      event_key,
      // Rule-based matching cannot tell a genuine development from a rehash, so
      // it never claims a thread. Better to lose the delta than to fork a thread.
      continues_thread: null,
      clean_title: title,
      category,
      geography,
      development_stage,

      financial_impact: dim('financial_impact'),
      career_impact: dim('career_impact'),
      investment: dim('investment'),
      decision_change: dim('decision_change'),
      business_opportunity: dim('business_opportunity'),
      property: geography === 'property_area' ? Math.max(5, dim('property')) : dim('property'),
      home_purchase: dim('home_purchase'),
      magnitude: dim('magnitude'),
      geographic,
      novelty: historyKeys?.has(event_key) ? 2 : 8,

      sourcing_flags,
      framing_flags,
      prompt_injection_attempt: false,
      // Honest: without a model nobody has read the study, so health and science
      // evidence is 'unclear', which the renderer surfaces as a visible badge.
      evidence_stage: category === 'quality_of_life' ? 'unclear' : 'not_applicable',
      include_candidate: include,
      why_it_matters: include ? whyFor(category, geography) : '',
    };
  });
}

const WHY = {
  ai: 'On your AI and emerging-technology watchlist.',
  finance: 'Touches markets, rates, or the broader economy.',
  career: 'Relevant to the software industry and your career positioning.',
  entrepreneurship: 'A small-business or entrepreneurial development.',
  politics: 'Policy or regulation with potential practical effect.',
  parenting: 'Relevant to family, schools, or children.',
  quality_of_life: 'On your health, travel, or personal-interest watchlist.',
};
function whyFor(category, geography) {
  if (geography === 'property_area') return 'Could affect the rental property.';
  if (geography === 'home_region') return 'A home-state development that could reach the local area.';
  return WHY[category] ?? 'Matched one of your tracks.';
}

export async function writeDigest({ payload }) {
  return {
    todays_signal:
      'Assembled by fixed rules today; summaries are source excerpts, not an editorial synthesis.',
    sections: payload.map((s) => ({
      section: s.section,
      label: s.label,
      stories: s.stories.map((st) => ({
        feedback_id: st.event_key,
        headline: st.title,
        category: st.category,
        summary: excerpt(st.snippet, st.title, st.source),
        why_it_matters: st.triage_note || 'Matched your interests by rule.',
        whats_new: '',
        thread_state: '',
        primary_url: st.primary_url,
        supporting_urls: st.supporting_urls ?? [],
        // 'Likely' rather than 'Certain': no editorial cross-checking happened.
        confidence: 'Likely',
        action: 'NONE',
        action_reason: '',
        time_horizon: 'Months',
        evidence_stage: st.evidence_stage ?? 'not_applicable',
      })),
    })),
  };
}

function excerpt(snippet, title, source) {
  const s = (snippet ?? '').trim();
  if (s.length < 40) return `${source} reports: ${title}. Open the link for the full story.`;
  const words = s.split(/\s+/);
  if (words.length <= 75) return s;
  return words.slice(0, 75).join(' ').replace(/[,;:]$/, '') + ' …';
}
