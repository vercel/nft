/**
 * Gets the major version of the current Node.js runtime
 * @returns The major version number (e.g., 22 for Node.js v22.16.0)
 */
export function getNodeMajorVersion(): number {
  return parseInt(process.versions.node.split('.')[0], 10);
}
