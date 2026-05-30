#!/usr/bin/env node
// Timing comparison: @vercel/nft's `nodeFileTrace` vs the nftrs napi binding
// over the same representative `test/unit` fixtures. Option wiring mirrors
// `compat/run.mjs`. Reports per-fixture median (ms) and the nftrs speedup.
//
// Build first:
//   tsc                                   # builds @vercel/nft -> out/index.js
//   (cd crates/nftrs_napi && napi build --release && \
//      ln -sf nftrs.node nftrs.darwin-arm64.node)
//
// Usage: node compat/bench.mjs [--json]

import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..');
const unitDir = join(repoRoot, 'test', 'unit');

const nftrs = require(join(repoRoot, 'crates', 'nftrs_napi')).nodeFileTrace;
const { nodeFileTrace: nft } = require(join(repoRoot, 'out', 'index.js'));

const asJson = process.argv.includes('--json');

// Same set as crates/nftrs_core/benches/trace.rs.
const FIXTURES = [
  ['import-meta-url', ['input.js']],
  ['wildcard', ['input.js']],
  ['webpack-wrapper', ['input.js']],
  ['asset-fs-extra', ['input.js']],
  ['asset-fs-inlining', ['input.js']],
  ['multi-input', ['input.js', 'input-2.js', 'input-3.js', 'input-4.js']],
  ['browserify', ['input.js']],
  ['asset-graceful-fs', ['input.js']],
  ['asset-package-json', ['input.js']],
  ['class-static', ['input.js']],
];

function optsFor(name) {
  const unitPath = join(unitDir, name);
  return {
    base: `${repoRoot}/`,
    processCwd: unitPath,
    paths: {
      dep: `${unitDir}/esm-paths/esm-dep.js`,
      'dep/': `${unitDir}/esm-paths-trailer/`,
    },
    exportsOnly: false,
    ts: true,
    analysis: true,
    mixedModules: true,
    ignore: (str) =>
      str.endsWith('/actual.js') || str.startsWith('usr/local'),
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function timeFn(fn, iters) {
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6); // ms
  }
  return median(samples);
}

async function main() {
  const WARMUP = 20;
  const ITERS = 100;
  const rows = [];

  for (const [name, inputs] of FIXTURES) {
    const files = inputs.map((f) => join(unitDir, name, f));
    const opts = optsFor(name);

    const runNft = () => nft(files, opts);
    const runRs = () => nftrs(files, opts);

    // Warm up both.
    for (let i = 0; i < WARMUP; i++) {
      await runNft();
      await runRs();
    }

    const nftMs = await timeFn(runNft, ITERS);
    const rsMs = await timeFn(runRs, ITERS);
    rows.push({ name, nftMs, rsMs, speedup: nftMs / rsMs });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (x) => x.toFixed(3);
  console.log(
    `\n@vercel/nft vs nftrs — median of ${ITERS} iters (node ${process.versions.node})`,
  );
  console.log('─'.repeat(64));
  console.log(
    `${pad('fixture', 20)}${pad('nft (ms)', 12)}${pad('nftrs (ms)', 12)}speedup`,
  );
  let totalNft = 0;
  let totalRs = 0;
  for (const r of rows) {
    totalNft += r.nftMs;
    totalRs += r.rsMs;
    console.log(
      `${pad(r.name, 20)}${pad(num(r.nftMs), 12)}${pad(num(r.rsMs), 12)}${r.speedup.toFixed(1)}x`,
    );
  }
  console.log('─'.repeat(64));
  console.log(
    `${pad('TOTAL', 20)}${pad(num(totalNft), 12)}${pad(num(totalRs), 12)}${(totalNft / totalRs).toFixed(1)}x`,
  );
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
