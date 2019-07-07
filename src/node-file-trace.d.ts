interface NodeFileTraceOptions {
  base?: string;
  includeBase?: boolean;
  ignore?: string | string[] | ((path: string) => boolean);
}

type NodeFileTrace = (files: string[], opts: NodeFileTraceOptions) => Promise<{ fileList: string[] }>;

export = NodeFileTrace;
