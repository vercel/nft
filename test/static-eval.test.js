const fs = require('fs');
const os = require('os');
const path = require('path');
const { nodeFileTrace } = require('../out/index.js');

it('traces a file with a long string concatenation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-static-eval-'));
  try {
    const chain = Array.from({ length: 3000 }, (_, i) => `'line ${i}\\n'`);
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `exports.profiles = { ca: [${chain.join(' + ')}] };\n`,
    );
    const { fileList } = await nodeFileTrace([path.join(dir, 'index.js')], {
      base: dir,
    });
    expect([...fileList]).toEqual(['index.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('traces a file with many chained concat calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-static-eval-'));
  try {
    const calls = Array.from(
      { length: 30 },
      (_, i) => `.concat('part ${i}', 'more ${i}')`,
    );
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `var it = 'start'${calls.join('')};\nconsole.log(it);\n`,
    );
    const { fileList } = await nodeFileTrace([path.join(dir, 'index.js')], {
      base: dir,
    });
    expect([...fileList]).toEqual(['index.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('parses a body that starts with a string concatenation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-static-eval-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `'a' + 'b';\nfunction f() {\n  'c' + 'd';\n}\n`,
    );
    const { fileList, warnings } = await nodeFileTrace(
      [path.join(dir, 'index.js')],
      { base: dir },
    );
    expect([...fileList]).toEqual(['index.js']);
    expect([...warnings]).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('traces past a value static-eval throws on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-static-eval-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `const big = 10n;\nconst doubled = typeof big === 'bigint' ? big * 2n : big * 2;\nrequire('./dep');\n`,
    );
    fs.writeFileSync(path.join(dir, 'dep.js'), 'module.exports = 1;\n');
    const { fileList, warnings } = await nodeFileTrace(
      [path.join(dir, 'index.js')],
      { base: dir },
    );
    expect([...fileList].sort()).toEqual(['dep.js', 'index.js']);
    expect([...warnings]).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('warns instead of rejecting on an expression too deep to analyze', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-static-eval-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `var a = {};\nexports.x = a${'.b'.repeat(50000)};\n`,
    );
    const { fileList, warnings } = await nodeFileTrace(
      [path.join(dir, 'index.js')],
      { base: dir },
    );
    expect([...fileList]).toEqual(['index.js']);
    expect([...warnings].map((w) => w.message)).toEqual([
      expect.stringContaining('Failed to analyze'),
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('returns unknown for string replace calls it cannot evaluate safely', async () => {
  const { parse } = require('acorn');
  const { evaluate } = require('../out/utils/static-eval.js');
  for (const code of [
    `'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'.replace(/(a+)+$/, '')`,
    `'abc'.replace(/b/, () => 'X')`,
  ]) {
    const ast = parse(code, { ecmaVersion: 'latest' }).body[0].expression;
    expect(await evaluate(ast)).toBeUndefined();
  }
});
