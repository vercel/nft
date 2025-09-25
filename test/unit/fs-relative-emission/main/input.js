
const fs = require('fs');

fs.readFile('../asset1.txt')

fs.readFile('../blog/asset2.txt')

const asset3 = 'asset3.txt';
fs.readFileSync('../blog/author' + '/' + asset3, 'utf8');

fs.readFile('../blog/author/../asset4.txt')
