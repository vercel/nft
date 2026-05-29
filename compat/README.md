# Compatibility harness

Runs `@vercel/nft`'s `test/unit` fixtures (the porting reference under `test/`)
against our Rust `@nftrs/core` binding and reports how many produce a matching
`fileList`. This is the **M1 gate**: turn all fixtures green.

```bash
# build the binding first
cd crates/nftrs_napi && napi build --release && cd -

node compat/run.mjs            # human summary ("N/151 passing")
node compat/run.mjs --json     # machine-readable
node compat/run.mjs --filter asset-fs   # subset
node compat/run.mjs --check    # CI ratchet vs compat/baseline.json (fails on regression)
```

As fixtures turn green, bump `passed` in `compat/baseline.json` so the count
can only go up. Reason-graph (`reasons`) assertions are added once the binding
returns them (#22); for now only the sorted `fileList` is compared.
