const fs = require('fs');
const net = require('net');
const os = require('os');
const { join } = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');

const describeOnUnix = process.platform === 'win32' ? describe.skip : describe;

describeOnUnix('non-regular files', () => {
  let base;
  let server;

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'nft-')));
    fs.mkdirSync(join(base, 'profile'));
    fs.writeFileSync(
      join(base, 'index.js'),
      `const fs = require('fs');
      const path = require('path');
      fs.readdirSync(path.join(__dirname, 'profile'));`,
    );
    server = net.createServer();
  });

  const listen = (path) =>
    new Promise((resolve) => server.listen(path, resolve));

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('should emit an extensionless socket as a plain asset', async () => {
    await listen(join(base, 'profile', 'sock'));

    const { fileList, warnings } = await nodeFileTrace(
      [join(base, 'index.js')],
      { base },
    );

    expect([...fileList].sort()).toEqual(['index.js', 'profile/sock']);
    expect([...warnings]).toEqual([]);
  });

  it('should emit a symlink to an extensionless socket', async () => {
    await listen(join(base, 'sock'));
    fs.symlinkSync(join(base, 'sock'), join(base, 'profile', 'link'));

    const { fileList, warnings } = await nodeFileTrace(
      [join(base, 'index.js')],
      { base },
    );

    expect([...fileList].sort()).toEqual(['index.js', 'profile/link', 'sock']);
    expect([...warnings]).toEqual([]);
  });
});
