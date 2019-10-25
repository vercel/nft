#!/usr/bin/env node

const { join, dirname } = require('path');
const fs = require('fs');
const { promisify } = require('util');
const copyFile = promisify(fs.copyFile);
const mkdir = promisify(fs.mkdir);
const rimraf = require('rimraf');
const trace = require('./node-file-trace');

async function cli(
  action = process.argv[2],
  files = process.argv.slice(3),
  outputDir = 'dist',
  cwd = process.cwd()
  ) {
  const opts = {
    ts: true,
    mixedModules: true,
    log: true
  };

  const { fileList, esmFileList, warnings } = await trace(files, opts);
  const allFiles = fileList.concat(esmFileList);
  const stdout = [];

  if (action === 'print') {
    stdout.push('FILELIST:')
    stdout.push(...allFiles);
    stdout.push('\n');
    if (warnings.length > 0) {
      stdout.push('WARNINGS:');
      stdout.push(...warnings);
    }
  } else if (action === 'build') {
    rimraf.sync(join(cwd, outputDir));
    for (const f of allFiles) {
      const src = join(cwd, f);
      const dest = join(cwd, outputDir, f);
      const dir = dirname(dest);
      await mkdir(dir, { recursive: true });
      await copyFile(src, dest);
    }
  } else {
    stdout.push('△ nft - provide an action such as `nft build` or `nft print`.');
  }
  return stdout.join('\n');
}

if (require.main === module) {
  cli().then(console.log).catch(console.error);
}

module.exports = cli;