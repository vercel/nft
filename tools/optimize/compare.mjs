#!/usr/bin/env node
// compare.mjs — diff two labeled snapshots produced by measure.mjs and emit a
// human table plus a machine-readable verdict (improved/regressed/neutral per
// fixture, and an overall pass/fail gate). Reuses the estimates/threshold math
// from lib.mjs (the same logic compare-bench.mjs uses on raw criterion dirs).
//
// Usage:
//   node tools/optimize/compare.mjs --base before --head after
//   node tools/optimize/compare.mjs --base before --head after --target wildcard --json
//   node tools/optimize/compare.mjs --selftest
//
// Flags:
//   --base <label>    baseline snapshot label
//   --head <label>    candidate snapshot label
//   --target <fix>    fixture the optimization targets (affects accept decision)
//   --json            print only the machine-readable verdict JSON
//   --selftest        run the built-in accept/reject tests and exit
//   --dir <dir>       snapshot dir (default: tools/optimize/snapshots)

import fs from 'node:fs';

import { decide, parseArgs, renderTable, snapshotPath } from './lib.mjs';
import { runSelftest } from './selftest.mjs';

function loadSnapshot(label, dir) {
  const p = snapshotPath(label, dir);
  if (!fs.existsSync(p)) {
    console.error(`[compare] snapshot not found: ${p} (run measure.mjs --label ${label})`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.selftest) {
    process.exit(runSelftest() ? 0 : 1);
  }

  const dir = typeof args.dir === 'string' ? args.dir : undefined;
  const baseLabel = args.base;
  const headLabel = args.head;
  if (typeof baseLabel !== 'string' || typeof headLabel !== 'string') {
    console.error('[compare] --base <label> and --head <label> are required (or use --selftest)');
    process.exit(2);
  }
  const target = typeof args.target === 'string' ? args.target : null;

  const base = loadSnapshot(baseLabel, dir);
  const head = loadSnapshot(headLabel, dir);
  const verdict = decide(base.fixtures, head.fixtures, target);

  if (args.json) {
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(verdict.gate === 'pass' ? 0 : 1);
  }

  const lines = [
    `### Benchmark comparison — \`${baseLabel}\` → \`${headLabel}\``,
    '',
    renderTable(verdict, { baseLabel, headLabel }),
    '',
    `Gate: **${verdict.gate.toUpperCase()}** (worst regression ${(verdict.worstRegression * 100).toFixed(1)}%)`,
  ];
  if (target != null) {
    lines.push(`Decision (target \`${target}\`): **${verdict.decision.toUpperCase()}** — ${verdict.reason}`);
  }
  console.log(lines.join('\n'));
  // Non-zero exit on a regression gate failure, mirroring compare-bench.mjs.
  process.exit(verdict.gate === 'pass' ? 0 : 1);
}

main();
