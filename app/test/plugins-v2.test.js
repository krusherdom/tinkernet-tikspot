// Tests for the plugin-engine v2 expansion (Stage 0.15):
// app/src/plugins/{recipe,template,parsers,match,engine}.js
//
// Covers: declared secretKeys/params + paramValues coercion + stripSecrets;
// renderJsonTemplate typed placeholders + omitEmpty pruning; `[n]` array
// indexing in renderTemplate; multi-step lookups with forEach enrichment,
// the maxFanOut/request-cap limits, and `optional` steps; match.minRules;
// auth.tokenExpiryPath caching; 401/403 re-auth-and-retry; and the 'sql'
// parse.dateFormat. All engine tests use a stub `http` — no real network.
//
// v1 recipes (plugins/demo-hotel-*.json, examples/guest-api/recipes/*.json)
// are covered by test/plugins.test.js and are NOT re-tested here; this file
// only exercises what's new in v2.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateRecipe, emptyRecipe, stripSecrets } from '../src/plugins/recipe.js';
import { renderTemplate, renderJsonTemplate } from '../src/plugins/template.js';
import { parseDate } from '../src/plugins/parsers.js';
import { matchRecord } from '../src/plugins/match.js';
import { runLookup, makeTokenCache } from '../src/plugins/engine.js';

// ---------------------------------------------------------------------------
// recipe.js — secretKeys / secretLabels / stripSecrets
// ---------------------------------------------------------------------------

function baseRecipe(overrides = {}) {
  return {
    name: 'Test Plugin',
    request: { method: 'GET', url: 'http://example.com/guests?room={{input.room}}', contentType: 'json' },
    parse: { type: 'json', root: 'guests', fields: { room: 'room', lastName: 'lastName' }, dateFormat: 'iso' },
    match: { all: true, rules: [{ input: 'room', field: 'room', normalize: 'trim' }] },
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
    ...overrides,
  };
}

test('emptyRecipe: v1 default secretKeys, and a v1 recipe (no secretKeys) still validates + strips to the 3-key trio', () => {
  const empty = emptyRecipe();
  assert.deepEqual(empty.secretKeys, ['username', 'password', 'apiKey']);
  assert.deepEqual(empty.secrets, { username: '', password: '', apiKey: '' });

  const v1 = validateRecipe(baseRecipe({ secrets: { username: 'u', password: 'p', apiKey: 'k' } }));
  assert.equal(v1.ok, true, JSON.stringify(v1.fields));
  assert.deepEqual(v1.value.secretKeys, ['username', 'password', 'apiKey']);
  assert.equal(v1.value.version, 2);

  const stripped = stripSecrets(v1.value);
  assert.deepEqual(stripped.secrets, { username: '', password: '', apiKey: '' });
  assert.equal(v1.value.secrets.username, 'u'); // original untouched
});

test('validateRecipe: declared secretKeys generalise the secrets object + stripSecrets', () => {
  const recipe = baseRecipe({
    secretKeys: ['agentId', 'agentPassword', 'clientId', 'clientPassword'],
    secretLabels: { agentId: 'Agent ID', clientId: 'Client ID' },
    secrets: { agentId: '123', agentPassword: 'pw', clientId: '', clientPassword: 'cpw', bogus: 'ignored' },
  });
  const v = validateRecipe(recipe);
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  assert.deepEqual(v.value.secrets, { agentId: '123', agentPassword: 'pw', clientId: '', clientPassword: 'cpw' });
  assert.equal(v.value.secretLabels.agentId, 'Agent ID');
  assert.equal('bogus' in v.value.secrets, false);

  const stripped = stripSecrets(v.value);
  assert.deepEqual(stripped.secrets, { agentId: '', agentPassword: '', clientId: '', clientPassword: '' });
});

