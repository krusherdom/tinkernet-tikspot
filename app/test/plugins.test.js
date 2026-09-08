// Tests for the pluggable guest-lookup login engine (Stage 0.13):
// app/src/plugins/{recipe,template,parsers,match,http,engine}.js
//
// Includes an integration test that spawns the zero-dependency demo guest
// API at examples/guest-api/server.js on an ephemeral port and drives all
// three sample recipes against it with the real (non-stubbed) httpRequest.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderTemplate, templateVars } from '../src/plugins/template.js';
import { getPath, parseResponse, parseDate } from '../src/plugins/parsers.js';
import { normalize, matchRecord, findGuest, inWindow } from '../src/plugins/match.js';
import { validateRecipe, emptyRecipe, stripSecrets, CANONICAL_FIELDS, NORMALIZERS } from '../src/plugins/recipe.js';
import { runLookup, makeTokenCache } from '../src/plugins/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const GUEST_API_DIR = path.join(REPO_ROOT, 'examples', 'guest-api');

// -----------------------------------------------------------------------
// template.js
// -----------------------------------------------------------------------

test('renderTemplate substitutes {{a.b}} and treats missing vars as empty', () => {
  const vars = { input: { room: '101' }, token: 'abc', secret: { apiKey: 'k' } };
  assert.equal(renderTemplate('room={{input.room}}&t={{token}}', vars, {}), 'room=101&t=abc');
  assert.equal(renderTemplate('missing={{input.nope}}', vars, {}), 'missing=');
  assert.equal(renderTemplate('', vars, {}), '');
  assert.equal(renderTemplate(null, vars, {}), '');
});

test('renderTemplate escape modes', () => {
  const vars = { input: { v: 'a & b <c> "d" \'e\' f g' } };
  assert.equal(renderTemplate('{{input.v}}', vars, { escape: 'none' }), 'a & b <c> "d" \'e\' f g');
  assert.equal(
    renderTemplate('{{input.v}}', vars, { escape: 'json' }),
    JSON.stringify('a & b <c> "d" \'e\' f g').slice(1, -1),
  );
  assert.equal(renderTemplate('{{input.v}}', { input: { v: 'a b' } }, { escape: 'form' }), 'a+b');
  assert.equal(
    renderTemplate('{{input.v}}', { input: { v: '<a>&"\'' } }, { escape: 'xml' }),
    '&lt;a&gt;&amp;&quot;&apos;',
  );
  assert.equal(renderTemplate('{{input.v}}', { input: { v: 'a/b c' } }, { escape: 'url' }), 'a%2Fb%20c');
});

test('renderTemplate strips CR/LF from substituted values regardless of mode', () => {
  const vars = { input: { v: 'line1\r\nline2' } };
  assert.equal(renderTemplate('X-Custom: {{input.v}}', vars, { escape: 'none' }), 'X-Custom: line1  line2');
});

test('templateVars accepts array-of-inputs-with-value, and plain object maps', () => {
  const recipe = { secrets: { apiKey: 'k1', username: 'u', password: 'p' } };
  const fromArray = templateVars(recipe, [{ name: 'room', value: '101', required: true }], 'tok', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(fromArray.input, { room: '101' });
  assert.equal(fromArray.token, 'tok');
  assert.equal(fromArray.secret.apiKey, 'k1');
  assert.equal(fromArray.now, '2026-01-01T00:00:00.000Z');

  const fromObject = templateVars(recipe, { room: '202' }, '', undefined);
  assert.deepEqual(fromObject.input, { room: '202' });
  assert.equal(fromObject.token, '');
  assert.equal(typeof fromObject.now, 'string');
});

// -----------------------------------------------------------------------
// parsers.js — getPath
// -----------------------------------------------------------------------

test('getPath: dot paths, array index, wildcard fan-out, empty path', () => {
  const obj = { a: { b: [{ c: 1 }, { c: 2 }, { c: 3 }] }, top: 'x' };
  assert.equal(getPath(obj, ''), obj);
  assert.equal(getPath(obj, 'top'), 'x');
  assert.equal(getPath(obj, 'a.b[0].c'), 1);
  assert.equal(getPath(obj, 'a.b[2].c'), 3);
  assert.deepEqual(getPath(obj, 'a.b[*].c'), [1, 2, 3]);
  assert.equal(getPath(obj, 'a.b[9].c'), undefined);
  assert.equal(getPath(obj, 'missing.path'), undefined);
  assert.equal(getPath(null, 'a.b'), undefined);
});

test('getPath: wildcard over object values', () => {
  const obj = { people: { p1: { name: 'A' }, p2: { name: 'B' } } };
  assert.deepEqual(getPath(obj, 'people[*].name').sort(), ['A', 'B']);
});

// -----------------------------------------------------------------------
// parsers.js — parseResponse (json / xml / regex)
// -----------------------------------------------------------------------

test('parseResponse json: array root, mapped fields', () => {
  const body = JSON.stringify({
    guests: [
      { firstName: 'Ann', lastName: 'Lee', room: '5', checkIn: '2026-01-01', checkOut: '2026-01-05' },
      { firstName: 'Bo', lastName: 'Kim', room: '6', checkIn: '2026-02-01', checkOut: '2026-02-05' },
    ],
  });
  const parse = {
    type: 'json',
    root: 'guests',
    fields: { firstName: 'firstName', lastName: 'lastName', room: 'room' },
  };
  const { records } = parseResponse(parse, body);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { firstName: 'Ann', lastName: 'Lee', room: '5' });
});

