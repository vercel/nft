import { marker } from '#internal/marker.js';
import { dollar } from '#a$&b.js';
import { main } from '#lib/feature/index.js';
import { specific } from '#precedence.js';
import { external } from '#dep/thing.js';
import { externalDollar } from '#dep/a$&b.js';

import('#missing/thing.js').catch(() => {});

console.log(marker, dollar, main, specific, external, externalDollar);
