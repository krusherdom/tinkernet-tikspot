// RouterOS v7 REST client. Talks to https://<router>/rest (or http) with HTTP
// Basic auth. Routers ship a self-signed cert, so TLS verification is disabled
// for https — this is a LAN management tool pointed at a user-configured router.
//
// Used by the setup wizard to auto-configure the router (RADIUS client, CoA
// incoming, hotspot profile, DNS static, walled-garden) and, optionally, as an
// alternative path for listing/kicking active users.
//
// The orchestration helpers below (ensure*, autoConfigure, verifyConfig) only ever
// touch `router.list / add / patch / call`, so a plain object stub satisfies them
// in unit tests — no network, no class.

import http from 'node:http';
import https from 'node:https';
import { matchPlacement, cidrCovers } from './placement.js';

// Comment stamped on every router object the setup wizard creates (DNS static,
// walled-garden rules). Re-running setup finds its own objects by this marker and
// updates them in place — even if the container IP or server-name changed — rather
// than leaving stale duplicates behind (important after a -Fresh reinstall, where
// the router config persists but the container's /data is wiped).
export const MANAGED_COMMENT = 'Tikspot portal (managed by setup wizard)';

// Managed-object rule (one rule, used everywhere): an object is ours when its
// comment CONTAINS the exact MANAGED_COMMENT string. That is deliberately narrower
// than the old /tikspot/i match (which claimed anything an operator happened to
// mention "tikspot" in) but still allows an operator prefix — configureHotspotProfile
// preserves an existing comment by appending " | <MANAGED_COMMENT>".
export const isManaged = (r) => String(r?.comment ?? '').includes(MANAGED_COMMENT);

// Merge an operator's existing comment with our marker (idempotent).
export function mergeComment(existing) {
  const cur = String(existing ?? '').trim();
  if (!cur) return MANAGED_COMMENT;
  if (cur.includes(MANAGED_COMMENT)) return cur;
  return `${cur} | ${MANAGED_COMMENT}`;
}

// A literal-IP server-name (e.g. "172.18.0.3") needs no DNS record or host walled-garden.
export const isIpHost = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(h || '').trim());

// RouterOS CoA / Change-of-Authorization listener settings. Without this the
// router ignores our Disconnect-Request packets and "Kick" silently does nothing.
export const COA_PORT = '3799';

// The router menus Tikspot creates/owns, and the safe fields to surface per menu
// when listing them back (secrets are deliberately never included).
const MANAGED_MENUS = [
  { key: 'radius', menu: '/radius', fields: ['address', 'service'] },
  { key: 'dns-static', menu: '/ip/dns/static', fields: ['name', 'address'] },
  { key: 'hotspot-profile', menu: '/ip/hotspot/profile', fields: ['name', 'use-radius', 'login-by'] },
  { key: 'walled-garden-ip', menu: '/ip/hotspot/walled-garden/ip', fields: ['action', 'dst-address'] },
  { key: 'walled-garden-host', menu: '/ip/hotspot/walled-garden', fields: ['action', 'dst-host'] },
];

function summarize(entry, fields) {
  const out = { id: entry['.id'], comment: entry.comment || '' };
  for (const f of fields) out[f] = entry[f];
  return out;
}

const errText = (err) => String(err?.message ?? err);

// A "not enough permissions" rejection means we could not READ, which is different
// from "the config is wrong" — Verify reports those as `unknown`, not `fail`.
export const isPermissionError = (err) =>
  err?.status === 403 || /permission|not enough|forbidden/i.test(errText(err));

// ---------------------------------------------------------------------------
// Tri-state reads: every menu read is { ok:true, rows } or { ok:false, error }.
// A read failure must never look like config drift.
export async function readMenu(router, menu) {
  try {
    const r = await router.list(menu);
    const rows = Array.isArray(r) ? r : r == null ? [] : [r];
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: errText(err), rows: [] };
  }
}

// Some RouterOS menus (/radius/incoming, /ip/dns) are a single settings OBJECT,
// not a list — never .find() over them.
export async function readObject(router, menu) {
  try {
    const r = await router.list(menu);
    const obj = Array.isArray(r) ? r[0] ?? {} : r ?? {};
    return { ok: true, obj };
  } catch (err) {
    return { ok: false, error: errText(err), obj: null };
  }
}

