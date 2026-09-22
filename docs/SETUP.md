# Setup

Do [CUSTOMIZE.md](CUSTOMIZE.md) first — the repo ships with an example reader's
profile, feeds and places, and you want yours in place before the first send.

About 15–25 minutes depending on the path you pick. Every credential below is
something you create and paste yourself — none of it passes through Claude.

## 1. Choose how it thinks

The pipeline auto-detects a model provider from whichever credential you set,
free options first. Set none and it still runs.

Providers are a **cascade**, not a single choice: set more than one and if the
first fails at 6:30 AM, the next takes over automatically.

| Path | Monthly cost | Quality | You need |
|---|---|---|---|
| **Claude subscription** (recommended) | **$0 extra** | Best | Claude Pro/Max — you have this if you use Claude Code |
| **Gemini free tier** (recommended as backup) | **$0** | Good | A Google account |
| **Anthropic API** | ~$5–6 | Best | API key + credit balance |
| **No model at all** | $0 forever | Basic | Nothing |

Setting **both** Claude and Gemini is the recommended configuration: Claude leads,
Gemini covers you if the token expires or you hit a plan limit, and rule-based
mode catches everything after that. All three are free.

**Claude subscription** — this uses your Pro/Max **plan**, not API credits.
There is no balance to deplete and no per-token bill; usage counts against the
same rolling plan limits as your interactive Claude use, and this workload is
about ten small requests a day. In any terminal where you're logged into Claude
Code, run:

```bash
claude setup-token
```

Copy the token it prints; that becomes the `CLAUDE_CODE_OAUTH_TOKEN` secret in
step 4. Treat it like a password — it acts as your Claude account. If it ever
expires, re-run the command and update the secret; until you do, Gemini covers
the gap silently.

**Copy it carefully.** The token is long enough to wrap in a terminal, and
copying a wrapped line can insert a line break mid-token. The symptom in the
Actions log is `API Error: Header '14' has invalid value: '***'` — GitHub
masking the secret because the whole value was rejected as an HTTP header.
Widen the terminal or triple-click the line before copying, and make sure the
pasted value starts with `sk-ant-oat01-` and has nothing after the last
character. The CLI-install step in the workflow runs one smoke call and prints
`smoke exit=0` when the token works, so you find out in seconds, not after a
25-minute run.

**Gemini free tier** — create a key at https://aistudio.google.com/apikey (no
card required). Becomes the `GEMINI_API_KEY` secret. Honest caveat: Google may
use free-tier inputs to improve its products, and the scoring prompt contains
your interest profile — first name, town, employer type, the rental
property, the home-purchase goal. The sign-up also asks you to attest you are
building "for professional or business purposes." If either bothers you, skip
Gemini: rule-based mode is the fallback and the footer says so on the day.

Use an established Google account for the key, not one created for this
project. A brand-new account's AI Studio project was refused with
`403 PERMISSION_DENIED: Your project has been denied access` on 2026-09-18;
Google's new-account controls block API access for a while.

**Anthropic API** — https://console.anthropic.com → API Keys. Add ~$10 credit
and set a monthly spend limit. Becomes the `ANTHROPIC_API_KEY` secret. This is
the only path with hard schema-enforced output; the others are sanitized in code
instead.

**No model** — skip this step entirely. Stories are picked by rules and
summaries are source excerpts. The email says so in its footer, so a fallback
day is never mistaken for an editorial one.

## 2. Gmail app password

A normal Gmail password will not work — Google blocks it for SMTP.

1. Enable 2-Step Verification: https://myaccount.google.com/signinoptions/two-step-verification
2. Go to https://myaccount.google.com/apppasswords
3. Name it `daily-brief`, create it, copy the 16 characters.

This password can send and read mail on that account. Treat it like a password,
because it is one. Revoke it from the same page any time. Paste it into the
secret as 16 characters with no spaces (Google displays it in groups of four).

A dedicated sending account is a reasonable choice — the credential then
unlocks an inbox with nothing else in it, and the feedback buttons still work
because the pipeline reads replies from `GMAIL_USER`, whoever sends them. Two
things a fresh account needs first: 2-Step Verification on (the App Passwords
page does not exist until it is), and if you see "The setting you are looking
for is not available for your account," turn off *Skip password when possible*
under Passkeys, then find App passwords via the account search box — the
direct link errors on some new accounts for a few hours.

If the first send fails with `534-5.7.9 WebLoginRequired`, Google is refusing
the login from GitHub's datacenter IP because it has never seen that account
sign in from anywhere unfamiliar. Visit
https://accounts.google.com/DisplayUnlockCaptcha while signed in as the
sending account, click Continue, and re-run.

## 3. Push to GitHub

From this folder, make the first commit:

```bash
git add -A && git commit -m "Daily brief pipeline"
```

Then create the repo and push:

```bash
gh repo create daily-brief --private --source=. --remote=origin --push
```

