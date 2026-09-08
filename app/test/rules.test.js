// Stage 0.11-C/D pure-logic tests: announcement window/validation rules,
// settings-patch validation, and CSV export formatting. No better-sqlite3
// import here — these must run anywhere with just `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTs,
  normalizeIso,
  isActiveAt,
  announcementState,
  compareAnnouncements,
  parseTargets,
  validateAnnouncement,
  MAX_TITLE,
  MAX_BODY,
  TARGETS,
} from '../src/admin/announcementRules.js';
import { validateSettingsPatch } from '../src/admin/settingsRoutes.js';
import { toCsv } from '../src/admin/logs.js';

// ---------------------------------------------------------------------------
// parseTs
test('parseTs parses ISO timestamps', () => {
  const t = parseTs('2026-01-01T10:00:00.000Z');
  assert.equal(t, Date.parse('2026-01-01T10:00:00.000Z'));
});

test('parseTs treats SQLite "YYYY-MM-DD HH:MM:SS" as UTC', () => {
  const t = parseTs('2026-01-01 10:00:00');
  assert.equal(t, Date.parse('2026-01-01T10:00:00Z'));
});

test('parseTs handles the space-separated form without seconds', () => {
  const t = parseTs('2026-01-01 10:00');
  assert.equal(t, Date.parse('2026-01-01T10:00Z'));
});

test('parseTs returns null for garbage/empty/nullish input', () => {
  assert.equal(parseTs('not a date'), null);
  assert.equal(parseTs(''), null);
  assert.equal(parseTs(null), null);
  assert.equal(parseTs(undefined), null);
});

// ---------------------------------------------------------------------------
// normalizeIso
test('normalizeIso accepts empty/null/undefined as ok with null value', () => {
  assert.deepEqual(normalizeIso(''), { ok: true, value: null });
  assert.deepEqual(normalizeIso(null), { ok: true, value: null });
  assert.deepEqual(normalizeIso(undefined), { ok: true, value: null });
  assert.deepEqual(normalizeIso('   '), { ok: true, value: null });
});

test('normalizeIso canonicalises a valid date to ISO', () => {
  const res = normalizeIso('2026-01-01 10:00:00');
  assert.equal(res.ok, true);
  assert.equal(res.value, new Date(Date.parse('2026-01-01T10:00:00Z')).toISOString());
});

test('normalizeIso rejects unparseable input', () => {
  const res = normalizeIso('nonsense');
  assert.equal(res.ok, false);
  assert.match(res.error, /date\/time/);
});

// ---------------------------------------------------------------------------
// isActiveAt
test('isActiveAt is false when disabled', () => {
  assert.equal(isActiveAt({ enabled: 0, starts_at: null, ends_at: null }, '2026-01-01T00:00:00Z'), false);
});

test('isActiveAt is false before the start window', () => {
  const a = { enabled: 1, starts_at: '2026-02-01T00:00:00Z', ends_at: null };
  assert.equal(isActiveAt(a, '2026-01-01T00:00:00Z'), false);
});

test('isActiveAt is false after the end window', () => {
  const a = { enabled: 1, starts_at: null, ends_at: '2026-01-01T00:00:00Z' };
  assert.equal(isActiveAt(a, '2026-02-01T00:00:00Z'), false);
});

