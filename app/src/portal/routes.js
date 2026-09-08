// Captive-portal routes (the public surface the hotspot clients reach via the
// walled-garden). The MikroTik shim POSTs the hotspot session context here; we
// render the active design's page, whose login form posts back to the router's
// link-login to complete authentication. /status and /logout render through
// the same themed renderer (ctx.page), so they follow the active design too.

import { renderPortalPage } from './render.js';
import { activeModel } from './designs.js';
import { getSetting, getTyped, getJSON } from '../db/settings.js';
import { activeAnnouncements } from '../admin/announcements.js';
import { listPlugins, getPlugin } from '../plugins/store.js';
import { grantGuest } from '../plugins/grants.js';
import { runLookup, makeTokenCache } from '../plugins/engine.js';
import { makeRateLimiter, clientIp } from '../admin/ratelimit.js';
import { logEvent } from '../admin/events.js';

// Guest-lookup rate limiting: 10 attempts / 5 min, keyed independently by
// client IP and by MAC (either bucket filling up blocks further attempts) —
// blunts both a single brute-forcing client and a flood spread across many
// spoofed source IPs behind the same hotspot MAC. Module-level (one process,
// like admin/auth.js's login limiter) so buckets persist across requests.
const lookupIpLimiter = makeRateLimiter({ max: 10, windowMs: 5 * 60_000 });
const lookupMacLimiter = makeRateLimiter({ max: 10, windowMs: 5 * 60_000 });
// One token cache shared by every plugin lookup for the life of the process,
// keyed internally by recipe.id (see plugins/engine.js's getToken).
const lookupTokenCache = makeTokenCache();

function pluginsMap(db) {
  const map = {};
  for (const p of listPlugins(db)) map[String(p.id)] = p;
  return map;
}

// The hotspot host shown to direct-load visitors: the host part of the configured
// server-name (set in Router setup), falling back to the request's own host.
function hotspotHost(db, req) {
  const sn = getSetting(db, 'server_name', '') || '';
  const host = sn.split('|')[0].trim();
  return host || (req.headers?.host || '').split(':')[0];
}

// Pull the hotspot session context from a POST body (shim) or GET query
// (direct/preview). Field names use MikroTik's hyphenated spelling.
function readContext(req) {
  const src = { ...(req.query ?? {}), ...(req.body ?? {}) };
  return {
    mac: src.mac ?? '',
    ip: src.ip ?? '',
    username: src.username ?? '',
    linkLogin: src['link-login'] ?? src.linkLogin ?? '',
    linkLogout: src['link-logout'] ?? src.linkLogout ?? '',
    dst: src.dst ?? src['link-orig'] ?? '',
    error: src.error ?? '',
    chapId: src['chap-id'] ?? src.chapId ?? '',
    chapChallenge: src['chap-challenge'] ?? src.chapChallenge ?? '',
  };
}

function loginMethod(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'login_method'").get();
  return row?.value ?? 'pap';
}

