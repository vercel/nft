#!/usr/bin/env node
// Read criterion's base/new estimates (written by `cargo bench --baseline base`)
// and emit a markdown comparison table to stdout. Used by benchmark.yml to
// comment the per-PR `node_file_trace` performance delta.

import fs from 'node:fs';
import path from 'node:path';

const CRITERION_DIR = 'target/criterion/node_file_trace';
// A regression beyond this (slower) fails the gate; improvements are praised.
const REGRESSION_THRESHOLD = 0.1; // 10%

function readMeanNs(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'estimates.json'), 'utf8'));
    return j.mean.point_estimate; // nanoseconds
  } catch {
    return null;
  }
}

function fmt(ns) {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(1)} µs`;
  return `${(ns / 1e6).toFixed(2)} ms`;
}

function main() {
  if (!fs.existsSync(CRITERION_DIR)) {
    console.log('_No `node_file_trace` benchmark results found._');
    process.exit(0);
  }
  const rows = [];
  let worst = 0;
  for (const name of fs.readdirSync(CRITERION_DIR).sort()) {
    const dir = path.join(CRITERION_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const base = readMeanNs(path.join(dir, 'base'));
    const head = readMeanNs(path.join(dir, 'new'));
    if (base == null || head == null) continue;
    const change = (head - base) / base;
    worst = Math.max(worst, change);
    const sign = change > 0 ? '🔴 +' : change < 0 ? '🟢 ' : '';
    rows.push(`| \`${name}\` | ${fmt(base)} | ${fmt(head)} | ${sign}${(change * 100).toFixed(1)}% |`);
  }

  const lines = [
    '### 📊 Benchmark — `node_file_trace` (base → head)',
    '',
    '| fixture | base | head | change |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    worst > REGRESSION_THRESHOLD
      ? `⚠️ Worst regression **+${(worst * 100).toFixed(1)}%** exceeds the ${REGRESSION_THRESHOLD * 100}% threshold.`
      : `✅ No regression beyond ${REGRESSION_THRESHOLD * 100}%.`,
  ];
  console.log(lines.join('\n'));
  // Exit non-zero on regression so the job (and the gate) goes red.
  process.exit(worst > REGRESSION_THRESHOLD ? 1 : 0);
}

main();
