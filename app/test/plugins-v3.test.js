// Tests for the 0.16 engine additions:
// app/src/plugins/{template,recipe,parsers,engine}.js
//
// Covers: template helpers (base64/lower/upper/trim/urlencode/digits/date/
// today) incl. unknown-helper handling; declarative HTTP Basic auth
// (auth.basic / request.basic); the csv parser; the built-in guest-list
// source (source:'list', validation + runLookup({records})); and the three
// additive step features requested alongside this stage: steps[].
// requireRecords, steps[].paginate, and steps[].extra. All engine tests use
// a stub `http` — no real network. DB-backed list-source tests (store.js +
// admin routes + cascade delete) live in plugins-list-db.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTemplate, renderJsonTemplate, findUnknownHelpers } from '../src/plugins/template.js';
import { parseCsv, mapCsvFields, parseResponse } from '../src/plugins/parsers.js';
import { validateRecipe } from '../src/plugins/recipe.js';
import { runLookup, makeTokenCache } from '../src/plugins/engine.js';

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

function validated(raw) {
  const v = validateRecipe(raw);
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  return v.value;
}

// ---------------------------------------------------------------------------
// A. template.js — helpers
// ---------------------------------------------------------------------------

test('helper: {{base64:path}} — base64 of the UTF-8 value', () => {
  const vars = { input: { name: 'Ann Lee' } };
  assert.equal(renderTemplate('{{base64:input.name}}', vars, {}), Buffer.from('Ann Lee', 'utf8').toString('base64'));
  assert.equal(renderTemplate('{{base64:input.missing}}', vars, {}), '');
});

test('helper: {{lower:path}}, {{upper:path}}, {{trim:path}}', () => {
  const vars = { input: { name: '  Ann Lee  ' } };
  assert.equal(renderTemplate('{{lower:input.name}}', vars, {}), '  ann lee  ');
  assert.equal(renderTemplate('{{upper:input.name}}', vars, {}), '  ANN LEE  ');
  assert.equal(renderTemplate('{{trim:input.name}}', vars, {}), 'Ann Lee');
});

test('helper: {{urlencode:path}} — inserted as-is even when escape mode is "none"', () => {
  const vars = { input: { room: 'a b/c' } };
  assert.equal(renderTemplate('{{urlencode:input.room}}', vars, { escape: 'none' }), 'a%20b%2Fc');
  assert.equal(renderTemplate('room={{urlencode:input.room}}', vars, { escape: 'json' }), 'room=a%20b%2Fc');
});

test('helper: {{digits:path}} — digits only', () => {
  const vars = { input: { phone: '+44 (0) 7700 900123' } };
  assert.equal(renderTemplate('{{digits:input.phone}}', vars, {}), '4407700900123');
});

test('helper: {{date:<offset>}} / {{date:<offset>:<fmt>}} — ISO UTC of now+offset, injected now', () => {
  const vars = { now: '2026-09-09T10:00:00.000Z' };
  assert.equal(renderTemplate('{{date:0d}}', vars, {}), '2026-09-09T10:00:00.000Z');
  assert.equal(renderTemplate('{{date:-1d}}', vars, {}), '2026-09-08T10:00:00.000Z');
  assert.equal(renderTemplate('{{date:+36h}}', vars, {}), '2026-09-10T22:00:00.000Z');
  assert.equal(renderTemplate('{{date:-30m}}', vars, {}), '2026-09-09T09:30:00.000Z');
  assert.equal(renderTemplate('{{date:0d:ymd}}', vars, {}), '2026-09-09');
  assert.equal(renderTemplate('{{date:0d:sql}}', vars, {}), '2026-09-09 10:00:00');
  assert.equal(renderTemplate('{{date:0d:epoch}}', vars, {}), String(Math.floor(Date.parse(vars.now) / 1000)));
});

test('helper: {{today}} is shorthand for {{date:0d:ymd}}', () => {
  const vars = { now: '2026-09-09T23:59:59.000Z' };
  assert.equal(renderTemplate('{{today}}', vars, {}), '2026-09-09');
});

