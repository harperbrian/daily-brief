#!/usr/bin/env node
/**
 * The golden set — the only test that distinguishes "personalized" from
 * "merely different."
 *
 * Everything in test/run.mjs checks MECHANISM: that the formula is monotone,
 * that caps hold, that flags are coerced. None of it can tell you whether the
 * fifteen stories that arrive each morning are the right fifteen. That is a
 * judgment only the reader can supply, so this captures it once and then tests
 * against it forever.
 *
 *   npm run label     build a labeling worksheet from a candidate dump
 *   npm run golden    score the current ranking against your labels
 *
 * The sampling matters. Showing only top-scoring candidates would surface just
 * FALSE POSITIVES — junk that got in. The more dangerous failure is a FALSE
 * NEGATIVE: a story that mattered and was silently rejected, which you would
 * never see because it never appeared. So the worksheet samples across the
 * whole score distribution, rejects included.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => join(ROOT, ...parts);
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;

const LABELS = {
  2: 'must surface — I would be annoyed to miss this',
  1: 'fine either way — no complaint if it appears or does not',
  0: 'suppress — this is noise for me',
};

const STOP = new Set('a an the and or but of to in on for with at by from as is are was were be been it its this that has have had after over into new says say said report reports'.split(' '));
/** Same shape as titleFingerprint in src/normalize.js — collapses one event's many articles. */
function fingerprint(title) {
  const w = String(title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((x) => x.length > 2 && !STOP.has(x));
  return [...new Set(w)].sort().slice(0, 6).join('-');
}

const mode = process.argv[2] ?? 'label';
if (mode === 'label') await buildWorksheet();
else await scoreAgainstLabels();

/** Most recent candidates-*.json in out/. */
async function latestDump() {
  const files = (await readdir(p('out'))).filter((f) => f.startsWith('candidates-') && f.endsWith('.json')).sort();
  if (!files.length) {
    console.log(`\n${B('No candidate dump found.')}\n`);
    console.log('  Generate one first:\n');
    console.log('    node src/index.js --dry-run --dump-candidates\n');
    console.log(dim('  Use a real model credential — a rule-based dump would teach the'));
    console.log(dim('  golden set the wrong distribution.\n'));
    process.exit(1);
  }
  return files[files.length - 1];
}

/**
 * Stratified sample across the score distribution. Every includable candidate is
 * shown (those are the decisions the system actually made), plus a spread from
 * each score band down to the tail — that band is where false negatives hide.
 */
async function buildWorksheet() {
  const file = await latestDump();
  const all = JSON.parse(await readFile(p('out', file), 'utf8'));
  const day = file.replace(/^candidates-|\.json$/g, '');

  // What actually reached the brief, which is NOT the same as what passed
  // triage. include_candidate is the scorer saying "this could earn a slot";
  // plenty of those then lose on rank, the category ceiling, or dedup. Labeling
  // against the triage flag measured the wrong decision entirely.
  // Match on brief.sections (the SELECTION data, which keeps the original
  // clean_title and event_key), never on brief.digest.sections — the writer
  // rewrites every headline, so digest titles will not match dump titles.
  let briefKeys = new Set();
  let briefTitles = new Set();
  try {
    const brief = JSON.parse(await readFile(p('out', `brief-${day}.json`), 'utf8'));
    for (const sec of brief.sections ?? []) {
      for (const st of sec.stories ?? []) {
        if (st.event_key) briefKeys.add(st.event_key);
        if (st.clean_title) briefTitles.add(st.clean_title);
      }
    }
  } catch {
    console.log(dim('  (no matching brief file — falling back to the triage flag)\n'));
  }
  const haveBrief = briefKeys.size > 0 || briefTitles.size > 0;
  const reachedBrief = (c) =>
    haveBrief ? (c.event_key ? briefKeys.has(c.event_key) : briefTitles.has(c.title)) : !!c.include;

  // Recomputed here rather than trusted from the dump. The field means "which
  // dimension drove the RANK", so it must be weighted by peak eligibility —
  // novelty is 8-10 on anything new and would otherwise win constantly while
  // contributing nothing. Recomputing also keeps older dumps usable.
  const prefs = JSON.parse(await readFile(p('config/preferences.json'), 'utf8'));
  const dimCfg = prefs.relevance?.dimensions ?? {};
  const topDim = (dims) => {
    let best = null;
    let bestVal = -1;
    for (const [d, v] of Object.entries(dims ?? {})) {
      const contribution = (v ?? 0) * (dimCfg[d]?.peak_eligibility ?? 1);
      if (contribution > bestVal) { bestVal = contribution; best = d; }
    }
    return best;
  };

  // Collapse near-duplicate coverage of one event before labeling. On a busy
  // day ten outlets carry the same tariff story; asking you to label all ten
  // wastes the pass and produces contradictory labels on a single event, which
  // then reads as both a miss and a false positive.
  // Prefer the scorer's event_key: it is semantic, so it groups "U.S.-Canada
  // talks collapse" with "United States imposes 50% tariffs" — which a lexical
  // fingerprint does not, as this exact case proved. Falls back to the
  // fingerprint only for dumps written before event_key was recorded.
  const usingKeys = all.some((c) => c.event_key);
  const seen = new Map();
  const deduped = [];
  for (const c of [...all].sort((a, b) => b.total - a.total)) {
    const key = usingKeys && c.event_key ? c.event_key : fingerprint(c.title);
    if (seen.has(key)) { seen.get(key)._dupes = (seen.get(key)._dupes ?? 0) + 1; continue; }
    seen.set(key, c);
    deduped.push(c);
  }
  if (!usingKeys) {
    console.log(dim('  (dump predates event_key — dedup is lexical and will miss'));
    console.log(dim('   differently-worded coverage of one event; the next run fixes this)\n'));
  }

  const sorted = deduped;
  const included = sorted.filter(reachedBrief);
  const rest = sorted.filter((c) => !reachedBrief(c));

  // Bands over the rejected pool, so the sample is not all near-misses.
  const bands = [
    { name: 'near miss', from: 0.0, to: 0.15, take: 12 },
    { name: 'middle', from: 0.15, to: 0.5, take: 10 },
    { name: 'low', from: 0.5, to: 1.0, take: 8 },
  ];
  const sampled = [];
  for (const band of bands) {
    const slice = rest.slice(Math.floor(rest.length * band.from), Math.floor(rest.length * band.to));
    const step = Math.max(1, Math.floor(slice.length / band.take));
    for (let i = 0; i < slice.length && sampled.length < 200; i += step) {
      sampled.push({ ...slice[i], _band: band.name });
      if (sampled.filter((s) => s._band === band.name).length >= band.take) break;
    }
  }

  const rows = [
    ...included.map((c) => ({ ...c, _band: 'SELECTED' })),
    ...sampled,
  ];

  const out = {
    _instructions: [
      'Label every row below by replacing null with 2, 1, or 0.',
      '',
      '  2 = must surface. I would be annoyed to miss this.',
      '  1 = fine either way. No complaint if it appears or does not.',
      '  0 = suppress. This is noise for me.',
      '',
      'Judge on YOUR interests, not on general newsworthiness — that is the',
      'whole point. A major world event with no line to your money, career,',
      'rental property, or family is a 0 or 1, not a 2.',
      '',
      'Rows marked SELECTED are what the system actually chose. Rows marked',
      'near miss / middle / low were REJECTED — those are the important ones.',
      'A 2 on a rejected row is a false negative, the failure you would never',
      'otherwise see.',
      '',
      'Aim for roughly a 30-minute pass. Partial labeling is fine; unlabeled',
      'rows are skipped. When done: npm run golden',
    ],
    _labels: LABELS,
    day,
    generated_at: new Date().toISOString(),
    rows: rows.map((c) => ({
      label: null,
      title: c.title,
      source: c.source,
      why_the_system_thought_so: c.why || '',
      snippet: c.snippet || '',
      url: c.url || '',
      _system: {
        band: c._band,
        selected: reachedBrief(c),
        passed_triage: !!c.include,
        similar_articles: c._dupes ?? 0,
        total: c.total,
        top_dimension: topDim(c.dims) ?? c.top,
        category: c.category,
        geography: c.geography,
      },
    })),
  };

  const path = p('state', `golden-${day}.json`);

  // Never destroy labeling work. Regenerating a worksheet used to overwrite it
  // wholesale, which silently threw away a completed pass — labels are the one
  // artifact here that cannot be recomputed, only re-earned by hand. Existing
  // labels are carried forward by title, and anything that no longer appears in
  // the sample is preserved in a retired list rather than dropped.
  let carried = 0;
  try {
    const prior = JSON.parse(await readFile(path, 'utf8'));
    const byTitle = new Map((prior.rows ?? []).filter((r) => r.label !== null).map((r) => [r.title, r.label]));
    if (byTitle.size) {
      for (const row of out.rows) {
        if (byTitle.has(row.title)) { row.label = byTitle.get(row.title); carried++; byTitle.delete(row.title); }
      }
      // Rows that fell out of the sample keep their labels here, so a later run
      // can still fold them back in.
      const retired = [...(prior._retired ?? [])];
      for (const [title, label] of byTitle) retired.push({ title, label });
      if (retired.length) out._retired = retired;
    }
  } catch {
    /* no prior worksheet */
  }

  await writeFile(path, JSON.stringify(out, null, 2) + '\n');

  console.log(`\n${B('Labeling worksheet ready')}\n`);
  console.log(`  ${path.replace(ROOT + '/', '')}`);
  console.log(`  ${rows.length} rows: ${included.length} that reached your brief, ${sampled.length} that did not`);
  if (carried) console.log(GREEN(`  ${carried} existing label(s) carried forward — nothing was lost`));
  console.log(dim(`  (${all.length - deduped.length} near-duplicate articles collapsed away)\n`));
  console.log('  Open it, replace each "label": null with 2, 1, or 0, save, then:\n');
  console.log('    npm run golden\n');
  console.log(dim('  The rejected rows matter most. A 2 on one of those is a story you'));
  console.log(dim('  would have missed and never known about.\n'));
}

/**
 * Measures whether the ranking agrees with the labels. Deliberately reports
 * false negatives first: a story wrongly included is a minor annoyance you can
 * see, while a story wrongly excluded is invisible and therefore worse.
 */
async function scoreAgainstLabels() {
  const files = (await readdir(p('state'))).filter((f) => f.startsWith('golden-') && f.endsWith('.json')).sort();
  if (!files.length) {
    console.log(`\n${B('No labeled set found.')} Run ${GREEN('npm run label')} first.\n`);
    process.exit(1);
  }

  let labeled = [];
  let retired = 0;
  for (const f of files) {
    const g = JSON.parse(await readFile(p('state', f), 'utf8'));
    labeled.push(...(g.rows ?? []).filter((r) => r.label === 0 || r.label === 1 || r.label === 2));
    retired += (g._retired ?? []).length;
  }
  if (retired) console.log(dim(`  (${retired} label(s) retained from earlier samples but not in the current one)`));

  if (labeled.length === 0) {
    console.log(`\n${B('Worksheet found, but nothing is labeled yet.')}\n`);
    console.log(`  Edit ${dim('state/golden-*.json')} and replace "label": null with 2, 1, or 0.\n`);
    process.exit(1);
  }

  const must = labeled.filter((r) => r.label === 2);
  const noise = labeled.filter((r) => r.label === 0);

  // The two failures that matter, named for what they cost you.
  const missed = must.filter((r) => !r._system.selected);
  const wrongfullyIncluded = noise.filter((r) => r._system.selected);

  const recall = must.length ? (must.length - missed.length) / must.length : null;
  const precision = (() => {
    const sel = labeled.filter((r) => r._system.selected);
    if (!sel.length) return null;
    return sel.filter((r) => r.label >= 1).length / sel.length;
  })();

  // Does score actually track your judgment? Mean score per label band.
  const meanScore = (n) => {
    const rows = labeled.filter((r) => r.label === n);
    return rows.length ? rows.reduce((a, r) => a + r._system.total, 0) / rows.length : null;
  };

  console.log(`\n${B('Golden set')} ${dim(`— ${labeled.length} labeled across ${files.length} day(s)`)}\n`);
  console.log(`  must surface (2):  ${must.length}`);
  console.log(`  fine either way:   ${labeled.filter((r) => r.label === 1).length}`);
  console.log(`  suppress (0):      ${noise.length}\n`);

  console.log(B('Does the score track your judgment?'));
  for (const n of [2, 1, 0]) {
    const m = meanScore(n);
    console.log(`  label ${n} (${LABELS[n].split(' —')[0].padEnd(16)}) mean score ${m === null ? 'n/a' : m.toFixed(1)}`);
  }
  // Compare only the bands that actually have labels. A missing middle band is
  // common on a partial pass and previously reported a correct ordering as
  // inverted, which is worse than saying nothing.
  const present = [2, 1, 0].filter((n) => meanScore(n) !== null);
  const ordered = present.every((n, i) => i === 0 || meanScore(present[i - 1]) > meanScore(n));
  if (present.length < 2) {
    console.log(`  ${dim('not enough label variety to judge ordering yet')}\n`);
  } else {
    const scope = present.length === 3 ? '' : dim(` (comparing labels ${present.join(' and ')} only)`);
    console.log(`  ${ordered ? GREEN('✓ ordering holds') : RED('✗ ordering is inverted — ranking is not tracking you')}${scope}\n`);
  }

  console.log(B('The failure that matters most: stories you would have missed'));
  if (!missed.length) {
    console.log(`  ${GREEN('none')} — every "must surface" story was selected\n`);
  } else {
    console.log(`  ${RED(`${missed.length} of ${must.length}`)} "must surface" stories never reached you:\n`);
    for (const r of missed.slice(0, 12)) {
      // Two different failures wearing the same face. The scorer rejecting a
      // story is a relevance problem; the scorer accepting it and selection
      // dropping it is a rank, ceiling or slot-pressure problem. They need
      // opposite fixes, so never report them as one number.
      const why = r._system.passed_triage ? YELLOW('lost on rank ') : RED('scored out   ');
      console.log(`    ${why} ${String(r._system.total).padStart(4)}  ${dim(`[${r._system.category}/${r._system.top_dimension}]`)} ${r.title.slice(0, 56)}`);
    }
    console.log();
    console.log(dim(`    "scored out" = the scorer judged it irrelevant → a relevance problem.`));
    console.log(dim(`    "lost on rank" = it qualified but lost a slot → a ranking or ceiling problem.\n`));
    diagnose(missed);
  }

  console.log(B('The lesser failure: noise that got through'));
  if (!wrongfullyIncluded.length) {
    console.log(`  ${GREEN('none')} — nothing labeled "suppress" was selected\n`);
  } else {
    console.log(`  ${YELLOW(`${wrongfullyIncluded.length}`)} selected stories you labeled as noise:\n`);
    for (const r of wrongfullyIncluded.slice(0, 8)) {
      console.log(`    score ${String(r._system.total).padStart(4)}  ${dim(`[${r._system.category}/${r._system.top_dimension}]`)} ${r.title.slice(0, 62)}`);
    }
    console.log();
  }

  if (recall !== null) console.log(`  ${B('recall')}    ${(recall * 100).toFixed(0)}% of what you wanted was surfaced`);
  if (precision !== null) console.log(`  ${B('precision')} ${(precision * 100).toFixed(0)}% of what was surfaced you wanted`);
  console.log();
}

/**
 * Turns misses into a specific config change rather than a vague "tune it".
 * A miss is almost always one of three things: the floor is too high, a
 * dimension is underweighted, or the story was never retrieved at all.
 */
function diagnose(missed) {
  console.log(B('  What to change'));

  // The two failures need opposite fixes, so diagnose them separately rather
  // than reasoning from the score alone. A story the scorer rejected never
  // reached the floor at all, so the floor is irrelevant to it.
  const scoredOut = missed.filter((r) => !r._system.passed_triage);
  const lostOnRank = missed.filter((r) => r._system.passed_triage);

  if (scoredOut.length) {
    console.log(`    ${scoredOut.length} were SCORED OUT — the scorer judged them irrelevant to you.`);
    console.log(`    ${YELLOW('→')} This is a prompt problem, not a threshold or weight problem. The`);
    console.log(`      fix is in prompts/scoring_prompt.txt: the dimension that should`);
    console.log(`      have fired either is not described, or is described too narrowly`);
    console.log(`      to cover this case.`);
  }
  if (lostOnRank.length) {
    const highest = Math.max(...lostOnRank.map((r) => r._system.total));
    console.log(`    ${lostOnRank.length} LOST ON RANK — they qualified but did not win a slot.`);
    if (highest < 15) {
      console.log(`    ${YELLOW('→')} Highest was ${highest}, under the MIN_SCORE of 15. Lowering it to`);
      console.log(`      about ${Math.max(5, highest - 2)} would let them compete.`);
    } else {
      console.log(`    ${YELLOW('→')} Highest was ${highest}, above the floor — so this is weights, the`);
      console.log(`      daily category ceiling, or simple slot pressure.`);
    }
  }

  const byDim = {};
  for (const r of missed) byDim[r._system.top_dimension] = (byDim[r._system.top_dimension] ?? 0) + 1;
  const ranked = Object.entries(byDim).sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    console.log(`\n    Misses cluster on these dimensions:`);
    for (const [d, n] of ranked.slice(0, 4)) console.log(`      ${d.padEnd(22)} ${n}`);

    // Novelty, geography and magnitude are modifiers on purpose — they can
    // never be grounds for inclusion. If misses cluster there, raising their
    // weight is the wrong fix and would undo the anti-engagement rule.
    const MODIFIERS = new Set(['novelty', 'geographic', 'magnitude']);
    if (MODIFIERS.has(ranked[0][0])) {
      console.log(`    ${YELLOW('→')} "${ranked[0][0]}" is a MODIFIER by design and cannot carry a story.`);
      console.log(`      Do not raise its weight. These misses scored on nothing else,`);
      console.log(`      which usually means the scoring prompt is not recognizing why`);
      console.log(`      they matter — check whether they belong to an interest the`);
      console.log(`      prompt describes at all.`);
    } else {
      console.log(`    ${YELLOW('→')} If one dominates, raise its weight in config/preferences.json`);
      console.log(`      (relevance.dimensions.<name>.weight) and re-run.`);
    }
  }

  const byCat = {};
  for (const r of missed) byCat[r._system.category] = (byCat[r._system.category] ?? 0) + 1;
  const catRanked = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  if (catRanked.length && catRanked[0][1] >= 3) {
    console.log(`\n    ${YELLOW('→')} "${catRanked[0][0]}" accounts for ${catRanked[0][1]} misses. Check whether that`);
    console.log(`      category is hitting the daily ceiling (allocation.daily_ceiling).`);
  }
  console.log();
}
