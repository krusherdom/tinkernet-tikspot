// Schema migration: create the FreeRADIUS tables and the Tikspot app tables in
// the shared SQLite DB. Both schema files are idempotent (IF NOT EXISTS), so
// this is safe to run on every boot.

import fs from 'node:fs';

const radiusSchema = fs.readFileSync(new URL('./schema-radius.sql', import.meta.url), 'utf8');
const appSchema = fs.readFileSync(new URL('./schema-app.sql', import.meta.url), 'utf8');

const SCHEMA_VERSION = '8';

// Add a column to a table only if it's missing (CREATE IF NOT EXISTS won't add
// columns to a pre-existing table).
function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export function migrate(db) {
  db.exec(radiusSchema);
  db.exec(appSchema);
  // Incremental column additions for DBs created before these columns existed.
  addColumnIfMissing(db, 'vouchers', 'valid_from', 'TEXT');
  addColumnIfMissing(db, 'vouchers', 'valid_until', 'TEXT');
  addColumnIfMissing(db, 'plans', 'expiry_mode', 'TEXT');
  addColumnIfMissing(db, 'designs', 'draft_json', 'TEXT');
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES ('schema_version', @v)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ v: SCHEMA_VERSION });
}
