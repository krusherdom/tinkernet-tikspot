// DB init entrypoint — run by the s6 `db-init` oneshot before radiusd and the
// Node server start. Creates/migrates the shared SQLite DB and seeds the default
// free plan + credential, so FreeRADIUS opens a fully-formed database.
//
// Zero-touch deployment (TIKSPOT_* env, see bootstrap/env.js) hooks in twice:
// a TIKSPOT_RESTORE_FILE is staged before the restore-promote step, and the
// env settings/admin password/plugin are applied after seeding — before the
// free-credential sync and clients.conf, so both see the bootstrapped values.
// Bootstrap failures are warnings, never a failed db-init.

import fs from 'node:fs';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seedDefaults } from './seed.js';
import { ensureDefaultDesign, activeModel } from './portal/designs.js';
import { syncFreeCredentials } from './design/credentials.js';
import { promoteStagedRestore } from './admin/backup.js';
import { ensureNasSecret } from './radius/nas.js';
import { writeClientsConf } from './radius/clientsconf.js';
import { readBootstrapEnv } from './bootstrap/env.js';
import { maybeRestoreFromFile, applyBootstrap } from './bootstrap/apply.js';
import { DB_PATH, ASSETS_DIR } from './config.js';

async function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  let spec = null;
  let restore = null;
  try {
    spec = readBootstrapEnv(process.env);
    restore = await maybeRestoreFromFile(spec);
  } catch (err) {
    console.warn('[tikspot-db-init] bootstrap restore skipped:', String(err?.message || err));
  }
  // If a restore was staged via the admin Backup page, swap it in before opening.
  if (promoteStagedRestore()) console.log('[tikspot-db-init] promoted staged restore');
  const db = openDb();
  try {
    migrate(db);
    seedDefaults(db);
    ensureDefaultDesign(db);
    try {
      if (spec) applyBootstrap(db, spec, { restore });
    } catch (err) {
      console.warn('[tikspot-db-init] environment bootstrap failed:', String(err?.message || err));
    }
    // Guards the restore-of-redacted-backup gap: a redacted backup strips
    // free_credentials, but the active design may still reference non-"free"
    // plans via free-login blocks — re-derive/re-sync those RADIUS users now,
    // before radiusd starts, rather than waiting on a design re-publish.
    syncFreeCredentials(db, activeModel(db));
    // Trust the router (and LAN NAS clients) in FreeRADIUS using the shared secret,
    // before radiusd starts. Without this, stock config only trusts localhost and
    // the router's requests are dropped as "unknown client".
    const wroteClients = writeClientsConf(ensureNasSecret(db));
    const plans = db.prepare('SELECT COUNT(*) AS n FROM plans').get().n;
    const checks = db.prepare('SELECT COUNT(*) AS n FROM radcheck').get().n;
    const designs = db.prepare('SELECT COUNT(*) AS n FROM designs').get().n;
    console.log(
      `[tikspot-db-init] ${DB_PATH} ready — ${plans} plan(s), ${checks} radcheck row(s), ${designs} design(s)` +
        `, clients.conf ${wroteClients ? 'written' : 'skipped (no raddb)'}`,
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('[tikspot-db-init] FAILED:', err);
  process.exit(1);
});