export class RouterOS {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  // Uses node:http/https directly so we can accept the router's self-signed cert
  // (rejectUnauthorized:false) without depending on undici Agent support.
  call(method, path, body) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(`${this.baseUrl}/rest${path}`);
      } catch (e) {
        reject(new Error('invalid router URL: ' + this.baseUrl));
        return;
      }
      const mod = url.protocol === 'https:' ? https : http;
      const data = body !== undefined ? JSON.stringify(body) : null;
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          Authorization: this.auth,
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        rejectUnauthorized: false,
        timeout: 8000,
      };
      const req = mod.request(opts, (res) => {
        let t = '';
        res.on('data', (d) => (t += d));
        res.on('end', () => {
          let parsed;
          try { parsed = t ? JSON.parse(t) : null; } catch { parsed = t; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            // RouterOS error bodies look like {error, message, detail} — `detail`
            // carries the real reason (e.g. "not enough permissions"). Surface it.
            const message = parsed && parsed.message;
            const detail = parsed && parsed.detail;
            const human =
              [message, detail].filter(Boolean).join(' — ') ||
              (typeof parsed === 'string' && parsed) ||
              `HTTP ${res.statusCode}`;
            const err = new Error(`RouterOS ${method} ${path}: ${human}`);
            err.status = res.statusCode;
            err.data = parsed;
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('router connection timed out')));
      if (data) req.write(data);
      req.end();
    });
  }

  // ---- primitives ----
  probe() { return this.call('GET', '/system/resource'); }
  list(menu) { return this.call('GET', menu); }
  add(menu, obj) { return this.call('PUT', menu, obj); }
  patch(menu, id, obj) { return this.call('PATCH', `${menu}/${encodeURIComponent(id)}`, obj); }
  remove(menu, id) { return this.call('DELETE', `${menu}/${encodeURIComponent(id)}`); }

  // ---- hotspot helpers (thin delegates to the stub-friendly functions below) ----
  ensureRadiusClient(opts) { return ensureRadiusClient(this, opts); }
  ensureRadiusIncoming(opts) { return ensureRadiusIncoming(this, opts); }
  configureHotspotProfile(opts) { return configureHotspotProfile(this, opts); }
  ensureDnsStatic(opts) { return ensureDnsStatic(this, opts); }
  ensureWalledGarden(opts) { return ensureWalledGarden(this, opts); }
  listManaged() { return listManaged(this); }

  listActive() { return this.list('/ip/hotspot/active'); }
  removeActive(id) { return this.remove('/ip/hotspot/active', id); }
}

// ---------------------------------------------------------------------------
// Ensure* helpers. Each takes the router as its first argument and uses only the
// four primitives, so tests can pass `{ list, add, patch, call }`.

export async function ensureRadiusClient(router, { address, secret }) {
  const all = await router.list('/radius');
  // Reuse our managed entry (by comment) or any hotspot entry for this ADDRESS,
  // so re-running setup updates it in place (incl. the secret) and tags it.
  const rows = Array.isArray(all) ? all : [];
  const existing =
    rows.find((r) => r.address === address && isManaged(r)) ||
    rows.find((r) => r.address === address && String(r.service || '').includes('hotspot')) ||
    rows.find(isManaged);
  const body = { address, secret, service: 'hotspot' };
  if (existing) {
    await router.patch('/radius', existing['.id'], { ...body, comment: mergeComment(existing.comment) });
    return { updated: existing['.id'], detail: `updated /radius entry for ${address}` };
  }
  const created = await router.add('/radius', { ...body, comment: MANAGED_COMMENT });
  return { created: created && created['.id'], detail: `created /radius entry for ${address}` };
}

// CoA / Disconnect-Request listener. `/radius/incoming` is a single settings
// object (no .id), so it is PATCHed at the menu path itself. Some RouterOS builds
// only accept the console-style `set` endpoint — fall back to that on 4xx.
export async function ensureRadiusIncoming(router, { port = COA_PORT } = {}) {
  const body = { accept: 'yes', port: String(port) };
  try {
    await router.call('PATCH', '/radius/incoming', body);
  } catch (err) {
    if (err?.status && err.status >= 400 && err.status < 500 && !isPermissionError(err)) {
      await router.call('POST', '/radius/incoming/set', body);
    } else {
      throw err;
    }
  }
  return { updated: 'radius-incoming', detail: `accept=yes port=${port} (CoA / kick)` };
}

// Point hotspot profiles at RADIUS. `profiles` (optional) narrows the blast radius
// to the named profiles — without it every profile on the router is configured,
// which is right for a dedicated hotspot box but wrong on a shared router.
// An operator's existing comment is preserved (our marker is appended).
export async function configureHotspotProfile(
  router,
  { loginBy = 'mac-cookie,http-chap,http-pap,mac', profiles = null } = {},
) {
  const all = await router.list('/ip/hotspot/profile');
  const rows = Array.isArray(all) ? all : [];
  const wanted = Array.isArray(profiles) && profiles.length
    ? rows.filter((p) => profiles.includes(p.name))
    : rows;
  if (Array.isArray(profiles) && profiles.length && !wanted.length) {
    throw new Error(`no hotspot profile matched ${profiles.join(', ')}`);
  }
  // NOTE: /ip/hotspot/profile has NO comment field (RouterOS rejects it with
  // "unknown parameter comment" — confirmed on 7.23), so profiles can't carry the
  // managed marker; they're identified by name / use-radius instead.
  const results = [];
  for (const p of wanted) {
    await router.patch('/ip/hotspot/profile', p['.id'], {
      'use-radius': 'yes',
      'login-by': loginBy,
    });
    results.push(p.name);
  }
  return { profiles: results, detail: results.length ? `use-radius on: ${results.join(', ')}` : 'no hotspot profiles found' };
}

