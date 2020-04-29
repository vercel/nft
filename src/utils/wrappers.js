// Wrapper detection pretransforms to enable static analysis
function handleWrappers (ast) {
  // UglifyJS will convert function wrappers into !function(){}
  let arg;

  if (ast.body.length === 1 &&
      ast.body[0].type === 'ExpressionStatement' &&
      ast.body[0].expression.type === 'UnaryExpression' &&
      ast.body[0].expression.operator === '!' &&
      ast.body[0].expression.argument.type === 'CallExpression' &&
      ast.body[0].expression.argument.callee.type === 'FunctionExpression' &&
      ast.body[0].expression.argument.arguments.length === 1)
    arg = ast.body[0].expression.argument.arguments[0];
  else if (ast.body.length === 1 &&
      ast.body[0].type === 'ExpressionStatement' &&
      ast.body[0].expression.type === 'CallExpression' &&
      ast.body[0].expression.callee.type === 'FunctionExpression' &&
      ast.body[0].expression.arguments.length === 1)
    arg = ast.body[0].expression.arguments[0];

  if (arg) {
    // When.js-style AMD wrapper:
    //   (function (define) { 'use strict' define(function (require) { ... }) })
    //   (typeof define === 'function' && define.amd ? define : function (factory) { module.exports = factory(require); })
    // ->
    //   (function (define) { 'use strict' define(function () { ... }) })
    //   (typeof define === 'function' && define.amd ? define : function (factory) { module.exports = factory(require); })
    if (arg.type === 'ConditionalExpression' && 
        arg.test.type === 'LogicalExpression' &&
        arg.test.operator === '&&' &&
        arg.test.left.type === 'BinaryExpression' &&
        arg.test.left.operator === '===' &&
        arg.test.left.left.type === 'UnaryExpression' &&
        arg.test.left.left.operator === 'typeof' &&
        arg.test.left.left.argument.name === 'define' &&
        arg.test.left.right.type === 'Literal' &&
        arg.test.left.right.value === 'function' &&
        arg.test.right.type === 'MemberExpression' &&
        arg.test.right.object.type === 'Identifier' &&
        arg.test.right.property.type === 'Identifier' &&
        arg.test.right.property.name === 'amd' &&
        arg.test.right.computed === false &&
        arg.alternate.type === 'FunctionExpression' &&
        arg.alternate.params.length === 1 &&
        arg.alternate.params[0].type === 'Identifier' &&
        arg.alternate.body.body.length === 1 &&
        arg.alternate.body.body[0].type === 'ExpressionStatement' &&
        arg.alternate.body.body[0].expression.type === 'AssignmentExpression' &&
        arg.alternate.body.body[0].expression.left.type === 'MemberExpression' &&
        arg.alternate.body.body[0].expression.left.object.type === 'Identifier' &&
        arg.alternate.body.body[0].expression.left.object.name === 'module' &&
        arg.alternate.body.body[0].expression.left.property.type === 'Identifier' &&
        arg.alternate.body.body[0].expression.left.property.name === 'exports' &&
        arg.alternate.body.body[0].expression.left.computed === false &&
        arg.alternate.body.body[0].expression.right.type === 'CallExpression' &&
        arg.alternate.body.body[0].expression.right.callee.type === 'Identifier' &&
        arg.alternate.body.body[0].expression.right.callee.name === arg.alternate.params[0].name &&
        arg.alternate.body.body[0].expression.right.arguments.length === 1 &&
        arg.alternate.body.body[0].expression.right.arguments[0].type === 'Identifier' &&
        arg.alternate.body.body[0].expression.right.arguments[0].name === 'require') {
      let iifeBody = ast.body[0].expression.callee.body.body;
      if (iifeBody[0].type === 'ExpressionStatement' &&
          iifeBody[0].expression.type === 'Literal' &&
          iifeBody[0].expression.value === 'use strict') {
        iifeBody = iifeBody.slice(1);
      }

      if (iifeBody.length === 1 &&
          iifeBody[0].type === 'ExpressionStatement' &&
          iifeBody[0].expression.type === 'CallExpression' &&
          iifeBody[0].expression.callee.type === 'Identifier' &&
          iifeBody[0].expression.callee.name === arg.test.right.object.name &&
          iifeBody[0].expression.arguments.length === 1 &&
          iifeBody[0].expression.arguments[0].type === 'FunctionExpression' &&
          iifeBody[0].expression.arguments[0].params.length === 1 &&
          iifeBody[0].expression.arguments[0].params[0].type === 'Identifier' &&
          iifeBody[0].expression.arguments[0].params[0].name === 'require') {
        iifeBody[0].expression.arguments[0].params = [];
      }
    }
    // Browserify-style wrapper
    //   (function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.bugsnag = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({
    //   1:[function(require,module,exports){
    //     ...code...
    //   },{"external":undefined}], 2: ...
    //   },{},[24])(24)
    //   });
    // ->
    //   (function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.bugsnag = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({
    //   1:[function(require,module,exports){
    //     ...code...
    //   },{"external":undefined}], 2: ...
    //   },{
    //     "external": { exports: require('external') }
    //   },[24])(24)
    //   });
    else if (arg.type === 'FunctionExpression' &&
        arg.params.length === 0 &&
        (arg.body.body.length === 1 ||
            arg.body.body.length === 2 &&
            arg.body.body[0].type === 'VariableDeclaration' &&
            arg.body.body[0].declarations.length === 3 &&
            arg.body.body[0].declarations.every(decl => decl.init === null && decl.id.type === 'Identifier')
        ) &&
        arg.body.body[arg.body.body.length - 1].type === 'ReturnStatement' &&
        arg.body.body[arg.body.body.length - 1].argument.type === 'CallExpression' &&
        arg.body.body[arg.body.body.length - 1].argument.callee.type === 'CallExpression' &&
        arg.body.body[arg.body.body.length - 1].argument.arguments.length &&
        arg.body.body[arg.body.body.length - 1].argument.arguments.every(arg => arg.type === 'Literal' && typeof arg.value === 'number') &&
        arg.body.body[arg.body.body.length - 1].argument.callee.callee.type === 'CallExpression' &&
        arg.body.body[arg.body.body.length - 1].argument.callee.callee.callee.type === 'FunctionExpression' &&
        arg.body.body[arg.body.body.length - 1].argument.callee.callee.arguments.length === 0 &&
        // (dont go deeper into browserify loader internals than this)
        arg.body.body[arg.body.body.length - 1].argument.callee.arguments.length === 3 &&
        arg.body.body[arg.body.body.length - 1].argument.callee.arguments[0].type === 'ObjectExpression' &&
        arg.body.body[arg.body.body.length - 1].argument.callee.arguments[1].type === 'ObjectExpression' &&
        arg.body.body[arg.body.body.length - 1].argument.callee.arguments[2].type === 'ArrayExpression') {
      const modules = arg.body.body[arg.body.body.length - 1].argument.callee.arguments[0].properties;
      
      // verify modules is the expected data structure
      // in the process, extract external requires
      const externals = {};
      if (modules.every(m => {
        if (m.type !== 'Property' ||
            m.computed !== false ||
            m.key.type !== 'Literal' ||
            typeof m.key.value !== 'number' ||
            m.value.type !== 'ArrayExpression' ||
            m.value.elements.length !== 2 ||
            m.value.elements[0].type !== 'FunctionExpression' ||
            m.value.elements[1].type !== 'ObjectExpression')
          return false;
        
        // detect externals from undefined moduleMap values
        const moduleMap = m.value.elements[1].properties;
        for (const prop of moduleMap) {
          if (prop.type !== 'Property' ||
              (prop.value.type !== 'Identifier' && prop.value.type !== 'Literal') ||
              prop.key.type !== 'Literal' ||
              typeof prop.key.value !== 'string' ||
              prop.computed)
            return false;
          if (prop.value.type === 'Identifier' && prop.value.name === 'undefined')
            externals[prop.key.value] = prop.key;
        }
        return true;
      })) {
        // if we have externals, inline them into the browserify cache for webpack to pick up
        const externalIds = Object.keys(externals);
        if (externalIds.length) {
          const cache = arg.body.body[1].argument.callee.arguments[1];
          cache.properties = externalIds.map(ext => {
            return {
              type: 'Property',
              kind: 'init',
              key: externals[ext],
              value: {
                type: 'ObjectExpression',
                properties: [{
                  type: 'Property',
                  kind: 'init',
                  key: {
                    type: 'Identifier',
                    name: 'exports'
                  },
                  value: {
                    type: 'CallExpression',
                    callee: {
                      type: 'Identifier',
                      name: 'require'
                    },
                    arguments: [externals[ext]]
                  }
                }]
              }
            };
          });
        }
      }
    }
    // UMD wrapper
    //    (function (factory) {
    //      if (typeof module === "object" && typeof module.exports === "object") {
    //         var v = factory(require, exports);
    //         if (v !== undefined) module.exports = v;
    //     }
    //     else if (typeof define === "function" && define.amd) {
    //         define(["require", "exports", "./impl/format", "./impl/edit", "./impl/scanner", "./impl/parser"], factory);
    //     }
    //   })(function (require, exports) {
    //     // ...
    //   }
    // ->
    //   (function (factory) {
    //     if (typeof module === "object" && typeof module.exports === "object") {
    //         var v = factory(require, exports);
    //         if (v !== undefined) module.exports = v;
    //     }
    //     else if (typeof define === "function" && define.amd) {
    //         define(["require", "exports", "./impl/format", "./impl/edit", "./impl/scanner", "./impl/parser"], factory);
    //     }
    //   })(function () {
    //     // ...
    //   }
    else if (arg.type === 'FunctionExpression' &&
        arg.params.length === 2 &&
        arg.params[0].type === 'Identifier' &&
        arg.params[1].type === 'Identifier' &&
        ast.body[0].expression.callee.body.body.length === 1) {
      const statement = ast.body[0].expression.callee.body.body[0];
      if (statement.type === 'IfStatement' &&
          statement.test.type === 'LogicalExpression' &&
          statement.test.operator === '&&' &&
          statement.test.left.type === 'BinaryExpression' &&
          statement.test.left.left.type === 'UnaryExpression' &&
          statement.test.left.left.operator === 'typeof' &&
          statement.test.left.left.argument.type === 'Identifier' &&
          statement.test.left.left.argument.name === 'module' &&
          statement.test.left.right.type === 'Literal' &&
          statement.test.left.right.value === 'object' &&
          statement.test.right.type === 'BinaryExpression' &&
          statement.test.right.left.type === 'UnaryExpression' &&
          statement.test.right.left.operator === 'typeof' &&
          statement.test.right.left.argument.type === 'MemberExpression' &&
          statement.test.right.left.argument.object.type === 'Identifier' &&
          statement.test.right.left.argument.object.name === 'module' &&
          statement.test.right.left.argument.property.type === 'Identifier' &&
          statement.test.right.left.argument.property.name === 'exports' &&
          statement.test.right.right.type === 'Literal' &&
          statement.test.right.right.value === 'object' &&
          statement.consequent.type === 'BlockStatement' &&
          statement.consequent.body.length > 0) {
          let callSite;
          if (statement.consequent.body[0].type === 'VariableDeclaration' &&
              statement.consequent.body[0].declarations[0].init &&
              statement.consequent.body[0].declarations[0].init.type === 'CallExpression')
            callSite = statement.consequent.body[0].declarations[0].init;
          else if (statement.consequent.body[0].type === 'ExpressionStatement' &&
              statement.consequent.body[0].expression.type === 'CallExpression')
            callSite = statement.consequent.body[0].expression;
          else if (statement.consequent.body[0].type === 'ExpressionStatement' &&
              statement.consequent.body[0].expression.type === 'AssignmentExpression' &&
              statement.consequent.body[0].expression.right.type === 'CallExpression')
            callSite = statement.consequent.body[0].expression.right;
          if (callSite &&
              callSite.callee.type === 'Identifier' &&
              callSite.callee.name === ast.body[0].expression.callee.params[0].name &&
              callSite.arguments.length === 2 &&
              callSite.arguments[0].type === 'Identifier' &&
              callSite.arguments[0].name === 'require' &&
              callSite.arguments[1].type === 'Identifier' &&
              callSite.arguments[1].name === 'exports') {
            ast.body[0].expression.arguments[0].params = [];
          }
      }
    }
  }
}

module.exports = handleWrappers;
