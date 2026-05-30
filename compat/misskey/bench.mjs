#!/usr/bin/env node
// Benchmark nftrs tracing the real Misskey backend entrypoint (issue #28).
//
// Runs nftrs N times over the Misskey entry and reports mean / min / max wall
// time plus the file count. Only runs if a checkout with a backend entry
// exists; otherwise prints guidance and exits non-zero. If @vercel/nft is
// installed, also benches it for a side-by-side speed comparison.
//
// Usage:
//   node compat/misskey/bench.mjs [--dir <checkout>] [--runs N] [--json]
//   MISSKEY_DIR=/path node compat/misskey/bench.mjs --runs 10

import {
  findBackendEntry,
  loadNftrs,
  loadVercelNft,
  resolveCheckoutDir,
} from './lib.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const runsIdx = argv.indexOf('--runs');
const runs = runsIdx !== -1 && argv[runsIdx + 1] ? parseInt(argv[runsIdx + 1], 10) : 5;

function log(...a) {
  if (!asJson) console.log(...a);
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    runs: times.length,
    meanMs: +(sum / times.length).toFixed(2),
    minMs: +sorted[0].toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2),
    medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
  };
}

async function main() {
  const checkoutDir = resolveCheckoutDir(argv);
  const found = findBackendEntry(checkoutDir);
  if (!found) {
    const msg =
      `No Misskey backend entrypoint under ${checkoutDir}; nothing to bench.\n` +
      `Run \`node compat/misskey/setup.mjs\` or pass --dir / set MISSKEY_DIR.`;
    if (asJson)
      process.stdout.write(
        JSON.stringify({ status: 'no-checkout', checkoutDir, message: msg }, null, 2) +
          '\n',
      );
    else console.error(msg);
    process.exit(2);
  }

  const nftrs = loadNftrs();
  const ts = found.kind === 'src-ts';
  const opts = { base: `${checkoutDir}/`, ts };

  log(`Benchmarking nftrs on ${found.rel} (${runs} runs)`);
  log(`  base: ${checkoutDir}`);

  // Warm-up run (caches FS stats, jit, etc.) — excluded from stats.
  const warm = nftrs.nodeFileTrace([found.entry], opts);
  const fileCount = warm.fileList.length;

  const nftrsTimes = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    nftrs.nodeFileTrace([found.entry], opts);
    nftrsTimes.push(performance.now() - t0);
  }
  const nftrsStats = stats(nftrsTimes);

  let nftStats = null;
  let nftVersion = null;
  const nft = loadVercelNft();
  if (nft) {
    nftVersion = nft.version;
    await nft.nodeFileTrace([found.entry], opts); // warm-up
    const nftTimes = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await nft.nodeFileTrace([found.entry], opts);
      nftTimes.push(performance.now() - t0);
    }
    nftStats = stats(nftTimes);
  }

  const result = {
    status: 'ok',
    checkoutDir,
    entry: found.rel,
    entryKind: found.kind,
    fileCount,
    nftrs: { version: nftrs.version(), ...nftrsStats },
    nft: nftStats ? { version: nftVersion, ...nftStats } : null,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    log('');
    log('─'.repeat(48));
    log(`  files traced : ${fileCount}`);
    log(
      `  nftrs        : mean ${nftrsStats.meanMs} ms  min ${nftrsStats.minMs} ms  max ${nftrsStats.maxMs} ms`,
    );
    if (nftStats) {
      log(
        `  @vercel/nft  : mean ${nftStats.meanMs} ms  min ${nftStats.minMs} ms  max ${nftStats.maxMs} ms`,
      );
      const speedup = (nftStats.meanMs / nftrsStats.meanMs).toFixed(2);
      log(`  speedup      : ${speedup}x (nft mean / nftrs mean)`);
    } else {
      log('  @vercel/nft  : not installed (nftrs-only bench)');
    }
    log('');
  }
}

main().catch((err) => {
  if (asJson)
    process.stdout.write(
      JSON.stringify({ status: 'error', error: String(err?.stack || err) }, null, 2) +
        '\n',
    );
  else console.error(err);
  process.exit(3);
});
