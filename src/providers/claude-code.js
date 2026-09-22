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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildScoringUser, buildDigestUser } from './format.js';
import { extractJson } from './json-util.js';

const exec = promisify(execFile);

export const name = 'claude-code';
export const label = 'Claude subscription (Claude Code CLI)';
export const concurrency = 1; // one CLI process at a time; subscription limits are per-account

async function run(prompt, model, usage) {
  const args = ['-p', prompt, '--output-format', 'json', '--model', model];
  const opts = { timeout: 240000, maxBuffer: 32 * 1024 * 1024 };

  let stdout;
  try {
    ({ stdout } = await exec(process.env.CLAUDE_CODE_BIN ?? 'claude', args, opts));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // CLI not on PATH (e.g. running locally without a global install) — npx fallback.
      ({ stdout } = await exec('npx', ['-y', '@anthropic-ai/claude-code', ...args], opts));
    } else {
      // Recent CLI versions print a "no stdin data received in 3s" warning on
      // every non-TTY call (harmless -- the call still succeeds). Strip it, or
      // it fills the error text and hides the actual failure.
      const stderr = String(err.stderr ?? '')
        .split('\n')
        .filter((l) => !/no stdin data received|redirect stdin explicitly/.test(l))
        .join('\n')
        .trim();
      const detail = stderr || String(err.stdout ?? '').trim() || err.message;
      throw new Error(`claude CLI failed (exit ${err.code ?? '?'}): ${detail.slice(0, 600)}`);
    }
  }

  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    return extractJson(stdout); // CLI printed raw text; salvage if it contains JSON
  }
  if (outer.is_error) throw new Error(`claude CLI error: ${String(outer.result).slice(0, 300)}`);
  // The CLI reports token counts in its JSON envelope; recording them is what
  // makes plan consumption measurable instead of guessed at.
  usage?.record(model, outer.usage);
  return extractJson(String(outer.result ?? ''));
}

function withSchema(system, user, schema) {
  return [
    system,
    '',
    user,
    '',
    'The output must be a single JSON object that validates against this JSON Schema:',
    JSON.stringify(schema),
    'Return ONLY the JSON object. No prose, no explanation, no code fences.',
  ].join('\n');
}

export async function scoreBatch({ system, historyText, payload, schema, usage }) {
  const prompt = withSchema(system, buildScoringUser(historyText, payload), schema);
  const out = await run(prompt, process.env.CC_TRIAGE_MODEL ?? 'haiku', usage);
  return out.stories ?? [];
}

export async function writeDigest({ system, payload, schema, usage }) {
  const prompt = withSchema(system, buildDigestUser(payload), schema);
  return run(prompt, process.env.CC_WRITER_MODEL ?? 'sonnet', usage);
}
