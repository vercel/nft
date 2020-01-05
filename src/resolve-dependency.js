const { isAbsolute, resolve, sep } = require('path');

// node resolver
// custom implementation to emit only needed package.json files for resolver
// (package.json files are emitted as they are hit)
module.exports = function resolveDependency (specifier, parent, job) {
  let resolved;
  if (isAbsolute(specifier) || specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../'))
    resolved = resolvePath(resolve(parent, '..', specifier), parent, job);
  else
    resolved = resolvePackage(specifier, parent, job);
  if (resolved.startsWith('node:')) return resolved;
  return job.realpath(resolved, parent);
};

function resolvePath (path, parent, job) {
  return resolveFile(path, parent, job) || resolveDir(path, parent, job) || notFound(path, parent);
}

function resolveFile (path, parent, job) {
  path = job.realpath(path, parent);
  if (path.endsWith(sep)) return;
  if (job.isFile(path)) return path;
  if (job.ts && path.startsWith(job.base) && path.substr(job.base.length).indexOf(sep + 'node_modules' + sep) === -1 && job.isFile(path + '.ts')) return path + '.ts';
  if (job.ts && path.startsWith(job.base) && path.substr(job.base.length).indexOf(sep + 'node_modules' + sep) === -1 && job.isFile(path + '.tsx')) return path + '.tsx';
  if (job.isFile(path + '.js')) return path + '.js';
  if (job.isFile(path + '.json')) return path + '.json';
  if (job.isFile(path + '.node')) return path + '.node';
}

function resolveDir (path, parent, job) {
  if (!job.isDir(path)) return;
  const realPjsonPath = job.realpath(path + sep + 'package.json', parent);
  const pjsonSource = job.readFile(realPjsonPath);
  if (pjsonSource) {
    try {
      var pjson = JSON.parse(pjsonSource);
    }
    catch (e) {}
    if (pjson && typeof pjson.main === 'string') {
      const resolved = resolveFile(resolve(path, pjson.main), parent, job) || resolveFile(resolve(path, pjson.main, 'index'), parent, job);
      if (resolved) {
        job.emitFile(realPjsonPath, 'resolve', parent);
        return resolved;
      }
    }
  }
  return resolveFile(resolve(path, 'index'), parent, job);
}

function notFound (specifier, parent) {
  const e = new Error("Cannot find module '" + specifier + "' loaded from " + parent);
  e.code = 'MODULE_NOT_FOUND';
  throw e;
}

const nodeBuiltins = new Set([...require("repl")._builtinLibs, "constants", "module", "timers", "console", "_stream_writable", "_stream_readable", "_stream_duplex", "process", "sys"]);

function resolvePackage (name, parent, job) {
  let packageParent = parent;
  if (nodeBuiltins.has(name)) return 'node:' + name;
  let separatorIndex;
  const rootSeparatorIndex = packageParent.indexOf(sep);
  while ((separatorIndex = packageParent.lastIndexOf(sep)) > rootSeparatorIndex) {
    packageParent = packageParent.substr(0, separatorIndex);
    const nodeModulesDir = packageParent + sep + 'node_modules';
    const stat = job.stat(nodeModulesDir);
    if (!stat || !stat.isDirectory()) continue;
    const resolved = resolveFile(nodeModulesDir + sep + name, parent, job) || resolveDir(nodeModulesDir + sep + name, parent, job);
    if (resolved) return resolved;
  }
  if (Object.hasOwnProperty.call(job.paths, name)) {
    return job.paths[name];
  }
  for (const path of Object.keys(job.paths)) {
    if (path.endsWith('/') && name.startsWith(path)) {
      const pathTarget = job.paths[path] + name.slice(path.length);
      return resolveFile(pathTarget, parent, job) || resolveDir(pathTarget, parent, job);
    }
  }
  notFound(name, parent);
}
