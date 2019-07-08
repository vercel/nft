interface NodeFileTraceOptions {
  base?: string;
  filterBase?: boolean;
  ignore?: string | string[] | ((path: string) => boolean);
  ts?: boolean;
  
  readFile?: (path: string) => Buffer | string | null;
  isDir?: (path: string) => boolean;
}

declare function NodeFileTrace (files: string[], opts: NodeFileTraceOptions): Promise<{ fileList: string[], esmFileList: string[] }>;

export = NodeFileTrace;