test('validateRecipe: secretKeys rejects bad names, duplicates, and more than 16 keys', () => {
  const badName = validateRecipe(baseRecipe({ secretKeys: ['1bad'] }));
  assert.equal(badName.ok, false);
  assert.ok(badName.fields['secretKeys[0]']);

  const dup = validateRecipe(baseRecipe({ secretKeys: ['a', 'a'] }));
  assert.equal(dup.ok, false);

  const tooMany = validateRecipe(baseRecipe({ secretKeys: Array.from({ length: 17 }, (_, i) => `k${i}`) }));
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.fields.secretKeys);
});

// ---------------------------------------------------------------------------
// recipe.js — params / paramValues
// ---------------------------------------------------------------------------

test('validateRecipe: params default types, and paramValues coercion by type', () => {
  const recipe = baseRecipe({
    params: {
      baseUrl: { label: 'Region', type: 'select', default: 'us', options: [{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }] },
      propertyId: { label: 'Property', type: 'number' },
      training: { label: 'Training DB', type: 'boolean', default: false },
      moduleType: { label: 'Module', type: 'text', default: 'distribution' },
    },
    paramValues: { baseUrl: 'eu', propertyId: '42', training: 'true' },
  });
  const v = validateRecipe(recipe);
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  assert.equal(v.value.paramValues.baseUrl, 'eu');
  assert.equal(v.value.paramValues.propertyId, 42);
  assert.equal(v.value.paramValues.training, true);
  assert.equal(v.value.paramValues.moduleType, 'distribution'); // missing -> default
});

test('validateRecipe: paramValues fails on a non-numeric number, non-boolean boolean, and an out-of-set select', () => {
  const recipe = baseRecipe({
    params: {
      n: { label: 'N', type: 'number' },
      b: { label: 'B', type: 'boolean' },
      s: { label: 'S', type: 'select', options: [{ value: 'a', label: 'A' }] },
    },
    paramValues: { n: 'not-a-number', b: 'maybe', s: 'not-declared' },
  });
  const v = validateRecipe(recipe);
  assert.equal(v.ok, false);
  assert.ok(v.fields['paramValues.n']);
  assert.ok(v.fields['paramValues.b']);
  assert.ok(v.fields['paramValues.s']);
});

test('validateRecipe: an optional (empty, no default) number/select paramValue is left empty, not failed', () => {
  const recipe = baseRecipe({
    params: {
      propertyId: { label: 'Property', type: 'number' },
      region: { label: 'Region', type: 'select', options: [{ value: 'us', label: 'US' }] },
    },
  });
  const v = validateRecipe(recipe);
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  assert.equal(v.value.paramValues.propertyId, '');
  assert.equal(v.value.paramValues.region, '');
});

test('emptyRecipe gains secretKeys/params/paramValues', () => {
  const empty = emptyRecipe();
  assert.deepEqual(empty.params, {});
  assert.deepEqual(empty.paramValues, {});
});

// ---------------------------------------------------------------------------
// recipe.js — match.minRules
// ---------------------------------------------------------------------------

test('validateRecipe: match.minRules accepts 0..rules.length, rejects out of range', () => {
  const recipe = baseRecipe({
    inputs: [
      { name: 'room', label: 'Room', type: 'text', required: true },
      { name: 'lastname', label: 'Last name', type: 'text' },
    ],
    match: {
      all: true,
      rules: [
        { input: 'room', field: 'room', normalize: 'trim' },
        { input: 'lastname', field: 'lastName', normalize: 'name' },
      ],
      minRules: 2,
    },
  });
  const v = validateRecipe(recipe);
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  assert.equal(v.value.match.minRules, 2);

  const tooHigh = validateRecipe({ ...recipe, match: { ...recipe.match, minRules: 3 } });
  assert.equal(tooHigh.ok, false);
  assert.ok(tooHigh.fields['match.minRules']);
});

