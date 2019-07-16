const { basename, dirname, isAbsolute, resolve, sep } = require('path');

function inPath (path, parent) {
  return path.startsWith(parent) && path[parent.length] === sep;
}

function realpath (path, parent, job, seen = new Set()) {
  if (seen.has(path)) throw new Error('Recursive symlink detected resolving ' + path);
  seen.add(path);
  const symlink = job.readlink(path);
  // emit direct symlink paths only
  if (symlink) {
    const parentPath = dirname(path);
    const resolved = resolve(parentPath, symlink);
    const realParent = realpath(parentPath, parent, job);
    if (inPath(path, realParent))
      job.emitFile(path, 'resolve', parent);
    return realpath(resolved, parent, job, seen);
  }
  // keep backtracking for realpath, emitting folder symlinks within base
  if (!inPath(path, job.base))
    return path;
  return realpath(dirname(path), parent, job, seen) + sep + basename(path);
}

// node resolver
// custom implementation to emit only needed package.json files for resolver
// (package.json files are emitted as they are hit)
module.exports = function resolveDependency (specifier, parent, job) {
  let resolved;
  if (isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../'))
    resolved = resolvePath(resolve(parent, '..', specifier), parent, job);
  else
    resolved = resolvePackage(specifier, parent, job);
  if (resolved.startsWith('node:')) return resolved;
  return realpath(resolved, parent, job);
};

function resolvePath (path, parent, job) {
  return resolveFile(path, job) || resolveDir(path, parent, job) || notFound(path, parent);
}

function resolveFile (path, job) {
  if (path.endsWith('/')) return;
  if (job.isFile(path)) return path;
  if (job.ts && path.startsWith(job.base) && path.substr(job.base.length).indexOf(sep + 'node_modules' + sep) === -1 && job.isFile(path + '.ts')) return path + '.ts';
  if (job.ts && path.startsWith(job.base) && path.substr(job.base.length).indexOf(sep + 'node_modules' + sep) === -1 && job.isFile(path + '.tsx')) return path + '.tsx';
  if (job.isFile(path + '.js')) return path + '.js';
  if (job.isFile(path + '.json')) return path + '.json';
  if (job.isFile(path + '.node')) return path + '.node';
}

function resolveDir (path, parent, job) {
  if (!job.isDir(path)) return;
  const realPjsonPath = realpath(path + '/package.json', parent, job);
  const pjsonSource = job.readFile(realPjsonPath);
  if (pjsonSource) {
    try {
      var pjson = JSON.parse(pjsonSource);
    }
    catch (e) {}
    if (pjson && typeof pjson.main === 'string') {
      const resolved = resolveFile(resolve(path, pjson.main), job) || resolveFile(resolve(path, pjson.main, 'index'), job);
      if (resolved) {
        job.emitFile(realPjsonPath, 'resolve', parent);
        return resolved;
      }
    }
  }
  return resolveFile(resolve(path, 'index'), job);
}

function notFound (specifier, parent) {
  const e = new Error("Cannot find module '" + specifier + "' loaded from " + parent);
  e.code = 'MODULE_NOT_FOUND';
  throw e;
}

const nodeBuiltins = new Set([...require("repl")._builtinLibs, "constants", "module", "timers", "console", "_stream_writable", "_stream_readable", "_stream_duplex"]);

function resolvePackage (name, parent, job) {
  let packageParent = parent;
  if (nodeBuiltins.has(name)) return 'node:' + name;
  let separatorIndex;
  const rootSeparatorIndex = packageParent.indexOf('/');
  while ((separatorIndex = packageParent.lastIndexOf('/')) > rootSeparatorIndex) {
    packageParent = packageParent.substr(0, separatorIndex);
    const nodeModulesDir = packageParent + '/node_modules';
    const stat = job.stat(nodeModulesDir);
    if (!stat || !stat.isDirectory()) continue;
    const resolved = resolveFile(nodeModulesDir + '/' + name, job) || resolveDir(nodeModulesDir + '/' + name, parent, job);
    if (resolved) return resolved;
  }
  notFound(name, parent);
}
