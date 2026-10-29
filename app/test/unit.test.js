// Unit tests for the security-sensitive, pure pieces of the backend: password
// hashing, the login rate limiter, and the management-API input validators.
// These avoid the native better-sqlite3 dependency so they run anywhere with
// just `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword } from '../src/admin/auth.js';
import { makeRateLimiter } from '../src/admin/ratelimit.js';
import {
  validateRateLimit,
  validateNonNegInt,
  validatePassword,
  validateDesignJson,
  validateExpiryMode,
  MAX_DESIGN_BYTES,
} from '../src/admin/validate.js';
import { renderClientsConf } from '../src/radius/clientsconf.js';
import { routerLocalDate } from '../src/radius/midnight.js';
import { buildSetupScript } from '../src/mikrotik/script.js';
import { MANAGED_COMMENT, verifyConfig, autoConfigure } from '../src/mikrotik/rest.js';
import {
  validateIPv4,
  validateScheme,
  validateHost,
  validateServerName,
  validateSecret,
  validateRouterSettings,
} from '../src/admin/validate.js';

test('password hash round-trips and rejects wrong/tampered input', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('', stored), false);
  assert.equal(verifyPassword('correct horse', null), false);

  // A salt is used: two hashes of the same password differ.
  assert.notEqual(hashPassword('same'), hashPassword('same'));

  // A tampered hash fails rather than throwing.
  const tampered = stored.slice(0, -1) + (stored.endsWith('a') ? 'b' : 'a');
  assert.equal(verifyPassword('correct horse', tampered), false);
  assert.equal(verifyPassword('x', 'bcrypt$deadbeef$cafe'), false); // unknown alg
});

test('rate limiter blocks after max within the window and reset clears it', () => {
  const rl = makeRateLimiter({ max: 3, windowMs: 1000 });
  const t0 = 1_000_000;
  assert.equal(rl.check('ip', t0).allowed, true);
  assert.equal(rl.check('ip', t0).allowed, true);
  assert.equal(rl.check('ip', t0).allowed, true);
  const blocked = rl.check('ip', t0);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);

  // A different key is independent.
  assert.equal(rl.check('other', t0).allowed, true);

  // The window rolls over.
  assert.equal(rl.check('ip', t0 + 1001).allowed, true);

  // reset() clears the counter immediately.
  rl.check('ip', t0 + 1001);
  rl.check('ip', t0 + 1001);
  assert.equal(rl.check('ip', t0 + 1001).allowed, false);
  rl.reset('ip');
  assert.equal(rl.check('ip', t0 + 1001).allowed, true);
});

test('validateRateLimit accepts MikroTik forms and rejects junk', () => {
  for (const good of ['5M/5M', '512k/1M', '10000000/10000000', '2.5M/2.5M']) {
    assert.equal(validateRateLimit(good).ok, true, good);
  }
  for (const bad of ['5M', '5M-5M', 'fast', '5M/', '/5M', '5X/5M']) {
    assert.equal(validateRateLimit(bad).ok, false, bad);
  }
  assert.deepEqual(validateRateLimit(''), { ok: true, value: null });
  assert.deepEqual(validateRateLimit(null), { ok: true, value: null });
  assert.equal(validateRateLimit('  5M/5M  ').value, '5M/5M'); // trimmed
});

test('validateNonNegInt rejects negatives, floats, and NaN', () => {
  assert.equal(validateNonNegInt(0, 'x').ok, true);
  assert.equal(validateNonNegInt(1024, 'x').value, 1024);
  assert.deepEqual(validateNonNegInt('', 'x'), { ok: true, value: null });
  assert.equal(validateNonNegInt(-1, 'x').ok, false);
  assert.equal(validateNonNegInt(1.5, 'x').ok, false);
  assert.equal(validateNonNegInt('abc', 'x').ok, false);
});

test('validatePassword enforces the minimum length', () => {
  assert.equal(validatePassword('123456').ok, true);
  assert.equal(validatePassword('12345').ok, false);
  assert.equal(validatePassword('').ok, false);
  assert.equal(validatePassword(undefined).ok, false);
});

