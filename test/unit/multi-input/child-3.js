const fs = require('fs')
const { join } = require('path')

fs.readFileSync(join(__dirname, 'asset.txt'))
