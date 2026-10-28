// 0.18 remembered devices (MAC re-auth against the user): mac/devices.js,
// its hooks in plugin grants / voucher sweeper / admin handlers, the
// mac_sessions -> user_devices migration and the 7-day purge.
import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';
import Fastify from 'fastify';

import { migrate } from '../src/db/migrate.js';
import { seedDefaults } from '../src/seed.js';
import {
  normMac,
  deviceExpiry,
  recordDevice,
  touchDevice,
  forgetDevice,
  forgetUserDevices,
  sweepDevices,
  listActiveDevices,
  listUserDevices,
  ownerOfMac,
  processDeviceCapture,
} from '../src/mac/devices.js';
import { grantGuest, sweepPluginGrants, revokeGrant } from '../src/plugins/grants.js';
import { sweepVouchers } from '../src/voucher/sweeper.js';
import { pruneNow, USER_PURGE_DAYS } from '../src/admin/retention.js';

const MAC = 'AA:BB:CC:DD:EE:01';
const MAC2 = 'AA:BB:CC:DD:EE:02';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  seedDefaults(db);
  return db;
}

const now = (db, mod = null) =>
  db.prepare(mod ? "SELECT datetime('now', ?) AS d" : "SELECT datetime('now') AS d").get(...(mod ? [mod] : [])).d;

function addPlan(db, { name, group, remember = 1, validity = null }) {
  const id = db
    .prepare(
      `INSERT INTO plans (name, radius_groupname, kind, mac_remember, mac_validity_secs)
       VALUES (?, ?, 'voucher', ?, ?)`,
    )
    .run(name, group, remember, validity).lastInsertRowid;
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
}

function addVoucher(db, code, plan, { validUntil = null, status = 'unused' } = {}) {
  db.prepare('INSERT INTO vouchers (code, plan_id, status, valid_until) VALUES (?, ?, ?, ?)').run(
    code,
    plan.id,
    status,
    validUntil,
  );
  db.prepare("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)").run(code, code);
  db.prepare('INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)').run(code, plan.radius_groupname);
}

function openSession(db, username, mac, id = `s-${username}-${mac}`) {
  db.prepare(
    `INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, callingstationid, acctstarttime)
     VALUES (?, ?, ?, '10.0.0.1', ?, datetime('now'))`,
  ).run(id, id.slice(0, 32), username, mac);
}

const radcheckOf = (db, u) => db.prepare('SELECT attribute, op, value FROM radcheck WHERE username = ?').all(u);
const groupOf = (db, u) => db.prepare('SELECT groupname FROM radusergroup WHERE username = ?').get(u)?.groupname;

// ---------------------------------------------------------------------------
test('normMac canonicalises separators and case; rejects junk', () => {
  assert.equal(normMac('aa-bb-cc-dd-ee-01'), MAC);
  assert.equal(normMac('aabb.ccdd.ee01'), MAC);
  assert.equal(normMac('aabbccddee01'), MAC);
  assert.equal(normMac(' aa:bb:cc:dd:ee:01 '), MAC);
  assert.equal(normMac('not-a-mac'), null);
  assert.equal(normMac(null), null);
});