test('validateDesignJson checks validity and size', () => {
  assert.equal(validateDesignJson('{"a":1}').ok, true);
  assert.deepEqual(validateDesignJson(null), { ok: true, value: null });
  assert.equal(validateDesignJson('{not json').ok, false);
  assert.equal(validateDesignJson(42).ok, false);
  const huge = JSON.stringify({ s: 'x'.repeat(MAX_DESIGN_BYTES) });
  assert.equal(validateDesignJson(huge).ok, false);
});

test('validateExpiryMode accepts fixed/midnight and rejects junk', () => {
  assert.deepEqual(validateExpiryMode(null), { ok: true, value: null });
  assert.deepEqual(validateExpiryMode(''), { ok: true, value: null });
  assert.deepEqual(validateExpiryMode('fixed'), { ok: true, value: null });
  assert.deepEqual(validateExpiryMode('midnight'), { ok: true, value: 'midnight' });
  assert.equal(validateExpiryMode('hourly').ok, false);
});

test('routerLocalDate shifts the date by the cached GMT offset', () => {
  // Minimal db stub: getSetting reads settings.value.
  const dbWith = (offsetSec) => ({ prepare: () => ({ get: () => ({ value: String(offsetSec) }) }) });
  const lateUtc = Date.parse('2026-01-01T23:30:00Z');
  const earlyUtc = Date.parse('2026-01-01T00:30:00Z');
  assert.equal(routerLocalDate(dbWith(0), lateUtc), '2026-01-01');
  assert.equal(routerLocalDate(dbWith(3600), lateUtc), '2026-01-02'); // +1h tips into next day
  assert.equal(routerLocalDate(dbWith(-3600), earlyUtc), '2025-12-31'); // -1h tips into prev day
});

