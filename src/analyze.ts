import path from 'path';
import { AsyncHandler, asyncWalk } from 'estree-walker';
import { attachScopes } from '@rollup/pluginutils';
import {
  evaluate,
  UNKNOWN,
  FUNCTION,
  WILDCARD,
  wildcardRegEx,
} from './utils/static-eval';
import { Parser } from 'acorn';
import bindings from 'bindings';
import { isIdentifierRead, isLoop, isVarLoop } from './utils/ast-helpers';
import { glob } from 'glob';
import { getPackageBase } from './utils/get-package-base';
import { pregyp, nbind } from './utils/binary-locators';
import {
  normalizeDefaultRequire,
  normalizeWildcardRequire,
} from './utils/interop-require';
import handleSpecialCases from './utils/special-cases';
import { Node } from './utils/types';
import resolve from './resolve-dependency.js';
//@ts-ignore
import nodeGypBuild from 'node-gyp-build';
//@ts-ignore
import mapboxPregyp from '@mapbox/node-pre-gyp';
import { Job } from './node-file-trace';
import { fileURLToPath, pathToFileURL, URL } from 'url';

// Note: these should be deprecated over time as they ship in Acorn core
const acorn = Parser.extend(
  //require("acorn-class-fields"),
  //require("acorn-static-class-features"),
  //require("acorn-private-class-elements")
  require('acorn-import-attributes').importAttributesOrAssertions,
);

import os from 'os';
import url from 'url';
import { handleWrappers } from './utils/wrappers';
import resolveFrom from 'resolve-from';
import {
  ConditionalValue,
  EvaluatedValue,
  StaticValue,
  Ast,
} from './utils/types';

const staticProcess = {
  cwd: () => {
    return cwd;
  },
  env: {
    NODE_ENV: UNKNOWN,
    [UNKNOWN]: true,
  },
  [UNKNOWN]: true,
};

// unique symbol value to identify express instance in static analysis
const EXPRESS_SET = Symbol();
const EXPRESS_ENGINE = Symbol();
const NBIND_INIT = Symbol();
const SET_ROOT_DIR = Symbol();
const PKG_INFO = Symbol();
const FS_FN = Symbol();
const FS_DIR_FN = Symbol();
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
  readdir: FS_DIR_FN,
  readdirSync: FS_DIR_FN,
  readFile: FS_FN,
  readFileSync: FS_FN,
  stat: FS_FN,
  statSync: FS_FN,
};
const fsExtraSymbols = {
  ...fsSymbols,
  pathExists: FS_FN,
  pathExistsSync: FS_FN,
  readJson: FS_FN,
  readJSON: FS_FN,
  readJsonSync: FS_FN,
  readJSONSync: FS_FN,
};
const MODULE_FN = Symbol();
const CREATE_REQUIRE = Symbol();
const moduleSymbols = {
  register: MODULE_FN,
  createRequire: CREATE_REQUIRE,
};
const staticModules = Object.assign(Object.create(null), {
  bindings: {
    default: BINDINGS,
  },
  express: {
    default: function () {
      return {
        [UNKNOWN]: true,
        set: EXPRESS_SET,
        engine: EXPRESS_ENGINE,
      };
    },
  },
  fs: {
    default: fsSymbols,
    ...fsSymbols,
  },
  module: {
    default: moduleSymbols,
    ...moduleSymbols,
  },
  'fs-extra': {
    default: fsExtraSymbols,
    ...fsExtraSymbols,
  },
  'graceful-fs': {
    default: fsSymbols,
    ...fsSymbols,
  },
  process: {
    default: staticProcess,
    ...staticProcess,
  },
  // populated below
  path: {
    default: {},
  },
  os: {
    default: os,
    ...os,
  },
  url: {
    default: url,
    ...url,
  },
  '@mapbox/node-pre-gyp': {
    default: mapboxPregyp,
    ...mapboxPregyp,
  },
  'node-pre-gyp': pregyp,
  'node-pre-gyp/lib/pre-binding': pregyp,
  'node-pre-gyp/lib/pre-binding.js': pregyp,
  'node-gyp-build': {
    default: NODE_GYP_BUILD,
  },
  '@aminya/node-gyp-build': {
    default: NODE_GYP_BUILD,
  },
  nbind: {
    init: NBIND_INIT,
    default: {
      init: NBIND_INIT,
    },
  },
  'resolve-from': {
    default: resolveFrom,
  },
  'strong-globalize': {
    default: {
      SetRootDir: SET_ROOT_DIR,
    },
    SetRootDir: SET_ROOT_DIR,
  },
  pkginfo: {
    default: PKG_INFO,
  },
});
const globalBindings: any = {
  // Support for require calls generated from `import` statements by babel
  _interopRequireDefault: normalizeDefaultRequire,
  _interopRequireWildcard: normalizeWildcardRequire,
  // Support for require calls generated from `import` statements by tsc
  __importDefault: normalizeDefaultRequire,
  __importStar: normalizeWildcardRequire,
  MONGOOSE_DRIVER_PATH: undefined,
  URL: URL,
  Object: {
    assign: Object.assign,
  },
};
globalBindings.global =
  globalBindings.GLOBAL =
  globalBindings.globalThis =
    globalBindings;

