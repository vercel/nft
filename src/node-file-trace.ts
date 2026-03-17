import {
  NodeFileTraceOptions,
  NodeFileTraceResult,
  NodeFileTraceReasons,
  NodeFileTraceReasonType,
} from './types';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import analyze, { AnalyzeResult } from './analyze';
import resolveDependency, { NotFoundError } from './resolve-dependency';
import { isMatch } from 'picomatch';
import { sharedLibEmit } from './utils/sharedlib-emit';
import { CachedFileSystem } from './fs';

function inPath(path: string, parent: string) {
  const pathWithSep = join(parent, sep);
  return path.startsWith(pathWithSep) && path !== pathWithSep;
}

export async function nodeFileTrace(
  files: string[],
  opts: NodeFileTraceOptions = {},
): Promise<NodeFileTraceResult> {
  const job = new Job(opts);

  if (opts.readFile) job.readFile = opts.readFile;
  if (opts.stat) job.stat = opts.stat;
  if (opts.readlink) job.readlink = opts.readlink;
  if (opts.resolve) job.resolve = opts.resolve;

  job.ts = true;

  await Promise.all(
    files.map(async (file) => {
      const path = resolve(file);
      await job.emitFile(path, 'initial');
      return job.emitDependency(path);
    }),
  );

  const result: NodeFileTraceResult = {
    fileList: job.fileList,
    esmFileList: job.esmFileList,
    reasons: job.reasons,
    warnings: job.warnings,
  };
  return result;
}

export class Job {
  public ts: boolean;
  public base: string;
  public cwd: string;
  public conditions: string[];
  public exportsOnly: boolean;
  public paths: Record<string, string>;
  public ignoreFn: (path: string, parent?: string) => boolean;
  public log: boolean;
  public depth: number;
  public mixedModules: boolean;
  public analysis: {
    emitGlobs?: boolean;
    computeFileReferences?: boolean;
    evaluatePureExpressions?: boolean;
  };
  private analysisCache: Map<string, AnalyzeResult>;
  public fileList: Set<string>;
  public esmFileList: Set<string>;
  public processed: Set<string>;
  public warnings: Set<Error>;
  public reasons: NodeFileTraceReasons = new Map();
  private cachedFileSystem: CachedFileSystem;
  private remappings: Map<string, Set<string>> = new Map();

  constructor({
    base = process.cwd(),
    processCwd,
    exports,
    conditions = exports || ['node'],
    exportsOnly = false,
    paths = {},
    ignore,
    log = false,
    mixedModules = false,
    ts = true,
    analysis = {},
    cache,
    // we use a default of 1024 concurrency to balance
    // performance and memory usage for fs operations
    fileIOConcurrency = 1024,
    depth = Infinity,
  }: NodeFileTraceOptions) {
    this.ts = ts;
    base = resolve(base);
    this.ignoreFn = (path: string) => {
      if (path.startsWith('..' + sep)) return true;
      return false;
    };
    if (typeof ignore === 'string') ignore = [ignore];
    if (typeof ignore === 'function') {
      const ig = ignore;
      this.ignoreFn = (path: string) => {
        if (path.startsWith('..' + sep)) return true;
        if (ig(path)) return true;
        return false;
      };
    } else if (Array.isArray(ignore)) {
      const resolvedIgnores = ignore.map((ignore) =>
        relative(base, resolve(base || process.cwd(), ignore)),
      );
      this.ignoreFn = (path: string) => {
        if (path.startsWith('..' + sep)) return true;
        if (isMatch(path, resolvedIgnores)) return true;
        return false;
      };
    }
    this.base = base;
    this.cwd = resolve(processCwd || base);
    this.conditions = conditions;
    this.exportsOnly = exportsOnly;
    const resolvedPaths: Record<string, string> = {};
    for (const path of Object.keys(paths)) {
      const trailer = paths[path].endsWith('/');
      const resolvedPath = resolve(base, paths[path]);
      resolvedPaths[path] = resolvedPath + (trailer ? '/' : '');
    }
    this.paths = resolvedPaths;
    this.log = log;
    this.depth = depth;
    this.mixedModules = mixedModules;
    this.cachedFileSystem = new CachedFileSystem({ cache, fileIOConcurrency });
    this.analysis = {};
    if (analysis !== false) {
      Object.assign(
        this.analysis,
        {
          // whether to glob any analysis like __dirname + '/dir/' or require('x/' + y)
          // that might output any file in a directory
          emitGlobs: true,
          // whether __filename and __dirname style
          // expressions should be analyzed as file references
          computeFileReferences: true,
          // evaluate known bindings to assist with glob and file reference analysis
          evaluatePureExpressions: true,
        },
        analysis === true ? {} : analysis,
      );
    }

    this.analysisCache = (cache && cache.analysisCache) || new Map();

    if (cache) {
      cache.analysisCache = this.analysisCache;
    }

    this.fileList = new Set();
    this.esmFileList = new Set();
    this.processed = new Set();
    this.warnings = new Set();
  }

