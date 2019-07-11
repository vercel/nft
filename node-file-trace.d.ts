interface NodeFileTraceOptions {
  base?: string;
  ignore?: string | string[] | ((path: string) => boolean);
  ts?: boolean;
  log?: boolean;
  readFile?: (path: string) => Buffer | string | null;
  stat?: (path: string) => Object | null;
  readlink?: (path: string) => string | null;
}

declare function NodeFileTrace (files: string[], opts: NodeFileTraceOptions): Promise<{ fileList: string[], esmFileList: string[] }>;

export = NodeFileTrace;
