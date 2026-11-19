import { createRequire as createRequireFn } from 'node:module';

const req = createRequireFn(import.meta.url);
const dep = req('./dep.js');
