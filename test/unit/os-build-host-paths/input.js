const fs = require('fs');
const os = require('os');
const path = require('path');

fs.readFileSync(path.join(os.homedir(), process.env.HOME_FILE));
fs.readFileSync(path.join(os.tmpdir(), process.env.TMP_FILE));
