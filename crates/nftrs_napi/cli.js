#!/usr/bin/env node
// CLI for @nftrs/core — a drop-in equivalent of @vercel/nft's `nft` CLI.
// Ports the `print` / `build` / `size` actions from src/cli.ts. The `why`
// action depends on the `reasons` graph (not yet returned — see issue #21).

'use strict';

const { join, dirname, isAbsolute } = require('node:path');
const fs = require('node:fs');
const { nodeFileTrace } = require('./index.js');

async function cli(
  action = process.argv[2],
  entrypoint = process.argv[3],
  exitpoint = process.argv[4],
  outputDir = 'dist',
  cwd = process.cwd(),
) {
  const usage = [
    '△ nftrs',
    '',
    'Usage:',
    '',
    '  $ nftrs [command] <file>',
    '',
    'Commands:',
    '',
    '  build [entrypoint]   trace and copy to the dist directory',
    '  print [entrypoint]   trace and print the file list to stdout',
    '   size [entrypoint]   trace and print the total size in bytes',
  ];

  if (!entrypoint || !['print', 'build', 'size', 'why'].includes(action)) {
    return usage.join('\n');
  }

  const { fileList, esmFileList, warnings } = await nodeFileTrace([entrypoint], {
    ts: true,
    base: cwd,
    mixedModules: true,
  });
  const allFiles = [...fileList].concat([...esmFileList]).sort();
  const stdout = [];

  if (action === 'print') {
    stdout.push('FILELIST:', ...allFiles, '');
    if (warnings && warnings.length > 0) {
      stdout.push('WARNINGS:', ...warnings.map(String));
    }
  } else if (action === 'build') {
    fs.rmSync(join(cwd, outputDir), { recursive: true, force: true });
    for (const f of allFiles) {
      const dest = join(cwd, outputDir, f);
      fs.mkdirSync(dirname(dest), { recursive: true });
      fs.copyFileSync(join(cwd, f), dest);
    }
    stdout.push(`Copied ${allFiles.length} files to ${outputDir}/`);
  } else if (action === 'size') {
    let bytes = 0;
    for (const f of allFiles) {
      const lstat = fs.lstatSync(f);
      bytes += lstat.isSymbolicLink() ? lstat.size : fs.statSync(f).size;
    }
    stdout.push(`${bytes} bytes total`);
  } else if (action === 'why') {
    // The `reasons` graph is not yet returned by the napi binding (issue #21).
    void exitpoint;
    void isAbsolute;
    throw new Error(
      'The "why" command requires the reasons graph, which is not implemented yet (see #21).',
    );
  }
  return stdout.join('\n');
}

if (require.main === module) {
  cli().then(console.log).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = cli;
