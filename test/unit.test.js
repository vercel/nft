const fs = require('fs');
const { join } = require('path');
const nodeFileTrace = require('../src/node-file-trace');

global._unit = true;

function tryCreateSymlink (target, path) {
  if (process.platform === 'win32') {
    console.log('skipping create symlink on Windows');
    return;
  }
  try {
    fs.symlinkSync(target, path);
  }
  catch (e) {
    if (e.code !== 'EEXIST' && e.code !== 'UNKNOWN') throw e;
  }
}

// ensure test/yarn-workspaces/node_modules/x -> test/yarn-workspaces/packages/x
try {
  fs.mkdirSync(join(__dirname, 'unit', 'yarn-workspaces', 'node_modules'));
}
catch (e) {
  if (e.code !== 'EEXIST' && e.code !== 'UNKNOWN') throw e;
}
tryCreateSymlink('../packages/x', join(__dirname, 'unit', 'yarn-workspaces', 'node_modules', 'x'));
tryCreateSymlink('./asset1.txt',  join(__dirname, 'unit', 'asset-symlink', 'asset.txt'));

for (const unitTest of fs.readdirSync(join(__dirname, 'unit'))) {
  if (process.platform === 'win32' && ['yarn-workspaces', 'asset-symlink', 'require-symlink'].includes(unitTest)) {
    console.log('skipping symlink test on Windows: ' + unitTest);
    continue;
  }
  it(`should correctly trace ${unitTest}`, async () => {
    const unitPath = join(__dirname, 'unit', unitTest);
    const { fileList, reasons } = await nodeFileTrace([join(unitPath, 'input.js')], {
      base: `${__dirname}/../`,
      ts: true,
      log: true,
      mixedModules: true,
      ignore: '**/actual.js'
    });
    let expected;
    try {
      expected = JSON.parse(fs.readFileSync(join(unitPath, 'output.js')).toString());
      if (process.platform === 'win32') {
        // When using Windows, the expected output should use backslash
        expected = expected.map(str => str.replace(/\//g, '\\'));
      }
    }
    catch (e) {
      console.warn(e);
      expected = [];
    }
    try {
      expect(fileList).toEqual(expected);
    }
    catch (e) {
      console.warn(reasons);
      fs.writeFileSync(join(unitPath, 'actual.js'), JSON.stringify(fileList, null, 2));
      throw e;
    }
  });
}
