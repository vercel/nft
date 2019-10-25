#!/usr/bin/env node

const { join, dirname } = require('path');
const fs = require('fs');
const { promisify } = require('util');
const copyFile = promisify(fs.copyFile);
const mkdir = promisify(fs.mkdir);
const trace = require('./node-file-trace');

async function main() {
  const cwd = process.cwd();
  const action = process.argv[2];
  const files = process.argv.slice(3);
  const outputDir = 'dist';

  const { fileList, esmFileList } = await trace(files, {
    ts: true,
    mixedModules: true,
    log: true
  });

  const allFiles = fileList.concat(esmFileList);

  if (action === 'print') {
    console.log('FILELIST:')
    console.log(allFiles.join('\n'));
    console.log('\n');
    if (o.warnings.length > 0) {
      console.log('WARNINGS:');
      console.log(o.warnings);
    }
  } else if (action === 'build') {
    for (const f of allFiles) {
      const src = join(cwd, f);
      const dest = join(cwd, outputDir, f);
      const dir = dirname(dest);
      await mkdir(dir, { recursive: true });
      await copyFile(src, dest);
    }
  } else {
    console.log('Provide an action like `nft build` or `nft print`.');
  }
}

main().then(() => console.log('Done')).catch(e => console.error(e));