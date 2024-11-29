const replacer = (key: string, value: unknown) => {
  if (typeof value === 'object') {
    if (key === 'globalThis') {
      return '[globalThis]';
    }
    if (key === 'global') {
      return '[global]';
    }
    if (key === 'GLOBAL') {
      return '[GLOBAL]';
    }
    if (key === 'process') {
      return '[process]';
    }
    if (key === 'win32') {
      // path.win32
      return '[win32]';
    }
    if (key === 'posix') {
      // path.posix
      return '[posix]';
    }
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value === 'bigint') {
    return '[bigint]';
  }
  return value;
};
export function safeStringify(obj: unknown) {
  return JSON.stringify(obj, replacer);
}
