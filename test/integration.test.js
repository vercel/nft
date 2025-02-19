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

const integrationTests = readdirSync(integrationDir);
const filteredTestsToRun = integrationTests.filter((testName) => {
  const isWin = process.platform === 'win32';
  // Filter the integration tests that will never work in Windows
  if (
    isWin &&
    [
      'argon2.js',
      'highlights.js',
      'hot-shots.js',
      'loopback.js',
      'playwright-core.js',
    ].includes(testName)
  ) {
    return false;
  }
  return true;
});

for (const integrationTest of filteredTestsToRun) {
  let currentIntegrationDir = integrationDir;

  it(`should correctly trace and correctly execute ${integrationTest}`, async () => {
    console.log('Tracing and executing ' + integrationTest);
    const nftCache = {};
    const rand = Math.random().toString().slice(2);
    const fails = integrationTest.endsWith('failure.js');
    let traceBase = path.resolve(__dirname, '..');

    if (integrationTest === 'polyfill-library.js') {
      console.log('Skipping polyfill-library.js');
      return;
    }

    if (integrationTest === 'sharp-pnpm.js') {
      if (process.version.startsWith('v18.') && process.platform === 'win32') {
        console.log(
          'Skipping sharp-pnpm.js on Node 18 and Windows because of a bug: ' +
            'https://github.com/nodejs/node/issues/18518',
        );
        return;
      }
      const tmpdir = path.resolve(
        os.tmpdir(),
        `node-file-trace-${integrationTest}-${rand}`,
      );
      rimraf.sync(tmpdir);
      mkdirSync(tmpdir);
      await copyFile(
        path.join(integrationDir, integrationTest),
        path.join(tmpdir, integrationTest),
      );
      await writeFile(
        path.join(tmpdir, 'package.json'),
        JSON.stringify({
          packageManager: 'pnpm@8.14.3',
          dependencies: { sharp: '0.33.2' },
        }),
      );
      await exec(`corepack enable && pnpm i`, {
        cwd: tmpdir,
        stdio: 'inherit',
      });
      currentIntegrationDir = tmpdir;
      traceBase = tmpdir;
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
      },
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
      }),
    );
    const testFile = path.join(
      tmpdir,
      path.relative(traceBase, currentIntegrationDir),
      integrationTest,
    );

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
        },
      );
      expect([...cachedResult.fileList].sort()).toEqual([...fileList].sort());
    }
  });
}
