'use strict';

// Converted from jest to Vitest.
//
// This suite drives `graceful-fs`'s `promises.readFile` by hand and asserts how
// `CachedFileSystem` serializes file IO when `fileIOConcurrency` is 1.
//
// jest routed every `require()` through its module registry, so a top-level
// `jest.mock('graceful-fs')` replaced the module even for the compiled CJS
// `../out/fs.js`. Under Vitest, `vi.mock('graceful-fs')` only reliably affects
// ESM importers; the inlined CJS `out/fs.js` captures its own (real) copy of
// `graceful-fs.promises.readFile` into a module-local `fsReadFile` binding at
// load time, so a `vi.mock` factory never observes the SUT's reads.
//
// To reproduce the original intent faithfully we instead `vi.spyOn` the real
// `graceful-fs.promises.readFile` BEFORE importing `out/fs.js`. Because
// `out/fs.js` does `const fsReadFile = graceful_fs_1.default.promises.readFile`
// at module-eval time, capturing the spy as that binding, the spy is exactly
// the function the SUT calls — which is what we assert on.
import gracefulFS from 'graceful-fs';

const { pendingReads } = vi.hoisted(() => ({ pendingReads: [] }));

// Install the spy before `out/fs.js` is evaluated so it captures the spy as its
// internal `fsReadFile` binding.
const readFileSpy = vi
  .spyOn(gracefulFS.promises, 'readFile')
  .mockImplementation(
    () =>
      new Promise((resolve) => {
        pendingReads.push(() => resolve(Buffer.from('content')));
      }),
  );

const { CachedFileSystem } = await import('../out/fs.js');

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

describe('CachedFileSystem concurrency limit', () => {
  beforeEach(() => {
    pendingReads.length = 0;
    readFileSpy.mockClear();
  });

  it('serializes file IO when fileIOConcurrency is 1', async () => {
    const fileSystem = new CachedFileSystem({ fileIOConcurrency: 1 });

    const a = fileSystem.readFile('/a.txt');
    const b = fileSystem.readFile('/b.txt');

    await flushMicrotasks();
    await flushMicrotasks();

    expect(readFileSpy).toHaveBeenCalledTimes(1);

    pendingReads[0]();
    await a;
    await flushMicrotasks();

    expect(readFileSpy).toHaveBeenCalledTimes(2);

    pendingReads[1]();
    await b;
  });
});
