# Daily Brief

A personal intelligence briefing. One email, ~3 AM your time (waiting when you wake), 15 stories.
A story earns its place by whether it could change a decision. Size of the news
does not enter into it. See [docs/PROFILE.md](docs/PROFILE.md) for the profile
it implements, and [docs/CUSTOMIZE.md](docs/CUSTOMIZE.md) to make it yours. The
repo ships configured for a fictional example reader.

Runs on GitHub Actions, started on time by a small Cloudflare Worker (free
plan; see "On-time trigger" below). No server, no n8n, no subscription.
Infrastructure is free, and the model layer can be too. **$0/month total** on a Claude Pro/Max
subscription you already have (via `claude setup-token`), on Gemini's free tier,
or with no model at all. The Anthropic API (~$5-6/month) is the only paid path.
The provider is auto-detected from whichever credential exists, free first.

**→ [docs/SETUP.md](docs/SETUP.md) to get it running.**

## Design principle

Never ask one model to "find and summarize the news." The job is split so each
stage can be tested, and so failures show up instead of passing quietly:

```
retrieve → normalize → prefilter → score → group → select → write → render → send
  65 RSS    dedupe      budget      Haiku   Haiku    code     Sonnet   fixed    SMTP
          + lean balance                    + code                     template
```

Two rules hold the whole thing together:

**Models judge; code decides.** The model returns ten independent relevance
dimensions per story. `src/score.js` computes the total. `src/select.js` picks
the 15. Given the same inputs, selection is identical every time, which is what
makes it debuggable. Ask a model for both the components and their weighted sum
and it gets the arithmetic wrong often enough to corrupt ranking silently.

**Models never emit markup.** The writer returns structured JSON.
`src/render.js` renders it through a fixed template with everything escaped and
non-`http(s)` URLs dropped. A bad generation cannot break the email or inject
anything into it.

## Layout

| Path | What it does |
|---|---|
| `config/feeds.json` | 65 RSS sources across 13 tracks (plus alert-only feeds), lean- and quality-tagged. The local ones are examples |
| `config/preferences.json` | The whole profile: dimensions, weights, allocation, sections, quality tiers |
| `config/search_queries.json` | Domain-scoped regulatory monitoring, for sites with no RSS |
| `config/people.json` | Where friends and family live. Watched hourly for real impact, never warnings |
| `prompts/` | Triage and editorial prompts |
| `schema/` | Structured-output schemas |
| `src/retrieve.js` | Concurrent fetch; one dead feed never stops the run |
| `src/normalize.js` | URL canonicalization, dedupe, per-track budgets |
| `src/history.js` | 14-day event memory + 90-day story threads |
| `src/providers/` | Swappable model layer: claude-code, gemini, anthropic, heuristic |
| `src/score.js` | Triage pass + deterministic total; failed batches rescored by rules |
| `src/select.js` | Cluster, corroborate, allocate, reserve, fill sections |
| `src/write.js` | Editorial pass; output sanitized, URLs restored from selection data |
| `src/render.js` | Fixed HTML template, everything escaped |
| `src/feedback.js` | Eight feedback signals, each routed to its own pipeline stage |
| `src/alert.js` | Urgency rules and alert rendering; impact rules for friends-and-family places |
| `src/quakes.js` | USGS proximity check for the places in `config/people.json` |
| `src/usage.js` | Token accounting (`npm run usage`) |
| `src/report.js` | Usage and tuning reports |
| `src/run-alert.js` | Hourly breaking-news entry point |
| `src/events.js` | One event, one key: groups reports of the same event; code merges on clear evidence |
| `cloudflare/trigger/` | Cloudflare Worker that starts both workflows on time |
| `test/run.mjs` | 363 offline tests (`npm test`), no keys required |
| `state/history.json` | Committed each run. This is the memory |

## How ranking works

Ten relevance dimensions, combined with a **peak-blended weighted mean**:

```
breadth   = Σ wᵢ·dᵢ                                 the weighted average
peak      = max(πᵢ·dᵢ)                              the strongest eligible reason
relevance = 10·(breadth + 0.55·(peak − breadth))
```

