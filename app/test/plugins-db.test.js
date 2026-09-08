// DB-backed tests for guest-lookup plugins (Stage 0.13-B/C):
// app/src/plugins/{store,grants}.js and the POST /portal/lookup/:id route.
// Uses a fresh in-memory better-sqlite3 DB (migrated) per test, plus a tiny
// local node:http stub standing in for a hotel guest API.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import Database from 'better-sqlite3';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';

import { migrate } from '../src/db/migrate.js';
import {
  listPlugins,
  getPlugin,
  getPluginPublic,
  getPluginSecretsMeta,
  createPlugin,
  updatePlugin,
  exportPlugin,
} from '../src/plugins/store.js';
import { grantGuest, sweepPluginGrants, listActiveGrants } from '../src/plugins/grants.js';
import portalRoutes from '../src/portal/routes.js';
import pluginRoutes from '../src/admin/plugins.js';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function baseBody(overrides = {}) {
  return {
    name: 'Hotel A',
    request: { method: 'GET', url: 'http://example.com/guests?room={{input.room}}', contentType: 'json' },
    parse: { type: 'json', root: 'guests', fields: { firstName: 'firstName', lastName: 'lastName', room: 'room' }, dateFormat: 'iso' },
    match: {
      all: true,
      rules: [
        { input: 'room', field: 'room', normalize: 'trim' },
        { input: 'name', anyOf: ['firstName', 'lastName'], normalize: 'name' },
      ],
    },
    inputs: [
      { name: 'room', label: 'Room', type: 'text', required: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
    ],
    secrets: { username: '', password: '', apiKey: '' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// plugins/store.js

test('store: create/read round-trip — secrets blanked on public reads, merged for the engine', () => {
  const db = freshDb();
  const created = createPlugin(db, baseBody({ secrets: { username: 'u1', password: 'p1', apiKey: '' } }));
  assert.equal(created.ok, true, JSON.stringify(created.fields));
  const id = created.id;

  const pub = getPluginPublic(db, id);
  assert.deepEqual(pub.secrets, { username: '', password: '', apiKey: '' });
  assert.equal(pub.name, 'Hotel A');
  assert.equal(pub.id, id);

  const full = getPlugin(db, id);
  assert.equal(full.secrets.username, 'u1');
  assert.equal(full.secrets.password, 'p1');
  assert.equal(full.id, id);

  const list = listPlugins(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].name, 'Hotel A');
  assert.equal(list[0].inputs.length, 2);
  assert.equal(JSON.stringify(list).includes('u1'), false, 'listPlugins must never include secret values');

  const bundle = exportPlugin(db, id);
  assert.equal(bundle.format, 'tikspot-plugin');
  assert.equal(bundle.version, 1);
  assert.deepEqual(bundle.recipe.secrets, { username: '', password: '', apiKey: '' });
  assert.equal('id' in bundle.recipe, false, 'exported recipe should not carry the DB id');

  const meta = getPluginSecretsMeta(db, id);
  assert.deepEqual(meta, { username: true, password: true, apiKey: false });
});

test('store: update — secrets are write-only (absent/empty keeps the stored value, a real value overwrites)', () => {
  const db = freshDb();
  const created = createPlugin(db, baseBody({ secrets: { username: 'orig-user', password: 'orig-pass', apiKey: '' } }));
  const id = created.id;

  // No `secrets` key at all in the update — stays untouched.
  const upd1 = updatePlugin(db, id, { name: 'Hotel B' });
  assert.equal(upd1.ok, true, JSON.stringify(upd1.fields));
  assert.equal(getPluginPublic(db, id).name, 'Hotel B');
  assert.equal(getPlugin(db, id).secrets.username, 'orig-user');

  // Explicit empty-string secrets — still must not clobber the stored ones.
  const upd2 = updatePlugin(db, id, { secrets: { username: '', password: '', apiKey: '' } });
  assert.equal(upd2.ok, true);
  assert.equal(getPlugin(db, id).secrets.username, 'orig-user');
  assert.equal(getPlugin(db, id).secrets.password, 'orig-pass');

  // A real new value overwrites just that field; the other stays.
  const upd3 = updatePlugin(db, id, { secrets: { username: 'new-user' } });
  assert.equal(upd3.ok, true);
  assert.equal(getPlugin(db, id).secrets.username, 'new-user');
  assert.equal(getPlugin(db, id).secrets.password, 'orig-pass');
});

test('store: update without `enabled` keeps the plugin\'s current enabled state', () => {
  const db = freshDb();
  const created = createPlugin(db, baseBody({ enabled: false }));
  const id = created.id;
  assert.equal(getPluginPublic(db, id).enabled, false);
  const upd = updatePlugin(db, id, { name: 'Renamed' });
  assert.equal(upd.ok, true);
  assert.equal(getPluginPublic(db, id).enabled, false, 'enabled must not silently reset to true on partial update');
});

test('store: updatePlugin on a missing id reports notFound', () => {
  const db = freshDb();
  const result = updatePlugin(db, 999, { name: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
});

test('store: createPlugin surfaces validateRecipe field errors', () => {
  const db = freshDb();
  const result = createPlugin(db, { name: '' });
  assert.equal(result.ok, false);
  assert.ok(result.fields);
});

// ---------------------------------------------------------------------------
// plugins/grants.js

test('grants: grantGuest mints a radcheck/radusergroup RADIUS user; sweepPluginGrants removes it after expiry', () => {
  const db = freshDb();
  const created = createPlugin(db, baseBody());
  const plugin = { id: created.id, planGroup: 'free', window: { maxGrantHours: 168 } };
  const grant = grantGuest(db, {
    plugin,
    guest: { label: 'Ann Lee · room 101' },
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    mac: 'AA:BB:CC:DD:EE:FF',
    ip: '10.5.50.5',
    inputs: [{ name: 'room', value: '101', required: true }],
  });

  assert.match(grant.username, /^pg-[A-Z0-9]{6}$/);
  assert.equal(grant.password.length, 12);

  const check = db.prepare("SELECT * FROM radcheck WHERE username = ? AND attribute = 'Cleartext-Password'").get(grant.username);
  assert.ok(check);
  assert.equal(check.value, grant.password);
  const grp = db.prepare('SELECT * FROM radusergroup WHERE username = ?').get(grant.username);
  assert.equal(grp.groupname, 'free');

  const active = listActiveGrants(db);
  assert.equal(active.length, 1);
  assert.equal(active[0].username, grant.username);
  assert.equal(active[0].guest_label, 'Ann Lee · room 101');

  db.prepare("UPDATE plugin_grants SET expires_at = datetime('now','-1 hour') WHERE username = ?").run(grant.username);
  const removed = sweepPluginGrants(db);
  assert.equal(removed, 1);
  assert.equal(db.prepare('SELECT * FROM radcheck WHERE username = ?').get(grant.username), undefined);
  assert.equal(listActiveGrants(db).length, 0);
});

test('grants: a maxGrantHours safety cap wins even if the engine hands back a further-out expiresAt', () => {
  const db = freshDb();
  const created = createPlugin(db, baseBody());
  const plugin = { id: created.id, planGroup: 'free', window: { maxGrantHours: 1 } };
  const farFuture = new Date(Date.now() + 100 * 3600_000).toISOString();
  const grant = grantGuest(db, { plugin, guest: { label: 'X' }, expiresAt: farFuture, inputs: [] });
  const capMs = Date.now() + 1 * 3600_000;
  assert.ok(Date.parse(grant.expiresAt) <= capMs + 2000, 'expiresAt should be capped near now+maxGrantHours');
});

// ---------------------------------------------------------------------------
// Integration: POST /portal/lookup/:id against a local guest-API stub.

let guestServer;
let guestBaseUrl;

before(async () => {
  guestServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ guests: [{ firstName: 'Ann', lastName: 'Lee', room: '101' }] }));
  });
  await new Promise((resolve) => guestServer.listen(0, '127.0.0.1', resolve));
  guestBaseUrl = `http://127.0.0.1:${guestServer.address().port}`;
});

