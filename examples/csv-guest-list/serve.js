#!/usr/bin/env node
// Zero-dependency static server for guests.csv — stands in for a Google
// Sheet "published to web" as CSV (or any other host that just serves a
// plain CSV file) so plugins/csv-url.json can be developed and tested
// without setting one up. Used by app/test/plugins-csv.test.js.
//
// Plain CommonJS + node:http only — no package.json / npm install required.
// Run with `npm run csv-guest-list` (from the repo root) or `node serve.js`.
//
// This is a MOCK for development and testing only — all guest data in
// guests.csv is fictional. Dates are written relative to server start (see
// resolveDates() below) so a run always tells a consistent "active stay"
// story no matter the real wall-clock date.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CSV_PATH = path.join(__dirname, 'guests.csv');
const START_MS = Date.now();

function toYmd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Replaces literal 'NOW±<N>d' tokens found anywhere in the CSV text with a
// concrete YYYY-MM-DD date, resolved once at server startup relative to the
// instant this process started.
function resolveDates(text) {
  return text.replace(/NOW([+-]\d+)d/g, (_m, offset) => toYmd(START_MS + Number(offset) * 24 * 3600 * 1000));
}

function loadCsv() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    return resolveDates(raw);
  } catch (e) {
    console.error(`could not read ${CSV_PATH}: ${e.message}`);
    return 'first_name,last_name,room,email,mobile,check_in,check_out\n';
  }
}

const csvText = loadCsv();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let status = 200;

  if (req.method !== 'GET') {
    status = 405;
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  } else if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bytes: csvText.length }));
  } else {
    // Google's own "publish to web" CSV links serve everything from a single
    // path regardless of the guest-facing URL, so this mock does the same:
    // any path returns the one CSV.
    const buf = Buffer.from(csvText, 'utf8');
    res.writeHead(status, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  }

  console.log(`${req.method} ${url.pathname} ${status}`);
});

function parsePort() {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1] !== undefined) return Number(process.argv[idx + 1]);
  if (process.env.PORT !== undefined && process.env.PORT !== '') return Number(process.env.PORT);
  return 8092;
}

const port = parsePort();
server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  console.log(`listening on http://127.0.0.1:${actualPort}`);
});
