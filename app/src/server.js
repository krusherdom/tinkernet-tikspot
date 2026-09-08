// Tikspot Node backend entrypoint.
//
// Serves two surfaces from one Fastify instance:
//   • the public captive portal (/login, /status, /logout, /m/*, /assets/*)
//   • the admin portal + API (/admin/*, /api/*)
// Both share one SQLite connection (app.db) — the same DB FreeRADIUS uses.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';

import { openDb } from './db/index.js';
import { HOST, PORT, VERSION, LOG_LEVEL, ASSETS_DIR } from './config.js';
import portalRoutes from './portal/routes.js';
import adminRoutes from './admin/routes.js';
import manageRoutes from './admin/manage.js';
import authRoutes, { makeAuthGate, ensureSessionSecret } from './admin/auth.js';
import setupRoutes from './admin/setup.js';
import logsRoutes from './admin/logs.js';
import systemRoutes from './admin/system.js';
import backupRoutes from './admin/backup.js';
import settingsRoutes from './admin/settingsRoutes.js';
import announcementRoutes from './admin/announcements.js';
import pluginRoutes from './admin/plugins.js';
import { processMacGrants, sweepMacSessions } from './mac/grants.js';
import { sweepVouchers } from './voucher/sweeper.js';
import { sweepMidnightExpiry } from './radius/midnight.js';
import { sweepRetention } from './admin/retention.js';
import { sweepPluginGrants } from './plugins/grants.js';
import { logEvent } from './admin/events.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const app = Fastify({ logger: { level: LOG_LEVEL } });

// One shared, writable SQLite handle for the whole process (better-sqlite3 is
// synchronous and safe to reuse across requests).
const db = openDb();
app.decorate('db', db);

// Don't leak internals to clients: pass through explicit 4xx messages (validation
// errors are safe and useful) but mask unexpected 5xx behind a generic message.
// Full detail is logged server-side.
app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) req.log.error({ err }, 'request failed');
  reply.code(status).send({ error: status < 500 ? err.message || 'request failed' : 'internal server error' });
});

// Cookies (signed session) + the global auth gate. Public paths (portal, static
// admin shell, health, auth/setup endpoints) pass; /api/* otherwise needs auth.
await app.register(cookie, { secret: ensureSessionSecret(db) });
app.addHook('onRequest', makeAuthGate(db));

// Body parsers: urlencoded (the MikroTik shim POST) and multipart (asset upload).
await app.register(formbody);
await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 } });

// Static roots. The first registration owns reply.sendFile; the rest opt out.
fs.mkdirSync(ASSETS_DIR, { recursive: true });
await app.register(fastifyStatic, {
  root: here('./portal/static'),
  prefix: '/m/',
});
await app.register(fastifyStatic, {
  root: here('../public/ds'),
  prefix: '/ds/',
  decorateReply: false,
});
await app.register(fastifyStatic, {
  root: here('../public/admin'),
  prefix: '/admin/',
  decorateReply: false,
});
await app.register(fastifyStatic, {
  root: ASSETS_DIR,
  prefix: '/assets/',
  decorateReply: false,
});

// Health + status. /healthz actually touches the DB so a broken SQLite file
// shows up here (the router's /tool/fetch triage step) instead of staying green.
app.get('/healthz', async (_req, reply) => {
  let dbOk = true;
  try {
    db.prepare('SELECT 1 FROM settings LIMIT 1').get();
  } catch {
    dbOk = false;
  }
  if (!dbOk) reply.code(503);
  return {
    status: dbOk ? 'ok' : 'degraded',
    service: 'tikspot',
    version: VERSION,
    db: dbOk,
    ts: new Date().toISOString(),
  };
});

app.get('/api/status', async (_req, reply) => {
  try {
    const plans = db
      .prepare('SELECT name, radius_groupname, rate_limit, total_limit_bytes, session_timeout_secs FROM plans ORDER BY id')
      .all();
    const radcheck = db.prepare('SELECT COUNT(*) AS n FROM radcheck').get().n;
    const radacct = db.prepare('SELECT COUNT(*) AS n FROM radacct').get().n;
    const designs = db.prepare('SELECT COUNT(*) AS n FROM designs').get().n;
    return { ok: true, version: VERSION, plans, radcheck, radacct, designs };
  } catch (err) {
    reply.code(503);
    return { ok: false, error: String(err.message ?? err) };
  }
});

// Feature routes.
await app.register(authRoutes);
await app.register(setupRoutes);
await app.register(adminRoutes);
await app.register(manageRoutes);
await app.register(logsRoutes);
await app.register(systemRoutes);
await app.register(backupRoutes);
await app.register(settingsRoutes);
await app.register(announcementRoutes);
await app.register(pluginRoutes);
await app.register(portalRoutes);

// Background sweeps: MAC re-auth grants/expiry, date-gated voucher windows,
// midnight-expiry plans, and daily log retention. Each sweep runs in its own
// try so one failure can't starve the others; failures are recorded as events
// (throttled per sweep so a persistent fault doesn't flood the log).
const SWEEP_INTERVAL_MS = Number(process.env.TIKSPOT_MAC_INTERVAL_MS ?? 20000);
const SWEEPS = [
  ['mac-grants', () => processMacGrants(db)],
  ['mac-expiry', () => sweepMacSessions(db)],
  ['vouchers', () => sweepVouchers(db)],
  ['midnight', () => sweepMidnightExpiry(db, app.log)],
  ['retention', () => sweepRetention(db, app.log)],
  ['plugin-grants', () => sweepPluginGrants(db)],
];
const sweepFailedAt = new Map();
const sweepTimer = setInterval(() => {
  for (const [name, fn] of SWEEPS) {
    try {
      fn();
    } catch (err) {
      app.log.warn({ err: String(err) }, `background sweep "${name}" failed`);
      const last = sweepFailedAt.get(name) || 0;
      if (Date.now() - last > 10 * 60 * 1000) {
        sweepFailedAt.set(name, Date.now());
        logEvent(db, 'warn', 'sweep', `Background sweep "${name}" failed`, String(err?.message || err));
      }
    }
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();
// Run once at startup so windows are correct immediately.
try { sweepVouchers(db); } catch { /* tables may not exist yet on very first boot */ }

async function main() {
  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`tikspot listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    app.log.info(`received ${sig}, shutting down`);
    app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

main();
