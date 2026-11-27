const fs = require('fs');
const path = require('path');

module.exports = (locale) =>
  JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), `${locale}.locale.json`),
      'utf8',
    ),
  );