test('matchRecord: minRules requires N *matched, non-empty* rules on top of the all/any check', () => {
  const record = { room: '101', lastName: 'Smith', email: 'smith@example.com' };
  const rules = [
    { input: 'room', field: 'room', normalize: 'trim' },
    { input: 'lastname', field: 'lastName', normalize: 'name' },
    { input: 'email', field: 'email', normalize: 'email' },
  ];
  // room (required) + lastName match; email input left blank (optional, not required) -> passes
  // the all-check vacuously but only 2 rules were *satisfied* (non-empty + matched).
  const inputsTwoSatisfied = [
    { name: 'room', value: '101', required: true },
    { name: 'lastname', value: 'Smith', required: false },
    { name: 'email', value: '', required: false },
  ];
  assert.equal(matchRecord({ all: true, rules, minRules: 0 }, record, inputsTwoSatisfied), true);
  assert.equal(matchRecord({ all: true, rules, minRules: 2 }, record, inputsTwoSatisfied), true);
  assert.equal(matchRecord({ all: true, rules, minRules: 3 }, record, inputsTwoSatisfied), false, 'only 2 rules were actually satisfied');

  // Only room supplied -> 1 satisfied rule -> fails minRules:2.
  const inputsOneSatisfied = [
    { name: 'room', value: '101', required: true },
    { name: 'lastname', value: '', required: false },
    { name: 'email', value: '', required: false },
  ];
  assert.equal(matchRecord({ all: true, rules, minRules: 2 }, record, inputsOneSatisfied), false);
});

// ---------------------------------------------------------------------------
// template.js — renderJsonTemplate (typed placeholders + omitEmpty)
// ---------------------------------------------------------------------------

test('renderJsonTemplate: typed placeholders coerce int/number/bool/raw/string', () => {
  const vars = { input: { count: '7', ratio: '3.5', flag: 'true', name: 'Ann' }, param: { obj: { a: 1, b: [1, 2] } } };
  const tree = {
    asInt: '{{int:input.count}}',
    asNumber: '{{number:input.ratio}}',
    asBool: '{{bool:input.flag}}',
    asRaw: '{{raw:param.obj}}',
    asString: '{{string:input.count}}',
    plain: 'room-{{input.name}}',
  };
  const out = renderJsonTemplate(tree, vars, { omitEmpty: false });
  assert.equal(out.asInt, 7);
  assert.equal(out.asNumber, 3.5);
  assert.equal(out.asBool, true);
  assert.deepEqual(out.asRaw, { a: 1, b: [1, 2] });
  assert.equal(out.asString, '7');
  assert.equal(out.plain, 'room-Ann');
});

test('renderJsonTemplate: int/number/bool treat empty or unparseable input as empty (pruned)', () => {
  const vars = { input: { count: '', bogus: 'not-a-number' } };
  const tree = { a: '{{int:input.count}}', b: '{{number:input.bogus}}', c: '{{bool:input.count}}' };
  const out = renderJsonTemplate(tree, vars, { omitEmpty: false });
  assert.equal(out.a, '');
  assert.equal(out.b, '');
  assert.equal(out.c, '');
});

test('renderJsonTemplate: omitEmpty (default true) recursively prunes empty leaves, arrays-of-blanks included; literal booleans/numbers survive', () => {
  const vars = { input: { name: '', keep: 'x' } };
  const tree = {
    surnames: ['{{input.name}}'],
    kept: ['{{input.keep}}'],
    nested: { empty: '', deeplyEmpty: { a: '' } },
    zero: 0,
    falseFlag: false,
    literalTrue: true,
  };
  const out = renderJsonTemplate(tree, vars); // default omitEmpty:true
  assert.deepEqual(out, { kept: ['x'], zero: 0, falseFlag: false, literalTrue: true });

  const unpruned = renderJsonTemplate(tree, vars, { omitEmpty: false });
  assert.deepEqual(unpruned.surnames, ['']);
  assert.deepEqual(unpruned.nested, { empty: '', deeplyEmpty: { a: '' } });
});

test('renderJsonTemplate: request.bodyJson forces contentType to json and defaults omitEmpty true (validated shape)', () => {
  const v = validateRecipe(
    baseRecipe({
      request: {
        method: 'POST',
        url: 'http://example.com/search',
        contentType: 'form', // should be overridden to 'json'
        bodyJson: { room: '{{input.room}}', propertyIds: ['{{int:param.propertyId}}'] },
      },
      params: { propertyId: { label: 'Property', type: 'number' } },
    }),
  );
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  assert.equal(v.value.request.contentType, 'json');
  assert.deepEqual(v.value.request.bodyJson, { room: '{{input.room}}', propertyIds: ['{{int:param.propertyId}}'] });
});

