const path = require('path');
const { existsSync, statSync } = require('fs');
const { walk } = require('estree-walker');
const { attachScopes } = require('rollup-pluginutils');
const evaluate = require('./utils/static-eval');
let acorn = require('acorn');
const bindings = require('bindings');
const { isIdentifierRead, isLoop, isVarLoop } = require('./utils/ast-helpers');
const glob = require('glob');
const getPackageBase = require('./utils/get-package-base');
const { pregyp, nbind } = require('./utils/binary-locators');
const interopRequire = require('./utils/interop-require');
const handleSpecialCases = require('./utils/special-cases');
const resolve = require('./resolve-dependency.js');
const nodeGypBuild = require('node-gyp-build');

// Note: these should be deprecated over time as they ship in Acorn core
acorn = acorn.Parser.extend(
  require("acorn-class-fields"),
  require("acorn-export-ns-from"),
  require("acorn-import-meta"),
  require("acorn-numeric-separator"),
  require("acorn-static-class-features"),
);
const os = require('os');
const handleWrappers = require('./utils/wrappers.js');
const resolveFrom = require('resolve-from');

const { UNKNOWN, FUNCTION, WILDCARD, wildcardRegEx } = evaluate;

const staticProcess = {
  cwd: () => {
    return cwd;
  },
  env: {
    NODE_ENV: UNKNOWN,
    [UNKNOWN]: true
  },
  [UNKNOWN]: true
};

// unique symbol value to identify express instance in static analysis
const EXPRESS_SET = Symbol();
const EXPRESS_ENGINE = Symbol();
const NBIND_INIT = Symbol();
const SET_ROOT_DIR = Symbol();
const PKG_INFO = Symbol();
const FS_FN = Symbol();
const BINDINGS = Symbol();
const NODE_GYP_BUILD = Symbol();
const fsSymbols = {
  access: FS_FN,
  accessSync: FS_FN,
  createReadStream: FS_FN,
  exists: FS_FN,
  existsSync: FS_FN,
  fstat: FS_FN,
  fstatSync: FS_FN,
  lstat: FS_FN,
  lstatSync: FS_FN,
  open: FS_FN,
  readFile: FS_FN,
  readFileSync: FS_FN,
  stat: FS_FN,
  statSync: FS_FN
};
const staticModules = Object.assign(Object.create(null), {
  bindings: {
    default: BINDINGS
  },
  express: {
    default: function () {
      return {
        [UNKNOWN]: true,
        set: EXPRESS_SET,
        engine: EXPRESS_ENGINE
      };
    }
  },
  fs: {
    default: fsSymbols,
    ...fsSymbols
  },
  process: {
    default: staticProcess,
    ...staticProcess
  },
  // populated below
  path: {
    default: {}
  },
  os: {
    default: os,
    ...os
  },
  'node-pre-gyp': pregyp,
  'node-pre-gyp/lib/pre-binding': pregyp,
  'node-pre-gyp/lib/pre-binding.js': pregyp,
  'node-gyp-build': {
    default: NODE_GYP_BUILD
  },
  'nbind': {
    init: NBIND_INIT,
    default: {
      init: NBIND_INIT
    }
  },
  'resolve-from': {
    default: resolveFrom
  },
  'strong-globalize': {
    default: {
      SetRootDir: SET_ROOT_DIR
    },
    SetRootDir: SET_ROOT_DIR
  },
  'pkginfo': {
    default: PKG_INFO
  }
});
const globalBindings = {
  // Support for require calls generated from `import` statements by babel
  _interopRequireDefault: interopRequire.normalizeDefaultRequire,
  _interopRequireWildcard: interopRequire.normalizeWildcardRequire,
  // Support for require calls generated from `import` statements by tsc
  __importDefault: interopRequire.normalizeDefaultRequire,
  __importStar: interopRequire.normalizeWildcardRequire,
  MONGOOSE_DRIVER_PATH: undefined
};
globalBindings.global = globalBindings.GLOBAL = globalBindings.globalThis = globalBindings;