test('helper: an unknown helper name renders empty, both in renderTemplate and inside a renderJsonTemplate leaf', () => {
  const vars = { input: { x: 'y' } };
  assert.equal(renderTemplate('{{lowre:input.x}}', vars, {}), '');
  const out = renderJsonTemplate({ a: 'prefix-{{lowre:input.x}}-suffix' }, vars, { omitEmpty: false });
  assert.equal(out.a, 'prefix--suffix');
});

test('helper: findUnknownHelpers flags an unrecognised helper but leaves known helpers, "now"/"today", and plain vars alone', () => {
  assert.deepEqual(findUnknownHelpers('{{lowre:input.x}}'), ['lowre']);
  assert.deepEqual(findUnknownHelpers('{{lower:input.x}} and {{today}} and {{now}} and {{input.x}}'), []);
  assert.deepEqual(findUnknownHelpers(''), []);
});

test('validateRecipe: an unknown helper in request.url/headers/bodyTemplate is flagged', () => {
  const badUrl = validateRecipe(baseRecipe({ request: { method: 'GET', url: 'http://example.com/g?x={{lowre:input.room}}', contentType: 'json' } }));
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.fields['request.url'], /unknown template helper "lowre"/);

  const badHeader = validateRecipe(baseRecipe({ request: { method: 'GET', url: 'http://example.com/g', contentType: 'json', headers: { 'X-Foo': '{{oops:input.room}}' } } }));
  assert.equal(badHeader.ok, false);
  assert.match(badHeader.fields['request.headers.X-Foo'], /unknown template helper "oops"/);

  const goodBodyJson = validateRecipe(baseRecipe({ request: { method: 'POST', url: 'http://example.com/g', contentType: 'json', bodyJson: { room: '{{int:input.room}}', label: '{{today}}' } } }));
  assert.equal(goodBodyJson.ok, true, JSON.stringify(goodBodyJson.fields));

  const badBodyJson = validateRecipe(baseRecipe({ request: { method: 'POST', url: 'http://example.com/g', contentType: 'json', bodyJson: { room: '{{nope:input.room}}' } } }));
  assert.equal(badBodyJson.ok, false);
  assert.match(badBodyJson.fields['request.bodyJson'], /unknown template helper "nope"/);
});

// ---------------------------------------------------------------------------
// B. Declarative Basic auth
// ---------------------------------------------------------------------------

test('validateRecipe: auth.basic / request.basic require string user/pass (pass may be "")', () => {
  const ok = validateRecipe(baseRecipe({ auth: { method: 'POST', url: 'http://example.com/token', contentType: 'json', basic: { user: '{{secret.clientId}}', pass: '' } } }));
  assert.equal(ok.ok, true, JSON.stringify(ok.fields));
  assert.deepEqual(ok.value.auth.basic, { user: '{{secret.clientId}}', pass: '' });

  const bad = validateRecipe(baseRecipe({ auth: { method: 'POST', url: 'http://example.com/token', contentType: 'json', basic: { user: 123 } } }));
  assert.equal(bad.ok, false);
  assert.ok(bad.fields['auth.basic.user']);
  assert.ok(bad.fields['auth.basic.pass']);
});

