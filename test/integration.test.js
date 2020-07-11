const { promises, readdirSync, mkdirSync } = require('fs');
const path = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');
const os = require('os');
const { promisify } = require('util');
const rimraf = require('rimraf');
const mkdirp = promisify(require('mkdirp'));
const { readFile, writeFile, readlink, symlink } = promises;
const { fork } = require('child_process');

jest.setTimeout(200000);

const integrationDir = `${__dirname}${path.sep}integration`;

for (const integrationTest of readdirSync(integrationDir)) {
  it(`should correctly trace and correctly execute ${integrationTest}`, async () => {
    console.log('Tracing and executing ' + integrationTest);
    const fails = integrationTest.endsWith('failure.js');
    const { fileList, reasons, warnings } = await nodeFileTrace([`${integrationDir}/${integrationTest}`], {
      log: true,
      base: path.resolve(__dirname, '..'),
      processCwd: integrationDir,
      // ignore other integration tests
      ignore: ['test/integration/**']
    });
    // warnings.forEach(warning => console.warn(warning));
    const randomTmpId = Math.random().toString().slice(2)
    const tmpdir = path.resolve(os.tmpdir(), `node-file-trace-${randomTmpId}`);
    rimraf.sync(tmpdir);
    mkdirSync(tmpdir);
    await Promise.all(fileList.map(async file => {
      const inPath = path.resolve(__dirname, '..', file);
      const outPath = path.resolve(tmpdir, file);
      try {
        var symlinkPath = await readlink(inPath);
      }
      catch (e) {
        if (e.code !== 'EINVAL' && e.code !== 'UNKNOWN') throw e;
      }
      mkdirp.sync(path.dirname(outPath));
      if (symlinkPath) {
        await symlink(symlinkPath, outPath);
      }
      else {
        await writeFile(outPath, await readFile(inPath), { mode: 0o777 });
      }
    }));
    const testFile = path.join(tmpdir, 'test', 'integration', integrationTest);
    const ps = fork(testFile, {
      stdio: fails ? 'pipe' : 'inherit'
    });
    const code = await new Promise(resolve => ps.on('close', resolve));
    expect(code).toBe(fails ? 1 : 0);
    rimraf.sync(tmpdir);
  });
}
