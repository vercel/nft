// Test that querystrings of various forms get stripped from esm imports

import * as aardvark from './animalFacts/aardvark?anteater';

console.log(`Aardvarks eat ${aardvark.food}.`);
