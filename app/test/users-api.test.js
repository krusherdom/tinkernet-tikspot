// 0.18 per-user detail: resolveUser across every login kind, GET
// /api/users/:username (devices + sessions by the user AND its MACs + auth
// log), MAC usernames redirecting to their owner, and forgetting a device.
import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';
import Fastify from 'fastify';

import { migrate } from '../src/db/migrate.js';
import { FREE_USERNAME } from '../src/config.js';
import usersRoutes, { resolveUser } from '../src/admin/users.js';
import { activeSessions } from '../src/radius/active.js';

const MAC1 = 'AA:BB:CC:00:00:01';
const MAC2 = 'AA:BB:CC:00:00:02';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  // Fallback while the schema is still landing (contract shape).
  db.exec(`CREATE TABLE IF NOT EXISTS user_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, mac TEXT NOT NULL,
    plan_id INTEGER, groupname TEXT, source TEXT NOT NULL DEFAULT 'session',
    first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
  return db;
}

function seed(db) {
  db.prepare("INSERT INTO plans (name, radius_groupname) VALUES ('Day pass', 'plan-day')").run();
  const planId = db.prepare("SELECT id FROM plans WHERE name = 'Day pass'").get().id;
  db.prepare("INSERT INTO vouchers (code, plan_id, status, batch_id) VALUES ('VOUCH123', ?, 'unused', 'b1')").run(planId);
  db.prepare("INSERT INTO vouchers (code, plan_id, status) VALUES ('GONE0001', ?, 'revoked')").run(planId);
  db.prepare("INSERT INTO accounts (username, password, plan_id, enabled) VALUES ('alice', 'pw', ?, 0)").run(planId);
  db.prepare("INSERT INTO plugins (name, recipe_json) VALUES ('Hotel PMS', '{}')").run();
  const pluginId = db.prepare("SELECT id FROM plugins WHERE name = 'Hotel PMS'").get().id;
  db.prepare(
    "INSERT INTO plugin_grants (plugin_id, username, guest_label, expires_at, active) VALUES (?, 'pg-abc', 'Smith, room 12', datetime('now', '+1 day'), 1)",
  ).run(pluginId);
  db.prepare("INSERT INTO radusergroup (username, groupname, priority) VALUES ('pg-abc', 'plan-day', 1)").run();
  // Devices remembered against the voucher: one active, one forgotten.
  db.prepare(
    "INSERT INTO user_devices (username, mac, plan_id, groupname, source, expires_at, active) VALUES ('VOUCH123', ?, ?, 'plan-day', 'session', datetime('now', '+1 day'), 1)",
  ).run(MAC1, planId);
  db.prepare(
    "INSERT INTO user_devices (username, mac, plan_id, groupname, source, expires_at, active) VALUES ('VOUCH123', ?, ?, 'plan-day', 'session', datetime('now', '-1 day'), 0)",
  ).run(MAC2, planId);
  return { planId };
}

let uid = 0;
function acct(db, { username, mac, start, stop = null }) {
  uid += 1;
  db.prepare(
    `INSERT INTO radacct (acctsessionid, acctuniqueid, username, callingstationid, framedipaddress, acctstarttime, acctstoptime, acctsessiontime, acctinputoctets, acctoutputoctets, acctterminatecause)
     VALUES (?, ?, ?, ?, '10.0.0.5', ?, ?, 60, 1000, 2000, ?)`,
  ).run(`s${uid}`, `u${uid}`, username, mac, start, stop, stop ? 'User-Request' : '');
}

async function appFor(db) {
  const app = Fastify();
  app.decorate('db', db);
  await app.register(usersRoutes);
  return app;
}

test('resolveUser: voucher / account / guest / free / unknown / mac / missing', () => {
  const db = freshDb();
  const { planId } = seed(db);

  const v = resolveUser(db, 'VOUCH123');
  assert.equal(v.kind, 'voucher');
  assert.equal(v.status, 'unused');
  assert.deepEqual(v.plan, { id: planId, name: 'Day pass', groupname: 'plan-day' });
  assert.equal(v.meta.batch_id, 'b1');
  assert.equal(resolveUser(db, 'GONE0001').status, 'revoked');

  const a = resolveUser(db, 'alice');
  assert.equal(a.kind, 'account');
  assert.equal(a.status, 'disabled');
  assert.equal(a.plan.name, 'Day pass');

  const g = resolveUser(db, 'pg-abc');
  assert.equal(g.kind, 'guest');
  assert.equal(g.label, 'Smith, room 12');
  assert.equal(g.status, 'active');
  assert.equal(g.meta.plugin_name, 'Hotel PMS');
  assert.equal(g.plan.groupname, 'plan-day');
  assert.ok(g.expires_at);

  const f = resolveUser(db, FREE_USERNAME);
  assert.equal(f.kind, 'free');

  acct(db, { username: 'legacy-user', mac: MAC2, start: '2026-10-01 10:00:00', stop: '2026-10-01 11:00:00' });
  assert.equal(resolveUser(db, 'legacy-user').kind, 'unknown');

  const m = resolveUser(db, 'aa-bb-cc-00-00-01');
  assert.equal(m.kind, 'mac');
  assert.equal(m.owner, 'VOUCH123');
  // A forgotten device's MAC no longer resolves to its old owner.
  assert.equal(resolveUser(db, MAC2), null);

  assert.equal(resolveUser(db, 'nobody'), null);
});

test('GET /api/users/:username returns devices, sessions by user + its MACs, and auth', async () => {
  const db = freshDb();
  seed(db);
  acct(db, { username: 'VOUCH123', mac: MAC1, start: '2026-10-01 09:00:00', stop: '2026-10-01 10:00:00' });
  acct(db, { username: MAC1, mac: MAC1, start: '2026-10-02 09:00:00' }); // MAC re-auth, still online
  acct(db, { username: MAC2, mac: MAC2, start: '2026-09-30 09:00:00', stop: '2026-09-30 09:30:00' }); // forgotten device
  acct(db, { username: 'alice', mac: 'AA:BB:CC:99:99:99', start: '2026-10-03 09:00:00' }); // a different user
  db.prepare("INSERT INTO radpostauth (username, pass, reply, authdate) VALUES ('VOUCH123', 'x', 'Access-Accept', '2026-10-01 09:00:00')").run();
  db.prepare("INSERT INTO radpostauth (username, pass, reply, authdate) VALUES (?, '', 'Access-Accept', '2026-10-02 09:00:00')").run(MAC1);
  db.prepare("INSERT INTO radpostauth (username, pass, reply, authdate) VALUES ('alice', 'x', 'Access-Reject', '2026-10-02 09:00:00')").run();

  const app = await appFor(db);
  const res = await app.inject({ method: 'GET', url: '/api/users/VOUCH123' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.user.kind, 'voucher');
  assert.equal(body.devices.length, 2);
  assert.deepEqual(body.devices.map((d) => d.mac).sort(), [MAC1, MAC2]);
  assert.equal(body.sessions.length, 3);
  assert.equal(body.sessions[0].username, MAC1); // newest first
  assert.equal(body.sessions[0].stop, null);
  assert.equal(body.sessions[0].ip, '10.0.0.5');
  assert.equal(body.sessions[0].in_octets, 1000);
  assert.ok(body.sessions.every((s) => s.username !== 'alice'));
  assert.equal(body.sessions.find((s) => s.stop).cause, 'User-Request');
  assert.equal(body.auth.length, 2);
  assert.ok(body.auth.every((a) => a.username !== 'alice'));
  await app.close();
});

test('GET /api/users/<MAC> redirects to the owner; unknown is 404', async () => {
  const db = freshDb();
  seed(db);
  const app = await appFor(db);
  let res = await app.inject({ method: 'GET', url: '/api/users/' + encodeURIComponent(MAC1) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { redirect: 'VOUCH123' });

  res = await app.inject({ method: 'GET', url: '/api/users/nobody' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'not found' });
  await app.close();
});

test('DELETE /api/users/:username/devices/:mac forgets the device and audits it', async () => {
  const db = freshDb();
  seed(db);
  const app = await appFor(db);
  let res = await app.inject({ method: 'DELETE', url: '/api/users/VOUCH123/devices/aa-bb-cc-00-00-01' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, forgot: true });
  assert.equal(db.prepare('SELECT active FROM user_devices WHERE mac = ?').get(MAC1).active, 0);
  assert.ok(db.prepare("SELECT 1 FROM admin_audit WHERE action = 'device.forget'").get());

  // Already forgotten -> ok but nothing forgotten.
  res = await app.inject({ method: 'DELETE', url: '/api/users/VOUCH123/devices/' + encodeURIComponent(MAC1) });
  assert.deepEqual(res.json(), { ok: true, forgot: false });

  res = await app.inject({ method: 'DELETE', url: '/api/users/VOUCH123/devices/not-a-mac' });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('activeSessions carries owner and by_mac', () => {
  const db = freshDb();
  seed(db);
  acct(db, { username: MAC1, mac: MAC1, start: '2026-10-02 09:00:00' });
  acct(db, { username: 'alice', mac: 'AA:BB:CC:99:99:99', start: '2026-10-02 08:00:00' });
  const rows = activeSessions(db);
  const byMac = rows.find((r) => r.username === MAC1);
  assert.equal(byMac.owner, 'VOUCH123');
  assert.equal(byMac.by_mac, true);
  const plain = rows.find((r) => r.username === 'alice');
  assert.equal(plain.owner, null);
  assert.equal(plain.by_mac, false);
  assert.ok('total_octets' in plain && 'acctsessionid' in plain);
});
