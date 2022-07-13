const fs = require('graceful-fs');
console.log(fs.readFileSync(__dirname + '/asset.txt'));
