#!/usr/bin/env node
// Zero-dependency demo "hotel guest system" HTTP API, used to exercise the
// three sample recipes in examples/guest-api/recipes/ against a real server
// (both by hand, and by the plugins.test.js integration test).
//
// Plain CommonJS + node:http only — no package.json / npm install required.
// Run with `npm run guest-api` (from the repo root) or `node server.js`.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const GUESTS_PATH = path.join(__dirname, 'guests.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// FIXED_DATES=1 anchors all relative guest dates to this fixed instant
// instead of the real clock, for reproducible manual/automated testing.
const FIXED_ANCHOR_MS = Date.parse('2025-06-15T12:00:00Z');
const FIXED_DATES = process.env.FIXED_DATES === '1';
const START_MS = FIXED_DATES ? FIXED_ANCHOR_MS : Date.now();

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`could not read ${file}: ${e.message}`);
    return fallback;
  }
}

let config = loadJson(CONFIG_PATH, { username: 'frontdesk', password: 'letmein', apiKey: 'demo-key-123' });

// A guests.json checkIn/checkOut value is either a literal ISO 8601 string,
// or a small relative token: "NOW-2d", "NOW+3h", etc. Tokens are resolved
// once, relative to START_MS, when the file is (re)loaded.
function resolveDate(token) {
  if (typeof token !== 'string') return null;
  const s = token.trim();
  const m = /^NOW\s*([+-]\d+(?:\.\d+)?)\s*(h|d)$/i.exec(s);
  if (m) {
    const amount = parseFloat(m[1]);
    const unitMs = m[2].toLowerCase() === 'h' ? 3600 * 1000 : 24 * 3600 * 1000;
    return new Date(START_MS + amount * unitMs).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function loadGuests() {
  const raw = loadJson(GUESTS_PATH, { guests: [] });
  const list = Array.isArray(raw.guests) ? raw.guests : [];
  return list.map((g) => ({
    firstName: g.firstName || '',
    lastName: g.lastName || '',
    room: String(g.room != null ? g.room : ''),
    mobile: g.mobile || '',
    email: g.email || '',
    bookingRef: g.bookingRef || '',
    checkIn: resolveDate(g.checkIn),
    checkOut: resolveDate(g.checkOut),
  }));
}

let guests = loadGuests();

fs.watchFile(GUESTS_PATH, { interval: 1000 }, () => {
  guests = loadGuests();
  console.log(`reloaded guests.json (${guests.length} guests)`);
});
fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  config = loadJson(CONFIG_PATH, config);
  console.log('reloaded config.json');
});

// ---- bearer tokens (in-memory) ----
const tokens = new Map(); // token -> expiresAtMs

function issueToken() {
  const token = 'demo_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  tokens.set(token, Date.now() + 3600 * 1000);
  return token;
}

function isValidBearer(token) {
  if (!token) return false;
  const exp = tokens.get(token);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

function isAuthorized(req) {
  const authHeader = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (m && isValidBearer(m[1])) return true;
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === config.apiKey) return true;
  return false;
}

// ---- request body helpers ----
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType) {
  const ct = contentType || '';
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw || '').entries());
  }
  // Unknown content-type: best-effort JSON, then form.
  try {
    return JSON.parse(raw || '');
  } catch {
    /* fall through */
  }
  try {
    return Object.fromEntries(new URLSearchParams(raw || '').entries());
  } catch {
    return {};
  }
}

// ---- filtering ----
function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function matchesFilters(guest, filters) {
  if (filters.room && guest.room.toLowerCase() !== filters.room.toLowerCase()) return false;
  if (filters.lastName && !guest.lastName.toLowerCase().includes(filters.lastName.toLowerCase())) return false;
  if (filters.firstName && !guest.firstName.toLowerCase().includes(filters.firstName.toLowerCase())) return false;
  if (filters.email && !guest.email.toLowerCase().includes(filters.email.toLowerCase())) return false;
  if (filters.bookingRef && !guest.bookingRef.toLowerCase().includes(filters.bookingRef.toLowerCase())) return false;
  if (filters.mobile) {
    const q = digitsOnly(filters.mobile);
    const m = digitsOnly(guest.mobile);
    if (!q || !m.endsWith(q)) return false;
  }
  return true;
}

