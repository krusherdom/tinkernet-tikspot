// Admin authentication: a single admin password (set during first-run setup),
// scrypt-hashed in settings, with a signed session cookie. The public captive
// portal and the static admin shell stay open; the /api/* management endpoints
// require auth (except /api/auth/* and, before setup completes, /api/setup/*).

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting, getBool } from '../db/settings.js';
import { VERSION } from '../config.js';
import { makeRateLimiter, clientIp } from './ratelimit.js';
import { logAudit } from './audit.js';
import { logEvent } from './events.js';

const COOKIE = 'tikspot_sess';

// Cap admin login attempts per IP to blunt online brute-forcing: 10 tries / 5 min.
const loginLimiter = makeRateLimiter({ max: 10, windowMs: 5 * 60_000 });

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// CSRF defence: the admin SPA is same-origin, so a state-changing request whose
// Origin/Referer host doesn't match the request host is hostile. Browsers always
// attach Origin to cross-origin POSTs; non-browser tooling that sends neither
// header is allowed through (it can't be driven by a victim's browser).
function sameOriginOk(req) {
  if (!UNSAFE_METHODS.has(req.method)) return true;
  const src = req.headers.origin || req.headers.referer;
  if (!src) return true;
  try {
    return new URL(src).host === req.headers.host;
  } catch {
    return false;
  }
}

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  const exp = Buffer.from(hashHex, 'hex');
  return h.length === exp.length && timingSafeEqual(h, exp);
}

// Ensure a cookie-signing secret exists (generated once, stored in settings).
export function ensureSessionSecret(db) {
  let s = getSetting(db, 'session_secret', null);
  if (!s) {
    s = randomBytes(32).toString('hex');
    setSetting(db, 'session_secret', s);
  }
  return s;
}

export function isAuthed(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return false;
  const r = req.unsignCookie(raw);
  return r.valid && r.value === 'admin';
}

function setupComplete(db) {
  return getBool(db, 'setup_complete', false);
}

// Setup endpoints that stay public no matter what, even after an admin password
// is set — the wizard needs to read its own state, and (re-)set the admin
// password, without already holding a session cookie.
const ALWAYS_PUBLIC_SETUP = new Set(['/api/setup/state', '/api/setup/admin']);

// Paths reachable without auth: the portal, the static admin shell, health,
// static assets, and the auth/setup endpoints.
function isPublic(db, req) {
  const url = req.url.split('?')[0];
  const PUBLIC_EXACT = new Set(['/', '/login', '/status', '/logout', '/healthz', '/api.json', '/favicon.ico']);
  if (PUBLIC_EXACT.has(url)) return true;
  if (url.startsWith('/m/') || url.startsWith('/assets/') || url.startsWith('/admin') || url.startsWith('/ds/')) return true;
  // Guest-lookup plugin lookups (POST /portal/lookup/:id) — public like the
  // rest of the captive portal; rate-limited separately in portal/routes.js.
  if (url.startsWith('/portal/')) return true;
  // Individual hotspot shim files — fetched by the router (no cookie) during push.
  if (url.startsWith('/hotspot-files/')) return true;
  if (url.startsWith('/api/auth/')) return true;
  // The help content is reference material for getting through setup — open it
  // up only until setup is finished, same as the setup endpoints below.
  if (url === '/api/help' && !setupComplete(db)) return true;
  // Setup endpoints are open only until setup is finished, and even then:
  // /state and /admin always stay open (the wizard needs them to bootstrap),
  // but once an admin password exists every OTHER /api/setup/* path needs the
  // session cookie — otherwise an attacker who reaches the container before
  // "Finish setup" is clicked could re-run Auto-configure or read router
  // credentials with no auth at all.
  if (url.startsWith('/api/setup/') && !setupComplete(db)) {
    if (ALWAYS_PUBLIC_SETUP.has(url)) return true;
    return !getSetting(db, 'admin_password_hash', null);
  }
  return false;
}

// Build the global onRequest gate (added on the root app so it covers all routes).
export function makeAuthGate(db) {
  return async function authGate(req, reply) {
    if (isPublic(db, req)) return;
    if (!isAuthed(req)) {
      return reply.code(401).send({ error: 'authentication required', authenticated: false });
    }
    if (!sameOriginOk(req)) {
      return reply.code(403).send({ error: 'cross-origin request blocked' });
    }
  };
}

export default async function authRoutes(app) {
  const db = app.db;

  app.get('/api/auth/status', async (req) => ({
    authenticated: isAuthed(req),
    setup_complete: setupComplete(db),
    version: VERSION,
  }));

  app.post('/api/auth/login', async (req, reply) => {
    const ip = clientIp(req);
    const rl = loginLimiter.check(ip);
    if (!rl.allowed) {
      reply.header('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      logEvent(db, 'warn', 'auth', 'Admin login rate-limited', ip);
      return reply.code(429).send({ error: 'too many attempts — try again later' });
    }
    const { password } = req.body ?? {};
    const stored = getSetting(db, 'admin_password_hash', null);
    if (!stored) return reply.code(400).send({ error: 'setup not complete' });
    if (!password || !verifyPassword(password, stored)) {
      logAudit(db, req, 'admin.login-failed', ip);
      return reply.code(401).send({ error: 'invalid password' });
    }
    loginLimiter.reset(ip); // legit login: clear the counter
    logAudit(db, req, 'admin.login');
    reply.setCookie(COOKIE, 'admin', {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
}