// ---------------------------------------------------------------------------
// template.js — `[n]` index support in renderTemplate (via parsers.js getPath)
// ---------------------------------------------------------------------------

test('renderTemplate: supports [n] array indexing into vars', () => {
  const vars = { steps: { res: { records: [{ guestId: 'g1' }, { guestId: 'g2' }] } } };
  assert.equal(renderTemplate('{{steps.res.records[0].guestId}}', vars, {}), 'g1');
  assert.equal(renderTemplate('{{steps.res.records[1].guestId}}', vars, {}), 'g2');
  assert.equal(renderTemplate('{{steps.res.records[9].guestId}}', vars, {}), '');
});

// ---------------------------------------------------------------------------
// parsers.js — 'sql' dateFormat
// ---------------------------------------------------------------------------

test("parseDate: 'sql' format (YYYY-MM-DD HH:MM:SS or YYYY-MM-DD), interpreted as UTC", () => {
  assert.equal(parseDate('2026-03-01 14:30:00', 'sql'), Date.UTC(2026, 2, 1, 14, 30, 0));
  assert.equal(parseDate('2026-03-01', 'sql'), Date.UTC(2026, 2, 1, 0, 0, 0));
  assert.equal(parseDate('not-a-date', 'sql'), null);
  assert.equal(parseDate('', 'sql'), null);
});

// ---------------------------------------------------------------------------
// engine.js — steps[] / forEach / maxFanOut / optional / request cap
// ---------------------------------------------------------------------------

function stepsRecipeRaw(overrides = {}) {
  return {
    name: 'RMS-like',
    inputs: [
      { name: 'room', label: 'Room', type: 'text', required: true },
      { name: 'lastname', label: 'Last name', type: 'text' },
    ],
    steps: [
      {
        name: 'reservations',
        request: { method: 'GET', url: 'http://example.com/reservations?room={{input.room}}', contentType: 'json' },
        parse: { type: 'json', root: '', fields: { guestId: 'guestId', room: 'room', lastName: 'lastName', checkIn: 'checkIn', checkOut: 'checkOut' }, dateFormat: 'iso' },
      },
      {
        name: 'guest',
        forEach: 'reservations',
        request: { method: 'GET', url: 'http://example.com/guests/{{record.guestId}}', contentType: 'json' },
        parse: { type: 'json', root: '', fields: { email: 'email', mobile: 'mobile' }, dateFormat: 'iso' },
      },
    ],
    match: { all: true, rules: [{ input: 'room', field: 'room', normalize: 'trim' }] },
    ...overrides,
  };
}

function validated(raw) {
  const v = validateRecipe(raw);
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  return v.value;
}

test('runLookup: forEach enriches the parent record, only filling empty/missing fields', () => {
  const recipe = validated(stepsRecipeRaw());
  const http = async (req) => {
    if (req.url.includes('/reservations')) {
      return {
        status: 200,
        headers: {},
        text: JSON.stringify([{ guestId: 1, room: '101', lastName: 'Smith', checkIn: '2026-01-01T00:00:00Z', checkOut: '2026-01-10T00:00:00Z' }]),
        ms: 1,
      };
    }
    if (req.url.endsWith('/guests/1')) {
      return { status: 200, headers: {}, text: JSON.stringify({ email: 'smith@example.com', mobile: '111' }), ms: 1 };
    }
    throw new Error(`unexpected url ${req.url}`);
  };
  return runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.parse('2026-01-05T00:00:00Z'), http }).then((result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.guest.record.email, 'smith@example.com');
    assert.equal(result.guest.record.mobile, '111');
    assert.equal(result.guest.record.lastName, 'Smith'); // untouched, already present
  });
});

