import { Job } from './node-file-trace';

export interface Stats {
  isFile(): boolean;
  isDirectory(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
}

export interface NodeFileTraceOptions {
  base?: string;
  processCwd?: string;
  exports?: string[];
  exportsOnly?: boolean;
  ignore?: string | string[] | ((path: string) => boolean);
  analysis?: boolean | {
    emitGlobs?: boolean;
    computeFileReferences?: boolean;
    evaluatePureExpressions?: boolean;
  };
  cache?: any;
  paths?: Record<string, string>;
  ts?: boolean;
  log?: boolean;
  mixedModules?: boolean;
  readFile?: (path: string) => Buffer | string | null;
  stat?: (path: string) => Stats | null;
  readlink?: (path: string) => string | null;
  resolve?: (id: string, parent: string, job: Job, cjsResolve: boolean) => string | string[];
}

export interface NodeFileTraceReasons {
  [fileName: string]: {
    type: string;
    ignored: boolean;
    parents: string[];
  };
}

export interface NodeFileTraceResult {
  fileList: string[];
  esmFileList: string[];
  reasons: NodeFileTraceReasons;
  warnings: Error[];
}

export interface StaticValue {
  value: any;
  wildcards?: string[];
}

export interface ConditionalValue {
  test: string;
  then: any;
  else: any;
}

export type EvaluatedValue = StaticValue | ConditionalValue | undefined;