// call expression triggers
const TRIGGER = Symbol();
(pregyp.find as any)[TRIGGER] = true;
const staticPath = staticModules.path;
Object.keys(path).forEach((name) => {
  const pathFn = (path as any)[name];
  if (typeof pathFn === 'function') {
    const fn: any = function mockPath() {
      return pathFn.apply(mockPath, arguments);
    };
    fn[TRIGGER] = true;
    staticPath[name] = staticPath.default[name] = fn;
  } else {
    staticPath[name] = staticPath.default[name] = pathFn;
  }
});

// overload path.resolve to support custom cwd
staticPath.resolve = staticPath.default.resolve = function (...args: string[]) {
  return path.resolve.apply(this, [cwd, ...args]);
};
staticPath.resolve[TRIGGER] = true;

const excludeAssetExtensions = new Set(['.h', '.cmake', '.c', '.cpp']);
const excludeAssetFiles = new Set([
  'CHANGELOG.md',
  'README.md',
  'readme.md',
  'changelog.md',
]);
let cwd: string;

const absoluteRegEx = /^\/[^\/]+|^[a-z]:[\\/][^\\/]+/i;
function isAbsolutePathOrUrl(str: any): boolean {
  if (str instanceof URL) return str.protocol === 'file:';
  if (typeof str === 'string') {
    if (str.startsWith('file:')) {
      try {
        new URL(str);
        return true;
      } catch {
        return false;
      }
    }
    return absoluteRegEx.test(str);
  }
  return false;
}

const BOUND_REQUIRE = Symbol();
const repeatGlobRegEx = /([\/\\]\*\*[\/\\]\*)+/g;

export interface AnalyzeResult {
  assets: Set<string>;
  deps: Set<string>;
  imports: Set<string>;
  isESM: boolean;
}

