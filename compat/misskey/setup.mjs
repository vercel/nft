#!/usr/bin/env node
// Idempotent helper that *attempts* to produce a Misskey checkout suitable for
// validate.mjs / bench.mjs, and FAILS SOFT with clear guidance when it can't
// (no network, no disk, build failure). It never throws an unhandled error —
// every step reports "ok / skipped / blocked" and the script exits non-zero
// with actionable instructions if a required step is blocked.
//
// What it does (each step is idempotent / re-runnable):
//   1. shallow `git clone --depth 1` of misskey-dev/misskey into .checkout
//   2. install the harness's own dep (@vercel/nft) in compat/misskey
//   3. `pnpm install` inside the checkout (backend + shared workspace deps)
//   4. `pnpm --filter backend... build` to emit packages/backend/built/**
//
// Misskey is a very large pnpm/TypeScript monorepo; steps 3 and 4 are heavy
// (multi-GB node_modules, several minutes). On a disk- or network-constrained
// machine they are expected to fail — that's fine, the harness is still usable
// against any *other* Misskey checkout via `--dir` / MISSKEY_DIR, and against
// a source-only checkout (validate.mjs falls back to tracing the .ts entry).
//
// Usage:
//   node compat/misskey/setup.mjs              # full attempt
//   node compat/misskey/setup.mjs --clone-only # just clone (skip install/build)
//   node compat/misskey/setup.mjs --ref v2024.x # clone a specific tag/branch

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CHECKOUT, here, findBackendEntry } from './lib.mjs';

const argv = process.argv.slice(2);
const cloneOnly = argv.includes('--clone-only');
const refIdx = argv.indexOf('--ref');
const ref = refIdx !== -1 ? argv[refIdx + 1] : null;
const REPO = 'https://github.com/misskey-dev/misskey';
const checkout = DEFAULT_CHECKOUT;

function run(cmd, args, opts = {}) {
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  return r;
}

function have(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

let blockedAt = null;
function block(step, message) {
  blockedAt = { step, message };
}

function main() {
  console.log('Misskey validation harness — setup');
  console.log(`  target checkout: ${checkout}`);

  // --- preflight ---
  if (!have('git')) {
    block('preflight', 'git not found on PATH. Install git and re-run.');
    return finish();
  }

  // --- step 1: clone ---
  const alreadyCloned =
    fs.existsSync(checkout) && fs.existsSync(`${checkout}/.git`);
  if (alreadyCloned) {
    console.log('\n[1/4] clone: already present, skipping');
  } else {
    const args = ['clone', '--depth', '1'];
    if (ref) args.push('--branch', ref);
    args.push(REPO, checkout);
    const r = run('git', args);
    if (r.status !== 0) {
      block(
        'clone',
        `git clone failed (status ${r.status ?? 'spawn-error'}). Likely no ` +
          `network access or insufficient disk. To do this manually:\n` +
          `    git clone --depth 1 ${REPO} ${checkout}`,
      );
      return finish();
    }
    console.log('[1/4] clone: ok');
  }

  // --- step 2: install harness dep (@vercel/nft) for comparison ---
  // Non-fatal: validate.mjs degrades to nftrs-only if this is skipped.
  const nftInstalled = fs.existsSync(`${here}/node_modules/@vercel/nft`);
  if (nftInstalled) {
    console.log('\n[2/4] @vercel/nft: already installed, skipping');
  } else if (have('npm')) {
    const r = run(
      'npm',
      ['install', '--no-audit', '--no-fund', '--no-package-lock'],
      { cwd: here },
    );
    if (r.status !== 0) {
      console.log(
        '[2/4] @vercel/nft: install failed (non-fatal) — validate.mjs will ' +
          'run nftrs-only.',
      );
    } else {
      console.log('[2/4] @vercel/nft: ok');
    }
  } else {
    console.log('[2/4] @vercel/nft: npm not found (non-fatal, nftrs-only)');
  }

  if (cloneOnly) {
    console.log('\n--clone-only: stopping after clone.');
    return finish();
  }

  // --- step 3: install Misskey workspace deps ---
  if (!have('pnpm')) {
    block(
      'install',
      'pnpm not found on PATH. Misskey uses pnpm workspaces. Install pnpm ' +
        '(`npm i -g pnpm` or corepack) and re-run, or build Misskey yourself ' +
        'and point --dir at it.',
    );
    return finish();
  }
  const haveModules = fs.existsSync(`${checkout}/node_modules`);
  if (haveModules) {
    console.log('\n[3/4] pnpm install: node_modules present, skipping');
  } else {
    const r = run('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout });
    if (r.status !== 0) {
      block(
        'install',
        `pnpm install failed (status ${r.status ?? 'spawn-error'}). This is ` +
          `the most common blocker: Misskey's full dependency tree is multi-GB ` +
          `and pulls native deps. Free up disk / fix network and retry:\n` +
          `    (cd ${checkout} && pnpm install)`,
      );
      return finish();
    }
    console.log('[3/4] pnpm install: ok');
  }

  // --- step 4: build the backend (+ its workspace deps) ---
  const entryBefore = findBackendEntry(checkout);
  if (entryBefore && entryBefore.kind === 'built-js') {
    console.log('\n[4/4] build: backend already built, skipping');
    return finish();
  }
  // Misskey's root build builds all packages; the backend depends on shared
  // workspace packages so a filtered build still needs them. Use the root
  // build script which is the documented path.
  const r = run('pnpm', ['run', 'build'], { cwd: checkout });
  if (r.status !== 0) {
    block(
      'build',
      `\`pnpm run build\` failed (status ${r.status ?? 'spawn-error'}). ` +
        `Misskey's build compiles many TS packages and can need extra system ` +
        `deps. Inspect the log above. You can still validate against the TS ` +
        `source: validate.mjs falls back to tracing packages/backend/src/boot/` +
        `entry.ts when no built JS exists.`,
    );
    return finish();
  }
  console.log('[4/4] build: ok');
  return finish();
}

function finish() {
  console.log('\n' + '─'.repeat(56));
  const entry = fs.existsSync(checkout) ? findBackendEntry(checkout) : null;
  if (entry) {
    console.log(`Backend entry available: ${entry.rel} (${entry.kind})`);
    console.log('Next:');
    console.log('  node compat/misskey/validate.mjs');
    console.log('  node compat/misskey/bench.mjs');
  }
  if (blockedAt) {
    console.error(`\nBLOCKED at step "${blockedAt.step}":`);
    console.error('  ' + blockedAt.message.split('\n').join('\n  '));
    if (entry) {
      console.error(
        '\n(But a usable entrypoint already exists, so you may still be able ' +
          'to run validate.mjs above.)',
      );
    }
    process.exit(1);
  }
  console.log('\nsetup: ok');
  process.exit(0);
}

main();