test('engine: auth.basic sets Authorization: Basic base64(user:pass) on the token request; never appears in diagnostics', async () => {
  const recipe = validated(
    baseRecipe({
      auth: {
        method: 'POST',
        url: 'http://example.com/token',
        contentType: 'json',
        bodyTemplate: '{}',
        basic: { user: '{{secret.clientId}}', pass: '{{secret.clientSecret}}' },
      },
      secretKeys: ['clientId', 'clientSecret'],
      secrets: { clientId: 'abc', clientSecret: 'def' },
    }),
  );
  const expected = 'Basic ' + Buffer.from('abc:def', 'utf8').toString('base64');
  let seenAuthHeader;
  const http = async (req) => {
    if (req.url.includes('/token')) {
      seenAuthHeader = req.headers['Authorization'];
      return { status: 200, headers: {}, text: JSON.stringify({ token: 'tok' }), ms: 1 };
    }
    return { status: 200, headers: {}, text: JSON.stringify({ guests: [{ room: '101', lastName: 'Smith' }] }), ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http, diagnostics: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(seenAuthHeader, expected);
  assert.equal(JSON.stringify(result).includes('Basic '), false, 'the rendered Basic header must never appear in diagnostics/result');
});

test('engine: request.basic sets Authorization on the lookup request; a token placement targeting the same header wins', async () => {
  const withoutToken = validated(
    baseRecipe({ request: { method: 'GET', url: 'http://example.com/guests?room={{input.room}}', contentType: 'json', basic: { user: 'u', pass: 'p' } } }),
  );
  let seen;
  const http = async (req) => {
    seen = req.headers['Authorization'];
    return { status: 200, headers: {}, text: JSON.stringify({ guests: [{ room: '101', lastName: 'Smith' }] }), ms: 1 };
  };
  const result = await runLookup({ recipe: withoutToken, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(seen, 'Basic ' + Buffer.from('u:p', 'utf8').toString('base64'));

  // Token placement targeting Authorization overwrites request.basic's header.
  const withToken = validated(
    baseRecipe({
      auth: { method: 'POST', url: 'http://example.com/token', contentType: 'json', bodyTemplate: '{}', placement: { in: 'header', name: 'Authorization', prefix: 'Bearer ' } },
      request: { method: 'GET', url: 'http://example.com/guests?room={{input.room}}', contentType: 'json', basic: { user: 'u', pass: 'p' } },
    }),
  );
  let seen2;
  const http2 = async (req) => {
    if (req.url.includes('/token')) return { status: 200, headers: {}, text: JSON.stringify({ token: 'tok-1' }), ms: 1 };
    seen2 = req.headers['Authorization'];
    return { status: 200, headers: {}, text: JSON.stringify({ guests: [{ room: '101', lastName: 'Smith' }] }), ms: 1 };
  };
  const result2 = await runLookup({ recipe: withToken, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http: http2 });
  assert.equal(result2.ok, true, JSON.stringify(result2));
  assert.equal(seen2, 'Bearer tok-1', 'token placement must win over request.basic on the same header');
});

test('engine: auth may be used without bodyTemplate/bodyJson (POST + form, empty body) — no crash, no Content-Length weirdness', async () => {
  const recipe = validated(
    baseRecipe({
      auth: { method: 'POST', url: 'http://example.com/token', contentType: 'form', placement: { in: 'header', name: 'Authorization', prefix: 'Bearer ' } },
    }),
  );
  let sawBody;
  const http = async (req) => {
    if (req.url.includes('/token')) {
      sawBody = req.body;
      return { status: 200, headers: {}, text: JSON.stringify({ token: 'tok' }), ms: 1 };
    }
    return { status: 200, headers: {}, text: JSON.stringify({ guests: [{ room: '101', lastName: 'Smith' }] }), ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(sawBody, undefined);
});

// ---------------------------------------------------------------------------
// C. CSV parser
// ---------------------------------------------------------------------------

test('parseCsv: quoted fields, doubled quotes, embedded delimiter/newline inside quotes', () => {
  const text = 'name,note\n"Smith, John","She said ""hi""\nline2"\nJones,plain';
  const { headers, rows } = parseCsv(text);
  assert.deepEqual(headers, ['name', 'note']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Smith, John');
  assert.equal(rows[0].note, 'She said "hi"\nline2');
  assert.equal(rows[1].name, 'Jones');
  assert.equal(rows[1].note, 'plain');
});

test('parseCsv: CRLF line endings and a leading UTF-8 BOM are handled transparently', () => {
  const text = '﻿room,name\r\n101,Ann\r\n102,Bea\r\n';
  const { headers, rows } = parseCsv(text);
  assert.deepEqual(headers, ['room', 'name']);
  assert.deepEqual(rows, [{ room: '101', name: 'Ann' }, { room: '102', name: 'Bea' }]);
});

test('parseCsv: delimiter ";" and "auto" sniffing', () => {
  const text = 'room;name\n101;Ann\n102;Bea';
  const bySemicolon = parseCsv(text, { delimiter: ';' });
  assert.deepEqual(bySemicolon.headers, ['room', 'name']);
  const byAuto = parseCsv(text, { delimiter: 'auto' });
  assert.deepEqual(byAuto.headers, ['room', 'name']);
  assert.deepEqual(byAuto.rows, bySemicolon.rows);
});

test('parseCsv: header:false uses #<index> keys', () => {
  const text = '101,Ann\n102,Bea';
  const { headers, rows } = parseCsv(text, { header: false });
  assert.deepEqual(headers, ['#0', '#1']);
  assert.deepEqual(rows, [{ '#0': '101', '#1': 'Ann' }, { '#0': '102', '#1': 'Bea' }]);
});

test('parseCsv: maxRows caps the number of data rows returned', () => {
  const text = 'room\n1\n2\n3\n4\n5';
  const { rows } = parseCsv(text, { maxRows: 2 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.room), ['1', '2']);
});

test('parseCsv: skipEmpty (default true) drops blank lines; a bare quote mid-field stays literal', () => {
  const text = 'room,name\n101,Ann\n\n102,Bea\n';
  const { rows } = parseCsv(text);
  assert.equal(rows.length, 2);

  const literalQuote = parseCsv('room\n12"A');
  assert.equal(literalQuote.rows[0].room, '12"A');
});

test('mapCsvFields: column names (case-insensitive) or #<index>; empty fieldsMap passes the row through', () => {
  const headers = ['Room', 'LastName'];
  const row = { Room: '101', LastName: 'Smith' };
  assert.deepEqual(mapCsvFields(row, headers, { room: 'room', lastName: '#1' }), { room: '101', lastName: 'Smith' });
  assert.deepEqual(mapCsvFields(row, headers, {}), { ...row });
});

test('parseResponse: parse.type "csv" end-to-end, including maxRecords honoured at parse time', () => {
  const body = 'room,lastName\n101,Smith\n102,Jones\n103,Lee';
  const { records } = parseResponse({ type: 'csv', header: true, fields: { room: 'room', lastName: 'lastName' } }, body, { maxRecords: 2 });
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { room: '101', lastName: 'Smith' });
});

test('validateRecipe: accept "csv" sets the Accept header via the engine', async () => {
  const recipe = validated(
    baseRecipe({
      request: { method: 'GET', url: 'http://example.com/guests.csv', contentType: 'json', accept: 'csv' },
      parse: { type: 'csv', header: true, fields: { room: 'room', lastName: 'lastName' } },
    }),
  );
  let acceptSeen;
  const http = async (req) => {
    acceptSeen = req.headers['Accept'];
    return { status: 200, headers: {}, text: 'room,lastName\n101,Smith', ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(acceptSeen, 'text/csv, text/plain;q=0.9, */*;q=0.8');
});

// ---------------------------------------------------------------------------
// D. Built-in guest-list source
// ---------------------------------------------------------------------------

function listRecipeRaw(overrides = {}) {
  return {
    name: 'Guest List',
    source: 'list',
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
    match: { all: true, rules: [{ input: 'room', field: 'room', normalize: 'trim' }] },
    ...overrides,
  };
}

test('validateRecipe: source:"list" rejects request/auth/steps', () => {
  const withRequest = validateRecipe(listRecipeRaw({ request: { method: 'GET', url: 'http://x/', contentType: 'json' } }));
  assert.equal(withRequest.ok, false);
  assert.ok(withRequest.fields.request);

  const withAuth = validateRecipe(listRecipeRaw({ auth: { method: 'POST', url: 'http://x/token', contentType: 'json' } }));
  assert.equal(withAuth.ok, false);
  assert.ok(withAuth.fields.auth);

  const withSteps = validateRecipe(listRecipeRaw({ steps: [{ name: 'a', request: { method: 'GET', url: 'http://x/', contentType: 'json' }, parse: { type: 'json', fields: {} } }] }));
  assert.equal(withSteps.ok, false);
  assert.ok(withSteps.fields.steps);
});

test('validateRecipe: source:"list" defaults to "http"; a plain recipe still validates unchanged', () => {
  const v = validateRecipe(baseRecipe());
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  assert.equal(v.value.source, 'http');
});

test('runLookup: source:"list" matches directly against caller-supplied records, with fields mapping', async () => {
  const recipe = validated(
    listRecipeRaw({
      parse: { fields: { room: 'Room', lastName: 'LastName' } },
      match: { all: true, rules: [{ input: 'room', field: 'room', normalize: 'trim' }, { input: 'lastname', field: 'lastName', normalize: 'name' }] },
      inputs: [
        { name: 'room', label: 'Room', type: 'text', required: true },
        { name: 'lastname', label: 'Last name', type: 'text' },
      ],
    }),
  );
  const records = [
    { Room: '101', LastName: 'Smith' },
    { Room: '102', LastName: 'Jones' },
  ];
  const ok = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }, { name: 'lastname', value: 'Smith' }], now: Date.now(), records });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.guest.record.lastName, 'Smith');

  const noMatch = await runLookup({ recipe, inputs: [{ name: 'room', value: '999', required: true }], now: Date.now(), records });
  assert.equal(noMatch.ok, false);
  assert.equal(noMatch.reason, 'no-match');
});

test('runLookup: source:"list" with no parse.fields uses columns as-is', async () => {
  const recipe = validated(listRecipeRaw());
  const records = [{ room: '101' }, { room: '102' }];
  const ok = await runLookup({ recipe, inputs: [{ name: 'room', value: '102', required: true }], now: Date.now(), records });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.guest.record.room, '102');
});

test('runLookup: source:"list" honours window/outside-window', async () => {
  const recipe = validated(
    listRecipeRaw({
      window: { start: 'checkIn', end: 'checkOut', leewayHours: 0, maxGrantHours: 24 },
    }),
  );
  const now = Date.parse('2026-01-05T00:00:00Z');
  const records = [{ room: '101', checkIn: '2026-01-01', checkOut: '2026-01-03' }];
  const outside = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now, records });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, 'outside-window');

  const inWindowRecords = [{ room: '101', checkIn: '2026-01-01', checkOut: '2026-01-10' }];
  const okResult = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now, records: inWindowRecords });
  assert.equal(okResult.ok, true, JSON.stringify(okResult));
});

