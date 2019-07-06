const fs = require('fs');
const path = require('path');
const nodeFileTrace = require('../src/node-file-trace');
const os = require('os');
const { promisify } = require('util');
const rimraf = require('rimraf');
const mkdirp = promisify(require('mkdirp'));
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const { fork } = require('child_process');

const tmpdir = path.resolve(os.tmpdir(), 'node-file-trace');

jest.setTimeout(20000);

const skipTests = [
  'leveldown',
  'sequelize',
  'loopback',
  'lighthouse',
  'json-without-ext',
  'firebase',
  'chromeless',
  'azure-cosmos',
  'bindings-failure',
  'pug',

  // hmm
  'esm'
];

for (const integrationTest of fs.readdirSync(`${__dirname}/integration`)) {
  if (skipTests.some(skipTest => integrationTest === skipTest + '.js')) continue;
  it(`should correctly trace and correctly execute ${integrationTest}`, async () => {
    const fails = integrationTest.endsWith('failure.js');
    const { fileList, reasons, warnings } = await nodeFileTrace([`${__dirname}/integration/${integrationTest}`], {
      base: path.resolve(__dirname, '..'),
      // ignore other integration tests
      ignore: ['test/integration/**']
    });
    // warnings.forEach(warning => console.warn(warning));
    rimraf.sync(tmpdir);
    fs.mkdirSync(tmpdir);
    await Promise.all(fileList.map(async file => {
      const outPath = path.resolve(tmpdir, file);
      await mkdirp(path.dirname(outPath));
      await writeFile(outPath, await readFile(path.resolve(__dirname, '..', file)));
    }));
    const ps = fork(`${tmpdir}/test/integration/${integrationTest}`, {
      stdio: fails ? 'pipe' : 'inherit'
    });
    const code = await new Promise(resolve => ps.on('close', resolve));
    expect(code).toBe(fails ? 1 : 0);
    rimraf.sync(tmpdir);
  });
}