No `gh`? Create an empty **private** repo on github.com, then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/daily-brief.git && git branch -M main && git push -u origin main
```

Keep it **private**. It contains your interests, your locations, and your reading
history. (Private repos get 2,000 free Actions minutes/month; this uses ~100.)

## 4. Add the secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

| Name | Value |
|---|---|
| `GMAIL_USER` | the Gmail address that sends (e.g. `you@gmail.com`) |
| `GMAIL_APP_PASSWORD` | the 16 characters from step 2 |
| `BRIEF_TO` | where the brief arrives — can be the same address |
| `CLAUDE_CODE_OAUTH_TOKEN` | *one of these three, per step 1* |
| `GEMINI_API_KEY` | ↑ |
| `ANTHROPIC_API_KEY` | ↑ |
| `TAVILY_API_KEY` | *optional*, leave unset unless you add search |

Set as many model credentials as you like — they chain in free-first order
(claude-code → gemini → anthropic → rule-based) and each is a fallback for the
one before it. To promote a specific one to the front, add a repository
**variable** (not secret) named `MODEL_PROVIDER` set to `claude-code`, `gemini`,
`anthropic`, or `heuristic` (the last disables models entirely).

## 4a. Breaking-news alerts

A second workflow checks 13 fast primary sources every hour (plus the friends-and-family places) — National Weather
Service alerts for your county and the property's, USGS earthquakes, FDA and CDC recalls,
the Fed, and the wires — and emails you **only** when something genuinely urgent
appears. It uses no model and no tokens.

The bar is deliberately high and hard-capped at **3 alerts per day**, because an
alert channel that cries wolf gets muted and then fails to deliver the one that
mattered. It runs 7 AM–11 PM your time only (`LOCAL_TZ` in the workflow), so nothing wakes you at 3 AM.
Most hours it sends nothing at all, which is the design working.

It also watches the places in `config/people.json` — where friends and family
live — for real impact only (casualties, destroyed homes, evacuations, nearby
M5.5+ earthquakes), never for warnings, and names who is there in the email.
Edit that file to add or remove a place; each needs a local news feed in
`config/feeds.json` tagged `"track": "people"`, `"alert_only": true`.

Nothing extra to configure — it uses the same Gmail secrets. To turn it off,
delete `.github/workflows/breaking-alert.yml`. To halve its Actions usage at the
cost of up to an hour's delay, change its cron to `5 */2 * * *`.

Actions minutes: measured on real Claude-subscription runs at 24–31 minutes/day
(23.8 min on 2026-08-23 from a Mac; 27.0 and 31.3 min on 2026-09-18 on
ubuntu-latest —
the claude-code provider scores one batch at a time on purpose, so this is the
slow path -- Gemini and the Anthropic API run several batches in parallel and
finish in 2-4 minutes). That's roughly **720–940 minutes/month** for the
daily brief alone, plus hourly alerts at ~500/month (alerts use no model, so
their timing does not change). Total **~1,200–1,450/month against the
2,000/month free allowance** for private repos -- real headroom, but not the "practically free"
margin the original estimate implied. If you add more scheduled automation
later, re-check this number before you do.

## 5. Test it

Repo → **Actions** → **Daily Brief** → **Run workflow**.

Run once with **dry run checked** first. That builds the brief and uploads it as
an artifact without emailing or recording history — if something is
misconfigured you find out without a bad email. Download the artifact and open
the `.html`. The log's "Generate and send" step echoes `dry_run input: 'true'`
so you can confirm the box was actually checked; an unchecked box tries to
send. From a terminal, `gh workflow run daily-brief.yml -f dry_run=true` sets
it unambiguously.

Then run again with dry run unchecked. The brief should arrive within a minute
or two.

After that it runs itself at ~6:30 AM your time, daily.

## 6. Watch for these

- **First run has no history**, so novelty scoring is blind and you may see a
  story that has circulated for days. It corrects itself by day three.
- **GitHub cron drifts** — usually 5–20 minutes, but the first day this repo
  was live (2026-09-18) the 10:30 UTC cron fired at 14:35, four hours late.
  The guard step handles this: a scheduled run proceeds once per local date
  at or after 6 AM, so drift delays the brief rather than losing it. 6:30
  means "6:30 on a good day."
- **GitHub disables scheduled workflows after 60 days of repo inactivity.** The
  daily history commit should prevent it, and GitHub emails you first. If the
  brief stops arriving, check the Actions tab.
- **A failure emails you** rather than going silent — and most failures don't
  even do that anymore: if the model provider breaks mid-run, the brief sends
  anyway with rule-based scoring or summaries and says so in the footer.

## Running locally

Every command below must be run from the project folder:

```bash
cd /path/to/daily-brief
```

Running an `npm run` command anywhere else fails with a missing-script or
missing-package.json error — that is the most common cause of "it didn't work."

```bash
npm install
npm test                              # 183 offline tests, no keys needed
npm run dry-run                       # build a brief, send nothing
npm run alert-dry                     # check the alert path, send nothing
npm run check-feeds                   # verify every source is alive
npm run usage                         # token consumption and plan share
npm run tuning                        # what your feedback has taught it
```

`npm run usage` reports a projection until the first live run — usage is only
recorded after a real send that used a model, so dry runs leave it empty. That is
expected, not a failure.

`dry-run` writes to `out/` and sends nothing — useful for tuning
`config/preferences.json` without waiting for tomorrow. With no credentials set
it runs in rule-based mode, so all of this works before you configure anything.

## Changing things

| To change | Edit |
|---|---|
| Model provider | which secret exists, or the `MODEL_PROVIDER` repo variable |
| Delivery time | the two `cron` lines in `.github/workflows/daily-brief.yml` |
| Topics and weights | `config/preferences.json` |
| Sources and their lean tags | `config/feeds.json`, then `npm run check-feeds` |
| Section sizes | `QUOTAS` in `src/select.js` |
| Quality floor | `MIN_SCORE` in `src/select.js` (raise it for fewer, better stories) |
| How much balance matters | `corroborationBonus()` in `src/select.js` |
| Alert sensitivity | `URGENCY_THRESHOLD` and the keyword lists in `src/alert.js` |
| Alert frequency | the `cron` in `.github/workflows/breaking-alert.yml` |
| Tone and length | `prompts/digest_prompt.txt` |

Run `npm run check-feeds` every couple of months. Feeds die quietly, and a
source that has silently stopped returning items is the most likely way this
degrades.
