import { NodeFileTraceOptions, NodeFileTraceResult, NodeFileTraceReasons, Stats } from './types';
import { basename, dirname, extname, relative, resolve, sep } from 'path';
import fs from 'fs';
import analyze, { AnalyzeResult } from './analyze';
import resolveDependency from './resolve-dependency';
import { isMatch } from 'micromatch';
import { sharedLibEmit } from './utils/sharedlib-emit';

const { gracefulify } = require('graceful-fs');
gracefulify(fs);

function inPath (path: string, parent: string) {
  return path.startsWith(parent) && path[parent.length] === sep;
}

export async function nodeFileTrace(files: string[], opts: NodeFileTraceOptions = {}): Promise<NodeFileTraceResult> {
  const job = new Job(opts);

  if (opts.readFile)
    job.readFile = opts.readFile;
  if (opts.stat)
    job.stat = opts.stat;
  if (opts.readlink)
    job.readlink = opts.readlink;

  job.ts = true;

  await Promise.all(files.map(file => {
    const path = resolve(file);
    job.emitFile(job.realpath(path), 'initial');
    if (path.endsWith('.js') || path.endsWith('.cjs') || path.endsWith('.mjs') || path.endsWith('.node') || job.ts && (path.endsWith('.ts') || path.endsWith('.tsx'))) {
      return job.emitDependency(path);
    }
    return undefined;
  }));

  const result: NodeFileTraceResult = {
    fileList: [...job.fileList].sort(),
    esmFileList: [...job.esmFileList].sort(),
    reasons: job.reasons,
    warnings: [...job.warnings]
  };
  return result;
};

export class Job {
  public ts: boolean;
  public base: string;
  public cwd: string;
  public exports: string[];
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
  public reasons: NodeFileTraceReasons = Object.create(null);
  
  constructor ({
    base = process.cwd(),
    processCwd,
    exports = ['node'],
    exportsOnly = false,
    paths = {},
    ignore,
    log = false,
    mixedModules = false,
    ts = true,
    analysis = {},
    cache,
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
    this.exports = exports;
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

  readlink (path: string) {
    const cached = this.symlinkCache.get(path);
    if (cached !== undefined) return cached;
    try {
      const link = fs.readlinkSync(path);
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
  }

  isFile (path: string) {
    const stats = this.stat(path);
    if (stats)
      return stats.isFile();
    return false;
  }

  isDir (path: string) {
    const stats = this.stat(path);
    if (stats)
      return stats.isDirectory();
    return false;
  }

  stat (path: string) {
    const cached = this.statCache.get(path);
    if (cached) return cached;
    try {
      const stats = fs.statSync(path);
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
  }

  readFile (path: string): string | Buffer | null {
    const cached = this.fileCache.get(path);
    if (cached !== undefined) return cached;
    try {
      const source = fs.readFileSync(path).toString();
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
  }

  realpath (path: string, parent?: string, seen = new Set()): string {
    if (seen.has(path)) throw new Error('Recursive symlink detected resolving ' + path);
    seen.add(path);
    const symlink = this.readlink(path);
    // emit direct symlink paths only
    if (symlink) {
      const parentPath = dirname(path);
      const resolved = resolve(parentPath, symlink);
      const realParent = this.realpath(parentPath, parent);
      if (inPath(path, realParent))
        this.emitFile(path, 'resolve', parent);
      return this.realpath(resolved, parent, seen);
    }
    // keep backtracking for realpath, emitting folder symlinks within base
    if (!inPath(path, this.base))
      return path;
    return this.realpath(dirname(path), parent, seen) + sep + basename(path);
  }

  emitFile (path: string, reason: string, parent?: string) {
    if (this.fileList.has(path)) return;
    path = relative(this.base, path);
    if (parent)
      parent = relative(this.base, parent);
    const reasonEntry = this.reasons[path] || (this.reasons[path] = {
      type: reason,
      ignored: false,
      parents: []
    });
    if (parent && reasonEntry.parents.indexOf(parent) === -1)
      reasonEntry.parents.push(parent);
    if (parent && this.ignoreFn(path, parent)) {
      if (reasonEntry) reasonEntry.ignored = true;
      return false;
    }
    this.fileList.add(path);
    return true;
  }

  getPjsonBoundary (path: string) {
    const rootSeparatorIndex = path.indexOf(sep);
    let separatorIndex: number;
    while ((separatorIndex = path.lastIndexOf(sep)) > rootSeparatorIndex) {
      path = path.substr(0, separatorIndex);
      if (this.isFile(path + sep + 'package.json'))
        return path;
    }
    return undefined;
  }

  async emitDependency (path: string, parent?: string) {
    if (this.processed.has(path)) return;
    this.processed.add(path);

    const emitted = this.emitFile(path, 'dependency', parent);
    if (!emitted) return;
    if (path.endsWith('.json')) return;
    if (path.endsWith('.node')) return await sharedLibEmit(path, this);

    // js files require the "type": "module" lookup, so always emit the package.json
    if (path.endsWith('.js')) {
      const pjsonBoundary = this.getPjsonBoundary(path);
      if (pjsonBoundary)
        this.emitFile(pjsonBoundary + sep + 'package.json', 'resolve', path);
    }

    let analyzeResult: AnalyzeResult;

    const cachedAnalysis = this.analysisCache.get(path);
    if (cachedAnalysis) {
      analyzeResult = cachedAnalysis;
    }
    else {
      const source = this.readFile(path);
      if (source === null) throw new Error('File ' + path + ' does not exist.');
      analyzeResult = await analyze(path, source.toString(), this);
      this.analysisCache.set(path, analyzeResult);
    }

    const { deps, imports, assets, isESM } = analyzeResult;

    if (isESM)
      this.esmFileList.add(relative(this.base, path));
    
    await Promise.all([
      ...[...assets].map(async asset => {
        const ext = extname(asset);
        if (ext === '.js' || ext === '.mjs' || ext === '.node' || ext === '' ||
            this.ts && (ext === '.ts' || ext === '.tsx') && asset.startsWith(this.base) && asset.substr(this.base.length).indexOf(sep + 'node_modules' + sep) === -1)
          await this.emitDependency(asset, path);
        else
          this.emitFile(this.realpath(asset, path), 'asset', path);
      }),
      ...[...deps].map(async dep => {
        try {
          var resolved = resolveDependency(dep, path, this, !isESM);
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
          var resolved = resolveDependency(dep, path, this, false);
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
