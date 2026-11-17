const { createStaticEvalVars } = require('../out/analyze.js');

const hasOwn = (obj, name) => Object.prototype.hasOwnProperty.call(obj, name);

// The eager copy that computePureStaticValue used to build on every call.
function copyVars(knownBindings, globals, importMeta) {
  const vars = Object.create(null);
  for (const name of Object.keys(globals))
    vars[name] = { value: globals[name] };
  for (const name of Object.keys(knownBindings)) {
    const binding = knownBindings[name];
    vars[name] = binding.shadowDepth === 0 ? binding.value : undefined;
  }
  vars['import.meta'] = importMeta;
  return vars;
}

function setup() {
  const knownBindings = Object.assign(Object.create(null), {
    __dirname: { shadowDepth: 0, value: { value: '/app' } },
    URL: { shadowDepth: 0, value: { value: 'known URL' } },
    process: { shadowDepth: 1, value: { value: 'shadowed process' } },
  });
  const globals = {
    URL: 'global URL',
    process: 'global process',
    Buffer: 'global Buffer',
    MONGOOSE_DRIVER_PATH: undefined,
  };
  const importMeta = {
    url: 'file:///app/index.js',
    dirname: '/app',
    filename: '/app/index.js',
  };
  const vars = createStaticEvalVars(knownBindings, globals, importMeta);
  return { knownBindings, globals, importMeta, vars };
}

const PROTOTYPE_NAMES = [
  'toString',
  'constructor',
  'hasOwnProperty',
  '__proto__',
];

test('matches the eager copy for every lookup', () => {
  const { knownBindings, globals, importMeta, vars } = setup();
  const copy = copyVars(knownBindings, globals, importMeta);
  const names = [
    'import.meta',
    ...Object.keys(knownBindings),
    ...Object.keys(globals),
    'missing',
    ...PROTOTYPE_NAMES,
  ];
  for (const name of names) {
    expect([name, hasOwn(vars, name), name in vars, vars[name]]).toEqual([
      name,
      hasOwn(copy, name),
      name in copy,
      copy[name],
    ]);
  }
});

test('looks up import.meta, then known bindings, then globals', () => {
  const { vars } = setup();
  expect(vars['import.meta']).toEqual({
    url: 'file:///app/index.js',
    dirname: '/app',
    filename: '/app/index.js',
  });
  expect(vars.URL).toEqual({ value: 'known URL' });
  expect(vars.Buffer).toEqual({ value: 'global Buffer' });
});

test('a shadowed binding is present with an undefined value', () => {
  const { vars } = setup();
  expect(hasOwn(vars, 'process')).toBe(true);
  expect('process' in vars).toBe(true);
  expect(vars.process).toBeUndefined();
});

test('a global with an undefined value is present', () => {
  const { vars } = setup();
  expect(hasOwn(vars, 'MONGOOSE_DRIVER_PATH')).toBe(true);
  expect('MONGOOSE_DRIVER_PATH' in vars).toBe(true);
  expect(vars.MONGOOSE_DRIVER_PATH).toEqual({ value: undefined });
});

test('Object.prototype members and symbols do not leak in', () => {
  const { vars } = setup();
  for (const name of [...PROTOTYPE_NAMES, Symbol.iterator]) {
    expect(hasOwn(vars, name)).toBe(false);
    expect(name in vars).toBe(false);
    expect(vars[name]).toBeUndefined();
  }
});

test('sees bindings that change after creation', () => {
  const { knownBindings, vars } = setup();
  knownBindings.later = { shadowDepth: 0, value: { value: 'later' } };
  knownBindings.process.shadowDepth = 0;
  delete knownBindings.__dirname;
  expect(vars.later).toEqual({ value: 'later' });
  expect(vars.process).toEqual({ value: 'shadowed process' });
  expect('__dirname' in vars).toBe(false);
});

test('rejects writes', () => {
  const { vars } = setup();
  expect(() => {
    vars.URL = { value: 'overwritten' };
  }).toThrow('read-only');
  expect(vars.URL).toEqual({ value: 'known URL' });
});
