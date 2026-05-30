<!-- This file records REAL measured numbers only. Do not fabricate. -->

# Misskey validation — results

- Harness: `compat/misskey/` (validate.mjs / bench.mjs / setup.mjs)
- nftrs: version `0.0.0` (napi binding built from this repo)
- `@vercel/nft`: `1.10.2`
- Misskey: `v2026.5.4` (shallow clone of `misskey-dev/misskey`)
- Machine: macOS (darwin arm64), Node `v24.16.0`, pnpm 10.33 → corepack pnpm 11.1.2

Status: **harness verified working; full built-JS validation _PENDING_ on a
Misskey backend build (see "Blocked at" below).**

---

## What ran

### Harness self-check (synthetic fixture) — ✅ PASS

A synthetic `packages/backend/built/boot/entry.js` with a local require chain,
a `fs.readFileSync` asset, and a `node_modules` package was traced by both
tracers. **nftrs and `@vercel/nft` produced identical 5-file lists** (`match`,
exit 0), confirming the diff/compare path is correct.

### Built-JS validation (the real #26 gate) — ⏳ pending build

`packages/backend/built/boot/entry.js` requires a successful Misskey backend
build (`pnpm run build`). See blocker below. To be filled in with:

| metric | `@vercel/nft` | `nftrs` |
| --- | --- | --- |
| file count | _tbd_ | _tbd_ |
| only-in-nft | — | _tbd_ |
| only-in-nftrs | — | _tbd_ |
| trace time | _tbd_ | _tbd_ |

### Source-only diagnostic (NOT apples-to-apples) — recorded

Tracing the raw TS entry `packages/backend/src/boot/entry.ts` (before deps were
installed) gave: `@vercel/nft` followed 6 files (7 warnings); nftrs followed
576 files (3459 warnings). These diverge because `@vercel/nft` does not walk
Misskey's TypeScript/NestJS source graph the way a built bundle is walked — see
the README note. This is a diagnostic data point, **not** a correctness verdict;
trust the built-JS table above for #26.

---

## Blocked at

(Filled in by the run. If empty, the built-JS validation completed — see table.)
