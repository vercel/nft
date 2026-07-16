import * as nativeFs from 'fs';

function createMockStats() {
  return {
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

export const fsIgnoreEnoent = {
  ...nativeFs,
  statSync: (path: any, ...args: any[]) => {
    try {
      return nativeFs.statSync(path, ...args as any);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return createMockStats() as any;
      }
      throw err;
    }
  },
  lstatSync: (path: any, ...args: any[]) => {
    try {
      return nativeFs.lstatSync(path, ...args as any);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return createMockStats() as any;
      }
      throw err;
    }
  },
  stat: (path: any, ...args: any[]) => {
    const cb = args.pop();
    nativeFs.stat(path, ...args, (err, stats) => {
      if (err && err.code === 'ENOENT') {
        return cb(null, createMockStats());
      }
      cb(err, stats);
    });
  },
  lstat: (path: any, ...args: any[]) => {
    const cb = args.pop();
    nativeFs.lstat(path, ...args, (err, stats) => {
      if (err && err.code === 'ENOENT') {
        return cb(null, createMockStats());
      }
      cb(err, stats);
    });
  },
  promises: {
    ...nativeFs.promises,
    stat: async (path: any, opts?: any) => {
      try {
        return await nativeFs.promises.stat(path, opts);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return createMockStats() as any;
        }
        throw err;
      }
    },
    lstat: async (path: any, opts?: any) => {
      try {
        return await nativeFs.promises.lstat(path, opts);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return createMockStats() as any;
        }
        throw err;
      }
    },
  },
};