test('runLookup: maxFanOut caps how many parent records get enriched', async () => {
  const recipe = validated(stepsRecipeRaw({ maxFanOut: 1 }));
  let guestCalls = 0;
  const http = async (req) => {
    if (req.url.includes('/reservations')) {
      return {
        status: 200,
        headers: {},
        text: JSON.stringify([
          { guestId: 1, room: '101', lastName: 'Smith' },
          { guestId: 2, room: '101', lastName: 'Smith' },
        ]),
        ms: 1,
      };
    }
    guestCalls += 1;
    return { status: 200, headers: {}, text: JSON.stringify({ email: 'e@example.com' }), ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http, diagnostics: true });
  assert.equal(guestCalls, 1, 'maxFanOut:1 should only enrich the first parent record');
  assert.equal(result.ok, true, JSON.stringify(result));
  const guestStep = result.steps.find((s) => s.name === 'guest');
  assert.equal(guestStep.status, 'ok');
});

test('runLookup: optional forEach step failure is ignored (record stays unenriched, lookup still succeeds)', async () => {
  const raw = stepsRecipeRaw();
  raw.steps[1].optional = true;
  raw.match = { all: true, rules: [{ input: 'lastname', field: 'lastName', normalize: 'name' }] };
  raw.inputs = [{ name: 'lastname', label: 'Last name', type: 'text', required: true }];
  const optionalRecipe = validated(raw);

  const http = async (req) => {
    if (req.url.includes('/reservations')) {
      return { status: 200, headers: {}, text: JSON.stringify([{ guestId: 2, room: '102', lastName: 'Jones' }]), ms: 1 };
    }
    throw Object.assign(new Error('guest lookup timed out'), { code: 'TIMEOUT' });
  };
  const result = await runLookup({ recipe: optionalRecipe, inputs: [{ name: 'lastname', value: 'Jones', required: true }], now: Date.now(), http });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.guest.record.email, undefined);
});

test('runLookup: a NON-optional forEach step failure fails the whole lookup', async () => {
  const raw = stepsRecipeRaw();
  raw.match = { all: true, rules: [{ input: 'lastname', field: 'lastName', normalize: 'name' }] };
  raw.inputs = [{ name: 'lastname', label: 'Last name', type: 'text', required: true }];
  const recipe = validated(raw);

  const http = async (req) => {
    if (req.url.includes('/reservations')) {
      return { status: 200, headers: {}, text: JSON.stringify([{ guestId: 3, room: '103', lastName: 'Jones' }]), ms: 1 };
    }
    return { status: 500, headers: {}, text: 'boom', ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'lastname', value: 'Jones', required: true }], now: Date.now(), http });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
  assert.equal(result.status, 500);
});

test('runLookup: the 25-request hard cap trips when a main step + forEach fan-out would exceed it', async () => {
  const parents = Array.from({ length: 30 }, (_, i) => ({ guestId: i + 1, room: '101', lastName: 'Smith' }));
  const raw = stepsRecipeRaw({ maxFanOut: 25 });
  const recipe = validated(raw);
  let httpCalls = 0;
  const http = async (req) => {
    httpCalls += 1;
    if (req.url.includes('/reservations')) {
      return { status: 200, headers: {}, text: JSON.stringify(parents), ms: 1 };
    }
    return { status: 200, headers: {}, text: JSON.stringify({ email: 'e@example.com' }), ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
  assert.equal(result.detail, 'request-cap');
  assert.equal(httpCalls, 25, '1 main request + 24 successful enrich requests before the 25th (26th overall) is blocked');
});

test('runLookup: diagnostics:true returns a steps[] array with {name,status,ms,records}; omitted by default', async () => {
  const recipe = validated(stepsRecipeRaw());
  const http = async (req) => {
    if (req.url.includes('/reservations')) {
      return { status: 200, headers: {}, text: JSON.stringify([{ guestId: 1, room: '101', lastName: 'Smith' }]), ms: 1 };
    }
    return { status: 200, headers: {}, text: JSON.stringify({ email: 'e@example.com' }), ms: 1 };
  };
  const withDiag = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http, diagnostics: true });
  assert.equal(withDiag.ok, true);
  assert.equal(Array.isArray(withDiag.steps), true);
  assert.deepEqual(
    withDiag.steps.map((s) => s.name),
    ['reservations', 'guest'],
  );
  for (const s of withDiag.steps) {
    assert.equal(typeof s.status, 'string');
    assert.equal(typeof s.ms, 'number');
    assert.equal(typeof s.records, 'number');
  }

  const withoutDiag = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http });
  assert.equal('steps' in withoutDiag, false);
});

