const { spawn } = require('child_process');
const path = require('path');

const tsc = require.resolve('typescript/bin/tsc');
console.log('path to tsc is ' + tsc);

const child = spawn(tsc, { cwd: path.resolve(__dirname, '..', 'fixtures') });
child.stdout.on('data', data => {
  console.error(data.toString());
  throw new Error('Unexpected output.');
});
child.stderr.on('data', data => {
  console.error(data.toString());
  throw new Error('Unexpected output.')
});
