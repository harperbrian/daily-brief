/**
 * Token accounting. Exists because "how much of my plan does this consume?"
 * should be answered by measurement, not by an estimate — Anthropic publishes
 * plan limits in hours and messages, not tokens, so any percentage quoted from
 * the outside is a guess. This records what actually happened.
 *
 *   npm run usage
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETENTION_DAYS = 60;

/** Accumulates per-run token counts as the pipeline reports them. */
export function createUsageTracker() {
  const byModel = new Map();

  return {
    record(model, usage) {
      if (!usage) return;
      const key = model ?? 'unknown';
      const cur = byModel.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      cur.input += usage.input_tokens ?? 0;
      cur.output += usage.output_tokens ?? 0;
      cur.cacheRead += usage.cache_read_input_tokens ?? 0;
      cur.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      cur.calls += 1;
      byModel.set(key, cur);
    },
    snapshot() {
      const models = Object.fromEntries(byModel);
      const total = Object.values(models).reduce(
        (a, m) => ({
          input: a.input + m.input,
          output: a.output + m.output,
          cacheRead: a.cacheRead + m.cacheRead,
          cacheWrite: a.cacheWrite + m.cacheWrite,
          calls: a.calls + m.calls,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
      );
      return { models, total };
    },
    isEmpty: () => byModel.size === 0,
  };
}

export async function appendUsage(path, { provider, snapshot, candidates, stories }) {
  let existing = { runs: [] };
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    /* first run */
  }

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600e3;
  const runs = [
    ...(existing.runs ?? []).filter((r) => r.at >= cutoff),
    {
      at: Date.now(),
      provider,
      candidates,
      stories,
      ...snapshot.total,
      models: snapshot.models,
    },
  ];

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ updated_at: new Date().toISOString(), runs }, null, 2) + '\n');
}

/**
 * Plan-consumption context. Anthropic states Claude Code limits for Pro and Max
 * as ranges of Sonnet-hours per week rather than token counts, and the mapping
 * from tokens to hours depends heavily on how a session uses tools. These are
 * therefore deliberately wide order-of-magnitude bands, not precise figures —
 * the real answer is the trend line in your own measured runs below.
 */
export const PLAN_BANDS = {
  Pro: { low: 10_000_000, high: 20_000_000 },
  'Max 5x': { low: 35_000_000, high: 70_000_000 },
  'Max 20x': { low: 60_000_000, high: 120_000_000 },
};

/**
 * Measured baseline, so `npm run usage` is informative before the first live run
 * rather than just empty. Taken from the real prompts built against the live
 * feed list on 2026-08-19: 262 candidates triaged on Haiku plus one Sonnet
 * write. Re-measure if BATCH_SIZE, the track budgets, or the prompts change
 * substantially.
 */
export const BASELINE = { perDay: 84_811, measuredOn: '2026-08-19', candidates: 262 };

export function summarize(runs) {
  const week = Date.now() - 7 * 24 * 3600e3;
  const recent = runs.filter((r) => r.at >= week);
  if (recent.length === 0) return null;

  const tot = recent.reduce(
    (a, r) => ({
      input: a.input + (r.input ?? 0),
      output: a.output + (r.output ?? 0),
      cacheRead: a.cacheRead + (r.cacheRead ?? 0),
      cacheWrite: a.cacheWrite + (r.cacheWrite ?? 0),
      calls: a.calls + (r.calls ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
  );

  // Extrapolate to a full week if fewer than 7 days of data exist.
  const days = Math.max(1, Math.min(7, Math.ceil((Date.now() - Math.min(...recent.map((r) => r.at))) / 86400e3)));
  const perDay = (tot.input + tot.output + tot.cacheRead) / days;
  const weekly = perDay * 7;

  return {
    runs: recent.length,
    days,
    total: tot,
    perDay,
    weekly,
    plans: Object.entries(PLAN_BANDS).map(([name, b]) => ({
      name,
      low: (weekly / b.high) * 100,
      high: (weekly / b.low) * 100,
    })),
  };
}
