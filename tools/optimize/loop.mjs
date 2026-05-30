#!/usr/bin/env node
// loop.mjs — orchestrator *scaffold* for the optimization loop.
//
// This is a FOUNDATION, not an autonomous optimizer. It:
//   1. ensures a baseline snapshot exists (running measure.mjs if asked),
//   2. picks a hotspot fixture (the slowest, or one you name),
//   3. emits a structured "optimization candidate" artifact (JSON + markdown)
//      describing the hotspot, a hypothesis, the change to try, and the
//      accept/reject criterion.
//
// It does NOT mutate Rust source. A human or coding agent reads the candidate,
// applies the change to `crates/`, then runs `measure.mjs --label after` and
// `compare.mjs --base <baseline> --head after --target <fixture>` to accept or
// reject the change. The accept/reject decision (lib.mjs `decide`) is real and
// unit-tested (compare.mjs --selftest).
//
// Usage:
//   node tools/optimize/loop.mjs --baseline before                 # measure + candidate
//   node tools/optimize/loop.mjs --baseline before --no-bench      # reuse criterion run
//   node tools/optimize/loop.mjs --baseline before --target wildcard
//
// Flags:
//   --baseline <label>  baseline snapshot label (measured if missing)
//   --target <fixture>  force the hotspot fixture (default: slowest)
//   --no-bench          don't run cargo bench; read existing criterion estimates
//   --out <dir>         candidate output dir (default: tools/optimize/candidates)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  IMPROVEMENT_THRESHOLD,
  REGRESSION_THRESHOLD,
  parseArgs,
  snapshotPath,
} from './lib.mjs';

// A small library of generic, source-agnostic hypotheses to seed the human/AI
// applying the candidate. These are starting points, not prescriptions.
const HYPOTHESIS_BANK = [
  {
    hypothesis: 'Redundant filesystem stat/read calls during resolution dominate this fixture.',
    change: 'Add/extend a cache around realpath + read in the resolver so repeated lookups are memoized within a single trace.',
    where: 'crates/nftrs_core (resolver / fs layer)',
  },
  {
    hypothesis: 'The OXC AST is walked more than once (analysis + asset scan re-parse).',
    change: 'Share a single parsed AST between the analyzer passes instead of re-parsing per concern.',
    where: 'crates/nftrs_core (analyzer)',
  },
  {
    hypothesis: 'Hot path allocates Strings/PathBufs that could be borrowed or interned.',
    change: 'Profile with nftrs_profiler, then replace owned allocations on the hot path with borrows / a small string interner.',
    where: 'crates/nftrs_core + crates/nftrs_profiler',
  },
];

