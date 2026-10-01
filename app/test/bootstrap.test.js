// Zero-touch deployment (app/src/bootstrap/*): env parsing, seed/enforce
// settings, admin password, plugin seeding + design attach, restore-from-file,
// hotspot provisioning in rest.js, and the retrying router bootstrap.
// In-memory SQLite (migrated) per test, temp dirs under os.tmpdir(), and an
// in-memory RouterOS stub — no network, no router.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import JSZip from 'jszip';

import { migrate } from '../src/db/migrate.js';
import { seedDefaults } from '../src/seed.js';
import { getSetting, setSetting, getJSON } from '../src/db/settings.js';
import { verifyPassword, hashPassword } from '../src/admin/auth.js';
import { ensureDefaultDesign, getActiveDesign, designModel, draftModel, saveDraft } from '../src/portal/designs.js';
import { getPlugin, getPluginPublic, listPlugins, createPlugin } from '../src/plugins/store.js';
import { readBootstrapEnv, redact } from '../src/bootstrap/env.js';
import { applyBootstrap, maybeRestoreFromFile, attachPluginToActiveDesign } from '../src/bootstrap/apply.js';
import { startRouterBootstrap, SIG_KEY } from '../src/bootstrap/router.js';
import { readBootstrapStatus } from '../src/bootstrap/status.js';
import { promoteStagedRestore } from '../src/admin/backup.js';
import {
  ensureHotspotProfile,
  ensureHotspotServer,
  ensureDhcpDns,
  autoConfigure,
  verifyConfig,
  MANAGED_COMMENT,
} from '../src/mikrotik/rest.js';

const PLUGINS_DIR = fileURLToPath(new URL('../../plugins', import.meta.url));
const RMS_ID = 'rms-cloud-surname-room';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  seedDefaults(db);
  ensureDefaultDesign(db);
  return db;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tikspot-bootstrap-'));
}

const quietLog = { info() {}, warn() {} };
const spec = (env) => readBootstrapEnv(env, { readFile: () => { throw new Error('no files'); } });
const apply = (db, env, opts = {}) => applyBootstrap(db, readBootstrapEnv(env), { log: quietLog, pluginDir: PLUGINS_DIR, ...opts });

// ---------------------------------------------------------------------------
// env parsing

