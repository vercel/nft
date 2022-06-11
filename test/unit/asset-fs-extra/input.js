const fs = require("fs-extra");
console.log(fs.readFileSync(__dirname + "/asset1.txt"));
console.log(fs.readJsonSync(__dirname + "/asset2.json"));
