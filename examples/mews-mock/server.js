#!/usr/bin/env node
// Zero-dependency mock of the parts of the Mews Connector API
// (docs.mews.com/connector-api) that plugins/mews-connector.json talks to.
// Used to develop and test that recipe without real Mews credentials, and by
// the automated integration test at app/test/plugins-mews.test.js.
//
// Plain CommonJS + node:http only — no package.json / npm install required.
// Run with `npm run mews-mock` (from the repo root) or `node server.js`.
//
// This is a MOCK for development and testing only. It is not affiliated with,
// and does not claim to fully implement, the real Mews Connector API — only
// the endpoints and fields documented in docs/plugins/mews.md, based on a
// probe of docs.mews.com and the public Mews demo done 2026-09-09.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DATA_PATH = path.join(__dirname, 'data.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// Every reservation date is resolved once, relative to the instant this
// process started, so a run always tells a consistent story no matter the
// real wall-clock date.
const START_MS = Date.now();

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`could not read ${file}: ${e.message}`);
    return fallback;
  }
}

const config = loadJson(CONFIG_PATH, { clientToken: 'mock-client-token', accessToken: 'mock-access-token' });

function toIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// A data.json date is either a literal ISO string or a relative token
// ("NOW-1d", "NOW+12h") resolved once against START_MS at load time.
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
  const raw = loadJson(DATA_PATH, { resources: [], customers: [], reservations: [] });
  const resources = Array.isArray(raw.resources) ? raw.resources : [];
  const customers = Array.isArray(raw.customers) ? raw.customers : [];
  const reservations = (Array.isArray(raw.reservations) ? raw.reservations : []).map((r) => ({
    ...r,
    ScheduledStartUtc: resolveDate(r.ScheduledStartUtc),
    ScheduledEndUtc: resolveDate(r.ScheduledEndUtc),
    ActualStartUtc: resolveDate(r.ActualStartUtc),
    ActualEndUtc: resolveDate(r.ActualEndUtc),
  }));
  return { resources, customers, reservations };
}

const { resources, customers, reservations } = loadData();

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

// Every real Connector API call, success or failure, is a POST with
// ClientToken/AccessToken embedded in the JSON body — there is no separate
// login/token endpoint. A bad or missing token pair gets Mews's own
// 401-style envelope: a bare `{ Message }`.
function checkTokens(body, res) {
  if (body.ClientToken === config.clientToken && body.AccessToken === config.accessToken) return true;
  sendJson(res, 401, { Message: 'Invalid access token.' });
  return false;
}

function asIdArray(v) {
  if (v === undefined || v === null) return null; // no filter
  if (Array.isArray(v)) return v.map(String);
  return [String(v)]; // tolerate a stray scalar (e.g. an un-rendered template)
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return true; // no window given -> no filter
  return Date.parse(aStart) <= Date.parse(bEnd) && Date.parse(bStart) <= Date.parse(aEnd);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let status = 500;

  Promise.resolve()
    .then(async () => {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        status = 200;
        sendJson(res, status, { ok: true, resources: resources.length, reservations: reservations.length, customers: customers.length });
        return;
      }

      if (req.method !== 'POST') {
        status = 404;
        sendJson(res, status, { Message: 'Not found.' });
        return;
      }

      const raw = await readBody(req);
      const body = parseJsonBody(raw);

      if (url.pathname === '/api/connector/v1/resources/getAll') {
        if (!checkTokens(body, res)) {
          status = 401;
          return;
        }
        const names = Array.isArray(body.Names) ? body.Names.map((n) => String(n).toLowerCase()) : null;
        const ids = asIdArray(body.ResourceIds);
        const count = (body.Limitation && Number(body.Limitation.Count)) || 100;
        let results = resources;
        if (names) results = results.filter((r) => names.includes(String(r.Name).toLowerCase()));
        if (ids) results = results.filter((r) => ids.includes(r.Id));
        results = results.slice(0, count);
        status = 200;
        sendJson(res, status, {
          Resources: results,
          ResourceCategories: [],
          ResourceCategoryAssignments: [],
          ResourceCategoryImageAssignments: [],
          ResourceFeatures: [],
          ResourceFeatureAssignments: [],
          Cursor: '',
        });
        return;
      }

      if (url.pathname === '/api/connector/v1/reservations/getAll/2023-06-06') {
        if (!checkTokens(body, res)) {
          status = 401;
          return;
        }
        const resourceIds = asIdArray(body.AssignedResourceIds);
        const states = Array.isArray(body.States) ? body.States : null;
        const collidingUtc = body.CollidingUtc || {};
        const count = (body.Limitation && Number(body.Limitation.Count)) || 100;
        let results = reservations;
        if (resourceIds) results = results.filter((r) => resourceIds.includes(r.AssignedResourceId));
        if (states) results = results.filter((r) => states.includes(r.State));
        if (collidingUtc.StartUtc || collidingUtc.EndUtc) {
          results = results.filter((r) => overlaps(r.ScheduledStartUtc, r.ScheduledEndUtc, collidingUtc.StartUtc, collidingUtc.EndUtc));
        }
        results = results.slice(0, count);
        status = 200;
        sendJson(res, status, { Reservations: results, Cursor: '' });
        return;
      }

      if (url.pathname === '/api/connector/v1/customers/getAll') {
        if (!checkTokens(body, res)) {
          status = 401;
          return;
        }
        const ids = asIdArray(body.CustomerIds);
        const count = (body.Limitation && Number(body.Limitation.Count)) || 100;
        let results = customers;
        if (ids) results = results.filter((c) => ids.includes(c.Id));
        results = results.slice(0, count);
        status = 200;
        sendJson(res, status, { Customers: results, Documents: [], Cursor: '' });
        return;
      }

      status = 404;
      sendJson(res, status, { Message: 'Not found.' });
    })
    .catch((e) => {
      status = 500;
      try {
        sendJson(res, status, { Message: e.message });
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
  return 8093;
}

const port = parsePort();
server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  console.log(`listening on http://127.0.0.1:${actualPort}`);
});