// Hotspot clients use the router as their resolver; without this the static
// server-name entry is never served to them. Single settings object (PATCH).
export async function ensureDnsRemoteRequests(router) {
  const cur = await router.list('/ip/dns');
  const obj = Array.isArray(cur) ? cur[0] ?? {} : cur ?? {};
  const v = obj['allow-remote-requests'];
  if (v === 'yes' || v === 'true' || v === true) return { detail: 'already enabled' };
  await router.call('PATCH', '/ip/dns', { 'allow-remote-requests': 'yes' });
  return { updated: true, detail: 'allow-remote-requests=yes' };
}

export async function ensureDnsStatic(router, { name, address }) {
  const all = await router.list('/ip/dns/static');
  const rows = Array.isArray(all) ? all : [];
  // Match by NAME first (that is the object's identity), then fall back to our marker.
  const existing = rows.find((r) => r.name === name) || rows.find(isManaged);
  if (existing) {
    await router.patch('/ip/dns/static', existing['.id'], { name, address, comment: mergeComment(existing.comment) });
    return { updated: name, detail: `${name} → ${address}` };
  }
  await router.add('/ip/dns/static', { name, address, comment: MANAGED_COMMENT });
  return { created: name, detail: `${name} → ${address}` };
}

export async function ensureWalledGarden(router, { address, host }) {
  const added = [];
  if (address) {
    const ips = await readMenu(router, '/ip/hotspot/walled-garden/ip');
    if (!ips.ok) throw new Error(ips.error);
    // Match by dst-address (the rule's identity), then our marker.
    const existing =
      ips.rows.find((e) => e['dst-address'] === address) || ips.rows.find(isManaged);
    const body = { action: 'accept', 'dst-address': address };
    if (existing) {
      await router.patch('/ip/hotspot/walled-garden/ip', existing['.id'], { ...body, comment: mergeComment(existing.comment) });
      added.push(`ip:${address} (updated)`);
    } else {
      await router.add('/ip/hotspot/walled-garden/ip', { ...body, comment: MANAGED_COMMENT });
      added.push(`ip:${address}`);
    }
  }
  if (host) {
    const wg = await readMenu(router, '/ip/hotspot/walled-garden');
    if (!wg.ok) throw new Error(wg.error);
    const existing = wg.rows.find((e) => e['dst-host'] === host) || wg.rows.find(isManaged);
    const body = { action: 'allow', 'dst-host': host };
    if (existing) {
      await router.patch('/ip/hotspot/walled-garden', existing['.id'], { ...body, comment: mergeComment(existing.comment) });
      added.push(`host:${host} (updated)`);
    } else {
      await router.add('/ip/hotspot/walled-garden', { ...body, comment: MANAGED_COMMENT });
      added.push(`host:${host}`);
    }
  }
  return { added, detail: added.join(', ') };
}

// ---------------------------------------------------------------------------
// Hotspot provisioning (zero-touch bootstrap). These create the hotspot itself
// rather than assuming the operator already ran the RouterOS hotspot wizard.

const DEFAULT_LOGIN_BY = 'mac-cookie,http-chap,http-pap,mac';

// A configuration problem we detected ourselves (not a transport failure), so
// autoConfigure must not mistake it for "router unreachable".
function configError(message) {
  const err = new Error(message);
  err.local = true;
  return err;
}

// The first enabled IPv4 on `iface`, as { ip, cidr } ("192.168.88.1",
// "192.168.88.1/24"). The hotspot profile's hotspot-address and the DHCP
// network match both key off it.
export async function interfaceAddress(router, iface) {
  const r = await readMenu(router, '/ip/address');
  if (!r.ok) throw new Error(r.error);
  const row = r.rows.find((a) => a.interface === iface && !yes(a.disabled) && a.address);
  if (!row) throw configError(`no IPv4 address on interface ${iface} — give it one before provisioning the hotspot`);
  const cidr = String(row.address);
  return { ip: cidr.split('/')[0], cidr };
}