test('env: defaults, _FILE secrets, plain wins over _FILE, hotspot + plugin maps', () => {
  const files = { '/run/secrets/admin': 'from-file-pw\n', '/run/secrets/nas': '  nas-secret-from-file  ', '/run/secrets/cp': 'cpw' };
  const s = readBootstrapEnv(
    {
      TIKSPOT_ADMIN_PASSWORD_FILE: '/run/secrets/admin',
      TIKSPOT_NAS_SECRET: 'plain-nas-secret',
      TIKSPOT_NAS_SECRET_FILE: '/run/secrets/nas',
      TIKSPOT_ROUTER_HOST: '192.168.88.1',
      TIKSPOT_HOTSPOT_PROFILES: ' hsprof1 , hsprof2 ,',
      TIKSPOT_AUTOCONFIGURE: 'always',
      TIKSPOT_HOTSPOT_INTERFACE: 'bridge-hs',
      TIKSPOT_PLUGIN: RMS_ID,
      TIKSPOT_PLUGIN_SECRET_clientId: '54321',
      TIKSPOT_PLUGIN_SECRET_clientPassword_FILE: '/run/secrets/cp',
      TIKSPOT_PLUGIN_PARAM_moduleType: 'GuestServices',
      TIKSPOT_PLUGIN_ENABLED: 'yes',
      TIKSPOT_RESTORE_FILE: '/data/b.zip',
    },
    { readFile: (p) => { if (!(p in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return files[p]; } },
  );
  assert.equal(s.mode, 'seed');
  assert.equal(s.admin.password, 'from-file-pw');
  assert.equal(s.setupComplete, true, 'defaults to complete when an admin password is supplied');
  assert.equal(s.nasSecret, 'plain-nas-secret', 'plain var wins over _FILE');
  assert.deepEqual(s.hotspotProfiles, ['hsprof1', 'hsprof2']);
  assert.equal(s.autoconfigure, 'always');
  assert.deepEqual(s.hotspot, { interface: 'bridge-hs', profileName: 'tikspot', dnsName: null });
  assert.equal(s.plugin.source, 'bundled');
  assert.deepEqual(s.plugin.secrets, { clientId: '54321', clientPassword: 'cpw' });
  assert.deepEqual(s.plugin.params, { moduleType: 'GuestServices' });
  assert.equal(s.plugin.enabled, true);
  assert.deepEqual(s.restore, { file: '/data/b.zip', mode: 'fresh' });
  assert.deepEqual(s.warnings, []);

  // redact() never leaks a secret value.
  const red = JSON.stringify(redact(s));
  for (const secret of ['from-file-pw', 'plain-nas-secret', '54321', 'cpw']) assert.ok(!red.includes(secret), secret);
});

test('env: unresolved RouterOS placeholders are ignored with a warning (value not echoed)', () => {
  const s = spec({
    TIKSPOT_ADMIN_PASSWORD: '[secret:admin_password]',
    TIKSPOT_CONTAINER_IP: '[containerIP]',
    TIKSPOT_SERVER_NAME: 'hotspot.tikspot',
  });
  assert.equal(s.admin.password, null);
  assert.equal(s.containerIp, null);
  assert.equal(s.setupComplete, null);
  assert.equal(s.serverName, 'hotspot.tikspot');
  assert.equal(s.warnings.length, 2);
  assert.ok(s.warnings.every((w) => /placeholder/.test(w) && !w.includes('admin_password]')));
});

test('env: invalid values are ignored with warnings, never thrown', () => {
  const s = spec({
    TIKSPOT_BOOTSTRAP: 'sometimes',
    TIKSPOT_ADMIN_PASSWORD: 'abc',
    TIKSPOT_ROUTER_SCHEME: 'ftp',
    TIKSPOT_ROUTER_HOST: 'http://router',
    TIKSPOT_CONTAINER_IP: '300.1.1.1',
    TIKSPOT_NAS_SECRET: 'short',
    TIKSPOT_LOGIN_METHOD: 'mschap',
    TIKSPOT_AUTOCONFIGURE: 'maybe',
    TIKSPOT_PLUGIN: 'not a valid ref!',
    TIKSPOT_RESTORE_MODE: 'twice',
    TIKSPOT_ADMIN_PASSWORD_FILE: '/missing',
  });
  assert.equal(s.mode, 'seed');
  assert.equal(s.admin.password, null);
  assert.equal(s.router.scheme, null);
  assert.equal(s.router.host, null);
  assert.equal(s.containerIp, null);
  assert.equal(s.nasSecret, null);
  assert.equal(s.loginMethod, null);
  assert.equal(s.autoconfigure, null);
  assert.equal(s.plugin, null);
  assert.equal(s.warnings.length, 10);
  assert.ok(!s.warnings.join(' ').includes('short'), 'secret values are not echoed');
  // CIDR suffix on the container IP is tolerated.
  assert.equal(spec({ TIKSPOT_CONTAINER_IP: '172.18.0.3/24' }).containerIp, '172.18.0.3');
});

// ---------------------------------------------------------------------------
// settings

test('settings: seed fills only unset values; enforce makes env win', () => {
  const db = freshDb();
  setSetting(db, 'portal_title', 'Operator title');
  const env = {
    TIKSPOT_ROUTER_HOST: '192.168.88.1',
    TIKSPOT_ROUTER_USER: 'tikspot-api',
    TIKSPOT_ROUTER_PASSWORD: 'router-pw',
    TIKSPOT_CONTAINER_IP: '172.18.0.3',
    TIKSPOT_SERVER_NAME: 'hotspot.tikspot',
    TIKSPOT_NAS_SECRET: 'a-long-nas-secret',
    TIKSPOT_PORTAL_TITLE: 'Env title',
    TIKSPOT_LOGIN_METHOD: 'chap',
    TIKSPOT_HOTSPOT_PROFILES: 'hsprof1,hsprof2',
  };
  const r = apply(db, env);
  assert.equal(getSetting(db, 'portal_title'), 'Operator title', 'seed does not overwrite');
  assert.equal(getSetting(db, 'router_scheme'), 'https');
  assert.equal(getSetting(db, 'router_host'), '192.168.88.1');
  assert.equal(getSetting(db, 'router_pass'), 'router-pw');
  assert.equal(getSetting(db, 'login_method'), 'chap');
  assert.deepEqual(getJSON(db, 'hotspot_profiles'), ['hsprof1', 'hsprof2']);
  assert.ok(r.applied.includes('router_host') && !r.applied.includes('portal_title'));

  // Operator edits after first boot survive a seed re-run…
  setSetting(db, 'router_host', '10.0.0.1');
  assert.deepEqual(apply(db, env).applied, []);
  assert.equal(getSetting(db, 'router_host'), '10.0.0.1');

  // …but enforce converges to the env.
  const e = apply(db, { ...env, TIKSPOT_BOOTSTRAP: 'enforce' });
  assert.equal(getSetting(db, 'router_host'), '192.168.88.1');
  assert.equal(getSetting(db, 'portal_title'), 'Env title');
  assert.deepEqual(e.applied.sort(), ['portal_title', 'router_host'].sort());

  // Status is stored with names only.
  const st = readBootstrapStatus(db);
  assert.equal(st.mode, 'enforce');
  assert.equal(st.router, null);
  const raw = getSetting(db, 'bootstrap_status');
  for (const secret of ['router-pw', 'a-long-nas-secret']) assert.ok(!raw.includes(secret));
});

test('admin password: seeded + setup_complete; not overwritten in seed; RESET forces it', () => {
  const db = freshDb();
  const r = apply(db, { TIKSPOT_ADMIN_PASSWORD: 'first-password' });
  assert.ok(r.applied.includes('admin_password'));
  assert.ok(verifyPassword('first-password', getSetting(db, 'admin_password_hash')));
  assert.equal(getSetting(db, 'setup_complete'), '1');

  apply(db, { TIKSPOT_ADMIN_PASSWORD: 'second-password' });
  assert.ok(verifyPassword('first-password', getSetting(db, 'admin_password_hash')), 'seed keeps the existing password');

  const hashBefore = getSetting(db, 'admin_password_hash');
  const same = apply(db, { TIKSPOT_ADMIN_PASSWORD: 'first-password', TIKSPOT_ADMIN_PASSWORD_RESET: 'true' });
  assert.ok(!same.applied.includes('admin_password'), 'unchanged password is not re-hashed');
  assert.equal(getSetting(db, 'admin_password_hash'), hashBefore);

  const reset = apply(db, { TIKSPOT_ADMIN_PASSWORD: 'second-password', TIKSPOT_ADMIN_PASSWORD_RESET: '1' });
  assert.ok(reset.applied.includes('admin_password'));
  assert.ok(verifyPassword('second-password', getSetting(db, 'admin_password_hash')));

  // Explicit TIKSPOT_SETUP_COMPLETE=0 keeps the wizard.
  const db2 = freshDb();
  apply(db2, { TIKSPOT_ADMIN_PASSWORD: 'first-password', TIKSPOT_SETUP_COMPLETE: '0' });
  assert.equal(getSetting(db2, 'setup_complete'), '0');
});

// ---------------------------------------------------------------------------
// plugin + design

const rmsEnv = {
  TIKSPOT_PLUGIN: RMS_ID,
  TIKSPOT_PLUGIN_ENABLED: '1',
  TIKSPOT_PLUGIN_SECRET_agentId: '15',
  TIKSPOT_PLUGIN_SECRET_agentPassword: 'agent-pw',
  TIKSPOT_PLUGIN_SECRET_clientId: '54321',
  TIKSPOT_PLUGIN_SECRET_clientPassword: 'client-pw',
  TIKSPOT_PLUGIN_PARAM_baseUrl: 'https://restapi14.rmscloud.com',
  TIKSPOT_PLUGIN_PARAM_propertyId: '1',
};

test('plugin: bundled id is imported once, configured, and idempotent across runs', () => {
  const db = freshDb();
  const r1 = apply(db, rmsEnv);
  assert.deepEqual(r1.warnings, []);
  assert.ok(r1.plugin && r1.plugin.id);
  assert.ok(r1.applied.includes('plugin') && r1.applied.includes('plugin.enabled'));
  const p = getPlugin(db, r1.plugin.id);
  assert.equal(p.enabled, true);
  assert.deepEqual(p.secrets, { agentId: '15', agentPassword: 'agent-pw', clientId: '54321', clientPassword: 'client-pw' });
  assert.equal(p.paramValues.baseUrl, 'https://restapi14.rmscloud.com');
  assert.equal(p.paramValues.propertyId, 1);
  assert.equal(p.paramValues.moduleType, 'GuestServices', 'other params keep their defaults');

  const r2 = apply(db, rmsEnv);
  assert.equal(listPlugins(db).length, 1, 'second run does not duplicate');
  assert.equal(r2.plugin.id, r1.plugin.id);
  assert.ok(!r2.applied.some((a) => a.startsWith('plugin')));

  // Status carries the plugin name/id but never its secrets.
  const raw = getSetting(db, 'bootstrap_status');
  assert.ok(!raw.includes('client-pw') && !raw.includes('agent-pw'));
  assert.deepEqual(readBootstrapStatus(db).plugin, r2.plugin);
});

test('plugin: seed keeps existing secrets/params and enabled state; enforce overwrites; unknown keys warn', () => {
  const db = freshDb();
  const { plugin } = apply(db, { ...rmsEnv, TIKSPOT_PLUGIN_NAME: 'Front desk' });
  assert.equal(plugin.name, 'Front desk');
  // Operator changes things in the UI…
  db.prepare('UPDATE plugins SET enabled = 0 WHERE id = ?').run(plugin.id);

  const changed = { ...rmsEnv, TIKSPOT_PLUGIN_NAME: 'Front desk', TIKSPOT_PLUGIN_SECRET_clientPassword: 'rotated-pw', TIKSPOT_PLUGIN_PARAM_baseUrl: 'https://restapi13.rmscloud.com', TIKSPOT_PLUGIN_SECRET_bogus: 'x' };
  const seed = apply(db, changed);
  let p = getPlugin(db, plugin.id);
  assert.equal(p.secrets.clientPassword, 'client-pw');
  assert.equal(p.paramValues.baseUrl, 'https://restapi14.rmscloud.com');
  assert.equal(p.enabled, false, 'seed does not re-enable a plugin the operator disabled');
  assert.ok(seed.warnings.some((w) => /TIKSPOT_PLUGIN_SECRET_bogus/.test(w)));

  const enf = apply(db, { ...changed, TIKSPOT_BOOTSTRAP: 'enforce' });
  p = getPlugin(db, plugin.id);
  assert.equal(p.secrets.clientPassword, 'rotated-pw');
  assert.equal(p.secrets.agentPassword, 'agent-pw', 'unchanged secrets are kept');
  assert.equal(p.paramValues.baseUrl, 'https://restapi13.rmscloud.com');
  assert.equal(p.enabled, true);
  assert.ok(enf.applied.includes('plugin.secret:clientPassword') && enf.applied.includes('plugin.param:baseUrl'));
  assert.ok(!JSON.stringify(enf).includes('rotated-pw'));
});

test('plugin: a missing bundled id is a warning, not a crash', () => {
  const db = freshDb();
  const r = apply(db, { TIKSPOT_PLUGIN: 'no-such-recipe' });
  assert.equal(r.plugin, null);
  assert.ok(r.warnings.some((w) => /no-such-recipe/.test(w)));
});

function loginBlocks(db) {
  return designModel(getActiveDesign(db)).blocks;
}

test('design attach: inserts a plugin-login before the first login block, once', () => {
  const db = freshDb();
  const v0 = getActiveDesign(db).version;
  const { plugin } = apply(db, { ...rmsEnv, TIKSPOT_PLUGIN_ATTACH: '1' });
  const blocks = loginBlocks(db);
  const idx = blocks.findIndex((b) => b.type === 'plugin-login');
  assert.ok(idx >= 0);
  assert.equal(blocks[idx].props.pluginId, String(plugin.id));
  assert.equal(blocks[idx].props.label, 'Continue');
  assert.ok(idx < blocks.findIndex((b) => b.id === 'b-free'));
  const v1 = getActiveDesign(db).version;
  assert.equal(v1, v0 + 1);

  apply(db, { ...rmsEnv, TIKSPOT_PLUGIN_ATTACH: '1' });
  assert.equal(loginBlocks(db).filter((b) => b.type === 'plugin-login').length, 1);
  assert.equal(getActiveDesign(db).version, v1, 'no re-publish when nothing changed');
});

test('design attach: fills an empty pluginId (published + draft), leaves a pointed block alone', () => {
  const db = freshDb();
  const row = getActiveDesign(db);
  const model = designModel(row);
  model.blocks.unshift({ id: 'b-pl', type: 'plugin-login', props: { label: 'Guests', pluginId: '', intro: '' } });
  // Publish with an empty plugin-login, and keep an unpublished draft too.
  db.prepare('UPDATE designs SET grapes_json = ? WHERE id = ?').run(JSON.stringify(model), row.id);
  saveDraft(db, row.id, model);

  const { plugin } = apply(db, { ...rmsEnv, TIKSPOT_PLUGIN_ATTACH: 'true' });
  const after = getActiveDesign(db);
  const pub = designModel(after).blocks.find((b) => b.id === 'b-pl');
  assert.equal(pub.props.pluginId, String(plugin.id));
  assert.equal(pub.props.label, 'Guests');
  const draft = draftModel(after);
  assert.ok(draft, 'draft survives the publish');
  assert.equal(draft.blocks.find((b) => b.id === 'b-pl').props.pluginId, String(plugin.id));

  // A block already pointing at a different, real plugin is left alone.
  const other = createPlugin(db, {
    name: 'Other',
    request: { method: 'GET', url: 'http://example.com/guests?room={{input.room}}', contentType: 'json' },
    parse: { type: 'json', root: 'guests', fields: { room: 'room' }, dateFormat: 'iso' },
    match: { all: true, rules: [{ input: 'room', field: 'room', normalize: 'trim' }] },
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
  });
  assert.ok(other.ok, JSON.stringify(other));
  const m2 = designModel(after);
  m2.blocks.find((b) => b.id === 'b-pl').props.pluginId = String(other.id);
  db.prepare('UPDATE designs SET grapes_json = ?, draft_json = NULL WHERE id = ?').run(JSON.stringify(m2), row.id);
  const res = attachPluginToActiveDesign(db, plugin.id);
  assert.equal(res.changed, false);
  assert.equal(designModel(getActiveDesign(db)).blocks.find((b) => b.id === 'b-pl').props.pluginId, String(other.id));
});

// ---------------------------------------------------------------------------
// restore from file

async function makeBackupZip(dir, { adminHash = null, title = 'Restored title' } = {}) {
  const dbFile = path.join(dir, `src-${Math.random().toString(36).slice(2)}.db`);
  const src = new Database(dbFile);
  migrate(src);
  setSetting(src, 'portal_title', title);
  if (adminHash) setSetting(src, 'admin_password_hash', adminHash);
  src.close();
  const zip = new JSZip();
  zip.file('tikspot.db', fs.readFileSync(dbFile));
  zip.file('tikspot-backup.json', JSON.stringify({ format: 'tikspot-backup', version: '0.16.2' }));
  zip.file('assets/logo.png', Buffer.from('png'));
  const zipPath = path.join(dir, 'backup.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
  return zipPath;
}

function readTitle(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try { return getSetting(db, 'portal_title'); } finally { db.close(); }
}

test('restore: fresh mode restores into a missing/unconfigured DB only, and not twice', async () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const dbPath = path.join(dataDir, 'tikspot.db');
  const assetsDir = path.join(dataDir, 'assets');
  const zipPath = await makeBackupZip(dir);
  const opts = { log: quietLog, dbPath, dataDir, assetsDir };
  const stagePath = path.join(dataDir, 'tikspot.db.restore');

  // No live DB -> restore.
  const s1 = spec({ TIKSPOT_RESTORE_FILE: zipPath });
  const r1 = await maybeRestoreFromFile(s1, opts);
  assert.equal(r1.restored, true);
  assert.equal(r1.assets_restored, 1);
  assert.ok(fs.existsSync(path.join(assetsDir, 'logo.png')));
  assert.ok(promoteStagedRestore({ dbPath, stagePath }));
  assert.equal(readTitle(dbPath), 'Restored title');

  // The restored DB is redacted (no admin hash), but the same file is not
  // re-applied on the next boot.
  const r2 = await maybeRestoreFromFile(spec({ TIKSPOT_RESTORE_FILE: zipPath }), opts);
  assert.equal(r2.restored, false);

  // A configured live DB is never overwritten in fresh mode, even by a new file.
  const live = new Database(dbPath);
  setSetting(live, 'admin_password_hash', hashPassword('secret-pw'));
  live.close();
  const zip2 = await makeBackupZip(fs.mkdtempSync(path.join(dir, 'b')), { title: 'Other' });
  const r3 = await maybeRestoreFromFile(spec({ TIKSPOT_RESTORE_FILE: zip2 }), opts);
  assert.equal(r3.restored, false);
  assert.equal(r3.reason, 'live DB already configured');

  // Missing file -> warning, continue.
  const s4 = spec({ TIKSPOT_RESTORE_FILE: path.join(dir, 'nope.zip') });
  const r4 = await maybeRestoreFromFile(s4, opts);
  assert.equal(r4.restored, false);
  assert.ok(s4.warnings.some((w) => /not found/.test(w)));

  // Not a zip -> warning, continue.
  const bad = path.join(dir, 'bad.zip');
  fs.writeFileSync(bad, 'not a zip');
  fs.rmSync(dbPath);
  const s5 = spec({ TIKSPOT_RESTORE_FILE: bad });
  assert.equal((await maybeRestoreFromFile(s5, opts)).restored, false);
  assert.ok(s5.warnings.some((w) => /not a valid zip/.test(w)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore: once mode applies once per file content, even over a configured DB', async () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const dbPath = path.join(dataDir, 'tikspot.db');
  const stagePath = path.join(dataDir, 'tikspot.db.restore');
  const opts = { log: quietLog, dbPath, dataDir, assetsDir: path.join(dataDir, 'assets') };
  const live = new Database(dbPath);
  migrate(live);
  setSetting(live, 'admin_password_hash', hashPassword('secret-pw'));
  live.close();

  const zipPath = await makeBackupZip(dir, { title: 'Once' });
  const env = { TIKSPOT_RESTORE_FILE: zipPath, TIKSPOT_RESTORE_MODE: 'once' };
  assert.equal((await maybeRestoreFromFile(spec(env), opts)).restored, true);
  promoteStagedRestore({ dbPath, stagePath });
  assert.equal(readTitle(dbPath), 'Once');
  assert.equal((await maybeRestoreFromFile(spec(env), opts)).restored, false);
  assert.ok(!fs.existsSync(stagePath));

  // A different file is applied again.
  const zip2 = await makeBackupZip(fs.mkdtempSync(path.join(dir, 'b')), { title: 'Twice' });
  assert.equal((await maybeRestoreFromFile(spec({ ...env, TIKSPOT_RESTORE_FILE: zip2 }), opts)).restored, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// RouterOS hotspot provisioning (in-memory stub)

function memRouter(initial = {}) {
  const menus = JSON.parse(JSON.stringify(initial));
  let seq = 100;
  const calls = [];
  return {
    menus,
    calls,
    list: async (menu) => {
      calls.push(['GET', menu]);
      return menus[menu] ?? [];
    },
    add: async (menu, obj) => {
      calls.push(['PUT', menu, obj]);
      const row = { '.id': `*${seq++}`, ...obj };
      (menus[menu] ||= []).push(row);
      return row;
    },
    patch: async (menu, id, obj) => {
      calls.push(['PATCH', menu, id, obj]);
      const row = (menus[menu] || []).find((r) => r['.id'] === id);
      if (!row) throw Object.assign(new Error('no such item'), { status: 404 });
      Object.assign(row, obj);
      return row;
    },
    call: async (method, p, body) => {
      calls.push([method, p, body]);
      if (method === 'PATCH' && !Array.isArray(menus[p])) menus[p] = { ...(menus[p] || {}), ...body };
      return { status: 'finished' };
    },
  };
}

const baseMenus = () => ({
  '/ip/address': [
    { '.id': '*1', address: '192.168.88.1/24', interface: 'bridge-lan' },
    { '.id': '*2', address: '10.5.50.1/24', interface: 'bridge-hs' },
  ],
  '/ip/hotspot/profile': [{ '.id': '*p0', name: 'default', 'use-radius': 'no', 'login-by': 'cookie,http-chap' }],
  '/ip/hotspot': [],
  '/ip/dhcp-server/network': [{ '.id': '*n1', address: '10.5.50.0/24', gateway: '10.5.50.1', 'dns-server': '' }],
  '/radius': [],
  '/radius/incoming': { accept: 'no', port: '1700' },
  '/ip/dns': { 'allow-remote-requests': 'no' },
});

test('ensureHotspotProfile: creates with RADIUS + interface address, updates by name, refuses dns-name == server host', async () => {
  const r = memRouter(baseMenus());
  const res = await ensureHotspotProfile(r, { name: 'tikspot', interface: 'bridge-hs', dnsName: 'login.wifi' });
  assert.equal(res.created, 'tikspot');
  const prof = r.menus['/ip/hotspot/profile'].find((p) => p.name === 'tikspot');
  assert.equal(prof['hotspot-address'], '10.5.50.1');
  assert.equal(prof['use-radius'], 'yes');
  assert.equal(prof['radius-accounting'], 'yes');
  assert.equal(prof['login-by'], 'mac-cookie,http-chap,http-pap,mac');
  assert.equal(prof['dns-name'], 'login.wifi');
  assert.equal(prof.comment, undefined, 'profiles have no comment field on RouterOS');

  const again = await ensureHotspotProfile(r, { name: 'tikspot', interface: 'bridge-hs' });
  assert.equal(again.updated, 'tikspot');
  assert.equal(r.menus['/ip/hotspot/profile'].filter((p) => p.name === 'tikspot').length, 1);

  await assert.rejects(
    ensureHotspotProfile(r, { name: 'tikspot', interface: 'bridge-hs', dnsName: 'Hotspot.Tikspot', serverHost: 'hotspot.tikspot' }),
    /must differ from the server-name/,
  );
  await assert.rejects(ensureHotspotProfile(r, { name: 'x', interface: 'ether9' }), /no IPv4 address on interface ether9/);
});

test('ensureHotspotServer: adds a server named after the host, or patches the one on that interface', async () => {
  const r = memRouter(baseMenus());
  const a = await ensureHotspotServer(r, { name: 'hotspot.tikspot', interface: 'bridge-hs', profile: 'tikspot' });
  assert.equal(a.created, 'hotspot.tikspot');
  const srv = r.menus['/ip/hotspot'][0];
  assert.deepEqual(
    { name: srv.name, interface: srv.interface, profile: srv.profile, disabled: srv.disabled, comment: srv.comment },
    { name: 'hotspot.tikspot', interface: 'bridge-hs', profile: 'tikspot', disabled: 'no', comment: MANAGED_COMMENT },
  );

  const r2 = memRouter({ ...baseMenus(), '/ip/hotspot': [{ '.id': '*h1', name: 'hotspot1', interface: 'bridge-hs', profile: 'hsprof1', comment: 'ops' }] });
  const b = await ensureHotspotServer(r2, { name: 'hotspot.tikspot', interface: 'bridge-hs', profile: 'tikspot' });
  assert.equal(b.updated, 'hotspot.tikspot');
  assert.equal(r2.menus['/ip/hotspot'].length, 1);
  assert.equal(r2.menus['/ip/hotspot'][0].name, 'hotspot.tikspot');
  assert.equal(r2.menus['/ip/hotspot'][0].comment, `ops | ${MANAGED_COMMENT}`);
});

test('ensureDhcpDns: fills an empty dns-server, keeps a set one, skips when no network', async () => {
  const r = memRouter(baseMenus());
  const a = await ensureDhcpDns(r, { interface: 'bridge-hs' });
  assert.equal(r.menus['/ip/dhcp-server/network'][0]['dns-server'], '10.5.50.1');
  assert.equal(a.updated, '10.5.50.0/24');
  const b = await ensureDhcpDns(r, { interface: 'bridge-hs' });
  assert.match(b.detail, /already has dns-server/);

  const r2 = memRouter({ ...baseMenus(), '/ip/dhcp-server/network': [] });
  const c = await ensureDhcpDns(r2, { interface: 'bridge-hs' });
  assert.equal(c.status, 'skipped');
  assert.ok(!r2.calls.some(([m, p]) => m === 'PUT' && p.startsWith('/ip/dhcp-server')), 'never creates DHCP config');
});

test('autoConfigure with hotspot: provisions profile + server + DHCP DNS, and verifyConfig passes the server-name check', async () => {
  const r = memRouter(baseMenus());
  const res = await autoConfigure(r, {
    containerIp: '172.18.0.3',
    nasSecret: 'a-long-nas-secret',
    serverHost: 'hotspot.tikspot',
    profiles: null,
    hotspot: { interface: 'bridge-hs', profileName: 'tikspot', dnsName: null },
  });
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  assert.deepEqual(res.steps.map((s) => s.step), [
    'radius-client', 'radius-incoming', 'hotspot-profile-ensure', 'hotspot-profile', 'hotspot-server',
    'dns-static', 'dns-remote-requests', 'dhcp-dns', 'walled-garden',
  ]);
  assert.equal(r.menus['/ip/hotspot'][0].name, 'hotspot.tikspot');

  const v = await verifyConfig(r, { containerIp: '172.18.0.3', serverHost: 'hotspot.tikspot' });
  const c = v.checks.find((x) => x.id === 'hotspot-server-name');
  assert.equal(c.status, 'pass');
  assert.equal(c.required, true);

  // A mis-named server fails the check with an explanation.
  r.menus['/ip/hotspot'][0].name = 'hotspot1';
  const v2 = await verifyConfig(r, { containerIp: '172.18.0.3', serverHost: 'hotspot.tikspot' });
  const c2 = v2.checks.find((x) => x.id === 'hotspot-server-name');
  assert.equal(c2.status, 'fail');
  assert.match(c2.hint, /\$\(server-name\)/);

  // dns-name == server host: that step fails as config (not "unreachable").
  const r3 = memRouter(baseMenus());
  const bad = await autoConfigure(r3, {
    containerIp: '172.18.0.3', nasSecret: 'a-long-nas-secret', serverHost: 'hotspot.tikspot',
    hotspot: { interface: 'bridge-hs', dnsName: 'hotspot.tikspot' },
  });
  assert.equal(bad.ok, false);
  assert.ok(!bad.unreachable);
  assert.equal(bad.steps.find((s) => s.step === 'hotspot-profile-ensure').status, 'failed');
  assert.equal(bad.steps.find((s) => s.step === 'walled-garden').status, 'done');
});

// ---------------------------------------------------------------------------
// router bootstrap

function routerDb(extraEnv = {}) {
  const db = freshDb();
  const env = {
    TIKSPOT_ROUTER_HOST: '192.168.88.1',
    TIKSPOT_ROUTER_PASSWORD: 'router-pw',
    TIKSPOT_CONTAINER_IP: '172.18.0.3',
    TIKSPOT_SERVER_NAME: 'hotspot.tikspot',
    TIKSPOT_NAS_SECRET: 'a-long-nas-secret',
    TIKSPOT_AUTOCONFIGURE: '1',
    TIKSPOT_HOTSPOT_INTERFACE: 'bridge-hs',
    ...extraEnv,
  };
  const s = readBootstrapEnv(env);
  applyBootstrap(db, s, { log: quietLog });
  return { db, spec: s };
}

const noNas = async () => ({ wrote: false, reloaded: false, degraded: false });
const zeroDelays = [0, 0, 0, 0];
const silentEvents = () => {};

test('router bootstrap: runs once, records status + signature, skips when unchanged, re-runs on always', async () => {
  const { db, spec: s } = routerDb();
  let made = 0;
  const r = memRouter(baseMenus());
  const opts = { log: quietLog, logEvent: silentEvents, delays: zeroDelays, applyNas: noNas, makeRouter: () => { made++; return r; } };

  const out = await startRouterBootstrap(db, s, opts);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.attempts, 1);
  assert.ok(getSetting(db, SIG_KEY));
  assert.equal(getSetting(db, 'router_configured'), '1');
  const st = readBootstrapStatus(db);
  assert.equal(st.router.ok, true);
  assert.ok(st.router.steps.every((x) => x.step && x.status && Object.keys(x).length === 2));
  assert.ok(!getSetting(db, 'bootstrap_status').includes('router-pw'));
  assert.ok(!getSetting(db, SIG_KEY).includes('router-pw'));

  const putsBefore = r.calls.length;
  const again = await startRouterBootstrap(db, s, opts);
  assert.equal(again.skipped, true);
  assert.equal(r.calls.length, putsBefore, 'no router traffic when the signature matches');

  // A changed input re-runs.
  setSetting(db, 'server_name', 'portal.tikspot');
  const changed = await startRouterBootstrap(db, s, opts);
  assert.ok(!changed.skipped);

  const always = await startRouterBootstrap(db, { ...s, autoconfigure: 'always' }, opts);
  assert.ok(!always.skipped && always.ok);
});

test('router bootstrap: retries while unreachable, then succeeds', async () => {
  const { db, spec: s } = routerDb();
  const good = memRouter(baseMenus());
  let attempt = 0;
  const flaky = {
    list: async (m) => {
      if (attempt < 2) throw new Error('connect ECONNREFUSED'); // no .status => unreachable
      return good.list(m);
    },
    add: (...a) => good.add(...a),
    patch: (...a) => good.patch(...a),
    call: (...a) => good.call(...a),
  };
  const out = await startRouterBootstrap(db, s, {
    log: quietLog,
    logEvent: silentEvents,
    delays: zeroDelays,
    applyNas: async (d) => { attempt++; return noNas(d); },
    makeRouter: () => flaky,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.attempts, 3);
  assert.ok(getSetting(db, SIG_KEY));
});

test('router bootstrap: gives up after the delays, never throws, and leaves no signature', async () => {
  const { db, spec: s } = routerDb();
  const dead = { list: async () => { throw new Error('timeout'); }, add: async () => ({}), patch: async () => ({}), call: async () => { throw new Error('timeout'); } };
  const events = [];
  const out = await startRouterBootstrap(db, s, {
    log: quietLog,
    logEvent: (...a) => events.push(a),
    delays: [0, 0],
    applyNas: noNas,
    makeRouter: () => dead,
  });
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 2);
  assert.equal(getSetting(db, SIG_KEY), null);
  assert.equal(readBootstrapStatus(db).router.ok, false);
  assert.equal(events[0][1], 'warn');
});

test('router bootstrap: URL plugin is fetched via the catalog helper and attached', async () => {
  const db = freshDb();
  const recipe = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, `${RMS_ID}.json`), 'utf8')).recipe;
  const s = readBootstrapEnv({
    TIKSPOT_PLUGIN: 'https://example.com/plugins/rms.json',
    TIKSPOT_PLUGIN_SECRET_clientId: '54321',
    TIKSPOT_PLUGIN_ATTACH: '1',
  });
  const boot = applyBootstrap(db, s, { log: quietLog });
  assert.equal(boot.plugin, null, 'URL sources are deferred to the router phase');
  const urls = [];
  await startRouterBootstrap(db, s, {
    log: quietLog,
    logEvent: silentEvents,
    delays: [0],
    fetchRecipe: async (u) => { urls.push(u); return { ok: true, recipe, fetchUrl: u }; },
  });
  assert.deepEqual(urls, ['https://example.com/plugins/rms.json']);
  const p = listPlugins(db).find((x) => x.name === recipe.name);
  assert.ok(p);
  assert.equal(getPlugin(db, p.id).secrets.clientId, '54321');
  assert.equal(getPluginPublic(db, p.id).enabled, false);
  assert.ok(loginBlocks(db).some((b) => b.type === 'plugin-login' && b.props.pluginId === String(p.id)));
  assert.deepEqual(readBootstrapStatus(db).plugin, { name: p.name, id: p.id });
});
