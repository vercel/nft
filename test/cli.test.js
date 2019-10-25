const { promisify } = require('util');
const { exec: _exec } = require('child_process');
const exec = promisify(_exec);

const inputjs = 'unit/wildcard/input.js';
const outputjs = 'unit/wildcard/assets/asset1.txt'; 

it('should correctly print trace from cli', async () => {
  const { stderr, stdout } = await exec(`../src/cli.js print ${inputjs}`, { cwd: __dirname });
  if (stderr){
    throw new Error(stderr);
  }
  expect(stdout).toMatch(outputjs);
});

it('should correctly print trace from required cli', async () => {
  // This is to satisfy code coverage
  const cli = require('../src/cli.js');
  const files = [__dirname + '/' + inputjs];
  const stdout = await cli('print', files);
  expect(stdout).toMatch(outputjs);
});