A plain weighted sum would break the profile's central requirement. The
dimensions are sparse. Most stories score zero on the property, home purchase,
and career. So a rental-area ordinance scoring 10 on property alone would
get 0.10×10 = 1.0 and lose to a forgettable story scoring 4 across six
dimensions. Under the blend it scores **59 against that story's 36**.

`πᵢ` (peak eligibility) is the second knob. It encodes the anti-engagement rule
as arithmetic rather than prompt English:

| Dimension | weight | π |
|---|---|---|
| financial impact | 0.20 | 1.0 |
| career, investment, decision-change | 0.15 each | 1.0 |
| business opportunity | 0.10 | 0.9 |
| property | 0.10 | 1.0 |
| home purchase | 0.05 | 1.0 |
| magnitude, geography | 0.05 each | **0.3** |
| novelty | 0.05 | **0.0** |

Novelty at 0 and geography at 0.3 mean neither can ever be *grounds* for
inclusion, only a modifier. Nothing is worth reading merely because it is new,
or merely because it happened nearby. At `peak_gain = 0` the whole thing
degenerates to a plain weighted sum, which makes that its own regression test.

**Source quality is deterministic.** It comes from a `source_class` on each of
the 65 feeds rather than a model's opinion. Quality is a property of the outlet,
known at retrieval. The previous design passed the tier *into* the prompt and asked for
credibility back. A cluster takes the best class among its members, so an
aggregator that breaks a story is lifted once a primary source actually
corroborates it. That means a corroborating article arrived. A model guessing
one exists does not count.

**Allocation targets apply at selection, never at scoring.** A percentage is a
property of the set. Applying it per story would make a score depend on which
batch it landed in. The long-run deficit is a bounded ±9 tie-break: enough to
reorder near-ties over weeks, never enough to promote a 40 over a 70.

## How it tries to stay unbiased

Prompting a model to "be balanced" does nothing if the input was one-sided to
begin with. Three mechanisms, all in code:

**Every source carries a `lean` tag.** 65 feeds spanning left, center-left,
center, center-right, right, and `primary` (government, scientific, and legal
records, which are not a "side" and are never traded against the others).

**Budgets are spent across leans, not by volume.** `allocateAcrossLeans()` in
`src/normalize.js` gives each lean bucket an equal share of a track's budget
before recency is considered. On a busy day the US track produces far more
center-left items than right ones. The 65 feeds do not publish at equal rates. A
pure recency sort would hand the scorer a pool that was already one-sided, and
nothing downstream could recover from that.

**Cross-spectrum agreement is rewarded.** When outlets that disagree editorially
report the same event, it is far more likely to be a fact than a framing
exercise. That is the cheapest reliable bias filter available without reading
the articles. Those stories score higher, and the email labels them *Reported
across the spectrum*. It costs nothing to compute. The lead section is also
barred from filling every slot from one side when an alternative exists.

A guard worth naming: adding the source-quality multiplier could have quietly
undone all of this. Six of ten right-leaning feeds are tier-2 versus a much
flatter split on the left, so inheriting `source_class` from `tier` would have
penalized one side twice. It is assigned in a pass that never consults `lean`.
A test asserts the mean multiplier per lean bucket stays within ±0.1. It
currently sits at 0.045.

Two limits remain. The feed list still leans left overall, roughly 2:1 by
volume, because sources were chosen for **factual reliability first and lean
second**. Several right-leaning outlets with weak fact-check records were
excluded. Padding the ledger with them would trade accuracy for symmetry.

Corroboration matching also only works well with a model, which groups events
semantically. Rule-based mode is blunter. Event keys there are lexical, so two
headlines about one event never merge if they are worded differently. The email
suppresses the negative badge in that mode rather than claiming a check it did
not perform.

## Breaking news

A second workflow (`.github/workflows/breaking-alert.yml`) checks fast
primary sources (NWS alerts for your county and the property's, USGS earthquakes,
FDA/CDC recalls, the Fed, and the wires) plus the friends-and-family local feeds. It stays silent unless
something clears a high urgency bar. The check is rule-based, so a quiet hour
costs seconds and zero tokens.

