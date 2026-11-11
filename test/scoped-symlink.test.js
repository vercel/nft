const fs = require('fs');
const os = require('os');
const path = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');

// The symlinks are created at runtime rather than committed as fixtures,
// because a Windows checkout does not necessarily materialize them.
async function setupWorkspace() {
  const base = await fs.promises.mkdtemp(
    path.join(await fs.promises.realpath(os.tmpdir()), 'nft-scoped-'),
  );

  for (const [dir, name] of [
    ['scoped-pkg', '@scope/pkg'],
    ['unscoped-pkg', 'unscoped'],
  ]) {
    await fs.promises.mkdir(path.join(base, dir, 'dist'), { recursive: true });
    await fs.promises.writeFile(
      path.join(base, dir, 'package.json'),
      JSON.stringify({
        name,
        type: 'module',
        exports: { './*': './dist/*.js' },
      }),
    );
    await fs.promises.writeFile(
      path.join(base, dir, 'dist', 'sub.js'),
      'export const value = 1;\n',
    );
  }

  await fs.promises.mkdir(path.join(base, 'node_modules', '@scope'), {
    recursive: true,
  });
  // 'junction' so that no elevated privileges are needed on Windows.
  await fs.promises.symlink(
    path.join(base, 'scoped-pkg'),
    path.join(base, 'node_modules', '@scope', 'pkg'),
    'junction',
  );
  await fs.promises.symlink(
    path.join(base, 'unscoped-pkg'),
    path.join(base, 'node_modules', 'unscoped'),
    'junction',
  );

  await fs.promises.writeFile(
    path.join(base, 'input.mjs'),
    "import '@scope/pkg/sub';\nimport 'unscoped/sub';\n",
  );

  return base;
}

describe('symlinked packages in node_modules', () => {
  let base;

  beforeAll(async () => {
    base = await setupWorkspace();
  });

  afterAll(async () => {
    if (base) await fs.promises.rm(base, { recursive: true, force: true });
  });

  it('emits the symlink for scoped and unscoped packages', async () => {
    const { fileList } = await nodeFileTrace([path.join(base, 'input.mjs')], {
      base,
      processCwd: base,
    });
    const files = [...fileList].map((file) => file.split(path.sep).join('/'));

    expect(files).toContain('node_modules/@scope/pkg');
    expect(files).toContain('node_modules/unscoped');
    expect(files).toContain('scoped-pkg/dist/sub.js');
    expect(files).toContain('unscoped-pkg/dist/sub.js');
  });
});
