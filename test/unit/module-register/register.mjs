import { register } from 'module';
import { pathToFileURL } from 'url';

register('./hook.mjs', import.meta.url);
register('./hook2.mjs', pathToFileURL(__filename));