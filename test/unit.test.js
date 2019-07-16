const fs = require('fs');
const nodeFileTrace = require('../src/node-file-trace');

global._unit = true;

function tryCreateSymlink (target, path) {
  try {
    fs.symlinkSync(target, path);
  }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

// ensure test/yarn-workspaces/node_modules/x -> test/yarn-workspaces/packages/x
try {
  fs.mkdirSync(`${__dirname}/unit/yarn-workspaces/node_modules`);
}
catch (e) {
  if (e.code !== 'EEXIST') throw e;
}
tryCreateSymlink('../packages/x', `${__dirname}/unit/yarn-workspaces/node_modules/x`);
tryCreateSymlink('./asset1.txt', `${__dirname}/unit/asset-symlink/asset.txt`);

for (const unitTest of fs.readdirSync(`${__dirname}/unit`)) {
  it(`should correctly trace ${unitTest}`, async () => {
    const unitPath = `${__dirname}/unit/${unitTest}`;
    const { fileList, reasons } = await nodeFileTrace([`${unitPath}/input.js`], {
      base: `${__dirname}/../`,
      ts: true,
      log: true,
      ignore: '**/actual.js'
    });
    let expected;
    try {
      expected = JSON.parse(fs.readFileSync(`${unitPath}/output.js`).toString());
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
      fs.writeFileSync(`${unitPath}/actual.js`, JSON.stringify(fileList, null, 2));
      throw e;
    }
  });
}