export default async function portalRoutes(app) {
  const db = app.db;

  async function serveLogin(req, reply) {
    const ctx = readContext(req);
    ctx.chap = loginMethod(db) === 'chap';
    ctx.preview = (req.query?.preview ?? '') === '1';
    // Preview-only: lets the editor's "open in a tab" link show /status or
    // /logout without needing a real router session.
    ctx.page = ctx.preview && ['status', 'logout'].includes(req.query?.page) ? req.query.page : 'login';
    ctx.hotspotHost = hotspotHost(db, req);
    ctx.title = getTyped(db, 'portal_title');
    ctx.announcements = activeAnnouncements(db, ctx.page === 'login' ? 'portal' : ctx.page);
    ctx.freeCreds = getJSON(db, 'free_credentials', {}) || {};
    ctx.plugins = pluginsMap(db);
    reply.type('text/html').send(renderPortalPage(activeModel(db), ctx));
  }

  // The shim POSTs; browsers/preview may GET.
  app.get('/login', serveLogin);
  app.post('/login', serveLogin);
  app.get('/', serveLogin); // bare container hit shows the portal too

  // POST /portal/lookup/:id — a plugin-login block's form target. Runs the
  // recipe's guest lookup and, on success, mints a short-lived RADIUS
  // credential and re-renders the login page as an auto-submitting
  // "Connecting…" card (render.js's connectingCard) that completes the real
  // router login. On failure, re-renders the ordinary login page with an
  // error banner. Never logs secrets or submitted input values — only input
  // *names* (via the recipe's own messages/labels) make it into events.
  async function handleLookup(req, reply) {
    const id = Number(req.params.id);
    const ctx = readContext(req);
    ctx.chap = loginMethod(db) === 'chap';
    ctx.hotspotHost = hotspotHost(db, req);
    ctx.title = getTyped(db, 'portal_title');
    ctx.freeCreds = getJSON(db, 'free_credentials', {}) || {};
    ctx.plugins = pluginsMap(db);
    ctx.announcements = [];

    const renderError = (message, code = 200) => {
      ctx.error = message;
      reply.code(code).type('text/html').send(renderPortalPage(activeModel(db), ctx));
    };

    const ipCheck = lookupIpLimiter.check(clientIp(req));
    const macKey = ctx.mac || 'no-mac';
    const macCheck = lookupMacLimiter.check(macKey);
    if (!ipCheck.allowed || !macCheck.allowed) {
      return renderError('Too many attempts — please wait a few minutes', 429);
    }

    const recipe = getPlugin(db, id);
    if (!recipe || !recipe.enabled) {
      return renderError('Guest lookup is not configured.');
    }

    // A recipe's window may not specify its own leeway — in that case the
    // live `plugin_leeway_hours` setting is the default, applied here (not
    // baked in at save time) so changing the setting affects every recipe
    // that hasn't overridden it.
    if (recipe.window && (recipe.window.leewayHours === undefined || recipe.window.leewayHours === null)) {
      recipe.window.leewayHours = getTyped(db, 'plugin_leeway_hours');
    }

    const body = req.body ?? {};
    const inputs = (recipe.inputs || []).map((inp) => ({
      name: inp.name,
      required: !!inp.required,
      value: body[`in_${inp.name}`] ?? '',
    }));
    const missingRequired = inputs.some((i) => i.required && !String(i.value ?? '').trim());
    if (missingRequired) {
      return renderError('Please fill in all the required fields.');
    }

    let result;
    try {
      result = await runLookup({ recipe, inputs, tokenCache: lookupTokenCache });
    } catch (err) {
      logEvent(db, 'error', 'plugin', `Lookup threw for plugin ${recipe.name}`, {
        plugin: id,
        error: String(err?.message || err),
      });
      return renderError(recipe.messages?.upstream || 'The guest system is not responding — please try again or ask at reception.');
    }

    if (!result.ok) {
      const key = result.reason === 'no-match' ? 'noMatch' : result.reason === 'outside-window' ? 'outsideWindow' : 'upstream';
      const level = result.reason === 'upstream' || result.reason === 'timeout' ? 'warn' : 'info';
      logEvent(db, level, 'plugin', `Lookup ${result.reason} for plugin ${recipe.name}`, {
        plugin: id,
        reason: result.reason,
        status: result.status,
        mac: ctx.mac,
      });
      return renderError(recipe.messages?.[key] || 'We could not find a booking with those details.');
    }

    const grant = grantGuest(db, {
      plugin: recipe,
      guest: result.guest,
      expiresAt: result.expiresAt,
      mac: ctx.mac,
      ip: ctx.ip,
      inputs,
    });
    logEvent(db, 'info', 'plugin', 'Guest admitted', {
      plugin: id,
      mac: ctx.mac,
      label: result.guest.label,
      expiresAt: grant.expiresAt,
    });

    reply.type('text/html').send(
      renderPortalPage(activeModel(db), {
        ...ctx,
        page: 'login',
        autosubmit: { username: grant.username, password: grant.password, label: result.guest.label },
        announcements: [],
      }),
    );
  }

  app.post('/portal/lookup/:id', handleLookup);
  app.get('/portal/lookup/:id', async (_req, reply) => reply.redirect('/login'));

  async function serveStatus(req, reply) {
    const ctx = readContext(req);
    ctx.page = 'status';
    ctx.title = 'Connected';
    ctx.announcements = activeAnnouncements(db, 'status');
    reply.type('text/html').send(renderPortalPage(activeModel(db), ctx));
  }
  app.get('/status', serveStatus);
  app.post('/status', serveStatus);

  async function serveLogout(req, reply) {
    const ctx = readContext(req);
    ctx.page = 'logout';
    ctx.title = 'Logged out';
    reply.type('text/html').send(renderPortalPage(activeModel(db), ctx));
  }
  app.get('/logout', serveLogout);
  app.post('/logout', serveLogout);
}
