const { isAbsolute, resolve } = require('path');
const fs = require('fs');

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
  return fs.realpathSync(resolved);
};

function resolvePath (path, parent, job) {
  return resolveFile(path, job) || resolveDir(path, parent, job) || notFound(path, parent);
}

function resolveFile (path, job) {
  if (path.endsWith('/')) return;
  if (job.readFile(path) !== null) return path;
  if (job.readFile(path + '.js') !== null) return path + '.js';
  if (job.readFile(path + '.json') !== null) return path + '.json';
  if (job.readFile(path + '.node') !== null) return path + '.node';
}

function resolveDir (path, parent, job) {
  if (!job.isDir(path)) return;
  const pjsonSource = job.readFile(path + '/package.json');
  if (pjsonSource) {
    try {
      var pjson = JSON.parse(pjsonSource);
    }
    catch (e) {}
    if (pjson && typeof pjson.main === 'string') {
      const resolved = resolveFile(resolve(path, pjson.main), job) || resolveFile(resolve(path, pjson.main, 'index'), job);
      if (resolved) {
        job.emitFile(path + '/package.json', 'resolve', parent);
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
    if (!job.isDir(nodeModulesDir)) continue;
    const resolved = resolveFile(nodeModulesDir + '/' + name, job) || resolveDir(nodeModulesDir + '/' + name, parent, job);
    if (resolved) return resolved;
  }
  notFound(name, parent);
}
