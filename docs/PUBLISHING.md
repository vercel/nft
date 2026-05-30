# Publishing

`nftrs` ships as a napi-rs package: the JS entry `@nftrs/core` plus one
prebuilt native binary per platform, published as `@nftrs/binding-*`
`optionalDependencies`. Releases run from
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml) using
**npm OIDC trusted publishing** — there is no `NPM_TOKEN` in the repo.

Targets (from `crates/nftrs_napi/package.json` → `napi.targets`):

| binding package                    | target                       |
| ---------------------------------- | ---------------------------- |
| `@nftrs/binding-darwin-x64`        | `x86_64-apple-darwin`        |
| `@nftrs/binding-darwin-arm64`      | `aarch64-apple-darwin`       |
| `@nftrs/binding-linux-x64-gnu`     | `x86_64-unknown-linux-gnu`   |
| `@nftrs/binding-linux-arm64-gnu`   | `aarch64-unknown-linux-gnu`  |
| `@nftrs/binding-win32-x64-msvc`    | `x86_64-pc-windows-msvc`     |

---

## How releases work

Cut a release with one command:

```bash
vp run release minor -y      # 0.0.0 -> 0.1.0  (also: patch / major)
```

[`scripts/release.mjs`](../scripts/release.mjs) bumps
`crates/nftrs_napi/package.json` **and** the workspace `Cargo.toml` version,
syncs `Cargo.lock`, commits `release: vX.Y.Z`, tags it, and pushes the tag.
Use `--dry-run` to print the plan without changing anything. The tag push is
what triggers the workflow:

1. `vp run release <patch|minor|major> -y` bumps + tags `vX.Y.Z` + pushes the
   tag (equivalently: tag a commit `vX.Y.Z` by hand, or run **Publish** from the
   Actions tab).
2. The `build` matrix compiles the addon for all five targets and uploads each
   `.node` as an artifact. `aarch64-unknown-linux-gnu` is cross-compiled via
   `@napi-rs/cross-toolchain` (`--use-napi-cross`).
4. The `publish` job downloads every binary, runs
   `napi create-npm-dirs` / `napi artifacts` / `napi pre-publish` to lay out the
   per-platform packages under `crates/nftrs_napi/npm/`, then runs
   `npm publish --provenance --access public` for each `@nftrs/binding-*` and
   finally for `@nftrs/core`. Authentication is OIDC; provenance attestations
   are generated automatically.

The `publish` job requests `id-token: write` and runs in the `npm-publish`
GitHub Environment so you can attach required reviewers or restrict it to tags.

---

## One-time setup (required before the workflow can publish)

### 0. Prerequisites

- npm CLI **>= 11.5.1** and Node **>= 22.14.0** are required for OIDC trusted
  publishing. The workflow upgrades npm (`npm install -g npm@latest`) on the
  runner; install the same locally for the initial publish.
- The npm account/org that owns `@nftrs` must be able to publish to the
  `@nftrs` scope.

### 1. Bootstrap the first publish (token), then switch to OIDC

`npm trust github <pkg>` **404s for a package that does not exist yet**
(`POST /-/package/@nftrs%2fcore/trust` → 404) — a trusted publisher can only be
attached to an existing package. So the very first release is a one-time
token-authed publish that **creates** the packages; trusted publishing (OIDC)
takes over for every release after.

