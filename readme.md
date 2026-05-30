# nftrs

A Rust + [OXC](https://oxc.rs) rewrite of [`@vercel/nft`](https://github.com/vercel/nft).

`nftrs` determines exactly which files (including those in `node_modules`) are
needed at runtime for a given set of Node.js entry points. It is a drop-in
replacement for `@vercel/nft`'s `nodeFileTrace`: same call signature, same
result shape (`fileList` / `esmFileList` / `warnings`), backed by a native
addon instead of a JavaScript AST walk.

## Why

- **Native speed.** Parsing and static analysis run in Rust on the OXC parser
  rather than acorn + an `estree-walker` pass in JS.
- **Drop-in API.** The npm binding (`@nftrs/core`) exposes the same
  `nodeFileTrace(files, options)` entry point.

## Usage

```js
const { nodeFileTrace } = require('@nftrs/core');

const { fileList } = await nodeFileTrace(['path/to/input.js']);
console.log(fileList); // files needed at runtime, relative to `base`
```

`nodeFileTrace(files, options)` accepts the common `@vercel/nft` options:
`base`, `processCwd`, `depth`, `ts`, `analysis`, `conditions`, `exportsOnly`,
`moduleSyncCatchall`, and `paths`. See `crates/nftrs_napi/index.d.ts` for the
full typed surface.

## Build

The Rust library entry point is `nftrs_core::node_file_trace(files, &opts)`.

```bash
# Rust workspace
cargo build --release
cargo test --workspace        # 92 unit tests

# Node addon (@nftrs/core)
cd crates/nftrs_napi
pnpm install --ignore-workspace
./node_modules/.bin/napi build --release
ln -sf nftrs.node nftrs.darwin-arm64.node   # platform-specific binding name
```

## Compatibility

`nftrs` is validated against `@vercel/nft`'s own `test/unit` fixtures via the
compatibility harness in `compat/`. Each fixture's traced `fileList` is
compared against the upstream expected output.

**Compat: 148/151 `test/unit` fixtures** match `@vercel/nft`.

```bash
node compat/run.mjs            # human summary
node compat/run.mjs --check    # CI ratchet vs compat/baseline.json
```

> Reproduction note: a local run on this environment (Node 24.16.0) measured
> **147/151**, with 4 fixtures (`phantomjs-prebuilt`, `pixelmatch`,
> `resolve-hook`, `shiki`) requiring their per-fixture npm dependencies to be
> installed first. The 3 skipped fixtures are platform/Node-version specific
> (see the skip lists in `compat/run.mjs`).

## Coverage

Rust coverage is measured with [`cargo llvm-cov`](https://github.com/taiki-e/cargo-llvm-cov):

```bash
cargo llvm-cov --workspace --summary-only
```

Measured on this environment (cargo-llvm-cov 0.8.4, 92 passing unit tests):

| Scope                                           | Region  | Line    |
| ----------------------------------------------- | ------- | ------- |
| Workspace                                       | 70.90%  | 71.65%  |
| Library crates (excludes `nftrs_napi` FFI shim) | 71.50%  | 72.40%  |

The `nftrs_napi` shim is a thin FFI boundary exercised through the compat
harness rather than Rust unit tests, so it reports 0% under `cargo llvm-cov`.

## Benchmarks

Two complementary measurements:

1. **`cargo bench`** — a [Criterion](https://github.com/bheisler/criterion.rs)
   benchmark (`crates/nftrs_core/benches/trace.rs`) timing
   `node_file_trace` directly over a representative set of fixtures, with no
   JS/napi overhead.
2. **`compat/bench.mjs`** — times `@vercel/nft`'s `nodeFileTrace` against the
   `@nftrs/core` napi binding over the same fixtures, with identical options.

```bash
cargo bench -p nftrs_core --bench trace   # native Criterion timings
node compat/bench.mjs                       # nftrs vs @vercel/nft speedup
```

### Criterion (native `node_file_trace`, median)

| Fixture            | Time     |
| ------------------ | -------- |
| import-meta-url    | 44.8 µs  |
| wildcard           | 301.5 µs |
| webpack-wrapper    | 79.9 µs  |
| asset-fs-extra     | 185.3 µs |
| asset-fs-inlining  | 50.9 µs  |
| multi-input        | 496.0 µs |
| browserify         | 129.3 µs |
| asset-graceful-fs  | 179.9 µs |
| asset-package-json | 35.6 µs  |
| class-static       | 50.3 µs  |

### nftrs vs @vercel/nft (end-to-end via napi, Node 24.16.0, median of 100 iters)

| Fixture            | @vercel/nft | nftrs      | Speedup   |
| ------------------ | ----------- | ---------- | --------- |
| import-meta-url    | 0.48 ms     | 0.05 ms    | ~10x      |
| wildcard           | 1.06 ms     | 0.25 ms    | ~4x       |
| webpack-wrapper    | 0.75 ms     | 0.07 ms    | ~10x      |
| asset-fs-extra     | 24.40 ms    | 7.89 ms    | ~3x       |
| asset-fs-inlining  | 0.37 ms     | 0.06 ms    | ~6x       |
| multi-input        | 1.76 ms     | 0.49 ms    | ~4x       |
| browserify         | 0.99 ms     | 0.13 ms    | ~8x       |
| asset-graceful-fs  | 5.26 ms     | 0.57 ms    | ~9x       |
| asset-package-json | 0.26 ms     | 0.04 ms    | ~6x       |
| class-static       | 0.35 ms     | 0.05 ms    | ~6x       |
| **Total**          | **35.7 ms** | **9.6 ms** | **~3.7x** |

Speedups vary by workload (3x–10x per fixture); the aggregate is weighted by
the heavy `asset-fs-extra` case. Numbers are from this machine and will differ
across hardware and Node versions — rerun the commands above to reproduce.

## License

MIT
