// Remembered devices (MAC re-auth, 0.18).
//
// Each client MAC is remembered against the USER that logged in on it: a
// voucher code, a named account, or a plugin guest (`pg-*`). An active
// user_devices row is mirrored as a RADIUS user (username = MAC, radcheck
// `Auth-Type := Accept`, radusergroup = the user's plan group) so RouterOS
// hotspot login-by=mac (mac-as-username, EMPTY password) silently re-admits the
// device — but only while the user itself is valid:
//
//   expires_at = MIN(user expiry, now + plan.mac_validity_secs)
//
// where user expiry is the plugin grant's expires_at (pg-*), the voucher's
// valid_until, or none for accounts. Devices are forgotten (RADIUS user removed,
// row deactivated) when they expire (sweepDevices) or when their user is
// revoked / disabled / deleted / kicked (forgetUserDevices / forgetDevice).
// Inactive rows are purged 7 days after expiry by admin/retention.js.
//
// All timestamps are SQLite 'YYYY-MM-DD HH:MM:SS' UTC. MACs are canonical
// uppercase colon-separated (normMac).

import { syncMacUser, removeUser } from '../radius/sync.js';

// Canonical MAC: 'AA:BB:CC:DD:EE:FF'. Accepts ':' '-' '.' separators (or none)
// and any case. Returns null for anything that isn't 12 hex digits.
export function normMac(s) {
  if (s == null) return null;
  const hex = String(s).trim().replace(/[:\-.\s]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null;
  return hex.toUpperCase().match(/.{2}/g).join(':');
}

const nowSql = (db) => db.prepare("SELECT datetime('now') AS d").get().d;

// When does `username` stop being valid? SQLite datetime, or null = no fixed
// end (accounts, ungated vouchers). `false` = the user is not valid at all
// (no active plugin grant, revoked/expired voucher).
function userExpiry(db, username) {
  const u = String(username);
  if (u.startsWith('pg-')) {
    const g = db
      .prepare('SELECT datetime(expires_at) AS d FROM plugin_grants WHERE username = ? AND active = 1')
      .get(u);
    return g && g.d ? g.d : false;
  }
  const v = db.prepare('SELECT status, datetime(valid_until) AS d FROM vouchers WHERE code = ?').get(u);
  if (v) {
    if (v.status === 'revoked' || v.status === 'expired') return false;
    return v.d || null;
  }
  return null; // named account (or anything else): no fixed end
}

// deviceExpiry(db, { username, plan }) -> SQLite datetime string | null.
// MIN(user expiry, now + plan.mac_validity_secs); null when neither bounds it
// (or the user is no longer valid) — the caller then doesn't remember the device.
export function deviceExpiry(db, { username, plan } = {}) {
  const user = userExpiry(db, username);
  if (user === false) return null;
  let cap = null;
  const secs = plan && plan.mac_validity_secs != null ? Number(plan.mac_validity_secs) : NaN;
  if (Number.isFinite(secs) && secs > 0) {
    cap = db.prepare("SELECT datetime('now', '+' || ? || ' seconds') AS d").get(Math.trunc(secs)).d;
  }
  if (user && cap) return user < cap ? user : cap;
  return user || cap || null;
}

// The single active row for a MAC (or undefined).
function activeRow(db, mac) {
  return db.prepare('SELECT * FROM user_devices WHERE mac = ? AND active = 1').get(mac);
}

// recordDevice(db, { username, mac, planId, groupname, expiresAt, source }) -> row
// Upsert the device against `username` (one active owner per MAC: a MAC seen
// under a different user is reassigned) and project it as a RADIUS MAC user.
export function recordDevice(
  db,
  { username, mac, planId = null, groupname = null, expiresAt, source = 'session' } = {},
) {
  const m = normMac(mac);
  if (!m) throw new Error(`invalid MAC: ${mac}`);
  if (!username) throw new Error('username is required');
  if (!expiresAt) throw new Error('expiresAt is required');
  const exp = db.prepare('SELECT datetime(?) AS d').get(String(expiresAt)).d;
  if (!exp) throw new Error(`invalid expiresAt: ${expiresAt}`);
  let id;
  db.transaction(() => {
    const cur = activeRow(db, m);
    if (cur && cur.username === String(username)) {
      db.prepare(
        `UPDATE user_devices SET last_seen = datetime('now'), expires_at = ?, plan_id = ?, groupname = ?
          WHERE id = ?`,
      ).run(exp, planId ?? null, groupname ?? null, cur.id);
      id = cur.id;
    } else if (cur) {
      db.prepare(
        `UPDATE user_devices SET username = ?, plan_id = ?, groupname = ?, source = ?,
                expires_at = ?, last_seen = datetime('now')
          WHERE id = ?`,
      ).run(String(username), planId ?? null, groupname ?? null, source, exp, cur.id);
      id = cur.id;
    } else {
      id = db
        .prepare(
          `INSERT INTO user_devices (username, mac, plan_id, groupname, source, expires_at, active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(String(username), m, planId ?? null, groupname ?? null, source, exp).lastInsertRowid;
    }
    syncMacUser(db, { mac: m, groupname });
  })();
  return db.prepare('SELECT * FROM user_devices WHERE id = ?').get(id);
}

// Bump last_seen on the active row for a MAC. Returns true if one was touched.
export function touchDevice(db, mac) {
  const m = normMac(mac);
  if (!m) return false;
  return (
    db.prepare("UPDATE user_devices SET last_seen = datetime('now') WHERE mac = ? AND active = 1").run(m)
      .changes > 0
  );
}

// Forget one device: remove its RADIUS MAC user and deactivate the row.
// Returns true if an active device was forgotten.
export function forgetDevice(db, mac) {
  const m = normMac(mac);
  if (!m) return false;
  let changed = 0;
  db.transaction(() => {
    removeUser(db, m);
    changed = db.prepare('UPDATE user_devices SET active = 0 WHERE mac = ? AND active = 1').run(m).changes;
  })();
  return changed > 0;
}

// Forget every active device of a user. Returns the count.
export function forgetUserDevices(db, username) {
  if (username == null) return 0;
  const u = String(username);
  const rows = db.prepare('SELECT mac FROM user_devices WHERE username = ? AND active = 1').all(u);
  if (!rows.length) return 0;
  db.transaction(() => {
    for (const { mac } of rows) removeUser(db, mac);
    db.prepare('UPDATE user_devices SET active = 0 WHERE username = ? AND active = 1').run(u);
  })();
  return rows.length;
}

// Forget devices whose expires_at has passed. Returns the count.
export function sweepDevices(db) {
  const rows = db
    .prepare("SELECT id, mac FROM user_devices WHERE active = 1 AND datetime(expires_at) <= datetime('now')")
    .all();
  if (!rows.length) return 0;
  db.transaction(() => {
    const off = db.prepare('UPDATE user_devices SET active = 0 WHERE id = ?');
    for (const r of rows) {
      removeUser(db, r.mac);
      off.run(r.id);
    }
  })();
  return rows.length;
}

const LIST_COLS = `d.id, d.username, d.mac, d.plan_id, p.name AS plan_name, d.groupname, d.source,
                   d.first_seen, d.last_seen, d.expires_at`;

export function listActiveDevices(db) {
  return db
    .prepare(
      `SELECT ${LIST_COLS}
         FROM user_devices d LEFT JOIN plans p ON p.id = d.plan_id
        WHERE d.active = 1 ORDER BY d.expires_at, d.id`,
    )
    .all();
}

// A user's devices (newest first). `includeInactive` adds forgotten/expired
// rows (each row then carries `active`).
export function listUserDevices(db, username, { includeInactive = false } = {}) {
  return db
    .prepare(
      `SELECT ${LIST_COLS}, d.active
         FROM user_devices d LEFT JOIN plans p ON p.id = d.plan_id
        WHERE d.username = ? ${includeInactive ? '' : 'AND d.active = 1'}
        ORDER BY d.active DESC, d.last_seen DESC, d.id DESC`,
    )
    .all(String(username));
}

// Username that currently owns a MAC (active row), or null.
export function ownerOfMac(db, mac) {
  const m = normMac(mac);
  if (!m) return null;
  const r = activeRow(db, m);
  return r ? r.username : null;
}

// Capture devices from live sessions (runs on the background sweep). For each
// open radacct session:
//  - a MAC login (username == calling-station-id) -> touch its device;
//  - a user login on a mac_remember plan -> remember the MAC against the user
//    (or just touch it if this user already owns it).
// Returns { recorded, touched }.
export function processDeviceCapture(db) {
  const rows = db
    .prepare(
      `SELECT DISTINCT ra.username, ra.callingstationid AS mac,
              p.id AS plan_id, p.radius_groupname AS groupname,
              p.mac_remember, p.mac_validity_secs
         FROM radacct ra
         LEFT JOIN radusergroup rug ON rug.username = ra.username
         LEFT JOIN plans p ON p.radius_groupname = rug.groupname
        WHERE ra.acctstoptime IS NULL
          AND ra.callingstationid IS NOT NULL AND ra.callingstationid <> ''`,
    )
    .all();
  let recorded = 0;
  let touched = 0;
  const seen = new Set();
  const now = nowSql(db);
  for (const r of rows) {
    const mac = normMac(r.mac);
    if (!mac || !r.username) continue;
    const key = `${r.username}|${mac}`;
    if (seen.has(key)) continue;
    if (normMac(r.username) === mac) {
      seen.add(key);
      if (touchDevice(db, mac)) touched++;
      continue;
    }
    if (r.mac_remember !== 1) continue;
    seen.add(key);
    const cur = activeRow(db, mac);
    if (cur && cur.username === r.username) {
      if (touchDevice(db, mac)) touched++;
      continue;
    }
    const expiresAt = deviceExpiry(db, {
      username: r.username,
      plan: { mac_remember: r.mac_remember, mac_validity_secs: r.mac_validity_secs },
    });
    if (!expiresAt || expiresAt <= now) continue;
    recordDevice(db, {
      username: r.username,
      mac,
      planId: r.plan_id,
      groupname: r.groupname,
      expiresAt,
      source: 'session',
    });
    recorded++;
  }
  return { recorded, touched };
}