// Create/update the named hotspot profile, pointed at RADIUS. dns-name must NOT
// equal the portal's server-name host: RouterOS adds a dynamic DNS entry
// dns-name -> router, which would shadow Tikspot's DNS static for the portal.
// NOTE: /ip/hotspot/profile has no comment field (see configureHotspotProfile),
// so it is identified by name only.
export async function ensureHotspotProfile(
  router,
  { name = 'tikspot', interface: iface, hotspotAddress, dnsName, serverHost, loginBy = DEFAULT_LOGIN_BY } = {},
) {
  if (dnsName && serverHost && dnsName.trim().toLowerCase() === String(serverHost).trim().toLowerCase()) {
    throw configError(
      `hotspot dns-name "${dnsName}" must differ from the server-name host — RouterOS maps dns-name to the router, which would hide the portal`,
    );
  }
  const address = hotspotAddress || (iface ? (await interfaceAddress(router, iface)).ip : null);
  const body = { 'use-radius': 'yes', 'radius-accounting': 'yes', 'login-by': loginBy };
  if (address) body['hotspot-address'] = address;
  if (dnsName) body['dns-name'] = dnsName;
  const r = await readMenu(router, '/ip/hotspot/profile');
  if (!r.ok) throw new Error(r.error);
  const existing = r.rows.find((p) => p.name === name);
  if (existing) {
    await router.patch('/ip/hotspot/profile', existing['.id'], body);
    return { updated: name, detail: `profile ${name} (hotspot-address=${address || '-'})` };
  }
  await router.add('/ip/hotspot/profile', { name, ...body });
  return { created: name, detail: `profile ${name} (hotspot-address=${address || '-'})` };
}

// The hotspot server entry. Its NAME must be the portal host: the hotspot HTML
// variable $(server-name) is this entry's name, and Tikspot's shim redirects to
// http://$(server-name)/login. One server per interface — an existing one is
// renamed/re-profiled rather than a second one added.
export async function ensureHotspotServer(router, { name, interface: iface, profile }) {
  if (!name) throw configError('no server-name configured — the hotspot server must be named after the portal host');
  if (!iface) throw configError('no hotspot interface given');
  const r = await readMenu(router, '/ip/hotspot');
  if (!r.ok) throw new Error(r.error);
  const existing = r.rows.find((s) => s.interface === iface) || r.rows.find((s) => s.name === name);
  const body = { name, interface: iface, profile, disabled: 'no' };
  if (existing) {
    await router.patch('/ip/hotspot', existing['.id'], { ...body, comment: mergeComment(existing.comment) });
    return { updated: name, detail: `hotspot server ${name} on ${iface} (profile ${profile})` };
  }
  await router.add('/ip/hotspot', { ...body, comment: MANAGED_COMMENT });
  return { created: name, detail: `hotspot server ${name} on ${iface} (profile ${profile})` };
}

// Hotspot clients must use the router as their resolver, or Tikspot's DNS
// static for the server-name is never consulted. Only fills an EMPTY
// dns-server on the DHCP network that serves the interface — never creates
// DHCP servers/pools (that is network design, not ours to guess).
export async function ensureDhcpDns(router, { interface: iface }) {
  const { ip } = await interfaceAddress(router, iface);
  const r = await readMenu(router, '/ip/dhcp-server/network');
  if (!r.ok) throw new Error(r.error);
  const net = r.rows.find((n) => n.address && cidrCovers(n.address, ip));
  if (!net) {
    return {
      status: 'skipped',
      detail: `no /ip/dhcp-server/network covers ${ip} — if clients get DHCP elsewhere, make sure they use ${ip} as DNS`,
    };
  }
  if (String(net['dns-server'] || '').trim()) {
    return { detail: `${net.address} already has dns-server=${net['dns-server']}` };
  }
  await router.patch('/ip/dhcp-server/network', net['.id'], { 'dns-server': ip, comment: mergeComment(net.comment) });
  return { updated: net.address, detail: `${net.address} dns-server=${ip}` };
}

