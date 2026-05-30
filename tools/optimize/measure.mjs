#!/usr/bin/env node
// measure.mjs — run the `trace` criterion benchmark, save a named criterion
// baseline, and snapshot the per-fixture mean-ns into a JSON report under
// `tools/optimize/snapshots/<label>.json`.
//
// Usage:
//   node tools/optimize/measure.mjs --label before
//   node tools/optimize/measure.mjs --label after --no-bench   # reuse last run
//
// Flags:
//   --label <name>   criterion baseline label + snapshot filename (default: ts)
//   --no-bench       skip `cargo bench`, just read existing criterion estimates
//   --out <dir>      snapshot output dir (default: tools/optimize/snapshots)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { parseArgs, readSnapshotFromCriterion, snapshotPath } from './lib.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = typeof args.label === 'string' ? args.label : new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = typeof args.out === 'string' ? args.out : path.join('tools', 'optimize', 'snapshots');

  if (!args['no-bench']) {
    // `--save-baseline <label>` makes criterion persist this run under
    // target/criterion/node_file_trace/<fixture>/<label>/estimates.json.
    const benchArgs = ['bench', '--bench', 'trace', '--', '--save-baseline', label];
    console.error(`[measure] cargo ${benchArgs.join(' ')}`);
    execFileSync('cargo', benchArgs, { stdio: 'inherit' });
  } else {
    console.error('[measure] --no-bench: reading existing criterion estimates');
  }

  const fixtures = readSnapshotFromCriterion(label);
  const names = Object.keys(fixtures);
  if (names.length === 0) {
    console.error(
      `[measure] no estimates found for label "${label}". Did the bench run? ` +
        `Expected target/criterion/node_file_trace/<fixture>/${label}/estimates.json`,
    );
    process.exit(1);
  }

  const report = {
    label,
    createdAt: new Date().toISOString(),
    unit: 'ns',
    metric: 'mean.point_estimate',
    group: 'node_file_trace',
    fixtures,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const out = snapshotPath(label, outDir);
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.error(`[measure] wrote ${out} (${names.length} fixtures)`);
  console.log(out);
}

main();
