const fs = require('fs');
const { join, isAbsolute, resolve } = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');

global._unit = true;

const skipOnWindows = ['yarn-workspaces', 'yarn-workspaces-base-root', 'yarn-workspace-esm', 'asset-symlink', 'require-symlink'];
const unitTestDirs = fs.readdirSync(join(__dirname, 'unit'));
const unitTests = [
  ...unitTestDirs.map(testName => ({testName, isRoot: false})),
  ...unitTestDirs.map(testName => ({testName, isRoot: true})),
];

for (const { testName, isRoot } of unitTests) {
  const testSuffix = `${testName} from ${isRoot ? 'root' : 'cwd'}`;
  if (process.platform === 'win32' && (isRoot || skipOnWindows.includes(testName))) {
    console.log(`Skipping unit test on Windows: ${testSuffix}`);
    continue;
  };
  const unitPath = join(__dirname, 'unit', testName);
  
  it(`should correctly trace ${testSuffix}`, async () => {

    // We mock readFile because when node-file-trace is integrated into @now/node
    // this is the hook that triggers TypeScript compilation. So if this doesn't
    // get called, the TypeScript files won't get compiled: Currently this is only
    // used in the tsx-input test:
    const readFileMock = jest.fn(function() {
      const [id] = arguments;
      
      if (id.startsWith('custom-resolution-')) {
        return ''
      }
      
      // ensure sync readFile works as expected since default is 
      // async now
      if (testName === 'wildcard') {
        try {
          return fs.readFileSync(id).toString()
        } catch (err) {
          return null
        }
      }
      return this.constructor.prototype.readFile.apply(this, arguments);
    });

    let inputFileName = "input.js";

    if (testName === "tsx-input") {
      inputFileName = "input.tsx";
    }
    const nftCache = {}
    
    const doTrace = async () => {
      const { fileList, reasons } = await nodeFileTrace([join(unitPath, inputFileName)], {
        base: isRoot ? '/' : `${__dirname}/../`,
        processCwd: unitPath,
        paths: {
          dep: `${__dirname}/../test/unit/esm-paths/esm-dep.js`,
          'dep/': `${__dirname}/../test/unit/esm-paths-trailer/`
        },
        cache: nftCache,
        exportsOnly: testName.startsWith('exports-only'),
        ts: true,
        log: true,
        // disable analysis for basic-analysis unit tests
        analysis: !testName.startsWith('basic-analysis'),
        mixedModules: true,
        // Ignore unit test output "actual.js", and ignore GitHub Actions preinstalled packages
        ignore: (str) => str.endsWith('/actual.js') || str.startsWith('usr/local'),
        readFile: readFileMock,
        resolve: testName.startsWith('resolve-hook')
          ? (id, parent) => `custom-resolution-${id}`
          : undefined,
      });
      let expected;
      try {
        expected = JSON.parse(fs.readFileSync(join(unitPath, 'output.js')).toString());
        if (process.platform === 'win32') {
          // When using Windows, the expected output should use backslash
          expected = expected.map(str => str.replace(/\//g, '\\'));
        }
        if (isRoot) {
          // We set `base: "/"` but we can't hardcode an absolute path because
          // CI will look different than a local machine so we fix the path here.
          expected = expected.map(str => join(__dirname, '..', str).slice(1));
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
    }
    await doTrace()
    // test tracing again with a populated nftTrace
    expect(nftCache.fileCache).toBeDefined()
    expect(nftCache.statCache).toBeDefined()
    expect(nftCache.symlinkCache).toBeDefined()
    expect(nftCache.analysisCache).toBeDefined()
    expect(nftCache.globCache).toBeDefined()
    expect(nftCache.resolveCache).toBeDefined()
    await doTrace()

    if (testName === "tsx-input") {
      expect(readFileMock.mock.calls.length).toBe(2);
    }
  });
}