test('parseResponse json: single-object root is wrapped as one record; root:"" is the whole body', () => {
  const body = JSON.stringify({ firstName: 'Solo', room: '9' });
  const { records } = parseResponse({ type: 'json', root: '', fields: { firstName: 'firstName', room: 'room' } }, body);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { firstName: 'Solo', room: '9' });
});

test('parseResponse xml: single and multiple sibling elements both normalise to arrays', () => {
  const single = '<guests><guest><firstName>Ann</firstName><room>5</room></guest></guests>';
  const multi =
    '<guests><guest><firstName>Ann</firstName><room>5</room></guest>' +
    '<guest><firstName>Bo</firstName><room>6</room></guest></guests>';
  const parse = { type: 'xml', root: 'guests.guest', fields: { firstName: 'firstName', room: 'room' } };

  const r1 = parseResponse(parse, single);
  assert.equal(r1.records.length, 1);
  assert.deepEqual(r1.records[0], { firstName: 'Ann', room: '5' });

  const r2 = parseResponse(parse, multi);
  assert.equal(r2.records.length, 2);
  assert.deepEqual(r2.records[1], { firstName: 'Bo', room: '6' });
});

test('parseResponse xml: attributes are reachable via @name', () => {
  const xml = '<guests><guest id="7"><firstName>Ann</firstName></guest></guests>';
  const parse = { type: 'xml', root: 'guests.guest', fields: { firstName: 'firstName', id: '@id' } };
  const { records } = parseResponse(parse, xml);
  assert.deepEqual(records[0], { firstName: 'Ann', id: '7' });
});

test('parseResponse regex: recordRegex with named groups, one match per record', () => {
  const text =
    'Guest: Ann Lee | Room: 5 | CheckIn: 2026-01-01 | CheckOut: 2026-01-05\n' +
    'Guest: Bo Kim | Room: 6 | CheckIn: 2026-02-01 | CheckOut: 2026-02-05\n';
  const parse = {
    type: 'regex',
    recordRegex:
      'Guest: (?<firstName>\\S+) (?<lastName>\\S+) \\| Room: (?<room>\\S+) \\| CheckIn: (?<checkIn>\\S+) \\| CheckOut: (?<checkOut>\\S+)',
    fields: { firstName: 'firstName', lastName: 'lastName', room: 'room', checkIn: 'checkIn', checkOut: 'checkOut' },
  };
  const { records } = parseResponse(parse, text);
  assert.equal(records.length, 2);
  assert.equal(records[0].firstName, 'Ann');
  assert.equal(records[1].room, '6');
});

test('parseResponse regex: empty recordRegex treats whole body as one record, each field its own regex', () => {
  const text = 'Name: Ann Lee. Room number: 12.';
  const parse = {
    type: 'regex',
    recordRegex: '',
    fields: { firstName: 'Name: (\\S+)', room: 'Room number: (\\d+)' },
  };
  const { records } = parseResponse(parse, text);
  assert.equal(records.length, 1);
  assert.equal(records[0].firstName, 'Ann');
  assert.equal(records[0].room, '12');
});

