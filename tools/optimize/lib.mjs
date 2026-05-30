// Shared helpers for the AI optimization loop tooling.
//
// The estimates math here is the same as `.github/scripts/compare-bench.mjs`:
// criterion records each benchmark's distribution in `estimates.json`, and we
// compare the `mean.point_estimate` (nanoseconds) between two runs. This file
// is the single source of truth for that math so `measure.mjs`, `compare.mjs`,
// and `loop.mjs` don't each re-derive it.

import fs from 'node:fs';
import path from 'node:path';

// Group criterion uses for the trace bench (`benchmark_group("node_file_trace")`).
export const CRITERION_GROUP = 'node_file_trace';
export const CRITERION_DIR = path.join('target', 'criterion', CRITERION_GROUP);

// A fixture that gets >10% slower fails the gate; same threshold as the CI
// benchmark job and `compare-bench.mjs`.
export const REGRESSION_THRESHOLD = 0.1; // +10%
// A fixture is only counted as a genuine improvement past this much faster, so
// run-to-run noise doesn't masquerade as a win.
export const IMPROVEMENT_THRESHOLD = 0.02; // -2%

// Read criterion's mean point-estimate (ns) for one fixture+baseline dir.
// Returns null when the file is missing/unreadable, matching compare-bench.mjs.
export function readMeanNs(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'estimates.json'), 'utf8'));
    return j.mean.point_estimate; // nanoseconds
  } catch {
    return null;
  }
}

// Format nanoseconds the way compare-bench.mjs does.
export function fmt(ns) {
  if (ns == null) return 'n/a';
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(1)} µs`;
  return `${(ns / 1e6).toFixed(2)} ms`;
}

// Read every fixture's mean-ns for a given criterion baseline label, producing
// a `{ fixture: meanNs }` map. `--save-baseline <label>` writes results under
// `target/criterion/node_file_trace/<fixture>/<label>/estimates.json`.
export function readSnapshotFromCriterion(label, criterionDir = CRITERION_DIR) {
  const fixtures = {};
  if (!fs.existsSync(criterionDir)) return fixtures;
  for (const name of fs.readdirSync(criterionDir).sort()) {
    const dir = path.join(criterionDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const mean = readMeanNs(path.join(dir, label));
    if (mean != null) fixtures[name] = mean;
  }
  return fixtures;
}

// Classify a single fixture's base->head change. `change` is the fractional
// delta `(head - base) / base` (positive = slower).
export function classify(change) {
  if (change > REGRESSION_THRESHOLD) return 'regressed';
  if (change < -IMPROVEMENT_THRESHOLD) return 'improved';
  return 'neutral';
}

// Core accept/reject logic, kept pure so it is trivially testable.
//
// Inputs are two snapshots `{ fixture: meanNs }` and the name of the fixture
// the candidate optimization is targeting. Returns a structured verdict.
//
// Decision rule (the candidate's accept criterion):
//   ACCEPT  iff  no fixture regresses beyond REGRESSION_THRESHOLD
//           AND  the target fixture improves beyond IMPROVEMENT_THRESHOLD.
//   REJECT  otherwise.
export function decide(baseSnap, headSnap, targetFixture) {
  const fixtures = [...new Set([...Object.keys(baseSnap), ...Object.keys(headSnap)])].sort();
  const perFixture = [];
  let worstRegression = 0; // most-positive change
  let anyRegression = false;

  for (const name of fixtures) {
    const base = baseSnap[name] ?? null;
    const head = headSnap[name] ?? null;
    let change = null;
    let verdict = 'missing';
    if (base != null && head != null) {
      change = (head - base) / base;
      verdict = classify(change);
      if (change > worstRegression) worstRegression = change;
      if (verdict === 'regressed') anyRegression = true;
    }
    perFixture.push({ fixture: name, base, head, change, verdict });
  }

  const target = perFixture.find((r) => r.fixture === targetFixture) ?? null;
  const targetImproved = target != null && target.verdict === 'improved';
  const targetKnown = target != null && target.change != null;

  // The gate (used by compare.mjs): pass iff nothing regressed past threshold.
  const gate = anyRegression ? 'fail' : 'pass';

  // The accept decision (used by loop.mjs): both conditions must hold.
  let accept = false;
  let reason;
  if (targetFixture == null) {
    // No target supplied: this is a pure regression gate (compare mode).
    accept = !anyRegression;
    reason = accept
      ? 'no fixture regressed beyond threshold'
      : 'a fixture regressed beyond threshold';
  } else if (!targetKnown) {
    reason = `target fixture "${targetFixture}" not present in both snapshots`;
  } else if (anyRegression) {
    reason = 'a fixture regressed beyond the 10% threshold';
  } else if (!targetImproved) {
    reason = `target fixture "${targetFixture}" did not improve beyond ${IMPROVEMENT_THRESHOLD * 100}%`;
  } else {
    accept = true;
    reason = `target fixture "${targetFixture}" improved and no fixture regressed`;
  }

  return {
    targetFixture: targetFixture ?? null,
    decision: accept ? 'accept' : 'reject',
    gate,
    accept,
    reason,
    worstRegression,
    targetChange: target?.change ?? null,
    perFixture,
  };
}

// Render a base->head delta table (markdown) from a decide() result.
export function renderTable(verdict, { baseLabel = 'base', headLabel = 'head' } = {}) {
  const emoji = { improved: '🟢', regressed: '🔴', neutral: '⚪️', missing: '⚠️' };
  const rows = verdict.perFixture.map((r) => {
    const change = r.change == null ? 'n/a' : `${r.change > 0 ? '+' : ''}${(r.change * 100).toFixed(1)}%`;
    const star = r.fixture === verdict.targetFixture ? ' 🎯' : '';
    return `| \`${r.fixture}\`${star} | ${fmt(r.base)} | ${fmt(r.head)} | ${emoji[r.verdict]} ${change} (${r.verdict}) |`;
  });
  return [
    `| fixture | ${baseLabel} | ${headLabel} | change |`,
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

// Locate a snapshot JSON written by measure.mjs, given a label.
export function snapshotPath(label, dir = path.join('tools', 'optimize', 'snapshots')) {
  return path.join(dir, `${label}.json`);
}

// Tiny argv parser: `--key value` and `--flag` -> { key: value, flag: true }.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}