The Cloudflare Worker starts it every hour from 7 AM to 10 PM. GitHub's own
cron (which fires only about one scheduled run in five) is kept as a 3-hourly
backup. Each check looks back to the last run that finished cleanly (2 to 18
hours, with an hour of overlap) instead of a fixed window. A missed run or a failed
send delays an alert; it no longer loses it. A world event reported by a
single wire waits until a second feed carries it, which costs at most a run
and stops one outlet's rhetoric ("character assassination", "could invade")
from going out as Breaking. Earthquakes are not world events: a quake alerts only when it is near
a friends-and-family place (below); anywhere else it waits for the morning brief.

The bar works as a gate rather than a sum. An item must match a severe-weather
or breaking-event pattern before locality and freshness modifiers apply. Without
that gate, a routine local item from a primary source scored exactly at the
threshold and would have been emailed as *Breaking*. Nothing makes an alert
channel worthless faster. Hard-capped at 3 alerts per day, 7 AM to 11 PM local.

### Friends and family

`config/people.json` lists places where people you care about live. The hourly
check watches each one for hazards that can reach the **whole area**, never for
single-site incidents: a hurricane or tropical storm, a tornado, wildfire, flood
or major winter storm with damage or evacuations, a boil-water notice,
shelter-in-place, a tsunami, a state of emergency, a dam or levee failure, a
mandatory or area evacuation order, or thousands without power. A building fire,
collapse, explosion, shooting or crash does not qualify, whatever the count: it
is someone else's street, not a reason to text a friend across town. A news
headline has to come from a local outlet for the place and name the place. Also
qualifying: USGS earthquakes of M5.5+ within 100 miles (or anything USGS itself
rates yellow or worse), and NWS products that mean the event is under way or a
hurricane is coming (tsunami, hurricane, typhoon and storm-surge warnings,
tornado and flash-flood emergencies, shelter in place). The email says who is
there, so you know who to text. These feeds
are `alert_only` and never enter the daily brief.

## One event, one key

The scorer sees candidates in batches of 25, so two outlets' reports of one
event can get two keys and both reach the brief. After scoring, one small call
groups the includable items that report the same occurrence, alongside the
events sent in the last four days. Code merges a group only on clear evidence:
same category and a rare, salient shared word (acronyms count, bare numbers
never do). A match to an earlier send needs a stronger overlap, and the story
then goes out again only on a real stage change. A model-proposed merge removes
the duplicate but never adds outlets, leans or links to the surviving story, so
corroboration still comes only from retrieval facts. At most eight stories are
absorbed per run, and each one is logged. The bias is deliberate: a missed
merge costs a near-duplicate line; a wrong one would hide a story.

## On-time trigger

GitHub's cron is best-effort: the 7 AM brief started a median ~5.5 hours late,
and only ~1 in 5 hourly alert crons fired. A Cloudflare Worker
(`cloudflare/trigger/`, free plan) calls GitHub's `workflow_dispatch` API on
Cloudflare's own scheduler: the brief at 3 AM local, a catch-up at 4 AM only
if no brief run started, and the alert check hourly from 7 AM to 10 PM. Each
dispatch says `scheduled=true`, so the workflows apply the same once-a-day and
waking-hours checks as a cron run, and a duplicate is harmless. GitHub's crons
stay as backups; a brief that arrives from one says so in its footer, which is
how an expired token gets noticed. The Worker has no public URL and holds one
secret: a fine-grained token for this repo only, Actions read/write.

## Why RSS instead of search

Search queries like *"most consequential global news today"* read as prompts
rather than queries, and engines return mush for them. Local search is worse. A
daily keyword sweep for "Madison Wisconsin" surfaces real-estate spam, while the
local station's feed surfaces the township ordinance. 65 curated feeds need no API
key, no quota, and no vendor account that can silently expire.

Tavily remains wired up behind `TAVILY_API_KEY` if a gap shows up. Nothing
requires it.

## Sections

| Section | Slots | Detail | Rule |
|---|---|---|---|
| What Actually Matters Today | 3-5 | full | Highest decision impact, on merit alone |
| Worth Knowing | fills to 15 | one sentence | Reserved slots, then deficit-ranked |
| Things I'm Watching | 0-4 | one line | Unresolved and forthcoming |

Reserved slots keep standing priorities alive on heavy news days: 1-2 for
quality-of-life (health, relationships, travel), 1-2 for home-region/local,
up to 1 for the property. A daily ceiling caps any one category at 6 of 15.

Fewer than 15 is normal and intended. There is no backfill. If a category has
nothing worth sending, the brief is shorter.

