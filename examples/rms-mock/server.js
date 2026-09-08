#!/usr/bin/env node
// Zero-dependency mock of the parts of the RMS Hospitality REST API
// (https://app.swaggerhub.com/apis-docs/RMSHospitality/RMS_REST_API/1.4.45.1)
// that the `plugins/rms-cloud-*.json` recipes talk to. Used to develop and
// test the RMS Cloud guest-lookup recipes without real RMS credentials, and
// by the automated integration test at app/test/plugins-rms.test.js.
//
// Plain CommonJS + node:http only — no package.json / npm install required.
// Run with `npm run rms-mock` (from the repo root) or `node server.js`.
//
// This is a MOCK for development and testing only. It is not affiliated
// with, and does not claim to fully implement, the real RMS Cloud API —
// only the endpoints and fields documented in docs/plugins/rms-cloud.md.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_PATH = path.join(__dirname, 'data.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// All reservation dates are resolved once, relative to the instant this
// process started, so a given server run always tells a consistent story
// ("arrived", "departed yesterday", "arriving in 10 days" etc.) no matter
// what the real wall-clock date happens to be.
const START_MS = Date.now();

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`could not read ${file}: ${e.message}`);
    return fallback;
  }
}

const config = loadJson(CONFIG_PATH, {
  agentId: 1000,
  agentPassword: 'agent-secret',
  clientId: 11281,
  clientPassword: 'webservice-secret',
  rmsClientId: 11281,
  allowedProperties: [{ clientId: 11281, clientName: 'Tikspot Demo Resort' }],
});

