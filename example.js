const nodeFileTrace = require('./src/node-file-trace');
const entrypoint = '/Users/styfle/Code/foo/now-sharp-example/index.js';
const workPath = '/Users/styfle/Code/foo/now-sharp-example';
nodeFileTrace([entrypoint], { base: workPath })
  .then(({ fileList, warnings }) => console.log(fileList))
  .catch(console.error);
