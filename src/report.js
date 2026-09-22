#!/usr/bin/env node
/**
 * Two reports, both read-only:
 *
 *   npm run usage    what the brief actually consumed, and what that means for a plan
 *   npm run tuning   what your More/Less clicks have taught it so far
 *
 * `tuning` exists so the learned state is never a black box — you should be able
 * to see exactly why a source stopped showing up, and undo it.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarize, PLAN_BANDS, BASELINE } from './usage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => join(ROOT, ...parts);
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const n = (x) => Math.round(x).toLocaleString();

const mode = process.argv[2] ?? 'usage';
const readJson = async (rel, fallback) => {
  try {
    return JSON.parse(await readFile(p(rel), 'utf8'));
  } catch {
    return fallback;
  }
};

if (mode === 'usage') await usageReport();
else await tuningReport();

async function usageReport() {
  const { runs } = await readJson('state/usage.json', { runs: [] });
  if (!runs.length) {
    console.log(`\n${B('Nothing consumed yet — this is expected.')}\n`);
    console.log('  Usage is recorded only after a real send that used a model.');
    console.log('  Dry runs and rule-based mode consume nothing, so there is');
    console.log('  nothing to report until the first live GitHub Actions run.\n');
    console.log(`  ${B('Expected once running')} ${dim('(measured against the live feed list)')}\n`);
    console.log(`    per day        ~${n(BASELINE.perDay)} tokens`);
    console.log(`    per week       ~${n(BASELINE.perDay * 7)} tokens\n`);
    for (const [name, band] of Object.entries(PLAN_BANDS)) {
      const weekly = BASELINE.perDay * 7;
      const lo = ((weekly / band.high) * 100).toFixed(1);
      const hi = ((weekly / band.low) * 100).toFixed(1);
      console.log(`    ${name.padEnd(9)} roughly ${lo}-${hi}% of the weekly allowance`);
    }
    console.log(`\n${dim('  Come back after a few live runs and this will show real numbers')}`);
    console.log(`${dim('  instead of this projection.')}\n`);
    return;
  }

  const s = summarize(runs);
  console.log(`\n${B('Token usage')} ${dim(`— ${s.runs} run(s) over ${s.days} day(s)`)}\n`);
  console.log(`  input          ${n(s.total.input).padStart(12)}`);
  if (s.total.cacheRead) console.log(`  cached input   ${n(s.total.cacheRead).padStart(12)} ${dim('(billed at a discount)')}`);
  console.log(`  output         ${n(s.total.output).padStart(12)}`);
  console.log(`  model calls    ${n(s.total.calls).padStart(12)}`);
  console.log(`\n  ${B('per day')}        ${n(s.perDay).padStart(12)} tokens`);
  console.log(`  ${B('per week')}       ${n(s.weekly).padStart(12)} tokens`);

  console.log(`\n${B('Estimated share of a weekly plan limit')}`);
  console.log(dim('  Anthropic publishes Pro/Max limits as ranges of usage hours, not tokens,'));
  console.log(dim('  so these are wide bands, not precise figures. They also assume Sonnet;'));
  console.log(dim('  triage runs on Haiku, which draws on the plan far more slowly, so real'));
  console.log(dim('  consumption trends toward the low end or below it.\n'));
  for (const plan of s.plans) {
    const lo = plan.low < 0.1 ? '<0.1' : plan.low.toFixed(1);
    const hi = plan.high < 0.1 ? '<0.1' : plan.high.toFixed(1);
    console.log(`  ${plan.name.padEnd(9)} roughly ${lo}–${hi}% of the weekly allowance`);
  }

  const recent = runs.slice(-7).reverse();
  console.log(`\n${B('Recent runs')}`);
  for (const r of recent) {
    const d = new Date(r.at).toISOString().slice(0, 10);
    console.log(
      `  ${d}  ${String(r.provider ?? '?').padEnd(12)} ${String(n((r.input ?? 0) + (r.cacheRead ?? 0))).padStart(8)} in  ${String(n(r.output ?? 0)).padStart(7)} out  ${dim(`${r.candidates ?? '?'} candidates → ${r.stories ?? '?'} stories`)}`
    );
  }
  console.log();
}

async function tuningReport() {
  const h = await readJson('state/history.json', {});
  const w = h.feedbackWeights ?? {};
  const logEntries = h.feedbackLog ?? [];

  console.log(`\n${B('What your feedback has taught it')}\n`);

  const buckets = [
    ['Sources', w.sources ?? {}],
    ['Categories', w.categories ?? {}],
    ['Geographies', w.geographies ?? {}],
  ];

  let any = false;
  for (const [label, obj] of buckets) {
    const rows = Object.entries(obj)
      .filter(([, v]) => v !== 0)
      .sort((a, b) => b[1] - a[1]);
    if (!rows.length) continue;
    any = true;
    console.log(`  ${B(label)}`);
    for (const [key, val] of rows) {
      const bar = val > 0 ? '\x1b[32m' + '+'.repeat(Math.min(8, Math.abs(val))) : '\x1b[31m' + '-'.repeat(Math.min(8, Math.abs(val)));
      console.log(`    ${String(key).padEnd(34)} ${String(val > 0 ? '+' + val : val).padStart(4)}  ${bar}\x1b[0m`);
    }
    console.log();
  }

  if (!any) {
    console.log(dim('  Nothing learned yet — no More/Less clicks have been processed.\n'));
  }

  const muted = Object.entries(h.muted ?? {}).filter(([, until]) => until > Date.now());
  if (muted.length) {
    console.log(`  ${B('Muted')}`);
    for (const [cat, until] of muted) {
      const days = Math.ceil((until - Date.now()) / 86400e3);
      console.log(`    ${cat.padEnd(34)} ${days} more day(s)`);
    }
    console.log();
  }

  if (logEntries.length) {
    console.log(`  ${B('Recent signals')}`);
    for (const e of logEntries.slice(-10).reverse()) {
      const d = new Date(e.at).toISOString().slice(0, 10);
      const mark = e.action === 'more' ? '\x1b[32m+\x1b[0m' : e.action === 'less' ? '\x1b[31m−\x1b[0m' : '\x1b[33mm\x1b[0m';
      console.log(`    ${d} ${mark} ${String(e.title ?? '').slice(0, 58)}`);
    }
    console.log();
  }

  // Signals that deliberately do NOT act on ranking. Showing them separately is
  // the point: each fixed something different, and collapsing them into one
  // weight table would hide that.
  const overrides = Object.entries(h.sourceOverrides ?? {});
  if (overrides.length) {
    console.log(`  ${B('Source demotions')} ${dim('(from "bad source")')}`);
    for (const [feed, rungs] of overrides) console.log(`    ${feed.padEnd(34)} down ${rungs} rung(s)`);
    console.log();
  }

  const complaints = Object.entries(h.feedComplaints ?? {}).filter(([, n]) => n >= 3);
  if (complaints.length) {
    console.log(`  ${B('Removal candidates')} ${dim('(flagged irrelevant repeatedly)')}`);
    for (const [feed, n] of complaints) console.log(`    ${feed.padEnd(34)} ${n} complaints — consider removing from config/feeds.json`);
    console.log();
  }

  const verbosity = Object.entries(h.verbosityHints ?? {});
  if (verbosity.length) {
    console.log(`  ${B('Length preferences')} ${dim('(from "too detailed")')}`);
    for (const [cat, level] of verbosity) console.log(`    ${cat.padEnd(34)} ${level}`);
    console.log();
  }

  const quiet = Object.keys(h.quietThreads ?? {});
  if (quiet.length) {
    console.log(`  ${B('Quieted threads')} ${dim('(from "already knew this" — resurface only on a real change)')}`);
    for (const k of quiet.slice(-6)) console.log(`    ${k}`);
    console.log();
  }

  // Suggested only, never applied. Auto-tuning ten weights from a handful of
  // clicks overfits badly and destroys any ability to explain a ranking.
  const important = Object.entries(h.importantDimensions ?? {}).sort((a, b) => b[1] - a[1]);
  if (important.length >= 3) {
    const total = important.reduce((n, [, v]) => n + v, 0);
    console.log(`  ${B('Weight suggestions')} ${dim(`(from ${total} "very important" clicks — suggested only, never auto-applied)`)}`);
    for (const [dimName, n] of important) {
      const share = ((n / total) * 100).toFixed(0);
      console.log(`    ${dimName.padEnd(34)} ${String(n).padStart(2)} clicks (${share}% of them)`);
    }
    console.log(dim('    If a dimension dominates here but carries a small weight in'));
    console.log(dim('    config/preferences.json, that is the weight worth raising.\n'));
  }

  console.log(dim('  To reset: edit feedbackWeights in state/history.json.'));
  console.log(dim('  For durable preferences, edit config/preferences.json instead —'));
  console.log(dim('  feedback nudges ranking, preferences define it.\n'));
}