test('runLookup: source:"list" diagnostics reports a single "list" step', async () => {
  const recipe = validated(listRecipeRaw());
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), records: [{ room: '101' }], diagnostics: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((s) => s.name), ['list']);
  assert.equal(result.steps[0].records, 1);
});

// ---------------------------------------------------------------------------
// steps[].requireRecords (and the top-level `requireRecords` recipe field)
// ---------------------------------------------------------------------------

test('validateRecipe: requireRecords defaults false and round-trips true', () => {
  const v = validateRecipe(baseRecipe({ requireRecords: true }));
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  assert.equal(v.value.requireRecords, true);
  assert.equal(validateRecipe(baseRecipe()).value.requireRecords, false);
});

test('runLookup: top-level requireRecords fails fast with no-match when the main step yields zero records', async () => {
  const recipe = validated(baseRecipe({ requireRecords: true }));
  const http = async () => ({ status: 200, headers: {}, text: JSON.stringify({ guests: [] }), ms: 1 });
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '999', required: true }], now: Date.now(), http, diagnostics: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-match');
  assert.equal(result.detail, 'step:main');
  assert.deepEqual(result.steps.map((s) => s.status), ['ok']); // the step itself succeeded; requireRecords is the gate
});

test('runLookup: steps[].requireRecords stops a later unfiltered step from ever running', async () => {
  const raw = {
    name: 'Rooms then guests',
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
    steps: [
      {
        name: 'rooms',
        request: { method: 'GET', url: 'http://x/rooms?room={{input.room}}', contentType: 'json' },
        parse: { type: 'json', root: 'rooms', fields: { roomId: 'id' } },
        requireRecords: true,
      },
      {
        name: 'guests',
        request: { method: 'GET', url: 'http://x/guests', contentType: 'json' },
        parse: { type: 'json', root: 'guests', fields: { room: 'room', lastName: 'lastName' } },
      },
    ],
    match: { all: true, rules: [{ input: 'room', field: 'room' }] },
  };
  const recipe = validated(raw);
  let guestsCalled = false;
  const http = async (req) => {
    if (req.url.includes('/rooms')) return { status: 200, headers: {}, text: JSON.stringify({ rooms: [] }), ms: 1 };
    guestsCalled = true;
    return { status: 200, headers: {}, text: JSON.stringify({ guests: [{ room: '101', lastName: 'Smith' }] }), ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '999', required: true }], now: Date.now(), http });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-match');
  assert.equal(result.detail, 'step:rooms');
  assert.equal(guestsCalled, false, 'the unfiltered "guests" step must never run once "rooms" comes back empty');
});