**Things I'm Watching routes on development stage, not on Action.** A story
belongs there because it is unresolved and forthcoming (a proposed rule, a
pending vote), which the scorer can judge from a headline. Action is a
recommendation the writer makes afterward, so a Watching story can carry
`RESEARCH` and a lead story can carry `NONE`.

## Model providers and the fallback ladder

The model layer is an adapter (`src/providers/`). Providers form a **cascade**
rather than a single choice. Set several, and each becomes a fallback for the
one before it:

```
CLAUDE_CODE_OAUTH_TOKEN → claude-code   $0 extra on a Claude Pro/Max subscription
GEMINI_API_KEY          → gemini        $0, Google free tier
ANTHROPIC_API_KEY       → anthropic     ~$5-6/month, hard schema enforcement
(always last)           → heuristic     $0 forever, rules only, cannot fail
```

The heuristic provider is also the in-run safety net, so **a model outage never
kills the morning email**. A triage batch that fails three times is rescored by
rules. A writer that fails twice is replaced by excerpt summaries. Either way
the morning email goes out, and its footer says what happened. The failure
notice is reserved for real collapse: no feeds, no send.

Every provider's output passes the same sanitizer: bad enums coerced, invented
story ids dropped, numbers clamped. No provider is structurally trusted,
including Anthropic's, which enforces the schema server-side anyway.

## Safety

- Article text is treated as untrusted data in both prompts. Items flagged
  `prompt_injection_attempt` are dropped before selection.
- All rendered text is HTML-escaped; only `http(s)` links are emitted.
- URLs are restored from selection data after writing, never trusted from output.
- Health stories carry an evidence stage that the writer may not upgrade.
- No investment or medical advice, enforced in the editorial prompt.

## Cost and plan usage

Measured on 2026-10-07: **~297,000 tokens per brief** (259 candidates scored
in 11 Haiku calls, one Sonnet call to write; alerts use no model at all). The
event-grouping step adds one small Haiku call (~1-3% more). About
161,000 of that is input, mostly cached, and 136,000 is output, half of it the
model's thinking, which the CLI does not let us turn off.

The first measured run that morning was 505,000. The difference is the Claude
Code CLI's own agent context: it used to ride along on every call (~21,000
tokens each). The scorer now replaces the CLI's system prompt with its own and
disables tools, which also cut the run from 27 minutes to 9. The README's
original 85,000 estimate counted only our prompt text.

That is roughly **2 million tokens a week**. Anthropic publishes plan limits in
usage hours rather than tokens, and most of this runs on Haiku, which draws on
the plan far more slowly than Sonnet, so treat any percentage as a wide band.

Rather than trust that estimate, the pipeline records what it actually used:

```bash
npm run usage
```

## Feedback

Each story in What Actually Matters Today has More / Less buttons and a More
options link (bad source, already knew this, too detailed, very important,
actionable, irrelevant, mute). Each opens a pre-filled email, and nothing
changes until you send it. Every signal now acts where its complaint came from:
"bad source" demotes that feed one quality rung, "already knew this" quiets the
thread until its stage changes, "too detailed" shortens that category's
summaries. Each message is applied exactly once, keyed by its Message-ID. One click moves three dials, weighted by specificity:
source ±3, category ±2, geography ±1, each capped. So "less like this" on a
home-state politics story dampens that outlet most rather than suppressing all
politics. The loop is deliberately slow. A real shift takes about five clicks
over days.

```bash
npm run tuning    # every learned weight, what's muted, recent signals
```

Nothing is hidden, and anything can be reset by editing `state/history.json`.
Feedback *nudges* ranking. `config/preferences.json` *defines* it. See
[docs/TUNING.md](docs/TUNING.md), which also covers handing a brief to Claude for
structural changes clicks cannot express.

This replaced the webhook in the original spec, which needed a public HTTPS
endpoint and signed tokens to keep strangers from editing the profile. For a
one-reader system, mailto has the same signal and no attack surface.

## Maintenance

```bash
npm run check-feeds
```

Run it every couple of months. Feeds rot. A source that quietly stopped
returning items is the most likely way this degrades, and it fails silently.
That is exactly what the check catches.

The original n8n design notes are preserved at `docs/n8n_node_map.md.orig`.
