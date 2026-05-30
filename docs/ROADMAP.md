# nftrs Roadmap

A full rewrite of `@vercel/nft` in Rust + OXC, distributed to npm via napi-rs.
Three goals: **(1) drop-in compatibility with `@vercel/nft`**, **(2) overwhelming speed**, and
**(3) a measurable foundation where optimization can be automated by AI**.
The near-term proof target is that **the Misskey build passes end-to-end**.

Design, profiling, and CI/CD follow [`ubugeeei-prod/ox-content`](https://github.com/ubugeeei-prod/ox-content).

---

## Goals & principles

- **Compatibility comes first (the M1 gate)**: turn nft's `test/unit` (154 fixtures), `test/integration`
  (89 fixtures), `test/ecmascript`, and `test/cli` all green. No optimization work until compatibility is in place.
- **Drop-in**: the published API exposes `nodeFileTrace(files, opts)` with the exact same signature and return
  shape (`fileList` / `esmFileList` / `reasons` / `warnings`). Existing tools (Misskey included) only swap the import.
- **Measurable**: every performance change is emitted as machine-readable JSON, compared base/head per PR,
  gated against regressions, and posted as an automated comment.
- **AI-automated optimization**: profiling output (span timings + allocations) is machine-readable so an agent
  can run an optimization loop with the regression gate as a safety net.

---

## npm / crate naming

| Kind                                      | Name                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Main JS package                           | `@nftrs/core`                                                     |
| Native binary (per-platform optionalDeps) | `@nftrs/binding-{platform}`                                       |
| napi crate                                | `nftrs_napi` (`binaryName: nftrs`, `packageName: @nftrs/binding`) |
| Crate prefix                              | `nftrs_*`                                                         |

---

## Architecture (Rust workspace)

nft's TS modules (~4,760 lines) map onto the following crates.

```
crates/
  nftrs_fs              # Cached FS (readFile/stat/readlink) + realpath/symlink emit      <- src/fs.ts
  nftrs_resolver        # Node resolution algorithm, built on oxc_resolver (exports/imports/conditions) <- src/resolve-dependency.ts
  nftrs_analyzer        # Parse with oxc_parser -> AST walk -> extract deps/imports/assets/isESM <- src/analyze.ts
    |- static_eval      #   Constant folding / static expression evaluation              <- src/utils/static-eval.ts
    |- wrappers         #   Unwrap bundler wrappers (browserify/webpack/etc.)            <- src/utils/wrappers.ts
    |- special_cases    #   Per-package hacks (pino/prisma/...)                          <- src/utils/special-cases.ts
  nftrs_core            # Job orchestration, emitFile/emitDependency, reasons graph       <- src/node-file-trace.ts
  nftrs_napi            # napi-rs bindings (expose nodeFileTrace, JS callback overrides)  <- src/index.ts
  nftrs_cli             # CLI                                                             <- src/cli.ts
  nftrs_profiler        # CountingAllocator + span timing + Report (ported from ox-content)
  nftrs_wasm            # (optional) wasm target
```

OXC is the core dependency: `oxc_parser` / `oxc_ast` / `oxc_ast_visit` / `oxc_span` / `oxc_allocator` / `oxc_resolver`.
Because `oxc_resolver` already implements exports/imports/conditions/extensions/paths, it should replace most of
`resolve-dependency.ts`.

The release profile follows ox-content (`lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip`, `opt-level = 3`).
Lints follow ox-content as well (clippy `pedantic` / `nursery` / `cargo` as warn, `-D warnings`).

---

## Milestones

### M0 — Foundation

Stand up the workspace, CI, napi skeleton, and the benchmark/profiling foundation. Reach a state that
"runs even when empty and is measurable."

### M1 — Full `@vercel/nft` compatibility (the gate) ★ highest priority

Port analyzer / resolver / special-cases / wrappers / static-eval and turn nft's whole test suite green.
**No optimization until this passes.**

### M2 — Misskey end-to-end

Run against a real Misskey build, close gaps and diffs, and satisfy "works completely."

### M3 — Performance & AI-automated optimization

On top of the benchmark foundation, drive speed down profile-first. Make the AI optimization loop runnable.
The measure → candidate → re-measure → gate scaffold is documented in [`OPTIMIZE.md`](./OPTIMIZE.md).

### M4 — Release

OIDC trusted publish of `@nftrs/core` + `@nftrs/binding-*` to npm. crates.io / docs.

---

## Issues (by milestone)

> Labels: `M0`-`M4`, `area:fs` / `area:resolver` / `area:analyzer` / `area:core` / `area:napi` / `area:ci` / `area:bench` / `area:compat`, `type:feat` / `type:infra` / `type:test` / `type:perf`

### M0 — Foundation

1. **[infra] Initialize Cargo workspace** — `Cargo.toml` (members, workspace.package, lints, release profile), `rust-toolchain.toml`, `.node-version`, `deny.toml`, pin OXC deps.
2. **[infra] Create crate skeletons** — the 9 crates above as empty libs that `cargo build` cleanly.
3. **[napi] napi-rs skeleton** — `nftrs_napi` (`crate-type=["cdylib","rlib"]`, `napi-build`) + `package.json` (`@nftrs/core`, napi targets, `binaryName/packageName`) + binding loader `index.js` + generated `index.d.ts`. `version()` and a stub `nodeFileTrace` callable from Node.
4. **[ci] Base CI pipeline** — `ci.yml`: rustfmt / clippy (`-D warnings`) / cargo test / TS typecheck / napi smoke (3 OS) / package dry-run / cargo-audit + cargo-deny. Port ox-content's `ci.yml`.
5. **[bench] Benchmark foundation** — criterion harness + machine-readable JSON output + port `nftrs_profiler` (CountingAllocator/span/Report) + `nftrs_profile_cli`.
6. **[bench] PR benchmark comparison CI** — `benchmark.yml` + `.github/scripts/{run,compare,comment}-pr-benchmark.mjs`. base/head comparison, regression-threshold gate, PR auto-comment.
7. **[infra] Issue/PR templates + labels** — port templates (incl. `production_readiness`), bulk-create labels via `gh label`.

### M1 — Full `@vercel/nft` compatibility

8. **[test] Compatibility harness** — run nft's `test/unit` (154) / `test/integration` (89) / `test/ecmascript` / `test/cli` against the built napi binary. Port the expected-value comparison (fileList/reasons). Track progress as "N/154 passing."
9. **[fs] Cached FS + realpath** — `readFile`/`stat`/`readlink` caches, `realpath` (symlink-loop detection, emit in-base symlinks), `fileIOConcurrency`.
10. **[resolver] oxc_resolver integration** — Node resolution via oxc_resolver. Basic extensions/index/`package.json` main resolution.
11. **[resolver] exports/imports/conditions** — `exports`/`imports` maps, `conditions` (alias of `exports`), `exportsOnly`, `moduleSyncCatchall`, `paths` option, TS resolution, `node:` prefix.
12. **[resolver] nft-specific resolution & remappings** — `@vercel/nft`-specific branches, `remappings`, `getPjsonBoundary`, `type: module` detection.
13. **[analyzer] Parsing foundation (oxc)** — parse CJS/ESM/TS/JSX/import-attributes with oxc. `isESM` detection. parse-failure warning behavior.
14. **[analyzer] require/import/export detection** — `require()`, `require.resolve`, dynamic `import()`, static `import`/`export ... from`, `module.exports`/`exports.x` dependency extraction.
15. **[analyzer] Port static-eval** — the static expression evaluation engine (`src/utils/static-eval.ts`, 588 lines). Template literals, binary ops, `path.join` folding, etc.
16. **[analyzer] **dirname/**filename/import.meta.url** — bindings and their contribution to asset-path resolution.
17. **[analyzer] Asset reference detection & globs** — argument resolution for `fs.readFile` etc., `emitAssetDirectory`, wildcard/glob (picomatch -> `globset`), `computeFileReferences`/`emitGlobs`/`evaluatePureExpressions`.
18. **[analyzer] Port wrappers** — `src/utils/wrappers.ts` (742 lines). Unwrap bundler output wrappers.
19. **[analyzer] Port special-cases** — `src/utils/special-cases.ts` (390 lines). pino/prisma/express/`@grpc` and other per-package hacks.
20. **[core] Job orchestration** — `emitFile`/`emitDependency`/`emitDependencies` recursion, dedup (`processed`), `reasons` graph, `esmFileList`, `depth`, `base`/`cwd`.
21. **[core] ignore / sharedlib / .node** — `ignore` (string/array/fn, glob), `sharedLibEmit` (bundling `.node`), short-circuit `.json`/`.node`.
22. **[napi] Full nodeFileTrace surface** — marshal all options, return shape (fileList/esmFileList/reasons/warnings), JS callback overrides (`readFile`/`stat`/`readlink`/`resolve`) via threadsafe functions. `index.d.ts` type-matched to `@vercel/nft`.
23. **[napi] Port CLI** — `out/cli.js` equivalent (`nftrs <files>`).
24. **[test] Turn the full suite green** — pass all fixtures via the harness from #8. Port Windows/macOS/Node-version skip rules. **DoD for M1.**

### M2 — Misskey end-to-end

25. **[compat] Validate Misskey build** — swap `@vercel/nft` for nftrs in Misskey's build path, run it, and diff the output (fileList) against `@vercel/nft`.
26. **[compat] Fix Misskey gaps** — minimize each missing fixture from #25, add it as a `test/unit`-style case, and fix.
27. **[bench] Benchmark the real Misskey workload** — pin the Misskey trace as a criterion bench + profiling target and put it under regression watch.

### M3 — Performance & AI-automated optimization

28. **[perf] Profile-driven hotspot optimization** — identify top entries from span/alloc reports and optimize (fewer allocations, zero-copy, caching).
29. **[perf] Parallel tracing** — parallelize fs I/O and parsing (rayon / tokio). Beat `@vercel/nft`'s async concurrency.
30. **[bench] AI optimization loop foundation** — profile JSON -> candidate extraction -> agent optimization PR -> auto accept/reject via the bench regression gate, runnable via Workflow / cron. Build out `nftrs bench --json` / `nftrs profile --json`.
31. **[bench] Continuous baseline tracking** — record benchmark history nightly and visualize long-term trends.

### M4 — Release

32. **[infra] publish.yml** — multi-target napi build (5 platforms) + binding subpackage creation + OIDC trusted publish (`@nftrs/core` / `@nftrs/binding-*`). Port ox-content's `publish.yml`.
33. **[infra] crates.io publish (optional)** — publish `nftrs_*` in dependency order.
34. **[infra] Docs & README** — usage, compatibility matrix, benchmark results, migration guide.

---

## How we work

- Each issue lands as a small PR; CI (compatibility tests + benchmark comparison) runs per PR.
- Stand up the M1 compatibility harness (#8) early and keep "N/154 passing" visible while turning things green.
- Performance work (M3) starts **only after the compatibility gate (M1) passes**, automated by AI with the regression gate as a safety net.
