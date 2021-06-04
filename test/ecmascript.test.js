const { promises, mkdirSync } = require('fs');
const path = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');
const os = require('os');
const rimraf = require('rimraf');
const { writeFile } = promises;

const randomTmpId = Math.random().toString().slice(2);
const tmpdir = path.resolve(os.tmpdir(), `node-file-trace-ecmascript${randomTmpId}`);
rimraf.sync(tmpdir);
mkdirSync(tmpdir);
console.log('created directory ' + tmpdir);

 // These are tests known to fail so we skip them
const ignoreCategories = new Set([
  'bind (::) operator',
  'additional meta properties',
  'syntactic tail calls',
  'object shorthand improvements',
  'throw expressions',
  'partial application syntax',
  'Object.freeze and Object.seal syntax',
  'Class and Property Decorators',
  'the pipeline operator',
  'Generator function.sent Meta Property',
  'Logical Assignment',
  'private class methods',
  'Class static initialization blocks',
  'Ergonomic brand checks for private fields',
]);

async function runTests(importPath) {
  const { tests } = require(importPath);
  for (const category of tests) {
    const subtests = category.subtests || [category]
    for (const test of subtests) {
      const { name, exec } = test;
      if (ignoreCategories.has(category.name)) {
        continue;
      }
      it(`should correctly trace ${importPath} "${category.name}" "${name}"`, async () => {
        let str = exec.toString().replace('{/*', '{').replace('*/}', '}');
        str = `var obj = { exec: ${str} }`;
        const filename = path.join(tmpdir, `test${Math.random().toString().slice(2)}.js`);
        await writeFile(filename, str, 'utf8');
        const { fileList, warnings } = await nodeFileTrace([filename], {
          base: `${__dirname}/../`,
          processCwd: path.dirname(filename),
          ts: true,
          log: true,
          mixedModules: true
        });
        if (warnings.length > 0) {
          console.log(warnings);
        }
        expect(warnings.length).toBe(0);
        expect(fileList.length).toBe(1);
      });
    }
  }
}

runTests('./ecmascript/data-es5');
runTests('./ecmascript/data-es6');
runTests('./ecmascript/data-es2016plus');
runTests('./ecmascript/data-esnext');
runTests('./ecmascript/data-esintl');
