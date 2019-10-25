const { promisify } = require('util');
const { existsSync } = require('fs');
const { join } = require('path');
const cp = require('child_process');
const exec = promisify(cp.exec);

const inputjs = 'unit/wildcard/input.js';
const outputjs = 'unit/wildcard/assets/asset1.txt';

function normalizeOutput(output) {
  if (process.platform === 'win32') {
    // When using Windows, the expected output should use backslash
    output = output.replace(/\//g, '\\');
  }
  return output;
}

it('should correctly print trace from cli', async () => {
  const { stderr, stdout } = await exec(`node ../src/cli.js print ${inputjs}`, { cwd: __dirname });
  if (stderr) {
    throw new Error(stderr);
  }
  expect(stdout).toMatch(normalizeOutput(outputjs));
});

it('should correctly build dist from cli', async () => {
  const { stderr } = await exec(`node ../src/cli.js build ${inputjs}`, { cwd: __dirname });
  if (stderr) {
    throw new Error(stderr);
  }
  const found = existsSync(join(__dirname, outputjs));
  expect(found).toBe(true);
});

it('should correctly print help when unknown action is used', async () => {
  const { stderr, stdout } = await exec(`node ../src/cli.js unknown ${inputjs}`, { cwd: __dirname });
  if (stderr) {
    throw new Error(stderr);
  }
  expect(stdout).toMatch('provide an action');
});

it('[codecov] should correctly print trace from required cli', async () => {
  // This test is only here to satisfy code coverage
  const cli = require('../src/cli.js')
  const files = [join(__dirname, inputjs)];
  const stdout = await cli('print', files);
  expect(stdout).toMatch(normalizeOutput(outputjs));
});

it('[codecov] should correctly build dist from required cli', async () => {
  // This test is only here to satisfy code coverage
  const cli = require('../src/cli.js')
  const files = [join(__dirname, inputjs)];
  await cli('build', files);
  const found = existsSync(join(__dirname, outputjs));
  expect(found).toBe(true);
});

it('[codecov] should correctly print help when unknown action is used', async () => {
  // This test is only here to satisfy code coverage
  const cli = require('../src/cli.js')
  const files = [join(__dirname, inputjs)];
  const stdout = await cli('unknown', files);
  expect(stdout).toMatch('provide an action');
});