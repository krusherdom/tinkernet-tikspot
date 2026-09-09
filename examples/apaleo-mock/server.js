#!/usr/bin/env node
// Zero-dependency mock of the parts of the Apaleo API (api.apaleo.com,
// identity.apaleo.com) that plugins/apaleo.json talks to. Used to develop
// and test that recipe without a real Apaleo developer account, and by the
// automated integration test at app/test/plugins-apaleo.test.js.
//
// Plain CommonJS + node:http only — no package.json / npm install required.
// Run with `npm run apaleo-mock` (from the repo root) or `node server.js`.
// Serves BOTH the identity (token) and booking endpoints on one port so a
// single "base URL" / "identity URL" pair can point at this process.
//
// This is a MOCK for development and testing only. It is not affiliated
// with, and does not claim to fully implement, the real Apaleo API — only
// the endpoints and fields documented in docs/plugins/apaleo.md, based on
// api.apaleo.com/swagger/booking-v1/swagger.json and apaleo.dev guides
// fetched 2026-09-09.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_PATH = path.join(__dirname, 'data.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const START_MS = Date.now();

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`could not read ${file}: ${e.message}`);
    return fallback;
  }
}

const config = loadJson(CONFIG_PATH, { clientId: 'mock-client-id', clientSecret: 'mock-client-secret', propertyId: 'BER' });

function toIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function resolveDate(token) {
  if (token == null) return null;
  if (typeof token !== 'string') return token;
  const s = token.trim();
  const m = /^NOW\s*([+-]\d+(?:\.\d+)?)\s*(h|d)$/i.exec(s);
  if (m) {
    const amount = parseFloat(m[1]);
    const unitMs = m[2].toLowerCase() === 'h' ? 3600 * 1000 : 24 * 3600 * 1000;
    return toIso(START_MS + amount * unitMs);
  }
  return s;
}

function loadData() {
  const raw = loadJson(DATA_PATH, { reservations: [] });
  const reservations = (Array.isArray(raw.reservations) ? raw.reservations : []).map((r) => ({
    ...r,
    arrival: resolveDate(r.arrival),
    departure: resolveDate(r.departure),
  }));
  return { reservations };
}

const { reservations } = loadData();

// ---- bearer tokens (in-memory) ----
const tokens = new Map(); // token -> expiresAtMs
let tokenCalls = 0;

function issueToken() {
  const token = 'apaleo_mock_' + crypto.randomBytes(16).toString('hex');
  tokens.set(token, Date.now() + 3000 * 1000);
  return token;
}

function bearerFromHeader(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function isAuthorizedBearer(req) {
  const token = bearerFromHeader(req);
  if (!token) return false;
  const exp = tokens.get(token);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

function basicFromHeader(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
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

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

// Apaleo's problem+json style error envelope for the booking API.
function sendProblem(res, status, title) {
  sendJson(res, status, {
    type: `https://api.apaleo.com/errors/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    traceId: 'mock-trace-' + Math.random().toString(16).slice(2),
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let status = 500;

  Promise.resolve()
    .then(async () => {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        status = 200;
        sendJson(res, status, { ok: true, reservations: reservations.length, tokenCalls });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/connect/token') {
        tokenCalls += 1;
        const raw = await readBody(req);
        const params = new URLSearchParams(raw);
        const basic = basicFromHeader(req);
        const grantType = params.get('grant_type');
        const ok = basic && basic.user === config.clientId && basic.pass === config.clientSecret && grantType === 'client_credentials';
        if (!ok) {
          // OAuth2's own error shape (RFC 6749 §5.2).
          status = 401;
          sendJson(res, status, { error: 'invalid_client', error_description: 'Client authentication failed.' });
          return;
        }
        const token = issueToken();
        status = 200;
        sendJson(res, status, { access_token: token, expires_in: 3000, token_type: 'Bearer', scope: 'reservations.read' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/booking/v1/reservations') {
        if (!isAuthorizedBearer(req)) {
          status = 401;
          sendProblem(res, status, 'Unauthorized');
          return;
        }
        const propertyIds = url.searchParams.getAll('propertyIds');
        const statuses = url.searchParams.getAll('status');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const pageSize = Number(url.searchParams.get('pageSize')) || 100;

        let results = reservations;
        if (propertyIds.length) results = results.filter((r) => propertyIds.includes(r.property.id));
        if (statuses.length) results = results.filter((r) => statuses.includes(r.status));
        if (from || to) {
          // A day-granularity `from`/`to` (Apaleo's dateFilter is date-only)
          // padded by an extra day on each side so this mock's behaviour
          // doesn't flip depending on what time of day the test happens to
          // run at — real Apaleo's exact `dateFilter=Stay` boundary semantics
          // aren't documented precisely enough to reproduce to the hour, and
          // being generous here only ever risks including one extra day's
          // reservations, never a false exclusion.
          const PAD_MS = 24 * 3600 * 1000;
          results = results.filter((r) => {
            const arr = Date.parse(r.arrival);
            const dep = Date.parse(r.departure);
            const fromMs = from ? Date.parse(from) - PAD_MS : -Infinity;
            const toMs = to ? Date.parse(to + 'T23:59:59Z') + PAD_MS : Infinity;
            return arr <= toMs && dep >= fromMs;
          });
        }
        results = results.slice(0, pageSize);
        status = 200;
        sendJson(res, status, { reservations: results, count: results.length });
        return;
      }

      status = 404;
      sendProblem(res, status, 'Not Found');
    })
    .catch((e) => {
      status = 500;
      try {
        sendProblem(res, status, e.message || 'Internal Server Error');
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
  return 8094;
}

const port = parsePort();
server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  console.log(`listening on http://127.0.0.1:${actualPort}`);
});
