const { join, relative } = require('path');
const { pathToFileURL } = require('url');
const { nodeFileTrace } = require('../out/node-file-trace');

const unitPath = join(__dirname, 'unit', 'string-concat');

it('should accept a URL instance as input', async () => {
  const inputPath = join(unitPath, 'input.js');
  const inputUrl = pathToFileURL(inputPath);
  const { fileList } = await nodeFileTrace([inputUrl], {
    base: `${__dirname}/../`,
    processCwd: unitPath,
    ts: true,
    log: true,
    mixedModules: true,
  });
  expect(fileList.size).toBeGreaterThan(0);
  // The input file itself should be in the file list
  const relativeInput = relative(join(__dirname, '..'), inputPath);
  expect(fileList.has(relativeInput)).toBe(true);
});

it('should produce identical results for URL and string inputs', async () => {
  const inputPath = join(unitPath, 'input.js');
  const inputUrl = pathToFileURL(inputPath);
  const opts = {
    base: `${__dirname}/../`,
    processCwd: unitPath,
    ts: true,
    log: true,
    mixedModules: true,
  };

  const resultFromString = await nodeFileTrace([inputPath], opts);
  const resultFromUrl = await nodeFileTrace([inputUrl], opts);

  expect([...resultFromUrl.fileList].sort()).toEqual(
    [...resultFromString.fileList].sort(),
  );
});

it('should accept a mix of URL and string inputs', async () => {
  const multiInputPath = join(__dirname, 'unit', 'multi-input');
  const input1 = join(multiInputPath, 'input.js');
  const input2 = pathToFileURL(join(multiInputPath, 'input-2.js'));

  const { fileList } = await nodeFileTrace([input1, input2], {
    base: `${__dirname}/../`,
    processCwd: multiInputPath,
    ts: true,
    log: true,
    mixedModules: true,
    ignore: (str) => str.endsWith('/actual.js'),
  });

  expect(fileList.size).toBeGreaterThan(0);
  // Both inputs should be in the file list
  const base = join(__dirname, '..');
  const relInput1 = relative(base, input1);
  const relInput2 = relative(base, join(multiInputPath, 'input-2.js'));
  expect(fileList.has(relInput1)).toBe(true);
  expect(fileList.has(relInput2)).toBe(true);
});