after(() => {
  guestServer.close();
});

async function buildApp(db) {
  const app = Fastify();
  app.decorate('db', db);
  await app.register(formbody);
  await app.register(cookie, { secret: 'test-only-secret-not-for-production' });
  await app.register(pluginRoutes);
  await app.register(portalRoutes);
  return app;
}

test('POST /portal/lookup/:id: a matching guest gets a "Connecting…" auto-submit page with a pg- credential', async () => {
  const db = freshDb();
  const created = createPlugin(
    db,
    baseBody({ request: { method: 'GET', url: `${guestBaseUrl}/guests?room={{input.room}}`, contentType: 'json' } }),
  );
  const app = await buildApp(db);
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/portal/lookup/${created.id}`,
      remoteAddress: '10.0.0.1',
      payload: { 'link-login': 'http://10.5.50.1/login', mac: 'AA:BB:CC:DD:EE:01', in_room: '101', in_name: 'Lee' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-tk-autosubmit/);
    assert.match(res.body, /pg-[A-Z0-9]{6}/);

    const grants = listActiveGrants(db);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].mac, 'AA:BB:CC:DD:EE:01');
  } finally {
    await app.close();
  }
});

test('POST /portal/lookup/:id: a non-matching guest re-renders the login page with the noMatch message', async () => {
  const db = freshDb();
  const created = createPlugin(
    db,
    baseBody({ request: { method: 'GET', url: `${guestBaseUrl}/guests?room={{input.room}}`, contentType: 'json' } }),
  );
  const app = await buildApp(db);
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/portal/lookup/${created.id}`,
      remoteAddress: '10.0.0.2',
      payload: { 'link-login': 'http://10.5.50.1/login', mac: 'AA:BB:CC:DD:EE:02', in_room: '101', in_name: 'Nobody' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /We could not find a booking with those details\./);
    assert.doesNotMatch(res.body, /data-tk-autosubmit/);
  } finally {
    await app.close();
  }
});

test('POST /portal/lookup/:id: the 11th attempt from the same IP/MAC in 5 minutes is rate-limited (429)', async () => {
  const db = freshDb();
  const created = createPlugin(
    db,
    baseBody({ request: { method: 'GET', url: `${guestBaseUrl}/guests?room={{input.room}}`, contentType: 'json' } }),
  );
  const app = await buildApp(db);
  try {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({
        method: 'POST',
        url: `/portal/lookup/${created.id}`,
        remoteAddress: '10.0.0.3',
        payload: { 'link-login': 'http://10.5.50.1/login', mac: 'AA:BB:CC:DD:EE:03', in_room: '999', in_name: 'Nobody' },
      });
    }
    assert.equal(last.statusCode, 429);
    assert.match(last.body, /Too many attempts/);
  } finally {
    await app.close();
  }
});

test('GET /portal/lookup/:id redirects to /login', async () => {
  const db = freshDb();
  const app = await buildApp(db);
  try {
    const res = await app.inject({ method: 'GET', url: '/portal/lookup/1' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await app.close();
  }
});
