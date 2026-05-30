# Misskey validation (M2)

The roadmap's near-term proof target is that **the Misskey build passes
end-to-end** under `nftrs`. The harness that validates and benchmarks this
lives in [`compat/misskey/`](../compat/misskey/README.md).

It traces the Misskey backend entrypoint with both `nftrs` and `@vercel/nft`
and diffs the resulting file lists, then benchmarks the trace. See:

- [`compat/misskey/README.md`](../compat/misskey/README.md) — how to run it
- [`compat/misskey/RESULTS.md`](../compat/misskey/RESULTS.md) — recorded
  numbers / current status

Tracked by issues #26 (validate), #27 (fix gaps), #28 (benchmark).

## Quick start

```sh
node compat/misskey/setup.mjs       # clone + (attempt) build Misskey
node compat/misskey/validate.mjs    # diff nftrs vs @vercel/nft, exit!=0 on mismatch
node compat/misskey/bench.mjs       # time the trace
```

The harness degrades gracefully: it works against any existing Misskey checkout
via `MISSKEY_DIR=/path` / `--dir`, runs nftrs-only when `@vercel/nft` isn't
installed, and falls back to the TS source entry when no built JS exists (see
the README for why the source-only comparison is diagnostic-only).
