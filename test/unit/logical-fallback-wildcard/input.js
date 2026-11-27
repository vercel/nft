const path = require('path');
const fs = require('fs');
const lang = process.argv[2];
fs.readFileSync(__dirname + '/locales/' + (lang || 'en') + '.json');
fs.readFileSync(`${__dirname}/locales/${lang ?? 'en'}.json`);
fs.readFileSync(path.join(__dirname, 'locales', (lang || 'en') + '.json'));
require('./locales/' + (lang || 'en') + '.json');
