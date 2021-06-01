#!/usr/bin/env node

import { join, dirname } from 'path';
import { promises, statSync, lstatSync } from 'fs';
const { copyFile, mkdir } = promises;
const rimraf = require('rimraf');
import { nodeFileTrace } from './node-file-trace';


async function cli(
  action = process.argv[2],
  files = process.argv.slice(3),
  outputDir = 'dist',
  cwd = process.cwd()
  ) {
  const opts = {
    ts: true,
    mixedModules: true,
    log: action !== 'size'
  };

  const { fileList, esmFileList, warnings } = await nodeFileTrace(files, opts);
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
  } else if (action === 'size') {
    const isSymbolicLink = (m: number) => (m & 61440) === 40960;
    let bytes = 0;
    for (const f of allFiles) {
      const lstat = lstatSync(f);
      if (isSymbolicLink(lstat.mode)) {
        bytes += lstat.size;
      } else {
        const stat = statSync(f)
        bytes += stat.size;
      }
    }
    stdout.push(`${bytes} bytes total`)
  } else {
    stdout.push(`△ nft ${require('../package.json').version}`);
    stdout.push('');
    stdout.push('Usage:');
    stdout.push('');
    stdout.push(`  $ nft [command] <file>`);
    stdout.push('');
    stdout.push('Commands:');
    stdout.push('');
    stdout.push('  build    trace and copy to the dist directory');
    stdout.push('  print    trace and print to stdout');
    stdout.push('   size    trace and print size in bytes');
  }
  return stdout.join('\n');
}

if (require.main === module) {
  cli().then(console.log).catch(console.error);
}

module.exports = cli;