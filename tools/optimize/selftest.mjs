// selftest.mjs — synthetic-snapshot tests for the accept/reject decision logic
// in lib.mjs. No benchmark run needed; this proves the gate math is correct.
//
// Run via: node tools/optimize/compare.mjs --selftest

import { classify, decide, IMPROVEMENT_THRESHOLD, REGRESSION_THRESHOLD } from './lib.mjs';

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

// Baseline snapshot every case diffs against (mean-ns per fixture).
const BASE = { a: 1000, b: 2000, c: 3000 };

export function runSelftest() {
  console.log('[selftest] accept/reject decision logic');

  // --- classify() boundaries -------------------------------------------------
  check('classify: big slowdown is regressed', classify(REGRESSION_THRESHOLD + 0.01) === 'regressed');
  check('classify: at regression threshold is neutral', classify(REGRESSION_THRESHOLD) === 'neutral');
  check('classify: big speedup is improved', classify(-(IMPROVEMENT_THRESHOLD + 0.01)) === 'improved');
  check('classify: tiny speedup is neutral', classify(-(IMPROVEMENT_THRESHOLD / 2)) === 'neutral');
  check('classify: no change is neutral', classify(0) === 'neutral');

  // --- ACCEPT: target improves, nothing regresses ----------------------------
  {
    const head = { a: 800, b: 2000, c: 3000 }; // a is 20% faster
    const v = decide(BASE, head, 'a');
    check('accept when target improves & no regression', v.accept === true && v.decision === 'accept');
    check('accept => gate pass', v.gate === 'pass');
    check('accept marks target fixture improved', v.perFixture.find((r) => r.fixture === 'a').verdict === 'improved');
  }

  // --- REJECT: target improves BUT another fixture regresses >10% -------------
  {
    const head = { a: 800, b: 2400, c: 3000 }; // a -20%, b +20% (regression)
    const v = decide(BASE, head, 'a');
    check('reject when another fixture regresses', v.accept === false && v.decision === 'reject');
    check('regression => gate fail', v.gate === 'fail');
    check('reports worst regression ~+20%', Math.abs(v.worstRegression - 0.2) < 1e-9);
  }

  // --- REJECT: nothing regresses BUT target did not improve -------------------
  {
    const head = { a: 1000, b: 1600, c: 3000 }; // a unchanged, b improved (not target)
    const v = decide(BASE, head, 'a');
    check('reject when target did not improve', v.accept === false);
    check('no regression => gate still pass', v.gate === 'pass');
  }

  // --- REJECT: target itself regresses ---------------------------------------
  {
    const head = { a: 1300, b: 2000, c: 3000 }; // a +30%
    const v = decide(BASE, head, 'a');
    check('reject when target itself regresses', v.accept === false && v.gate === 'fail');
  }

  // --- REJECT: unknown target fixture ----------------------------------------
  {
    const head = { a: 800, b: 2000, c: 3000 };
    const v = decide(BASE, head, 'does-not-exist');
    check('reject when target fixture is unknown', v.accept === false);
    check('unknown target keeps gate pass (no regression)', v.gate === 'pass');
  }

  // --- boundary: exactly +10% is NOT a regression ----------------------------
  {
    const head = { a: 800, b: 2200, c: 3000 }; // b exactly +10%
    const v = decide(BASE, head, 'a');
    check('exactly +10% is not counted as a regression', v.gate === 'pass' && v.accept === true);
  }

  // --- boundary: just over +10% IS a regression ------------------------------
  {
    const head = { a: 800, b: 2200.01, c: 3000 };
    const v = decide(BASE, head, 'a');
    check('just over +10% is a regression', v.gate === 'fail' && v.accept === false);
  }

  // --- no-target gate mode (compare.mjs without --target) ---------------------
  {
    const clean = decide(BASE, { a: 900, b: 1900, c: 2900 }, null);
    check('no-target: clean run accepts (pure gate)', clean.accept === true && clean.gate === 'pass');
    const dirty = decide(BASE, { a: 900, b: 2300, c: 2900 }, null);
    check('no-target: regression rejects', dirty.accept === false && dirty.gate === 'fail');
  }

  console.log(`[selftest] ${passed} passed, ${failed} failed`);
  return failed === 0;
}