  addRemapping(path: string, dep: string) {
    if (path === dep) return;
    let deps = this.remappings.get(path);
    if (!deps) {
      deps = new Set();
      this.remappings.set(path, deps);
    }
    deps.add(dep);
  }

  async readlink(path: string) {
    return this.cachedFileSystem.readlink(path);
  }

  async isFile(path: string) {
    const stats = await this.stat(path);
    if (stats) return stats.isFile();
    return false;
  }

  async isDir(path: string) {
    const stats = await this.stat(path);
    if (stats) return stats.isDirectory();
    return false;
  }

  async stat(path: string) {
    return this.cachedFileSystem.stat(path);
  }

  private maybeEmitDep = async (
    dep: string,
    path: string,
    cjsResolve: boolean,
    depth: number,
  ) => {
    let resolved: string | string[] = '';
    let error: Error | undefined;
    try {
      resolved = await this.resolve(dep, path, this, cjsResolve);
    } catch (e1: any) {
      error = e1;
      try {
        if (this.ts && dep.endsWith('.js') && e1 instanceof NotFoundError) {
          // TS with ESM relative import paths need full extensions
          // (we have to write import "./foo.js" instead of import "./foo")
          // See https://www.typescriptlang.org/docs/handbook/esm-node.html
          const depTS = dep.slice(0, -3) + '.ts';
          resolved = await this.resolve(depTS, path, this, cjsResolve);
          error = undefined;
        }
      } catch (e2: any) {
        error = e2;
      }
    }

    if (error) {
      this.warnings.add(
        new Error(`Failed to resolve dependency "${dep}":\n${error?.message}`),
      );
      return;
    }

    if (Array.isArray(resolved)) {
      for (const item of resolved) {
        // ignore builtins
        if (item.startsWith('node:')) return;
        await this.emitDependency(item, path, depth);
      }
    } else {
      // ignore builtins
      if (resolved.startsWith('node:')) return;
      await this.emitDependency(resolved, path, depth);
    }
  };

  async resolve(
    id: string,
    parent: string,
    job: Job,
    cjsResolve: boolean,
  ): Promise<string | string[]> {
    return resolveDependency(id, parent, job, cjsResolve);
  }

  async readFile(path: string): Promise<Buffer | string | null> {
    return this.cachedFileSystem.readFile(path);
  }

  async realpath(
    path: string,
    parent?: string,
    seen = new Set(),
  ): Promise<string> {
    if (seen.has(path))
      throw new Error('Recursive symlink detected resolving ' + path);
    seen.add(path);
    const symlink = await this.readlink(path);
    // emit direct symlink paths only
    if (symlink) {
      const parentPath = dirname(path);
      const resolved = resolve(parentPath, symlink);
      const realParent = await this.realpath(parentPath, parent);
      if (inPath(path, realParent))
        await this.emitFile(path, 'resolve', parent, true);
      return this.realpath(resolved, parent, seen);
    }
    // keep backtracking for realpath, emitting folder symlinks within base
    if (!inPath(path, this.base)) return path;
    return join(
      await this.realpath(dirname(path), parent, seen),
      basename(path),
    );
  }