// "YYYY-MM-DD HH:MM:SS" in UTC, matching RMS's date format and the recipes'
// `dateFormat: "sql"` (interpreted as UTC — see docs/plugins/rms-cloud.md).
function toSqlDate(ms) {
  const iso = new Date(ms).toISOString(); // 2026-09-08T12:34:56.789Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

// A data.json date is either a literal "YYYY-MM-DD HH:MM:SS" string or a
// small relative token — "NOW-1d", "NOW+2h", etc — resolved once against
// START_MS when the file is loaded.
function resolveDate(token) {
  if (typeof token !== 'string') return null;
  const s = token.trim();
  const m = /^NOW\s*([+-]\d+(?:\.\d+)?)\s*(h|d)$/i.exec(s);
  if (m) {
    const amount = parseFloat(m[1]);
    const unitMs = m[2].toLowerCase() === 'h' ? 3600 * 1000 : 24 * 3600 * 1000;
    return toSqlDate(START_MS + amount * unitMs);
  }
  // Already a literal "YYYY-MM-DD HH:MM:SS" (or anything Date.parse likes).
  const t = Date.parse(s.includes(' ') ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isFinite(t) ? toSqlDate(t) : s;
}

function loadData() {
  const raw = loadJson(DATA_PATH, { areas: [], guests: [], reservations: [] });
  const areas = Array.isArray(raw.areas) ? raw.areas : [];
  const guests = Array.isArray(raw.guests) ? raw.guests : [];
  // guestGiven/guestSurname are denormalised onto each reservation at load
  // time (RMS's own reservation records carry the guest's name directly) so
  // filtering on `guestSurname` works against the reservation itself, not a
  // later guest lookup.
  const reservations = (Array.isArray(raw.reservations) ? raw.reservations : []).map((r) => {
    const guest = guests.find((g) => g.id === r.guestId);
    return {
      ...r,
      guestGiven: guest ? guest.guestGiven : '',
      guestSurname: guest ? guest.guestSurname : '',
      arrivalDate: resolveDate(r.arrivalDate),
      departureDate: resolveDate(r.departureDate),
    };
  });
  return { areas, guests, reservations };
}

let { areas, guests, reservations } = loadData();

// ---- tokens (in-memory) ----
const tokens = new Map(); // token -> expiresAtMs

// Every POST /authToken call (success or failure) bumps this. Exposed on
// /healthz so tests can assert "the token was cached and reused" without
// scraping stdout logs.
let authTokenCalls = 0;

function issueToken() {
  const token = 'rms_mock_' + crypto.randomBytes(16).toString('hex');
  tokens.set(token, Date.now() + 3600 * 1000);
  return token;
}

function isAuthorized(req) {
  const token = req.headers['authtoken'];
  if (!token) return false;
  const exp = tokens.get(token);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
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

function parseJsonBody(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

// ---- filtering helpers ----
function includesCI(list, value) {
  if (!Array.isArray(list) || !list.length) return true; // no filter = pass
  const v = String(value == null ? '' : value).toLowerCase();
  return list.some((x) => String(x).toLowerCase() === v);
}

function includesNum(list, value) {
  if (!Array.isArray(list) || !list.length) return true;
  return list.map(Number).includes(Number(value));
}

function containsCI(haystack, needle) {
  if (!needle) return true; // no filter = pass
  return String(haystack || '')
    .toLowerCase()
    .includes(String(needle).toLowerCase());
}

function matchesReservationFilters(r, f) {
  if (!includesCI(f.guestSurname, r.guestSurname)) return false;
  if (!includesCI(f.areaNames, r.areaName)) return false;
  if (f.areaNameLike && !containsCI(r.areaName, f.areaNameLike)) return false;
  if (!includesCI(f.listOfStatus, r.status)) return false;
  if (!includesNum(f.propertyIds, r.propertyId)) return false;
  if (!includesNum(f.guestIds, r.guestId)) return false;
  if (f.arriveFrom && r.arrivalDate < f.arriveFrom) return false;
  if (f.arriveTo && r.arrivalDate > f.arriveTo) return false;
  if (f.departFrom && r.departureDate < f.departFrom) return false;
  if (f.departTo && r.departureDate > f.departTo) return false;
  return true;
}

const BASIC_FIELDS = [
  'id',
  'areaId',
  'areaName',
  'categoryName',
  'arrivalDate',
  'departureDate',
  'guestGiven',
  'guestSurname',
  'guestId',
  'status',
  'propertyId',
];

function reservationView(r, modelType) {
  if (modelType === 'full') return r;
  const basic = {};
  for (const k of BASIC_FIELDS) basic[k] = r[k];
  return basic;
}

function guestPublicView(g) {
  const { contacts, ...rest } = g;
  return rest;
}

// ---- routing ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let status = 500;

  Promise.resolve()
    .then(async () => {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        status = 200;
        sendJson(res, status, { ok: true, reservations: reservations.length, guests: guests.length, authTokenCalls });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/authToken') {
        authTokenCalls += 1;
        const raw = await readBody(req);
        const body = parseJsonBody(raw);
        const ok =
          Number(body.agentId) === Number(config.agentId) &&
          body.agentPassword === config.agentPassword &&
          Number(body.clientId) === Number(config.clientId) &&
          body.clientPassword === config.clientPassword;
        if (!ok) {
          status = 401;
          sendJson(res, status, { error: 'invalid credentials' });
          return;
        }
        const token = issueToken();
        status = 201;
        sendJson(res, status, {
          token,
          expiryDate: toSqlDate(Date.now() + 3600 * 1000),
          rmsClientId: config.rmsClientId,
          allowedProperties: config.allowedProperties,
        });
        return;
      }

      // Every other route needs a valid `authtoken` header.
      if (!isAuthorized(req)) {
        status = 401;
        sendJson(res, status, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/reservations/search') {
        const raw = await readBody(req);
        const filters = parseJsonBody(raw);
        const modelType = url.searchParams.get('modelType') || 'basic';
        const limit = Number(url.searchParams.get('limit')) || 50;
        const results = reservations.filter((r) => matchesReservationFilters(r, filters)).slice(0, limit);
        status = 200;
        sendJson(
          res,
          status,
          results.map((r) => reservationView(r, modelType)),
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/guests/search') {
        const raw = await readBody(req);
        const f = parseJsonBody(raw);
        let results = guests.filter((g) => {
          if (!containsCI(g.guestSurname, f.surname)) return false;
          if (!containsCI(g.guestGiven, f.given)) return false;
          if (!containsCI(g.email, f.email)) return false;
          if (!containsCI(g.mobile, f.mobile)) return false;
          return true;
        });
        status = 200;
        sendJson(
          res,
          status,
          results.map((g) => {
            const view = guestPublicView(g);
            if (f.includeReservationIds) {
              view.reservationIds = reservations.filter((r) => r.guestId === g.id).map((r) => r.id);
            }
            return view;
          }),
        );
        return;
      }

      const guestMatch = /^\/guests\/(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && guestMatch) {
        const guest = guests.find((g) => g.id === Number(guestMatch[1]));
        if (!guest) {
          status = 404;
          sendJson(res, status, { error: 'not found' });
          return;
        }
        status = 200;
        sendJson(res, status, guestPublicView(guest));
        return;
      }

      const contactsMatch = /^\/guests\/(\d+)\/contacts$/.exec(url.pathname);
      if (req.method === 'GET' && contactsMatch) {
        const guest = guests.find((g) => g.id === Number(contactsMatch[1]));
        if (!guest) {
          status = 404;
          sendJson(res, status, { error: 'not found' });
          return;
        }
        status = 200;
        sendJson(res, status, Array.isArray(guest.contacts) ? guest.contacts : []);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/areas') {
        const propertyId = url.searchParams.get('propertyId');
        const results = propertyId == null || propertyId === '' ? areas : areas.filter((a) => Number(a.propertyId) === Number(propertyId));
        status = 200;
        sendJson(res, status, results);
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
  return 8091;
}

const port = parsePort();
server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  // Tests/tools spawning this as a child process parse this exact line to
  // discover the chosen port (needed when PORT=0 / --port 0 asks for an
  // ephemeral one).
  console.log(`listening on http://127.0.0.1:${actualPort}`);
});