**a. Create the npm org + a token.** Ensure the `@nftrs` org exists
(<https://www.npmjs.com/org/create>). Create a **granular access token** with
read-write publish rights to the `@nftrs` scope
(<https://www.npmjs.com/settings/~/tokens>), then add it as a repo secret:

```bash
gh secret set NPM_TOKEN          # paste the token when prompted
```

The publish job picks up `NPM_TOKEN` automatically (`NODE_AUTH_TOKEN`); when the
secret is absent it publishes via OIDC instead.

**b. Cut the first release.** This builds every platform and publishes
`@nftrs/core` + the five `@nftrs/binding-*` with the token, creating them:

```bash
vp run release minor -y          # tag v0.1.0 -> publish.yml
```

**c. Configure trusted publishing** (now the packages exist):

```bash
npm login
npm run setup-trusted-publishing   # runs `npm trust github` for all six packages
npm trust list @nftrs/core         # verify
```

`setup-trusted-publishing.sh` runs, for each package:

```bash
npm trust github <package> --file publish.yml \
  --repo ubugeeei-prod/nftrs --env npm-publish --yes
```

The `--file` / `--repo` / `--env` must match the workflow exactly — they form
the OIDC subject npm checks at publish time.

**d. Remove the token.** `gh secret delete NPM_TOKEN`. Every subsequent
`vp run release` now publishes via OIDC trusted publishing — no token.

### 2. Create the GitHub Environment

Already created: the `npm-publish` environment exists on this repo (the
`publish` job's `environment:`). Optionally add required reviewers or a tag
deployment rule in **Settings → Environments → npm-publish**. No secrets are
needed — OIDC supplies
the short-lived token at publish time.

### 3. Confirm permissions

The `publish` job already declares:

```yaml
permissions:
  contents: read
  id-token: write   # OIDC token for trusted publishing + provenance
```

No `NPM_TOKEN` secret is configured or required for steady-state releases.

---

## Verifying without publishing

Run **Publish** via `workflow_dispatch` with the **dry-run** input checked. It
builds all targets and runs `npm publish --dry-run --provenance` for every
package without touching the registry.

---

## Publishing the Rust crates to crates.io (optional / not yet active)

> **TL;DR:** crates.io publishing is **optional and best-effort**. The library
> crates are currently `version = "0.0.0"`, which crates.io rejects, so the
> [`publish-crates.yml`](../.github/workflows/publish-crates.yml) workflow is a
> **dispatch-only scaffold**. It runs `cargo publish --dry-run` today; the real
> upload is gated behind a typed confirmation **and** a version above `0.0.0`.
> npm is the supported distribution channel; the crates are internal.

### What is (and isn't) publishable

`nftrs_napi` sets `publish = false` — it's a `cdylib` Node addon and goes to
**npm** (above), never to crates.io. The five plain library crates can go to
crates.io once they carry a real version:

| crate            | crates.io? | nftrs deps                                  |
| ---------------- | ---------- | ------------------------------------------- |
| `nftrs_fs`       | yes        | —                                           |
| `nftrs_profiler` | yes        | —                                           |
| `nftrs_analyzer` | yes        | —                                           |
| `nftrs_resolver` | yes        | `nftrs_fs`                                  |
| `nftrs_core`     | yes        | `nftrs_fs`, `nftrs_resolver`, `nftrs_analyzer` |
| `nftrs_napi`     | **no**     | `nftrs_core` (npm only)                     |

Publish order (leaves first, so each dependent's `version` requirement resolves
on the index): `nftrs_fs`, `nftrs_profiler`, `nftrs_analyzer` →
`nftrs_resolver` → `nftrs_core`. The workflow encodes exactly this order.

### Prerequisites before a real crates.io release

1. **Bump the version.** The workspace pins one version for all crates
   (`[workspace.package] version` in `Cargo.toml`); the path deps reference it
   too. crates.io will not accept `0.0.0`. Set a real pre-release/release
   version (e.g. `0.1.0`) — either by editing `Cargo.toml` directly or with
   [`cargo-release`](https://github.com/crate-ci/cargo-release)
   (`cargo release 0.1.0 --workspace`), which can also tag and publish in
   dependency order. The `publish-crates.yml` version guard fails fast while the
   version is still `0.0.0`.
2. **Fill in crate metadata** if missing (each crate already has `description`,
   `license`, `repository`, `homepage`, `keywords`, `categories` inherited from
   the workspace — confirm they're acceptable for a public release).
3. **Authentication.** Two options:
   - **Token:** create a crates.io API token scoped to publish, store it as the
     `CARGO_REGISTRY_TOKEN` secret in the `crates-publish` GitHub Environment.
     The workflow already reads it.
   - **Trusted publishing (preferred, no long-lived secret):** configure a
     crates.io trusted publisher for this repo + `publish-crates.yml`, then
     replace the `CARGO_REGISTRY_TOKEN` env with the
     `rust-lang/crates-io-auth-action` step. (Mirror of the npm OIDC flow above.)
4. **Create the `crates-publish` GitHub Environment** (Settings → Environments)
   to hold the token / required reviewers, matching the `environment:` in the
   workflow job.

### Running it

- **Dry run (safe, runs today):** trigger **Publish crates** via
  `workflow_dispatch` and leave `confirm` at its default. It runs
  `cargo publish --dry-run -p <crate>` for all five library crates against the
  live index to prove the manifests pack and build — no upload, no token needed.
- **Real publish:** set the `confirm` input to exactly `publish`. The job still
  refuses to proceed if the version is `0.0.0`. On success it uploads each crate
  in dependency order with a short `sleep` between uploads so the index catches
  up before the next dependent resolves.

You can also dry-run locally:

```bash
for c in nftrs_fs nftrs_profiler nftrs_analyzer nftrs_resolver nftrs_core; do
  cargo publish --dry-run -p "$c"
done
```

---

## Continuous compat-baseline tracking

[`baseline.yml`](../.github/workflows/baseline.yml) records the compat passing
count over time (issue #32). It is **observational** — it never fails the build;
regressions are still gated on PRs by CI's `node compat/run.mjs --check`.

On every push to `main` (ignoring docs/markdown-only pushes) it:

1. Builds the native binding and runs `node compat/run.mjs --json`.
2. Distills the summary into one record
   (`{date, commit, passed, considered, total}`) and **appends it to
   `compat/history.ndjson`** — but only when the count actually moved, so the
   file stays a clean changelog of the number rather than one row per commit.
   The file is created on the first run and committed back by
   `github-actions[bot]` (`[skip ci]`, rebased before push to avoid races).
3. Writes a [shields.io endpoint](https://shields.io/endpoint) badge JSON
   (`compat-badge.json`) as a build artifact and prints the current `N/M` to the
   job summary.

`compat/history.ndjson` is **not seeded in the repo**; the workflow creates it
on its first run on `main`. To surface a live badge in the README, publish the
endpoint JSON somewhere stable (e.g. commit `compat-badge.json` or push it to a
gist) and point
`https://img.shields.io/endpoint?url=<raw-url>` at it.