// call expression triggers
const TRIGGER = Symbol();
pregyp.find[TRIGGER] = true;
const staticPath = staticModules.path;
Object.keys(path).forEach(name => {
  const pathFn = path[name];
  if (typeof pathFn === 'function') {
    const fn = function () {
      return pathFn.apply(this, arguments);
    };
    fn[TRIGGER] = true;
    staticPath[name] = staticPath.default[name] = fn;
  }
  else {
    staticPath[name] = staticPath.default[name] = pathFn;
  }
});

// overload path.resolve to support custom cwd
staticPath.resolve = staticPath.default.resolve = function (...args) {
  return path.resolve.apply(this, [cwd, ...args]);
};
staticPath.resolve[TRIGGER] = true;

const excludeAssetExtensions = new Set(['.h', '.cmake', '.c', '.cpp']);
const excludeAssetFiles = new Set(['CHANGELOG.md', 'README.md', 'readme.md', 'changelog.md']);
let cwd;

const absoluteRegEx = /^\/[^\/]+|^[a-z]:[\\/][^\\/]+/i;
function isAbsolutePathStr (str) {
  return typeof str === 'string' && str.match(absoluteRegEx);
}

const BOUND_REQUIRE = Symbol();

const repeatGlobRegEx = /([\/\\]\*\*[\/\\]\*)+/g

