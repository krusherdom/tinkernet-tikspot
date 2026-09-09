#!/usr/bin/env node
// Zero-dependency mock of the parts of the Eventbrite API
// (www.eventbriteapi.com/v3) that plugins/eventbrite.json talks to. Used to
// develop and test that recipe without a real Eventbrite private token, and
// by the automated integration test at app/test/plugins-eventbrite.test.js.
//
// Plain CommonJS + node:http only — no package.json / npm install required.
// Run with `npm run eventbrite-mock` (from the repo root) or `node server.js`.
//
// This is a MOCK for development and testing only. It is not affiliated
// with, and does not claim to fully implement, the real Eventbrite API.
// `event`/`attendees` field shapes beyond pagination/profile are Tikspot's
// best-effort reconstruction of the documented v3 API (no live probe was
// done for Eventbrite — see docs/plugins/eventbrite.md, verified: mock).

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

const config = loadJson(CONFIG_PATH, { token: 'mock-eventbrite-private-token', eventId: '900001' });
const data = loadJson(DATA_PATH, { event: {}, needleAttendee: {}, attendeeCount: 120, pageSize: 50 });

function toIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function resolveDate(token) {
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

const event = {
  id: data.event.id,
  name: data.event.name,
  start: { ...data.event.start, utc: resolveDate(data.event.start.utc), local: resolveDate(data.event.start.local).replace('Z', '') },
  end: { ...data.event.end, utc: resolveDate(data.event.end.utc), local: resolveDate(data.event.end.local).replace('Z', '') },
};

const FIRST_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Drew', 'Quinn'];
const LAST_NAMES = ['Reed', 'Blake', 'Chen', 'Patel', 'Novak', 'Osei', 'Silva', 'Kim', 'Rossi', 'Nguyen'];

function genAttendees() {
  const count = data.attendeeCount || 120;
  const needle = data.needleAttendee || {};
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    let firstName;
    let lastName;
    let email;
    if (i === needle.index) {
      firstName = needle.firstName;
      lastName = needle.lastName;
      email = needle.email;
    } else {
      firstName = FIRST_NAMES[i % FIRST_NAMES.length];
      lastName = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
      email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`;
    }
    out.push({
      id: `att-${1000 + i}`,
      status: 'Attending',
      checked_in: false,
      cancelled: false,
      refunded: false,
      order_id: `ORD-${2000 + i}`,
      event_id: config.eventId,
      ticket_class_name: 'General Admission',
      profile: { first_name: firstName, last_name: lastName, email, name: `${firstName} ${lastName}` },
    });
  }
  return out;
}

const attendees = genAttendees();
const PAGE_SIZE = data.pageSize || 50;

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function isAuthorized(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!(m && m[1] === config.token);
}

// Eventbrite's own error envelope shape.
function sendAuthError(res) {
  sendJson(res, 401, {
    status_code: 401,
    error: 'NOT_AUTHORIZED',
    error_description: "You didn't provide a valid access token, or your access token has expired.",
  });
}

function sendNotFound(res) {
  sendJson(res, 404, { status_code: 404, error: 'NOT_FOUND', error_description: 'The event you are trying to retrieve could not be found.' });
}

let requestsToAttendees = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let status = 500;

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      status = 200;
      sendJson(res, status, { ok: true, attendees: attendees.length, requestsToAttendees });
      return;
    }

    const eventMatch = /^\/v3\/events\/([^/]+)\/$/.exec(url.pathname);
    if (req.method === 'GET' && eventMatch) {
      if (!isAuthorized(req)) {
        status = 401;
        sendAuthError(res);
        return;
      }
      if (eventMatch[1] !== event.id) {
        status = 404;
        sendNotFound(res);
        return;
      }
      status = 200;
      sendJson(res, status, event);
      return;
    }

    const attendeesMatch = /^\/v3\/events\/([^/]+)\/attendees\/$/.exec(url.pathname);
    if (req.method === 'GET' && attendeesMatch) {
      requestsToAttendees += 1;
      if (!isAuthorized(req)) {
        status = 401;
        sendAuthError(res);
        return;
      }
      if (attendeesMatch[1] !== event.id) {
        status = 404;
        sendNotFound(res);
        return;
      }
      const statusFilter = url.searchParams.get('status');
      let pool = attendees;
      if (statusFilter) pool = pool.filter((a) => a.status.toLowerCase() === statusFilter.toLowerCase());

      const continuation = url.searchParams.get('continuation');
      const pageNumber = continuation ? Number(continuation) : 1;
      const pageCount = Math.max(1, Math.ceil(pool.length / PAGE_SIZE));
      const start = (pageNumber - 1) * PAGE_SIZE;
      const pageItems = pool.slice(start, start + PAGE_SIZE);
      const hasMore = pageNumber < pageCount;

      status = 200;
      sendJson(res, status, {
        pagination: {
          object_count: pool.length,
          page_number: pageNumber,
          page_size: PAGE_SIZE,
          page_count: pageCount,
          has_more_items: hasMore,
          continuation: hasMore ? String(pageNumber + 1) : null,
        },
        attendees: pageItems,
      });
      return;
    }

    status = 404;
    sendNotFound(res);
  } catch (e) {
    status = 500;
    try {
      sendJson(res, status, { status_code: 500, error: 'INTERNAL', error_description: e.message });
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
  return 8096;
}

const port = parsePort();
server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  console.log(`listening on http://127.0.0.1:${actualPort}`);
});