test('deviceExpiry: voucher valid_until, plugin grant, account, and the plan validity cap', () => {
  const db = freshDb();
  const capped = addPlan(db, { name: 'Day', group: 'day', validity: 3600 });
  const uncapped = addPlan(db, { name: 'Open', group: 'open', validity: null });

  // Voucher ending in 10 minutes, plan cap 1 h -> the voucher end wins.
  const soon = now(db, '+10 minutes');
  addVoucher(db, 'V1', capped, { validUntil: soon });
  assert.equal(deviceExpiry(db, { username: 'V1', plan: capped }), soon);
  // Voucher ending in 2 days, cap 1 h -> the cap wins.
  addVoucher(db, 'V2', capped, { validUntil: now(db, '+2 days') });
  const e2 = deviceExpiry(db, { username: 'V2', plan: capped });
  assert.ok(e2 >= now(db, '+3590 seconds') && e2 <= now(db, '+3610 seconds'), e2);
  // Date-only valid_until is parsed by datetime().
  addVoucher(db, 'V3', uncapped, { validUntil: '2099-07-31' });
  assert.equal(deviceExpiry(db, { username: 'V3', plan: uncapped }), '2099-07-31 00:00:00');
  // Ungated voucher on an uncapped plan -> null (not remembered).
  addVoucher(db, 'V4', uncapped);
  assert.equal(deviceExpiry(db, { username: 'V4', plan: uncapped }), null);
  // Revoked voucher -> null.
  addVoucher(db, 'V5', capped, { status: 'revoked' });
  assert.equal(deviceExpiry(db, { username: 'V5', plan: capped }), null);

  // Account: no user expiry -> the cap, or null without one.
  db.prepare("INSERT INTO accounts (username, password, plan_id) VALUES ('alice', 'pw123456', ?)").run(capped.id);
  assert.ok(deviceExpiry(db, { username: 'alice', plan: capped }));
  assert.equal(deviceExpiry(db, { username: 'alice', plan: uncapped }), null);

  // Plugin guest: its active grant's expiry (ISO legacy row still parsed).
  const iso = new Date(Date.now() + 20 * 60_000).toISOString();
  db.prepare("INSERT INTO plugin_grants (username, expires_at, active) VALUES ('pg-AAAAAA', ?, 1)").run(iso);
  assert.equal(deviceExpiry(db, { username: 'pg-AAAAAA', plan: uncapped }), iso.slice(0, 19).replace('T', ' '));
  assert.equal(deviceExpiry(db, { username: 'pg-NOGRANT', plan: capped }), null);
});

test('recordDevice: Auth-Type Accept MAC user (no password); a second user takes the MAC over and regroups it', () => {
  const db = freshDb();
  const a = addPlan(db, { name: 'A', group: 'grp-a', validity: 3600 });
  const b = addPlan(db, { name: 'B', group: 'grp-b', validity: 3600 });

  const row = recordDevice(db, {
    username: 'V1', mac: 'aa-bb-cc-dd-ee-01', planId: a.id, groupname: 'grp-a', expiresAt: now(db, '+1 hour'),
  });
  assert.equal(row.mac, MAC);
  assert.equal(row.source, 'session');
  assert.deepEqual(radcheckOf(db, MAC), [{ attribute: 'Auth-Type', op: ':=', value: 'Accept' }]);
  assert.equal(groupOf(db, MAC), 'grp-a');
  assert.equal(ownerOfMac(db, MAC), 'V1');

  // Same user again: one row, bumped.
  const again = recordDevice(db, { username: 'V1', mac: MAC, planId: a.id, groupname: 'grp-a', expiresAt: now(db, '+2 hours') });
  assert.equal(again.id, row.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_devices').get().c, 1);

  // A different user on the same MAC: ownership moves, group follows.
  const moved = recordDevice(db, {
    username: 'V2', mac: MAC, planId: b.id, groupname: 'grp-b', expiresAt: now(db, '+1 hour'), source: 'grant',
  });
  assert.equal(moved.id, row.id);
  assert.equal(moved.username, 'V2');
  assert.equal(moved.source, 'grant');
  assert.equal(ownerOfMac(db, MAC), 'V2');
  assert.equal(groupOf(db, MAC), 'grp-b');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_devices WHERE active = 1').get().c, 1);
  assert.equal(listUserDevices(db, 'V1').length, 0);
  assert.equal(listUserDevices(db, 'V2').length, 1);

  const listed = listActiveDevices(db);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].plan_name, 'B');
  for (const k of ['id', 'username', 'mac', 'plan_id', 'plan_name', 'groupname', 'source', 'first_seen', 'last_seen', 'expires_at']) {
    assert.ok(k in listed[0], k);
  }
});

