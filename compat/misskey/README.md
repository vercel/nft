# Misskey validation harness

Real-world validation of `nftrs` against [`@vercel/nft`] on the
[Misskey](https://github.com/misskey-dev/misskey) backend — a large
production pnpm/TypeScript monorepo. This is the M2 milestone work:

- **#26** validate the Misskey build traces identically under both tracers
- **#27** fix the gaps validation surfaces
- **#28** benchmark the real Misskey workload

Everything here is self-contained in `compat/misskey/`; it does **not** touch
the core crates, the M1 unit gate (`compat/run.mjs` / `compat/baseline.json`),
or CI.

## TL;DR

```sh
# 1. (once) make sure the nftrs napi addon is built somewhere this repo can see
cd crates/nftrs_napi && ./node_modules/.bin/napi build --release && \
  ln -sf nftrs.node nftrs.darwin-arm64.node

# 2. clone + (attempt to) build Misskey, install @vercel/nft for comparison
node compat/misskey/setup.mjs

# 3. trace the backend entry with BOTH tracers and diff the file lists
node compat/misskey/validate.mjs        # exit 0 = match, 1 = mismatch

# 4. benchmark nftrs (and nft, if installed) over the entry
node compat/misskey/bench.mjs --runs 10
```

See [`RESULTS.md`](./RESULTS.md) for the recorded numbers / current status.

## Files

| file | what it does |
| --- | --- |
| `setup.mjs` | Idempotent helper that *attempts* a shallow clone of Misskey into `.checkout`, installs `@vercel/nft` here for comparison, then `pnpm install` + `pnpm run build` of the checkout. **Fails soft** with a precise "BLOCKED at step X" message + manual instructions when network/disk/build constraints stop it. |
| `validate.mjs` | Traces the Misskey backend entry with nftrs and (if available) `@vercel/nft`, then diffs: total count, files-only-in-nft, files-only-in-nftrs. Exit `0` match / `1` mismatch / `2` no-checkout / `3` error. Degrades to nftrs-only (exit 0) when nft isn't installed. |
| `bench.mjs` | Times nftrs (and nft, if present) over the entry — N runs, reports mean/min/max/median + speedup. Needs a checkout. |
| `lib.mjs` | Shared helpers: nftrs/nft loading, backend-entry detection, list normalization, `--dir`/`MISSKEY_DIR` resolution. |
| `RESULTS.md` | Recorded real numbers, or an honest "blocked at step X" status. |
| `.checkout/` | The Misskey clone (gitignored, never committed). |

## How nftrs is located

The napi `.node` artifact is gitignored and built per-checkout, so an agent
git worktree may not have one. `lib.mjs#loadNftrs()` therefore tries, in order:

1. `$NFTRS_NAPI` (an explicit `crates/nftrs_napi` dir), then
2. this worktree's `crates/nftrs_napi`, then
3. **every other git worktree of this repo** (the primary checkout usually has
   the built binding).

It loads the first one whose native binding actually resolves, and errors with
the full list of what it tried otherwise. Override with `NFTRS_NAPI=/path/...`.

## Choosing the entrypoint: built JS vs TS source

`validate.mjs`/`bench.mjs` prefer the **built** backend
(`packages/backend/built/boot/entry.js`) because that is what `@vercel/nft` is
designed to trace in production. If only source exists they fall back to
`packages/backend/src/boot/entry.ts` (with `ts: true`).

> ⚠️ The **source-only** comparison is *not* apples-to-apples: `@vercel/nft`
> does not resolve Misskey's TypeScript path aliases / NestJS-style source
> graph the way a built bundle exposes them, so the two tracers diverge for
> reasons unrelated to nftrs correctness. Trust the **built-JS** numbers in
> `RESULTS.md` for the real #26 gate; the source-only run is recorded only as a
> diagnostic.

## Pointing at an existing checkout

If you already have Misskey built somewhere, skip `setup.mjs`:

```sh
MISSKEY_DIR=/path/to/misskey node compat/misskey/validate.mjs
# or
node compat/misskey/validate.mjs --dir /path/to/misskey
```

## Comparison against `@vercel/nft`

`setup.mjs` installs `@vercel/nft` into `compat/misskey/node_modules` (a small
~12 MB install, isolated from the repo's pnpm workspace via the local
`package.json`). If it's absent, `validate.mjs` runs nftrs-only and says so
rather than failing.

[`@vercel/nft`]: https://github.com/vercel/nft
