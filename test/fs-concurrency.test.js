'use strict';

const pendingReads = [];

jest.mock('graceful-fs', () => {
  const original = jest.requireActual('graceful-fs');
  return {
    ...original,
    promises: {
      ...original.promises,
      readFile: jest.fn(
        () =>
          new Promise((resolve) => {
            pendingReads.push(() => resolve(Buffer.from('content')));
          }),
      ),
    },
  };
});

const gracefulFS = require('graceful-fs');
const { CachedFileSystem } = require('../out/fs');

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

describe('CachedFileSystem concurrency limit', () => {
  beforeEach(() => {
    pendingReads.length = 0;
    gracefulFS.promises.readFile.mockClear();
  });

  it('serializes file IO when fileIOConcurrency is 1', async () => {
    const fileSystem = new CachedFileSystem({ fileIOConcurrency: 1 });

    const a = fileSystem.readFile('/a.txt');
    const b = fileSystem.readFile('/b.txt');

    await flushMicrotasks();
    await flushMicrotasks();

    expect(gracefulFS.promises.readFile).toHaveBeenCalledTimes(1);

    pendingReads[0]();
    await a;
    await flushMicrotasks();

    expect(gracefulFS.promises.readFile).toHaveBeenCalledTimes(2);

    pendingReads[1]();
    await b;
  });
});
