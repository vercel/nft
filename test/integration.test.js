const fs = require('fs');
const path = require('path');
const nodeFileTrace = require('../src/node-file-trace');
const os = require('os');
const { promisify } = require('util');
const rimraf = require('rimraf');
const mkdirp = promisify(require('mkdirp'));
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const readlink = promisify(fs.readlink);
const symlink = promisify(fs.symlink);
const { fork } = require('child_process');

jest.setTimeout(200000);

for (const integrationTest of fs.readdirSync(`${__dirname}/integration`)) {
  it(`should correctly trace and correctly execute ${integrationTest}`, async () => {
    const fails = integrationTest.endsWith('failure.js');
    const { fileList, reasons, warnings } = await nodeFileTrace([`${__dirname}/integration/${integrationTest}`], {
      base: path.resolve(__dirname, '..'),
      // ignore other integration tests
      ignore: ['test/integration/**']
    });
    // warnings.forEach(warning => console.warn(warning));
    const randomTmpId = Math.random().toString().slice(2)
    const tmpdir = path.resolve(os.tmpdir(), `node-file-trace-${randomTmpId}`);
    rimraf.sync(tmpdir);
    fs.mkdirSync(tmpdir);
    await Promise.all(fileList.map(async file => {
      const inPath = path.resolve(__dirname, '..', file);
      const outPath = path.resolve(tmpdir, file);
      try {
        var symlinkPath = await readlink(inPath);
      }
      catch (e) {
        if (e.code !== 'EINVAL') throw e;
      }
      mkdirp.sync(path.dirname(outPath));
      if (symlinkPath) {
        await symlink(symlinkPath, outPath);
      }
      else {
        await writeFile(outPath, await readFile(inPath), { mode: 0o777 });
      }
    }));
    const ps = fork(`${tmpdir}/test/integration/${integrationTest}`, {
      stdio: fails ? 'pipe' : 'inherit'
    });
    const code = await new Promise(resolve => ps.on('close', resolve));
    expect(code).toBe(fails ? 1 : 0);
    rimraf.sync(tmpdir);
  });
}
