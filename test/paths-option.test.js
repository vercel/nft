const fs = require('fs');
const os = require('os');
const path = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');

describe('paths option with a trailing slash', () => {
  let base;

  beforeAll(async () => {
    base = await fs.promises.mkdtemp(
      path.join(await fs.promises.realpath(os.tmpdir()), 'nft-paths-'),
    );
    await fs.promises.mkdir(path.join(base, 'lib', 'dir'), { recursive: true });
    for (const file of ['dir/index.js', 'dir.js']) {
      await fs.promises.writeFile(
        path.join(base, 'lib', file),
        'module.exports = 1;\n',
      );
    }
    await fs.promises.writeFile(
      path.join(base, 'folder.js'),
      "require('dep/dir/');\n",
    );
    await fs.promises.mkdir(path.join(base, 'lib', 'real'));
    await fs.promises.writeFile(
      path.join(base, 'lib', 'real', 'x.js'),
      'module.exports = 1;\n',
    );
    // 'junction' so that no elevated privileges are needed on Windows.
    await fs.promises.symlink(
      path.join(base, 'lib', 'real'),
      path.join(base, 'lib', 'sub'),
      'junction',
    );
    await fs.promises.writeFile(
      path.join(base, 'link.js'),
      "require('dep/sub/x.js');\n",
    );
  });

  afterAll(async () => {
    if (base) await fs.promises.rm(base, { recursive: true, force: true });
  });

  async function trace(input) {
    const { fileList } = await nodeFileTrace([path.join(base, input)], {
      base,
      processCwd: base,
      paths: { 'dep/': path.join(base, 'lib') + '/' },
    });
    return [...fileList].map((file) => file.split(path.sep).join('/')).sort();
  }

  it('resolves a specifier with a trailing slash as a directory', async () => {
    expect(await trace('folder.js')).toEqual(['folder.js', 'lib/dir/index.js']);
  });

  it('emits a symlink below the target', async () => {
    expect(await trace('link.js')).toEqual([
      'lib/real/x.js',
      'lib/sub',
      'link.js',
    ]);
  });
});
