import os from 'os';
import path from 'path';
import { glob } from 'glob';
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

// Emit every shared library bundled inside a package directory.
async function emitSharedLibs(pkgPath: string, parent: string, job: Job) {
  const base = pkgPath.replaceAll(path.sep, path.posix.sep);
  const files = await glob(base + sharedlibGlob, {
    ignore: base + '/**/node_modules/**/*',
    dot: true,
  });
  await Promise.all(
    files.map((file) => job.emitFile(file, 'sharedlib', parent)),
  );
}

// helper for emitting the associated shared libraries when a binary is emitted
export async function sharedLibEmit(p: string, job: Job) {
  const pkgPath = getPackageBase(p);
  if (!pkgPath) return;

  // Emit the shared libraries bundled alongside the binary itself.
  await emitSharedLibs(pkgPath, p, job);

  // Native addons frequently load a platform-specific shared library from a
  // sibling package they declare as an optional dependency and dlopen at
  // runtime — e.g. sharp's prebuilt `@img/sharp-<platform>` binary loads
  // libvips from `@img/sharp-libvips-<platform>`. That dlopen can't be traced
  // statically, so follow the package manifest and emit the shared libraries
  // from each dependency package too. This stays correct as sharp (and similar
  // packages) change versions, since it reads the declared dependencies rather
  // than hardcoding package names.
  const pkgJson = await job.readFile(pkgPath + path.sep + 'package.json');
  if (pkgJson === null) return;

  let deps: string[];
  try {
    const { optionalDependencies } = JSON.parse(pkgJson.toString());
    deps = Object.keys(optionalDependencies ?? {});
  } catch {
    return;
  }
  if (deps.length === 0) return;

  const nodeModules = pkgPath.slice(
    0,
    pkgPath.lastIndexOf('node_modules') + 'node_modules'.length,
  );
  await Promise.all(
    deps.map(async (dep) => {
      const depPath = path.join(nodeModules, dep);
      if (await job.isDir(depPath)) {
        await emitSharedLibs(await job.realpath(depPath), p, job);
      }
    }),
  );
}
