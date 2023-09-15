// this will load the CJS export and should not be treated as ESM
const ec = require('@vercel/edge-config');

// this will cause the file to be treated as ESM
export default function foo() {}
