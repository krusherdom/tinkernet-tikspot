#!/usr/bin/env node
// Zero-dependency mock of the parts of the Cloudbeds API
// (developers.cloudbeds.com) that plugins/cloudbeds.json talks to. Used to
// develop and test that recipe without a real Cloudbeds partner sandbox, and
// by the automated integration test at app/test/plugins-cloudbeds.test.js.
//
// Plain CommonJS + node:http only — no package.json / npm install required.
// Run with `npm run cloudbeds-mock` (from the repo root) or `node server.js`.
//
// This is a MOCK for development and testing only. It is not affiliated
// with, and does not claim to fully implement, the real Cloudbeds API — only
// the endpoint and fields documented in docs/plugins/cloudbeds.md, based on
// the developers.cloudbeds.com reference fetched 2026-09-09.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

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

const config = loadJson(CONFIG_PATH, { apiKey: 'mock-cloudbeds-api-key', propertyId: '12345' });

function toYmd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function resolveDate(token) {
  if (typeof token !== 'string') return token;
  const s = token.trim();
  const m = /^NOW\s*([+-]\d+(?:\.\d+)?)\s*d$/i.exec(s);
  if (m) return toYmd(START_MS + parseFloat(m[1]) * 24 * 3600 * 1000);
  return s;
}

function loadData() {
  const raw = loadJson(DATA_PATH, { reservations: [] });
  const reservations = (Array.isArray(raw.reservations) ? raw.reservations : []).map((r) => {
    const guestList = {};
    for (const [gid, g] of Object.entries(r.guestList || {})) {
      guestList[gid] = { ...g, startDate: resolveDate(g.startDate), endDate: resolveDate(g.endDate) };
    }
    return { ...r, startDate: resolveDate(r.startDate), endDate: resolveDate(r.endDate), guestList };
  });
  return { reservations };
}

const { reservations } = loadData();

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function isAuthorized(req) {
  const key = req.headers['x-api-key'];
  if (key && key === config.apiKey) return true;
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return !!(m && m[1] === config.apiKey);
}

function reservationMatchesRoom(r, roomName) {
  if (!roomName) return true;
  const wanted = String(roomName).toLowerCase();
  return Object.values(r.guestList).some((g) => String(g.roomName || '').toLowerCase() === wanted);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let status = 500;

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      status = 200;
      sendJson(res, status, { ok: true, reservations: reservations.length });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1.3/getReservations') {
      if (!isAuthorized(req)) {
        // Cloudbeds' own shape for an auth failure: { success:false, message }.
        status = 401;
        sendJson(res, status, { success: false, message: 'Invalid API key.' });
        return;
      }
      const statusFilter = url.searchParams.get('status');
      const roomName = url.searchParams.get('roomName');
      const pageSize = Number(url.searchParams.get('pageSize')) || 100;

      let results = reservations;
      if (statusFilter) results = results.filter((r) => r.status === statusFilter);
      if (roomName) results = results.filter((r) => reservationMatchesRoom(r, roomName));
      results = results.slice(0, pageSize);

      status = 200;
      sendJson(res, status, { success: true, data: results, count: results.length, total: reservations.length });
      return;
    }

    status = 404;
    sendJson(res, status, { success: false, message: 'Not found.' });
  } catch (e) {
    status = 500;
    try {
      sendJson(res, status, { success: false, message: e.message });
    } catch {
      /* response already sent/destroyed */
    }
  } finally {
    console.log(`${req.method} ${url.pathname} ${status}`);
  }
});

function parsePort() {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1] !== undefined) return Number(process.argv[idx + 1]);
  if (process.env.PORT !== undefined && process.env.PORT !== '') return Number(process.env.PORT);
  return 8095;
}

const port = parsePort();
server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  console.log(`listening on http://127.0.0.1:${actualPort}`);
});
