import os from 'os';
import path from 'path';
import { glob } from 'tinyglobby';
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
export async function sharedLibEmit(p: string, job: Job) {
  // console.log('Emitting shared libs for ' + path);
  const pkgPath = getPackageBase(p);
  if (!pkgPath) return;

  const files = await glob(
    pkgPath.replaceAll(path.sep, path.posix.sep) + sharedlibGlob,
    {
      ignore:
        pkgPath.replaceAll(path.sep, path.posix.sep) + '/**/node_modules/**/*',
      dot: true,
    },
  );
  await Promise.all(files.map((file) => job.emitFile(file, 'sharedlib', p)));
}
