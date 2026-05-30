#!/usr/bin/env node
// Validate nftrs against @vercel/nft on the real Misskey backend entrypoint.
//
// Traces Misskey's backend entry with BOTH tracers (when nft is available) and
// diffs the resulting file lists: total count, files-only-in-nft, and
// files-only-in-nftrs. Exits non-zero on any mismatch so CI / a human can gate
// on it. When @vercel/nft is not installed, it still runs nftrs alone and
// reports the list with a clear "comparison skipped" note (exit 0).
//
// Usage:
//   node compat/misskey/validate.mjs [--dir <misskey-checkout>] [--json]
//   MISSKEY_DIR=/path/to/misskey node compat/misskey/validate.mjs
//
// Default checkout dir: compat/misskey/.checkout  (see setup.mjs).
//
// See issues #26 (validate), #27 (fix gaps), #28 (benchmark).

import {
  DEFAULT_CHECKOUT,
  findBackendEntry,
  loadNftrs,
  loadVercelNft,
  normalizeList,
  resolveCheckoutDir,
} from './lib.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

function log(...a) {
  if (!asJson) console.log(...a);
}

async function main() {
  const checkoutDir = resolveCheckoutDir(argv);
  const found = findBackendEntry(checkoutDir);

  if (!found) {
    const msg =
      `No Misskey backend entrypoint found under ${checkoutDir}.\n` +
      `Expected one of:\n` +
      `  packages/backend/built/boot/entry.js  (built — preferred)\n` +
      `  packages/backend/src/boot/entry.ts    (source fallback)\n` +
      `Run \`node compat/misskey/setup.mjs\` to clone+build Misskey, or pass\n` +
      `--dir / set MISSKEY_DIR to an existing checkout` +
      (checkoutDir === DEFAULT_CHECKOUT ? '.' : '.');
    if (asJson) {
      process.stdout.write(
        JSON.stringify({ status: 'no-checkout', checkoutDir, message: msg }, null, 2) +
          '\n',
      );
    } else {
      console.error(msg);
    }
    process.exit(2);
  }

  log(`Misskey checkout : ${checkoutDir}`);
  log(`Backend entry    : ${found.rel} (${found.kind})`);

  const nftrs = loadNftrs();
  log(`nftrs            : ${nftrs.version()}  (from ${nftrs.from})`);

  // nft is normally run against built JS with base = the package/repo root.
  // Use the entry's package as the trace base so paths line up across tools.
  const base = checkoutDir;
  const traceOpts = {
    base: `${base}/`,
    ts: found.kind === 'src-ts',
  };

  // --- nftrs trace ---
  const tNftrs0 = performance.now();
  const nftrsRes = nftrs.nodeFileTrace([found.entry], traceOpts);
  const nftrsMs = performance.now() - tNftrs0;
  const nftrsList = normalizeList(nftrsRes.fileList);
  log(`nftrs files      : ${nftrsList.length}  (${nftrsMs.toFixed(0)} ms)`);
  if (nftrsRes.warnings?.length) {
    log(`nftrs warnings   : ${nftrsRes.warnings.length}`);
  }

  // --- @vercel/nft trace (optional) ---
  const nft = loadVercelNft();
  if (!nft) {
    const note =
      '@vercel/nft is not installed — comparison skipped (nftrs list only).\n' +
      'Install it with: (cd compat/misskey && npm i @vercel/nft) or run setup.mjs.';
    log('');
    log(note);
    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          {
            status: 'nftrs-only',
            checkoutDir,
            entry: found.rel,
            entryKind: found.kind,
            nftrs: { version: nftrs.version(), count: nftrsList.length, ms: nftrsMs },
            note,
          },
          null,
          2,
        ) + '\n',
      );
    }
    // nftrs-only is not a failure: the harness ran successfully.
    process.exit(0);
  }

  log(`@vercel/nft      : ${nft.version}  (from ${nft.from})`);
  const tNft0 = performance.now();
  const nftRes = await nft.nodeFileTrace([found.entry], { base: `${base}/`, ts: traceOpts.ts });
  const nftMs = performance.now() - tNft0;
  const nftList = normalizeList(nftRes.fileList);
  log(`nft files        : ${nftList.length}  (${nftMs.toFixed(0)} ms)`);
  if (nftRes.warnings?.size || nftRes.warnings?.length) {
    log(`nft warnings     : ${nftRes.warnings.size ?? nftRes.warnings.length}`);
  }

  // --- diff ---
  const nftrsSet = new Set(nftrsList);
  const nftSet = new Set(nftList);
  const onlyInNft = nftList.filter((f) => !nftrsSet.has(f));
  const onlyInNftrs = nftrsList.filter((f) => !nftSet.has(f));
  const match = onlyInNft.length === 0 && onlyInNftrs.length === 0;

  const result = {
    status: match ? 'match' : 'mismatch',
    checkoutDir,
    entry: found.rel,
    entryKind: found.kind,
    nft: { version: nft.version, count: nftList.length, ms: nftMs },
    nftrs: { version: nftrs.version(), count: nftrsList.length, ms: nftrsMs },
    diff: {
      onlyInNftCount: onlyInNft.length,
      onlyInNftrsCount: onlyInNftrs.length,
      onlyInNft,
      onlyInNftrs,
    },
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    log('');
    log('─'.repeat(56));
    log(`  nft   : ${nftList.length} files`);
    log(`  nftrs : ${nftrsList.length} files`);
    log(`  only in nft   : ${onlyInNft.length}`);
    log(`  only in nftrs : ${onlyInNftrs.length}`);
    const cap = 40;
    if (onlyInNft.length) {
      log('\n  files only in @vercel/nft (nftrs MISSED these):');
      for (const f of onlyInNft.slice(0, cap)) log(`    - ${f}`);
      if (onlyInNft.length > cap) log(`    … and ${onlyInNft.length - cap} more`);
    }
    if (onlyInNftrs.length) {
      log('\n  files only in nftrs (extra / over-traced):');
      for (const f of onlyInNftrs.slice(0, cap)) log(`    + ${f}`);
      if (onlyInNftrs.length > cap)
        log(`    … and ${onlyInNftrs.length - cap} more`);
    }
    log('');
    log(match ? '  RESULT: MATCH ✓' : '  RESULT: MISMATCH ✗');
    log('');
  }

  process.exit(match ? 0 : 1);
}

main().catch((err) => {
  if (asJson) {
    process.stdout.write(
      JSON.stringify({ status: 'error', error: String(err?.stack || err) }, null, 2) +
        '\n',
    );
  } else {
    console.error(err);
  }
  process.exit(3);
});