export default async function analyze(
  id: string,
  code: string,
  job: Job,
): Promise<AnalyzeResult> {
  const assets = new Set<string>();
  const deps = new Set<string>();
  const imports = new Set<string>();

  const dir = path.dirname(id);
  // if (typeof options.production === 'boolean' && staticProcess.env.NODE_ENV === UNKNOWN)
  //  staticProcess.env.NODE_ENV = options.production ? 'production' : 'dev';
  cwd = job.cwd;
  const pkgBase = getPackageBase(id);

  const emitAssetDirectory = (wildcardPath: string) => {
    if (!job.analysis.emitGlobs) return;
    wildcardPath = wildcardPath.replaceAll(path.sep, path.posix.sep);
    const wildcardIndex = wildcardPath.indexOf(WILDCARD);
    const dirIndex =
      wildcardIndex === -1
        ? wildcardPath.length
        : wildcardPath.lastIndexOf(path.posix.sep, wildcardIndex);
    const assetDirPath = wildcardPath.substring(0, dirIndex);
    const patternPath = wildcardPath.slice(dirIndex);
    const wildcardPattern =
      patternPath
        .replace(wildcardRegEx, (_match, index) => {
          return patternPath[index - 1] === path.posix.sep ? '**/*' : '*';
        })
        .replace(repeatGlobRegEx, '/**/*') || '/**/*';

    if (job.ignoreFn(path.relative(job.base, assetDirPath + wildcardPattern)))
      return;

    assetEmissionPromises = assetEmissionPromises.then(async () => {
      if (job.log) console.log('Globbing ' + assetDirPath + wildcardPattern);
      const files = await glob(assetDirPath + wildcardPattern, {
        mark: true,
        ignore: assetDirPath + '/**/node_modules/**/*',
        dot: true,
        nodir: true,
      });
      files
        .filter(
          (name) =>
            !excludeAssetExtensions.has(path.extname(name)) &&
            !excludeAssetFiles.has(path.basename(name)),
        )
        .forEach((file) => assets.add(file));
    });
  };

  let assetEmissionPromises = Promise.resolve();

  // remove shebang
  code = code.replace(/^#![^\n\r]*[\r\n]/, '');

  let ast: Node;
  let isESM = false;

  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      allowReturnOutsideFunction: true,
    });
    isESM = false;
  } catch (e: any) {
    const isModule = e && e.message && e.message.includes('sourceType: module');
    if (!isModule) {
      job.warnings.add(
        new Error(`Failed to parse ${id} as script:\n${e && e.message}`),
      );
    }
  }
  //@ts-ignore
  if (!ast) {
    try {
      ast = acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowAwaitOutsideFunction: true,
      });
      isESM = true;
    } catch (e: any) {
      job.warnings.add(
        new Error(`Failed to parse ${id} as module:\n${e && e.message}`),
      );
      // Parser errors just skip analysis
      return { assets, deps, imports, isESM: false };
    }
  }

  const importMetaUrl = pathToFileURL(id).href;

  const knownBindings: Record<
    string,
    {
      shadowDepth: number;
      value: StaticValue | ConditionalValue;
    }
  > = Object.assign(Object.create(null), {
    __dirname: {
      shadowDepth: 0,
      value: { value: path.resolve(id, '..') },
    },
    __filename: {
      shadowDepth: 0,
      value: { value: id },
    },
    process: {
      shadowDepth: 0,
      value: { value: staticProcess },
    },
  });

  if (!isESM || job.mixedModules) {
    knownBindings.require = {
      shadowDepth: 0,
      value: {
        value: {
          [FUNCTION](specifier: string) {
            deps.add(specifier);
            const m =
              staticModules[
                specifier.startsWith('node:') ? specifier.slice(5) : specifier
              ];
            return m.default;
          },
          resolve(specifier: string) {
            return resolve(specifier, id, job);
          },
        },
      },
    };
    (knownBindings.require.value as StaticValue).value.resolve[TRIGGER] = true;
  }

  function setKnownBinding(
    name: string,
    value: StaticValue | ConditionalValue,
  ) {
    // require is somewhat special in that we shadow it but don't
    // statically analyze it ("known unknown" of sorts)
    // but we can make an exception for ones created by module.createRequire
    if (
      name === 'require' &&
      'value' in value &&
      value.value !== BOUND_REQUIRE
    ) {
      return;
    }
    knownBindings[name] = {
      shadowDepth: 0,
      value: value,
    };
  }
  function getKnownBinding(name: string): EvaluatedValue {
    const binding = knownBindings[name];
    if (binding) {
      if (binding.shadowDepth === 0) {
        return binding.value;
      }
    }
    return undefined;
  }
  function hasKnownBindingValue(name: string) {
    const binding = knownBindings[name];
    return binding && binding.shadowDepth === 0;
  }

  if ((isESM || job.mixedModules) && isAst(ast)) {
    for (const decl of ast.body) {
      if (decl.type === 'ImportDeclaration') {
        const source = String(decl.source.value);
        deps.add(source);
        const staticModule =
          staticModules[source.startsWith('node:') ? source.slice(5) : source];
        if (staticModule) {
          for (const impt of decl.specifiers) {
            if (impt.type === 'ImportNamespaceSpecifier')
              setKnownBinding(impt.local.name, { value: staticModule });
            else if (
              impt.type === 'ImportDefaultSpecifier' &&
              'default' in staticModule
            )
              setKnownBinding(impt.local.name, { value: staticModule.default });
            else if (
              impt.type === 'ImportSpecifier' &&
              impt.imported.name in staticModule
            )
              setKnownBinding(impt.local.name, {
                value: staticModule[impt.imported.name],
              });
          }
        }
      } else if (
        decl.type === 'ExportNamedDeclaration' ||
        decl.type === 'ExportAllDeclaration'
      ) {
        if (decl.source) deps.add(String(decl.source.value));
      }
    }
  }

  async function computePureStaticValue(expr: Node, computeBranches = true) {
    const vars = Object.create(null);
    Object.keys(globalBindings).forEach((name) => {
      vars[name] = { value: globalBindings[name] };
    });
    Object.keys(knownBindings).forEach((name) => {
      vars[name] = getKnownBinding(name);
    });
    vars['import.meta'] = { url: importMetaUrl };
    // evaluate returns undefined for non-statically-analyzable
    const result = await evaluate(expr, vars, computeBranches);
    return result;
  }

  // statically determinable leaves are tracked, and inlined when the
  // greatest parent statically known leaf computation corresponds to an asset path
  let staticChildNode: Node | undefined;
  let staticChildValue: EvaluatedValue;

  // Express engine opt-out
  let definedExpressEngines = false;

  function emitWildcardRequire(wildcardRequire: string) {
    if (
      !job.analysis.emitGlobs ||
      (!wildcardRequire.startsWith('./') && !wildcardRequire.startsWith('../'))
    )
      return;

    wildcardRequire = path
      .resolve(dir, wildcardRequire)
      .replaceAll(path.sep, path.posix.sep);

    const wildcardIndex = wildcardRequire.indexOf(WILDCARD);
    const dirIndex =
      wildcardIndex === -1
        ? wildcardRequire.length
        : wildcardRequire.lastIndexOf(path.posix.sep, wildcardIndex);
    const wildcardDirPath = wildcardRequire.substring(0, dirIndex);

    const patternPath = wildcardRequire.slice(dirIndex);
    let wildcardPattern =
      patternPath.replace(wildcardRegEx, (_match, index) => {
        return patternPath[index - 1] === path.posix.sep ? '**/*' : '*';
      }) || '/**/*';

    if (!wildcardPattern.endsWith('*'))
      wildcardPattern +=
        '?(' + (job.ts ? '.ts|.tsx|' : '') + '.js|.json|.node)';

    if (
      job.ignoreFn(path.relative(job.base, wildcardDirPath + wildcardPattern))
    )
      return;

    assetEmissionPromises = assetEmissionPromises.then(async () => {
      if (job.log) console.log('Globbing ' + wildcardDirPath + wildcardPattern);
      const files = await glob(wildcardDirPath + wildcardPattern, {
        mark: true,
        ignore: wildcardDirPath + '/**/node_modules/**/*',
        nodir: true,
      });
      files
        .filter(
          (name) =>
            !excludeAssetExtensions.has(path.extname(name)) &&
            !excludeAssetFiles.has(path.basename(name)),
        )
        .forEach((file) => deps.add(file));
    });
  }

  async function processRequireArg(expression: Node, isImport = false) {
    if (expression.type === 'ConditionalExpression') {
      await processRequireArg(expression.consequent, isImport);
      await processRequireArg(expression.alternate, isImport);
      return;
    }
    if (expression.type === 'LogicalExpression') {
      await processRequireArg(expression.left, isImport);
      await processRequireArg(expression.right, isImport);
      return;
    }

    let computed = await computePureStaticValue(expression, true);
    if (!computed) return;

    function add(value: string) {
      (isImport ? imports : deps).add(value);
    }

    if ('value' in computed && typeof computed.value === 'string') {
      if (!computed.wildcards) add(computed.value);
      else if (computed.wildcards.length >= 1)
        emitWildcardRequire(computed.value);
    } else {
      if ('ifTrue' in computed && typeof computed.ifTrue === 'string')
        add(computed.ifTrue);
      if ('else' in computed && typeof computed.else === 'string')
        add(computed.else);
    }
  }

  let scope = attachScopes(ast, 'scope');
  if (isAst(ast)) {
    handleWrappers(ast);
    await handleSpecialCases({
      id,
      ast,
      emitDependency: (path) => deps.add(path),
      emitAsset: (path) => assets.add(path),
      emitAssetDirectory,
      job,
    });
  }
  async function backtrack(
    parent: Node,
    context?: ThisParameterType<AsyncHandler>,
  ) {
    // computing a static expression outward
    // -> compute and backtrack
    // Note that `context` can be undefined in `leave()`
    if (!staticChildNode)
      throw new Error('Internal error: No staticChildNode for backtrack.');
    const curStaticValue = await computePureStaticValue(parent, true);
    if (curStaticValue) {
      if (
        ('value' in curStaticValue &&
          typeof curStaticValue.value !== 'symbol') ||
        ('ifTrue' in curStaticValue &&
          typeof curStaticValue.ifTrue !== 'symbol' &&
          typeof curStaticValue.else !== 'symbol')
      ) {
        staticChildValue = curStaticValue;
        staticChildNode = parent;
        if (context) context.skip();
        return;
      }
    }
    // no static value -> see if we should emit the asset if it exists
    await emitStaticChildAsset();
  }

  await asyncWalk(ast, {
    async enter(_node, _parent) {
      const node: Node = _node as any;
      const parent: Node = _parent as any;

      if (node.scope) {
        scope = node.scope;
        for (const id in node.scope.declarations) {
          if (id in knownBindings) knownBindings[id].shadowDepth++;
        }
      }

      // currently backtracking
      if (staticChildNode) return;

      if (!parent) return;

      if (node.type === 'Identifier') {
        if (
          isIdentifierRead(node, parent) &&
          job.analysis.computeFileReferences
        ) {
          let binding;
          // detect asset leaf expression triggers (if not already)
          // __dirname,  __filename
          if (
            (typeof (binding = (
              getKnownBinding(node.name) as StaticValue | undefined
            )?.value) === 'string' &&
              binding.match(absoluteRegEx)) ||
            (binding &&
              (typeof binding === 'function' || typeof binding === 'object') &&
              binding[TRIGGER])
          ) {
            staticChildValue = {
              value: typeof binding === 'string' ? binding : undefined,
            };
            staticChildNode = node;
            await backtrack(parent, this);
          }
        }
      } else if (
        job.analysis.computeFileReferences &&
        node.type === 'MemberExpression' &&
        node.object.type === 'MetaProperty' &&
        node.object.meta.name === 'import' &&
        node.object.property.name === 'meta' &&
        (node.property.computed ? node.property.value : node.property.name) ===
          'url'
      ) {
        // import.meta.url leaf trigger
        staticChildValue = { value: importMetaUrl };
        staticChildNode = node;
        await backtrack(parent, this);
      } else if (node.type === 'ImportExpression') {
        await processRequireArg(node.source, true);
        return;
      }
      // Call expression cases and asset triggers
      // - fs triggers: fs.readFile(...)
      // - require.resolve()
      // - bindings()(...)
      // - nodegyp()
      // - etc.
      else if (node.type === 'CallExpression') {
        if (
          (!isESM || job.mixedModules) &&
          node.callee.type === 'Identifier' &&
          node.arguments.length
        ) {
          if (
            node.callee.name === 'require' &&
            knownBindings.require &&
            knownBindings.require.shadowDepth === 0
          ) {
            await processRequireArg(node.arguments[0]);
            return;
          }
        } else if (
          (!isESM || job.mixedModules) &&
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'module' &&
          'module' in knownBindings === false &&
          node.callee.property.type === 'Identifier' &&
          !node.callee.computed &&
          node.callee.property.name === 'require' &&
          node.arguments.length
        ) {
          await processRequireArg(node.arguments[0]);
          return;
        } else if (
          (!isESM || job.mixedModules) &&
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'require' &&
          knownBindings.require &&
          knownBindings.require.shadowDepth === 0 &&
          node.callee.property.type === 'Identifier' &&
          !node.callee.computed &&
          node.callee.property.name === 'resolve' &&
          node.arguments.length
        ) {
          await processRequireArg(node.arguments[0]);
          return;
        }

        const calleeValue =
          job.analysis.evaluatePureExpressions &&
          (await computePureStaticValue(node.callee, false));
        // if we have a direct pure static function,
        // and that function has a [TRIGGER] symbol -> trigger asset emission from it
        if (
          calleeValue &&
          'value' in calleeValue &&
          typeof calleeValue.value === 'function' &&
          (calleeValue.value as any)[TRIGGER] &&
          job.analysis.computeFileReferences
        ) {
          staticChildValue = await computePureStaticValue(node, true);
          // if it computes, then we start backtracking
          if (staticChildValue && parent) {
            staticChildNode = node;
            await backtrack(parent, this);
          }
        }
        // handle well-known function symbol cases
        else if (
          calleeValue &&
          'value' in calleeValue &&
          typeof calleeValue.value === 'symbol'
        ) {
          switch (calleeValue.value) {
            // customRequireWrapper('...')
            case BOUND_REQUIRE:
              if (
                node.arguments.length === 1 &&
                node.arguments[0].type === 'Literal' &&
                node.callee.type === 'Identifier' &&
                (!knownBindings.require ||
                  knownBindings.require.shadowDepth === 0)
              ) {
                await processRequireArg(node.arguments[0]);
              }
              break;
            // require('bindings')(...)
            case BINDINGS:
              if (node.arguments.length) {
                const arg = await computePureStaticValue(
                  node.arguments[0],
                  false,
                );
                if (arg && 'value' in arg && arg.value) {
                  let opts: any;
                  if (typeof arg.value === 'object') opts = arg.value;
                  else if (typeof arg.value === 'string')
                    opts = { bindings: arg.value };
                  if (!opts.path) {
                    opts.path = true;
                  }
                  opts.module_root = pkgBase;
                  let resolved;
                  try {
                    resolved = bindings(opts);
                  } catch (e) {}
                  if (resolved) {
                    staticChildValue = { value: resolved };
                    staticChildNode = node;
                    await emitStaticChildAsset();
                  }
                }
              }
              break;
            case NODE_GYP_BUILD:
              // handle case: require('node-gyp-build')(__dirname)
              // handle case: require('node-gyp-build')(join(__dirname, ''))
              // also case: require('@aminya/node-gyp-build')(__dirname)

              if (node.arguments.length) {
                const arg = await computePureStaticValue(
                  node.arguments[0],
                  false,
                );
                if (arg && 'value' in arg && arg.value) {
                  const pathJoinedDir = arg.value;
                  let resolved: string | undefined;
                  try {
                    // the pkg could be 'node-gyp-build' or '@aminya/node-gyp-build'
                    const pkgName =
                      node?.callee?.arguments?.[0]?.value || 'node-gyp-build';
                    // use installed version of node-gyp-build since resolving
                    // binaries can differ among versions
                    const nodeGypBuildPath = resolveFrom(
                      pathJoinedDir,
                      pkgName,
                    );
                    resolved = require(nodeGypBuildPath).path(pathJoinedDir);
                  } catch (e) {
                    try {
                      resolved = nodeGypBuild.path(pathJoinedDir);
                    } catch (e) {}
                  }
                  if (resolved) {
                    staticChildValue = { value: resolved };
                    staticChildNode = node;
                    await emitStaticChildAsset();
                  }
                }
              }
              break;
            // nbind.init(...) -> require('./resolved.node')
            case NBIND_INIT:
              if (node.arguments.length) {
                const arg = await computePureStaticValue(
                  node.arguments[0],
                  false,
                );
                if (
                  arg &&
                  'value' in arg &&
                  (typeof arg.value === 'string' ||
                    typeof arg.value === 'undefined')
                ) {
                  const bindingInfo = nbind(arg.value);
                  if (bindingInfo && bindingInfo.path) {
                    deps.add(
                      path.relative(dir, bindingInfo.path).replace(/\\/g, '/'),
                    );
                    return this.skip();
                  }
                }
              }
              break;
            // Express templates:
            // app.set("view engine", [name]) -> 'name' is a require
            case EXPRESS_SET:
              if (
                node.arguments.length === 2 &&
                node.arguments[0].type === 'Literal' &&
                node.arguments[0].value === 'view engine' &&
                !definedExpressEngines
              ) {
                await processRequireArg(node.arguments[1]);
                return this.skip();
              }
              break;
            // app.engine('name', ...) causes opt-out of express dynamic require
            case EXPRESS_ENGINE:
              definedExpressEngines = true;
              break;
            case FS_FN:
            case FS_DIR_FN:
              if (node.arguments[0] && job.analysis.computeFileReferences) {
                staticChildValue = await computePureStaticValue(
                  node.arguments[0],
                  true,
                );
                // if it computes, then we start backtracking
                if (staticChildValue) {
                  staticChildNode = node.arguments[0];
                  if (
                    calleeValue.value === FS_DIR_FN &&
                    node.arguments[0].type === 'Identifier' &&
                    node.arguments[0].name === '__dirname'
                  ) {
                    // Special case `fs.readdirSync(__dirname)` to emit right away
                    emitAssetDirectory(dir);
                  } else {
                    await backtrack(parent, this);
                  }
                  return this.skip();
                }
              }
              break;
            // strong globalize (emits intl folder)
            case SET_ROOT_DIR:
              if (node.arguments[0]) {
                const rootDir = await computePureStaticValue(
                  node.arguments[0],
                  false,
                );
                if (rootDir && 'value' in rootDir && rootDir.value)
                  emitAssetDirectory(rootDir.value + '/intl');
                return this.skip();
              }
              break;
            // pkginfo - require('pkginfo')(module) -> loads package.json
            case PKG_INFO:
              let pjsonPath = path.resolve(id, '../package.json');
              const rootPjson = path.resolve('/package.json');
              while (
                pjsonPath !== rootPjson &&
                (await job.stat(pjsonPath)) === null
              )
                pjsonPath = path.resolve(pjsonPath, '../../package.json');
              if (pjsonPath !== rootPjson) assets.add(pjsonPath);
              break;
            case MODULE_FN:
              if (
                node.arguments.length &&
                // TODO: We only cater for the case where the first argument is a string
                node.arguments[0].type === 'Literal'
              ) {
                const pathOrSpecifier = node.arguments[0].value;
                // It's a relative URL
                if (pathOrSpecifier.startsWith('.')) {
                  // Compute the parentURL if it's statically analyzable
                  const computedParentURL =
                    node.arguments.length > 1
                      ? await computePureStaticValue(node.arguments[1])
                      : undefined;

                  if (computedParentURL && 'value' in computedParentURL) {
                    const parentURL =
                      computedParentURL.value instanceof URL
                        ? computedParentURL.value.href
                        : typeof computedParentURL.value === 'string'
                          ? computedParentURL.value
                          : computedParentURL.value.parentURL;

                    // Resolve the srcURL from the parentURL
                    const srcURL = new URL(pathOrSpecifier, parentURL).href;

                    const currentDirURL = importMetaUrl.slice(
                      0,
                      importMetaUrl.lastIndexOf('/'),
                    );

                    // Resolve the srcPath relative to the current file
                    const srcPath = path.relative(currentDirURL, srcURL);
                    // Make it a proper relative path
                    const relativeSrcPath = srcPath.startsWith('.')
                      ? srcPath
                      : './' + srcPath;

                    imports.add(relativeSrcPath);
                  }
                } else {
                  // It's a bare specifier, so just add into the imports
                  imports.add(pathOrSpecifier);
                }
              }
              break;
          }
        }
      } else if (
        node.type === 'VariableDeclaration' &&
        parent &&
        !isVarLoop(parent) &&
        job.analysis.evaluatePureExpressions
      ) {
        for (const decl of node.declarations) {
          if (!decl.init) continue;
          const computed = await computePureStaticValue(decl.init, true);
          if (computed) {
            // var known = ...;
            if (decl.id.type === 'Identifier') {
              setKnownBinding(decl.id.name, computed);
            }
            // var { known } = ...;
            else if (decl.id.type === 'ObjectPattern' && 'value' in computed) {
              for (const prop of decl.id.properties) {
                if (
                  prop.type !== 'Property' ||
                  prop.key.type !== 'Identifier' ||
                  prop.value.type !== 'Identifier' ||
                  typeof computed.value !== 'object' ||
                  computed.value === null ||
                  !(prop.key.name in computed.value)
                )
                  continue;
                setKnownBinding(prop.value.name, {
                  value: computed.value[prop.key.name],
                });
              }
            }
            if (
              !('value' in computed) &&
              isAbsolutePathOrUrl(computed.ifTrue) &&
              isAbsolutePathOrUrl(computed.else)
            ) {
              staticChildValue = computed;
              staticChildNode = decl.init;
              await emitStaticChildAsset();
            }
          }
        }
      } else if (
        node.type === 'AssignmentExpression' &&
        parent &&
        !isLoop(parent) &&
        job.analysis.evaluatePureExpressions
      ) {
        if (!hasKnownBindingValue(node.left.name)) {
          const computed = await computePureStaticValue(node.right, false);
          if (computed && 'value' in computed) {
            // var known = ...
            if (node.left.type === 'Identifier') {
              setKnownBinding(node.left.name, computed);
            }
            // var { known } = ...
            else if (node.left.type === 'ObjectPattern') {
              for (const prop of node.left.properties) {
                if (
                  prop.type !== 'Property' ||
                  prop.key.type !== 'Identifier' ||
                  prop.value.type !== 'Identifier' ||
                  typeof computed.value !== 'object' ||
                  computed.value === null ||
                  !(prop.key.name in computed.value)
                )
                  continue;
                setKnownBinding(prop.value.name, {
                  value: computed.value[prop.key.name],
                });
              }
            }
            if (isAbsolutePathOrUrl(computed.value)) {
              staticChildValue = computed;
              staticChildNode = node.right;
              await emitStaticChildAsset();
            }
          }
        }
      }
      // Support require wrappers like function p (x) { ...; var y = require(x); ...; return y;  }
      else if (
        (!isESM || job.mixedModules) &&
        (node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression') &&
        (node.arguments || node.params)[0] &&
        (node.arguments || node.params)[0].type === 'Identifier'
      ) {
        let fnName: any;
        let args: any[];
        if (
          (node.type === 'ArrowFunctionExpression' ||
            node.type === 'FunctionExpression') &&
          parent &&
          parent.type === 'VariableDeclarator' &&
          parent.id.type === 'Identifier'
        ) {
          fnName = parent.id;
          args = node.arguments || node.params;
        } else if (node.id) {
          fnName = node.id;
          args = node.arguments || node.params;
        }
        if (fnName && node.body.body) {
          let requireDecl,
            returned = false;
          for (let i = 0; i < node.body.body.length; i++) {
            if (
              node.body.body[i].type === 'VariableDeclaration' &&
              !requireDecl
            ) {
              requireDecl = node.body.body[i].declarations.find(
                (decl: any) =>
                  decl &&
                  decl.id &&
                  decl.id.type === 'Identifier' &&
                  decl.init &&
                  decl.init.type === 'CallExpression' &&
                  decl.init.callee.type === 'Identifier' &&
                  decl.init.callee.name === 'require' &&
                  knownBindings.require.shadowDepth === 0 &&
                  decl.init.arguments[0] &&
                  decl.init.arguments[0].type === 'Identifier' &&
                  decl.init.arguments[0].name === args[0].name,
              );
            }
            if (
              requireDecl &&
              node.body.body[i].type === 'ReturnStatement' &&
              node.body.body[i].argument &&
              node.body.body[i].argument.type === 'Identifier' &&
              node.body.body[i].argument.name === requireDecl.id.name
            ) {
              returned = true;
              break;
            }
          }
          if (returned) setKnownBinding(fnName.name, { value: BOUND_REQUIRE });
        }
      }
      // Support module.createRequire
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'module' &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'createRequire'
      ) {
        if (
          parent.type === 'VariableDeclarator' &&
          parent.id.type === 'Identifier'
        ) {
          const requireName = parent.id.name;
          setKnownBinding(requireName, { value: BOUND_REQUIRE });
        }
      }
      // Support createRequire from named import: import { createRequire } from 'node:module'
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'createRequire'
      ) {
        const createRequireBinding = getKnownBinding('createRequire');
        if (
          createRequireBinding &&
          'value' in createRequireBinding &&
          createRequireBinding.value === CREATE_REQUIRE
        ) {
          if (
            parent.type === 'VariableDeclarator' &&
            parent.id.type === 'Identifier'
          ) {
            const requireName = parent.id.name;
            setKnownBinding(requireName, { value: BOUND_REQUIRE });
          }
        }
      }
    },
    async leave(_node, _parent) {
      const node: Node = _node as any;
      const parent: Node = _parent as any;

      if (node.scope) {
        if (scope.parent) {
          scope = scope.parent;
        }
        for (const id in node.scope.declarations) {
          if (id in knownBindings) {
            if (knownBindings[id].shadowDepth > 0)
              knownBindings[id].shadowDepth--;
            else delete knownBindings[id];
          }
        }
      }

      if (staticChildNode && parent) await backtrack(parent, this);
    },
  });

  await assetEmissionPromises;
  return { assets, deps, imports, isESM };

  async function emitAssetPath(assetPath: string) {
    // verify the asset file / directory exists
    const wildcardIndex = assetPath.indexOf(WILDCARD);
    const dirIndex =
      wildcardIndex === -1
        ? assetPath.length
        : assetPath.lastIndexOf(path.sep, wildcardIndex);
    const basePath = assetPath.substring(0, dirIndex);
    try {
      var stats = await job.stat(basePath);
      if (stats === null) {
        throw new Error('file not found');
      }
    } catch (e) {
      return;
    }
    if (wildcardIndex !== -1 && stats.isFile()) return;
    // do not emit assets outside the package boundary if inside node_modules
    if (pkgBase) {
      const nodeModulesBase =
        id.substring(0, id.indexOf(path.sep + 'node_modules')) +
        path.sep +
        'node_modules' +
        path.sep;
      if (!assetPath.startsWith(nodeModulesBase)) {
        if (job.log)
          console.log(
            'Skipping asset emission of ' +
              assetPath +
              ' for ' +
              id +
              ' as it is outside the package base ' +
              pkgBase,
          );
        return;
      }
    }
    if (stats.isFile()) {
      // do not emit file assets outside job.base
      if (job.ignoreFn(path.relative(job.base, assetPath))) return;
      assets.add(assetPath);
    } else if (stats.isDirectory()) {
      // do not emit directory assets outside job.base
      if (job.ignoreFn(path.relative(job.base, assetPath))) return;
      if (validWildcard(assetPath)) emitAssetDirectory(assetPath);
    }
  }

  function validWildcard(assetPath: string) {
    let wildcardSuffix = '';
    if (assetPath.endsWith(path.sep)) wildcardSuffix = path.sep;
    else if (assetPath.endsWith(path.sep + WILDCARD))
      wildcardSuffix = path.sep + WILDCARD;
    else if (assetPath.endsWith(WILDCARD)) wildcardSuffix = WILDCARD;
    // do not emit __dirname
    if (assetPath === dir + wildcardSuffix) return false;
    // do not emit cwd
    if (assetPath === cwd + wildcardSuffix) return false;
    // do not emit node_modules
    if (assetPath.endsWith(path.sep + 'node_modules' + wildcardSuffix))
      return false;
    // do not emit directories above __dirname
    if (
      dir.startsWith(
        assetPath.slice(0, assetPath.length - wildcardSuffix.length) + path.sep,
      )
    )
      return false;
    // do not emit asset directories higher than the node_modules base if a package
    if (pkgBase) {
      const nodeModulesBase =
        id.substring(0, id.indexOf(path.sep + 'node_modules')) +
        path.sep +
        'node_modules' +
        path.sep;
      if (!assetPath.startsWith(nodeModulesBase)) {
        if (job.log)
          console.log(
            'Skipping asset emission of ' +
              assetPath.replace(wildcardRegEx, '*') +
              ' for ' +
              id +
              ' as it is outside the package base ' +
              pkgBase,
          );
        return false;
      }
    }
    return true;
  }

  function resolveAbsolutePathOrUrl(value: string | URL): string {
    return value instanceof URL
      ? fileURLToPath(value)
      : value.startsWith('file:')
        ? fileURLToPath(new URL(value))
        : path.resolve(value);
  }

  async function emitStaticChildAsset() {
    if (!staticChildValue) {
      return;
    }

    if (
      'value' in staticChildValue &&
      isAbsolutePathOrUrl(staticChildValue.value)
    ) {
      try {
        const resolved = resolveAbsolutePathOrUrl(staticChildValue.value);
        await emitAssetPath(resolved);
      } catch (e) {}
    } else if (
      'ifTrue' in staticChildValue &&
      'else' in staticChildValue &&
      isAbsolutePathOrUrl(staticChildValue.ifTrue) &&
      isAbsolutePathOrUrl(staticChildValue.else)
    ) {
      let resolvedThen;
      try {
        resolvedThen = resolveAbsolutePathOrUrl(staticChildValue.ifTrue);
      } catch (e) {}
      let resolvedElse;
      try {
        resolvedElse = resolveAbsolutePathOrUrl(staticChildValue.else);
      } catch (e) {}
      if (resolvedThen) await emitAssetPath(resolvedThen);
      if (resolvedElse) await emitAssetPath(resolvedElse);
    } else if (
      staticChildNode &&
      staticChildNode.type === 'ArrayExpression' &&
      'value' in staticChildValue &&
      staticChildValue.value instanceof Array
    ) {
      for (const value of staticChildValue.value) {
        try {
          const resolved = resolveAbsolutePathOrUrl(value);
          await emitAssetPath(resolved);
        } catch (e) {}
      }
    }
    staticChildNode = staticChildValue = undefined;
  }
}

function isAst(ast: any): ast is Ast {
  return 'body' in ast;
}
