// Test that CJS files treat question marks in filenames as any other character,
// matching Node behavior

// https://www.youtube.com/watch?v=2ve20PVNZ18

const baseball = require('./who?what?idk!');
console.log(baseball.players);
