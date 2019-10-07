#!/usr/bin/env node
const trace = require('./node-file-trace');
const files = process.argv.slice(2);

trace(files, {
  ts: true,
  mixedModules: true,
  log: true
}).then(o => {
  console.log('FILELIST:')
  console.log(o.fileList.join('\n'));
  console.log('\n');
  if (o.warnings.length > 0) {
    console.log('WARNINGS:');
    console.log(o.warnings);
  }
}).catch(e => {
  console.error(e)
});