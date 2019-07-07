interface NodeFileTraceOptions {
  base?: string;
  filterBase?: boolean;
  ignore?: string | string[] | ((path: string) => boolean);
  
  readFile?: (path: string) => Promise<Buffer | string | null>;
  isDir?: (path: string) => Promise<boolean>;
}

declare function NodeFileTrace (files: string[], opts: NodeFileTraceOptions): Promise<{ fileList: string[] }>;

export = NodeFileTrace;
