const { join } = require('path');
const file2 = join(__dirname, '..', 'asset', 'file2.txt');

module.exports = `dep2 has file ${file2}`;