// ---- serialization ----
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toXml(list) {
  const items = list
    .map(
      (g) => `  <guest>
    <firstName>${xmlEscape(g.firstName)}</firstName>
    <lastName>${xmlEscape(g.lastName)}</lastName>
    <room>${xmlEscape(g.room)}</room>
    <mobile>${xmlEscape(g.mobile)}</mobile>
    <email>${xmlEscape(g.email)}</email>
    <bookingRef>${xmlEscape(g.bookingRef)}</bookingRef>
    <checkIn>${xmlEscape(g.checkIn)}</checkIn>
    <checkOut>${xmlEscape(g.checkOut)}</checkOut>
  </guest>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<guests>\n${items}\n</guests>\n`;
}

function toText(list) {
  return (
    list
      .map(
        (g) =>
          `Guest: ${g.firstName} ${g.lastName} | Room: ${g.room} | Mobile: ${g.mobile} | Email: ${g.email} | Ref: ${g.bookingRef} | CheckIn: ${g.checkIn} | CheckOut: ${g.checkOut}`,
      )
      .join('\n') + '\n'
  );
}

function pickFormat(req, url) {
  const q = url.searchParams.get('format');
  if (q === 'json' || q === 'xml' || q === 'text') return q;
  const accept = req.headers['accept'] || '';
  if (accept.includes('xml')) return 'xml';
  if (accept.includes('text/plain')) return 'text';
  return 'json';
}

function send(res, status, body, contentType) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': buf.length });
  res.end(buf);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json');
}

// ---- routing ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let status = 500;

  Promise.resolve()
    .then(async () => {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        status = 200;
        sendJson(res, status, { ok: true, guests: guests.length, fixedDates: FIXED_DATES });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/auth/token') {
        const raw = await readBody(req);
        const creds = parseBody(raw, req.headers['content-type']);
        if (creds.username === config.username && creds.password === config.password) {
          status = 200;
          sendJson(res, status, { token: issueToken(), expiresIn: 3600 });
        } else {
          status = 401;
          sendJson(res, status, { error: 'invalid credentials' });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/guests') {
        if (!isAuthorized(req)) {
          status = 401;
          sendJson(res, status, { error: 'unauthorized' });
          return;
        }
        const filters = {
          room: url.searchParams.get('room') || '',
          lastName: url.searchParams.get('lastName') || '',
          firstName: url.searchParams.get('firstName') || '',
          mobile: url.searchParams.get('mobile') || '',
          email: url.searchParams.get('email') || '',
          bookingRef: url.searchParams.get('bookingRef') || '',
        };
        const results = guests.filter((g) => matchesFilters(g, filters));
        const format = pickFormat(req, url);
        status = 200;
        if (format === 'xml') send(res, status, toXml(results), 'application/xml');
        else if (format === 'text') send(res, status, toText(results), 'text/plain');
        else sendJson(res, status, { guests: results });
        return;
      }

      const resvMatch = /^\/reservations\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && resvMatch) {
        if (!isAuthorized(req)) {
          status = 401;
          sendJson(res, status, { error: 'unauthorized' });
          return;
        }
        const room = decodeURIComponent(resvMatch[1]);
        const guest = guests.find((g) => g.room.toLowerCase() === room.toLowerCase());
        if (!guest) {
          status = 404;
          sendJson(res, status, { error: 'not found' });
          return;
        }
        status = 200;
        sendJson(res, status, guest);
        return;
      }

      status = 404;
      sendJson(res, status, { error: 'not found' });
    })
    .catch((e) => {
      status = 500;
      try {
        sendJson(res, status, { error: e.message });
      } catch {
        /* response already sent/destroyed */
      }
    })
    .finally(() => {
      console.log(`${req.method} ${url.pathname} ${status}`);
    });
});

function parsePort() {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1] !== undefined) return Number(process.argv[idx + 1]);
  if (process.env.PORT !== undefined && process.env.PORT !== '') return Number(process.env.PORT);
  return 8090;
}

const port = parsePort();
server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  // Tests/tools spawning this as a child process parse this exact line to
  // discover the chosen port (needed when PORT=0 asks for an ephemeral one).
  console.log(`listening on http://127.0.0.1:${actualPort}`);
});
