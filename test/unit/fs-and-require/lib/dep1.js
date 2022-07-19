const { join } = require('path');
const file1 = join(__dirname, '..', 'asset', 'file1.txt');
const dep2 = require('../more/dep2.js');

module.exports = `dep1 has asset ${file1} and dep ${dep2}`
