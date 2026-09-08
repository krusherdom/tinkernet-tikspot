// First-run setup wizard backend + router settings + MAC-session views.

import { randomBytes } from 'node:crypto';
import os from 'node:os';

// First non-loopback IPv4 of this process — inside the container that is its
// veth address on the router bridge (the value the router must be told).
export function detectContainerIp() {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
import { getSetting, setSetting, getBool, getJSON } from '../db/settings.js';
import { hashPassword } from './auth.js';
import { RouterOS, autoConfigure, verifyConfig, listManaged, isPermissionError } from '../mikrotik/rest.js';
import { buildSetupScript } from '../mikrotik/script.js';
import { activeMacSessions } from '../mac/grants.js';
import { removeUser } from '../radius/sync.js';
import { ensureNasSecret } from '../radius/nas.js';
import { applyNasSecret } from '../radius/clientsconf.js';
import { validateRouterSettings } from './validate.js';
import { logEvent } from './events.js';
import { logAudit } from './audit.js';
import { buildHelp } from './help.js';

const COOKIE = 'tikspot_sess';

function serverHostOf(serverName) {
  return String(serverName || '').split('|')[0].trim();
}

// hotspot_profiles is stored as a JSON array (or absent) — narrow it to
// `null` (every profile) or a non-empty array of names, never `[]`.
function hotspotProfilesSetting(db) {
  const p = getJSON(db, 'hotspot_profiles', null);
  return Array.isArray(p) && p.length ? p : null;
}

export function routerFromSettings(db) {
  const scheme = getSetting(db, 'router_scheme', 'https');
  const host = getSetting(db, 'router_host', null);
  if (!host) return null;
  return new RouterOS({
    baseUrl: `${scheme}://${host}`,
    username: getSetting(db, 'router_user', 'admin'),
    password: getSetting(db, 'router_pass', ''),
  });
}

export default async function setupRoutes(app) {
  const db = app.db;

  app.get('/api/setup/state', async () => ({
    setup_complete: getBool(db, 'setup_complete', false),
    has_admin: !!getSetting(db, 'admin_password_hash', null),
    has_nas_secret: Boolean(getSetting(db, 'nas_secret', null)),
    // The container's own IPv4 on the router bridge — the wizard prefills the
    // Container IP field with it so the operator doesn't guess a neighbour's.
    detected_ip: detectContainerIp(),
    router: {
      scheme: getSetting(db, 'router_scheme', 'https'),
      host: getSetting(db, 'router_host', ''),
      username: getSetting(db, 'router_user', 'admin'),
      container_ip: getSetting(db, 'container_ip', ''),
      server_name: getSetting(db, 'server_name', ''),
      configured: getBool(db, 'router_configured', false),
    },
  }));

  // Set the admin password (first run) and log the browser in to continue.
  app.post('/api/setup/admin', async (req, reply) => {
    const { password } = req.body ?? {};
    if (!password || String(password).length < 6) {
      return reply.code(400).send({ error: 'password must be at least 6 characters' });
    }
    // Only allowed pre-setup, or when already authed (handled by the auth gate).
    if (getSetting(db, 'admin_password_hash', null) && !getBool(db, 'setup_complete', false)) {
      // allow overwrite during setup
    }
    setSetting(db, 'admin_password_hash', hashPassword(password));
    logAudit(db, req, 'admin.password-set');
    reply.setCookie(COOKIE, 'admin', {
      signed: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 7,
    });
    return { ok: true };
  });

  // Store router connection + network settings.
  app.post('/api/setup/router', async (req, reply) => {
    const b = req.body ?? {};
    const v = validateRouterSettings(b);
    if (!v.ok) return reply.code(400).send({ error: v.error, fields: v.fields });
    const values = v.values;

    const map = {
      router_scheme: values.scheme, router_host: values.host,
      container_ip: values.container_ip, server_name: values.server_name,
    };
    for (const [k, val] of Object.entries(map)) if (val !== undefined) setSetting(db, k, val);
    // username/password are not covered by validateRouterSettings — pass through.
    if (b.username !== undefined) setSetting(db, 'router_user', b.username);
    if (b.password !== undefined) setSetting(db, 'router_pass', b.password);

    // Only touch the NAS secret when a NEW, non-empty value was actually posted —
    // an empty nas_secret means "leave it alone" (validateSecret allows '' through
    // as a no-op, it must never blank out / reload against the real secret).
    let warning;
    const newSecret = values.nas_secret;
    if (newSecret) {
      const changed = newSecret !== getSetting(db, 'nas_secret', null);
      if (changed) {
        setSetting(db, 'nas_secret', newSecret);
        const { degraded } = await applyNasSecret(db);
        if (degraded) {
          warning = 'RADIUS secret written but radiusd reload failed — restart the container';
          logEvent(db, 'warn', 'radius', 'radiusd reload failed after secret change');
        }
      }
    }

    logAudit(db, req, 'router.settings', `host=${values.host ?? getSetting(db, 'router_host', '')}`);
    return warning ? { ok: true, warning } : { ok: true };
  });

  // Probe the router (connectivity + auth check).
  app.post('/api/setup/probe', async (_req, reply) => {
    const router = routerFromSettings(db);
    if (!router) return reply.code(400).send({ error: 'router not configured' });
    try {
      const r = await router.probe();
      let canWrite = true;
      try {
        await router.list('/user');
      } catch (err) {
        if (err?.status === 403 || isPermissionError(err)) canWrite = false;
      }
      return { ok: true, version: r?.version, board: r?.['board-name'], canWrite };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: String(err.message ?? err) });
    }
  });

  // Auto-configure the router over REST.
  app.post('/api/setup/autoconfig', async (req, reply) => {
    const router = routerFromSettings(db);
    if (!router) return reply.code(400).send({ error: 'router not configured' });
    try {
      // Ensure a real shared secret exists (generates + persists a strong random
      // one if the admin didn't set one) — never the old "testing123" placeholder.
      const result = await autoConfigure(router, {
        containerIp: getSetting(db, 'container_ip', ''),
        nasSecret: ensureNasSecret(db),
        serverHost: serverHostOf(getSetting(db, 'server_name', '')),
        profiles: hotspotProfilesSetting(db),
      });

      // Make the container accept exactly the secret we just gave the router.
      const { degraded } = await applyNasSecret(db);
      if (degraded) {
        result.warning = 'RADIUS secret written but radiusd reload failed — restart the container';
        logEvent(db, 'warn', 'radius', 'radiusd reload failed after secret change');
      }

      if (result.ok) setSetting(db, 'router_configured', '1');
      logAudit(db, req, 'router.autoconfig', result.ok ? 'ok' : `failed: ${result.error || 'unknown'}`);

      // A step actually completing means the router was reachable — only refuse
      // with a 502 when NOTHING got done and the failure looks network-level.
      const noStepsDone = !result.steps.some((s) => s.status === 'done');
      if (result.unreachable && noStepsDone) {
        return reply.code(502).send(result);
      }
      return result;
    } catch (err) {
      logAudit(db, req, 'router.autoconfig', `failed: ${String(err.message ?? err)}`);
      return reply.code(502).send({ ok: false, error: String(err.message ?? err) });
    }
  });

  app.post('/api/setup/verify', async (_req, reply) => {
    const router = routerFromSettings(db);
    if (!router) return reply.code(400).send({ error: 'router not configured' });
    try {
      return await verifyConfig(router, {
        containerIp: getSetting(db, 'container_ip', ''),
        serverHost: serverHostOf(getSetting(db, 'server_name', '')),
      });
    } catch (err) {
      return reply.code(502).send({ ok: false, error: String(err.message ?? err) });
    }
  });

  app.post('/api/setup/finish', async () => {
    setSetting(db, 'setup_complete', '1');
    return { ok: true };
  });

  // Generate idempotent RouterOS commands equivalent to Auto-configure, so the admin
  // can configure the router by hand (no write credentials needed in the container).
  app.get('/api/setup/script', async (_req) => ({
    script: buildSetupScript({
      containerIp: getSetting(db, 'container_ip', ''),
      serverHost: serverHostOf(getSetting(db, 'server_name', '')),
      nasSecret: ensureNasSecret(db),
    }),
  }));

  // List the router objects Tikspot manages (tagged by comment) so the admin can
  // see/audit exactly what was configured on the router.
  app.get('/api/setup/router-objects', async (_req, reply) => {
    const router = routerFromSettings(db);
    if (!router) return reply.code(400).send({ error: 'router not configured' });
    try {
      return { ok: true, objects: await listManaged(router) };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: String(err.message ?? err) });
    }
  });

  // Rotate the RADIUS shared secret: generate a new one, persist it, and make the
  // container accept it immediately. The router itself is NOT updated here — it
  // still expects the old secret until Auto-configure (or the manual script) is
  // re-run, so the response says as much. The new secret is never returned.
  app.post('/api/setup/rotate-secret', async (req, reply) => {
    const secret = randomBytes(16).toString('hex');
    setSetting(db, 'nas_secret', secret);
    const { degraded } = await applyNasSecret(db);
    logAudit(db, req, 'router.rotate-secret');
    const warning = degraded
      ? 'RADIUS secret written but radiusd reload failed — restart the container'
      : undefined;
    if (degraded) logEvent(db, 'warn', 'radius', 'radiusd reload failed after secret change');
    return {
      ok: true,
      degraded,
      ...(warning ? { warning } : {}),
      note: 'Re-run Auto-configure or the setup script so the router learns the new secret',
    };
  });

  // Static help content: router-setup checklist, doc links, and a symptom table.
  app.get('/api/help', async () => buildHelp());

  // ---- Remembered devices (MAC re-auth) ----
  app.get('/api/mac', async () => ({ mac_sessions: activeMacSessions(db) }));
  app.delete('/api/mac/:mac', async (req) => {
    const mac = req.params.mac;
    removeUser(db, mac);
    db.prepare('UPDATE mac_sessions SET active = 0 WHERE mac = ?').run(mac);
    return { ok: true };
  });
}
