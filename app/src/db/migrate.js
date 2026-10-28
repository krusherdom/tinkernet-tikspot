// Schema migration: create the FreeRADIUS tables and the Tikspot app tables in
// the shared SQLite DB. Both schema files are idempotent (IF NOT EXISTS), so
// this is safe to run on every boot.

import fs from 'node:fs';
import { syncMacUser, removeUser } from '../radius/sync.js';
import { normMac } from '../mac/devices.js';

const radiusSchema = fs.readFileSync(new URL('./schema-radius.sql', import.meta.url), 'utf8');
const appSchema = fs.readFileSync(new URL('./schema-app.sql', import.meta.url), 'utf8');

const SCHEMA_VERSION = '9';

// Add a column to a table only if it's missing (CREATE IF NOT EXISTS won't add
// columns to a pre-existing table).
function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// 0.18: the pre-0.18 `mac_sessions` table (MAC -> identity) becomes
// `user_devices` (MAC remembered against the user). Copy the rows over (source
// 'legacy'), re-project the still-active ones as Auth-Type := Accept MAC users
// (the old Cleartext-Password = MAC rows never matched the router's empty
// password), then drop the old table. A no-op on fresh DBs / once migrated.
function migrateMacSessions(db) {
  if (!tableExists(db, 'mac_sessions')) return;
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT ms.mac, ms.identity, ms.plan_id, ms.granted_at, ms.expires_at, ms.active,
                p.radius_groupname AS groupname
           FROM mac_sessions ms LEFT JOIN plans p ON p.id = ms.plan_id
          ORDER BY ms.id`,
      )
      .all();
    const ins = db.prepare(
      `INSERT INTO user_devices (username, mac, plan_id, groupname, source, first_seen, last_seen, expires_at, active)
       VALUES (@username, @mac, @plan_id, @groupname, 'legacy', @seen, @seen, @expires_at, @active)`,
    );
    for (const r of rows) {
      const mac = normMac(r.mac);
      if (!mac) continue;
      const active = r.active ? 1 : 0;
      if (active && db.prepare('SELECT 1 FROM user_devices WHERE mac = ? AND active = 1').get(mac)) continue;
      const expires =
        db.prepare('SELECT datetime(?) AS d').get(r.expires_at).d || db.prepare("SELECT datetime('now') AS d").get().d;
      ins.run({
        username: r.identity || mac,
        mac,
        plan_id: r.plan_id ?? null,
        groupname: r.groupname ?? null,
        seen: r.granted_at || db.prepare("SELECT datetime('now') AS d").get().d,
        expires_at: expires,
        active,
      });
      if (active) {
        if (r.mac !== mac) removeUser(db, r.mac); // old non-canonical RADIUS user
        syncMacUser(db, { mac, groupname: r.groupname ?? null });
      }
    }
    db.exec('DROP TABLE mac_sessions');
  })();
}

export function migrate(db) {
  db.exec(radiusSchema);
  db.exec(appSchema);
  // Incremental column additions for DBs created before these columns existed.
  addColumnIfMissing(db, 'vouchers', 'valid_from', 'TEXT');
  addColumnIfMissing(db, 'vouchers', 'valid_until', 'TEXT');
  addColumnIfMissing(db, 'plans', 'expiry_mode', 'TEXT');
  addColumnIfMissing(db, 'designs', 'draft_json', 'TEXT');
  migrateMacSessions(db);
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES ('schema_version', @v)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ v: SCHEMA_VERSION });
}