// ---------------------------------------------------------------------------
// engine.js — auth.tokenExpiryPath caching
// ---------------------------------------------------------------------------

function authRecipeRaw(overrides = {}) {
  return baseRecipe({
    auth: {
      method: 'POST',
      url: 'http://example.com/authToken',
      contentType: 'json',
      bodyTemplate: '{}',
      tokenPath: 'token',
      tokenExpiryPath: 'expiryDate',
      tokenTtlSecs: 3600,
      placement: { in: 'header', name: 'authtoken', prefix: '' },
    },
    secrets: { username: 'u', password: 'p', apiKey: '' },
    ...overrides,
  });
}

test('engine: auth.tokenExpiryPath caches the token until (server expiry - 60s), bounded by tokenTtlSecs', async () => {
  const recipe = validateRecipe(authRecipeRaw()).value;
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  // Server says the token expires in 10 minutes — well inside the 1h tokenTtlSecs bound.
  const expiryIso = new Date(now + 10 * 60 * 1000).toISOString();
  let authCalls = 0;
  const http = async (req) => {
    if (req.url.includes('/authToken')) {
      authCalls += 1;
      return { status: 200, headers: {}, text: JSON.stringify({ token: 'tok-1', expiryDate: expiryIso }), ms: 1 };
    }
    return { status: 200, headers: {}, text: JSON.stringify({ guests: [{ room: '101', lastName: 'Smith' }] }), ms: 1 };
  };
  const tokenCache = makeTokenCache();

  await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now, http, tokenCache });
  assert.equal(authCalls, 1);

  // Just before the (expiry - 60s) boundary: still cached.
  await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: now + 8 * 60 * 1000, http, tokenCache });
  assert.equal(authCalls, 1, 'token should still be cached shortly before expiry-60s');

  // Past (expiry - 60s): must refetch.
  await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: now + 10 * 60 * 1000, http, tokenCache });
  assert.equal(authCalls, 2, 'token should be refetched once past expiry-60s');
});

test('validateRecipe: auth.placement.prefix "" is honoured as empty (no default "Bearer " injected)', () => {
  const v = validateRecipe(authRecipeRaw());
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  assert.equal(v.value.auth.placement.prefix, '');
});

// ---------------------------------------------------------------------------
// engine.js — 401/403 re-auth-and-retry
// ---------------------------------------------------------------------------

test('engine: a 401 on a lookup step using a CACHED token triggers one re-auth + retry, which then succeeds', async () => {
  const recipe = validateRecipe(authRecipeRaw()).value;
  const tokenCache = makeTokenCache();
  tokenCache.set(recipe.id || recipe.name, { token: 'stale-token', expiresAtMs: Date.now() + 3600_000 });

  let authCalls = 0;
  let guestCalls = 0;
  const http = async (req) => {
    if (req.url.includes('/authToken')) {
      authCalls += 1;
      return { status: 200, headers: {}, text: JSON.stringify({ token: 'fresh-token' }), ms: 1 };
    }
    guestCalls += 1;
    if (req.headers.authtoken === 'stale-token') {
      return { status: 401, headers: {}, text: 'unauthorized', ms: 1 };
    }
    assert.equal(req.headers.authtoken, 'fresh-token');
    return { status: 200, headers: {}, text: JSON.stringify({ guests: [{ room: '101', lastName: 'Smith' }] }), ms: 1 };
  };

  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http, tokenCache });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(authCalls, 1, 'should fetch exactly one fresh token after the cached one was rejected');
  assert.equal(guestCalls, 2, 'the failed request + the retry');
  assert.deepEqual(tokenCache.get(recipe.id || recipe.name).token, 'fresh-token');
});