// -----------------------------------------------------------------------
// parsers.js — parseDate
// -----------------------------------------------------------------------

test('parseDate handles iso, dmy, mdy, ymd, epoch(seconds/ms), and invalid input', () => {
  assert.equal(parseDate('2026-01-02T03:04:05Z', 'iso'), Date.parse('2026-01-02T03:04:05Z'));
  assert.equal(parseDate('25/12/2026', 'dmy'), Date.UTC(2026, 11, 25));
  assert.equal(parseDate('12/25/2026', 'mdy'), Date.UTC(2026, 11, 25));
  assert.equal(parseDate('2026-12-25', 'ymd'), Date.UTC(2026, 11, 25));
  assert.equal(parseDate(1893456000, 'epoch'), 1893456000 * 1000); // seconds
  assert.equal(parseDate(1893456000000, 'epoch'), 1893456000000); // ms
  assert.equal(parseDate('not-a-date', 'iso'), null);
  assert.equal(parseDate('', 'iso'), null);
  assert.equal(parseDate(null, 'iso'), null);
  assert.equal(parseDate('32/13/2026', 'dmy') !== undefined, true); // doesn't throw
});

// -----------------------------------------------------------------------
// match.js
// -----------------------------------------------------------------------

test('normalize: trim/name/phone/digits/email/upper', () => {
  assert.equal(normalize('  Room 5  ', 'trim'), 'Room 5');
  assert.equal(normalize("José  O'Brien-Smith", 'name'), 'jose obrien smith');
  assert.equal(normalize('+44 (0) 7700-900123', 'phone'), '4407700900123');
  assert.equal(normalize('+44 (0) 7700-900123', 'digits'), '4407700900123');
  assert.equal(normalize('  Foo@BAR.com ', 'email'), 'foo@bar.com');
  assert.equal(normalize(' abc ', 'upper'), 'ABC');
  assert.equal(normalize(null, 'trim'), '');
});

test('matchRecord: all/any semantics, anyOf, and empty-input-on-non-required-field passes', () => {
  const record = { room: '101', firstName: 'Jane', lastName: 'Smith' };
  const rules = [
    { input: 'room', field: 'room', normalize: 'trim' },
    { input: 'name', anyOf: ['firstName', 'lastName'], normalize: 'name' },
  ];
  const inputsGood = [
    { name: 'room', value: '101', required: true },
    { name: 'name', value: 'smith', required: true },
  ];
  assert.equal(matchRecord({ all: true, rules }, record, inputsGood), true);

  const inputsWrongRoom = [
    { name: 'room', value: '999', required: true },
    { name: 'name', value: 'smith', required: true },
  ];
  assert.equal(matchRecord({ all: true, rules }, record, inputsWrongRoom), false);
  // `all:false` (any-of-rules): one rule matching is enough.
  assert.equal(matchRecord({ all: false, rules }, record, inputsWrongRoom), true);

  // Empty input on a non-required field passes that rule automatically.
  const rulesOptionalName = [
    { input: 'room', field: 'room', normalize: 'trim' },
    { input: 'name', anyOf: ['firstName', 'lastName'], normalize: 'name' },
  ];
  const inputsEmptyOptional = [
    { name: 'room', value: '101', required: true },
    { name: 'name', value: '', required: false },
  ];
  assert.equal(matchRecord({ all: true, rules: rulesOptionalName }, record, inputsEmptyOptional), true);

  // Empty input on a *required* field fails that rule (and thus the match).
  const inputsEmptyRequired = [
    { name: 'room', value: '101', required: true },
    { name: 'name', value: '', required: true },
  ];
  assert.equal(matchRecord({ all: true, rules: rulesOptionalName }, record, inputsEmptyRequired), false);
});

test('matchRecord: phone normalize compares the last 9 digits when both sides have >= 9', () => {
  const record = { mobile: '+44 7700 900123' };
  const rules = [{ input: 'mobile', field: 'mobile', normalize: 'phone' }];
  const local = [{ name: 'mobile', value: '07700900123', required: true }]; // UK local form
  assert.equal(matchRecord({ all: true, rules }, record, local), true);
  const wrong = [{ name: 'mobile', value: '07700900000', required: true }];
  assert.equal(matchRecord({ all: true, rules }, record, wrong), false);
});

