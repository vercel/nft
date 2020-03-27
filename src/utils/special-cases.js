const path = require('path');
const resolve = require('../resolve-dependency');
const { getPackageName } = require('./get-package-base');
const fs = require('fs');

const specialCases = {
  '@generated/photon' ({ id, emitAssetDirectory }) {
    if (id.endsWith('@generated/photon/index.js')) {
      emitAssetDirectory(path.resolve(path.dirname(id), 'runtime/'));
    }
  },
  'argon2' ({ id, emitAssetDirectory }) {
    if (id.endsWith('argon2/argon2.js')) {
      emitAssetDirectory(path.resolve(path.dirname(id), 'build', 'Release'));
      emitAssetDirectory(path.resolve(path.dirname(id), 'prebuilds'));
    }
  },
  'bull' ({ id, emitAssetDirectory }) {
    if (id.endsWith('bull/lib/commands/index.js')) {
      emitAssetDirectory(path.resolve(path.dirname(id)));
    }
  },
  'google-gax' ({ id, ast, emitAssetDirectory }) {
    if (id.endsWith('google-gax/build/src/grpc.js')) {
      // const googleProtoFilesDir = path.normalize(google_proto_files_1.getProtoPath('..'));
      // ->
      // const googleProtoFilesDir = path.resolve(__dirname, '../../../google-proto-files');
      for (const statement of ast.body) {
        if (statement.type === 'VariableDeclaration' &&
            statement.declarations[0].id.type === 'Identifier' &&
            statement.declarations[0].id.name === 'googleProtoFilesDir') {
          emitAssetDirectory(path.resolve(path.dirname(id), '../../../google-proto-files'));
        }
      }
    }
  },
  'oracledb' ({ id, ast, emitAsset }) {
    if (id.endsWith('oracledb/lib/oracledb.js')) {
      for (const statement of ast.body) {
        if (statement.type === 'ForStatement' &&
            statement.body.body &&
            statement.body.body[0] &&
            statement.body.body[0].type === 'TryStatement' &&
            statement.body.body[0].block.body[0] &&
            statement.body.body[0].block.body[0].type === 'ExpressionStatement' &&
            statement.body.body[0].block.body[0].expression.type === 'AssignmentExpression' &&
            statement.body.body[0].block.body[0].expression.operator === '=' &&
            statement.body.body[0].block.body[0].expression.left.type === 'Identifier' &&
            statement.body.body[0].block.body[0].expression.left.name === 'oracledbCLib' &&
            statement.body.body[0].block.body[0].expression.right.type === 'CallExpression' &&
            statement.body.body[0].block.body[0].expression.right.callee.type === 'Identifier' &&
            statement.body.body[0].block.body[0].expression.right.callee.name === 'require' &&
            statement.body.body[0].block.body[0].expression.right.arguments.length === 1 &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].type === 'MemberExpression' &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].computed === true &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].object.type === 'Identifier' &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].object.name === 'binaryLocations' &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].property.type === 'Identifier' &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].property.name === 'i') {
          statement.body.body[0].block.body[0].expression.right.arguments = [{ type: 'Literal', value: '_' }];
          const version = global._unit ? '3.0.0' : JSON.parse(fs.readFileSync(id.slice(0, -15) + 'package.json')).version;
          const useVersion = Number(version.slice(0, version.indexOf('.'))) >= 4;
          const binaryName = 'oracledb-' + (useVersion ? version : 'abi' + process.versions.modules) + '-' + process.platform + '-' + process.arch + '.node';
          emitAsset(path.resolve(id, '../../build/Release/' + binaryName));
        }
      }
    }
  },
  'phantomjs-prebuilt' ({ id, emitAssetDirectory }) {
    if (id.endsWith('phantomjs-prebuilt/lib/phantomjs.js')) {
      emitAssetDirectory(path.resolve(path.dirname(id), '..', 'bin'));
    }
  },
  'semver' ({ id, emitAsset }) {
    if (id.endsWith('semver/index.js')) {
      // See https://github.com/npm/node-semver/blob/master/CHANGELOG.md#710
      emitAsset(path.resolve(id.replace('index.js', 'preload.js')));
    }
  },
  'socket.io' ({ id, ast }) {
    if (id.endsWith('socket.io/lib/index.js')) {
      function replaceResolvePathStatement (statement) {
        if (statement.type === 'ExpressionStatement' &&
            statement.expression.type === 'AssignmentExpression' &&
            statement.expression.operator === '=' &&
            statement.expression.right.type === 'CallExpression' &&
            statement.expression.right.callee.type === 'Identifier' &&
            statement.expression.right.callee.name === 'read' &&
            statement.expression.right.arguments.length >= 1 &&
            statement.expression.right.arguments[0].type === 'CallExpression' &&
            statement.expression.right.arguments[0].callee.type === 'Identifier' &&
            statement.expression.right.arguments[0].callee.name === 'resolvePath' &&
            statement.expression.right.arguments[0].arguments.length === 1 &&
            statement.expression.right.arguments[0].arguments[0].type === 'Literal') {
          const arg = statement.expression.right.arguments[0].arguments[0].value;
          try {
            var resolved = resolve(arg, id, job);
          }
          catch (e) {
            return;
          }
          // The asset relocator will then pick up the AST rewriting from here
          const relResolved = '/' + path.relative(path.dirname(id), resolved);
          statement.expression.right.arguments[0] = {
            type: 'BinaryExpression',
            start: statement.expression.right.arguments[0].start,
            end: statement.expression.right.arguments[0].end,
            operator: '+',
            left: {
              type: 'Identifier',
              name: '__dirname'
            },
            right: {
              type: 'Literal',
              value: relResolved,
              raw: JSON.stringify(relResolved)
            }
          };
        }
        return;
      }

      for (const statement of ast.body) {
        if (statement.type === 'ExpressionStatement' &&
            statement.expression.type === 'AssignmentExpression' &&
            statement.expression.operator === '=' &&
            statement.expression.left.type === 'MemberExpression' &&
            statement.expression.left.object.type === 'MemberExpression' &&
            statement.expression.left.object.object.type === 'Identifier' &&
            statement.expression.left.object.object.name === 'Server' &&
            statement.expression.left.object.property.type === 'Identifier' &&
            statement.expression.left.object.property.name === 'prototype' &&
            statement.expression.left.property.type === 'Identifier' &&
            statement.expression.left.property.name === 'serveClient' &&
            statement.expression.right.type === 'FunctionExpression') {
          let ifStatement;
          for (const node of statement.expression.right.body.body)
            if (node.type === 'IfStatement') ifStatement = node;
          const ifBody = ifStatement && ifStatement.consequent.body;
          let replaced = false;
          if (ifBody && ifBody[0] && ifBody[0].type === 'ExpressionStatement')
            replaced = replaceResolvePathStatement(ifBody[0]);
          const tryBody = ifBody && ifBody[1] && ifBody[1].type === 'TryStatement' && ifBody[1].block.body;
          if (tryBody && tryBody[0])
            replaced = replaceResolvePathStatement(tryBody[0]) || replaced;
          return;
        }
      }
    }
  },
  'typescript' ({ id, emitAssetDirectory }) {
    if (id.endsWith('typescript/lib/tsc.js')) {
      emitAssetDirectory(path.resolve(id, '../'));
    }
  },
  'uglify-es' ({ id, emitAsset }) {
    if (id.endsWith('uglify-es/tools/node.js')) {
      emitAsset(path.resolve(id, '../../lib/utils.js'));
      emitAsset(path.resolve(id, '../../lib/ast.js'));
      emitAsset(path.resolve(id, '../../lib/parse.js'));
      emitAsset(path.resolve(id, '../../lib/transform.js'));
      emitAsset(path.resolve(id, '../../lib/scope.js'));
      emitAsset(path.resolve(id, '../../lib/output.js'));
      emitAsset(path.resolve(id, '../../lib/compress.js'));
      emitAsset(path.resolve(id, '../../lib/sourcemap.js'));
      emitAsset(path.resolve(id, '../../lib/mozilla-ast.js'));
      emitAsset(path.resolve(id, '../../lib/propmangle.js'));
      emitAsset(path.resolve(id, '../../lib/minify.js'));
      emitAsset(path.resolve(id, '../exports.js'));
    }
  },
  'uglify-js' ({ id, emitAsset, emitAssetDirectory }) {
    if (id.endsWith('uglify-js/tools/node.js')) {
      emitAssetDirectory(path.resolve(id, '../../lib'));
      emitAsset(path.resolve(id, '../exports.js'));
    }
  }
};

module.exports = function ({ id, ast, emitAsset, emitAssetDirectory, job }) {
  const pkgName = getPackageName(id);
  const specialCase = specialCases[pkgName];
  id = id.replace(/\\/g,  '/');
  if (specialCase) specialCase({ id, ast, emitAsset, emitAssetDirectory, job });
};
