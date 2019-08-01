const { unlinkSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

if (process.platform === 'win32') {
  // Delete the integration tests that will never work in Windows
  // because those packages were designed for Linux.
  const pkgJson = readFileSync(join(__dirname, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgJson);
  unlinkSync(join(__dirname, 'yarn.lock'));
  unlinkSync(join(__dirname, 'test', 'integration', 'tensorflow.js'));
  unlinkSync(join(__dirname, 'test', 'integration', 'highlights.js'));
  unlinkSync(join(__dirname, 'test', 'integration', 'hot-shots.js'));
  unlinkSync(join(__dirname, 'test', 'integration', 'yoga-layout.js'));
  delete pkg.devDependencies['@tensorflow/tfjs-node'];
  delete pkg.devDependencies['highlights'];
  delete pkg.devDependencies['hot-shots'];
  delete pkg.devDependencies['yoga-layout'];
  writeFileSync(join(__dirname, 'package.json'), JSON.stringify(pkg));
} else {
  console.log('[azure-prepare] Expected current platform to be win32 but found ' + process.platform);
}