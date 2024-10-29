import { readdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const files = await readdir(__dirname);
for (const file of files.filter(f => f.startsWith('data-'))) {
  const url = `https://raw.githubusercontent.com/kangax/compat-table/gh-pages/${file}`;
  const res = await fetch(url);
  const text = await res.text();
  await writeFile(join(__dirname, file), text);
}
console.log('Update complete!')