test('engine: if the retry also fails, the result is upstream with the retry status', async () => {
  const recipe = validateRecipe(authRecipeRaw()).value;
  const tokenCache = makeTokenCache();
  tokenCache.set(recipe.id || recipe.name, { token: 'stale-token', expiresAtMs: Date.now() + 3600_000 });

  let authCalls = 0;
  const http = async (req) => {
    if (req.url.includes('/authToken')) {
      authCalls += 1;
      return { status: 200, headers: {}, text: JSON.stringify({ token: 'still-bad-token' }), ms: 1 };
    }
    return { status: 403, headers: {}, text: 'forbidden', ms: 1 };
  };

  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http, tokenCache });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
  assert.equal(result.status, 403);
  assert.equal(authCalls, 1, 'exactly one re-auth attempt, no infinite retry loop');
});

test('engine: a 401 on a FRESHLY-minted token (not from cache) is not retried', async () => {
  const recipe = validateRecipe(authRecipeRaw()).value;
  const tokenCache = makeTokenCache(); // empty — this run's token comes fresh from the auth call
  let authCalls = 0;
  let guestCalls = 0;
  const http = async (req) => {
    if (req.url.includes('/authToken')) {
      authCalls += 1;
      return { status: 200, headers: {}, text: JSON.stringify({ token: 'fresh-token' }), ms: 1 };
    }
    guestCalls += 1;
    return { status: 401, headers: {}, text: 'unauthorized', ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http, tokenCache });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
  assert.equal(result.status, 401);
  assert.equal(authCalls, 1, 'no second auth call — the token was already fresh');
  assert.equal(guestCalls, 1, 'no retry — the token was already fresh');
});

test('url templates insert param values verbatim but still escape guest input', () => {
  const vars = { param: { baseUrl: 'http://10.0.0.5:8091' }, input: { room: 'a b/c' } };
  const out = renderTemplate('{{param.baseUrl}}/rooms/{{input.room}}', vars, { escape: 'url' });
  assert.equal(out, 'http://10.0.0.5:8091/rooms/a%20b%2Fc');
});

test('only param placeholders may lead a URL; guest input cannot supply the origin', () => {
  const base = { ...emptyRecipe(), name: 'u', inputs: [{ name: 'room', required: true }], match: { rules: [{ input: 'room', field: 'room' }] }, parse: { type: 'json', fields: { room: 'room' } } };
  const okP = validateRecipe({ ...base, params: { baseUrl: { type: 'text', default: 'https://x' } }, request: { url: '{{param.baseUrl}}/a' } });
  assert.equal(okP.ok, true);
  const badI = validateRecipe({ ...base, request: { url: '{{input.room}}/a' } });
  assert.equal(badI.ok, false);
  assert.ok(badI.fields['request.url']);
});

test('declared param defaults are coerced by type', () => {
  const base = { ...emptyRecipe(), name: 'd', inputs: [{ name: 'room', required: true }], match: { rules: [{ input: 'room', field: 'room' }] }, parse: { type: 'json', fields: { room: 'room' } }, request: { url: 'http://x/' } };
  const v = validateRecipe({ ...base, params: { t: { type: 'boolean', default: 'false' }, n: { type: 'number', default: '7' } } });
  assert.equal(v.ok, true);
  assert.equal(v.value.params.t.default, false);
  assert.equal(v.value.params.n.default, 7);
  assert.equal(v.value.paramValues.t, false);
});

test('name matching treats hyphens and word breaks as optional', () => {
  const spec = { all: true, rules: [{ input: 'name', field: 'lastName', normalize: 'name' }] };
  const inp = (v) => [{ name: 'name', required: true, value: v }];
  assert.equal(matchRecord(spec, { lastName: 'Smith-Jones' }, inp('smith jones')), true);
  assert.equal(matchRecord(spec, { lastName: 'Smith-Jones' }, inp('smithjones')), true);
  assert.equal(matchRecord(spec, { lastName: "O'Brien" }, inp('obrien')), true);
  assert.equal(matchRecord(spec, { lastName: 'Smith-Jones' }, inp('smith')), false);
});
