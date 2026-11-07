import { createRequire } from 'module';
import { format as importFormat } from 'dual/imported';

const require = createRequire(import.meta.url);
const { format: requireFormat } = require('dual/required');

console.log(importFormat, requireFormat);
