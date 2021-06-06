import { resolve, dirname, relative } from 'path';
import resolveDependency from '../resolve-dependency';
import { getPackageName } from './get-package-base';
import { readFileSync } from 'fs';
import { Job } from '../node-file-trace';
import { Ast } from './types';
type Node = Ast['body'][0]

const specialCases: Record<string, (o: SpecialCaseOpts) => void> = {
  '@generated/photon' ({ id, emitAssetDirectory }) {
    if (id.endsWith('@generated/photon/index.js')) {
      emitAssetDirectory(resolve(dirname(id), 'runtime/'));
    }
  },
  'argon2' ({ id, emitAssetDirectory }) {
    if (id.endsWith('argon2/argon2.js')) {
      emitAssetDirectory(resolve(dirname(id), 'build', 'Release'));
      emitAssetDirectory(resolve(dirname(id), 'prebuilds'));
      emitAssetDirectory(resolve(dirname(id), 'lib', 'binding'));
    }
  },
  'bull' ({ id, emitAssetDirectory }) {
    if (id.endsWith('bull/lib/commands/index.js')) {
      emitAssetDirectory(resolve(dirname(id)));
    }
  },
  'camaro' ({ id, emitAsset }) {
    if (id.endsWith('camaro/dist/camaro.js')) {
      emitAsset(resolve(dirname(id), 'camaro.wasm'));
    }
  },
  'google-gax' ({ id, ast, emitAssetDirectory }) {
    if (id.endsWith('google-gax/build/src/grpc.js')) {
      // const googleProtoFilesDir = path.normalize(google_proto_files_1.getProtoPath('..'));
      // ->
      // const googleProtoFilesDir = resolve(__dirname, '../../../google-proto-files');
      for (const statement of ast.body) {
        if (statement.type === 'VariableDeclaration' &&
            statement.declarations[0].id.type === 'Identifier' &&
            statement.declarations[0].id.name === 'googleProtoFilesDir') {
          emitAssetDirectory(resolve(dirname(id), '../../../google-proto-files'));
        }
      }
    }
  },
  'oracledb' ({ id, ast, emitAsset }) {
    if (id.endsWith('oracledb/lib/oracledb.js')) {
      for (const statement of ast.body) {
        if (statement.type === 'ForStatement' &&
            'body' in statement.body &&
            statement.body.body &&
            Array.isArray(statement.body.body) &&
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
          const version = (global as any)._unit ? '3.0.0' : JSON.parse(readFileSync(id.slice(0, -15) + 'package.json', 'utf8')).version;
          const useVersion = Number(version.slice(0, version.indexOf('.'))) >= 4;
          const binaryName = 'oracledb-' + (useVersion ? version : 'abi' + process.versions.modules) + '-' + process.platform + '-' + process.arch + '.node';
          emitAsset(resolve(id, '../../build/Release/' + binaryName));
        }
      }
    }
  },
  'phantomjs-prebuilt' ({ id, emitAssetDirectory }) {
    if (id.endsWith('phantomjs-prebuilt/lib/phantomjs.js')) {
      emitAssetDirectory(resolve(dirname(id), '..', 'bin'));
    }
  },
  'semver' ({ id, emitAsset }) {
    if (id.endsWith('semver/index.js')) {
      // See https://github.com/npm/node-semver/blob/master/CHANGELOG.md#710
      emitAsset(resolve(id.replace('index.js', 'preload.js')));
    }
  },
  'socket.io' ({ id, ast, job }) {
    if (id.endsWith('socket.io/lib/index.js')) {
      function replaceResolvePathStatement (statement: Node) {
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
          let resolved: string;
          try {
            const dep = resolveDependency(String(arg), id, job);
            if (typeof dep === 'string') {
              resolved = dep;
            } else {
              return undefined;
            }
          }
          catch (e) {
            return undefined;
          }
          // The asset relocator will then pick up the AST rewriting from here
          const relResolved = '/' + relative(dirname(id), resolved);
          statement.expression.right.arguments[0] = {
            type: 'BinaryExpression',
            // @ts-ignore Its okay if start is undefined
            start: statement.expression.right.arguments[0].start,
            // @ts-ignore Its okay if end is undefined
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
        return undefined;
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
          
          for (const node of statement.expression.right.body.body) {
            if (node.type === 'IfStatement' && node.consequent && 'body' in node.consequent && node.consequent.body) {
              const ifBody = node.consequent.body;
              let replaced: boolean | undefined = false;
              if (Array.isArray(ifBody) && ifBody[0] && ifBody[0].type === 'ExpressionStatement') {
                replaced = replaceResolvePathStatement(ifBody[0]);
              }
              if (Array.isArray(ifBody) && ifBody[1] && ifBody[1].type === 'TryStatement' && ifBody[1].block.body && ifBody[1].block.body[0]) {
                replaced = replaceResolvePathStatement(ifBody[1].block.body[0]) || replaced;
              }
              return;
            }
          }
          
        }
      }
    }
  },
  'typescript' ({ id, emitAssetDirectory }) {
    if (id.endsWith('typescript/lib/tsc.js')) {
      emitAssetDirectory(resolve(id, '../'));
    }
  },
  'uglify-es' ({ id, emitAsset }) {
    if (id.endsWith('uglify-es/tools/node.js')) {
      emitAsset(resolve(id, '../../lib/utils.js'));
      emitAsset(resolve(id, '../../lib/ast.js'));
      emitAsset(resolve(id, '../../lib/parse.js'));
      emitAsset(resolve(id, '../../lib/transform.js'));
      emitAsset(resolve(id, '../../lib/scope.js'));
      emitAsset(resolve(id, '../../lib/output.js'));
      emitAsset(resolve(id, '../../lib/compress.js'));
      emitAsset(resolve(id, '../../lib/sourcemap.js'));
      emitAsset(resolve(id, '../../lib/mozilla-ast.js'));
      emitAsset(resolve(id, '../../lib/propmangle.js'));
      emitAsset(resolve(id, '../../lib/minify.js'));
      emitAsset(resolve(id, '../exports.js'));
    }
  },
  'uglify-js' ({ id, emitAsset, emitAssetDirectory }) {
    if (id.endsWith('uglify-js/tools/node.js')) {
      emitAssetDirectory(resolve(id, '../../lib'));
      emitAsset(resolve(id, '../exports.js'));
    }
  },
  'playwright-core' ({ id, emitAsset }) {
    if (id.endsWith('playwright-core/index.js')) {
      emitAsset(resolve(dirname(id), 'browsers.json'));
    }
  },
};

interface SpecialCaseOpts {
  id: string;
  ast: Ast;
  emitAsset: (filename: string) => void;
  emitAssetDirectory: (dirname: string) => void;
  job: Job;
}

export default function handleSpecialCases({ id, ast, emitAsset, emitAssetDirectory, job }: SpecialCaseOpts) {
  const pkgName = getPackageName(id);
  const specialCase = specialCases[pkgName || ''];
  id = id.replace(/\\/g,  '/');
  if (specialCase) specialCase({ id, ast, emitAsset, emitAssetDirectory, job });
};
