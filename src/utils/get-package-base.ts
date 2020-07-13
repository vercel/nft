// returns the base-level package folder based on detecting "node_modules"
// package name boundaries
const pkgNameRegEx = /^(@[^\\\/]+[\\\/])?[^\\\/]+/;

export function getPackageBase(id: string): string | undefined {
  const pkgIndex = id.lastIndexOf('node_modules');
  if (pkgIndex !== -1 &&
      (id[pkgIndex - 1] === '/' || id[pkgIndex - 1] === '\\') &&
      (id[pkgIndex + 12] === '/' || id[pkgIndex + 12] === '\\')) {
    const pkgNameMatch = id.substr(pkgIndex + 13).match(pkgNameRegEx);
    if (pkgNameMatch)
      return id.substr(0, pkgIndex + 13 + pkgNameMatch[0].length);
  }
  return undefined;
}

export function getPackageName(id: string): string | undefined {
  const pkgIndex = id.lastIndexOf('node_modules');
  if (pkgIndex !== -1 &&
      (id[pkgIndex - 1] === '/' || id[pkgIndex - 1] === '\\') &&
      (id[pkgIndex + 12] === '/' || id[pkgIndex + 12] === '\\')) {
    const pkgNameMatch = id.substr(pkgIndex + 13).match(pkgNameRegEx);
    if (pkgNameMatch && pkgNameMatch.length > 0) {
      return pkgNameMatch[0].replace(/\\/g,  '/');
    }
  }
  return undefined;
};