test('isActiveAt is true inside the window', () => {
  const a = { enabled: 1, starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-03-01T00:00:00Z' };
  assert.equal(isActiveAt(a, '2026-02-01T00:00:00Z'), true);
});

test('isActiveAt is true when open-ended (no start/end)', () => {
  assert.equal(isActiveAt({ enabled: 1, starts_at: null, ends_at: null }, '2026-01-01T00:00:00Z'), true);
});

test('isActiveAt treats enabled as 1, "1", or true', () => {
  const base = { starts_at: null, ends_at: null };
  assert.equal(isActiveAt({ ...base, enabled: 1 }, '2026-01-01T00:00:00Z'), true);
  assert.equal(isActiveAt({ ...base, enabled: '1' }, '2026-01-01T00:00:00Z'), true);
  assert.equal(isActiveAt({ ...base, enabled: true }, '2026-01-01T00:00:00Z'), true);
  assert.equal(isActiveAt({ ...base, enabled: 0 }, '2026-01-01T00:00:00Z'), false);
  assert.equal(isActiveAt({ ...base, enabled: '0' }, '2026-01-01T00:00:00Z'), false);
  assert.equal(isActiveAt({ ...base, enabled: false }, '2026-01-01T00:00:00Z'), false);
});

test('isActiveAt returns false for a nullish announcement', () => {
  assert.equal(isActiveAt(null, '2026-01-01T00:00:00Z'), false);
  assert.equal(isActiveAt(undefined, '2026-01-01T00:00:00Z'), false);
});

// ---------------------------------------------------------------------------
// announcementState
test('announcementState reports disabled first, regardless of window', () => {
  const a = { enabled: 0, starts_at: '2020-01-01T00:00:00Z', ends_at: '2099-01-01T00:00:00Z' };
  assert.equal(announcementState(a, '2026-01-01T00:00:00Z'), 'disabled');
});

test('announcementState reports scheduled/active/expired', () => {
  const scheduled = { enabled: 1, starts_at: '2027-01-01T00:00:00Z', ends_at: null };
  assert.equal(announcementState(scheduled, '2026-01-01T00:00:00Z'), 'scheduled');

  const active = { enabled: 1, starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-03-01T00:00:00Z' };
  assert.equal(announcementState(active, '2026-02-01T00:00:00Z'), 'active');

  const expired = { enabled: 1, starts_at: null, ends_at: '2020-01-01T00:00:00Z' };
  assert.equal(announcementState(expired, '2026-01-01T00:00:00Z'), 'expired');

  const openEnded = { enabled: 1, starts_at: null, ends_at: null };
  assert.equal(announcementState(openEnded, '2026-01-01T00:00:00Z'), 'active');
});

// ---------------------------------------------------------------------------
// compareAnnouncements
test('compareAnnouncements sorts danger first, then warning, info, success', () => {
  const items = [
    { id: 1, severity: 'success' },
    { id: 2, severity: 'info' },
    { id: 3, severity: 'danger' },
    { id: 4, severity: 'warning' },
  ];
  const sorted = [...items].sort(compareAnnouncements);
  assert.deepEqual(sorted.map((x) => x.severity), ['danger', 'warning', 'info', 'success']);
});

test('compareAnnouncements breaks ties within a severity by newest id first', () => {
  const items = [
    { id: 1, severity: 'danger' },
    { id: 5, severity: 'danger' },
    { id: 3, severity: 'danger' },
  ];
  const sorted = [...items].sort(compareAnnouncements);
  assert.deepEqual(sorted.map((x) => x.id), [5, 3, 1]);
});

test('compareAnnouncements treats unknown severities as lowest priority', () => {
  const items = [{ id: 1, severity: 'weird' }, { id: 2, severity: 'danger' }];
  const sorted = [...items].sort(compareAnnouncements);
  assert.deepEqual(sorted.map((x) => x.severity), ['danger', 'weird']);
});

// ---------------------------------------------------------------------------
// parseTargets
test('parseTargets accepts an array and filters unknown values', () => {
  assert.deepEqual(parseTargets(['portal', 'bogus', 'admin']), ['portal', 'admin']);
});

test('parseTargets parses a JSON string and defends against garbage', () => {
  assert.deepEqual(parseTargets('["portal","status"]'), ['portal', 'status']);
  assert.deepEqual(parseTargets('not json'), []);
  assert.deepEqual(parseTargets(null), []);
  assert.deepEqual(parseTargets(undefined), []);
  assert.deepEqual(parseTargets('[]'), []);
});

// ---------------------------------------------------------------------------
// validateAnnouncement
test('validateAnnouncement requires a non-empty title', () => {
  const res = validateAnnouncement({ title: '  ', targets: ['portal'] });
  assert.equal(res.ok, false);
  assert.ok(res.fields.title);
});

test('validateAnnouncement enforces MAX_TITLE and MAX_BODY', () => {
  const tooLongTitle = validateAnnouncement({ title: 'x'.repeat(MAX_TITLE + 1), targets: ['portal'] });
  assert.equal(tooLongTitle.ok, false);
  assert.ok(tooLongTitle.fields.title);

  const okTitle = validateAnnouncement({ title: 'x'.repeat(MAX_TITLE), targets: ['portal'] });
  assert.equal(okTitle.ok, true);

  const tooLongBody = validateAnnouncement({ title: 'ok', body: 'x'.repeat(MAX_BODY + 1), targets: ['portal'] });
  assert.equal(tooLongBody.ok, false);
  assert.ok(tooLongBody.fields.body);

  const okBody = validateAnnouncement({ title: 'ok', body: 'x'.repeat(MAX_BODY), targets: ['portal'] });
  assert.equal(okBody.ok, true);
});

test('validateAnnouncement enforces the severity enum', () => {
  const bad = validateAnnouncement({ title: 'ok', severity: 'critical', targets: ['portal'] });
  assert.equal(bad.ok, false);
  assert.ok(bad.fields.severity);

  const good = validateAnnouncement({ title: 'ok', severity: 'warning', targets: ['portal'] });
  assert.equal(good.ok, true);
  assert.equal(good.value.severity, 'warning');

  // Default severity is 'info' when omitted.
  const def = validateAnnouncement({ title: 'ok', targets: ['portal'] });
  assert.equal(def.ok, true);
  assert.equal(def.value.severity, 'info');
});

test('validateAnnouncement requires a non-empty subset of TARGETS', () => {
  const empty = validateAnnouncement({ title: 'ok', targets: [] });
  assert.equal(empty.ok, false);
  assert.ok(empty.fields.targets);

  const missing = validateAnnouncement({ title: 'ok' });
  assert.equal(missing.ok, false);
  assert.ok(missing.fields.targets);

  const bogus = validateAnnouncement({ title: 'ok', targets: ['portal', 'nope'] });
  assert.equal(bogus.ok, false);
  assert.ok(bogus.fields.targets);

  const dedup = validateAnnouncement({ title: 'ok', targets: ['portal', 'portal', 'admin'] });
  assert.equal(dedup.ok, true);
  assert.deepEqual(dedup.value.targets, ['portal', 'admin']);

  // A single non-array target value is coerced into a one-element array.
  const single = validateAnnouncement({ title: 'ok', targets: 'status' });
  assert.equal(single.ok, true);
  assert.deepEqual(single.value.targets, ['status']);

  for (const t of TARGETS) {
    assert.equal(validateAnnouncement({ title: 'ok', targets: [t] }).ok, true, t);
  }
});

test('validateAnnouncement requires ends_at >= starts_at', () => {
  const bad = validateAnnouncement({
    title: 'ok',
    targets: ['portal'],
    starts_at: '2026-02-01T00:00:00Z',
    ends_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.fields.ends_at);

  const good = validateAnnouncement({
    title: 'ok',
    targets: ['portal'],
    starts_at: '2026-01-01T00:00:00Z',
    ends_at: '2026-02-01T00:00:00Z',
  });
  assert.equal(good.ok, true);

  // Equal start/end is allowed (ends >= starts).
  const equal = validateAnnouncement({
    title: 'ok',
    targets: ['portal'],
    starts_at: '2026-01-01T00:00:00Z',
    ends_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(equal.ok, true);
});

test('validateAnnouncement rejects an unparseable starts_at/ends_at', () => {
  const bad = validateAnnouncement({ title: 'ok', targets: ['portal'], starts_at: 'nonsense' });
  assert.equal(bad.ok, false);
  assert.ok(bad.fields.starts_at);
});

test('validateAnnouncement returns { ok:true, value } with defaulted enabled=1', () => {
  const res = validateAnnouncement({ title: 'Hello', body: 'World', targets: ['portal'] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, {
    title: 'Hello',
    body: 'World',
    severity: 'info',
    targets: ['portal'],
    starts_at: null,
    ends_at: null,
    enabled: 1,
  });
});

test('validateAnnouncement coerces enabled from 0/1/"1"/true/false', () => {
  assert.equal(validateAnnouncement({ title: 'ok', targets: ['portal'], enabled: 0 }).value.enabled, 0);
  assert.equal(validateAnnouncement({ title: 'ok', targets: ['portal'], enabled: 1 }).value.enabled, 1);
  assert.equal(validateAnnouncement({ title: 'ok', targets: ['portal'], enabled: '1' }).value.enabled, 1);
  assert.equal(validateAnnouncement({ title: 'ok', targets: ['portal'], enabled: true }).value.enabled, 1);
  assert.equal(validateAnnouncement({ title: 'ok', targets: ['portal'], enabled: false }).value.enabled, 0);
});

test('validateAnnouncement returns error = the first field error, and tolerates non-object body', () => {
  const res = validateAnnouncement(null);
  assert.equal(res.ok, false);
  assert.equal(typeof res.error, 'string');
  assert.ok(res.fields.title); // title is checked first
});

// ---------------------------------------------------------------------------
// validateSettingsPatch
test('validateSettingsPatch flags an unknown key', () => {
  const res = validateSettingsPatch({ not_a_real_setting: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.fields.not_a_real_setting, 'Unknown setting');
});

test('validateSettingsPatch flags a bad int value', () => {
  const res = validateSettingsPatch({ retention_days: 'x' });
  assert.equal(res.ok, false);
  assert.ok(res.fields.retention_days);
});

test('validateSettingsPatch returns updates pairs when everything is good', () => {
  const res = validateSettingsPatch({ retention_days: 45, login_method: 'chap' });
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.updates.sort((a, b) => a[0].localeCompare(b[0])),
    [['login_method', 'chap'], ['retention_days', '45']],
  );
});

test('validateSettingsPatch rejects a non-object body', () => {
  assert.equal(validateSettingsPatch(null).ok, false);
  assert.equal(validateSettingsPatch('x').ok, false);
  assert.equal(validateSettingsPatch([1, 2]).ok, false);
  assert.equal(validateSettingsPatch({}).ok, false);
});

// ---------------------------------------------------------------------------
// toCsv
test('toCsv quotes every field and doubles embedded quotes', () => {
  const csv = toCsv(['a', 'b'], [{ a: 'he said "hi"', b: 'plain' }]);
  assert.equal(csv, '"a","b"\n"he said ""hi""","plain"\n');
});

test('toCsv strips CR but keeps LF, and quotes null as an empty field', () => {
  const csv = toCsv(['a'], [{ a: 'line1\r\nline2' }, { a: null }]);
  assert.equal(csv, '"a"\n"line1\nline2"\n""\n');
});

test('toCsv with no rows returns just the header line', () => {
  const csv = toCsv(['a', 'b'], []);
  assert.equal(csv, '"a","b"\n');
});
