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

  const trace = () => nodeFileTrace([join(base, 'index.js')], { base });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('should emit an extensionless socket as a plain asset', async () => {
    await listen(join(base, 'profile', 'sock'));

    const { fileList, reasons, warnings } = await trace();

    expect([...fileList].sort()).toEqual(['index.js', 'profile/sock']);
    expect(reasons.get('profile/sock').type).toEqual(['asset']);
    expect([...warnings]).toEqual([]);
  });

  it('should emit a symlink to an extensionless socket', async () => {
    await listen(join(base, 'sock'));
    fs.symlinkSync(join(base, 'sock'), join(base, 'profile', 'link'));
    expect(fs.lstatSync(join(base, 'sock')).isSocket()).toBe(true);

    const { fileList, reasons, warnings } = await trace();

    expect([...fileList].sort()).toEqual(['index.js', 'profile/link', 'sock']);
    expect(reasons.get('sock').type).toEqual(['asset']);
    expect([...warnings]).toEqual([]);
  });

  it('should emit a dangling extensionless symlink', async () => {
    fs.symlinkSync('missing', join(base, 'profile', 'link'));

    const { fileList, warnings } = await trace();

    expect([...fileList].sort()).toEqual([
      'index.js',
      'profile/link',
      'profile/missing',
    ]);
    expect([...warnings]).toEqual([]);
  });

  it('should analyze an extensionless regular file', async () => {
    fs.writeFileSync(join(base, 'profile', 'tool'), `require('../dep.js');`);
    fs.writeFileSync(join(base, 'dep.js'), '');

    const { fileList, reasons } = await trace();

    expect([...fileList].sort()).toEqual([
      'dep.js',
      'index.js',
      'profile/tool',
    ]);
    expect(reasons.get('profile/tool').type).toEqual(['dependency']);
    expect(reasons.get('dep.js').type).toEqual(['dependency']);
  });

  it('should analyze a file behind a relative extensionless symlink', async () => {
    fs.mkdirSync(join(base, 'profile', 'links'));
    fs.writeFileSync(join(base, 'tool'), '');
    fs.symlinkSync('../../tool', join(base, 'profile', 'links', 'link'));
    // the wrong resolution of the symlink above, read after it was processed
    fs.appendFileSync(join(base, 'index.js'), `\nrequire('./a.js');`);
    fs.writeFileSync(join(base, 'a.js'), `require('./b.js');`);
    fs.writeFileSync(
      join(base, 'b.js'),
      `try { require('./profile/tool'); } catch {}`,
    );

    const { fileList } = await trace();

    expect([...fileList].sort()).toEqual([
      'a.js',
      'b.js',
      'index.js',
      'profile/links/link',
      'tool',
    ]);
  });

  it('should analyze a file behind more symlinks than stat follows', async () => {
    fs.mkdirSync(join(base, 'chain'));
    fs.writeFileSync(join(base, 'chain', 'tool'), `require('../dep.js');`);
    fs.writeFileSync(join(base, 'dep.js'), '');
    fs.symlinkSync('tool', join(base, 'chain', 'link-0'));
    for (let i = 1; i < 50; i++) {
      fs.symlinkSync(`link-${i - 1}`, join(base, 'chain', `link-${i}`));
    }
    fs.symlinkSync('../chain/link-49', join(base, 'profile', 'link'));

    const { fileList, reasons } = await trace();

    expect(fileList.has('chain/tool')).toBe(true);
    expect(reasons.get('dep.js').type).toEqual(['dependency']);
  });
});