module.exports = async function (id, code, job) {
  const assets = new Set();
  const deps = new Set();

  const dir = path.dirname(id);
  // if (typeof options.production === 'boolean' && staticProcess.env.NODE_ENV === UNKNOWN)
  //  staticProcess.env.NODE_ENV = options.production ? 'production' : 'dev';
  cwd = job.cwd;
  const pkgBase = getPackageBase(id);

  const emitAssetDirectory = (wildcardPath) => {
    if (!job.analysis.emitGlobs) return;
    const wildcardIndex = wildcardPath.indexOf(WILDCARD);
    const dirIndex = wildcardIndex === -1 ? wildcardPath.length : wildcardPath.lastIndexOf(path.sep, wildcardIndex);
    const assetDirPath = wildcardPath.substr(0, dirIndex);
    const patternPath = wildcardPath.substr(dirIndex);
    const wildcardPattern = patternPath.replace(wildcardRegEx, (_match, index) => {
      return patternPath[index - 1] === path.sep ? '**/*' : '*';
    }).replace(repeatGlobRegEx, '/**/*') || '/**/*';

    if (job.ignoreFn(path.relative(job.base, assetDirPath + wildcardPattern)))
      return;

    assetEmissionPromises = assetEmissionPromises.then(async () => {
      if (job.log)
        console.log('Globbing ' + assetDirPath + wildcardPattern);
      const files = (await new Promise((resolve, reject) =>
        glob(assetDirPath + wildcardPattern, { mark: true, ignore: assetDirPath + '/**/node_modules/**/*' }, (err, files) => err ? reject(err) : resolve(files))
      ));
      files
      .filter(name =>
        !excludeAssetExtensions.has(path.extname(name)) &&
        !excludeAssetFiles.has(path.basename(name)) &&
        !name.endsWith('/')
      )
      .forEach(file => assets.add(file));
    });
  };

  let assetEmissionPromises = Promise.resolve();

  // remove shebang
  code = code.replace(/^#![^\n\r]*[\r\n]/, '');

  let ast, isESM;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2020, allowReturnOutsideFunction: true });
    isESM = false;
  }
  catch (e) {
    const isModule = e && e.message && e.message.includes('sourceType: module');
    if (!isModule) {
      job.warnings.add(new Error(`Failed to parse ${id} as script:\n${e && e.message}`));
    }
  }
  if (!ast) {
    try {
      ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: 'module' });
      isESM = true;
    }
    catch (e) {
      job.warnings.add(new Error(`Failed to parse ${id} as module:\n${e && e.message}`));
      // Parser errors just skip analysis
      return { assets, deps, isESM: false };
    }
  }

  const knownBindings = Object.assign(Object.create(null), {
    __dirname: {
      shadowDepth: 0,
      value: path.resolve(id, '..')
    },
    __filename: {
      shadowDepth: 0,
      value: id
    },
    process: {
      shadowDepth: 0,
      value: staticProcess
    }
  });

  if (!isESM || job.mixedModules) {
    knownBindings.require = {
      shadowDepth: 0,
      value: {
        [FUNCTION] (specifier) {
          deps.add(specifier);
          const m = staticModules[specifier];
          return m.default;
        },
        resolve (specifier) {
          return resolve(specifier, id, job);
        }
      }
    };
    knownBindings.require.value.resolve[TRIGGER] = true;
  }

  function setKnownBinding (name, value) {
    // require is somewhat special in that we shadow it but don't
    // statically analyze it ("known unknown" of sorts)
    if (name === 'require') return;
    knownBindings[name] = {
      shadowDepth: 0,
      value: value
    };
  }
  function getKnownBinding (name) {
    const binding = knownBindings[name];
    if (binding) {
      if (binding.shadowDepth === 0) {
        return binding.value;
      }
    }
  }
  function hasKnownBindingValue (name) {
    const binding = knownBindings[name];
    return binding && binding.shadowDepth === 0;
  }

  if (isESM || job.mixedModules) {
    for (const decl of ast.body) {
      if (decl.type === 'ImportDeclaration') {
        const source = decl.source.value;
        deps.add(source);
        const staticModule = staticModules[source];
        if (staticModule) {
          for (const impt of decl.specifiers) {
            if (impt.type === 'ImportNamespaceSpecifier')
              setKnownBinding(impt.local.name, staticModule);
            else if (impt.type === 'ImportDefaultSpecifier' && 'default' in staticModule)
              setKnownBinding(impt.local.name, staticModule.default);
            else if (impt.type === 'ImportSpecifier' && impt.imported.name in staticModule)
              setKnownBinding(impt.local.name, staticModule[impt.imported.name]);
          }
        }
      }
      else if (decl.type === 'ExportNamedDeclaration' || decl.type === 'ExportAllDeclaration') {
        if (decl.source) deps.add(decl.source.value);
      }
    }
  }

  function computePureStaticValue (expr, computeBranches = true) {
    const vars = Object.create(null);
    Object.keys(knownBindings).forEach(name => {
      vars[name] = getKnownBinding(name);
    });
    Object.keys(globalBindings).forEach(name => {
      vars[name] = globalBindings[name];
    });
    // evaluate returns undefined for non-statically-analyzable
    const result = evaluate(expr, vars, computeBranches);
    return result;
  }

  // statically determinable leaves are tracked, and inlined when the
  // greatest parent statically known leaf computation corresponds to an asset path
  let staticChildNode, staticChildValue;

  // Express engine opt-out
  let definedExpressEngines = false;

  function emitWildcardRequire (wildcardRequire) {
    if (!job.analysis.emitGlobs || !wildcardRequire.startsWith('./') && !wildcardRequire.startsWith('../')) return;

    wildcardRequire = path.resolve(dir, wildcardRequire);

    const wildcardIndex = wildcardRequire.indexOf(WILDCARD);
    const dirIndex = wildcardIndex === -1 ? wildcardRequire.length : wildcardRequire.lastIndexOf(path.sep, wildcardIndex);
    const wildcardDirPath = wildcardRequire.substr(0, dirIndex);
    const patternPath = wildcardRequire.substr(dirIndex);
    let wildcardPattern = patternPath.replace(wildcardRegEx, (_match, index) => {
      return patternPath[index - 1] === path.sep ? '**/*' : '*';
    }) || '/**/*';

    if (!wildcardPattern.endsWith('*'))
      wildcardPattern += '?(' + (job.ts ? '.ts|.tsx|' : '') + '.js|.json|.node)';

    if (job.ignoreFn(path.relative(job.base, wildcardDirPath + wildcardPattern)))
      return;

    assetEmissionPromises = assetEmissionPromises.then(async () => {
      if (job.log)
        console.log('Globbing ' + wildcardDirPath + wildcardPattern);
      const files = (await new Promise((resolve, reject) =>
        glob(wildcardDirPath + wildcardPattern, { mark: true, ignore: wildcardDirPath + '/**/node_modules/**/*' }, (err, files) => err ? reject(err) : resolve(files))
      ));
      files
      .filter(name =>
        !excludeAssetExtensions.has(path.extname(name)) &&
        !excludeAssetFiles.has(path.basename(name)) &&
        !name.endsWith('/')
      )
      .forEach(file => assets.add(file));
    });
  }

  function processRequireArg (expression) {
    if (expression.type === 'ConditionalExpression') {
      processRequireArg(expression.consequent);
      processRequireArg(expression.alternate);
      return;
    }
    if (expression.type === 'LogicalExpression') {
      processRequireArg(expression.left);
      processRequireArg(expression.right);
      return;
    }

    let computed = computePureStaticValue(expression, true);
    if (!computed) return;

    if (typeof computed.value === 'string') {
      if (!computed.wildcards)
        deps.add(computed.value);
      else if (computed.wildcards.length >= 1)
        emitWildcardRequire(computed.value);
    }
    else {
      if (typeof computed.then === 'string')
        deps.add(computed.then);
      if (typeof computed.else === 'string')
        deps.add(computed.else);
    }
  }

  let scope = attachScopes(ast, 'scope');
  handleWrappers(ast);
  ({ ast = ast, scope = scope } = handleSpecialCases({ id, ast, scope, emitAsset: path => assets.add(path), emitAssetDirectory, job }) || {});

  function backtrack (self, parent) {
    // computing a static expression outward
    // -> compute and backtrack
    if (!staticChildNode) throw new Error('Internal error: No staticChildNode for backtrack.');
    const curStaticValue = computePureStaticValue(parent, true);
    if (curStaticValue) {
      if ('value' in curStaticValue && typeof curStaticValue.value !== 'symbol' ||
          typeof curStaticValue.then !== 'symbol' && typeof curStaticValue.else !== 'symbol') {
        staticChildValue = curStaticValue;
        staticChildNode = parent;
        if (self.skip) self.skip();
        return;
      }
    }
    // no static value -> see if we should emit the asset if it exists
    emitStaticChildAsset();
  }

  walk(ast, {
    enter (node, parent) {
      if (node.scope) {
        scope = node.scope;
        for (const id in node.scope.declarations) {
          if (id in knownBindings)
            knownBindings[id].shadowDepth++;
        }
      }

      // currently backtracking
      if (staticChildNode) return;

      if (node.type === 'Identifier') {
        if (isIdentifierRead(node, parent) && job.analysis.computeFileReferences) {
          let binding;
          // detect asset leaf expression triggers (if not already)
          // __dirname,  __filename
          // Could add import.meta.url, even path-like environment variables
          if (typeof (binding = getKnownBinding(node.name)) === 'string' && binding.match(absoluteRegEx) ||
              binding && (typeof binding === 'function' || typeof binding === 'object') && binding[TRIGGER]) {
            staticChildValue = { value: typeof binding === 'string' ? binding : undefined };
            staticChildNode = node;
            backtrack(this, parent);
          }
        }
      }
      else if ((isESM || job.mixedModules) && node.type === 'ImportExpression') {
        processRequireArg(node.source);
        return;
      }
      // Call expression cases and asset triggers
      // - fs triggers: fs.readFile(...)
      // - require.resolve()
      // - bindings()(...)
      // - nodegyp()
      // - etc.
      else if (node.type === 'CallExpression') {
        if ((!isESM || job.mixedModules) && node.callee.type === 'Identifier' && node.arguments.length) {
          if (node.callee.name === 'require' && knownBindings.require.shadowDepth === 0) {
            processRequireArg(node.arguments[0]);
            return;
          }
        }
        else if ((!isESM || job.mixedModules) &&
            node.callee.type === 'MemberExpression' &&
            node.callee.object.type === 'Identifier' &&
            node.callee.object.name === 'module' &&
            'module' in knownBindings === false &&
            node.callee.property.type === 'Identifier' &&
            !node.callee.computed &&
            node.callee.property.name === 'require' &&
            node.arguments.length) {
          processRequireArg(node.arguments[0]);
          return;
        }

        const calleeValue = job.analysis.evaluatePureExpressions && computePureStaticValue(node.callee, false);
        // if we have a direct pure static function,
        // and that function has a [TRIGGER] symbol -> trigger asset emission from it
        if (calleeValue && typeof calleeValue.value === 'function' && calleeValue.value[TRIGGER] && job.analysis.computeFileReferences) {
          staticChildValue = computePureStaticValue(node, true);
          // if it computes, then we start backtracking
          if (staticChildValue) {
            staticChildNode = node;
            backtrack(this, parent);
          }
        }
        // handle well-known function symbol cases
        else if (calleeValue && typeof calleeValue.value === 'symbol') {
          switch (calleeValue.value) {
            // customRequireWrapper('...')
            case BOUND_REQUIRE:
              if (node.arguments.length === 1 &&
                  node.arguments[0].type === 'Literal' &&
                  node.callee.type === 'Identifier' &&
                  knownBindings.require.shadowDepth === 0) {
                processRequireArg(node.arguments[0]);
              }
            break;
            // require('bindings')(...)
            case BINDINGS:
              if (node.arguments.length) {
                const arg = computePureStaticValue(node.arguments[0], false);
                if (arg && arg.value) {
                  let staticBindingsInstance = false;
                  let opts;
                  if (typeof arg.value === 'object')
                    opts = arg.value;
                  else if (typeof arg.value === 'string')
                    opts = { bindings: arg.value };
                  if (!opts.path) {
                    staticBindingsInstance = true;
                    opts.path = true;
                  }
                  opts.module_root = pkgBase;
                  let resolved;
                  try {
                    resolved = bindings(opts);
                  }
                  catch (e) {}
                  if (resolved) {
                    staticChildValue = { value: resolved };
                    staticChildNode = node;
                    emitStaticChildAsset(staticBindingsInstance);
                  }
                }
              }
            break;
            case NODE_GYP_BUILD:
              if (node.arguments.length === 1 && node.arguments[0].type === 'Identifier' &&
                  node.arguments[0].name === '__dirname' && knownBindings.__dirname.shadowDepth === 0) {
                transformed = true;
                let resolved;
                try {
                  resolved = nodeGypBuild.path(dir);
                }
                catch (e) {}
                if (resolved) {
                  staticChildValue = { value: resolved };
                  staticChildNode = node;
                  emitStaticChildAsset(path);
                }
              }
            break;
            // nbind.init(...) -> require('./resolved.node')
            case NBIND_INIT:
              if (node.arguments.length) {
                const arg = computePureStaticValue(node.arguments[0], false);
                if (arg && arg.value) {
                  const bindingInfo = nbind(arg.value);
                  if (bindingInfo) {
                    deps.add(path.relative(dir, bindingInfo.path).replace(/\\/g, '/'));
                    return this.skip();
                  }
                }
              }
            break;
            // Express templates:
            // app.set("view engine", [name]) -> 'name' is a require
            case EXPRESS_SET:
              if (node.arguments.length === 2 &&
                  node.arguments[0].type === 'Literal' &&
                  node.arguments[0].value === 'view engine' &&
                  !definedExpressEngines) {
                processRequireArg(node.arguments[1]);
                return this.skip();
              }
            break;
            // app.engine('name', ...) causes opt-out of express dynamic require
            case EXPRESS_ENGINE:
              definedExpressEngines = true;
            break;
            case FS_FN:
              if (node.arguments[0] && job.analysis.computeFileReferences) {
                staticChildValue = computePureStaticValue(node.arguments[0], true);
                // if it computes, then we start backtracking
                if (staticChildValue) {
                  staticChildNode = node.arguments[0];
                  backtrack(this, parent);
                  return this.skip();
                }
              }
            break;
            // strong globalize (emits intl folder)
            case SET_ROOT_DIR:
              if (node.arguments[0]) {
                const rootDir = computePureStaticValue(node.arguments[0], false);
                if (rootDir && rootDir.value)
                  emitAssetDirectory(rootDir.value + '/intl');
                return this.skip();
              }
            break;
            // pkginfo - require('pkginfo')(module) -> loads package.json
            case PKG_INFO:
              let pjsonPath = path.resolve(id, '../package.json');
              const rootPjson = path.resolve('/package.json');
              while (pjsonPath !== rootPjson && !existsSync(pjsonPath))
                pjsonPath = path.resolve(pjsonPath, '../../package.json');
              if (pjsonPath !== rootPjson)
                assets.add(pjsonPath);
            break;
          }
        }
      }
      else if (node.type === 'VariableDeclaration' && !isVarLoop(parent) && job.analysis.evaluatePureExpressions) {
        for (const decl of node.declarations) {
          if (!decl.init) continue;
          const computed = computePureStaticValue(decl.init, false);
          if (computed && 'value' in computed) {
            // var known = ...;
            if (decl.id.type === 'Identifier') {
              setKnownBinding(decl.id.name, computed.value);
            }
            // var { known } = ...;
            else if (decl.id.type === 'ObjectPattern') {
              for (const prop of decl.id.properties) {
                if (prop.type !== 'Property' ||
                    prop.key.type !== 'Identifier' ||
                    prop.value.type !== 'Identifier' ||
                    typeof computed.value !== 'object' ||
                    computed.value === null ||
                    !(prop.key.name in computed.value))
                  continue;
                setKnownBinding(prop.value.name, computed.value[prop.key.name]);
              }
            }
            if (isAbsolutePathStr(computed.value)) {
              staticChildValue = computed;
              staticChildNode = decl.init;
              emitStaticChildAsset();
            }
          }
        }
      }
      else if (node.type === 'AssignmentExpression' && !isLoop(parent) && job.analysis.evaluatePureExpressions) {
        if (!hasKnownBindingValue(node.left.name)) {
          const computed = computePureStaticValue(node.right, false);
          if (computed && 'value' in computed) {
            // var known = ...
            if (node.left.type === 'Identifier') {
              setKnownBinding(node.left.name, computed.value);
            }
            // var { known } = ...
            else if (node.left.type === 'ObjectPattern') {
              for (const prop of node.left.properties) {
                if (prop.type !== 'Property' ||
                    prop.key.type !== 'Identifier' ||
                    prop.value.type !== 'Identifier' ||
                    typeof computed.value !== 'object' ||
                    computed.value === null ||
                    !(prop.key.name in computed.value))
                  continue;
                setKnownBinding(prop.value.name, computed.value[prop.key.name]);
              }
            }
            if (isAbsolutePathStr(computed.value)) {
              staticChildValue = computed;
              staticChildNode = node.right;
              emitStaticChildAsset();
            }
          }
        }
      }
      // Support require wrappers like function p (x) { ...; var y = require(x); ...; return y;  }
      else if ((!isESM || job.mixedModules) &&
               (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') &&
               (node.arguments || node.params)[0] && (node.arguments || node.params)[0].type === 'Identifier') {
        let fnName, args;
        if ((node.type === 'ArrowFunctionExpression' ||  node.type === 'FunctionExpression') &&
            parent.type === 'VariableDeclarator' &&
            parent.id.type === 'Identifier') {
          fnName = parent.id;
          args = node.arguments || node.params;
        }
        else if (node.id) {
          fnName = node.id;
          args = node.arguments || node.params;
        }
        if (fnName && node.body.body) {
          let requireDecl, returned = false;
          for (let i = 0; i < node.body.body.length; i++) {
            if (node.body.body[i].type === 'VariableDeclaration' && !requireDecl) {
              requireDecl = node.body.body[i].declarations.find(decl =>
                decl.id.type === 'Identifier' &&
                decl.init &&
                decl.init.type === 'CallExpression' &&
                decl.init.callee.type === 'Identifier' &&
                decl.init.callee.name === 'require' &&
                knownBindings.require.shadowDepth === 0 &&
                decl.init.arguments[0] &&
                decl.init.arguments[0].type === 'Identifier' &&
                decl.init.arguments[0].name === args[0].name
              );
            }
            if (requireDecl &&
                node.body.body[i].type === 'ReturnStatement' &&
                node.body.body[i].argument &&
                node.body.body[i].argument.type === 'Identifier' &&
                node.body.body[i].argument.name === requireDecl.id.name) {
              returned = true;
              break;
            }
          }
          if (returned)
            setKnownBinding(fnName.name, BOUND_REQUIRE);
        }
      }
    },
    leave (node, parent) {
      if (node.scope) {
        scope = scope.parent;
        for (const id in node.scope.declarations) {
          if (id in knownBindings) {
            if (knownBindings[id].shadowDepth > 0)
              knownBindings[id].shadowDepth--;
            else
              delete knownBindings[id];
          }
        }
      }

      if (staticChildNode) backtrack(this, parent);
    }
  });

  await assetEmissionPromises;
  return { assets, deps, isESM };

  function emitAssetPath (assetPath) {
    // verify the asset file / directory exists
    const wildcardIndex = assetPath.indexOf(WILDCARD);
    const dirIndex = wildcardIndex === -1 ? assetPath.length : assetPath.lastIndexOf(path.sep, wildcardIndex);
    const basePath = assetPath.substr(0, dirIndex);
    try {
      var stats = statSync(basePath);
    }
    catch (e) {
      return;
    }
    if (wildcardIndex !== -1 && stats.isFile())
      return;
    if (stats.isFile()) {
      assets.add(assetPath);
    }
    else if (stats.isDirectory()) {
      if (validWildcard(assetPath))
        emitAssetDirectory(assetPath);
    }
  }

  function validWildcard (assetPath) {
    let wildcardSuffix = '';
    if (assetPath.endsWith(path.sep))
      wildcardSuffix = path.sep;
    else if (assetPath.endsWith(path.sep + WILDCARD))
      wildcardSuffix = path.sep + WILDCARD;
    else if (assetPath.endsWith(WILDCARD))
      wildcardSuffix = WILDCARD;
    // do not emit __dirname
    if (assetPath === dir + wildcardSuffix)
      return false;
    // do not emit cwd
    if (assetPath === cwd + wildcardSuffix)
      return false;
    // do not emit node_modules
    if (assetPath.endsWith(path.sep + 'node_modules' + wildcardSuffix))
      return false;
    // do not emit directories above __dirname
    if (dir.startsWith(assetPath.substr(0, assetPath.length - wildcardSuffix.length) + path.sep))
      return false;
    // do not emit asset directories higher than the node_modules base if a package
    if (pkgBase) {
      const nodeModulesBase = id.substr(0, id.indexOf(path.sep + 'node_modules')) + path.sep + 'node_modules' + path.sep;
      if (!assetPath.startsWith(nodeModulesBase)) {
        if (job.log) console.log('Skipping asset emission of ' + assetPath.replace(wildcardRegEx, '*') + ' for ' + id + ' as it is outside the package base ' + pkgBase);
        return false;
      }
    }
    return true;
  }

  function emitStaticChildAsset () {
    if (isAbsolutePathStr(staticChildValue.value)) {
      let resolved;
      try { resolved = path.resolve(staticChildValue.value); }
      catch (e) {}
      emitAssetPath(resolved);
    }
    else if (isAbsolutePathStr(staticChildValue.then) && isAbsolutePathStr(staticChildValue.else)) {
      let resolvedThen;
      try { resolvedThen = path.resolve(staticChildValue.then); }
      catch (e) {}
      let resolvedElse;
      try { resolvedElse = path.resolve(staticChildValue.else); }
      catch (e) {}
      if (resolvedThen) emitAssetPath(resolvedThen);
      if (resolvedElse) emitAssetPath(resolvedElse);
    }
    staticChildNode = staticChildValue = undefined;
  }
};
