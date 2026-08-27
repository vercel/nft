const { join, parse } = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');

it('does not glob from the filesystem root', async () => {
  const unitPath = join(__dirname, 'unit', 'asset-wildcard-root');
  const input = join(unitPath, 'input.js');
  const { fileList } = await nodeFileTrace([input], {
    base: parse(input).root,
    processCwd: unitPath,
  });
  expect([...fileList].some((file) => file.endsWith('input.js'))).toBe(true);
});
