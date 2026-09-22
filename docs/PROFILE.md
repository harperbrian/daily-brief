# Personalization Profile

> This is the specification the pipeline implements, written for an **example
> reader** so the mechanism is visible. Everything about Alex is fiction. Write
> your own version of each section, then carry it into the files
> [docs/CUSTOMIZE.md](CUSTOMIZE.md) lists — the profile is the reasoning, the
> config is the arithmetic, and they should agree.

The goal is not a generic news reader. It is a personal intelligence briefing
that finds the small number of developments most likely to affect the reader's
finances, investments, career, business opportunities, family, property, or
major decisions.

## The example reader

Alex lives in Madison, Wisconsin (Dane County), is a parent, and works in
product management at a mid-size SaaS company. Alex owns a short-term rental in
Bend, Oregon (Deschutes County), is saving toward a primary residence, and is
interested in entrepreneurship — AI consulting, workflow automation and
small-business economics in particular.

Friends and family live in Denver and Phoenix (see `config/people.json`).

## Primary objective

Each day, find and rank the most important news by:

1. Financial impact
2. Investment relevance
3. Career impact
4. Business or entrepreneurial opportunity
5. Impact on the rental property
6. Impact on the plan to buy a primary residence
7. Family or parenting relevance
8. Geographic relevance
9. Magnitude of the development
10. Whether the information could reasonably change a decision the reader makes

Do not fill category quotas with weak stories to meet percentages. Quality and
personal relevance override allocation when the news cycle warrants it.

## Target topic allocation

Long-run targets, not daily quotas (`allocation.category_targets` in
`config/preferences.json`):

| Share | Topic |
|---|---|
| 27% | AI and emerging technology |
| 25% | Finance, investing, markets, economics |
| 15% | Career and the reader's industry |
| 13% | Entrepreneurship and small business |
| 10% | Politics, regulation, public policy |
| 10% | Parenting, family, education |

Classify by the primary reason a story matters. Never double-count one event
across categories: a Fed decision that affects mortgages is finance, not
politics.

## Geographic weighting

Home town and county first, then the home state, then the property area, then
the US, then the world. Proximity is a *modifier*: nothing is worth reading
merely because it happened nearby. `geography_priority` in
`config/preferences.json` and `hyperlocal_terms` under `heuristic_priors` carry
this.

## The rental property

Score property relevance only when there is a concrete channel to bookings,
revenue, costs, risk, property value, or long-term viability: short-term-rental
regulation and licensing, lodging and property taxes, insurance cost and
availability, HOA trends, pricing at the resort or attraction that drives
demand, closures of the road or airport that reaches the area. State news with
no property channel scores zero even when the dateline is the property's
county. This distinction is the single most common scoring error and the
scoring prompt spells it out with a rubric.

## Home purchase and the cash behind it

Mortgage rates and the Fed as it reaches mortgage financing, lending standards,
buyer programs, local housing supply and prices, property taxes, insurance,
closing costs, affordability. Also anything affecting *where the down payment
sits* while the reader saves: high-yield savings and money-market rates, CD and
Treasury-bill yields, deposit insurance, bank stability. That cash has a
near-term purpose, so the writer never implies it belongs in a market
opportunity.

## Personal relevance score

| Weight | Dimension |
|---|---|
| 20% | financial_impact |
| 15% | career_impact |
| 15% | investment |
| 15% | decision_change |
| 10% | business_opportunity |
| 10% | property |
| 5% | home_purchase |
| 5% | magnitude |
| 5% | geographic |
| 5% | novelty |

A story with very high relevance on one dimension must be able to outrank
mediocre stories touching several. The README explains the peak-blended formula
that makes this true, and why a plain weighted sum cannot.

## Signal-to-noise standard

Target 15 worthwhile stories; fewer on a slow day is correct. Never manufacture
significance. Suppress: generic AI hype, recycled announcements, hustle-culture
and get-rich-quick content, partisan outrage and horse-race coverage, routine
local crime, celebrity items, generic lifestyle advice.

## Daily briefing format

Every story links to its retrieved source; a model cannot invent a link because
`enforceUrls()` in `src/write.js` rewrites any URL back to the real one.

Per story: headline; what happened (2 to 4 sentences); why it matters to the
reader, naming the channel rather than asserting importance; confidence
(`Certain` / `Likely` / `Guessing`); action (`NONE` / `WATCH` / `RESEARCH` /
`CONSIDER_ACTION`, with a reason when not NONE); time horizon; category;
geography.

Sections:

1. **What Actually Matters Today** — 3 to 5 developments with the greatest
   potential to change a decision. Not the biggest headlines.
2. **Worth Knowing** — the rest of the selected stories, one line each.
3. **Things I'm Watching** — unresolved and forthcoming: proposals, pending
   launches, scheduled decisions.

## Avoid news anxiety

Do not reward sensationalism, negativity, conflict, outrage, fear, or novelty
for its own sake. A catastrophic headline should not rank highly unless its
consequences reach the reader. The product exists to improve decisions, not to
maximize attention. In the config this is `peak_eligibility`: novelty at 0.0
and geography and magnitude at 0.3 can never be *grounds* for inclusion.
