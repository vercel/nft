// Test that if a file and the same file with a querystring correspond to different
// modules in memory, one can successfully import the other. The import chain
// goes `input` (this file) -> `base?__withQuery` -> `base` -> `dep`, which means
// that if `dep` shows up in `output`, we know that both `base?__withQuery` and
// `base` have been loaded successfully.

import * as baseWithQuery from './base?__withQuery';
console.log('Dogs:', baseWithQuery.dogs);
console.log('Cats:', baseWithQuery.cats);
console.log('Rats:', baseWithQuery.rats);