test('processDeviceCapture records from open sessions, touches MAC logins, ignores mac_remember=0 plans', () => {
  const db = freshDb();
  const rem = addPlan(db, { name: 'Rem', group: 'rem', validity: 3600 });
  const off = addPlan(db, { name: 'Off', group: 'off', remember: 0, validity: 3600 });
  addVoucher(db, 'REM1', rem);
  addVoucher(db, 'OFF1', off);
  openSession(db, 'REM1', MAC);
  openSession(db, 'OFF1', MAC2);

  let res = processDeviceCapture(db);
  assert.deepEqual(res, { recorded: 1, touched: 0 });
  assert.equal(ownerOfMac(db, MAC), 'REM1');
  assert.equal(ownerOfMac(db, MAC2), null);
  const dev = listActiveDevices(db)[0];
  assert.equal(dev.groupname, 'rem');
  assert.equal(dev.source, 'session');

  // Second pass: already known for this user -> touched, not re-recorded.
  res = processDeviceCapture(db);
  assert.deepEqual(res, { recorded: 0, touched: 1 });

  // The device comes back via login-by=mac: username == MAC -> touch only.
  db.prepare('UPDATE radacct SET acctstoptime = datetime(\'now\') WHERE username = ?').run('REM1');
  db.prepare("UPDATE user_devices SET last_seen = '2000-01-01 00:00:00'").run();
  openSession(db, MAC, MAC);
  res = processDeviceCapture(db);
  assert.deepEqual(res, { recorded: 0, touched: 1 });
  assert.notEqual(listActiveDevices(db)[0].last_seen, '2000-01-01 00:00:00');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_devices').get().c, 1);
});

test('touchDevice / forgetDevice / sweepDevices', () => {
  const db = freshDb();
  recordDevice(db, { username: 'u1', mac: MAC, groupname: 'free', expiresAt: now(db, '+1 hour') });
  recordDevice(db, { username: 'u2', mac: MAC2, groupname: 'free', expiresAt: now(db, '+1 hour') });
  assert.equal(touchDevice(db, MAC), true);
  assert.equal(touchDevice(db, 'AA:BB:CC:00:00:00'), false);

  assert.equal(forgetDevice(db, 'aa:bb:cc:dd:ee:01'), true);
  assert.equal(forgetDevice(db, MAC), false);
  assert.deepEqual(radcheckOf(db, MAC), []);
  assert.equal(groupOf(db, MAC), undefined);

  db.prepare("UPDATE user_devices SET expires_at = datetime('now', '-1 minute') WHERE mac = ?").run(MAC2);
  assert.equal(sweepDevices(db), 1);
  assert.deepEqual(radcheckOf(db, MAC2), []);
  assert.equal(listActiveDevices(db).length, 0);
  assert.equal(listUserDevices(db, 'u2', { includeInactive: true }).length, 1);
});

test('grantGuest with a MAC on a mac_remember plan remembers the device; revokeGrant forgets it', () => {
  const db = freshDb();
  addPlan(db, { name: 'Guest', group: 'guest', validity: 7200 });
  const plugin = { id: null, planGroup: 'guest', window: { maxGrantHours: 1 } };
  const g = grantGuest(db, { plugin, guest: { label: 'X' }, expiresAt: new Date(Date.now() + 3600_000).toISOString(), mac: 'aa-bb-cc-dd-ee-01', inputs: [] });

  const stored = db.prepare('SELECT * FROM plugin_grants WHERE username = ?').get(g.username);
  assert.match(stored.expires_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);

  const devs = listUserDevices(db, g.username);
  assert.equal(devs.length, 1);
  assert.equal(devs[0].mac, MAC);
  assert.equal(devs[0].source, 'grant');
  // Capped by the grant (1 h), not the plan (2 h).
  assert.equal(devs[0].expires_at, stored.expires_at);
  assert.deepEqual(radcheckOf(db, MAC), [{ attribute: 'Auth-Type', op: ':=', value: 'Accept' }]);

  // A plan with mac_remember=0 (the seeded free plan) records nothing.
  const g2 = grantGuest(db, { plugin: { planGroup: 'free' }, guest: {}, mac: MAC2, inputs: [] });
  assert.equal(listUserDevices(db, g2.username).length, 0);

  assert.equal(revokeGrant(db, stored.id), true);
  assert.equal(ownerOfMac(db, MAC), null);
  assert.deepEqual(radcheckOf(db, MAC), []);
});

