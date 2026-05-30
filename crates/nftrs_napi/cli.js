#!/usr/bin/env node
// CLI for @nftrs/core — a drop-in equivalent of @vercel/nft's `nft` CLI.
// Ports the `print` / `build` / `size` actions from src/cli.ts. The `why`
// action depends on the `reasons` graph (not yet returned — see issue #21).

'use strict';

const { join, dirname, isAbsolute, relative, sep } = require('node:path');
const fs = require('node:fs');
const { nodeFileTrace } = require('./index.js');

// Print the `file` and recursively its parents (ports nft's `printStack`).
function printStack(file, reasons, stdout, seen = new Set()) {
  if (seen.has(file)) return;
  seen.add(file);
  stdout.push(file);
  const reason = reasons[file];
  if (!reason || !reason.parents || reason.parents.length === 0) return;
  for (const parent of reason.parents) printStack(parent, reasons, stdout, seen);
}

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
    '  build [entrypoint]        trace and copy to the dist directory',
    '  print [entrypoint]        trace and print the file list to stdout',
    '   size [entrypoint]        trace and print the total size in bytes',
    '    why [entrypoint] [file]  trace and print why <file> was included',
  ];

  if (!entrypoint || !['print', 'build', 'size', 'why'].includes(action)) {
    return usage.join('\n');
  }

  const { fileList, esmFileList, warnings, reasons } = await nodeFileTrace(
    [entrypoint],
    { ts: true, base: cwd, mixedModules: true },
  );
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
    if (!exitpoint) {
      throw new Error('Expected an additional <file> argument for the "why" command.');
    }
    const target = (isAbsolute(exitpoint) ? relative(cwd, exitpoint) : exitpoint).replace(
      /[/\\]/g,
      sep,
    );
    printStack(target, reasons, stdout);
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
