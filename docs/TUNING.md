# Tuning the brief

Two ways to shape what you get, meant for different jobs.

## 1. Click the buttons (gradual, automatic)

Stories in **What Actually Matters Today** carry four buttons — More like this,
Less like this, Very important, Actionable — plus a **More options…** link
covering four more. They open a pre-filled email; nothing happens until you send
it. The next morning's run reads them and adjusts.

**Each signal acts where its complaint came from.** This is the important part.
Routing everything into one relevance score would make every complaint say "less
of this topic" — the one thing none of them actually said.

| Signal | Acts on | What it does |
|---|---|---|
| More like this | ranking | +3 source, +2 category, +1 geography |
| Less like this | ranking | the same, negative |
| Very important | ranking + calibration | double weight, and records which *dimension* drove it |
| Actionable | ranking + Action calibration | positive nudge; flags whether the Action label was right |
| Irrelevant | ranking + retrieval | double negative, and counts a complaint against that feed |
| Already knew this | **timing, not topic** | quiets that thread until it genuinely changes. Never touches the category — the subject was fine, the moment was wrong |
| Bad source | **quality, not ranking** | demotes that feed one quality rung, capped at two. The complaint is about believability, so it multiplies rather than adds |
| Too detailed | **the writer only** | shortens summaries for that category. Zero effect on what gets selected |
| Mute | selection | suppresses the category for 30 days |

Ranking signals move three dials at once, weighted by specificity: source ±3
(cap 15), category ±2 (cap 12), geography ±1 (cap 8). So "less like this" on a
home-state politics piece from a state outlet dampens that outlet most, politics
somewhat, and the home region slightly — rather than suppressing every political story
you get.

This is deliberately slow. A single click nudges; changing a source's standing
meaningfully takes about five clicks over several days. That is the point — one
irritated morning should not permanently reshape the brief.

See what it has learned at any time:

```bash
npm run tuning
```

That prints every learned weight, source demotions, feeds you have repeatedly
called irrelevant, length preferences, quieted threads, and — once you have
clicked "Very important" a few times — a **suggested weight adjustment**.

Those suggestions are printed, never applied. Auto-tuning ten dimension weights
from a handful of clicks overfits badly and destroys any ability to explain why
a story ranked where it did. If a dimension dominates your "very important"
clicks but carries a small weight in `config/preferences.json`, that is the
weight worth raising by hand.

Nothing is hidden, and you can reset any of it by editing `state/history.json`.

## 2. Tell Claude (structural, immediate)

The buttons nudge ranking. They cannot add a source, change a section's size, or
teach a new interest. For that, hand a brief to Claude in a session and say what
worked and what didn't:

> "In today's brief, the Ebola story and the Fed piece were exactly right. The
> two home-state road-construction items were noise — I don't care about
> resurfacing projects unless they're on my commute. And I'd like more on AI
> policy specifically, not AI product launches."

That is actionable in a way clicks are not, and it results in edits to:

| What you said | What changes |
|---|---|
| "more AI policy, less product launches" | `config/preferences.json` topic weights, and the scoring prompt's guidance |
| "road construction is noise" | `junk_patterns` in `config/preferences.json` |
| "this outlet is consistently bad" | remove it from `config/feeds.json` |
| "I want a source covering X" | find and verify a feed, add it |
| "nine stories is too many" | `max_stories` and the `QUOTAS` in `src/select.js` |
| "summaries are too long" | `prompts/digest_prompt.txt` |

**The distinction that matters:** feedback weights *nudge* ranking and decay in
influence as they hit their caps. `config/preferences.json` *defines* what the
brief is. Recurring irritations belong in preferences; passing ones belong in
clicks.

## What to send Claude

Most useful, in order:

1. **The brief itself** — `out/brief-YYYY-MM-DD.html`, or just forward the email.
2. **Which stories earned their place and which didn't**, with a sentence of why.
   "Didn't care" is less useful than "I don't need coverage of state politics
   outside my county."
3. **`npm run tuning` output**, if you have been clicking — it shows whether the
   automatic side is already drifting somewhere you did not intend.

## A caution on over-tuning

The brief gets worse if you tune it toward only what you already agree with. The
cross-spectrum corroboration bonus and the Must Know balance rule exist to resist
that, and they work against your clicks by design. If you find yourself muting
every source that annoys you, you are building a mirror rather than a briefing.

`npm run tuning` is the check: if the dampened list is all one political
direction, that is worth noticing.

## 3. The golden set (measuring whether any of this works)

The 145 tests in `npm test` check *mechanism* — that the formula is monotone,
that caps hold, that bad model output is coerced safely. None of them can tell
you whether the fifteen stories arriving each morning are the **right** fifteen.
Only you can say that.

```bash
node src/index.js --dry-run --dump-candidates   # needs a real model credential
npm run label                                   # build a labeling worksheet
# ...label it, ~30 minutes...
npm run golden                                  # score the ranking against your labels
```

`npm run label` writes `state/golden-<date>.json`. Replace each `"label": null`
with:

| | |
|---|---|
| `2` | must surface — I would be annoyed to miss this |
| `1` | fine either way |
| `0` | suppress — this is noise for me |

**Judge on your interests, not general newsworthiness.** A major world event with
no line to your money, career, rental property, or family is a 0 or 1.
That distinction is the entire point.

### Why the worksheet includes rejected stories

Roughly two-thirds of the rows are stories the system **rejected**. That is
deliberate. If you only labeled what it selected, you could only ever catch
*false positives* — junk that got in, which you can already see in your inbox.
The dangerous failure is a *false negative*: something that mattered, silently
dropped, which you would never learn about. A `2` on a rejected row is exactly
that, and `npm run golden` reports those first.

### Reading the output

- **Ordering check** — mean score for label 2 should exceed label 1 should
  exceed label 0. If that ordering is flat or inverted, ranking is not tracking
  you at all and no amount of weight-tweaking will fix it.
- **Recall** — how much of what you wanted actually surfaced.
- **Precision** — how much of what surfaced you wanted.
- **What to change** — turns misses into a specific config edit: lower
  `MIN_SCORE`, raise a dimension weight, or check a category ceiling.

One guard worth knowing: if misses cluster on `novelty`, `geographic`, or
`magnitude`, the tool will tell you **not** to raise those weights. They are
modifiers by design — they can never be grounds for including a story — so
clustering there means the scoring prompt is not recognizing why those stories
matter, which is a prompt problem, not a weights problem.

Re-run `npm run label` on future days to accumulate more labeled data;
`npm run golden` reads every `state/golden-*.json` together.
