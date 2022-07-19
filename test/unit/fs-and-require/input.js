const { readdirSync } = require('fs');
const { join } = require('path');

readdirSync(join(__dirname, 'lib'))
  .filter(f => f.endsWith('.js'))
  .forEach(f => {
    const mod = require('./lib/' + f);
    console.log(`mod: ${mod}`);
  });