test('sweepPluginGrants: a legacy ISO expires_at row expires on time and takes its devices with it', () => {
  const db = freshDb();
  // ISO string 1 minute in the past. Text-compared with datetime('now') it
  // would sort AFTER today ('T' > ' ') and survive for a day — the old bug.
  const iso = new Date(Date.now() - 60_000).toISOString();
  db.prepare("INSERT INTO plugin_grants (username, expires_at, active) VALUES ('pg-LEGACY', ?, 1)").run(iso);
  db.prepare("INSERT INTO user_devices (username, mac, groupname, expires_at) VALUES ('pg-LEGACY', ?, 'free', datetime('now', '+1 hour'))").run(MAC);
  assert.equal(sweepPluginGrants(db), 1);
  assert.equal(db.prepare("SELECT active FROM plugin_grants WHERE username = 'pg-LEGACY'").get().active, 0);
  assert.equal(ownerOfMac(db, MAC), null);
});

test('voucher sweeper expiry and voucher revoke forget the voucher\'s devices', async () => {
  const db = freshDb();
  const plan = addPlan(db, { name: 'Rem', group: 'rem', validity: 3600 });
  addVoucher(db, 'OLD1', plan, { validUntil: now(db, '-1 minute') });
  recordDevice(db, { username: 'OLD1', mac: MAC, groupname: 'rem', expiresAt: now(db, '+1 hour') });
  sweepVouchers(db);
  assert.equal(db.prepare("SELECT status FROM vouchers WHERE code = 'OLD1'").get().status, 'expired');
  assert.equal(ownerOfMac(db, MAC), null);

  const { default: manageRoutes } = await import('../src/admin/manage.js');
  const app = Fastify();
  app.decorate('db', db);
  await app.register(manageRoutes);
  addVoucher(db, 'LIVE1', plan);
  recordDevice(db, { username: 'LIVE1', mac: MAC2, groupname: 'rem', expiresAt: now(db, '+1 hour') });
  const id = db.prepare("SELECT id FROM vouchers WHERE code = 'LIVE1'").get().id;
  const res = await app.inject({ method: 'POST', url: `/api/vouchers/${id}/revoke` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().forgotDevices, 1);
  assert.equal(ownerOfMac(db, MAC2), null);
  assert.deepEqual(radcheckOf(db, MAC2), []);

  // Account disable + delete.
  db.prepare("INSERT INTO accounts (username, password, plan_id) VALUES ('bob', 'pw123456', ?)").run(plan.id);
  const accId = db.prepare("SELECT id FROM accounts WHERE username = 'bob'").get().id;
  recordDevice(db, { username: 'bob', mac: MAC, groupname: 'rem', expiresAt: now(db, '+1 hour') });
  let r = await app.inject({ method: 'PATCH', url: `/api/accounts/${accId}`, payload: { enabled: false } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(ownerOfMac(db, MAC), null);
  recordDevice(db, { username: 'bob', mac: MAC, groupname: 'rem', expiresAt: now(db, '+1 hour') });
  r = await app.inject({ method: 'DELETE', url: `/api/accounts/${accId}` });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(ownerOfMac(db, MAC), null);
  await app.close();
});

test('forgetUserDevices forgets every active device of the user only', () => {
  const db = freshDb();
  recordDevice(db, { username: 'u1', mac: MAC, groupname: 'free', expiresAt: now(db, '+1 hour') });
  recordDevice(db, { username: 'u1', mac: MAC2, groupname: 'free', expiresAt: now(db, '+1 hour') });
  recordDevice(db, { username: 'u2', mac: 'AA:BB:CC:DD:EE:03', groupname: 'free', expiresAt: now(db, '+1 hour') });
  assert.equal(forgetUserDevices(db, 'u1'), 2);
  assert.equal(forgetUserDevices(db, 'u1'), 0);
  assert.equal(listActiveDevices(db).length, 1);
});

test('migrate: pre-0.18 mac_sessions rows move to user_devices (as Auth-Type Accept users) and the table is dropped', () => {
  // A migrated DB, then the pre-0.18 table added back by hand.
  const db = new Database(':memory:');
  migrate(db);
  db.exec("INSERT INTO plans (name, radius_groupname, mac_remember, mac_validity_secs) VALUES ('Day', 'day', 1, 3600)");
  const planId = db.prepare("SELECT id FROM plans WHERE radius_groupname = 'day'").get().id;
  db.exec(`CREATE TABLE mac_sessions (
             id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL UNIQUE, identity TEXT,
             plan_id INTEGER, rate_limit TEXT, total_limit_bytes INTEGER, session_timeout_secs INTEGER,
             granted_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
             active INTEGER NOT NULL DEFAULT 1)`);
  db.exec(`INSERT INTO mac_sessions (mac, identity, plan_id, granted_at, expires_at, active) VALUES
             ('aa:bb:cc:dd:ee:01', 'V1', ${planId}, '2026-10-01 10:00:00', datetime('now', '+1 hour'), 1),
             ('AA:BB:CC:DD:EE:02', 'V2', ${planId}, '2026-09-01 10:00:00', '2026-09-02 10:00:00', 0)`);
  db.exec("INSERT INTO radcheck (username, attribute, op, value) VALUES ('aa:bb:cc:dd:ee:01', 'Cleartext-Password', ':=', 'aa:bb:cc:dd:ee:01')");

  migrate(db);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'mac_sessions'").get(), undefined);
  const rows = db.prepare('SELECT * FROM user_devices ORDER BY mac').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].username, 'V1');
  assert.equal(rows[0].source, 'legacy');
  assert.equal(rows[0].groupname, 'day');
  assert.equal(rows[0].first_seen, '2026-10-01 10:00:00');
  assert.equal(rows[0].active, 1);
  assert.equal(rows[1].active, 0);
  assert.deepEqual(radcheckOf(db, MAC), [{ attribute: 'Auth-Type', op: ':=', value: 'Accept' }]);
  assert.equal(groupOf(db, MAC), 'day');
  assert.deepEqual(radcheckOf(db, 'aa:bb:cc:dd:ee:01'), []);
  assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, '9');

  // Idempotent.
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_devices').get().c, 2);
});

