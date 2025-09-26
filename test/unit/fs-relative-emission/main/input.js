
const fs = require('fs');

fs.readFileSync('../asset1.txt')

fs.readFileSync('../blog/asset2.txt')

const asset3 = 'asset3.txt';
fs.readFileSync('../blog/author' + '/' + asset3, 'utf8');

fs.readFileSync('../blog/author/../asset4.txt')
