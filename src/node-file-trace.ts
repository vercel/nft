import { NodeFileTraceOptions, NodeFileTraceResult, NodeFileTraceReasons, Stats, NodeFileTraceReasonType } from './types';
import { basename, dirname, relative, resolve, sep } from 'path';
import fs from 'graceful-fs';
import analyze, { AnalyzeResult } from './analyze';
import resolveDependency from './resolve-dependency';
import { isMatch } from 'micromatch';
import { sharedLibEmit } from './utils/sharedlib-emit';
import { join } from 'path';
import { Sema } from 'async-sema';

const fsReadFile = fs.promises.readFile;
const fsReadlink = fs.promises.readlink;
const fsStat = fs.promises.stat;

function inPath (path: string, parent: string) {
  const pathWithSep = join(parent, sep);
  return path.startsWith(pathWithSep) && path !== pathWithSep;
}

export async function nodeFileTrace(files: string[], opts: NodeFileTraceOptions = {}): Promise<NodeFileTraceResult> {
  const job = new Job(opts);

  if (opts.readFile)
    job.readFile = opts.readFile
  if (opts.stat)
    job.stat = opts.stat
  if (opts.readlink)
    job.readlink = opts.readlink
  if (opts.resolve)
    job.resolve = opts.resolve

  job.ts = true;

  await Promise.all(files.map(async file => {
    const path = resolve(file);
    await job.emitFile(path, 'initial');
    return job.emitDependency(path);
  }));

  const result: NodeFileTraceResult = {
    fileList: job.fileList,
    esmFileList: job.esmFileList,
    reasons: job.reasons,
    warnings: job.warnings
  };
  return result;
};

export class Job {
  public ts: boolean;
  public base: string;
  public cwd: string;
  public conditions: string[];
  public exportsOnly: boolean;
  public paths: Record<string, string>;
  public ignoreFn: (path: string, parent?: string) => boolean;
  public log: boolean;
  public mixedModules: boolean;
  public analysis: { emitGlobs?: boolean, computeFileReferences?: boolean, evaluatePureExpressions?: boolean };
  private fileCache: Map<string, string | null>;
  private statCache: Map<string, Stats | null>;
  private symlinkCache: Map<string, string | null>;
  private analysisCache: Map<string, AnalyzeResult>;
  public fileList: Set<string>;
  public esmFileList: Set<string>;
  public processed: Set<string>;
  public warnings: Set<Error>;
  public reasons: NodeFileTraceReasons = new Map()
  private fileIOQueue: Sema;

