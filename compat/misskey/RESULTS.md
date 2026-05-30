<!-- This file records REAL measured numbers only. Do not fabricate. -->

# Misskey validation — results

- Harness: `compat/misskey/` (validate.mjs / bench.mjs / setup.mjs)
- nftrs: version `0.0.0` (napi binding built from this repo)
- `@vercel/nft`: `1.10.2`
- Misskey: `v2026.5.4` (shallow clone of `misskey-dev/misskey`)
- Backend entry: `packages/backend/built/entry.js` (rolldown-bundled — newer
  Misskey bundles the backend to a single file; the old `built/boot/entry.js`
  layout is gone)
- Machine: macOS (darwin arm64), Node `v24`; backend built with
  `pnpm --filter=backend... run build` (cypress/playwright/puppeteer binary
  downloads skipped)

Status: **built-JS validation completed — real numbers below.**

---

## Built-JS validation (#26)

`node compat/misskey/validate.mjs --dir compat/misskey/.checkout`

| metric              | `@vercel/nft` 1.10.2 | `nftrs` |
| ------------------- | -------------------- | ------- |
| files traced        | **2236**             | **2162** |
| trace time (1 run)  | 35.5 s               | 9.0 s   |
| warnings            | 73                   | 79      |
| only in nft (nftrs **missed**) | —         | 75      |
| only in nftrs (**over-traced**) | —        | 1       |

**Overlap: 2161 / 2236 = 96.6 %.** nftrs reproduces almost the entire nft file
list on a real ~2.2k-file production backend. `RESULT: MISMATCH` (the 76-file
delta below), but the shared core is identical.

### The 75 files nftrs misses (#27 gaps)

All are **native / install-time binary** trails that nft special-cases:

| package group                    | files | what nft emits that nftrs doesn't |
| -------------------------------- | ----- | --------------------------------- |
| `node-gyp`                       | 62    | the `gyp/pylib/**` Python tree + `bin/node-gyp.js` |
| `@img/sharp-darwin-arm64`        | 4     | the platform `.node` + `package.json` + license |
| `@img/sharp-libvips-darwin-arm64`| 4     | `libvips-cpp.*.dylib` + `lib/index.js` + `versions.json` |
| `sharp`                          | 2     | sharp's native loader assets |
| `env-paths`                      | 2     | node-gyp's `env-paths` dep |
| `semver`                         | 1     | node-gyp's `semver` file |

The 1 over-traced file is the repo-root `package.json` (a harmless extra). These
gaps are tracked in #27 (sharp + node-gyp native-binary special cases).

## Benchmark (#28)

`node compat/misskey/bench.mjs --dir compat/misskey/.checkout` (5 runs):

| tracer        | mean       | min       | max       |
| ------------- | ---------- | --------- | --------- |
| **nftrs**     | **8.78 s** | 8.48 s    | 9.16 s    |
| `@vercel/nft` | 35.55 s    | 35.20 s   | 36.34 s   |

**nftrs is 4.05× faster** than `@vercel/nft` on the real Misskey backend
workload (`nft mean / nftrs mean`).

---

## Reproduce

```bash
node compat/misskey/setup.mjs                       # clone + install + build backend
node compat/misskey/validate.mjs --dir compat/misskey/.checkout
node compat/misskey/bench.mjs    --dir compat/misskey/.checkout
```

> Source-only diagnostic (not apples-to-apples): tracing the raw TS entry
> `packages/backend/src/boot/entry.ts` has nft follow ~6 files vs nftrs ~576,
> because nft doesn't walk Misskey's TS/NestJS source graph. Trust the built-JS
> table above for #26.
