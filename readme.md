# Node File Trace

[![Build Status](https://circleci.com/gh/zeit/node-file-trace.svg?&style=shield)](https://circleci.com/gh/zeit/workflows/node-file-trace)
[![codecov](https://codecov.io/gh/zeit/node-file-trace/branch/master/graph/badge.svg)](https://codecov.io/gh/zeit/node-file-trace)

Node file tracer used in now-node to determine exactly which files (including from node_modules) are necessary for the application runtime.

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

```js
const { fileList } = await nodeFileTrace(files, {
  base: process.cwd()
}
```

If no base is provided, absolute paths are always output.

By default any files below the `base` are ignored in the listing and analysis.

#### FilterBase

Boolean, defaults to true.

```js
const { fileList } = await nodeFileTrace(files, {
  base: process.cwd(),
  filterBase: false
}
```

By setting this to `false`, it allows opting out of excluding any files below the `base` path in the list.

#### Ignore

Custom ignores can be provided to skip file inclusion (and consequently analysis of the file for references in turn as well).

```js
const { fileList } = await nodeFileTrace(files, {
  ignore: ['./node_modules/pkg/file.js']
});
```

Ignore will also accept a function or globs.

Note that the path provided to ignore is relative to `base`.

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
