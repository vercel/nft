const { unlinkSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

if (process.version.startsWith('v12.')) {
  // Delete the integration tests that do not currently work with Node 12.x
  const pkgJson = readFileSync(join(__dirname, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgJson);
  unlinkSync(join(__dirname, 'yarn.lock'));
  unlinkSync(join(__dirname, 'test', 'integration', 'oracledb.js'));
  delete pkg.devDependencies['oracledb'];
  writeFileSync(join(__dirname, 'package.json'), JSON.stringify(pkg));
} else {
  console.log('[node-12-prepare] Expected current node version to be 12 but found ' + process.version);
}
