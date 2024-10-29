import { readdir, writeFile } from 'fs/promises';

const dir = new URL('./', import.meta.url);
const files = await readdir(dir);

for (const file of files.filter(f => f.startsWith('data-'))) {
  const url = `https://raw.githubusercontent.com/kangax/compat-table/gh-pages/${file}`;
  const res = await fetch(url);
  const text = await res.text();
  await writeFile(new URL(file, dir), text);
}

console.log('Update complete!')
