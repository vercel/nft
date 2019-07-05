const fs = require('fs');
const nodeFileTrace = require('../src/node-file-trace');

global._unit = true;

for (const unitTest of fs.readdirSync(`${__dirname}/unit`)) {
  if (unitTest.startsWith('pkginfo')) continue;
  it(`should correctly trace ${unitTest}`, async () => {
    const unitPath = `${__dirname}/unit/${unitTest}`;
    const { fileList, reasons } = await nodeFileTrace([`${unitPath}/input.js`], {
      base: `${__dirname}/unit`,
      filterBase: false,
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
