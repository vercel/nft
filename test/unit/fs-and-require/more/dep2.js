const { join } = require('path');
const file2 = join(__dirname, '..', 'asset', 'file2.js');

module.exports = `dep2 has file ${file2}`;