// ---------------------------------------------------------------------------
// steps[].paginate (and request.paginate on the top-level form)
// ---------------------------------------------------------------------------

test('validateRecipe: paginate requires parse.type "json"; validates cursorPath/name/maxPages', () => {
  const csvWithPaginate = validateRecipe(
    baseRecipe({
      request: { method: 'GET', url: 'http://x/g.csv', contentType: 'json', paginate: { cursorPath: 'next', name: 'cursor' } },
      parse: { type: 'csv', fields: { room: 'room' } },
    }),
  );
  assert.equal(csvWithPaginate.ok, false);
  assert.ok(csvWithPaginate.fields['request.paginate']);

  const missingName = validateRecipe(baseRecipe({ request: { method: 'GET', url: 'http://x/g', contentType: 'json', paginate: { cursorPath: 'next' } } }));
  assert.equal(missingName.ok, false);
  assert.ok(missingName.fields['request.paginate.name']);

  const tooManyPages = validateRecipe(baseRecipe({ request: { method: 'GET', url: 'http://x/g', contentType: 'json', paginate: { cursorPath: 'next', name: 'cursor', maxPages: 11 } } }));
  assert.equal(tooManyPages.ok, false);
  assert.ok(tooManyPages.fields['request.paginate.maxPages']);

  const ok = validateRecipe(baseRecipe({ request: { method: 'GET', url: 'http://x/g', contentType: 'json', paginate: { cursorPath: 'next', name: 'cursor' } } }));
  assert.equal(ok.ok, true, JSON.stringify(ok.fields));
  assert.deepEqual(ok.value.request.paginate, { cursorPath: 'next', morePath: '', in: 'query', name: 'cursor', maxPages: 5 });
});

