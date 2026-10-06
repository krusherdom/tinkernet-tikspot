// Captive-portal routes (the public surface the hotspot clients reach via the
// walled-garden). The MikroTik shim POSTs the hotspot session context here; we
// render the active design's page, whose login form posts back to the router's
// link-login to complete authentication. /status and /logout render through
// the same themed renderer (ctx.page), so they follow the active design too.

import { renderPortalPage } from './render.js';
import { activeModel } from './designs.js';
import { getSetting, getTyped, getJSON } from '../db/settings.js';
import { activeAnnouncements } from '../admin/announcements.js';
import { listPlugins, getPlugin, listRows } from '../plugins/store.js';
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

// ---- lookup attempt logging -------------------------------------------------
// One event per attempt, worded so the Events table alone answers "what did
// they type and why was it refused?" without expanding the detail row.

function typedInputs(inputs) {
  return Object.fromEntries(inputs.map((i) => [i.name, String(i.value ?? '').trim().slice(0, 80)]));
}

function typedSummary(typed) {
  const parts = Object.entries(typed).map(([k, v]) => `${k} ${v || '(blank)'}`);
  return parts.length ? parts.join(' / ') : '(no inputs)';
}

const shortDate = (v) => (v == null || v === '' ? '?' : String(v).replace('T', ' ').slice(0, 16));

export function describeOutcome(result, typed, pluginName) {
  const who = typedSummary(typed);
  const tail = ` (plugin ${pluginName})`;
  if (result.ok) {
    return { level: 'info', message: `Lookup OK: ${who} → ${result.guest?.label || 'guest'}${tail}` };
  }
  const n = result.candidates;
  let why;
  let level = 'info';
  switch (result.reason) {
    case 'no-match':
      if (result.detail === 'no-candidates' || n === 0) why = 'no booking found (search returned 0 records)';
      else if (typeof result.detail === 'string' && result.detail.startsWith('step:')) why = `no booking found (${result.detail} returned nothing)`;
      else why = `details did not match any of ${n != null ? n : 'the'} records`;
      break;
    case 'outside-window': {
      const w = result.window || {};
      const when = result.detail === 'missing-dates' ? 'stay dates missing on the record' : `${result.detail}; ${shortDate(w.start)} → ${shortDate(w.end)}`;
      why = `found, but outside the stay window (${when})`;
      break;
    }
    case 'timeout':
      level = 'warn';
      why = 'guest system timed out';
      break;
    default:
      level = 'warn';
      why = result.status ? `guest system error (HTTP ${result.status})` : `guest system error${result.detail ? ` (${result.detail})` : ''}`;
  }
  return { level, message: `Lookup refused: ${who} — ${why}${tail}` };
}

function lookupDetail(result, typed, plugin, mac) {
  const d = {
    plugin,
    inputs: typed,
    mac,
    outcome: result.ok ? 'ok' : result.reason,
    detail: result.ok ? undefined : result.detail,
    candidates: result.candidates,
    window: result.window,
    status: result.status,
    steps: Array.isArray(result.steps) ? result.steps.map((s) => `${s.name}:${s.status}:${s.records}`).join(' ') : undefined,
    clockSkewSecs: result.clockSkewSecs,
    label: result.ok ? result.guest?.label : undefined,
  };
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  return d;
}

// A guest system whose `Date` header disagrees with our clock by more than a
// few minutes means every date filter and stay window this container computes
// is wrong; the symptom is "no booking found (search returned 0 records)" for
// guests who are demonstrably checked in. Warn once an hour, not per attempt.
const CLOCK_SKEW_WARN_SECS = 300;
const CLOCK_WARN_INTERVAL_MS = 60 * 60 * 1000;
let lastClockWarnAt = 0;
export function warnOnClockSkew(db, skewSecs, source, nowMs = Date.now()) {
  if (skewSecs == null || Math.abs(skewSecs) < CLOCK_SKEW_WARN_SECS) return false;
  if (nowMs - lastClockWarnAt < CLOCK_WARN_INTERVAL_MS) return false;
  lastClockWarnAt = nowMs;
  const mins = Math.round(Math.abs(skewSecs) / 60);
  logEvent(db, 'warn', 'clock', `Container clock is ${mins} min ${skewSecs > 0 ? 'behind' : 'ahead of'} the guest system (${source})`, {
    clockSkewSecs: skewSecs,
    hint:
      'The container takes its time from the router. Check /system/clock and /system/ntp/client on the MikroTik — ' +
      'NTP status "waiting" means it has never synced (UDP 123 or DNS blocked). Until it is right, date-based lookup ' +
      'filters and stay windows are computed from the wrong time and checked-in guests are refused.',
  });
  return true;
}
export function _resetClockWarn() {
  lastClockWarnAt = 0;
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
      ctx.errorPluginId = id; // lets the plugin-login block show it inline, by its own inputs
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
      const blank = typedInputs(inputs);
      logEvent(db, 'info', 'plugin', `Lookup refused: ${typedSummary(blank)} — a required field was left blank (plugin ${recipe.name})`, {
        plugin: id,
        inputs: blank,
        mac: ctx.mac,
        outcome: 'missing-required',
      });
      return renderError('Please fill in all the required fields.');
    }

    // source:'list' recipes have no HTTP request to run — the engine matches
    // directly against the plugin's stored guest-list rows (uploaded via the
    // admin's Guest list card — see app/src/admin/plugins.js).
    const records = recipe.source === 'list' ? listRows(db, id).rows : undefined;

    // Every attempt is logged with WHAT was typed and WHY it was accepted or
    // refused (see describeOutcome). The typed values are guest identifiers
    // the operator is entitled to see (room, surname…), not credentials, and
    // the event log is admin-only. Diagnostics adds per-step record counts
    // and the clock-skew probe — never response bodies.
    const typed = typedInputs(inputs);
    let result;
    try {
      result = await runLookup({ recipe, inputs, tokenCache: lookupTokenCache, records, diagnostics: true });
    } catch (err) {
      logEvent(db, 'error', 'plugin', `Lookup failed: ${typedSummary(typed)} — guest system threw (plugin ${recipe.name})`, {
        plugin: id,
        inputs: typed,
        mac: ctx.mac,
        error: String(err?.message || err),
      });
      return renderError(recipe.messages?.upstream || 'The guest system is not responding — please try again or ask at reception.');
    }

    // Refusals are logged here; a success is logged once, below, after the
    // grant (so one attempt = one event, and the event carries the expiry).
    warnOnClockSkew(db, result.clockSkewSecs, recipe.name);
    if (!result.ok) {
      const outcome = describeOutcome(result, typed, recipe.name);
      logEvent(db, outcome.level, 'plugin', outcome.message, lookupDetail(result, typed, id, ctx.mac));
      const key = result.reason === 'no-match' ? 'noMatch' : result.reason === 'outside-window' ? 'outsideWindow' : 'upstream';
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
    logEvent(db, 'info', 'plugin', `${describeOutcome(result, typed, recipe.name).message.replace(/ \(plugin /, `, admitted until ${grant.expiresAt} (plugin `)}`, {
      ...lookupDetail(result, typed, id, ctx.mac),
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
