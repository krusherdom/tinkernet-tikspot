// Tests for the 0.11 foundations (settings registry, retention maths).
// Pure functions only — no better-sqlite3 — so this runs anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_REGISTRY,
  settingSpec,
  coerceSetting,
  validateSettingValue,
} from '../src/db/settings.js';
import { retentionCutoffs, RETENTION_TABLES } from '../src/admin/retention.js';

test('settings registry entries are well-formed', () => {
  const keys = new Set();
  for (const s of SETTINGS_REGISTRY) {
    assert.ok(s.key && !keys.has(s.key), `duplicate/missing key ${s.key}`);
    keys.add(s.key);
    assert.ok(['int', 'bool', 'text', 'select', 'json'].includes(s.type), s.key);
    assert.ok(s.group && s.label && s.help, `${s.key} needs group/label/help`);
    if (s.type === 'select') assert.ok(Array.isArray(s.options) && s.options.includes(s.default));
    if (s.type === 'int') assert.equal(typeof s.default, 'number');
  }
  assert.ok(keys.has('retention_days') && keys.has('login_method'));
});

test('coerceSetting falls back to defaults on bad stored values', () => {
  const days = settingSpec('retention_days');
  assert.equal(coerceSetting(days, null), 30);
  assert.equal(coerceSetting(days, ''), 30);
  assert.equal(coerceSetting(days, 'abc'), 30);
  assert.equal(coerceSetting(days, '45'), 45);
  assert.equal(coerceSetting(days, '45.9'), 45);
  const lm = settingSpec('login_method');
  assert.equal(coerceSetting(lm, 'chap'), 'chap');
});

test('validateSettingValue enforces type, range and options', () => {
  const days = settingSpec('retention_days');
  assert.equal(validateSettingValue(days, 'x').ok, false);
  assert.equal(validateSettingValue(days, 0).ok, false);
  assert.equal(validateSettingValue(days, 1.5).ok, false);
  assert.deepEqual(validateSettingValue(days, '90'), { ok: true, value: '90' });
  assert.equal(validateSettingValue(days, 99999).ok, false);
  const lm = settingSpec('login_method');
  assert.equal(validateSettingValue(lm, 'eap').ok, false);
  assert.deepEqual(validateSettingValue(lm, 'pap'), { ok: true, value: 'pap' });
  const title = settingSpec('portal_title');
  assert.deepEqual(validateSettingValue(title, 'Hi'), { ok: true, value: 'Hi' });
  assert.equal(validateSettingValue(title, 'x'.repeat(2001)).ok, false);
});

test('retentionCutoffs clamps and formats as SQLite datetime', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0); // 2026-09-08 12:00:00Z
  const c = retentionCutoffs({ days: 30, maxRows: 5000 }, now);
  assert.equal(c.cutoff, '2026-08-09 12:00:00');
  assert.equal(c.days, 30);
  assert.equal(c.maxRows, 5000);
  // Clamps: at least 1 day, at least 100 rows, garbage -> defaults.
  assert.equal(retentionCutoffs({ days: 0, maxRows: 10 }, now).days, 1);
  assert.equal(retentionCutoffs({ days: 0, maxRows: 10 }, now).maxRows, 100);
  assert.equal(retentionCutoffs({ days: 'x', maxRows: 'y' }, now).days, 30);
  assert.equal(retentionCutoffs({ days: 'x', maxRows: 'y' }, now).maxRows, 5000);
});

test('retention covers the unbounded tables and only closed sessions', () => {
  const names = RETENTION_TABLES.map((t) => t.table);
  for (const t of ['radpostauth', 'radacct', 'admin_audit', 'events']) assert.ok(names.includes(t), t);
  const acct = RETENTION_TABLES.find((t) => t.table === 'radacct');
  assert.equal(acct.closedOnly, true);
  assert.equal(acct.tsCol, 'acctstoptime');
  assert.equal(acct.idCol, 'radacctid');
});
