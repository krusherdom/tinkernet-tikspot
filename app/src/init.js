// DB init entrypoint — run by the s6 `db-init` oneshot before radiusd and the
// Node server start. Creates/migrates the shared SQLite DB and seeds the default
// free plan + credential, so FreeRADIUS opens a fully-formed database.

import fs from 'node:fs';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seedDefaults } from './seed.js';
import { ensureDefaultDesign, activeModel } from './portal/designs.js';
import { syncFreeCredentials } from './design/credentials.js';
import { promoteStagedRestore } from './admin/backup.js';
import { ensureNasSecret } from './radius/nas.js';
import { writeClientsConf } from './radius/clientsconf.js';
import { DB_PATH, ASSETS_DIR } from './config.js';

function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  // If a restore was staged via the admin Backup page, swap it in before opening.
  if (promoteStagedRestore()) console.log('[tikspot-db-init] promoted staged restore');
  const db = openDb();
  try {
    migrate(db);
    seedDefaults(db);
    ensureDefaultDesign(db);
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

try {
  main();
} catch (err) {
  console.error('[tikspot-db-init] FAILED:', err);
  process.exit(1);
}
