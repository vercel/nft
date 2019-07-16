const os = require('os');
const glob = require('glob');
const getPackageBase = require('./get-package-base');

let sharedlibGlob;
switch (os.platform()) {
  case 'darwin':
    sharedlibGlob = '/**/*.@(dylib|so?(.*))';
  break;
  case 'win32':
    sharedlibGlob = '/**/*.dll';
  break;
  default:
    sharedlibGlob = '/**/*.so?(.*)';
}

// helper for emitting the associated shared libraries when a binary is emitted
module.exports = async function (path, job) {
  // console.log('Emitting shared libs for ' + path);
  const pkgPath = getPackageBase(path);
  if (!pkgPath)
    return;

  const files = await new Promise((resolve, reject) =>
    glob(pkgPath + sharedlibGlob, { ignore: pkgPath + '/**/node_modules/**/*' }, (err, files) => err ? reject(err) : resolve(files))
  );
  files.forEach(file => job.emitFile(job.realpath(file, path), 'sharedlib', path));
};