test('runLookup: steps[].paginate follows a query cursor across pages, accumulating records, and reports {pages} in diagnostics', async () => {
  const raw = {
    name: 'Paged',
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
    steps: [
      {
        name: 'guests',
        request: { method: 'GET', url: 'http://x/guests', contentType: 'json' },
        parse: { type: 'json', root: 'items', fields: { room: 'room', lastName: 'lastName' } },
        paginate: { cursorPath: 'next', name: 'cursor', in: 'query', maxPages: 5 },
      },
    ],
    match: { all: true, rules: [{ input: 'room', field: 'room' }] },
  };
  const recipe = validated(raw);
  const pages = [
    { items: [{ room: '101', lastName: 'Smith' }], next: 'page2' },
    { items: [{ room: '102', lastName: 'Jones' }], next: 'page3' },
    { items: [{ room: '103', lastName: 'Lee' }] }, // no `next` -> stop
  ];
  let calls = 0;
  const http = async (req) => {
    const u = new URL(req.url);
    const cursor = u.searchParams.get('cursor');
    const idx = cursor ? Number(cursor.replace('page', '')) - 1 : 0;
    calls += 1;
    return { status: 200, headers: {}, text: JSON.stringify(pages[idx]), ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '103', required: true }], now: Date.now(), http, diagnostics: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls, 3);
  const step = result.steps.find((s) => s.name === 'guests');
  assert.equal(step.records, 3);
  assert.equal(step.pages, 3);
});

