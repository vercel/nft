import { Node } from 'estree-walker';
import { EvaluatedValue, StaticValue, ConditionalValue } from '../types';
import { URL } from 'url';
type Walk = (node: Node) => EvaluatedValue;
type State = { computeBranches: boolean, vars: Record<string, any> };

export function evaluate(ast: Node, vars = {}, computeBranches = true): EvaluatedValue {
  const state: State = {
    computeBranches,
    vars
  };
  return walk(ast);

  // walk returns:
  // 1. Single known value: { value: value }
  // 2. Conditional value: { test, then, else }
  // 3. Unknown value: undefined
  function walk(node: Node) {
    const visitor = visitors[node.type];
    if (visitor) {
      return visitor.call(state, node, walk);
    }
    return undefined;
  }
};

export const UNKNOWN = Symbol();
export const FUNCTION = Symbol();
export const WILDCARD = '\x1a';
export const wildcardRegEx = /\x1a/g;

function countWildcards (str: string) {
  wildcardRegEx.lastIndex = 0;
  let cnt = 0;
  while (wildcardRegEx.exec(str)) cnt++;
  return cnt;
}

const visitors: Record<string, (this: State, node: Node, walk: Walk) => EvaluatedValue> = {
  'ArrayExpression': function ArrayExpression(this: State, node: Node, walk: Walk) {
    const arr = [];
    for (let i = 0, l = node.elements.length; i < l; i++) {
      if (node.elements[i] === null) {
        arr.push(null);
        continue;
      }
      const x = walk(node.elements[i]);
      if (!x) return;
      if ('value' in x === false) return;
      arr.push((x as StaticValue).value);
    }
    return { value: arr };
  },
  'BinaryExpression': function BinaryExpression(this: State, node: Node, walk: Walk) {
    const op = node.operator;

    let l = walk(node.left);

    if (!l && op !== '+') return;

    let r = walk(node.right);

    if (!l && !r) return;

    if (!l) {
      // UNKNOWN + 'str' -> wildcard string value
      if (this.computeBranches && r && 'value' in r && typeof r.value === 'string')
        return { value: WILDCARD + r.value, wildcards: [node.left, ...r.wildcards || []] };
      return;
    }

    if (!r) {
      // 'str' + UKNOWN -> wildcard string value
      if (this.computeBranches && op === '+') {
        if (l && 'value' in l && typeof l.value === 'string')
          return { value: l.value + WILDCARD, wildcards: [...l.wildcards || [], node.right] };
      }
      // A || UNKNOWN -> A if A is truthy
      if (!('test' in l) && op === '||' && l.value)
        return l;
      return;
    }

    if ('test' in l && 'value' in r) {
      const v: any = r.value;
      if (op === '==') return { test: l.test, then: l.then == v, else: l.else == v };
      if (op === '===') return { test: l.test, then: l.then === v, else: l.else === v };
      if (op === '!=') return { test: l.test, then: l.then != v, else: l.else != v };
      if (op === '!==') return { test: l.test, then: l.then !== v, else: l.else !== v };
      if (op === '+') return { test: l.test, then: l.then + v, else: l.else + v };
      if (op === '-') return { test: l.test, then: l.then - v, else: l.else - v };
      if (op === '*') return { test: l.test, then: l.then * v, else: l.else * v };
      if (op === '/') return { test: l.test, then: l.then / v, else: l.else / v };
      if (op === '%') return { test: l.test, then: l.then % v, else: l.else % v };
      if (op === '<') return { test: l.test, then: l.then < v, else: l.else < v };
      if (op === '<=') return { test: l.test, then: l.then <= v, else: l.else <= v };
      if (op === '>') return { test: l.test, then: l.then > v, else: l.else > v };
      if (op === '>=') return { test: l.test, then: l.then >= v, else: l.else >= v };
      if (op === '|') return { test: l.test, then: l.then | v, else: l.else | v };
      if (op === '&') return { test: l.test, then: l.then & v, else: l.else & v };
      if (op === '^') return { test: l.test, then: l.then ^ v, else: l.else ^ v };
      if (op === '&&') return { test: l.test, then: l.then && v, else: l.else && v };
      if (op === '||') return { test: l.test, then: l.then || v, else: l.else || v };
    }
    else if ('test' in r && 'value' in l) {
      const v: any = l.value;
      if (op === '==') return { test: r.test, then: v == r.then, else: v == r.else };
      if (op === '===') return { test: r.test, then: v === r.then, else: v === r.else };
      if (op === '!=') return { test: r.test, then: v != r.then, else: v != r.else };
      if (op === '!==') return { test: r.test, then: v !== r.then, else: v !== r.else };
      if (op === '+') return { test: r.test, then: v + r.then, else: v + r.else };
      if (op === '-') return { test: r.test, then: v - r.then, else: v - r.else };
      if (op === '*') return { test: r.test, then: v * r.then, else: v * r.else };
      if (op === '/') return { test: r.test, then: v / r.then, else: v / r.else };
      if (op === '%') return { test: r.test, then: v % r.then, else: v % r.else };
      if (op === '<') return { test: r.test, then: v < r.then, else: v < r.else };
      if (op === '<=') return { test: r.test, then: v <= r.then, else: v <= r.else };
      if (op === '>') return { test: r.test, then: v > r.then, else: v > r.else };
      if (op === '>=') return { test: r.test, then: v >= r.then, else: v >= r.else };
      if (op === '|') return { test: r.test, then: v | r.then, else: v | r.else };
      if (op === '&') return { test: r.test, then: v & r.then, else: v & r.else };
      if (op === '^') return { test: r.test, then: v ^ r.then, else: v ^ r.else };
      if (op === '&&') return { test: r.test, then: v && r.then, else: l && r.else };
      if (op === '||') return { test: r.test, then: v || r.then, else: l || r.else };
    }
    else if ('value' in l && 'value' in r) {
      if (op === '==') return { value: l.value == r.value };
      if (op === '===') return { value: l.value === r.value };
      if (op === '!=') return { value: l.value != r.value };
      if (op === '!==') return { value: l.value !== r.value };
      if (op === '+') {
        const val: StaticValue = { value: l.value + r.value };
        let wildcards: string[] = [];
        if ('wildcards' in l && l.wildcards) {
          wildcards = wildcards.concat(l.wildcards);
        }
        if ('wildcards' in r && r.wildcards) {
          wildcards = wildcards.concat(r.wildcards);
        }
        if (wildcards.length > 0) {
          val.wildcards = wildcards;
        }
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
  'CallExpression': function CallExpression(this: State, node: Node, walk: Walk) {
    const callee = walk(node.callee);
    if (!callee || 'test' in callee) return;
    let fn: any = callee.value;
    if (typeof fn === 'object' && fn !== null) fn = fn[FUNCTION];
    if (typeof fn !== 'function') return;

    let ctx = null
    if (node.callee.object) {
      ctx = walk(node.callee.object)
      ctx = ctx && 'value' in ctx && ctx.value ? ctx.value : null
    }

    // we allow one conditional argument to create a conditional expression
    let predicate;
    let args = [];
    let argsElse;
    let allWildcards = node.arguments.length > 0;
    const wildcards: string[] = [];
    for (let i = 0, l = node.arguments.length; i < l; i++) {
      let x = walk(node.arguments[i]);
      if (x) {
        allWildcards = false;
        if ('value' in x && typeof x.value === 'string' && x.wildcards)
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
  'ConditionalExpression': function ConditionalExpression(this: State, node: Node, walk: Walk) {
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
  'ExpressionStatement': function ExpressionStatement(this: State, node: Node, walk: Walk) {
    return walk(node.expression);
  },
  'Identifier': function Identifier(this: State, node: Node, _walk: Walk) {
    if (Object.hasOwnProperty.call(this.vars, node.name))
      return this.vars[node.name];
    return undefined;
  },
  'Literal': function Literal (this: State, node: Node, _walk: Walk) {
    return { value: node.value };
  },
  'MemberExpression': function MemberExpression(this: State, node: Node, walk: Walk) {
    const obj = walk(node.object);
    // do not allow access to methods on Function
    if (!obj || 'test' in obj || typeof obj.value === 'function') {
      return undefined;
    }
    if (node.property.type === 'Identifier') {
      if (typeof obj.value === 'object' && obj.value !== null) {
        const objValue = obj.value as any;
        if (node.computed) {
          // See if we can compute the computed property
          const computedProp = walk(node.property);
          if (computedProp && 'value' in computedProp && computedProp.value) {
            const val = objValue[computedProp.value];
            if (val === UNKNOWN) return undefined;
            return { value: val };
          }
          // Special case for empty object
          if (!objValue[UNKNOWN] && Object.keys(obj).length === 0) {
            return { value: undefined };
          }
        }
        else if (node.property.name in objValue) {
          const val = objValue[node.property.name];
          if (val === UNKNOWN) return undefined;
          return { value: val };
        }
        else if (objValue[UNKNOWN])
          return undefined;
      }
      else {
        return { value: undefined };
      }
    }
    const prop = walk(node.property);
    if (!prop || 'test' in prop)
      return undefined;
    if (typeof obj.value === 'object' && obj.value !== null) {
      //@ts-ignore
      if (prop.value in obj.value) {
        //@ts-ignore
        const val = obj.value[prop.value];
        if (val === UNKNOWN)
          return undefined;
        return { value: val };
      }
      //@ts-ignore
      else if (obj.value[UNKNOWN]) {
        return undefined;
      }
    }
    else {
      return { value: undefined };
    }
    return undefined;
  },
  'MetaProperty': function MetaProperty(this: State, node: Node) {
    if (node.meta.name === 'import' && node.property.name === 'meta')
      return { value: this.vars['import.meta'] };
    return undefined;
  },
  'NewExpression': function NewExpression(this: State, node: Node, walk: Walk) {
    // new URL('./local', parent)
    const cls = walk(node.callee);
    if (cls && 'value' in cls && cls.value === URL && node.arguments.length) {
      const arg = walk(node.arguments[0]);
      if (!arg)
        return undefined;
      let parent = null;
      if (node.arguments[1]) {
        parent = walk(node.arguments[1]);
        if (!parent || !('value' in parent))
          return undefined;
      }
      if ('value' in arg) {
        if (parent) {
          try {
            return { value: new URL(arg.value, parent.value) };
          }
          catch {
            return undefined;
          }
        }
        try {
          return { value: new URL(arg.value) };
        }
        catch {
          return undefined;
        }
      }
      else {
        const test = arg.test;
        if (parent) {
          try {
            return {
              test,
              then: new URL(arg.then, parent.value),
              else: new URL(arg.else, parent.value)
            };
          }
          catch {
            return undefined;
          }
        }
        try {
          return {
            test,
            then: new URL(arg.then),
            else: new URL(arg.else)
          };
        }
        catch {
          return undefined;
        }
      }
    }
    return undefined;
  },
  'ObjectExpression': function ObjectExpression(this: State, node: Node, walk: Walk) {
    const obj: any = {};
    for (let i = 0; i < node.properties.length; i++) {
      const prop = node.properties[i];
      const keyValue = prop.computed ? walk(prop.key) : prop.key && { value: prop.key.name || prop.key.value };
      if (!keyValue || 'test' in keyValue) return;
      const value = walk(prop.value);
      if (!value || 'test' in value) return;
      //@ts-ignore
      if (value.value === UNKNOWN) return;
      //@ts-ignore
      obj[keyValue.value] = value.value;
    }
    return { value: obj };
  },
  'TemplateLiteral': function TemplateLiteral(this: State, node: Node, walk: Walk) {
    let val: StaticValue | ConditionalValue = { value: '' };
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
          return undefined;
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
      else if ('value' in val) {
        if ('wildcards' in val) {
          // only support a single branch in a template
          return;
        }
        val = {
          test: exprValue.test,
          then: val.value + exprValue.then,
          else: val.value + exprValue.else
        };
      } else {
        // only support a single branch in a template
        return;
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
  'ThisExpression': function ThisExpression(this: State, _node: Node, _walk: Walk) {
    if (Object.hasOwnProperty.call(this.vars, 'this'))
      return this.vars['this'];
    return undefined;
  },
  'UnaryExpression': function UnaryExpression(this: State, node: Node, walk: Walk) {
    const val = walk(node.argument);
    if (!val)
      return undefined;
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
    return undefined;
  }
};
visitors.LogicalExpression = visitors.BinaryExpression;
