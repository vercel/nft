const { promises, readdirSync, mkdirSync } = require('fs');
const path = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');
const os = require('os');
const rimraf = require('rimraf');
const { readFile, writeFile, readlink, symlink, copyFile } = promises;
const { fork, exec: execOrig } = require('child_process');

const exec = require('util').promisify(execOrig);

jest.setTimeout(200_000);

const integrationDir = `${__dirname}${path.sep}integration`;

for (const integrationTest of readdirSync(integrationDir)) {
  let currentIntegrationDir = integrationDir;

  it(`should correctly trace and correctly execute ${integrationTest}`, async () => {
    console.log('Tracing and executing ' + integrationTest);
    const nftCache = {};
    const rand = Math.random().toString().slice(2);
    const fails = integrationTest.endsWith('failure.js');

    let traceBase = path.resolve(__dirname, '..')

    if (integrationTest === 'sharp-pnpm.js') {
      currentIntegrationDir = path.resolve(os.tmpdir(), `node-file-trace-${integrationTest}-${rand}`);
      rimraf.sync(currentIntegrationDir);
      mkdirSync(currentIntegrationDir);
      await copyFile(
        path.join(integrationDir, integrationTest),
        path.join(currentIntegrationDir, integrationTest)
      );
      await writeFile(
        path.join(currentIntegrationDir, 'package.json'),
        JSON.stringify({ dependencies: { sharp: '0.33.2' } })
      );
      traceBase = currentIntegrationDir
      await exec(`npx pnpm@8.14.3 install`, { cwd: currentIntegrationDir, stdio: 'inherit' });
    }
    
    const { fileList, reasons, warnings } = await nodeFileTrace(
      [`${currentIntegrationDir}/${integrationTest}`],
      {
        log: true,
        cache: nftCache,
        base: traceBase,
        processCwd: currentIntegrationDir,
        // ignore other integration tests
        ignore: ['test/integration/**'],
      }
    );
    // warnings.forEach(warning => console.warn(warning));
    const tmpdir = path.resolve(os.tmpdir(), `node-file-trace-${rand}`);
    rimraf.sync(tmpdir);
    mkdirSync(tmpdir);
    
    await Promise.all(
      [...fileList].map(async (file) => {
        const inPath = path.resolve(traceBase, file);
        const outPath = path.resolve(tmpdir, file);
        try {
          var symlinkPath = await readlink(inPath);
        } catch (e) {
          if (e.code !== 'EINVAL' && e.code !== 'UNKNOWN') throw e;
        }
        mkdirSync(path.dirname(outPath), { recursive: true });
        if (symlinkPath) {
          await symlink(symlinkPath, outPath);
        } else {
          await writeFile(outPath, await readFile(inPath), { mode: 0o777 });
        }
      })
    );
    const testFile = path.join(tmpdir, path.relative(traceBase, currentIntegrationDir), integrationTest);
    
    const ps = fork(testFile, {
      stdio: fails ? 'pipe' : 'inherit',
    });
    const code = await new Promise((resolve) => ps.on('close', resolve));
    expect(code).toBe(fails ? 1 : 0);
    rimraf.sync(tmpdir);

    // TODO: ensure analysis cache is safe for below case
    // seems this fails with cache since < 0.14.0
    if (integrationTest !== 'browserify-middleware.js') {
      const cachedResult = await nodeFileTrace(
        [`${currentIntegrationDir}/${integrationTest}`],
        {
          log: true,
          cache: nftCache,
          base: traceBase,
          processCwd: currentIntegrationDir,
          // ignore other integration tests
          ignore: ['test/integration/**'],
        }
      );
      expect([...cachedResult.fileList].sort()).toEqual([...fileList].sort());
    }
  });
}
