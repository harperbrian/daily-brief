/**
 * Claude subscription provider — $0 marginal cost. Runs the Claude Code CLI in
 * headless mode, authenticated by CLAUDE_CODE_OAUTH_TOKEN (generated once with
 * `claude setup-token`, requires a Pro/Max subscription). Officially supported by
 * Anthropic for CI use; the two short jobs a day are trivial against plan limits.
 *
 * No forced tool_choice here, so the schema is included in the prompt and the
 * output is extracted and sanitized rather than trusted (src/score.js and
 * src/write.js validate every field regardless of provider).
 */
import { spawn } from 'node:child_process';
import { historyBlock, scoringPayloadBlock, buildDigestUser, eventsPayloadBlock } from './format.js';
import { extractJson } from './json-util.js';

export const name = 'claude-code';
export const label = 'Claude subscription (Claude Code CLI)';
export const concurrency = 1; // one CLI process at a time; subscription limits are per-account

const TIMEOUT_MS = 240000;

/**
 * Environment for the CLI child process. The Claude Code CLI prefers an API key
 * over the subscription token whenever one is present, and an API key is
 * metered. This provider exists to spend the subscription and nothing else, so
 * every variable that could route the call to a metered account is removed
 * before the CLI starts. With these gone the CLI can only use
 * CLAUDE_CODE_OAUTH_TOKEN (or, locally, the developer's own login).
 */
const METERED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];
export function cliEnv(env) {
  const out = { ...env };
  for (const k of METERED_ENV) delete out[k];
  return out;
}

/**
 * Runs `claude -p` with the instructions as the SYSTEM prompt, the data on
 * stdin, and no tools.
 *
 * Measured on 2026-10-07: with the CLI's default system prompt and tools, every
 * call carried ~21k tokens of Claude Code agent context before our prompt, which
 * was ~46% of the brief's tokens. Replacing the system prompt and disabling tools
 * removes that; the prompt is also identical across a run's batches, so it can
 * be cached. stdin replaces a single huge argv element (Linux caps one argument
 * at 128 KiB) and the CLI's 3 s wait for stdin on every call.
 */
async function run(system, user, model, usage, { effort, timeoutMs = TIMEOUT_MS } = {}) {
  const args = ['-p', '--output-format', 'json', '--model', model, '--system-prompt', system, '--tools', ''];
  // Unset means the CLI default. The CLI does not send effort to Haiku 4.5
  // (measured 2026-10-07: no change in output), so this only matters for Sonnet.
  // Thinking also stays on: MAX_THINKING_TOKENS=0 was tested the same day on CLI
  // 2.1.292 and had no effect (11.5k-15k thinking tokens per run either way).
  const env = cliEnv(process.env);

  let stdout;
  try {
    stdout = await runCli(process.env.CLAUDE_CODE_BIN ?? 'claude', args, user, env, timeoutMs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // CLI not on PATH (e.g. running locally without a global install) — npx fallback.
      stdout = await runCli('npx', ['-y', '@anthropic-ai/claude-code', ...args], user, env, timeoutMs);
    } else {
      // A failed call can still have spent tokens; count them before giving up.
      recordEnvelope(err.stdout, model, usage);
      // Recent CLI versions print a "no stdin data received in 3s" warning on
      // non-TTY calls. Strip it so it cannot hide the actual failure.
      const stderr = String(err.stderr ?? '')
        .split('\n')
        .filter((l) => !/no stdin data received|redirect stdin explicitly/.test(l))
        .join('\n')
        .trim();
      const detail = stderr || String(err.stdout ?? '').trim() || err.message;
      const e = new Error(`claude CLI failed (${err.timeout ? 'timeout' : `exit ${err.exitCode ?? '?'}`}): ${detail.slice(0, 600)}`);
      e.timeout = !!err.timeout;
      throw e;
    }
  }

  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    return extractJson(stdout); // CLI printed raw text; salvage if it contains JSON
  }
  // The CLI reports token counts in its JSON envelope; recording them is what
  // makes plan consumption measurable instead of guessed at. Recorded before the
  // error check so a failed call still counts.
  recordEnvelope(outer, model, usage);
  if (outer.is_error) throw new Error(`claude CLI error: ${String(outer.result).slice(0, 300)}`);
  return extractJson(String(outer.result ?? ''));
}

function recordEnvelope(outer, model, usage) {
  if (typeof outer === 'string') {
    try {
      outer = JSON.parse(outer);
    } catch {
      return;
    }
  }
  if (outer && typeof outer === 'object' && outer.usage) {
    usage?.record(model, { ...outer.usage, num_turns: outer.num_turns });
  }
}

/** spawn with stdin input and a hard timeout; rejects with stdout/stderr attached. */
export function runCli(bin, args, input, env, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        const err = new Error(timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit ${code}`);
        Object.assign(err, { timeout: timedOut, exitCode: code, stdout, stderr });
        reject(err);
        return;
      }
      resolve(stdout);
    });
    child.stdin.on('error', () => {}); // EPIPE if the CLI exits early; 'close' reports it
    child.stdin.end(input);
  });
}

function schemaInstruction(schema) {
  return [
    'The output must be a single JSON object that validates against this JSON Schema:',
    JSON.stringify(schema),
    'Return ONLY the JSON object. No prose, no explanation, no code fences.',
  ].join('\n');
}

export async function scoreBatch({ system, historyText, openThreads, payload, schema, usage }) {
  // Everything except the articles is identical across a run's batches, so it
  // sits in the system prompt where it can be cached.
  const sys = [system, '', historyBlock(historyText, openThreads), '', schemaInstruction(schema)].join('\n');
  const out = await run(sys, scoringPayloadBlock(payload), process.env.CC_TRIAGE_MODEL ?? 'haiku', usage, {
    effort: process.env.CC_TRIAGE_EFFORT,
  });
  return out.stories ?? [];
}

export async function writeDigest({ system, payload, schema, usage }) {
  const sys = [system, '', schemaInstruction(schema)].join('\n');
  return run(sys, buildDigestUser(payload), process.env.CC_WRITER_MODEL ?? 'sonnet', usage, {
    effort: process.env.CC_WRITER_EFFORT,
  });
}

export async function groupEvents({ system, payload, schema, usage }) {
  const sys = [system, '', schemaInstruction(schema)].join('\n');
  // A small call (~5k tokens): 90 s, not the scorer's 240 s, so a hung CLI
  // cannot hold the brief for four minutes before the word-overlap fallback.
  return run(sys, eventsPayloadBlock(payload), process.env.CC_TRIAGE_MODEL ?? 'haiku', usage, {
    effort: process.env.CC_TRIAGE_EFFORT,
    timeoutMs: 90000,
  });
}