  async emitFile(
    path: string,
    reasonType: NodeFileTraceReasonType,
    parent?: string,
    isRealpath = false,
  ) {
    if (!isRealpath) {
      path = await this.realpath(path, parent);
    }
    path = relative(this.base, path);

    if (parent) {
      parent = relative(this.base, parent);
    }
    let reasonEntry = this.reasons.get(path);

    if (!reasonEntry) {
      reasonEntry = {
        type: [reasonType],
        ignored: false,
        parents: new Set(),
      };
      this.reasons.set(path, reasonEntry);
    } else if (!reasonEntry.type.includes(reasonType)) {
      reasonEntry.type.push(reasonType);
    }
    if (parent && this.ignoreFn(path, parent)) {
      if (!this.fileList.has(path) && reasonEntry) {
        reasonEntry.ignored = true;
      }
      return false;
    }
    if (parent) {
      reasonEntry.parents.add(parent);
    }
    this.fileList.add(path);
    return true;
  }

  async getPjsonBoundary(path: string) {
    const rootSeparatorIndex = path.indexOf(sep);
    let separatorIndex: number;
    while ((separatorIndex = path.lastIndexOf(sep)) > rootSeparatorIndex) {
      path = path.slice(0, separatorIndex);
      if (await this.isFile(path + sep + 'package.json')) return path;
    }
    return undefined;
  }

  async emitDependency(
    path: string,
    parent?: string,
    depth: number = this.depth,
  ) {
    if (depth < 0)
      throw new Error('invariant - depth option cannot be negative');

    // Resolve symlinks so that dependencies are resolved relative to the real
    // file location, not the symlink location
    const realPath = await this.realpath(path, parent);

    if (this.processed.has(realPath)) {
      if (parent) {
        await this.emitFile(path, 'dependency', parent);
      }
      return;
    }
    this.processed.add(realPath);

    // Additional dependencies.
    const additionalDeps = this.remappings.get(realPath);
    if (additionalDeps) {
      await Promise.all(
        [...additionalDeps].map(async (dep) =>
          this.emitDependency(dep, realPath, depth),
        ),
      );
    }

    const emitted = await this.emitFile(path, 'dependency', parent);
    if (!emitted) return;
    if (realPath.endsWith('.json')) return;
    if (realPath.endsWith('.node')) return await sharedLibEmit(realPath, this);

    // .js and .ts files can change behavior based on { "type": "module" }
    // in the nearest package.json so we must emit it too. We don't need to
    // emit for .cjs/.mjs/.cts/.mts files since their behavior does not
    // depend on package.json
    if (realPath.endsWith('.js') || realPath.endsWith('.ts')) {
      const pjsonBoundary = await this.getPjsonBoundary(realPath);
      if (pjsonBoundary)
        await this.emitFile(
          pjsonBoundary + sep + 'package.json',
          'resolve',
          realPath,
        );
    }
    if (depth === 0) return;

    let analyzeResult: AnalyzeResult;

    const cachedAnalysis = this.analysisCache.get(realPath);
    if (cachedAnalysis) {
      analyzeResult = cachedAnalysis;
    } else {
      const source = await this.readFile(realPath);
      if (source === null)
        throw new Error('File ' + realPath + ' does not exist.');
      // analyze should not have any side-effects e.g. calling `job.emitFile`
      // directly as this will not be included in the cachedAnalysis and won't
      // be emit for successive runs that leverage the cache
      analyzeResult = await analyze(realPath, source.toString(), this);
      this.analysisCache.set(realPath, analyzeResult);
    }

    const { deps, imports, assets, isESM } = analyzeResult;

    if (isESM) {
      this.esmFileList.add(relative(this.base, realPath));
    }

    await Promise.all([
      ...[...assets].map(async (asset) => {
        const ext = extname(asset);
        if (
          ext === '.js' ||
          ext === '.mjs' ||
          ext === '.node' ||
          ext === '' ||
          (this.ts &&
            (ext === '.ts' || ext === '.tsx') &&
            asset.startsWith(this.base) &&
            asset
              .slice(this.base.length)
              .indexOf(sep + 'node_modules' + sep) === -1)
        )
          await this.emitDependency(asset, realPath, depth - 1);
        else await this.emitFile(asset, 'asset', realPath);
      }),
      ...[...deps].map(async (dep) =>
        this.maybeEmitDep(dep, realPath, !isESM, depth - 1),
      ),
      ...[...imports].map(async (dep) =>
        this.maybeEmitDep(dep, realPath, false, depth - 1),
      ),
    ]);
  }
}
