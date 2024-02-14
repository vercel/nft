import type { Stats } from 'fs';
import { resolve } from 'path';
import fs from 'graceful-fs';
import { Sema } from 'async-sema';

const fsReadFile = fs.promises.readFile;
const fsReadlink = fs.promises.readlink;
const fsStat = fs.promises.stat;

export class CachedFileSystem {
  private fileCache: Map<string, Promise<string | null>>;
  private statCache: Map<string, Promise<Stats | null>>;
  private symlinkCache: Map<string, Promise<string | null>>;
  private fileIOQueue: Sema;

  constructor({
    cache,
    fileIOConcurrency,
  }: {
    cache?: {
      fileCache?: Map<string, Promise<string | null>>;
      statCache?: Map<string, Promise<Stats | null>>;
      symlinkCache?: Map<string, Promise<string | null>>;
    };
    fileIOConcurrency: number;
  }) {
    this.fileIOQueue = new Sema(fileIOConcurrency);
    this.fileCache = cache?.fileCache ?? new Map();
    this.statCache = cache?.statCache ?? new Map();
    this.symlinkCache = cache?.symlinkCache ?? new Map();

    if (cache) {
      cache.fileCache = this.fileCache;
      cache.statCache = this.statCache;
      cache.symlinkCache = this.symlinkCache;
    }
  }

  async readlink(path: string): Promise<string | null> {
    const cached = this.symlinkCache.get(path);
    if (cached !== undefined) return cached;
    // This is not awaiting the response, so that the cache is instantly populated and
    // future calls serve the Promise from the cache
    const readlinkPromise = this.executeFileIO(path, this._internalReadlink);
    this.symlinkCache.set(path, readlinkPromise);

    return readlinkPromise;
  }

  async readFile(path: string): Promise<string | null> {
    const cached = this.fileCache.get(path);
    if (cached !== undefined) return cached;
    // This is not awaiting the response, so that the cache is instantly populated and
    // future calls serve the Promise from the cache
    const readFilePromise = this.executeFileIO(path, this._internalReadFile);
    this.fileCache.set(path, readFilePromise);

    return readFilePromise;
  }

  async stat(path: string): Promise<Stats | null> {
    const cached = this.statCache.get(path);
    if (cached !== undefined) return cached;
    // This is not awaiting the response, so that the cache is instantly populated and
    // future calls serve the Promise from the cache
    const statPromise = this.executeFileIO(path, this._internalStat);
    this.statCache.set(path, statPromise);

    return statPromise;
  }

  private async _internalReadlink(path: string) {
    try {
      const link = await fsReadlink(path);
      // also copy stat cache to symlink
      const stats = this.statCache.get(path);
      if (stats) this.statCache.set(resolve(path, link), stats);
      return link;
    } catch (e: any) {
      if (e.code !== 'EINVAL' && e.code !== 'ENOENT' && e.code !== 'UNKNOWN')
        throw e;
      return null;
    }
  }

  private async _internalReadFile(path: string): Promise<string | null> {
    try {
      return (await fsReadFile(path)).toString();
    } catch (e: any) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') {
        return null;
      }
      throw e;
    }
  }

  private async _internalStat(path: string) {
    try {
      return await fsStat(path);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return null;
      }
      throw e;
    }
  }

  private async executeFileIO<Return>(
    path: string,
    fileIO: (path: string) => Promise<Return>,
  ): Promise<Return> {
    await this.fileIOQueue.acquire();

    try {
      return fileIO.call(this, path);
    } finally {
      this.fileIOQueue.release();
    }
  }
}
