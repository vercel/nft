import type { Sema } from "async-sema";

async function fileIOExecutor <Return>(path: string, fileIOQueue: Sema, fileIO: (path: string) => Promise<Return>): Promise<Return> {
    await fileIOQueue.acquire();
    try {
      return fileIO(path);
    }
    finally {
      fileIOQueue.release();
    }
}

export function cacheFileIOFactory <Return>(
  fileIO: (path: string) => Promise<Return>,
  cache: Map<string, Promise<Return>>,
  fileIOQueue: Sema
) {
  return async (path: string) => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    // This is not awaiting the response, so that the cache is instantly populated and
    // future calls serve the Promise from the cache
    const fileIOPromise = fileIOExecutor<Return>(path, fileIOQueue, fileIO)
    cache.set(path, fileIOPromise);

    return fileIOPromise;
  }
}
