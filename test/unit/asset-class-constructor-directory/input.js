const fs = require("fs")
const path = require("path")

class Foobar {
  constructor(packagePath) {
    console.log(fs.readFileSync(path.join(packagePath, 'asset1.txt'), 'utf8'))
  }
}

new Foobar(__dirname)
