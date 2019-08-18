module.exports = function (ast, vars = {}, computeBranches = true) {
  const state = {
    computeBranches,
    vars
  };
  return walk(ast);

  // walk returns:
  // 1. Single known value: { value: value }
  // 2. Conditional value: { test, then, else }
  // 3. Unknown value: undefined
  function walk (node) {
    const visitor = visitors[node.type];
    if (visitor)
      return visitor.call(state, node, walk);
  }
};

const UNKNOWN = module.exports.UNKNOWN = Symbol();
const FUNCTION = module.exports.FUNCTION = Symbol();
const WILDCARD = module.exports.WILDCARD = '\x1a';
const wildcardRegEx = module.exports.wildcardRegEx = /\x1a/g;

function countWildcards (str) {
  wildcardRegEx.lastIndex = 0;
  let cnt = 0;
  while (wildcardRegEx.exec(str)) cnt++;
  return cnt;
}

const visitors = {
  ArrayExpression (node, walk) {
    const arr = [];
    for (let i = 0, l = node.elements.length; i < l; i++) {
      if (node.elements[i] === null) {
        arr.push(null);
        continue;
      }
      const x = walk(node.elements[i]);
      if (!x) return;
      if ('value' in x === false) return;
      arr.push(x.value);
    }
    return { value: arr };
  },
  BinaryExpression (node, walk) {
    const op = node.operator;

    let l = walk(node.left);

    if (!l && op !== '+') return;

    let r = walk(node.right);

    if (!l && !r) return;

    if (!l) {
      // UNKNOWN + 'str' -> wildcard string value
      if (this.computeBranches && typeof r.value === 'string')
        return { value: WILDCARD + r.value, wildcards: [node.left, ...r.wildcards || []] };
      return;
    }

    if (!r) {
      // 'str' + UKNOWN -> wildcard string value
      if (this.computeBranches && op === '+') {
        if (typeof l.value === 'string')
          return { value: l.value + WILDCARD, wildcards: [...l.wildcards || [], node.right] };
      }
      // A || UNKNOWN -> A if A is truthy
      if (!('test' in l) && op === '||' && l.value)
        return l;
      return;
    }

    if ('test' in l && 'test' in r)
      return;

    if ('test' in l) {
      r = r.value;
      if (op === '==') return { test: l.test, then: l.then == r, else: l.else == r };
      if (op === '===') return { test: l.test, then: l.then === r, else: l.else === r };
      if (op === '!=') return { test: l.test, then: l.then != r, else: l.else != r };
      if (op === '!==') return { test: l.test, then: l.then !== r, else: l.else !== r };
      if (op === '+') return { test: l.test, then: l.then + r, else: l.else + r };
      if (op === '-') return { test: l.test, then: l.then - r, else: l.else - r };
      if (op === '*') return { test: l.test, then: l.then * r, else: l.else * r };
      if (op === '/') return { test: l.test, then: l.then / r, else: l.else / r };
      if (op === '%') return { test: l.test, then: l.then % r, else: l.else % r };
      if (op === '<') return { test: l.test, then: l.then < r, else: l.else < r };
      if (op === '<=') return { test: l.test, then: l.then <= r, else: l.else <= r };
      if (op === '>') return { test: l.test, then: l.then > r, else: l.else > r };
      if (op === '>=') return { test: l.test, then: l.then >= r, else: l.else >= r };
      if (op === '|') return { test: l.test, then: l.then | r, else: l.else | r };
      if (op === '&') return { test: l.test, then: l.then & r, else: l.else & r };
      if (op === '^') return { test: l.test, then: l.then ^ r, else: l.else ^ r };
      if (op === '&&') return { test: l.test, then: l.then && r, else: l.else && r };
      if (op === '||') return { test: l.test, then: l.then || r, else: l.else || r };
    }
    else if ('test' in r) {
      l = l.value;
      if (op === '==') return { test: r.test, then: l == r.then, else: l == r.else };
      if (op === '===') return { test: r.test, then: l === r.then, else: l === r.else };
      if (op === '!=') return { test: r.test, then: l != r.then, else: l != r.else };
      if (op === '!==') return { test: r.test, then: l !== r.then, else: l !== r.else };
      if (op === '+') return { test: r.test, then: l + r.then, else: l + r.else };
      if (op === '-') return { test: r.test, then: l - r.then, else: l - r.else };
      if (op === '*') return { test: r.test, then: l * r.then, else: l * r.else };
      if (op === '/') return { test: r.test, then: l / r.then, else: l / r.else };
      if (op === '%') return { test: r.test, then: l % r.then, else: l % r.else };
      if (op === '<') return { test: r.test, then: l < r.then, else: l < r.else };
      if (op === '<=') return { test: r.test, then: l <= r.then, else: l <= r.else };
      if (op === '>') return { test: r.test, then: l > r.then, else: l > r.else };
      if (op === '>=') return { test: r.test, then: l >= r.then, else: l >= r.else };
      if (op === '|') return { test: r.test, then: l | r.then, else: l | r.else };
      if (op === '&') return { test: r.test, then: l & r.then, else: l & r.else };
      if (op === '^') return { test: r.test, then: l ^ r.then, else: l ^ r.else };
      if (op === '&&') return { test: r.test, then: l && r.then, else: l && r.else };
      if (op === '||') return { test: r.test, then: l || r.then, else: l || r.else };
    }
    else {
      if (op === '==') return { value: l.value == r.value };
      if (op === '===') return { value: l.value === r.value };
      if (op === '!=') return { value: l.value != r.value };
      if (op === '!==') return { value: l.value !== r.value };
      if (op === '+') {
        const val = { value: l.value + r.value };
        if (l.wildcards || r.wildcards)
          val.wildcards = [...l.wildcards || [], ...r.wildcards || []];
        return val;
      }
      if (op === '-') return { value: l.value - r.value };
      if (op === '*') return { value: l.value * r.value };
      if (op === '/') return { value: l.value / r.value };
      if (op === '%') return { value: l.value % r.value };
      if (op === '<') return { value: l.value < r.value };
      if (op === '<=') return { value: l.value <= r.value };
      if (op === '>') return { value: l.value > r.value };
      if (op === '>=') return { value: l.value >= r.value };
      if (op === '|') return { value: l.value | r.value };
      if (op === '&') return { value: l.value & r.value };
      if (op === '^') return { value: l.value ^ r.value };
      if (op === '&&') return { value: l.value && r.value };
      if (op === '||') return { value: l.value || r.value };
    }
    return;
  },
  CallExpression (node, walk) {
    const callee = walk(node.callee);
    if (!callee || 'test' in callee) return;
    let fn = callee.value;
    if (typeof fn === 'object' && fn !== null) fn = fn[FUNCTION];
    if (typeof fn !== 'function') return;

    let ctx = null
    if (node.callee.object) {
      ctx = walk(node.callee.object)
      ctx = ctx && ctx.value ? ctx.value : null
    }

    // we allow one conditional argument to create a conditional expression
    let predicate;
    let args = [];
    let argsElse;
    let allWildcards = node.arguments.length > 0;
    const wildcards = [];
    for (let i = 0, l = node.arguments.length; i < l; i++) {
      let x = walk(node.arguments[i]);
      if (x) {
        allWildcards = false;
        if (typeof x.value === 'string' && x.wildcards)
          x.wildcards.forEach(w => wildcards.push(w));
      }
      else {
        if (!this.computeBranches)
          return;
        // this works because provided static functions
        // operate on known string inputs
        x = { value: WILDCARD };
        wildcards.push(node.arguments[i]);
      }
      if ('test' in x) {
        if (wildcards.length) return;
        if (predicate) return;
        predicate = x.test;
        argsElse = args.concat([]);
        args.push(x.then);
        argsElse.push(x.else);
      }
      else {
        args.push(x.value);
        if (argsElse)
          argsElse.push(x.value);
      }
    }
    if (allWildcards)
      return;
    try {
      const result = fn.apply(ctx, args);
      if (result === UNKNOWN)
        return;
      if (!predicate) {
        if (wildcards.length) {
          if (typeof result !== 'string' || countWildcards(result) !== wildcards.length)
            return;
          return { value: result, wildcards };
        }
        return { value: result };
      }
      const resultElse = fn.apply(ctx, argsElse);
      if (result === UNKNOWN)
        return;
      return { test: predicate, then: result, else: resultElse };
    }
    catch (e) {
      return;
    }
  },
  ConditionalExpression (node, walk) {
    const val = walk(node.test);
    if (val && 'value' in val)
      return val.value ? walk(node.consequent) : walk(node.alternate);

    if (!this.computeBranches)
      return;

    const thenValue = walk(node.consequent);
    if (!thenValue || 'wildcards' in thenValue || 'test' in thenValue)
      return;
    const elseValue = walk(node.alternate);
    if (!elseValue || 'wildcards' in elseValue || 'test' in elseValue)
      return;

    return {
      test: node.test,
      then: thenValue.value,
      else: elseValue.value
    };
  },
  ExpressionStatement (node, walk) {
    return walk(node.expression);
  },
  Identifier (node) {
    if (Object.hasOwnProperty.call(this.vars, node.name)) {
      const val = this.vars[node.name];
      if (val === UNKNOWN)
        return;
      return { value: val };
    }
    return;
  },
  Literal (node) {
    return { value: node.value };
  },
  MemberExpression (node, walk) {
    const obj = walk(node.object);
    // do not allow access to methods on Function
    if (!obj || 'test' in obj || typeof obj.value === 'function')
      return;
    if (node.property.type === 'Identifier') {
      if (typeof obj.value === 'object' && obj.value !== null) {
        if (node.computed) {
          // See if we can compute the computed property
          const computedProp = walk(node.property);
          if (computedProp && computedProp.value) {
            const val = obj.value[computedProp.value];
            if (val === UNKNOWN) return;
            return { value: val };
          }
          // Special case for empty object
          if (!obj.value[UNKNOWN] && Object.keys(obj).length === 0) {
            return { value: undefined };
          }
        }
        else if (node.property.name in obj.value) {
          const val = obj.value[node.property.name];
          if (val === UNKNOWN)
            return;
          return { value: val };
        }
        else if (obj.value[UNKNOWN])
          return;
      }
      else {
        return { value: undefined };
      }
    }
    const prop = walk(node.property);
    if (!prop || 'test' in prop)
      return;
    if (typeof obj.value === 'object' && obj.value !== null) {
      if (prop.value in obj.value) {
        const val = obj.value[prop.value];
        if (val === UNKNOWN)
          return;
        return { value: val };
      }
      else if (obj.value[UNKNOWN]) {
        return;
      }
    }
    else {
      return { value: undefined };
    }
  },
  ObjectExpression (node, walk) {
    const obj = {};
    for (let i = 0; i < node.properties.length; i++) {
      const prop = node.properties[i];
      const keyValue = prop.computed ? walk(prop.key) : prop.key && { value: prop.key.name || prop.key.value };
      if (!keyValue || 'test' in keyValue) return;
      const value = walk(prop.value);
      if (!value || 'test' in value) return;
      if (value.value === UNKNOWN) return;
      obj[keyValue.value] = value.value;
    }
    return { value: obj };
  },
  TemplateLiteral (node, walk) {
    let val = { value: '' };
    for (var i = 0; i < node.expressions.length; i++) {
      if ('value' in val) {
        val.value += node.quasis[i].value.cooked;
      }
      else {
        val.then += node.quasis[i].value.cooked;
        val.else += node.quasis[i].value.cooked;
      }
      let exprValue = walk(node.expressions[i]);
      if (!exprValue) {
        if (!this.computeBranches)
          return;
        exprValue = { value: WILDCARD, wildcards: [node.expressions[i]] };
      }
      if ('value' in exprValue) {
        if ('value' in val) {
          val.value += exprValue.value;
          if (exprValue.wildcards)
            val.wildcards = [...val.wildcards || [], ...exprValue.wildcards];
        }
        else {
          if (exprValue.wildcards)
            return;
          val.then += exprValue.value;
          val.else += exprValue.value;
        }
      }
      else {
        // only support a single branch in a template
        if ('value' in val === false || val.wildcards)
          return;
        val = {
          test: exprValue.test,
          then: val.value + exprValue.then,
          else: val.value + exprValue.else
        };
      }
    }
    if ('value' in val) {
      val.value += node.quasis[i].value.cooked;
    }
    else {
      val.then += node.quasis[i].value.cooked;
      val.else += node.quasis[i].value.cooked;
    }
    return val;
  },
  ThisExpression () {
    if (Object.hasOwnProperty.call(this.vars, 'this'))
      return { value: this.vars['this'] };
  },
  UnaryExpression (node, walk) {
    const val = walk(node.argument);
    if (!val)
      return;
    if ('value' in val && 'wildcards' in val === false) {
      if (node.operator === '+') return { value: +val.value };
      if (node.operator === '-') return { value: -val.value };
      if (node.operator === '~') return { value: ~val.value };
      if (node.operator === '!') return { value: !val.value };
    }
    else if ('test' in val && 'wildcards' in val === false) {
      if (node.operator === '+') return { test: val.test, then: +val.then, else: +val.else };
      if (node.operator === '-') return { test: val.test, then: -val.then, else: -val.else };
      if (node.operator === '~') return { test: val.test, then: ~val.then, else: ~val.else };
      if (node.operator === '!') return { test: val.test, then: !val.then, else: !val.else };
    }
    return;
  }
};
visitors.LogicalExpression = visitors.BinaryExpression;
