// Backup & restore — migrate a whole Tikspot install (plans, vouchers, accounts,
// page designs, settings/secrets, branding assets) to another device, plus a
// snapshot of how this container sits on the router (for re-creating the network
// side on the new MikroTik).
//
// Backup: a zip of a consistent DB snapshot + /data/assets + a metadata JSON.
// Restore: stage the DB to /data/tikspot.db.restore + extract assets; the next
// container boot (db-init, app/src/init.js) promotes the staged DB in place. A
// restart is required because radiusd + Node hold the live DB open.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { buildHealth } from './system.js';
import { logAudit } from './audit.js';
import { DB_PATH, ASSETS_DIR, DATA_DIR, VERSION } from '../config.js';

const RESTORE_STAGE = path.join(DATA_DIR, 'tikspot.db.restore');

// Settings that are secret. Stripped from a backup unless ?secrets=1 is passed,
// so the default download is safe to share/store without leaking router creds,
// the NAS secret, the cookie-signing secret, or the admin password hash.
const SENSITIVE_KEYS = ['router_pass', 'nas_secret', 'session_secret', 'admin_password_hash', 'free_credentials'];

export default async function backupRoutes(app) {
  const db = app.db;

  app.get('/api/backup', async (req, reply) => {
    const res = reply;
    // config-only: a small, portable bundle — always redacted, with the unbounded
    // RADIUS accounting/auth-log history dropped (config + auth tables only).
    const configOnly = String(req.query?.config ?? '') === '1';
    const includeSecrets = !configOnly && String(req.query?.secrets ?? '') === '1';
    const tmp = path.join(DATA_DIR, `tikspot.snapshot.${process.pid}.db`);
    try {
      // Consistent online snapshot of the live DB.
      await db.backup(tmp);

      // Redact secrets from the snapshot itself (not just the metadata JSON) so a
      // shared backup can't leak credentials via the embedded DB; for a config-only
      // backup also drop the accounting tables and reclaim space.
      if (!includeSecrets) {
        const snap = new Database(tmp);
        try {
          const del = snap.prepare('DELETE FROM settings WHERE key = ?');
          for (const k of SENSITIVE_KEYS) del.run(k);
          // Plugin credentials (recipe username/password/apiKey) live outside
          // `settings`, so redact them here too.
          snap.exec("UPDATE plugins SET secrets_json = '{}'");
          if (configOnly) {
            snap.exec('DELETE FROM radacct; DELETE FROM radpostauth; DELETE FROM events; DELETE FROM plugin_grants; VACUUM;');
          }
        } finally {
          snap.close();
        }
      }

      const zip = new JSZip();
      zip.file('tikspot.db', fs.readFileSync(tmp));

      // Branding assets.
      if (fs.existsSync(ASSETS_DIR)) {
        for (const name of fs.readdirSync(ASSETS_DIR)) {
          const p = path.join(ASSETS_DIR, name);
          if (fs.statSync(p).isFile()) zip.file(`assets/${name}`, fs.readFileSync(p));
        }
      }

      // Metadata: settings (secrets included only when explicitly requested) +
      // router snapshot.
      const sensitive = new Set(SENSITIVE_KEYS);
      const settings = {};
      for (const row of db.prepare('SELECT key, value FROM settings').all()) {
        if (!includeSecrets && sensitive.has(row.key)) continue;
        settings[row.key] = row.value;
      }
      let routerSnapshot = null;
      try { routerSnapshot = await buildHealth(db); } catch { /* router optional */ }
      zip.file(
        'tikspot-backup.json',
        JSON.stringify(
          { format: 'tikspot-backup', version: VERSION, created_at: new Date().toISOString(), secrets_included: includeSecrets, config_only: configOnly, settings, router_snapshot: routerSnapshot },
          null,
          2,
        ),
      );

      const buf = await zip.generateAsync({ type: 'nodebuffer' });
      const stamp = new Date().toISOString().slice(0, 10);
      const kind = configOnly ? 'config' : 'backup';
      logAudit(db, req, 'backup.download', configOnly ? 'config-only' : includeSecrets ? 'with secrets' : 'redacted');
      res
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="tikspot-${kind}-${stamp}.zip"`)
        .send(buf);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  app.post('/api/restore', async (req, reply) => {
    const file = await req.file?.();
    if (!file) return reply.code(400).send({ error: 'expected a backup .zip upload' });
    const buf = await file.toBuffer();

    let zip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch {
      return reply.code(400).send({ error: 'not a valid zip file' });
    }
    const dbEntry = zip.file('tikspot.db');
    const metaEntry = zip.file('tikspot-backup.json');
    if (!dbEntry || !metaEntry) {
      return reply.code(400).send({ error: 'not a Tikspot backup (missing tikspot.db / tikspot-backup.json)' });
    }

    // Stage the DB; promoted on next boot by db-init.
    fs.writeFileSync(RESTORE_STAGE, await dbEntry.async('nodebuffer'));

    // Restore branding assets now (files, not the live DB).
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    let assetCount = 0;
    for (const name of Object.keys(zip.files)) {
      if (name.startsWith('assets/') && !zip.files[name].dir) {
        const base = path.basename(name);
        if (base) { fs.writeFileSync(path.join(ASSETS_DIR, base), await zip.files[name].async('nodebuffer')); assetCount++; }
      }
    }

    let meta = {};
    try { meta = JSON.parse(await metaEntry.async('string')); } catch { /* tolerate */ }
    logAudit(db, req, 'restore.staged', `from v${meta.version ?? '?'}, ${assetCount} assets`);
    return {
      ok: true,
      staged: true,
      from_version: meta.version ?? null,
      assets_restored: assetCount,
      message: 'Backup staged. Restart the container to complete the restore.',
    };
  });
}

// Called by db-init (app/src/init.js) BEFORE the DB is opened: if a restore was
// staged, replace the live DB with it and clear the WAL sidecars.
export function promoteStagedRestore() {
  if (!fs.existsSync(RESTORE_STAGE)) return false;
  for (const suffix of ['-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
  fs.rmSync(DB_PATH, { force: true });
  fs.renameSync(RESTORE_STAGE, DB_PATH);
  return true;
}
