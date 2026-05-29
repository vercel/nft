#!/usr/bin/env node
// Compatibility harness: runs @vercel/nft's `test/unit` fixtures against our
// Rust `@nftrs/core` binding and reports how many match (the "N/154 passing"
// gate for M1). Mirrors the option wiring in `test/unit.test.js`, but compares
// only the sorted `fileList` against each fixture's `output.js` for now;
// reason-graph assertions are layered on once `reasons` is returned (#22).
//
// Usage:
//   node compat/run.mjs            # human summary
//   node compat/run.mjs --json     # machine-readable summary to stdout
//   node compat/run.mjs --filter foo   # only fixtures whose name includes "foo"
//
// See https://github.com/ubugeeei-prod/nftrs/issues/9

import fs from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..');
const unitDir = join(repoRoot, 'test', 'unit');

const binding = require(join(repoRoot, 'crates', 'nftrs_napi'));
const nodeFileTrace = binding.nodeFileTrace;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
// --check ratchets against compat/baseline.json: exit non-zero if the number
// of passing fixtures drops below the committed baseline. Bump the baseline as
// fixtures are turned green so the count can only go up.
const check = args.includes('--check');
const filterIdx = args.indexOf('--filter');
const filter = filterIdx !== -1 ? args[filterIdx + 1] : null;

// Skip rules ported from test/unit.test.js (platform / node version specific).
const skipOnWindows = [
  'datadog-pprof-node-gyp', 'yarn-workspaces', 'yarn-workspaces-base-root',
  'yarn-workspace-esm', 'asset-symlink', 'require-symlink',
];
const skipOnMac = [];
const skipOnNode20AndBelow = [
  'module-sync-condition-es', 'module-sync-condition-cjs',
  'module-sync-condition-es-default', 'module-sync-condition-es-nested',
  'imports-module-sync', 'imports-module-sync-cjs', 'self-reference-module-sync',
];
const skipOnNode22AndAbove = [
  'module-sync-condition-es-node20', 'module-sync-condition-cjs-node20',
];
const skipOnNode26AndAbove = ['datadog-pprof-node-gyp', 'phantomjs-prebuilt'];
const nodeGypTests = [
  'datadog-pprof-node-gyp', 'microtime-node-gyp', 'zeromq-node-gyp',
];
if (process.platform === 'darwin' && process.arch === 'arm64') {
  skipOnMac.push('microtime-node-gyp');
}

const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);

function inputNamesFor(testName) {
  if (testName === 'jsx-input') return ['input.jsx'];
  if (testName === 'tsx-input') return ['input.tsx'];
  if (testName === 'ts-input-esm') return ['input.ts'];
  if (
    testName === 'module-create-require-no-mixed' ||
    testName === 'module-create-require-named-require' ||
    testName === 'module-create-require-named-import' ||
    testName === 'module-create-require-ignore-other' ||
    testName === 'module-create-require-destructure'
  ) {
    return ['input.mjs'];
  }
  if (testName === 'multi-input') {
    return ['input.js', 'input-2.js', 'input-3.js', 'input-4.js'];
  }
  return ['input.js'];
}

function shouldSkip(testName) {
  if (process.platform === 'win32' && skipOnWindows.includes(testName)) return 'windows';
  if (process.platform === 'darwin' && skipOnMac.includes(testName)) return 'macos';
  if (nodeVersion < 22 && skipOnNode20AndBelow.includes(testName)) return 'node<22';
  if (nodeVersion >= 22 && skipOnNode22AndAbove.includes(testName)) return 'node>=22';
  if (nodeVersion >= 26 && skipOnNode26AndAbove.includes(testName)) return 'node>=26';
  return null;
}

function readExpected(unitPath) {
  const raw = fs.readFileSync(join(unitPath, 'output.js')).toString();
  return JSON.parse(raw);
}

function readOpts(unitPath) {
  try {
    return JSON.parse(fs.readFileSync(join(unitPath, 'test-opts.json')).toString());
  } catch {
    return {};
  }
}

