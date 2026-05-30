# AI Optimization Loop

This page describes the **foundation** for nftrs goal #3 — *"a measurable
foundation where optimization can be automated by AI"* (see
[`ROADMAP.md`](./ROADMAP.md)).

The tooling lives in [`tools/optimize/`](../tools/optimize/README.md). It turns
performance work into a reproducible, benchmark-gated loop:

```
measure → identify a hotspot → record a candidate optimization
        → (apply) → re-measure → keep only non-regressing wins
```

## How it fits the existing benchmark infra

- The `trace` criterion benchmark (`cargo bench --bench trace`) measures
  `node_file_trace` over 10 `test/unit` fixtures.
- `.github/scripts/compare-bench.mjs` is the CI gate: it fails a PR on a
  **>10% regression**. The optimize tooling reuses the same estimates math and
  threshold so local decisions match CI.
- `crates/nftrs_profiler` localizes a hotspot once a fixture is flagged.

## The accept/reject rule

A candidate change is **accepted** iff **both**:

1. no fixture regresses beyond **+10%** (the CI gate), and
2. the targeted hotspot fixture improves beyond **-2%** (a noise floor).

Otherwise it is **rejected** and reverted. This decision is implemented as a
pure, unit-tested function (`decide()` in `tools/optimize/lib.mjs`), verified by:

```sh
node tools/optimize/compare.mjs --selftest
```

## Honest scope

This is a **foundation/scaffold**, not an autonomous optimizer. The scripts
measure, pick a hotspot, and emit a structured *candidate* artifact (hotspot +
hypothesis + change-to-try + accept criterion). A **human or coding agent**
applies the change to `crates/`; the scripts never edit Rust source. The loop's
value is making the measure/decide steps objective and repeatable so the
"apply" step can later be driven by an agent.

See the [`tools/optimize/` README](../tools/optimize/README.md) for the full
command reference and end-to-end workflow.