// List every router object Tikspot manages (tagged with MANAGED_COMMENT), grouped
// by menu, with only safe fields (never secrets). Powers the admin "router objects"
// view so the operator can see exactly what Tikspot configured. Each group is
// tri-state: { ok, rows } or { ok:false, error } — a read failure is not "none".
export async function listManaged(router) {
  const out = {};
  for (const { key, menu, fields } of MANAGED_MENUS) {
    const r = await readMenu(router, menu);
    // Hotspot profiles can't carry the managed comment (no such field), so the
    // ones pointed at RADIUS are what Tikspot "manages" there.
    const mine = key === 'hotspot-profile'
      ? (e) => e['use-radius'] === 'yes' || e['use-radius'] === 'true' || e['use-radius'] === true
      : isManaged;
    out[key] = r.ok
      ? { ok: true, rows: r.rows.filter(mine).map((e) => summarize(e, fields)) }
      : { ok: false, error: r.error, rows: [] };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestrate the full auto-config. `serverHost` is the bare host of server-name
// (e.g. "hotspot.tikspot"); the container is reachable at `containerIp`.
//
// Never throws away work: returns { ok, steps:[{step,status,detail}], error?,
// unreachable? }. A step that fails is recorded and the rest still run, unless the
// failure looks network-level (no HTTP status), in which case the remainder are
// marked 'skipped' and `unreachable` is set.
//
// `hotspot: { interface, profileName, dnsName }` (optional) additionally
// provisions the hotspot itself: profile, server (named after serverHost) and
// the DHCP network's DNS server.
export async function autoConfigure(router, { containerIp, nasSecret, serverHost, profiles = null, hotspot = null } = {}) {
  // A literal-IP server-name resolves itself, so only a real hostname needs a DNS
  // static + host walled-garden entry.
  const host = serverHost && !isIpHost(serverHost) ? serverHost : null;
  const hs = hotspot && hotspot.interface ? { profileName: 'tikspot', ...hotspot } : null;
  if (hs && !hs.profileName) hs.profileName = 'tikspot';

  const plan = [
    { step: 'radius-client', run: () => ensureRadiusClient(router, { address: containerIp, secret: nasSecret }) },
    { step: 'radius-incoming', run: () => ensureRadiusIncoming(router, {}) },
    // The new profile must exist before configureHotspotProfile filters by name.
    ...(hs
      ? [{
          step: 'hotspot-profile-ensure',
          run: () => ensureHotspotProfile(router, { name: hs.profileName, interface: hs.interface, dnsName: hs.dnsName, serverHost }),
        }]
      : []),
    { step: 'hotspot-profile', run: () => configureHotspotProfile(router, { profiles }) },
    ...(hs
      ? [{
          step: 'hotspot-server',
          run: () => ensureHotspotServer(router, { name: serverHost, interface: hs.interface, profile: hs.profileName }),
        }]
      : []),
    ...(host ? [{ step: 'dns-static', run: () => ensureDnsStatic(router, { name: host, address: containerIp }) }] : []),
    ...(host ? [{ step: 'dns-remote-requests', run: () => ensureDnsRemoteRequests(router) }] : []),
    ...(hs ? [{ step: 'dhcp-dns', run: () => ensureDhcpDns(router, { interface: hs.interface }) }] : []),
    { step: 'walled-garden', run: () => ensureWalledGarden(router, { address: containerIp, host }) },
  ];

  const steps = [];
  let unreachable = false;
  let error = null;
  for (let i = 0; i < plan.length; i++) {
    const { step, run } = plan[i];
    if (unreachable) {
      steps.push({ step, status: 'skipped', detail: 'skipped — the router became unreachable' });
      continue;
    }
    try {
      const r = await run();
      steps.push({ step, status: 'done', detail: r?.detail || '', ...r });
    } catch (err) {
      const msg = errText(err);
      steps.push({ step, status: 'failed', detail: msg });
      if (!error) error = msg;
      // No HTTP status => transport-level failure (DNS/TCP/TLS/timeout): the rest
      // will fail the same way, so stop hammering the router. A problem we
      // detected ourselves (err.local) is config, not transport.
      if (!err?.status && !err?.local) unreachable = true;
    }
  }

  // A step may itself report 'skipped' (nothing to do, e.g. no DHCP network) —
  // that is not a failure. Unreachable-skips always come with a failed step.
  const ok = steps.every((s) => s.status === 'done' || s.status === 'skipped');
  const out = { ok, steps };
  if (error) out.error = error;
  if (unreachable) out.unreachable = true;
  return out;
}

// ---------------------------------------------------------------------------
// Verify the router matches the expected hotspot/RADIUS config.
//
// Returns { ok, checks } where each check is
//   { component, status:'pass'|'fail'|'unknown', ok, required, detail, raw?, docs? }
// `ok` is kept as a compat boolean (=== status === 'pass'), `raw` is the actual
// RouterOS line for a pass (the RADIUS secret is never included), and top-level
// `ok` is true when every REQUIRED check PASSES ('unknown' never counts as a pass).
const DOCS_BASE = 'https://github.com/krusherdom/tinkernet-tikspot/blob/main/docs/setup-mikrotik.md';

function mk(component, status, opts = {}) {
  return {
    component,
    status,
    ok: status === 'pass',
    required: opts.required !== false,
    detail: opts.detail || '',
    raw: opts.raw || '',
    hint: opts.hint || '',
    docs: opts.docs ? `${DOCS_BASE}#${opts.docs}` : '',
  };
}

const fmt = (menu, e, fields) =>
  (menu + ' ' + fields.map((f) => `${f}=${e[f] == null ? '' : e[f]}`).join(' ')).trim();

const yes = (v) => v === 'yes' || v === 'true' || v === true;

export async function verifyConfig(router, { containerIp, serverHost } = {}) {
  const [radius, incoming, profiles, servers, dns, dnsCfg, wgIp, wgHost, nat, containers, veths, addrs] =
    await Promise.all([
      readMenu(router, '/radius'),
      readObject(router, '/radius/incoming'),
      readMenu(router, '/ip/hotspot/profile'),
      readMenu(router, '/ip/hotspot'),
      readMenu(router, '/ip/dns/static'),
      readObject(router, '/ip/dns'),
      readMenu(router, '/ip/hotspot/walled-garden/ip'),
      readMenu(router, '/ip/hotspot/walled-garden'),
      readMenu(router, '/ip/firewall/nat'),
      readMenu(router, '/container'),
      readMenu(router, '/interface/veth'),
      readMenu(router, '/ip/address'),
    ]);

  const host = String(serverHost || '').trim();
  const checks = [];
  // A read that failed => 'unknown' with the reason, never a silent 'fail'.
  const unknown = (component, read, opts) =>
    mk(component, 'unknown', { ...opts, detail: read.error || 'the router menu could not be read' });

  // --- RADIUS client ------------------------------------------------------
  {
    const c = `RADIUS client → ${containerIp || '?'}`;
    const o = { docs: 'radius-client', hint: 'The router must know the container as a RADIUS server for hotspot logins.' };
    if (!radius.ok) checks.push(unknown(c, radius, o));
    else {
      const rc = radius.rows.find((r) => r.address === containerIp && String(r.service || '').includes('hotspot'));
      checks.push(mk(c, rc ? 'pass' : 'fail', {
        ...o,
        detail: rc ? '' : 'no /radius entry for the container with service=hotspot',
        raw: rc ? fmt('/radius', rc, ['address', 'service', 'comment']) : '',
      }));
    }
  }

  // --- RADIUS incoming (CoA) ---------------------------------------------
  {
    const c = 'RADIUS incoming (CoA / kick)';
    const o = { docs: 'radius-incoming-coa', hint: 'Without accept=yes on /radius incoming the router ignores Disconnect-Requests, so "Kick" does nothing.' };
    if (!incoming.ok) checks.push(unknown(c, incoming, o));
    else {
      const inc = incoming.obj || {};
      const good = yes(inc.accept) && String(inc.port || '') === COA_PORT;
      checks.push(mk(c, good ? 'pass' : 'fail', {
        ...o,
        detail: good ? '' : `/radius incoming must be accept=yes port=${COA_PORT} (found accept=${inc.accept ?? '?'} port=${inc.port ?? '?'})`,
        raw: good ? fmt('/radius/incoming', inc, ['accept', 'port']) : '',
      }));
    }
  }

  // --- Hotspot server bound to a RADIUS profile ---------------------------
  const radiusProfiles = profiles.ok ? profiles.rows.filter((p) => yes(p['use-radius'])) : [];
  {
    const c = 'Hotspot server uses a RADIUS profile';
    const o = { docs: 'hotspot-profile', hint: 'A hotspot server must reference a profile with use-radius=yes, otherwise logins never reach Tikspot.' };
    if (!profiles.ok) checks.push(unknown(c, profiles, o));
    else if (!servers.ok) checks.push(unknown(c, servers, o));
    else {
      const names = new Set(radiusProfiles.map((p) => p.name));
      const srv = servers.rows.find((s) => names.has(s.profile));
      const detail = !servers.rows.length
        ? 'no /ip/hotspot server is defined on the router'
        : !radiusProfiles.length
          ? 'no hotspot profile has use-radius=yes'
          : 'no hotspot server references a use-radius profile';
      checks.push(mk(c, srv ? 'pass' : 'fail', {
        ...o,
        detail: srv ? '' : detail,
        raw: srv ? fmt('/ip/hotspot', srv, ['name', 'interface', 'profile']) : '',
      }));
    }
  }

  // --- Hotspot server named after the portal host --------------------------
  // $(server-name) in the hotspot HTML is the /ip/hotspot entry's NAME, and the
  // Tikspot shim redirects guests to http://$(server-name)/login — so a server
  // called "hotspot1" sends phones to a host that doesn't resolve.
  if (host) {
    const c = `Hotspot server is named ${host}`;
    const o = {
      docs: 'hotspot-profile',
      hint: 'The hotspot HTML variable $(server-name) is the /ip/hotspot server\'s name; Tikspot redirects guests to http://$(server-name)/login, so the server must be named after the portal host.',
    };
    let check;
    if (!servers.ok) check = unknown(c, servers, o);
    else {
      const srv = servers.rows.find((s) => String(s.name || '').split('|')[0].trim() === host);
      const names = servers.rows.map((s) => s.name).filter(Boolean);
      check = mk(c, srv ? 'pass' : 'fail', {
        ...o,
        detail: srv ? '' : names.length ? `hotspot server(s) named ${names.join(', ')} — none named ${host}` : 'no /ip/hotspot server is defined on the router',
        raw: srv ? fmt('/ip/hotspot', srv, ['name', 'interface', 'profile']) : '',
      });
    }
    checks.push({ id: 'hotspot-server-name', ...check });
  }

  // --- login-by methods ---------------------------------------------------
  {
    const prof = radiusProfiles[0] || (profiles.ok ? profiles.rows[0] : null);
    const loginBy = String(prof?.['login-by'] || '');
    const parts = loginBy.split(',').map((s) => s.trim()).filter(Boolean);
    const c = 'Login methods include http-pap and mac';
    const o = { docs: 'login-methods', hint: 'http-pap is the method Tikspot\'s portal posts; mac enables MAC re-auth for remembered devices.' };
    if (!profiles.ok) checks.push(unknown(c, profiles, o));
    else if (!prof) checks.push(mk(c, 'fail', { ...o, detail: 'no hotspot profile found' }));
    else {
      const missing = ['http-pap', 'mac'].filter((m) => !parts.includes(m));
      checks.push(mk(c, missing.length ? 'fail' : 'pass', {
        ...o,
        detail: missing.length ? `login-by is missing: ${missing.join(', ')} (found "${loginBy}")` : '',
        raw: missing.length ? '' : fmt('/ip/hotspot/profile', prof, ['name', 'login-by']),
      }));
      // http-chap is optional (CHAP login is unverified on hardware) — informational.
      checks.push(mk('Login methods include http-chap', parts.includes('http-chap') ? 'pass' : 'fail', {
        required: false,
        docs: 'login-methods',
        hint: 'Optional. CHAP hashes the password client-side; Tikspot defaults to PAP.',
        detail: parts.includes('http-chap') ? '' : 'optional — add http-chap to login-by to allow CHAP logins',
      }));
    }
  }

  // --- Walled-garden IP ---------------------------------------------------
  {
    const c = `Walled-garden allows ${containerIp || '?'}`;
    const o = { docs: 'walled-garden', hint: 'Pre-login clients must be allowed to reach the container IP, or the portal page never loads.' };
    if (!wgIp.ok) checks.push(unknown(c, wgIp, o));
    else {
      const wi = wgIp.rows.find((e) => e['dst-address'] === containerIp && e.action === 'accept');
      checks.push(mk(c, wi ? 'pass' : 'fail', {
        ...o,
        detail: wi ? '' : "pre-login clients can't reach the container (no walled-garden IP accept)",
        raw: wi ? fmt('/ip/hotspot/walled-garden/ip', wi, ['action', 'dst-address']) : '',
      }));
    }
  }

  // --- Hostname-only checks ----------------------------------------------
  if (host && !isIpHost(host)) {
    {
      const c = `DNS static ${host} → ${containerIp || '?'}`;
      const o = { docs: 'dns-static', hint: 'Clients resolve the hotspot server-name through the router, so it needs a static A record for the container.' };
      if (!dns.ok) checks.push(unknown(c, dns, o));
      else {
        const d = dns.rows.find((r) => r.name === host && (!containerIp || r.address === containerIp));
        checks.push(mk(c, d ? 'pass' : 'fail', {
          ...o,
          detail: d ? '' : "no /ip/dns/static mapping the server-name to the container (clients can't resolve it)",
          raw: d ? fmt('/ip/dns/static', d, ['name', 'address']) : '',
        }));
      }
    }
    {
      const c = 'Router answers client DNS queries';
      const o = { docs: 'remote-dns-requests', hint: '/ip dns allow-remote-requests=yes lets hotspot clients use the router as their resolver — required for a hostname server-name.' };
      if (!dnsCfg.ok) checks.push(unknown(c, dnsCfg, o));
      else {
        const ok = yes(dnsCfg.obj?.['allow-remote-requests']);
        checks.push(mk(c, ok ? 'pass' : 'fail', {
          ...o,
          detail: ok ? '' : '/ip dns allow-remote-requests is not enabled, so clients cannot resolve the server-name',
          raw: ok ? '/ip/dns allow-remote-requests=yes' : '',
        }));
      }
    }
    {
      const c = `Walled-garden allows host ${host}`;
      const o = { required: false, docs: 'walled-garden', hint: 'Optional belt-and-braces: a dst-host rule for the server-name.' };
      if (!wgHost.ok) checks.push(unknown(c, wgHost, o));
      else {
        const wh = wgHost.rows.find((e) => e['dst-host'] === host && (e.action === 'allow' || e.action === 'accept'));
        checks.push(mk(c, wh ? 'pass' : 'fail', {
          ...o,
          detail: wh ? '' : 'optional — a dst-host walled-garden entry for the server-name',
          raw: wh ? fmt('/ip/hotspot/walled-garden', wh, ['action', 'dst-host']) : '',
        }));
      }
    }
  } else if (isIpHost(host)) {
    checks.push(mk(`Server-name is an IP (${host}) — no DNS needed`, 'pass', {
      required: false, docs: 'dns-static', detail: 'clients reach the portal directly by IP',
    }));
  }

  // --- Masquerade for container egress (informational) --------------------
  {
    const c = 'Masquerade covers the container subnet';
    const o = { required: false, docs: 'masquerade', hint: 'Without a srcnat masquerade rule the container has no outbound internet (guest-lookup plugins and the egress check fail).' };
    if (!nat.ok) checks.push(unknown(c, nat, o));
    else {
      const masq = nat.rows.filter((r) => r.chain === 'srcnat' && r.action === 'masquerade' && !yes(r.disabled));
      // Prefer a rule whose src-address explicitly covers the container; a rule
      // with no src-address can't be judged (it may be pinned to another
      // out-interface), so it is reported as "unknown", never as a pass.
      const rule = masq.find((r) => r['src-address'] && cidrCovers(r['src-address'], containerIp));
      const vague = !rule && masq.find((r) => !r['src-address']);
      const status = rule ? 'pass' : vague ? 'unknown' : 'fail';
      checks.push(mk(c, status, {
        ...o,
        detail: rule
          ? ''
          : vague
            ? `a masquerade rule without src-address exists (${fmt('', vague, ['out-interface', 'comment']).trim()}) — cannot confirm it covers ${containerIp || 'the container'}`
            : `no enabled srcnat masquerade rule covers ${containerIp || 'the container'} — outbound internet from the container will not work`,
        raw: rule ? fmt('/ip/firewall/nat', rule, ['chain', 'action', 'src-address', 'out-interface']) : '',
      }));
    }
  }

  // --- Container status / start-on-boot (informational) -------------------
  {
    const c = 'Container is running and starts on boot';
    const o = { required: false, docs: 'container-status', hint: 'start-on-boot=yes means the portal comes back by itself after a router reboot.' };
    if (!containers.ok) checks.push(unknown(c, containers, o));
    else {
      const pl = matchPlacement(containerIp, containers.rows, veths.rows, addrs.rows);
      const pc = pl && pl.container;
      if (!pc) {
        checks.push(mk(c, 'fail', { ...o, detail: `no /container on the router matches ${containerIp || 'the container IP'}` }));
      } else {
        const running = String(pc.status || '').toLowerCase() === 'running';
        const onBoot = yes(pc.startOnBoot);
        const bits = [];
        if (!running) bits.push(`status=${pc.status || 'unknown'} (expected running)`);
        if (!onBoot) bits.push('start-on-boot is not enabled');
        checks.push(mk(c, bits.length ? 'fail' : 'pass', {
          ...o,
          detail: bits.join('; '),
          raw: bits.length ? '' : `/container name=${pc.name || ''} status=${pc.status} start-on-boot=yes`,
        }));
      }
    }
  }

  // --- Router → container reachability (the triage step) ------------------
  {
    const c = `Router can reach the container (${containerIp || '?'}/healthz)`;
    const o = { docs: 'router-reachability', hint: 'The router fetches http://<container-ip>/healthz — if this fails, nothing else about the hotspot can work.' };
    if (!containerIp) {
      checks.push(mk(c, 'fail', { ...o, detail: 'no container IP configured' }));
    } else {
      try {
        const r = await router.call('POST', '/tool/fetch', {
          url: `http://${containerIp}/healthz`,
          mode: 'http',
          output: 'user',
        });
        const status = r && (r.status || r['status']);
        const good = !status || /finish|done|success/i.test(String(status));
        checks.push(mk(c, good ? 'pass' : 'fail', {
          ...o,
          detail: good ? '' : `/tool/fetch reported "${status}"`,
          raw: good ? `/tool/fetch url="http://${containerIp}/healthz" → ${status || 'ok'}` : '',
        }));
      } catch (err) {
        // A read-only API user can't run /tool/fetch — that's "couldn't check",
        // not "the router can't reach the container".
        checks.push(
          isPermissionError(err)
            ? mk(c, 'unknown', { ...o, detail: `the API user may not run /tool/fetch: ${errText(err)}` })
            : mk(c, 'fail', { ...o, detail: errText(err) }),
        );
      }
    }
  }

  return { ok: checks.every((c) => !c.required || c.status === 'pass'), checks };
}
