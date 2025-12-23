import * as module from 'node:module';

// Variable named 'require' - might conflict
const require = module.createRequire(import.meta.url);
const lib = require('./lib.node');

