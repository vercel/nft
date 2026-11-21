const { parseExpressionAt } = require('acorn');
const { evaluate } = require('../out/utils/static-eval');

it.each([
  ["({ ['file']: './dep.js' })", { file: './dep.js' }],
  ["({ ['fi' + 'le']: './dep.js' })", { file: './dep.js' }],
  ["({ ['']: './dep.js' })", { '': './dep.js' }],
  ["({ [0]: './dep.js' })", { 0: './dep.js' }],
])('evaluates computed object keys in %s', async (expression, value) => {
  const ast = parseExpressionAt(expression, 0, { ecmaVersion: 2020 });
  await expect(evaluate(ast)).resolves.toEqual({ value });
});

it.each([
  "({ [unknown]: './dep.js' })",
  "({ [unknown ? 'a' : 'b']: './dep.js' })",
])('does not invent a key for %s', async (expression) => {
  const ast = parseExpressionAt(expression, 0, { ecmaVersion: 2020 });
  await expect(evaluate(ast)).resolves.toBeUndefined();
});
