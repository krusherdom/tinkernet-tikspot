// Lookup attempt logging (0.17.1): the engine says WHICH kind of refusal a
// lookup was (no candidates vs no record matched vs outside the stay window)
// and measures the guest system's clock against ours; the portal route turns
// that into one readable event per attempt plus a rate-limited clock warning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrate.js';
import { runLookup, makeTokenCache } from '../src/plugins/engine.js';
import { describeOutcome, warnOnClockSkew, _resetClockWarn } from '../src/portal/routes.js';
import { listEvents } from '../src/admin/events.js';

const recipe = () => ({
  name: 'Stub PMS',
  inputs: [
    { name: 'room', label: 'Room', type: 'text', required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
  ],
  request: { method: 'GET', url: 'https://pms.example/guests?room={{input.room}}', contentType: 'json' },
  parse: { type: 'json', root: 'data', fields: { firstName: 'first', lastName: 'last', room: 'room', checkIn: 'in', checkOut: 'out' }, dateFormat: 'iso' },
  match: { all: true, rules: [{ input: 'room', field: 'room', normalize: 'roomNumber' }, { input: 'name', field: 'lastName', normalize: 'name' }] },
  window: { start: 'checkIn', end: 'checkOut', leewayHours: 24, maxGrantHours: 168 },
});

const inputsFor = (room, name) => [
  { name: 'room', value: room, required: true },
  { name: 'name', value: name, required: true },
];

const body = (rows) => JSON.stringify({ data: rows });
const row = { first: 'Jane', last: 'Smith', room: '101', in: '2026-01-01T14:00:00Z', out: '2026-01-10T10:00:00Z' };
const httpWith = (rows, headers = {}) => async () => ({ status: 200, headers, text: body(rows), ms: 1 });
const now = Date.parse('2026-01-05T12:00:00Z');

test('engine: no-match distinguishes "search returned nothing" from "nothing matched"', async () => {
  const empty = await runLookup({ recipe: recipe(), inputs: inputsFor('101', 'Smith'), now, http: httpWith([]), tokenCache: makeTokenCache(), diagnostics: true });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no-match');
  assert.equal(empty.detail, 'no-candidates');
  assert.equal(empty.candidates, 0);

  const wrong = await runLookup({ recipe: recipe(), inputs: inputsFor('101', 'Brown'), now, http: httpWith([row, { ...row, last: 'Jones' }]), tokenCache: makeTokenCache(), diagnostics: true });
  assert.equal(wrong.reason, 'no-match');
  assert.equal(wrong.detail, 'no-record-matched');
  assert.equal(wrong.candidates, 2);
});

test('engine: outside-window carries the record dates, leeway and now; ok carries candidates', async () => {
  const early = await runLookup({ recipe: recipe(), inputs: inputsFor('101', 'Smith'), now: Date.parse('2025-12-20T00:00:00Z'), http: httpWith([row]), tokenCache: makeTokenCache(), diagnostics: true });
  assert.equal(early.reason, 'outside-window');
  assert.equal(early.detail, 'not-started');
  assert.equal(early.candidates, 1);
  assert.deepEqual(early.window, { start: row.in, end: row.out, leewayHours: 24, now: '2025-12-20T00:00:00.000Z' });

  const ok = await runLookup({ recipe: recipe(), inputs: inputsFor('101', 'smith '), now, http: httpWith([row]), tokenCache: makeTokenCache() });
  assert.equal(ok.ok, true);
  assert.equal(ok.candidates, 1);
  assert.equal(ok.steps, undefined, 'no diagnostics -> no steps');
  assert.equal(ok.clockSkewSecs, undefined);
});

test('engine: clockSkewSecs comes from the first Date header, only with diagnostics', async () => {
  const remote = new Date(Date.now() + 2 * 3600 * 1000).toUTCString(); // guest system 2 h ahead = we are 2 h behind
  const r = await runLookup({ recipe: recipe(), inputs: inputsFor('101', 'Smith'), now, http: httpWith([], { date: remote }), tokenCache: makeTokenCache(), diagnostics: true });
  assert.ok(r.clockSkewSecs >= 7195 && r.clockSkewSecs <= 7205, `skew ${r.clockSkewSecs}`);
  const quiet = await runLookup({ recipe: recipe(), inputs: inputsFor('101', 'Smith'), now, http: httpWith([], { Date: remote }), tokenCache: makeTokenCache() });
  assert.equal(quiet.clockSkewSecs, undefined);
  const noHdr = await runLookup({ recipe: recipe(), inputs: inputsFor('101', 'Smith'), now, http: httpWith([]), tokenCache: makeTokenCache(), diagnostics: true });
  assert.equal(noHdr.clockSkewSecs, undefined);
});

test('describeOutcome: one readable line per outcome, typed inputs first', () => {
  const typed = { room: '101', name: 'Smith' };
  const t = (result) => describeOutcome(result, typed, 'RMS Cloud');
  assert.deepEqual(t({ ok: true, guest: { label: 'Jane Smith · room 101' } }), {
    level: 'info',
    message: 'Lookup OK: room 101 / name Smith → Jane Smith · room 101 (plugin RMS Cloud)',
  });
  assert.equal(t({ ok: false, reason: 'no-match', detail: 'no-candidates', candidates: 0 }).message,
    'Lookup refused: room 101 / name Smith — no booking found (search returned 0 records) (plugin RMS Cloud)');
  assert.equal(t({ ok: false, reason: 'no-match', detail: 'no-record-matched', candidates: 12 }).message,
    'Lookup refused: room 101 / name Smith — details did not match any of 12 records (plugin RMS Cloud)');
  assert.equal(t({ ok: false, reason: 'outside-window', detail: 'ended', window: { start: '2026-01-01T14:00:00', end: '2026-01-10T10:00:00' } }).message,
    'Lookup refused: room 101 / name Smith — found, but outside the stay window (ended; 2026-01-01 14:00 → 2026-01-10 10:00) (plugin RMS Cloud)');
  assert.equal(t({ ok: false, reason: 'outside-window', detail: 'missing-dates' }).message,
    'Lookup refused: room 101 / name Smith — found, but outside the stay window (stay dates missing on the record) (plugin RMS Cloud)');
  const up = t({ ok: false, reason: 'upstream', status: 401 });
  assert.equal(up.level, 'warn');
  assert.equal(up.message, 'Lookup refused: room 101 / name Smith — guest system error (HTTP 401) (plugin RMS Cloud)');
  assert.equal(t({ ok: false, reason: 'timeout' }).message, 'Lookup refused: room 101 / name Smith — guest system timed out (plugin RMS Cloud)');
  assert.equal(describeOutcome({ ok: false, reason: 'no-match', candidates: 0 }, { room: '', name: 'Smith' }, 'P').message,
    'Lookup refused: room (blank) / name Smith — no booking found (search returned 0 records) (plugin P)');
});

test('warnOnClockSkew: ignores small skew, warns once an hour, names the direction', () => {
  const db = new Database(':memory:');
  migrate(db);
  _resetClockWarn();
  const t0 = Date.parse('2026-01-05T12:00:00Z');
  assert.equal(warnOnClockSkew(db, 120, 'RMS Cloud', t0), false, 'under 5 min is fine');
  assert.equal(warnOnClockSkew(db, 76070, 'RMS Cloud', t0), true);
  assert.equal(warnOnClockSkew(db, 76070, 'RMS Cloud', t0 + 10 * 60 * 1000), false, 'rate limited');
  assert.equal(warnOnClockSkew(db, -900, 'RMS Cloud', t0 + 61 * 60 * 1000), true);
  const ev = listEvents(db, { source: 'clock' });
  assert.equal(ev.length, 2);
  assert.equal(ev[1].level, 'warn');
  assert.equal(ev[1].message, 'Container clock is 1268 min behind the guest system (RMS Cloud)');
  assert.equal(ev[0].message, 'Container clock is 15 min ahead of the guest system (RMS Cloud)');
  assert.match(JSON.parse(ev[1].detail).hint, /\/system\/ntp\/client/);
  _resetClockWarn();
});