test('findGuest returns the first matching record or null', () => {
  const records = [
    { room: '1', firstName: 'A' },
    { room: '2', firstName: 'B' },
  ];
  const rules = [{ input: 'room', field: 'room', normalize: 'trim' }];
  const found = findGuest({ all: true, rules }, records, [{ name: 'room', value: '2', required: true }]);
  assert.equal(found.firstName, 'B');
  const notFound = findGuest({ all: true, rules }, records, [{ name: 'room', value: '9', required: true }]);
  assert.equal(notFound, null);
});

test('inWindow: two-sided leeway, expiry cap via maxGrantHours, missing dates, and no-window default', () => {
  const iso = (s) => Date.parse(s);
  const parseIso = (v) => iso(v);
  const windowSpec = { start: 'checkIn', end: 'checkOut', leewayHours: 24, maxGrantHours: 168 };

  // Squarely inside the stay.
  const midStay = { checkIn: '2026-01-05T00:00:00Z', checkOut: '2026-01-10T00:00:00Z' };
  const okMid = inWindow(windowSpec, midStay, iso('2026-01-07T00:00:00Z'), parseIso);
  assert.equal(okMid.ok, true);
  assert.equal(okMid.expiresAt, new Date(iso('2026-01-11T00:00:00Z')).toISOString());

  // Just inside the pre-checkin leeway.
  const okLeewayStart = inWindow(windowSpec, midStay, iso('2026-01-04T01:00:00Z'), parseIso);
  assert.equal(okLeewayStart.ok, true);

  // Before the leeway window -> not-started.
  const notStarted = inWindow(windowSpec, midStay, iso('2026-01-03T00:00:00Z'), parseIso);
  assert.equal(notStarted.ok, false);
  assert.equal(notStarted.reason, 'not-started');

  // After checkout + leeway -> ended.
  const ended = inWindow(windowSpec, midStay, iso('2026-01-12T00:00:00Z'), parseIso);
  assert.equal(ended.ok, false);
  assert.equal(ended.reason, 'ended');

  // maxGrantHours caps expiresAt even when checkout+leeway is further out.
  const shortGrant = inWindow(
    { start: 'checkIn', end: 'checkOut', leewayHours: 24, maxGrantHours: 6 },
    midStay,
    iso('2026-01-07T00:00:00Z'),
    parseIso,
  );
  assert.equal(shortGrant.ok, true);
  assert.equal(shortGrant.expiresAt, new Date(iso('2026-01-07T06:00:00Z')).toISOString());

  // Missing dates.
  const missing = inWindow(windowSpec, { checkIn: '2026-01-01T00:00:00Z' }, iso('2026-01-02T00:00:00Z'), parseIso);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-dates');

  // No window at all -> always ok, granted maxGrantHours (default 168) from now.
  const noWindow = inWindow(undefined, {}, iso('2026-01-01T00:00:00Z'), parseIso);
  assert.equal(noWindow.ok, true);
  assert.equal(noWindow.expiresAt, new Date(iso('2026-01-01T00:00:00Z') + 168 * 3600 * 1000).toISOString());
});

// -----------------------------------------------------------------------
// recipe.js — validateRecipe
// -----------------------------------------------------------------------