test('runLookup: steps[].paginate stops at maxPages even if a cursor keeps coming back', async () => {
  const raw = {
    name: 'Paged capped',
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
    steps: [
      {
        name: 'guests',
        request: { method: 'GET', url: 'http://x/guests', contentType: 'json' },
        parse: { type: 'json', root: 'items', fields: { room: 'room' } },
        paginate: { cursorPath: 'next', name: 'cursor', maxPages: 2 },
      },
    ],
    match: { all: true, rules: [{ input: 'room', field: 'room' }] },
  };
  const recipe = validated(raw);
  let calls = 0;
  const http = async () => {
    calls += 1;
    return { status: 200, headers: {}, text: JSON.stringify({ items: [{ room: String(calls) }], next: 'more' }), ms: 1 };
  };
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '2', required: true }], now: Date.now(), http, diagnostics: true });
  assert.equal(calls, 2, 'maxPages:2 must stop after exactly 2 requests despite an ever-present cursor');
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('runLookup: a non-paginated step behaves exactly as before (single request, no "pages" in diagnostics)', async () => {
  const recipe = validated(baseRecipe());
  const http = async () => ({ status: 200, headers: {}, text: JSON.stringify({ guests: [{ room: '101', lastName: 'Smith' }] }), ms: 1 });
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now: Date.now(), http, diagnostics: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal('pages' in result.steps[0], false);
});

// ---------------------------------------------------------------------------
// steps[].extra
// ---------------------------------------------------------------------------

test('validateRecipe: steps[].extra field names count as declared parse fields for match/window', () => {
  const raw = {
    name: 'Extra',
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
    steps: [
      {
        name: 'a',
        request: { method: 'GET', url: 'http://x/a', contentType: 'json' },
        parse: { type: 'json', root: '', fields: { room: 'room' } },
        extra: { checkIn: '{{today}}', checkOut: '{{date:+2d}}' },
      },
    ],
    match: { all: true, rules: [{ input: 'room', field: 'room' }] },
    window: { start: 'checkIn', end: 'checkOut' },
  };
  const v = validateRecipe(raw);
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  assert.deepEqual(v.value.steps[0].extra, { checkIn: '{{today}}', checkOut: '{{date:+2d}}' });
});

test('runLookup: steps[].extra stamps a templated value onto every record of that step, overwriting any existing value', async () => {
  const now = Date.parse('2026-01-05T00:00:00Z');
  const raw = {
    name: 'Extra fill',
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
    steps: [
      {
        name: 'attendees',
        request: { method: 'GET', url: 'http://x/attendees', contentType: 'json' },
        parse: { type: 'json', root: '', fields: { room: 'room', checkIn: 'checkIn' } },
        extra: { checkIn: '{{today}}', checkOut: '{{date:+1d:ymd}}' },
      },
    ],
    match: { all: true, rules: [{ input: 'room', field: 'room' }] },
    window: { start: 'checkIn', end: 'checkOut', leewayHours: 0, maxGrantHours: 48 },
  };
  const recipe = validated(raw);
  const http = async () => ({ status: 200, headers: {}, text: JSON.stringify([{ room: '101', checkIn: 'should-be-overwritten' }]), ms: 1 });
  const result = await runLookup({ recipe, inputs: [{ name: 'room', value: '101', required: true }], now, http });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.guest.record.checkIn, '2026-01-05');
  assert.equal(result.guest.record.checkOut, '2026-01-06');
});

test('wildcard [*] paths work inside placeholders (raw array + joined string)', () => {
  const vars = { steps: { room: { records: [{ id: 'a' }, { id: 'b' }] } } };
  assert.deepEqual(renderJsonTemplate({ ids: '{{raw:steps.room.records[*].id}}' }, vars, { omitEmpty: true }), { ids: ['a', 'b'] });
  assert.deepEqual(renderJsonTemplate({ ids: '{{raw:steps.room.records[*].nope}}' }, vars, { omitEmpty: true }), {});
  assert.equal(renderTemplate('{{steps.room.records[*].id}}', vars), 'a,b');
});
