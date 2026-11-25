import fs from 'fs';
console.log(
  fs.readFileSync(
    new URL('./dict/dict.txt', import.meta.url.replace(/dist[\\\/]index.cjs$/, '')),
  ),
);
