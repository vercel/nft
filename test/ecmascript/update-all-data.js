const { readdir, writeFile } = require('fs/promises');
const { join } = require('path');

async function main() {
  const files = await readdir(__dirname);
  for (const file of files.filter(f => f.startsWith('data-'))) {
    const url = `https://raw.githubusercontent.com/kangax/compat-table/gh-pages/${file}`;
    const res = await fetch(url);
    const text = await res.text();
    await writeFile(join(__dirname, file), text);
  }
}

main().then(() => console.log('Done.')).catch(e => console.error(e));
