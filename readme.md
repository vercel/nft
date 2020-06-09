# Node File Trace

[![CI Status](https://badgen.net/github/checks/vercel/node-file-trace?label=CI)](https://github.com/vercel/node-file-trace/actions?workflow=CI)
[![Code Coverage](https://badgen.net/codecov/c/github/vercel/node-file-trace)](https://codecov.io/gh/vercel/node-file-trace)

This package is used in [@vercel/node](https://npmjs.com/package/@vercel/node) and [@vercel/next](https://npmjs.com/package/@vercel/next) to determine exactly which files (including `node_modules`) are necessary for the application runtime.

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

#### Process Cwd

When applying analysis certain functions rely on the `process.cwd()` value, such as `path.resolve('./relative')` or even a direct `process.cwd()`
invocation.

Setting the `processCwd` option allows this analysis to be guided to the right path to ensure that assets are correctly detected.

```js
const { fileList } = await nodeFileTrace(files, {
  processCwd: path.resolve(__dirname)
}
```

By default `processCwd` is the same as `base`.

#### Paths

> Status: Experimental. May change at any time.

Custom resolution path definitions to use.

```js
const { fileList } = await nodeFileTrace(files, {
  paths: {
    'utils/': '/path/to/utils/'
  }
});
```

Trailing slashes map directories, exact paths map exact only.

#### Hooks

The following FS functions can be hooked by passing them as options:

* `readFile(path): Promise<string>`
* `stat(path): Promise<FS.Stats>`
* `readlink(path): Promise<string>`

#### TypeScript

The internal resolution supports resolving `.ts` files in traces by default.

By its nature of integrating into existing build systems, the TypeScript
compiler is not included in this project - rather the TypeScript transform
layer requires separate integration into the `readFile` hook.

#### Analysis

Analysis options allow customizing how much analysis should be performed to exactly work out the dependency list.

By default as much analysis as possible is done to ensure no possibly needed files are left out of the trace.

To disable all analysis, set `analysis: false`. Alternatively, individual analysis options can be customized via:

```js
const { fileList } = await nodeFileTrace(files, {
  // default
  analysis: {
    // whether to glob any analysis like __dirname + '/dir/' or require('x/' + y)
    // that might output any file in a directory
    emitGlobs: true,
    // whether __filename and __dirname style
    // expressions should be analyzed as file references
    computeFileReferences: true,
    // evaluate known bindings to assist with glob and file reference analysis
    evaluatePureExpressions: true,
  }
});
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
