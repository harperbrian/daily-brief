# Make it yours

The repository ships configured for a fictional reader (Alex, Madison WI, a
rental in Bend OR, family in Denver and Phoenix). Every file below carries
example data you replace. Nothing about the code needs to change.

Do these in order. Each takes a few minutes; `npm test` and `npm run dry-run`
work at every step, with no keys.

## 1. Who you are — the prompts

Two files carry a short profile block between `=== PROFILE ===` markers:

- `prompts/scoring_prompt.txt` — the triage model reads this. Name, town and
  county, family situation, job and industry, the rental property (or delete
  those sentences), the home-purchase goal (or delete), interests.
- `prompts/digest_prompt.txt` — the writer reads this. Keep it consistent with
  the first.

Keep the block short. The rubric below it is generic and does not need edits.
If you have no rental property, leave the `property` dimension in place and set
its weight to 0 in step 2; the prompt's rubric then never fires.

## 2. What matters to you — `config/preferences.json`

- `owner` — your first name. It becomes the email title.
- `timezone` — IANA name, e.g. `America/New_York`. Also set `LOCAL_TZ` and the
  two cron lines in `.github/workflows/daily-brief.yml`, and `LOCAL_TZ` in
  `breaking-alert.yml`.
- `geography_priority` and `topic_priority` — plain-English labels and weights.
- `relevance.dimensions` — the ten weights. Relative, normalized in code.
- `allocation.category_targets`, `reserved_slots` — long-run mix and the
  standing slots for local news, quality of life and the property.
- `heuristic_priors.hyperlocal_terms` — names that mean "right where I live".
- `heuristic_priors.property_terms` — names that mean the rental area.

## 3. Where the news comes from — `config/feeds.json`

The national feeds are a reasonable starting set for anyone. Replace every feed
on these tracks:

| Track | Meaning | Example entries to replace |
|---|---|---|
| `home_local` | your town and county | Channel 3000, Wisconsin State Journal, WKOW, NWS Dane County |
| `home_region` | your state | Wisconsin Examiner, Wisconsin Watch, Wisconsin Right Now, Badger Institute |
| `property_local` | where the rental is | KTVZ, The Oregonian, Oregon Capital Chronicle, Oregon Catalyst, NWS Deschutes County |

Give each feed a `lean` (`left`, `center-left`, `center`, `center-right`,
`right`, or `primary` for government and scientific sources) and a
`source_class`. Keep each track balanced across leans — the README explains why
that is a code-level requirement, not a nicety. Then:

```bash
npm run check-feeds
```

**NWS zone codes.** For your home and property coordinates, open
`https://api.weather.gov/points/LAT,LNG` and read `county` (e.g. `WIC025`) and
`forecastZone` (e.g. `WIZ063`) from the response. The feed URL is
`https://api.weather.gov/alerts/active.atom?zone=COUNTY,ZONE`. Never use
`?area=STATE`: that is the whole state, and a thunderstorm warning 200 miles
away will page you daily.

## 4. Targeted searches — `config/search_queries.json`

Only used if you set `TAVILY_API_KEY`. Replace the town, county and state names
in the queries and the `include_domains` lists with your local government
sites. Delete the file's entries if you do not want search at all.

## 5. Friends and family — `config/people.json`

One entry per place: `id`, `place`, `people` (what the email should say),
`lat`/`lng`, `match` (a regex the headline must hit — the town, its county, the
neighbourhoods), and `nws` (county and zone codes as in step 3). Then add feeds
to `config/feeds.json` for each place with `"track": "people"`,
`"alert_only": true`, and `"place"` set to the entry's `id`: one or two local
outlets plus an NWS zone feed.

The bar for these places is impact, never warnings: casualties, destroyed
homes, evacuation orders, explosions, boil-water notices, nearby earthquakes.
To turn the feature off, set `places` to `[]` and delete the `people` feeds.

## 6. The profile document — `docs/PROFILE.md`

Rewrite it for yourself. It is the reasoning the config implements; when the
two disagree, the config wins and the document is wrong, so keep them together.

## 7. Check

```bash
npm test              # 183 offline tests
npm run dry-run       # builds a brief to out/ with no keys, rule-based
npm run alert-dry     # checks the alert path, sends nothing
```

Then follow [SETUP.md](SETUP.md) to put it in the cloud.
