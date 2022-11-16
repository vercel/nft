const fs = require('fs');
const { join, relative, sep } = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');

global._unit = true;

const skipOnWindows = ['yarn-workspaces', 'yarn-workspaces-base-root', 'yarn-workspace-esm', 'asset-symlink', 'require-symlink', 'cjs-querystring'];
const unitTestDirs = fs.readdirSync(join(__dirname, 'unit'));
const unitTests = [
  ...unitTestDirs.map(testName => ({testName, isRoot: true})),
  ...unitTestDirs.map(testName => ({testName, isRoot: false})),
];

for (const { testName, isRoot } of unitTests) {
  const testSuffix = `${testName} from ${isRoot ? 'root' : 'cwd'}`;
  const unitPath = join(__dirname, 'unit', testName);

  if (process.platform === 'win32') { 
    if (isRoot || skipOnWindows.includes(testName)) {
      console.log(`Skipping unit test on Windows: ${testSuffix}`);
      continue;
    }
  } else {
    if (testName === 'cjs-querystring') {
      // Create (a git-ignored copy of) the file we need, since committing it
      // breaks CI on Windows. See https://github.com/vercel/nft/pull/322.
      const currentFilepath = join(unitPath, 'noPunctuation', 'whowhatidk.js');
      const newFilepath = currentFilepath.replace(
        'noPunctuation' + sep + 'whowhatidk.js',
        'who?what?idk!.js'
      );
      if (!fs.existsSync(newFilepath)) {
        fs.copyFileSync(currentFilepath, newFilepath);
      }
    }
  }
  
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

      // mock an in-memory module store (such as webpack's) where the same filename with
      // two different querystrings can correspond to two different modules, one importing
      // the other
      if (testName === 'querystring-self-import') {
        if (id.endsWith('input.js') || id.endsWith('base.js') || id.endsWith('dep.js')) {
          return fs.readFileSync(id).toString()
        }

        if (id.endsWith('base.js?__withQuery')) {
          return `
            import * as origBase from './base';
            export const dogs = origBase.dogs.concat('Cory', 'Bodhi');
            export const cats = origBase.cats.concat('Teaberry', 'Sassafras', 'Persephone');
            export const rats = origBase.rats;
          `;
        }
      }

      return this.constructor.prototype.readFile.apply(this, arguments);
    });

    const nftCache = {}
    
    const doTrace = async (cached = false) => {
      let inputFileNames = ["input.js"];
      let outputFileName = "output.js";
      
      if (testName === "jsx-input") {
        inputFileNames = ["input.jsx"];
      }
      if (testName === "tsx-input") {
        inputFileNames = ["input.tsx"];
      }
      if (testName === "ts-input-esm") {
        inputFileNames = ["input.ts"];
      }
      if (testName === "processed-dependency" && cached) {
        inputFileNames = ["input-cached.js"]
        outputFileName = "output-cached.js"
      }
      
      if (testName === 'multi-input') {
        inputFileNames.push('input-2.js', 'input-3.js', 'input-4.js');
      }

      const { fileList, reasons, warnings } = await nodeFileTrace(
        inputFileNames.map(file => join(unitPath, file)), 
        {
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
        }
      );

      const normalizeFilesRoot = f => 
        (isRoot ? relative(join('./', __dirname, '..'), f) : f).replace(/\\/g, '/');
      
      const normalizeInputRoot = f =>
        isRoot ? join('./', unitPath, f) : join('test/unit', testName, f);
      
      const getReasonType = f => reasons.get(normalizeInputRoot(f)).type;
      
      if (testName === 'multi-input') {
        const collectFiles = (parent, files = new Set()) => {
          fileList.forEach(file => {
            if (files.has(file)) return
            const reason = reasons.get(file)
        
            if (reason.parents && reason.parents.has(parent)) {
              files.add(file)
              collectFiles(file, files)
            }
          })
          return files
        }
        
        expect([...collectFiles(normalizeInputRoot('input.js'))].map(normalizeFilesRoot).sort()).toEqual([
          "package.json",
          "test/unit/multi-input/asset-2.txt",
          "test/unit/multi-input/asset.txt",
          "test/unit/multi-input/child-1.js",
          "test/unit/multi-input/child-2.js",
          "test/unit/multi-input/input-2.js",
        ])
        expect([...collectFiles(normalizeInputRoot('input-2.js'))].map(normalizeFilesRoot).sort()).toEqual([
          "package.json",
          "test/unit/multi-input/asset-2.txt",
          "test/unit/multi-input/asset.txt",
          "test/unit/multi-input/child-1.js",
          "test/unit/multi-input/child-2.js",
          "test/unit/multi-input/input-2.js",
        ])
        expect([...collectFiles(normalizeInputRoot('input-3.js'))].map(normalizeFilesRoot).sort()).toEqual([
          "package.json",
          "test/unit/multi-input/asset.txt",
          "test/unit/multi-input/child-3.js",
        ])

        expect([...collectFiles(normalizeInputRoot('input-4.js'))].map(normalizeFilesRoot).sort()).toEqual([
          "package.json",
          "test/unit/multi-input/child-4.js",
          "test/unit/multi-input/style.module.css",
        ])

        expect(getReasonType('input.js')).toEqual(['initial', 'dependency'])
        expect(getReasonType('input-2.js')).toEqual(['initial', 'dependency'])
        expect(getReasonType('input-3.js')).toEqual(['initial', 'dependency'])
        expect(getReasonType('input-4.js')).toEqual(['initial', 'dependency'])
        expect(getReasonType('child-1.js')).toEqual(['dependency'])
        expect(getReasonType('child-2.js')).toEqual(['dependency'])
        expect(getReasonType('child-3.js')).toEqual(['dependency'])
        expect(getReasonType('child-4.js')).toEqual(['dependency'])
        expect(getReasonType('asset.txt')).toEqual(['asset'])
        expect(getReasonType('asset-2.txt')).toEqual(['asset'])
        expect(getReasonType('style.module.css')).toEqual(['dependency', 'asset'])
      }
      let sortedFileList = [...fileList].sort()
      
      if (testName === 'microtime-node-gyp') {
        let foundMatchingBinary = false
        sortedFileList = sortedFileList.filter(file => {
          if (file.endsWith('node-napi.node')) {
            // remove from fileList for expected checking
            // as it will differ per platform
            foundMatchingBinary = true
            fileList.delete(file)
            return false
          }
          return true
        })
        expect(foundMatchingBinary).toBe(true) 
      }
      
      let expected;
      try {
        expected = JSON.parse(fs.readFileSync(join(unitPath, outputFileName)).toString());
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
        expect(sortedFileList).toEqual(expected);
      }
      catch (e) {
        console.warn({reasons, warnings});
        fs.writeFileSync(join(unitPath, 'actual.js'), JSON.stringify(sortedFileList, null, 2));
        throw e;
      }
    }
    await doTrace()
    // test tracing again with a populated nftTrace
    expect(nftCache.fileCache).toBeDefined()
    expect(nftCache.statCache).toBeDefined()
    expect(nftCache.symlinkCache).toBeDefined()
    expect(nftCache.analysisCache).toBeDefined()
    
    try {
      await doTrace(true)
    } catch (err) {
      console.error(`Failed for cached run`)
      throw err
    }

    if (testName === "tsx-input") {
      expect(readFileMock.mock.calls.length).toBe(2);
    }
  });
}