test('buildSetupScript emits idempotent hotspot config with embedded values (IP server-name)', () => {
  const s = buildSetupScript({ containerIp: '172.18.0.3', serverHost: '172.18.0.3', nasSecret: 'sek' });
  assert.match(s, /:if \(\[:len \[\/radius find/); // idempotent set-or-add form
  assert.match(s, /\/radius add address="172\.18\.0\.3" secret="sek" service=hotspot/);
  assert.ok(s.includes(MANAGED_COMMENT)); // tagged with the managed comment
  assert.match(s, /\/ip\/hotspot\/profile set \[find\] use-radius=yes/);
  // 0.18.0: MAC cookies off by default; MAC re-auth sends the MAC as username.
  assert.ok(s.includes('login-by="http-chap,http-pap,mac" mac-auth-mode=mac-as-username'));
  const withCookie = buildSetupScript({ containerIp: '172.18.0.3', serverHost: '172.18.0.3', nasSecret: 'sek', macCookie: true });
  assert.ok(withCookie.includes('login-by="mac-cookie,http-chap,http-pap,mac" mac-auth-mode=mac-as-username'));
  assert.match(s, /walled-garden\/ip add action=accept dst-address="172\.18\.0\.3"/);
  // CoA / kick support — without this "Kick" silently does nothing.
  assert.ok(s.includes('/radius incoming set accept=yes port=3799'));
  // A literal-IP server-name needs no DNS static / host walled-garden.
  assert.ok(!s.includes('/ip/dns/static add'));
  assert.match(s, /server-name is an IP/);
});

test('buildSetupScript adds DNS + host walled-garden for a hostname server-name', () => {
  const s = buildSetupScript({ containerIp: '10.0.0.5', serverHost: 'wifi.example.com', nasSecret: 'x' });
  assert.match(s, /\/ip\/dns\/static add name="wifi\.example\.com" address="10\.0\.0\.5"/);
  assert.match(s, /\/ip\/hotspot\/walled-garden add action=allow dst-host="wifi\.example\.com"/);
});

test('renderClientsConf embeds the secret and trusts localhost + a LAN range', () => {
  const conf = renderClientsConf('s3cr3t-value');
  // Secret present on every client block.
  assert.equal((conf.match(/secret = s3cr3t-value/g) || []).length, 4);
  assert.match(conf, /client localhost \{/);
  assert.match(conf, /ipaddr = 127\.0\.0\.1/);
  // A catch-all client so a router at any LAN IP is accepted (the gap this fixes).
  assert.match(conf, /ipaddr = 0\.0\.0\.0\/0/);
  assert.match(conf, /ipv6addr = ::\/0/);
  // BlastRADIUS: LAN clients must send Message-Authenticator; localhost is exempt.
  assert.equal((conf.match(/require_message_authenticator = yes/g) || []).length, 2);
  assert.equal((conf.match(/limit_proxy_state = yes/g) || []).length, 2);
  assert.doesNotMatch(conf.split('client tikspot_net')[0], /require_message_authenticator/);
});

// ---------------------------------------------------------------------------
// Router-settings validators (POST /api/setup/router).

test('validateIPv4 accepts dotted-quad and rejects junk, empty is ok', () => {
  assert.deepEqual(validateIPv4(''), { ok: true, value: '' });
  assert.deepEqual(validateIPv4(null), { ok: true, value: '' });
  assert.equal(validateIPv4('172.18.0.3').ok, true);
  assert.equal(validateIPv4('172.18.0.3').value, '172.18.0.3');
  assert.equal(validateIPv4('256.1.1.1').ok, false);
  assert.equal(validateIPv4('not-an-ip').ok, false);
  assert.equal(validateIPv4('1.2.3').ok, false);
});

test('validateScheme accepts http/https, defaults to https, rejects other', () => {
  assert.deepEqual(validateScheme(''), { ok: true, value: 'https' });
  assert.deepEqual(validateScheme(null), { ok: true, value: 'https' });
  assert.equal(validateScheme('http').value, 'http');
  assert.equal(validateScheme('HTTPS').value, 'https');
  assert.equal(validateScheme('ftp').ok, false);
});

test('validateHost accepts host[:port] forms and rejects scheme/path/spaces', () => {
  assert.deepEqual(validateHost(''), { ok: true, value: '' });
  assert.equal(validateHost('192.168.88.1').ok, true);
  assert.equal(validateHost('router.lan:8443').ok, true);
  assert.equal(validateHost('router.lan:70000').ok, false); // bad port
  assert.equal(validateHost('https://router.lan').ok, false); // scheme not allowed
  assert.equal(validateHost('router.lan/path').ok, false); // no path
  assert.equal(validateHost('router lan').ok, false); // no spaces
  assert.equal(validateHost('not a host', 'host').error.includes('host'), true);
});

test('validateServerName rejects .local and enforces host|label shape', () => {
  assert.deepEqual(validateServerName(''), { ok: true, value: '' });
  assert.equal(validateServerName('hotspot.tikspot').ok, true);
  assert.equal(validateServerName('hotspot.tikspot|Guest Wifi').ok, true);
  assert.equal(validateServerName('172.18.0.3').ok, true);
  assert.equal(validateServerName('hotspot.local').ok, false);
  assert.match(validateServerName('hotspot.local').error, /mDNS|Bonjour/);
  assert.equal(validateServerName('HOTSPOT.LOCAL').ok, false); // case-insensitive
  assert.equal(validateServerName('|label only').ok, false); // no host part
  assert.equal(validateServerName('bad host|label').ok, false); // space in host part
});

test('validateSecret enforces minimum length and rejects spaces, empty is a no-op', () => {
  assert.deepEqual(validateSecret(''), { ok: true, value: '' });
  assert.equal(validateSecret('short').ok, false);
  assert.equal(validateSecret('longenoughsecret').ok, true);
  assert.equal(validateSecret('has a space here').ok, false);
});

test('validateRouterSettings validates only the fields present and reports per-field errors', () => {
  const good = validateRouterSettings({
    scheme: 'https', host: '192.168.88.1', container_ip: '172.18.0.3',
    server_name: 'hotspot.tikspot', nas_secret: 'a-real-secret-value',
  });
  assert.equal(good.ok, true);
  assert.deepEqual(Object.keys(good.values).sort(), ['container_ip', 'host', 'nas_secret', 'scheme', 'server_name']);

  const bad = validateRouterSettings({ host: '192.168.88.1', server_name: 'hotspot.local', container_ip: '999.1.1.1' });
  assert.equal(bad.ok, false);
  assert.ok(bad.fields.server_name);
  assert.ok(bad.fields.container_ip);
  assert.equal(bad.fields.host, undefined); // valid field is not reported
  assert.equal(bad.error, Object.values(bad.fields)[0]);

  // Fields not present in the body are left untouched (partial update).
  const partial = validateRouterSettings({ host: '192.168.88.1' });
  assert.equal(partial.ok, true);
  assert.deepEqual(Object.keys(partial.values), ['host']);
});

// ---------------------------------------------------------------------------
// verifyConfig — stub router satisfying only `list` and `call`.

function verifyFixtures({ containerIp, serverHost, radius = 'ok' } = {}) {
  const fx = {
    '/radius': radius === 'ok' ? [{ '.id': '*1', address: containerIp, service: 'hotspot', comment: 'x' }] : [],
    '/radius/incoming': { accept: 'yes', port: '3799' },
    '/ip/hotspot/profile': [{ '.id': '*2', name: 'default', 'use-radius': 'yes', 'login-by': 'http-chap,http-pap,mac', 'mac-auth-mode': 'mac-as-username' }],
    // Named after the portal host — $(server-name) is the server entry's name.
    '/ip/hotspot': [{ '.id': '*3', name: serverHost, interface: 'bridge1', profile: 'default' }],
    '/ip/dns/static': [{ '.id': '*4', name: serverHost, address: containerIp }],
    '/ip/dns': { 'allow-remote-requests': 'yes' },
    '/ip/hotspot/walled-garden/ip': [{ '.id': '*5', action: 'accept', 'dst-address': containerIp }],
    '/ip/hotspot/walled-garden': [{ '.id': '*6', action: 'allow', 'dst-host': serverHost }],
    '/ip/firewall/nat': [{ '.id': '*7', chain: 'srcnat', action: 'masquerade', 'src-address': '10.0.0.0/24' }],
    '/container': [{ '.id': '*8', name: 'app-tikspot', interface: 'veth1', status: 'running', 'start-on-boot': 'yes' }],
    '/interface/veth': [{ name: 'veth1', address: `${containerIp}/24`, gateway: '10.0.0.1' }],
    '/ip/address': [{ address: `${containerIp}/24`, interface: 'veth1' }],
  };
  return fx;
}

test('verifyConfig passes every required check on a fully-configured router', async () => {
  const containerIp = '10.0.0.5';
  const serverHost = 'wifi.example.com';
  const fx = verifyFixtures({ containerIp, serverHost });
  const router = {
    list: async (menu) => fx[menu],
    call: async () => ({ status: 'finished' }),
  };
  const result = await verifyConfig(router, { containerIp, serverHost });
  const failing = result.checks.filter((c) => c.required && c.status !== 'pass');
  assert.deepEqual(failing, []);
  assert.equal(result.ok, true);
});

test('verifyConfig reports drift (missing RADIUS client) as a required failure', async () => {
  const containerIp = '10.0.0.5';
  const serverHost = 'wifi.example.com';
  const fx = verifyFixtures({ containerIp, serverHost, radius: 'missing' });
  const router = {
    list: async (menu) => fx[menu],
    call: async () => ({ status: 'finished' }),
  };
  const result = await verifyConfig(router, { containerIp, serverHost });
  const radiusCheck = result.checks.find((c) => c.component.startsWith('RADIUS client'));
  assert.equal(radiusCheck.status, 'fail');
  assert.equal(result.ok, false);
});

test('verifyConfig reports a read failure as unknown, not a silent fail, and overall ok is false', async () => {
  const containerIp = '10.0.0.5';
  const serverHost = 'wifi.example.com';
  const fx = verifyFixtures({ containerIp, serverHost });
  const router = {
    list: async (menu) => {
      if (menu === '/radius') throw new Error('no permission to read this menu');
      return fx[menu];
    },
    call: async () => ({ status: 'finished' }),
  };
  const result = await verifyConfig(router, { containerIp, serverHost });
  const radiusCheck = result.checks.find((c) => c.component.startsWith('RADIUS client'));
  assert.equal(radiusCheck.status, 'unknown');
  assert.equal(result.ok, false); // 'unknown' never counts as a pass
});

// ---------------------------------------------------------------------------
// autoConfigure — stub router satisfying only `list`, `add`, `patch`, `call`.

test('autoConfigure records a failed step (403) and keeps going, without marking unreachable', async () => {
  const containerIp = '10.0.0.5';
  const router = {
    list: async (menu) => {
      if (menu === '/radius') return []; // -> ensureRadiusClient will add()
      if (menu === '/ip/hotspot/profile') return [{ '.id': '*p1', name: 'default', comment: '' }];
      return []; // walled-garden reads
    },
    add: async () => ({ '.id': '*new' }),
    patch: async (menu) => {
      if (menu === '/ip/hotspot/profile') {
        const err = new Error('not enough permissions');
        err.status = 403;
        throw err;
      }
      return {};
    },
    call: async () => ({}),
  };

  const result = await autoConfigure(router, {
    containerIp,
    nasSecret: 'a-real-secret-value',
    serverHost: containerIp, // an IP server-name skips the DNS step
    profiles: null,
  });

  const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s.status]));
  assert.equal(byStep['radius-client'], 'done');
  assert.equal(byStep['radius-incoming'], 'done');
  assert.equal(byStep['hotspot-profile'], 'failed');
  assert.equal(byStep['walled-garden'], 'done'); // execution continues past the failed step
  assert.equal(result.ok, false);
  assert.ok(!result.unreachable);
  assert.ok(result.error);
});

test('autoConfigure marks the router unreachable and skips remaining steps on a status-less error', async () => {
  const containerIp = '10.0.0.5';
  const router = {
    list: async () => {
      throw new Error('connect ECONNREFUSED'); // no .status => transport-level failure
    },
    add: async () => ({ '.id': '*new' }),
    patch: async () => ({}),
    call: async () => ({}),
  };

  const result = await autoConfigure(router, {
    containerIp,
    nasSecret: 'a-real-secret-value',
    serverHost: containerIp,
    profiles: null,
  });

  assert.equal(result.steps[0].status, 'failed');
  assert.ok(result.steps.slice(1).every((s) => s.status === 'skipped'));
  assert.equal(result.unreachable, true);
  assert.equal(result.ok, false);
});

// --- hardware findings from the test RB5009 (RouterOS 7.23), 2026-09-08 ---------
import { configureHotspotProfile, ensureDnsRemoteRequests, verifyConfig as verifyCfg2, loginByFor } from '../src/mikrotik/rest.js';
import { matchPlacement } from '../src/mikrotik/placement.js';

function stubRouter(menus, calls) {
  return {
    list: async (menu) => menus[menu] ?? [],
    add: async (menu, obj) => { calls.push(['add', menu, obj]); return { '.id': '*9' }; },
    patch: async (menu, id, obj) => { calls.push(['patch', menu, id, obj]); return {}; },
    call: async (method, path, body) => { calls.push([method, path, body]); return { status: 'finished' }; },
  };
}

test('hotspot profile PATCH never sends a comment (RouterOS has no such field)', async () => {
  const calls = [];
  const r = stubRouter({ '/ip/hotspot/profile': [{ '.id': '*0', name: 'default', 'use-radius': 'false', 'login-by': 'cookie,http-chap' }] }, calls);
  const res = await configureHotspotProfile(r, {});
  assert.deepEqual(res.profiles, ['default']);
  const patch = calls.find((c) => c[0] === 'patch');
  assert.equal(patch[1], '/ip/hotspot/profile');
  assert.equal('comment' in patch[3], false);
  assert.equal(patch[3]['use-radius'], 'yes');
  // 0.18.0 default: no mac-cookie, MAC re-auth as username with empty password.
  assert.equal(patch[3]['login-by'], 'http-chap,http-pap,mac');
  assert.equal(patch[3]['mac-auth-mode'], 'mac-as-username');
  assert.equal('mac-auth-password' in patch[3], false);
});

test('configureHotspotProfile: macCookie adds mac-cookie; an explicit loginBy still wins', async () => {
  const menus = { '/ip/hotspot/profile': [{ '.id': '*0', name: 'default' }] };
  const calls = [];
  await configureHotspotProfile(stubRouter(menus, calls), { macCookie: true });
  assert.equal(calls[0][3]['login-by'], 'mac-cookie,http-chap,http-pap,mac');
  assert.equal(calls[0][3]['mac-auth-mode'], 'mac-as-username');
  const calls2 = [];
  await configureHotspotProfile(stubRouter(menus, calls2), { loginBy: 'http-pap,mac' });
  assert.equal(calls2[0][3]['login-by'], 'http-pap,mac');
});

test('loginByFor follows the hotspot_mac_cookie setting (default off)', () => {
  const dbWith = (value) => ({ prepare: () => ({ get: () => (value == null ? undefined : { value }) }) });
  assert.equal(loginByFor(dbWith(null)), 'http-chap,http-pap,mac');
  assert.equal(loginByFor(dbWith('0')), 'http-chap,http-pap,mac');
  assert.equal(loginByFor(dbWith('1')), 'mac-cookie,http-chap,http-pap,mac');
  assert.equal(loginByFor(dbWith('true')), 'mac-cookie,http-chap,http-pap,mac');
});

test('verifyConfig: mac-auth-mode must be mac-as-username; mac-cookie mismatch is only a warning', async () => {
  const containerIp = '10.0.0.5';
  const serverHost = 'wifi.example.com';
  const run = async (prof, opts = {}) => {
    const fx = verifyFixtures({ containerIp, serverHost });
    fx['/ip/hotspot/profile'] = [{ ...fx['/ip/hotspot/profile'][0], ...prof }];
    const router = { list: async (menu) => fx[menu], call: async () => ({ status: 'finished' }) };
    return verifyCfg2(router, { containerIp, serverHost, ...opts });
  };
  const find = (res, prefix) => res.checks.find((c) => c.component.startsWith(prefix));

  const bad = await run({ 'mac-auth-mode': 'mac-as-username-and-password' });
  const mode = find(bad, 'Hotspot profile mac-auth-mode');
  assert.equal(mode.status, 'fail');
  assert.equal(mode.required, true);
  assert.match(mode.hint, /profile set default mac-auth-mode=mac-as-username/);
  assert.equal(bad.ok, false);

  const good = await run({});
  assert.equal(find(good, 'Hotspot profile mac-auth-mode').status, 'pass');
  assert.equal(find(good, 'Hotspot MAC cookies').status, 'pass');

  // Cookie on the router but the setting is off -> non-required warning.
  const extra = await run({ 'login-by': 'mac-cookie,http-chap,http-pap,mac' });
  const w = find(extra, 'Hotspot MAC cookies');
  assert.equal(w.status, 'fail');
  assert.equal(w.required, false);
  assert.match(w.detail, /turn "Use MAC cookies" on/);
  assert.equal(extra.ok, true);

  // Setting on but the router lacks mac-cookie -> warning the other way.
  const missing = await run({}, { macCookie: true });
  const w2 = find(missing, 'Hotspot MAC cookies');
  assert.equal(w2.status, 'fail');
  assert.equal(w2.required, false);
  assert.match(w2.detail, /lacks mac-cookie/);
  assert.equal((await run({ 'login-by': 'mac-cookie,http-chap,http-pap,mac' }, { macCookie: true })).checks
    .find((c) => c.component.startsWith('Hotspot MAC cookies')).status, 'pass');
});

test('verifyConfig judges the profile the hotspot server uses, not the first profile on the router', async () => {
  const containerIp = '10.0.0.5';
  const serverHost = 'wifi.example.com';
  const fx = verifyFixtures({ containerIp, serverHost });
  // RouterOS's built-in "default" profile keeps stock values (mac-cookie, and-password)
  // but no server references it; the server uses a clean "tikspot" profile.
  fx['/ip/hotspot/profile'] = [
    { '.id': '*2', name: 'default', 'use-radius': 'yes', 'login-by': 'mac,http-chap,http-pap,mac-cookie', 'mac-auth-mode': 'mac-as-username-and-password' },
    { '.id': '*9', name: 'tikspot', 'use-radius': 'yes', 'login-by': 'mac,http-chap,http-pap', 'mac-auth-mode': 'mac-as-username' },
  ];
  fx['/ip/hotspot'] = [{ '.id': '*3', name: serverHost, interface: 'bridge1', profile: 'tikspot' }];
  const router = { list: async (menu) => fx[menu], call: async () => ({ status: 'finished' }) };
  const res = await verifyCfg2(router, { containerIp, serverHost });
  const find = (prefix) => res.checks.find((c) => c.component.startsWith(prefix));
  assert.equal(find('Hotspot MAC cookies').status, 'pass');
  assert.equal(find('Hotspot profile mac-auth-mode').status, 'pass');
  assert.match(find('Login methods include http-pap').raw, /name=tikspot/);
  assert.equal(res.ok, true);
});

test('ensureDnsRemoteRequests patches the single /ip/dns object only when off', async () => {
  const calls = [];
  const off = stubRouter({ '/ip/dns': [{ 'allow-remote-requests': 'false' }] }, calls);
  assert.equal((await ensureDnsRemoteRequests(off)).updated, true);
  assert.deepEqual(calls[0], ['PATCH', '/ip/dns', { 'allow-remote-requests': 'yes' }]);
  const on = stubRouter({ '/ip/dns': [{ 'allow-remote-requests': 'true' }] }, []);
  assert.equal((await ensureDnsRemoteRequests(on)).updated, undefined);
});

test('masquerade check: empty src-address is unknown, covering rule is pass', async () => {
  const base = { '/radius': [], '/radius/incoming': [{}], '/ip/hotspot/profile': [], '/ip/hotspot': [], '/ip/dns/static': [], '/ip/dns': [{}], '/ip/hotspot/walled-garden/ip': [], '/ip/hotspot/walled-garden': [], '/container': [], '/interface/veth': [], '/ip/address': [] };
  const vague = stubRouter({ ...base, '/ip/firewall/nat': [{ chain: 'srcnat', action: 'masquerade', 'out-interface': 'test-bridge' }] }, []);
  let c = (await verifyCfg2(vague, { containerIp: '172.18.5.6' })).checks.find((x) => x.component.startsWith('Masquerade'));
  assert.equal(c.status, 'unknown');
  const good = stubRouter({ ...base, '/ip/firewall/nat': [{ chain: 'srcnat', action: 'masquerade', 'out-interface': 'x' }, { chain: 'srcnat', action: 'masquerade', 'src-address': '172.18.5.0/24' }] }, []);
  c = (await verifyCfg2(good, { containerIp: '172.18.5.6' })).checks.find((x) => x.component.startsWith('Masquerade'));
  assert.equal(c.status, 'pass');
});

test('matchPlacement derives status from RouterOS 7.23 running=true', () => {
  const pl = matchPlacement('172.18.5.6', [{ name: 'app-tikspot', interface: 'veth-tikspot', running: 'true', 'start-on-boot': 'true' }], [{ name: 'veth-tikspot', address: '172.18.5.6/24' }], []);
  assert.equal(pl.container.status, 'running');
  assert.equal(pl.container.startOnBoot, 'true');
});
