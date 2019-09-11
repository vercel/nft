const fs = require('fs');
const path = require('path');
const nodeFileTrace = require('../src/node-file-trace');
const os = require('os');
const { promisify } = require('util');
const rimraf = require('rimraf');
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const { tests } = require('./ecmascript/data-es5');

async function main() {
  const randomTmpId = Math.random().toString().slice(2);
  const tmpdir = path.resolve(os.tmpdir(), `node-file-trace-ecmascript${randomTmpId}`);
  rimraf.sync(tmpdir);
  fs.mkdirSync(tmpdir);
  console.log('created directory ' + tmpdir);

  for (const t in tests) {
    for (const st in tests[t].subtests) {
      const { name, exec } = tests[t].subtests[st];
      it(`should correctly trace ecmascript "${name}"`, async () => {
        
        let str = exec.toString().replace('/*', '').replace('*/', '');
        str = `var obj = { exec: ${str} }`;
        const filename = path.join(tmpdir, `test${Math.random().toString().slice(2)}.js`);
        //console.log(`Test ${name} with file ${filename}`);
        //console.log(str);
        await writeFile(filename, str, 'utf8');
        const { fileList, warnings } = await nodeFileTrace([filename], {
          base: `${__dirname}/../`,
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

main();
