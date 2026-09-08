// System / health view. Reports the container's own status plus — when a router
// is configured — the MikroTik's resources, clock/NTP, and THIS container's
// placement on the router (mount, root-dir, veth, IP). The router snapshot is
// also reused by the backup bundle.

import fs from 'node:fs';
import { routerFromSettings } from './setup.js';
import { getSetting, setSetting, getTyped } from '../db/settings.js';
import { matchPlacement } from '../mikrotik/placement.js';
import { runOnce } from '../radius/clientsconf.js';
import { logEvent } from './events.js';
import { VERSION, DATA_DIR } from '../config.js';

// FreeRADIUS's default UDP auth port (1812) in the hex form /proc/net/udp[6] uses.
const RADIUSD_PORT_HEX = '0714';

function diskFree(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

export function containerInfo() {
  return {
    version: VERSION,
    node: process.version,
    uptimeSecs: Math.round(process.uptime()),
    data: diskFree(DATA_DIR),
  };
}

function ntpSynced(ntp) {
  if (!ntp) return null;
  const s = String(ntp.status || ntp['status'] || '').toLowerCase();
  if (s) return s.includes('synchronized') || s.includes('synced');
  return ntp.enabled === 'true' || ntp.enabled === true ? null : false;
}

// Does /proc/net/udp (or udp6) show a listener bound to port 1812? Alpine's
// FreeRADIUS may bind IPv4, IPv6, or both depending on config — check both files.
// Returns true/false when at least one of the files was readable (a definitive
// answer), or null when NEITHER file exists (e.g. Windows/dev, outside Linux).
function radiusdListening() {
  let anyReadable = false;
  for (const file of ['/proc/net/udp', '/proc/net/udp6']) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // this file doesn't exist here — try the next one
    }
    anyReadable = true;
    const lines = text.split('\n').slice(1); // header row
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1]; // "local_address" col: "ADDR:PORT" in hex
      if (!local) continue;
      const port = local.split(':')[1];
      if (port && port.toUpperCase() === RADIUSD_PORT_HEX) return true;
    }
  }
  return anyReadable ? false : null;
}

// Determine whether radiusd is up: first by checking for a listening socket on
// the RADIUS auth port (works whenever /proc is available, i.e. inside the
// container on Linux); when /proc isn't available at all (Windows/dev), ask s6
// directly; if neither can answer, say so rather than guessing.
async function radiusdStatus() {
  const listening = radiusdListening();
  if (listening === true) return { ok: true, method: 'proc-net-udp', detail: 'listening on UDP/1812' };
  if (listening === false) return { ok: false, method: 'proc-net-udp', detail: 'no listener on UDP/1812' };
  for (const bin of ['/command/s6-svstat', 's6-svstat']) {
    const code = await runOnce(bin, ['/run/service/radiusd'], 3000);
    if (code === 0) return { ok: true, method: 's6-svstat', detail: 'service reports up' };
    if (code != null) return { ok: false, method: 's6-svstat', detail: `service reports down (exit ${code})` };
  }
  return { ok: null, method: 'unavailable', detail: 'cannot determine outside the container' };
}

// SQLite health: PRAGMA quick_check plus a handful of row counts the operator
// cares about. Never throws — a DB problem is exactly what this is meant to catch.
function dbStatus(db) {
  let ok = null;
  let detail = '';
  try {
    const row = db.prepare('PRAGMA quick_check').get();
    const result = row && (row.quick_check ?? Object.values(row)[0]);
    ok = result === 'ok';
    detail = ok ? '' : String(result ?? 'quick_check failed');
  } catch (err) {
    ok = false;
    detail = String(err.message ?? err);
  }
  const counts = {};
  for (const [key, table] of [['plans', 'plans'], ['radcheck', 'radcheck'], ['radacct', 'radacct'], ['designs', 'designs']]) {
    try {
      counts[key] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      counts[key] = null;
    }
  }
  return { ok, detail, quick_check: counts };
}

// Optional outbound-reachability probe, only run when the operator has set an
// egress_check_url (System settings) — this is the only network call in
// buildHealth that leaves the LAN, so it stays opt-in both by setting AND by
// the `egress` flag (buildHealth callers that just want a snapshot, like the
// backup bundle, skip it by default).
async function egressStatus(db) {
  const url = getTyped(db, 'egress_check_url');
  if (!url) return { configured: false };
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000), redirect: 'manual' });
    return { configured: true, ok: res.status < 500, status: res.status };
  } catch (err) {
    return { configured: true, ok: false, error: String(err.message ?? err) };
  }
}

let ntpWarnedOnce = false;

// Build the full health snapshot (also used by backup). Returns { container,
// router, clock, ntpOk, placement, services, egress }.
// `opts.egress` (default false) controls whether the outbound egress-check
// fetch runs — callers that just want a fast, LAN-only snapshot (e.g. the
// backup bundle) should leave it off; the System page route turns it on.
export async function buildHealth(db, opts = {}) {
  const out = { container: containerInfo(), routerConfigured: false };

  // Container-local checks: independent of whether a router is configured, and
  // must not vanish just because routerFromSettings() returns null.
  const [services, egress] = await Promise.all([
    (async () => ({ radiusd: await radiusdStatus(), db: dbStatus(db) }))(),
    opts.egress ? egressStatus(db) : Promise.resolve({ configured: false }),
  ]);
  out.services = services;
  out.egress = egress;

  const router = routerFromSettings(db);
  if (!router) return out;
  out.routerConfigured = true;
  try {
    const [resource, clock, ntp, containers, veths, addrs] = await Promise.all([
      router.call('GET', '/system/resource').catch(() => null),
      router.call('GET', '/system/clock').catch(() => null),
      router.call('GET', '/system/ntp/client').catch(() => null),
      router.list('/container').catch(() => []),
      router.list('/interface/veth').catch(() => []),
      router.list('/ip/address').catch(() => []),
    ]);
    if (resource) {
      out.router = {
        board: resource['board-name'],
        version: resource.version,
        arch: resource['architecture-name'],
        cpuLoad: resource['cpu-load'],
        freeMemory: Number(resource['free-memory']) || null,
        totalMemory: Number(resource['total-memory']) || null,
        uptime: resource.uptime,
      };
    }
    if (clock) {
      out.clock = { time: clock.time, date: clock.date, timezone: clock['time-zone-name'] };
      // Cache the router's GMT offset (seconds) so the midnight-expiry sweeper can
      // compute router-local midnight without querying the router each tick.
      if (clock['gmt-offset'] != null) setSetting(db, 'router_gmt_offset_secs', String(clock['gmt-offset']));
    }
    if (ntp) out.ntp = { enabled: ntp.enabled, status: ntp.status, servers: ntp.servers || ntp['server-dns-names'] || '' };
    out.ntpOk = ntpSynced(ntp);
    if (out.ntpOk === false && !ntpWarnedOnce) {
      ntpWarnedOnce = true;
      logEvent(db, 'warn', 'ntp', 'Router clock is not NTP-synchronised');
    }
    out.placement = matchPlacement(
      getSetting(db, 'container_ip', ''),
      Array.isArray(containers) ? containers : [],
      Array.isArray(veths) ? veths : [],
      Array.isArray(addrs) ? addrs : [],
    );
  } catch (err) {
    out.error = String(err.message ?? err);
  }
  return out;
}

export default async function systemRoutes(app) {
  const db = app.db;
  app.get('/api/system/health', async () => buildHealth(db, { egress: true }));
}
