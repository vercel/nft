// Test that querystrings of various forms get stripped from esm imports when those
// imports contain the `.mjs` file extension

import * as aardvark from "./animalFacts/aardvark.mjs?anteater";

console.log(`Aardvarks eat ${aardvark.food}.`);
