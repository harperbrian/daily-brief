/**
 * On-time trigger for the GitHub Actions workflows.
 *
 * GitHub's own cron is best-effort: from 2026-09-30 to 10-07 the 7 AM brief
 * started a median ~5.5 h late, and only ~1 in 5 hourly alert crons fired at
 * all. A workflow_dispatch call starts a run within seconds, so this Worker's
 * cron (Cloudflare's scheduler, which fires on time) calls the GitHub API once
 * an hour:
 *
 *   3 AM local          -> daily-brief.yml       (scheduled=true)
 *   4 AM local          -> daily-brief.yml again, ONLY if no brief run has
 *                            started in the last 2 h (catches a failed 3 AM
 *                            dispatch; the check is a read, so it costs no
 *                            Actions minutes)
 *   7 AM - 10 PM local  -> breaking-alert.yml    (scheduled=true)
 *
 * `scheduled=true` makes each workflow apply the same once-a-day and
 * waking-hours checks as its own cron, so a duplicate dispatch is harmless.
 * The hour is computed in America/local here, so daylight saving needs no
 * second cron line.
 *
 * Security: the only secret is GITHUB_TOKEN, a fine-grained token limited to
 * this one repository with Actions read/write. It is never logged. The Worker
 * has no fetch handler and no public URL (workers_dev and preview_urls are off
 * in wrangler.jsonc), so nothing on the internet can invoke it.
 */

export const TZ = 'America/Chicago'; // your IANA timezone; keep it equal to `timezone` in config/preferences.json
// 3 AM local, so the brief is waiting when the day starts.
export const BRIEF_HOUR = 3;
export const CATCHUP_HOUR = 4;
export const ALERT_FIRST_HOUR = 7;
export const ALERT_LAST_HOUR = 22;

/** Pure: which workflows to start at this instant. */
export function plan(date, tz = TZ) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(date)
  );
  const jobs = [];
  if (hour === BRIEF_HOUR) jobs.push({ workflow: 'daily-brief.yml', inputs: { scheduled: 'true' } });
  if (hour === CATCHUP_HOUR) {
    jobs.push({ workflow: 'daily-brief.yml', inputs: { scheduled: 'true' }, unlessRunWithinMs: 2 * 3600e3 });
  }
  if (hour >= ALERT_FIRST_HOUR && hour <= ALERT_LAST_HOUR) {
    jobs.push({ workflow: 'breaking-alert.yml', inputs: { scheduled: 'true' } });
  }
  return { hour, jobs };
}

const API = 'https://api.github.com';
const headers = (env) => ({
  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'brief-trigger (cloudflare worker)',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POSTs one workflow_dispatch. A 5xx or a network error is retried once after
 * a pause (a brief GitHub hiccup usually outlasts an immediate retry); a 4xx
 * will not fix itself and is reported at once.
 */
export async function dispatch(job, env, fetchImpl = fetch, { retryDelayMs = 30000 } = {}) {
  const url = `${API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${job.workflow}/dispatches`;
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await sleep(retryDelayMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers(env), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: env.GITHUB_REF || 'main', inputs: job.inputs }),
      });
    } catch (err) {
      last = { ok: false, status: 0, detail: `network error: ${String(err?.message ?? err).slice(0, 200)}`, attempts: attempt };
      continue;
    }
    if (res.status === 204) return { ok: true, status: 204, attempts: attempt };
    // GitHub's error body says what is wrong (bad credentials, missing
    // permission, unknown input) and never echoes the token.
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    last = { ok: false, status: res.status, detail, attempts: attempt };
    if (res.status < 500) break;
  }
  return last;
}

/** True if any run of this workflow was created within the window (a read; no Actions minutes). */
export async function hasRecentRun(workflow, withinMs, env, fetchImpl = fetch, now = Date.now()) {
  const since = new Date(now - withinMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url = `${API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflow}/runs?created=%3E%3D${encodeURIComponent(since)}&per_page=1`;
  const res = await fetchImpl(url, { headers: headers(env) });
  if (res.status !== 200) throw new Error(`run lookup HTTP ${res.status}`);
  const body = await res.json();
  return (body.total_count ?? 0) > 0;
}

/** Runs one planned job; never throws, so one failure cannot skip the others. */
export async function runJob(job, env, hour, { fetchImpl = fetch, retryDelayMs, now } = {}) {
  try {
    if (job.unlessRunWithinMs) {
      let recent = true;
      try {
        recent = await hasRecentRun(job.workflow, job.unlessRunWithinMs, env, fetchImpl, now);
      } catch (err) {
        // Unknown is treated as "already ran": the guard would skip a duplicate
        // anyway, but a catch-up must never cost a second full brief.
        console.error(`local hour ${hour}: catch-up check failed (${String(err?.message ?? err)}); not dispatching`);
      }
      if (recent) {
        console.log(`local hour ${hour}: ${job.workflow} already started recently; no catch-up needed`);
        return { skipped: true };
      }
    }
    const r = await dispatch(job, env, fetchImpl, { retryDelayMs });
    if (r.ok) console.log(`local hour ${hour}: started ${job.workflow}${job.unlessRunWithinMs ? ' (catch-up)' : ''}`);
    else console.error(`local hour ${hour}: ${job.workflow} dispatch failed (HTTP ${r.status}): ${r.detail}`);
    return r;
  } catch (err) {
    console.error(`local hour ${hour}: ${job.workflow} failed unexpectedly: ${String(err?.message ?? err).slice(0, 200)}`);
    return { ok: false, status: 0 };
  }
}

export default {
  async scheduled(controller, env, ctx) {
    if (!env.GITHUB_TOKEN) {
      console.error('GITHUB_TOKEN secret is not set; nothing dispatched');
      return;
    }
    const { hour, jobs } = plan(new Date(controller.scheduledTime));
    if (jobs.length === 0) {
      console.log(`local hour ${hour}: nothing to start`);
      return;
    }
    ctx.waitUntil(
      (async () => {
        for (const job of jobs) await runJob(job, env, hour, { now: controller.scheduledTime });
      })()
    );
  },
};
