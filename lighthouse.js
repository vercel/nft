const nodeFileTrace = require('./src/node-file-trace');
const entrypoint = '/Users/styfle/Code/zeit/integrations/lighthouse/lighthouse/index.js';
const workPath = '/Users/styfle/Code/zeit/integrations/lighthouse';
nodeFileTrace([entrypoint], { base: workPath })
  .then(({ fileList, warnings }) => console.log(fileList.filter(f => f.includes('lighthouse'))))
  .catch(console.error);
