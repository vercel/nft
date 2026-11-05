import * as Module from 'node:module';

// Namespace import under a local name other than `module`
const require = Module.createRequire(import.meta.url);
const dep = require('./dep.js');
