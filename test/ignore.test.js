const fs = require('fs');
const os = require('os');
const path = require('path');
const { nodeFileTrace } = require('../out/node-file-trace');

describe('ignore patterns', () => {
  let base;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-ignore-'));
    fs.mkdirSync(path.join(base, 'ignored'));
    fs.writeFileSync(path.join(base, 'package.json'), '{}');
    fs.writeFileSync(
      path.join(base, 'input.js'),
      "require('./ignored/child'); require('./kept');",
    );
    fs.writeFileSync(path.join(base, 'ignored', 'child.js'), '');
    fs.writeFileSync(path.join(base, 'kept.js'), '');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  test.each([
    ['string glob', () => 'ignored/**'],
    ['array glob', () => ['./ignored/**']],
    ['native glob', () => [path.join('ignored', '**')]],
    ['absolute glob', () => [path.join(base, 'ignored', '**')]],
    ['exact path', () => ['ignored/child.js']],
  ])('%s excludes matching dependencies', async (_name, getIgnore) => {
    const { fileList, reasons, warnings } = await nodeFileTrace(
      [path.join(base, 'input.js')],
      { base, ignore: getIgnore() },
    );

    expect([...fileList].sort()).toEqual([
      'input.js',
      'kept.js',
      'package.json',
    ]);
    expect(reasons.get(path.join('ignored', 'child.js')).ignored).toBe(true);
    expect(warnings.size).toBe(0);
  });

  test('callbacks receive native relative paths', async () => {
    const ignore = jest.fn((file) => file === path.join('ignored', 'child.js'));
    const { fileList } = await nodeFileTrace([path.join(base, 'input.js')], {
      base,
      ignore,
    });

    expect([...fileList].sort()).toEqual([
      'input.js',
      'kept.js',
      'package.json',
    ]);
    expect(ignore).toHaveBeenCalledWith(path.join('ignored', 'child.js'));
  });

  test('entry points are retained even when matching an ignore glob', async () => {
    const { fileList } = await nodeFileTrace([path.join(base, 'input.js')], {
      base,
      ignore: '**',
    });

    expect([...fileList]).toEqual(['input.js']);
  });
});