function baseRecipe(overrides = {}) {
  return {
    name: 'Test Hotel',
    request: { method: 'GET', url: 'http://example.com/guests?room={{input.room}}', contentType: 'json' },
    parse: {
      type: 'json',
      root: 'guests',
      fields: { firstName: 'firstName', lastName: 'lastName', room: 'room', checkIn: 'checkIn', checkOut: 'checkOut' },
      dateFormat: 'iso',
    },
    match: {
      all: true,
      rules: [
        { input: 'room', field: 'room', normalize: 'trim' },
        { input: 'name', anyOf: ['firstName', 'lastName'], normalize: 'name' },
      ],
    },
    window: { start: 'checkIn', end: 'checkOut', leewayHours: 24, maxGrantHours: 168 },
    inputs: [
      { name: 'room', label: 'Room', type: 'text', required: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
    ],
    ...overrides,
  };
}

test('validateRecipe: accepts a well-formed recipe and normalises defaults', () => {
  const result = validateRecipe(baseRecipe());
  assert.equal(result.ok, true);
  assert.equal(result.value.name, 'Test Hotel');
  assert.equal(result.value.enabled, true);
  assert.equal(result.value.timeoutMs, 8000);
  assert.equal(result.value.match.rules.length, 2);
  assert.equal(result.value.version, 2); // RECIPE_VERSION bumped to 2 in Stage 0.15 (plugin engine expansion)
});

test('validateRecipe: rejects a non-http(s) request url', () => {
  const result = validateRecipe(baseRecipe({ request: { method: 'GET', url: 'ftp://example.com/x', contentType: 'json' } }));
  assert.equal(result.ok, false);
  assert.ok(result.fields['request.url']);
});

test('validateRecipe: rejects a match rule referencing an undeclared input', () => {
  const recipe = baseRecipe();
  recipe.match.rules.push({ input: 'nonexistent', field: 'room', normalize: 'trim' });
  const result = validateRecipe(recipe);
  assert.equal(result.ok, false);
  assert.ok(Object.keys(result.fields).some((k) => k.includes('input')));
});

test('validateRecipe: rejects an unknown normalizer', () => {
  const recipe = baseRecipe();
  recipe.match.rules[0].normalize = 'reverse-psychology';
  const result = validateRecipe(recipe);
  assert.equal(result.ok, false);
  assert.ok(Object.keys(result.fields).some((k) => k.includes('normalize')));
});

test('validateRecipe: rejects a window date not present in parse.fields', () => {
  const recipe = baseRecipe({ window: { start: 'checkIn', end: 'notAField', leewayHours: 24, maxGrantHours: 168 } });
  const result = validateRecipe(recipe);
  assert.equal(result.ok, false);
  assert.ok(result.fields['window.end']);
});

test('validateRecipe: duplicate/invalid input names are rejected', () => {
  const recipe = baseRecipe();
  recipe.inputs.push({ name: 'room', label: 'Dup', type: 'text' }); // duplicate
  const dup = validateRecipe(recipe);
  assert.equal(dup.ok, false);

  const bad = validateRecipe(baseRecipe({ inputs: [{ name: 'Room#1', label: 'Bad', type: 'text' }] }));
  assert.equal(bad.ok, false);
});

test('emptyRecipe/stripSecrets/CANONICAL_FIELDS/NORMALIZERS sanity', () => {
  const empty = emptyRecipe();
  assert.equal(validateRecipe({ ...empty, name: 'x', inputs: [], match: { all: true, rules: [] } }).ok, false); // no match rules
  assert.ok(CANONICAL_FIELDS.includes('room'));
  assert.ok(NORMALIZERS.includes('phone'));

  const withSecrets = { ...baseRecipe(), secrets: { username: 'u', password: 'p', apiKey: 'k' } };
  const stripped = stripSecrets(withSecrets);
  assert.deepEqual(stripped.secrets, { username: '', password: '', apiKey: '' });
  assert.equal(withSecrets.secrets.username, 'u'); // original untouched
});

// -----------------------------------------------------------------------
// engine.js — runLookup with a stubbed http
// -----------------------------------------------------------------------

function jsonRecipeWithAuth() {
  const v = validateRecipe(
    baseRecipe({
      auth: {
        method: 'POST',
        url: 'http://example.com/auth/token',
        contentType: 'json',
        bodyTemplate: '{"username":"{{secret.username}}","password":"{{secret.password}}"}',
        tokenPath: 'token',
        tokenTtlSecs: 3600,
        placement: { in: 'header', name: 'Authorization', prefix: 'Bearer ' },
      },
      secrets: { username: 'frontdesk', password: 'letmein', apiKey: '' },
    }),
  );
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  return v.value;
}

const sampleGuestsBody = JSON.stringify({
  guests: [
    {
      firstName: 'Jane',
      lastName: 'Smith',
      room: '101',
      checkIn: '2026-01-01T00:00:00Z',
      checkOut: '2026-01-10T00:00:00Z',
    },
  ],
});

const inputsFor = (room, name) => [
  { name: 'room', value: room, required: true },
  { name: 'name', value: name, required: true },
];

test('runLookup: auth token flow + token cache hit (auth only called once)', async () => {
  const recipe = jsonRecipeWithAuth();
  let authCalls = 0;
  let guestCalls = 0;
  const http = async (req) => {
    if (req.url.includes('/auth/token')) {
      authCalls += 1;
      return { status: 200, headers: {}, text: JSON.stringify({ token: 'tok-123' }), ms: 1 };
    }
    guestCalls += 1;
    assert.equal(req.headers.Authorization, 'Bearer tok-123');
    return { status: 200, headers: {}, text: sampleGuestsBody, ms: 1 };
  };
  const tokenCache = makeTokenCache();
  const now = Date.parse('2026-01-05T00:00:00Z');

  const first = await runLookup({ recipe, inputs: inputsFor('101', 'Smith'), now, http, tokenCache });
  assert.equal(first.ok, true);
  assert.equal(first.guest.label, 'Jane Smith · room 101');
  assert.equal(first.expiresAt, new Date(Date.parse('2026-01-11T00:00:00Z')).toISOString());

  const second = await runLookup({ recipe, inputs: inputsFor('101', 'Smith'), now, http, tokenCache });
  assert.equal(second.ok, true);
  assert.equal(authCalls, 1, 'second lookup should reuse the cached token');
  assert.equal(guestCalls, 2);
});

test('runLookup: no-match', async () => {
  const recipe = jsonRecipeWithAuth();
  const http = async (req) =>
    req.url.includes('/auth/token')
      ? { status: 200, headers: {}, text: JSON.stringify({ token: 't' }), ms: 1 }
      : { status: 200, headers: {}, text: sampleGuestsBody, ms: 1 };
  const result = await runLookup({
    recipe,
    inputs: inputsFor('999', 'Nobody'),
    now: Date.parse('2026-01-05T00:00:00Z'),
    http,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'no-match' });
});

test('runLookup: outside-window', async () => {
  const recipe = jsonRecipeWithAuth();
  const http = async (req) =>
    req.url.includes('/auth/token')
      ? { status: 200, headers: {}, text: JSON.stringify({ token: 't' }), ms: 1 }
      : { status: 200, headers: {}, text: sampleGuestsBody, ms: 1 };
  const result = await runLookup({
    recipe,
    inputs: inputsFor('101', 'Smith'),
    now: Date.parse('2026-02-01T00:00:00Z'), // long after checkout+leeway
    http,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside-window');
  assert.equal(result.detail, 'ended');
});

test('runLookup: upstream on non-2xx guest response', async () => {
  const recipe = jsonRecipeWithAuth();
  const http = async (req) =>
    req.url.includes('/auth/token')
      ? { status: 200, headers: {}, text: JSON.stringify({ token: 't' }), ms: 1 }
      : { status: 500, headers: {}, text: 'boom', ms: 1 };
  const result = await runLookup({
    recipe,
    inputs: inputsFor('101', 'Smith'),
    now: Date.parse('2026-01-05T00:00:00Z'),
    http,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
  assert.equal(result.status, 500);
});

test('runLookup: auth failure (wrong credentials) maps to upstream', async () => {
  const recipe = jsonRecipeWithAuth();
  const http = async (req) =>
    req.url.includes('/auth/token')
      ? { status: 401, headers: {}, text: JSON.stringify({ error: 'invalid credentials' }), ms: 1 }
      : { status: 200, headers: {}, text: sampleGuestsBody, ms: 1 };
  const result = await runLookup({
    recipe,
    inputs: inputsFor('101', 'Smith'),
    now: Date.parse('2026-01-05T00:00:00Z'),
    http,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'upstream' });
});

test('runLookup: a thrown TIMEOUT error maps to reason "timeout"', async () => {
  const recipe = jsonRecipeWithAuth();
  const http = async (req) => {
    if (req.url.includes('/auth/token')) {
      return { status: 200, headers: {}, text: JSON.stringify({ token: 't' }), ms: 1 };
    }
    throw Object.assign(new Error('request timed out'), { code: 'TIMEOUT' });
  };
  const result = await runLookup({
    recipe,
    inputs: inputsFor('101', 'Smith'),
    now: Date.parse('2026-01-05T00:00:00Z'),
    http,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

test('runLookup: never leaks secrets or the bearer token into the result', async () => {
  const recipe = jsonRecipeWithAuth();
  const http = async (req) =>
    req.url.includes('/auth/token')
      ? { status: 200, headers: {}, text: JSON.stringify({ token: 'super-secret-token' }), ms: 1 }
      : { status: 200, headers: {}, text: sampleGuestsBody, ms: 1 };
  const result = await runLookup({
    recipe,
    inputs: inputsFor('101', 'Smith'),
    now: Date.parse('2026-01-05T00:00:00Z'),
    http,
    tokenCache: makeTokenCache(),
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('super-secret-token'), false);
  assert.equal(serialized.includes('letmein'), false);
});

// -----------------------------------------------------------------------
// Integration: spawn the real demo guest API and drive all three recipes
// through runLookup with the real httpRequest.
// -----------------------------------------------------------------------

const FIXED_ANCHOR_ISO = '2025-06-15T12:00:00Z'; // must match examples/guest-api/server.js's FIXED_ANCHOR_MS
const FIXED_ANCHOR_MS = Date.parse(FIXED_ANCHOR_ISO);

let child;
let baseUrl;

before(async () => {
  const serverPath = path.join(GUEST_API_DIR, 'server.js');
  assert.ok(fs.existsSync(serverPath), `expected ${serverPath} to exist`);

  child = spawn(process.execPath, [serverPath], {
    cwd: GUEST_API_DIR,
    env: { ...process.env, PORT: '0', FIXED_DATES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  baseUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
      if (m) {
        child.stdout.off('data', onData);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`guest-api server exited early (code ${code})`)));
    setTimeout(() => reject(new Error('timed out waiting for guest-api server to start')), 10000);
  });
});

after(() => {
  if (child && !child.killed) child.kill();
});

function loadExampleRecipe(name, base) {
  const raw = JSON.parse(fs.readFileSync(path.join(GUEST_API_DIR, 'recipes', `${name}.json`), 'utf8'));
  const rewrite = (s) => s.replace('http://192.168.1.10:8090', base);
  if (raw.auth) raw.auth.url = rewrite(raw.auth.url);
  raw.request.url = rewrite(raw.request.url);
  const v = validateRecipe(raw);
  assert.equal(v.ok, true, `${name} should validate: ${JSON.stringify(v.fields)}`);
  return v.value;
}

for (const recipeName of ['hotel-json', 'hotel-xml', 'hotel-regex']) {
  test(`integration (${recipeName}): match room 101 -> ok with expiresAt`, async () => {
    const { httpRequest } = await import('../src/plugins/http.js');
    const recipe = loadExampleRecipe(recipeName, baseUrl);
    const result = await runLookup({
      recipe,
      inputs: inputsFor('101', 'Sato'),
      now: FIXED_ANCHOR_MS,
      http: httpRequest,
      tokenCache: makeTokenCache(),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(typeof result.expiresAt, 'string');
    assert.match(result.guest.label, /Sato/);
  });

  test(`integration (${recipeName}): checked-out guest (room 106) -> outside-window`, async () => {
    const { httpRequest } = await import('../src/plugins/http.js');
    const recipe = loadExampleRecipe(recipeName, baseUrl);
    const result = await runLookup({
      recipe,
      inputs: inputsFor('106', 'Fitzgerald'),
      now: FIXED_ANCHOR_MS,
      http: httpRequest,
      tokenCache: makeTokenCache(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'outside-window');
  });

  test(`integration (${recipeName}): unknown guest -> no-match`, async () => {
    const { httpRequest } = await import('../src/plugins/http.js');
    const recipe = loadExampleRecipe(recipeName, baseUrl);
    const result = await runLookup({
      recipe,
      inputs: inputsFor('999', 'Nobody'),
      now: FIXED_ANCHOR_MS,
      http: httpRequest,
      tokenCache: makeTokenCache(),
    });
    assert.deepEqual(result, { ok: false, reason: 'no-match' });
  });
}

test('integration (hotel-json): wrong password -> upstream', async () => {
  const { httpRequest } = await import('../src/plugins/http.js');
  const recipe = loadExampleRecipe('hotel-json', baseUrl);
  recipe.secrets.password = 'wrong-password';
  const result = await runLookup({
    recipe,
    inputs: inputsFor('101', 'Sato'),
    now: FIXED_ANCHOR_MS,
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'upstream' });
});
