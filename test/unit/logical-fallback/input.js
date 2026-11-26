const path = require('path');
const fs = require('fs');
const filePath = process.argv[2];
fs.readFileSync(path.join(process.cwd(), filePath || 'file.json'));
fs.readFileSync(path.join(__dirname, filePath ?? 'other.json'));
