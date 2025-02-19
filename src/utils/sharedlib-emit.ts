import os from 'os';
import { escape, glob } from 'glob';
import { getPackageBase } from './get-package-base';
import { Job } from '../node-file-trace';

let sharedlibGlob = '';
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
export async function sharedLibEmit(path: string, job: Job) {
  // console.log('Emitting shared libs for ' + path);
  const pkgPath = getPackageBase(path);
  if (!pkgPath) return;

  const files = await glob(escape(pkgPath) + sharedlibGlob, {
    ignore: escape(pkgPath) + '/**/node_modules/**/*',
    dot: true,
  });
  await Promise.all(files.map((file) => job.emitFile(file, 'sharedlib', path)));
}
