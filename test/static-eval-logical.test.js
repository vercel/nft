const { parseExpressionAt } = require('acorn');
const { evaluate } = require('../out/utils/static-eval');

it.each([
  ["false || (unknown ? 'a' : 'b')", 'a', 'b'],
  ["'' || (unknown ? 'a' : 'b')", 'a', 'b'],
  ["'fallback' || (unknown ? 'a' : 'b')", 'fallback', 'fallback'],
  ["false && (unknown ? 'a' : 'b')", false, false],
  ["true && (unknown ? 'a' : 'b')", 'a', 'b'],
])('evaluates both branches of %s', async (expression, ifTrue, otherwise) => {
  const ast = parseExpressionAt(expression, 0, { ecmaVersion: 2020 });
  await expect(evaluate(ast)).resolves.toEqual({
    test: ast.right.test,
    ifTrue,
    else: otherwise,
  });
});
