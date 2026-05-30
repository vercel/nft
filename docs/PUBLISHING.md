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

1. Bump the version in `crates/nftrs_napi/package.json` (and the workspace
   `Cargo.toml` if you also cut a crate release). Commit it.
2. Tag the commit `vX.Y.Z` and push the tag (or run **Publish** manually from
   the Actions tab).
3. The `build` matrix compiles the addon for all five targets and uploads each
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

### 1. Initial publish from the CLI (bootstrap)

> **Why this is manual:** a package must already exist on npm before you can
> open its settings and add a trusted publisher. You therefore cannot publish
> the *first* version of a brand-new package via OIDC — the very first release
> of each package name has to be done with classic auth (an automation token or
> an interactive `npm login`). After that, OIDC takes over.

From a clean checkout, build and publish all packages once:

```bash
# build every target locally (or download the workflow's build artifacts)
cd crates/nftrs_napi
npx @napi-rs/cli@3 napi create-npm-dirs
# place each freshly built nftrs.<platform>.node next to its binding package,
# then stamp versions + copy addons in:
npx @napi-rs/cli@3 napi artifacts --output-dir ./artifacts
npx @napi-rs/cli@3 napi pre-publish

# authenticate once with classic auth for the bootstrap publish
npm login

# publish the platform packages, then the JS entry
for dir in npm/*/; do npm publish "$dir" --provenance --access public; done
npm publish --provenance --access public
```

This creates `@nftrs/core` and each `@nftrs/binding-*` on the registry so their
settings pages exist. (If you build all five targets on a single machine is
inconvenient, instead trigger `publish.yml` once via `workflow_dispatch` *after*
temporarily granting it a token — but the trusted-publisher route below is the
intended steady state, so doing the one-off bootstrap from the CLI is simplest.)

### 2. Configure the trusted publisher on npm (per package)

For **each** package (`@nftrs/core` and every `@nftrs/binding-*`):

1. Go to `https://www.npmjs.com/package/<name>/access` (Settings → Trusted
   Publisher).
2. Add a trusted publisher:
   - **Provider:** GitHub Actions
   - **Organization / user:** `ubugeeei-prod`
   - **Repository:** `nftrs`
   - **Workflow filename:** `publish.yml`
   - **Environment:** `npm-publish` (must match the `environment:` in the job)
3. Save.

You can do the same from the CLI with
`npm trust github-actions --help` (the CLI equivalent of the website's
trusted-publisher settings).

> Doing this for ~6 packages is repetitive; once a package is created you only
> need to set it up once, and subsequent versions publish automatically.

### 3. Create the GitHub Environment

In the repo: **Settings → Environments → New environment** → name it
`npm-publish`. Optionally add required reviewers or a deployment branch/tag
rule so only release tags can publish. No secrets are needed — OIDC supplies
the short-lived token at publish time.

### 4. Confirm permissions

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
