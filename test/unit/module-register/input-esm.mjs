import { register } from 'module';

// Load relative to the current file
register('./hook.mjs', import.meta.url);
// Load from a bare specifier
register('test-pkg', import.meta.url);