# Node File Trace

[![Build Status](https://badgen.net/circleci/github/zeit/node-file-trace)](https://circleci.com/gh/zeit/workflows/node-file-trace)
[![Code Coverage](https://badgen.net/codecov/c/github/zeit/node-file-trace)](https://codecov.io/gh/zeit/node-file-trace)

This package is used in [@now/node](https://npmjs.com/package/@now/node) and [@now/next](https://npmjs.com/package/@now/next) to determine exactly which files (including `node_modules`) are necessary for the application runtime.

This is similar to [@zeit/ncc](https://npmjs.com/package/@zeit/ncc) except there is no bundling performed and therefore no reliance on webpack. This achieves the same tree-shaking benefits without moving any assets or binaries.

## Usage

### Installation
```bash
npm i @zeit/node-file-trace
```

### Usage

Provide the list of source files as input:

```js
const nodeFileTrace = require('@zeit/node-file-trace');
const files = ['./src/main.js', './src/second.js'];
const { fileList } = await nodeFileTrace(files);
```

The list of files will include all `node_modules` modules and assets that may be needed by the application code.

### Options

#### Base

The base path for the file list - all files will be provided as relative to this base.

By default the `process.cwd()` is used:

```js
const { fileList } = await nodeFileTrace(files, {
  base: process.cwd()
}
```

Any files/folders above the `base` are ignored in the listing and analysis.

#### TypeScript

Both JavaScript and TypeScript source files can be traced.

By default, TypeScript is disabled. Use the `ts` flag to enable.

```js
const { fileList } = await nodeFileTrace(['index.ts'], {
  ts: true
}
```

#### Ignore

Custom ignores can be provided to skip file inclusion (and consequently analysis of the file for references in turn as well).

```js
const { fileList } = await nodeFileTrace(files, {
  ignore: ['./node_modules/pkg/file.js']
});
```

Ignore will also accept a function or globs.

Note that the path provided to ignore is relative to `base`.

#### Cache

To persist the file cache between builds, pass an empty `cache` object:

```js
const cache = Object.create(null);
const { fileList } = await nodeFileTrace(['index.ts'], { cache });
// later:
{
  const { fileList } = await nodeFileTrace(['index.ts'], { cache });
}
```

Note that cache invalidations are not supported so the assumption is that the file system is not changed between runs.

#### Reasons

To get the underlying reasons for individual files being included, a `reasons` object is also provided by the output:

```js
const { fileList, reasons } = await nodeFileTrace(files);
```

The `reasons` output will then be an object of the following form:

```js
{
  [file: string]: {
    type: 'dependency' | 'asset' | 'sharedlib',
    ignored: true | false,
    parents: string[]
  }
}
```

`reasons` also includes files that were ignored as `ignored: true`, with their `ignoreReason`.

Every file is included because it is referenced by another file. The `parents` list will contain the list of all files that caused this file to be included.
