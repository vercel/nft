const { isAbsolute, resolve, sep } = require('path');

// node resolver
// custom implementation to emit only needed package.json files for resolver
// (package.json files are emitted as they are hit)
module.exports = function resolveDependency (specifier, parent, job, cjsResolve = true) {
  let resolved;
  if (isAbsolute(specifier) || specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) {
    const trailingSlash = specifier.endsWith('/');
    resolved = resolvePath(resolve(parent, '..', specifier) + (trailingSlash ? '/' : ''), parent, job);
  }
  else {
    resolved = resolvePackage(specifier, parent, job, cjsResolve);
  }
  if (typeof resolved === 'string' && resolved.startsWith('node:')) return resolved;
  if (Array.isArray(resolved))
    return resolved.map(resolved => job.realpath(resolved, parent));
  return job.realpath(resolved, parent);
};

function resolvePath (path, parent, job) {
  return resolveFile(path, parent, job) || resolveDir(path, parent, job) || notFound(path, parent);
}

function resolveFile (path, parent, job) {
  if (path.endsWith('/')) return;
  path = job.realpath(path, parent);
  if (job.isFile(path)) return path;
  if (job.ts && path.startsWith(job.base) && path.substr(job.base.length).indexOf(sep + 'node_modules' + sep) === -1 && job.isFile(path + '.ts')) return path + '.ts';
  if (job.ts && path.startsWith(job.base) && path.substr(job.base.length).indexOf(sep + 'node_modules' + sep) === -1 && job.isFile(path + '.tsx')) return path + '.tsx';
  if (job.isFile(path + '.js')) return path + '.js';
  if (job.isFile(path + '.json')) return path + '.json';
  if (job.isFile(path + '.node')) return path + '.node';
}

function resolveDir (path, parent, job) {
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (!job.isDir(path)) return;
  const pkgCfg = getPkgCfg(path, job);
  if (pkgCfg && typeof pkgCfg.main === 'string') {
    const resolved = resolveFile(resolve(path, pkgCfg.main), parent, job) || resolveFile(resolve(path, pkgCfg.main, 'index'), parent, job);
    if (resolved) {
      job.emitFile(path + sep + 'package.json', 'resolve', parent);
      return resolved;
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

function getPkgName (name) {
  const segments = name.split('/');
  if (name[0] === '@' && segments.length > 1)
    return segments.length > 1 ? segments.slice(0, 2).join('/') : null;
  return segments.length ? segments[0] : null;
}

function getPkgCfg (pkgPath, job) {
  const pjsonSource = job.readFile(pkgPath + sep + 'package.json');
  if (pjsonSource) {
    try {
      return JSON.parse(pjsonSource);
    }
    catch (e) {}
  }
}

function getExportsTarget (exports, conditions, cjsResolve) {
  if (typeof exports === 'string') {
    return exports;
  }
  else if (Array.isArray(exports)) {
    for (const item of exports) {
      const target = getExportsTarget(item, conditions, cjsResolve);
      if (target === null || typeof target === 'string' && target.startsWith('./'))
        return target;
    }
  }
  else if (typeof exports === 'object') {
    for (const condition of Object.keys(exports)) {
      if (condition === 'default' ||
          condition === 'require' && cjsResolve ||
          condition === 'import' && !cjsResolve ||
          conditions.includes(condition)) {
        const target = getExportsTarget(exports[condition], conditions, cjsResolve);
        if (target !== undefined)
          return target;
      }
    }
  }
  else if (exports === null) {
    return exports;
  }
}

function resolveExportsTarget (pkgPath, exports, subpath, job, cjsResolve) {
  if (typeof exports === 'string' ||
      typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).length && Object.keys(exports)[0][0] !== '.')
    exports = { '.' : exports };
  if (subpath in exports) {
    const target = getExportsTarget(exports[subpath], job.exports, cjsResolve);
    if (typeof target === 'string' && target.startsWith('./'))
      return pkgPath + target.slice(1);
  }
  for (const match of Object.keys(exports)) {
    if (!match.endsWith('/'))
      continue;
    if (subpath.startsWith(match)) {
      const target = getExportsTarget(exports[match], job.exports, cjsResolve);
      if (typeof target === 'string' && target.endsWith('/') && target.startsWith('./'))
        return pkgPath + match.slice(2) + subpath.slice(match.length);
    }
  }
}

function resolvePackage (name, parent, job, cjsResolve) {
  let packageParent = parent;
  if (nodeBuiltins.has(name)) return 'node:' + name;

  const pkgName = getPkgName(name);
  
  // package own name resolution
  let selfResolved;
  if (job.exports) {
    const pjsonBoundary = job.getPjsonBoundary(parent);
    if (pjsonBoundary) {
      const pkgCfg = getPkgCfg(pjsonBoundary, job);
      if (pkgCfg && pkgCfg.name && pkgCfg.exports !== null && pkgCfg.exports !== undefined) {
        selfResolved = resolveExportsTarget(pjsonBoundary, pkgCfg.exports, '.' + name.slice(pkgName.length), job, cjsResolve);
        if (selfResolved)
          job.emitFile(pjsonBoundary + sep + 'package.json', 'resolve', parent);
      }
    }
  }

  let separatorIndex;
  const rootSeparatorIndex = packageParent.indexOf(sep);
  while ((separatorIndex = packageParent.lastIndexOf(sep)) > rootSeparatorIndex) {
    packageParent = packageParent.substr(0, separatorIndex);
    const nodeModulesDir = packageParent + sep + 'node_modules';
    const stat = job.stat(nodeModulesDir);
    if (!stat || !stat.isDirectory()) continue;
    const pkgCfg = getPkgCfg(nodeModulesDir + sep + pkgName, job);
    if (pkgCfg && job.exports && pkgCfg.exports !== undefined && pkgCfg.exports !== null && !selfResolved) {
      let legacyResolved;
      if (!job.exportsOnly)
        legacyResolved = resolveFile(nodeModulesDir + sep + name, parent, job) || resolveDir(nodeModulesDir + sep + name, parent, job);
      let resolved = resolveExportsTarget(nodeModulesDir + sep + pkgName, pkgCfg.exports, '.' + name.slice(pkgName.length), job, cjsResolve);
      if (resolved && cjsResolve)
        resolved = resolveFile(resolved, parent, job) || resolveDir(resolved, parent, job);
      if (resolved) {
        job.emitFile(nodeModulesDir + sep + pkgName + sep + 'package.json', 'resolve', parent);
        if (legacyResolved && legacyResolved !== resolved)
          return [resolved, legacyResolved];
        return resolved;
      }
      if (legacyResolved)
        return legacyResolved;
    }
    else {
      const resolved = resolveFile(nodeModulesDir + sep + name, parent, job) || resolveDir(nodeModulesDir + sep + name, parent, job);
      if (resolved) {
        if (selfResolved && selfResolved !== resolved)
          return [resolved, selfResolved];
        return resolved;
      }
    }
  }
  if (selfResolved) return selfResolved;
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