async function traceFixture(testName) {
  const unitPath = join(unitDir, testName);
  const inputFileNames = inputNamesFor(testName);
  const testOpts = readOpts(unitPath);

  const result = await nodeFileTrace(
    inputFileNames.map((f) => join(unitPath, f)),
    {
      conditions: testOpts.conditions,
      base: `${repoRoot}/`,
      processCwd: unitPath,
      paths: {
        dep: `${unitDir}/esm-paths/esm-dep.js`,
        'dep/': `${unitDir}/esm-paths-trailer/`,
      },
      exportsOnly: testName.startsWith('exports-only'),
      moduleSyncCatchall: testOpts.moduleSyncCatchall,
      ts: true,
      analysis: !testName.startsWith('basic-analysis'),
      mixedModules: testOpts?.mixedModules ?? true,
      ignore: (str) => str.endsWith('/actual.js') || str.startsWith('usr/local'),
      depth: testOpts.depth,
    },
  );

  let fileList = [...result.fileList];
  if (nodeGypTests.includes(testName)) {
    fileList = fileList.filter(
      (file) => !(file.includes('prebuilds') && file.endsWith('.node')),
    );
  }
  return fileList.map((f) => f.replace(/\\/g, '/')).sort();
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  const all = fs.readdirSync(unitDir).filter((name) => {
    const p = join(unitDir, name);
    return fs.statSync(p).isDirectory() && fs.existsSync(join(p, 'output.js'));
  });

  const passed = [];
  const failed = [];
  const errored = [];
  const skipped = [];

  for (const testName of all) {
    if (filter && !testName.includes(filter)) continue;
    const reason = shouldSkip(testName);
    if (reason) {
      skipped.push({ testName, reason });
      continue;
    }
    let expected;
    try {
      expected = readExpected(join(unitDir, testName));
    } catch {
      skipped.push({ testName, reason: 'no-output' });
      continue;
    }
    try {
      const actual = await traceFixture(testName);
      if (arraysEqual(actual, [...expected].sort())) {
        passed.push(testName);
      } else {
        failed.push({ testName, expected: [...expected].sort(), actual });
      }
    } catch (err) {
      errored.push({ testName, error: String(err && err.message ? err.message : err) });
    }
  }

  const considered = passed.length + failed.length + errored.length;
  const summary = {
    passed: passed.length,
    failed: failed.length,
    errored: errored.length,
    skipped: skipped.length,
    considered,
    total: all.length,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify({ summary, failed, errored, skipped }, null, 2) + '\n');
  } else {
    console.log(`\nnftrs compatibility — test/unit`);
    console.log('─'.repeat(48));
    console.log(`  passed   ${summary.passed}/${considered}`);
    console.log(`  failed   ${summary.failed}`);
    console.log(`  errored  ${summary.errored}`);
    console.log(`  skipped  ${summary.skipped}`);
    if (failed.length) {
      console.log('\n  failing:');
      for (const f of failed) console.log(`    ✗ ${f.testName}`);
    }
    if (errored.length) {
      console.log('\n  errored:');
      for (const e of errored) console.log(`    ! ${e.testName}: ${e.error}`);
    }
    console.log('');
  }

  if (check) {
    const baselinePath = join(here, 'baseline.json');
    let baseline = { passed: 0 };
    try {
      baseline = JSON.parse(fs.readFileSync(baselinePath).toString());
    } catch {
      // No baseline yet — treat as 0.
    }
    if (summary.passed < baseline.passed) {
      console.error(
        `\nCompat regression: ${summary.passed} passing < baseline ${baseline.passed}.`,
      );
      process.exit(1);
    }
    if (summary.passed > baseline.passed) {
      console.error(
        `\nCompat improved: ${summary.passed} passing > baseline ${baseline.passed}. ` +
          `Bump compat/baseline.json to lock it in.`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
