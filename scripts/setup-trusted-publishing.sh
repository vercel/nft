#!/usr/bin/env bash
# One-time setup of npm OIDC trusted publishing for every package nftrs ships.
#
# Uses npm v11's `npm trust github` CLI (npm >= 11.5.1). Run it ONCE, after
# `npm login`, from any machine. It authorizes this repo's publish.yml workflow
# (running in the `npm-publish` environment) to publish each package via OIDC —
# no NPM_TOKEN ever lives in the repo.
#
#   npm login                       # interactive, one-time
#   ./scripts/setup-trusted-publishing.sh
#
# After this, `vp run release minor -y` (tag push) publishes automatically.
#
# Notes:
# - The npm `@nftrs` org/scope must exist and your account must own it.
# - Each package must ALREADY EXIST on npm: `npm trust github` returns 404 for a
#   package that has never been published. So publish the first version with a
#   token first (`gh secret set NPM_TOKEN` + `vp run release minor -y`), THEN run
#   this to switch to OIDC. See docs/PUBLISHING.md "Bootstrap the first publish".
set -euo pipefail

REPO="ubugeeei-prod/nftrs"
WORKFLOW="publish.yml"
ENVIRONMENT="npm-publish"

PACKAGES=(
  "@nftrs/core"
  "@nftrs/binding-darwin-x64"
  "@nftrs/binding-darwin-arm64"
  "@nftrs/binding-linux-x64-gnu"
  "@nftrs/binding-linux-arm64-gnu"
  "@nftrs/binding-win32-x64-msvc"
)

echo "Configuring GitHub Actions trusted publishing for ${#PACKAGES[@]} packages"
echo "  repo=${REPO} workflow=${WORKFLOW} environment=${ENVIRONMENT}"
echo

for pkg in "${PACKAGES[@]}"; do
  echo "→ npm trust github ${pkg}"
  npm trust github "${pkg}" \
    --file "${WORKFLOW}" \
    --repo "${REPO}" \
    --env "${ENVIRONMENT}" \
    --yes
done

echo
echo "Done. Verify with:  npm trust list @nftrs/core"
echo "Then release with:  vp run release minor -y"
