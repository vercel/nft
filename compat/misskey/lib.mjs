// Shared helpers for the Misskey validation harness (validate/bench/setup).
//
// The trickiest part is *loading nftrs*: the napi `.node` artifact is
// gitignored and built per-checkout, so a git worktree that hasn't been built
// will not have one. We therefore try a series of candidate roots and load the
// first one whose native binding actually resolves. See README.md.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
export const here = dirname(fileURLToPath(import.meta.url));
// compat/misskey -> compat -> repo root
export const compatDir = dirname(here);
export const worktreeRoot = dirname(compatDir);

/** Default Misskey checkout location (overridable via env / --dir). */
export const DEFAULT_CHECKOUT = join(here, '.checkout');

/**
 * Candidate directories that may contain a built `crates/nftrs_napi` addon,
 * in priority order. We include every git worktree of this repo because agent
 * worktrees often share a single built `.node` in the primary checkout.
 */
function nftrsCandidates() {
  const cands = [];
  if (process.env.NFTRS_NAPI) cands.push(resolve(process.env.NFTRS_NAPI));
  cands.push(join(worktreeRoot, 'crates', 'nftrs_napi'));
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
    });
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        const wt = line.slice('worktree '.length).trim();
        cands.push(join(wt, 'crates', 'nftrs_napi'));
      }
    }
  } catch {
    // not a git repo / git missing — fine, fall through to what we have
  }
  // De-dup while preserving order.
  return [...new Set(cands)];
}

/**
 * Load the nftrs napi binding, returning `{ nodeFileTrace, version, from }`.
 * Throws a descriptive error listing every candidate tried on failure.
 */
export function loadNftrs() {
  const tried = [];
  for (const dir of nftrsCandidates()) {
    const entry = join(dir, 'index.js');
    if (!fs.existsSync(entry)) {
      tried.push(`${dir} (no index.js)`);
      continue;
    }
    try {
      const mod = require(entry);
      if (typeof mod.nodeFileTrace !== 'function') {
        tried.push(`${dir} (no nodeFileTrace export)`);
        continue;
      }
      return { ...mod, from: dir };
    } catch (err) {
      tried.push(`${dir} (load failed: ${err.message.split('\n')[0]})`);
    }
  }
  throw new Error(
    'Could not load the nftrs napi binding. Build it first:\n' +
      '  cd crates/nftrs_napi && ./node_modules/.bin/napi build --release && \\\n' +
      '    ln -sf nftrs.node nftrs.darwin-arm64.node\n' +
      'or point NFTRS_NAPI at a checkout that has a built `.node`.\n' +
      'Tried:\n  - ' +
      tried.join('\n  - '),
  );
}

/**
 * Try to load `@vercel/nft`'s programmatic `nodeFileTrace`. Returns the fn or
 * `null` if it isn't installed (the harness degrades to nftrs-only). We look in
 * compat/misskey/node_modules first (where setup.mjs installs it), then the
 * ambient resolution.
 */
export function loadVercelNft() {
  const candidates = [
    join(here, 'node_modules', '@vercel', 'nft'),
    '@vercel/nft',
  ];
  for (const c of candidates) {
    try {
      const mod = require(c);
      if (typeof mod.nodeFileTrace !== 'function') continue;
      let version = 'unknown';
      try {
        const pkgSpec =
          c === '@vercel/nft'
            ? '@vercel/nft/package.json'
            : join(c, 'package.json');
        version = require(pkgSpec).version;
      } catch {
        // ignore
      }
      return { nodeFileTrace: mod.nodeFileTrace, version, from: c };
    } catch {
      // keep trying
    }
  }
  return null;
}

/**
 * Locate the Misskey backend entrypoint inside a checkout. Prefers the built
 * JS (what nft is normally pointed at in production) but falls back to the TS
 * source so the harness still works on a source-only checkout.
 * Returns `{ entry, kind, rel } | null`.
 */
export function findBackendEntry(checkoutDir) {
  const candidates = [
    // Newer Misskey (>= 2026.x) bundles the backend with rolldown to a single
    // `built/entry.js`; older layouts used `built/boot/entry.js`.
    { rel: 'packages/backend/built/entry.js', kind: 'built-js' },
    { rel: 'packages/backend/built/boot/entry.js', kind: 'built-js' },
    { rel: 'packages/backend/built/index.js', kind: 'built-js' },
    { rel: 'packages/backend/src/boot/entry.ts', kind: 'src-ts' },
    { rel: 'packages/backend/src/index.ts', kind: 'src-ts' },
  ];
  for (const c of candidates) {
    const p = join(checkoutDir, c.rel);
    if (fs.existsSync(p)) return { entry: p, kind: c.kind, rel: c.rel };
  }
  return null;
}

/** Normalize a fileList to a sorted array of forward-slash relative paths. */
export function normalizeList(list) {
  return [...list].map((f) => f.replace(/\\/g, '/')).sort();
}

/** Parse a `--dir <path>` arg, falling back to env or the default checkout. */
export function resolveCheckoutDir(argv) {
  const i = argv.indexOf('--dir');
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  if (process.env.MISSKEY_DIR) return resolve(process.env.MISSKEY_DIR);
  return DEFAULT_CHECKOUT;
}
