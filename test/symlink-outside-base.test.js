const fs = require('fs');
const os = require('os');
const path = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');

// File symlinks need elevated privileges or the Developer Mode on Windows.
function canSymlinkFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-probe-'));
  try {
    fs.symlinkSync('target', path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const itWithFileSymlinks = canSymlinkFiles() ? it : it.skip;
const itOnWindows = process.platform === 'win32' ? it : it.skip;

const pkgJson = (name) =>
  JSON.stringify({ name, type: 'module', exports: { './*': './dist/*.js' } });

describe('symlinks that lead outside the base', () => {
  let root;
  let base;

  // The symlinks are created at runtime, because a fixture cannot point
  // outside the repository.
  beforeAll(async () => {
    root = await fs.promises.mkdtemp(
      path.join(await fs.promises.realpath(os.tmpdir()), 'nft-outside-'),
    );
    base = path.join(root, 'project');
    const outside = path.join(root, 'outside');

    await fs.promises.mkdir(path.join(outside, 'linked', 'dist'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(outside, 'linked', 'package.json'),
      pkgJson('linked'),
    );
    await fs.promises.mkdir(path.join(base, 'packages', 'inside', 'dist'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(base, 'packages', 'inside', 'package.json'),
      pkgJson('inside'),
    );
    for (const file of [
      path.join(outside, 'linked', 'dist', 'sub.js'),
      path.join(outside, 'secret.js'),
      path.join(base, 'packages', 'inside', 'dist', 'sub.js'),
      path.join(base, 'local.js'),
    ]) {
      await fs.promises.writeFile(file, 'export const value = 1;\n');
    }

    await fs.promises.mkdir(path.join(base, 'node_modules', 'pkg', 'dist'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(base, 'node_modules', 'pkg', 'package.json'),
      pkgJson('pkg'),
    );
    await fs.promises.writeFile(
      path.join(base, 'inside.mjs'),
      "import 'inside/sub';\n",
    );
    await fs.promises.writeFile(
      path.join(base, 'dir.mjs'),
      "import 'linked/sub';\n",
    );
    await fs.promises.writeFile(
      path.join(base, 'file.mjs'),
      "import 'pkg/secret';\n",
    );
    await fs.promises.writeFile(
      path.join(base, 'parent.mjs'),
      "import 'parent/outside/secret.js';\n",
    );
    await fs.promises.writeFile(
      path.join(base, 'drive.mjs'),
      "import 'pkg/remote';\n",
    );
    await fs.promises.writeFile(
      path.join(base, 'local.mjs'),
      "import 'pkg/local';\n",
    );
  });

  afterAll(async () => {
    if (root) await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function trace(input, traceBase = base) {
    const { fileList } = await nodeFileTrace([path.join(traceBase, input)], {
      base: traceBase,
      processCwd: traceBase,
    });
    return [...fileList].map((file) => file.split(path.sep).join('/')).sort();
  }

  it('does not emit a directory symlink', async () => {
    // 'junction' so that no elevated privileges are needed on Windows.
    await fs.promises.symlink(
      path.join(root, 'outside', 'linked'),
      path.join(base, 'node_modules', 'linked'),
      'junction',
    );

    expect(await trace('dir.mjs')).toEqual(['dir.mjs']);
  });

  itWithFileSymlinks('does not emit a file symlink', async () => {
    await fs.promises.symlink(
      path.join(root, 'outside', 'secret.js'),
      path.join(base, 'node_modules', 'pkg', 'dist', 'secret.js'),
      'file',
    );

    expect(await trace('file.mjs')).toEqual([
      'file.mjs',
      'node_modules/pkg/package.json',
    ]);
  });

  it('does not emit a symlink to the parent of the base', async () => {
    await fs.promises.symlink(
      root,
      path.join(base, 'node_modules', 'parent'),
      'junction',
    );

    expect(await trace('parent.mjs')).toEqual(['parent.mjs']);
  });

  // A second drive cannot be assumed, so the tracer is told that a real file
  // is a symlink to a drive that does not exist.
  itOnWindows('does not emit a symlink to another drive', async () => {
    const drive = [...'ZYXWVUTSRQPONMLKJIHGFED'].find(
      (letter) => !fs.existsSync(letter + ':' + path.sep),
    );
    const link = path.join(base, 'node_modules', 'pkg', 'dist', 'remote.js');
    const target = drive + ':' + path.sep + 'remote.js';
    await fs.promises.writeFile(link, 'export const value = 1;\n');

    const { fileList } = await nodeFileTrace([path.join(base, 'drive.mjs')], {
      base,
      processCwd: base,
      readlink(file) {
        if (file === link) return target;
        return this.constructor.prototype.readlink.call(this, file);
      },
      readFile(file) {
        if (file === target) return 'export const value = 1;\n';
        return this.constructor.prototype.readFile.call(this, file);
      },
    });
    const files = [...fileList].map((f) => f.split(path.sep).join('/'));

    expect(files).toContain('drive.mjs');
    expect(files).not.toContain('node_modules/pkg/dist/remote.js');
  });

  itWithFileSymlinks(
    'emits a file symlink that stays inside the base',
    async () => {
      await fs.promises.symlink(
        path.join(base, 'local.js'),
        path.join(base, 'node_modules', 'pkg', 'dist', 'local.js'),
        'file',
      );

      expect(await trace('local.mjs')).toEqual([
        'local.js',
        'local.mjs',
        'node_modules/pkg/dist/local.js',
        'node_modules/pkg/package.json',
      ]);
    },
  );

  // The drive letter of a working directory and of a stored junction target
  // often differ in case.
  itOnWindows(
    'emits a symlink into a base spelled in another case',
    async () => {
      await fs.promises.symlink(
        path.join(base, 'packages', 'inside'),
        path.join(base, 'node_modules', 'inside'),
        'junction',
      );
      const drive = base[0];
      const otherCase =
        (drive === drive.toUpperCase()
          ? drive.toLowerCase()
          : drive.toUpperCase()) + base.slice(1);

      expect(await trace('inside.mjs', otherCase)).toEqual([
        'inside.mjs',
        'node_modules/inside',
        'packages/inside/dist/sub.js',
        'packages/inside/package.json',
      ]);
    },
  );
});
