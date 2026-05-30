# `tools/optimize` — AI-assisted performance optimization loop (foundation)

A small, dependency-free scaffold for an **iterative, benchmark-gated**
optimization loop over `node_file_trace`. It is a *foundation*, not an
autonomous optimizer: the tooling measures, picks a hotspot, and emits a
structured **optimization candidate** artifact. A human (or a coding agent)
applies the suggested change to Rust source, then re-measures and lets the
gate decide accept/reject.

> Honesty note: the "AI" here is the human/agent that *applies* a candidate.
> These scripts never edit `crates/` — they orchestrate measurement and make
> the accept/reject decision objective and reproducible.

## What it builds on

- `cargo bench --bench trace` (criterion) over 10 `node_file_trace` fixtures,
  writing `target/criterion/node_file_trace/<fixture>/<label>/estimates.json`.
- `.github/scripts/compare-bench.mjs` — the CI gate that fails a PR on a
  >10% regression. This tooling reuses the **same** estimates math and 10%
  threshold (centralized in [`lib.mjs`](./lib.mjs)).
- `crates/nftrs_profiler` — a profiling crate to localize a hotspot once a
  fixture is identified.

## The loop

```
measure(before) ──► loop ──► candidate.{json,md}
                              │  (human / agent applies the change to crates/)
                              ▼
                       measure(after) ──► compare(before, after, target)
                                               │
                                  accept (keep) ◄┴► reject (revert)
```

A change is **accepted** iff **both**:
1. no fixture regresses beyond **+10%** (the existing CI gate), and
2. the **target** fixture improves beyond **-2%** (noise floor).

Otherwise it is **rejected** and reverted. This rule lives in `decide()` in
`lib.mjs` and is covered by the self-test.

## Scripts

All are plain Node ESM, no extra deps. Run from the repo root.

### `measure.mjs` — snapshot a benchmark run

```sh
node tools/optimize/measure.mjs --label before
```

Runs `cargo bench --bench trace -- --save-baseline before`, then reads each
fixture's `mean.point_estimate` (ns) into `tools/optimize/snapshots/before.json`.

- `--label <name>` criterion baseline label + snapshot filename (default: timestamp)
- `--no-bench` skip the bench, just read existing criterion estimates
- `--out <dir>` snapshot output dir (default: `tools/optimize/snapshots`)

### `compare.mjs` — diff two snapshots, emit a verdict

```sh
node tools/optimize/compare.mjs --base before --head after --target wildcard
node tools/optimize/compare.mjs --base before --head after --json   # machine-readable
```

Prints a base→head delta table and a machine-readable verdict (per-fixture
`improved`/`regressed`/`neutral` and an overall `pass`/`fail` gate). With
`--target <fixture>` it also prints the accept/reject **decision**. Exits
non-zero on a gate failure (like `compare-bench.mjs`).

- `--base` / `--head <label>` snapshots to diff
- `--target <fixture>` fixture the optimization targets (drives the decision)
- `--json` print only the verdict JSON
- `--selftest` run the built-in accept/reject tests (see below)

### `loop.mjs` — orchestrator scaffold

```sh
node tools/optimize/loop.mjs --baseline before
node tools/optimize/loop.mjs --baseline before --target browserify
```

Ensures a baseline snapshot exists (measuring if needed), picks a hotspot
(slowest fixture, or `--target`), and writes an **optimization candidate**
(`tools/optimize/candidates/candidate-<fixture>-<ts>.{json,md}`) describing the
hotspot, a hypothesis, the change to try, and the accept/reject criterion plus
the exact re-measure/decide commands. It does **not** mutate Rust source.

- `--baseline <label>` baseline snapshot label
- `--target <fixture>` force the hotspot fixture
- `--no-bench` reuse existing criterion estimates
- `--out <dir>` candidate output dir (default: `tools/optimize/candidates`)

## End-to-end workflow

```sh
# 1. Baseline
node tools/optimize/measure.mjs --label before

# 2. Generate a candidate (hotspot + hypothesis + criterion)
node tools/optimize/loop.mjs --baseline before
#    -> read tools/optimize/candidates/candidate-<fixture>-*.md

# 3. Apply the change to crates/ (human or coding agent).
#    Use crates/nftrs_profiler to localize the hotspot first if needed.

# 4. Re-measure and decide
node tools/optimize/measure.mjs --label after
node tools/optimize/compare.mjs --base before --head after --target <fixture>
#    ACCEPT -> commit. REJECT -> git restore crates/ and try another candidate.
```

## Self-test

The accept/reject logic is unit-tested with synthetic snapshots (no benchmark
run required):

```sh
node tools/optimize/compare.mjs --selftest
```

It covers the accept case, regression-elsewhere rejection, target-didn't-improve
rejection, target-itself-regressed rejection, unknown-target handling, and the
exact ±10% / -2% boundaries.

## Files

| file | role |
| --- | --- |
| `lib.mjs` | shared estimates math, thresholds, and the pure `decide()` gate |
| `measure.mjs` | run bench + snapshot per-fixture mean-ns to JSON |
| `compare.mjs` | diff two snapshots → table + verdict; `--selftest` entry |
| `loop.mjs` | orchestrator: measure → pick hotspot → emit candidate artifact |
| `selftest.mjs` | synthetic-snapshot tests for `decide()` |

`snapshots/` and `candidates/` are transient run artifacts (git-ignored).