test(`pruneNow purges inactive user_devices / plugin_grants ${USER_PURGE_DAYS} days after expiry`, () => {
  const db = freshDb();
  const nowMs = Date.UTC(2026, 9, 29, 12, 0, 0);
  const ins = db.prepare('INSERT INTO user_devices (username, mac, expires_at, active) VALUES (?, ?, ?, ?)');
  ins.run('old', 'AA:00:00:00:00:01', '2026-10-21 12:00:00', 0); // 8 days -> purged
  ins.run('recent', 'AA:00:00:00:00:02', '2026-10-23 12:00:00', 0); // 6 days -> kept
  ins.run('active-old', 'AA:00:00:00:00:03', '2026-10-01 12:00:00', 1); // active -> kept
  const g = db.prepare('INSERT INTO plugin_grants (username, expires_at, active) VALUES (?, ?, ?)');
  g.run('pg-OLD', '2026-10-20T12:00:00.000Z', 0); // legacy ISO, 9 days -> purged
  g.run('pg-NEW', '2026-10-28 12:00:00', 0);

  const res = pruneNow(db, nowMs);
  assert.equal(res.user_devices, 1);
  assert.equal(res.plugin_grants, 1);
  assert.deepEqual(db.prepare('SELECT username FROM user_devices ORDER BY username').all().map((r) => r.username), ['active-old', 'recent']);
  assert.deepEqual(db.prepare('SELECT username FROM plugin_grants').all().map((r) => r.username), ['pg-NEW']);
});