function loadSnapshot(label, dir) {
  const p = snapshotPath(label, dir);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function ensureBaseline(label, { noBench }) {
  let snap = loadSnapshot(label);
  if (snap) {
    console.error(`[loop] using existing baseline snapshot for "${label}"`);
    return snap;
  }
  const measureArgs = [path.join('tools', 'optimize', 'measure.mjs'), '--label', label];
  if (noBench) measureArgs.push('--no-bench');
  console.error(`[loop] measuring baseline: node ${measureArgs.join(' ')}`);
  execFileSync('node', measureArgs, { stdio: 'inherit' });
  snap = loadSnapshot(label);
  if (!snap) throw new Error(`measure did not produce a snapshot for "${label}"`);
  return snap;
}

// Pick the hotspot: the named fixture if given, else the slowest by mean-ns.
function pickHotspot(fixtures, forced) {
  const names = Object.keys(fixtures);
  if (forced) {
    if (!names.includes(forced)) {
      throw new Error(`--target "${forced}" not in snapshot (have: ${names.join(', ')})`);
    }
    return forced;
  }
  return names.reduce((slow, n) => (fixtures[n] > (fixtures[slow] ?? -1) ? n : slow), names[0]);
}

function pickHypothesis(fixture) {
  // Deterministic per-fixture pick so re-running is stable.
  let h = 0;
  for (const ch of fixture) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HYPOTHESIS_BANK[h % HYPOTHESIS_BANK.length];
}

function renderMarkdown(candidate) {
  const c = candidate;
  return [
    `# Optimization candidate — \`${c.hotspot.fixture}\``,
    '',
    `Generated: ${c.createdAt}`,
    `Baseline label: \`${c.baselineLabel}\``,
    '',
    '## Hotspot',
    `- Fixture: \`${c.hotspot.fixture}\``,
    `- Baseline mean: ${c.hotspot.meanNs.toFixed(0)} ns`,
    `- Rank: slowest #${c.hotspot.rank} of ${c.hotspot.total} fixtures`,
    '',
    '## Hypothesis',
    c.hypothesis,
    '',
    '## Change to try',
    `${c.change}`,
    '',
    `Likely location: ${c.where}`,
    '',
    '## Accept / reject criterion',
    `ACCEPT the change iff **both** hold (decided by \`compare.mjs\`):`,
    `1. No fixture regresses beyond **+${REGRESSION_THRESHOLD * 100}%**.`,
    `2. Target fixture \`${c.hotspot.fixture}\` improves beyond **-${IMPROVEMENT_THRESHOLD * 100}%**.`,
    '',
    'Otherwise REJECT and revert.',
    '',
    '## Apply / verify steps',
    '```sh',
    `# 1. (already done) baseline measured as "${c.baselineLabel}"`,
    `# 2. apply the change above to ${c.where}`,
    `# 3. re-measure`,
    `node tools/optimize/measure.mjs --label after`,
    `# 4. decide`,
    `node tools/optimize/compare.mjs --base ${c.baselineLabel} --head after --target ${c.hotspot.fixture}`,
    '```',
    '',
    '> Note: this artifact is applied by a human or coding agent. The loop does',
    '> not autonomously edit Rust source.',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselineLabel = typeof args.baseline === 'string' ? args.baseline : 'baseline';
  const outDir = typeof args.out === 'string' ? args.out : path.join('tools', 'optimize', 'candidates');
  const noBench = !!args['no-bench'];

  const snap = ensureBaseline(baselineLabel, { noBench });
  const fixtures = snap.fixtures;
  const hotspot = pickHotspot(fixtures, typeof args.target === 'string' ? args.target : null);

  const ranked = Object.keys(fixtures).sort((a, b) => fixtures[b] - fixtures[a]);
  const rank = ranked.indexOf(hotspot) + 1;
  const hint = pickHypothesis(hotspot);

  const candidate = {
    schema: 'nftrs.optimize.candidate/v1',
    createdAt: new Date().toISOString(),
    baselineLabel,
    hotspot: {
      fixture: hotspot,
      meanNs: fixtures[hotspot],
      rank,
      total: ranked.length,
    },
    hypothesis: hint.hypothesis,
    change: hint.change,
    where: hint.where,
    acceptCriterion: {
      regressionThreshold: REGRESSION_THRESHOLD,
      improvementThreshold: IMPROVEMENT_THRESHOLD,
      rule: 'no fixture regresses beyond regressionThreshold AND target fixture improves beyond improvementThreshold',
    },
    verify: {
      remeasure: `node tools/optimize/measure.mjs --label after`,
      decide: `node tools/optimize/compare.mjs --base ${baselineLabel} --head after --target ${hotspot}`,
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = candidate.createdAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `candidate-${hotspot}-${stamp}.json`);
  const mdPath = path.join(outDir, `candidate-${hotspot}-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(candidate, null, 2) + '\n');
  fs.writeFileSync(mdPath, renderMarkdown(candidate) + '\n');

  console.error(`[loop] hotspot: ${hotspot} (${fixtures[hotspot].toFixed(0)} ns, slowest #${rank})`);
  console.error(`[loop] wrote ${jsonPath}`);
  console.error(`[loop] wrote ${mdPath}`);
  console.log(jsonPath);
}

main();
