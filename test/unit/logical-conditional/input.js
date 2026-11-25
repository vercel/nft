const file = false || (process.env.USE_A ? './a' : './b');
require(file);