  constructor ({
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
    }
    else if (Array.isArray(ignore)) {
      const resolvedIgnores = ignore.map(ignore => relative(base, resolve(base || process.cwd(), ignore)));
      this.ignoreFn = (path: string) => {
        if (path.startsWith('..' + sep)) return true;
        if (isMatch(path, resolvedIgnores)) return true;
        return false;
      }
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
    this.mixedModules = mixedModules;
    this.fileIOQueue = new Sema(fileIOConcurrency);

    this.analysis = {};
    if (analysis !== false) {
      Object.assign(this.analysis, {
        // whether to glob any analysis like __dirname + '/dir/' or require('x/' + y)
        // that might output any file in a directory
        emitGlobs: true,
        // whether __filename and __dirname style
        // expressions should be analyzed as file references
        computeFileReferences: true,
        // evaluate known bindings to assist with glob and file reference analysis
        evaluatePureExpressions: true,
      }, analysis === true ? {} : analysis);
    }

    this.fileCache = cache && cache.fileCache || new Map();
    this.statCache = cache && cache.statCache || new Map();
    this.symlinkCache = cache && cache.symlinkCache || new Map();
    this.analysisCache = cache && cache.analysisCache || new Map();

    if (cache) {
      cache.fileCache = this.fileCache;
      cache.statCache = this.statCache;
      cache.symlinkCache = this.symlinkCache;
      cache.analysisCache = this.analysisCache;
    }

    this.fileList = new Set();
    this.esmFileList = new Set();
    this.processed = new Set();
    this.warnings = new Set();
  }

  async readlink (path: string) {
    const cached = this.symlinkCache.get(path);
    if (cached !== undefined) return cached;
    await this.fileIOQueue.acquire();
    try {
      const link = await fsReadlink(path);
      // also copy stat cache to symlink
      const stats = this.statCache.get(path);
      if (stats)
        this.statCache.set(resolve(path, link), stats);
      this.symlinkCache.set(path, link);
      return link;
    }
    catch (e) {
      if (e.code !== 'EINVAL' && e.code !== 'ENOENT' && e.code !== 'UNKNOWN')
        throw e;
      this.symlinkCache.set(path, null);
      return null;
    }
    finally {
      this.fileIOQueue.release();
    }
  }

  async isFile (path: string) {
    const stats = await this.stat(path);
    if (stats)
      return stats.isFile();
    return false;
  }

  async isDir (path: string) {
    const stats = await this.stat(path);
    if (stats)
      return stats.isDirectory();
    return false;
  }

  async stat (path: string) {
    const cached = this.statCache.get(path);
    if (cached) return cached;
    await this.fileIOQueue.acquire();
    try {
      const stats = await fsStat(path);
      this.statCache.set(path, stats);
      return stats;
    }
    catch (e) {
      if (e.code === 'ENOENT') {
        this.statCache.set(path, null);
        return null;
      }
      throw e;
    }
    finally {
      this.fileIOQueue.release();
    }
  }

  async resolve (id: string, parent: string, job: Job, cjsResolve: boolean): Promise<string | string[]> {
    return resolveDependency(id, parent, job, cjsResolve);
  }

  async readFile (path: string): Promise<string | Buffer | null> {
    const cached = this.fileCache.get(path);
    if (cached !== undefined) return cached;
    await this.fileIOQueue.acquire();
    try {
      const source = (await fsReadFile(path)).toString();
      this.fileCache.set(path, source);
      return source;
    }
    catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') {
        this.fileCache.set(path, null);
        return null;
      }
      throw e;
    }
    finally {
      this.fileIOQueue.release();
    }
  }

  async realpath (path: string, parent?: string, seen = new Set()): Promise<string> {
    if (seen.has(path)) throw new Error('Recursive symlink detected resolving ' + path);
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
    if (!inPath(path, this.base))
      return path;
    return join(await this.realpath(dirname(path), parent, seen), basename(path));
  }

  async emitFile (path: string, reasonType: NodeFileTraceReasonType, parent?: string, isRealpath = false) {
    if (!isRealpath) {
      path = await this.realpath(path, parent);
    }
    path = relative(this.base, path);
    
    if (parent) {
      parent = relative(this.base, parent);
    }
    let reasonEntry = this.reasons.get(path)
    
    if (!reasonEntry) {
      reasonEntry = {
        type: [reasonType],
        ignored: false,
        parents: new Set()
      };
      this.reasons.set(path, reasonEntry)
    } else if (!reasonEntry.type.includes(reasonType)) {
      reasonEntry.type.push(reasonType)
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

  async getPjsonBoundary (path: string) {
    const rootSeparatorIndex = path.indexOf(sep);
    let separatorIndex: number;
    while ((separatorIndex = path.lastIndexOf(sep)) > rootSeparatorIndex) {
      path = path.slice(0, separatorIndex);
      if (await this.isFile(path + sep + 'package.json'))
        return path;
    }
    return undefined;
  }

  async emitDependency (path: string, parent?: string) {
    if (this.processed.has(path)) {
      if (parent) {
        await this.emitFile(path, 'dependency', parent)
      }
      return
    };
    this.processed.add(path);

    const emitted = await this.emitFile(path, 'dependency', parent);
    if (!emitted) return;
    if (path.endsWith('.json')) return;
    if (path.endsWith('.node')) return await sharedLibEmit(path, this);

    const handlePjsonBoundary = async (item: string) => {
      // js files require the "type": "module" lookup, so always emit the package.json
      if (item.endsWith(".js")) {
        const pjsonBoundary = await this.getPjsonBoundary(item);
        if (pjsonBoundary)
          await this.emitFile(
            pjsonBoundary + sep + "package.json",
            "resolve",
            item
          );
      }
    };
    await handlePjsonBoundary(path);

    let analyzeResult: AnalyzeResult;

    const cachedAnalysis = this.analysisCache.get(path);
    if (cachedAnalysis) {
      analyzeResult = cachedAnalysis;
    }
    else {
      const source = await this.readFile(path);
      if (source === null) throw new Error('File ' + path + ' does not exist.');
      analyzeResult = await analyze(path, source.toString(), this);
      this.analysisCache.set(path, analyzeResult);
    }

    const { deps, imports, assets, isESM } = analyzeResult;

    if (isESM)
      this.esmFileList.add(relative(this.base, path));
    
    await Promise.all([
      ...[...assets].map(async asset => {
        await handlePjsonBoundary(asset)
        await this.emitFile(asset, 'asset', path);
      }),
      ...[...deps].map(async dep => {
        try {
          var resolved = await this.resolve(dep, path, this, !isESM);
        }
        catch (e) {
          this.warnings.add(new Error(`Failed to resolve dependency ${dep}:\n${e && e.message}`));
          return;
        }
        if (Array.isArray(resolved)) {
          for (const item of resolved) {
            // ignore builtins
            if (item.startsWith('node:')) return;
            await this.emitDependency(item, path);
          }
        }
        else {
          // ignore builtins
          if (resolved.startsWith('node:')) return;
          await this.emitDependency(resolved, path);
        }
      }),
      ...[...imports].map(async dep => {
        try {
          var resolved = await this.resolve(dep, path, this, false);
        }
        catch (e) {
          this.warnings.add(new Error(`Failed to resolve dependency ${dep}:\n${e && e.message}`));
          return;
        }
        if (Array.isArray(resolved)) {
          for (const item of resolved) {
            // ignore builtins
            if (item.startsWith('node:')) return;
            await this.emitDependency(item, path);
          }
        }
        else {
          // ignore builtins
          if (resolved.startsWith('node:')) return;
          await this.emitDependency(resolved, path);
        }
      })
    ]);
  }
}