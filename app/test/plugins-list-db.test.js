// DB-backed tests for the 0.16 built-in guest-list source
// (app/src/plugins/store.js's plugin_list_rows helpers, the admin
// /api/plugins/:id/list routes, export/import with listRows, and cascade
// delete) — follows test/plugins-db.test.js's conventions (fresh in-memory
// better-sqlite3 DB per test, migrated).
//
// NOTE: `migrate(db)` on a bare `new Database(':memory:')` does NOT turn
// foreign keys on (that's openDb()'s job in production — see
// app/src/db/index.js) — SQLite defaults `PRAGMA foreign_keys` to OFF per
// connection. Tests exercising the plugin_list_rows ON DELETE CASCADE must
// enable it explicitly to mirror the real app; forgetting this makes the
// cascade look broken (or silently "pass" without ever exercising it).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';

import { migrate } from '../src/db/migrate.js';
import { createPlugin, updatePlugin, getPluginPublic, exportPlugin, importPlugin, replaceListRows, listRows, countListRows, deletePlugin } from '../src/plugins/store.js';
import pluginRoutes from '../src/admin/plugins.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // mirror app/src/db/index.js's openDb()
  migrate(db);
  return db;
}

function listBody(overrides = {}) {
  return {
    name: 'Front Desk List',
    source: 'list',
    match: { all: true, rules: [{ input: 'room', field: 'room', normalize: 'trim' }] },
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
    ...overrides,
  };
}

async function buildApp(db) {
  const app = Fastify();
  app.decorate('db', db);
  await app.register(formbody);
  await app.register(cookie, { secret: 'test-only-secret-not-for-production' });
  await app.register(pluginRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// store.js: replaceListRows / listRows / countListRows

test('store: replaceListRows/listRows/countListRows round-trip, coercing values to strings', () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  assert.equal(created.ok, true, JSON.stringify(created.fields));
  const id = created.id;

  assert.equal(countListRows(db, id), 0);
  const result = replaceListRows(db, id, [
    { room: 101, lastName: 'Smith' },
    { room: '102', lastName: 'Jones' },
  ]);
  assert.equal(result.count, 2);
  assert.equal(countListRows(db, id), 2);

  const { count, rows } = listRows(db, id);
  assert.equal(count, 2);
  assert.deepEqual(rows, [
    { room: '101', lastName: 'Smith' },
    { room: '102', lastName: 'Jones' },
  ]);
});

test('store: replaceListRows replaces wholesale (old rows are gone) and caps at 5000', () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  const id = created.id;

  replaceListRows(db, id, [{ room: '1' }, { room: '2' }, { room: '3' }]);
  assert.equal(countListRows(db, id), 3);

  replaceListRows(db, id, [{ room: 'only-one' }]);
  assert.equal(countListRows(db, id), 1);
  assert.deepEqual(listRows(db, id).rows, [{ room: 'only-one' }]);

  const many = Array.from({ length: 5010 }, (_, i) => ({ room: String(i) }));
  const capped = replaceListRows(db, id, many);
  assert.equal(capped.count, 5000);
  assert.equal(countListRows(db, id), 5000);
});

test('store: listRows({limit}) caps the returned rows but not the reported count', () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  const id = created.id;
  replaceListRows(db, id, [{ room: '1' }, { room: '2' }, { room: '3' }]);
  const { count, rows } = listRows(db, id, { limit: 2 });
  assert.equal(count, 3);
  assert.equal(rows.length, 2);
});

test('store: deleting a plugin cascades to plugin_list_rows (ON DELETE CASCADE)', () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  const id = created.id;
  replaceListRows(db, id, [{ room: '101' }, { room: '102' }]);
  assert.equal(countListRows(db, id), 2);

  const ok = deletePlugin(db, id);
  assert.equal(ok, true);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM plugin_list_rows WHERE plugin_id = ?').get(id).n,
    0,
    'plugin_list_rows rows must be gone once the owning plugin is deleted',
  );
});

test('store: updatePlugin flips source http -> list without resurrecting the stored request/auth/steps', () => {
  const db = freshDb();
  const created = createPlugin(db, {
    name: 'Was HTTP',
    request: { method: 'GET', url: 'http://example.com/guests?room={{input.room}}', contentType: 'json' },
    parse: { type: 'json', root: 'guests', fields: { room: 'room' } },
    match: { all: true, rules: [{ input: 'room', field: 'room' }] },
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
  });
  assert.equal(created.ok, true, JSON.stringify(created.fields));
  const id = created.id;

  const flipped = updatePlugin(db, id, { source: 'list' });
  assert.equal(flipped.ok, true, JSON.stringify(flipped.fields));
  const recipe = getPluginPublic(db, id);
  assert.equal(recipe.source, 'list');
  assert.equal('request' in recipe, false);
  assert.equal('auth' in recipe, false);
  assert.equal('steps' in recipe, false);
});

// ---------------------------------------------------------------------------
// store.js: export/import with listRows

test('store: exportPlugin omits listRows by default and includes them only with includeRows:true', () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  const id = created.id;
  replaceListRows(db, id, [{ room: '101' }]);

  const plain = exportPlugin(db, id);
  assert.equal('listRows' in plain, false);

  const withRows = exportPlugin(db, id, { includeRows: true });
  assert.deepEqual(withRows.listRows, [{ room: '101' }]);
});

test('store: exportPlugin({includeRows:true}) on a non-list plugin never adds listRows', () => {
  const db = freshDb();
  const created = createPlugin(db, {
    name: 'HTTP one',
    request: { method: 'GET', url: 'http://example.com/g', contentType: 'json' },
    parse: { type: 'json', root: 'guests', fields: { room: 'room' } },
    match: { all: true, rules: [{ input: 'room', field: 'room' }] },
    inputs: [{ name: 'room', label: 'Room', type: 'text', required: true }],
  });
  const bundle = exportPlugin(db, created.id, { includeRows: true });
  assert.equal('listRows' in bundle, false);
});

test('store: importPlugin stores listRows when present in the bundle', () => {
  const db = freshDb();
  const bundle = { format: 'tikspot-plugin', version: 1, recipe: listBody(), listRows: [{ room: '201' }, { room: '202' }] };
  const result = importPlugin(db, bundle);
  assert.equal(result.ok, true, JSON.stringify(result.fields));
  assert.equal(countListRows(db, result.id), 2);
  assert.deepEqual(listRows(db, result.id).rows, [{ room: '201' }, { room: '202' }]);
});

// ---------------------------------------------------------------------------
// admin/plugins.js: GET/PUT/DELETE /api/plugins/:id/list

test('GET /api/plugins/:id/list: count/sample/columns for an empty and a populated list', async () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  const app = await buildApp(db);
  try {
    const empty = await app.inject({ method: 'GET', url: `/api/plugins/${created.id}/list` });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(JSON.parse(empty.body), { count: 0, sample: [], columns: [] });

    replaceListRows(db, created.id, [
      { room: '101', lastName: 'Smith' },
      { room: '102', lastName: 'Jones' },
    ]);
    const res = await app.inject({ method: 'GET', url: `/api/plugins/${created.id}/list` });
    const body = JSON.parse(res.body);
    assert.equal(body.count, 2);
    assert.equal(body.sample.length, 2);
    assert.deepEqual(body.columns, ['room', 'lastName']);
  } finally {
    await app.close();
  }
});

test('PUT /api/plugins/:id/list: { csv } parses (header required) and replaces the stored rows', async () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  const app = await buildApp(db);
  try {
    const csv = 'room,lastName\n101,Smith\n102,Jones\n';
    const res = await app.inject({ method: 'PUT', url: `/api/plugins/${created.id}/list`, payload: { csv } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.count, 2);
    assert.deepEqual(body.columns, ['room', 'lastName']);
    assert.deepEqual(listRows(db, created.id).rows, [
      { room: '101', lastName: 'Smith' },
      { room: '102', lastName: 'Jones' },
    ]);

    // A second PUT replaces wholesale.
    const res2 = await app.inject({ method: 'PUT', url: `/api/plugins/${created.id}/list`, payload: { csv: 'room\n201\n' } });
    assert.equal(JSON.parse(res2.body).count, 1);
    assert.equal(countListRows(db, created.id), 1);
  } finally {
    await app.close();
  }
});

test('PUT /api/plugins/:id/list: { rows: [...] } (JSON) is accepted directly', async () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  const app = await buildApp(db);
  try {
    const res = await app.inject({ method: 'PUT', url: `/api/plugins/${created.id}/list`, payload: { rows: [{ room: '1' }, { room: '2' }] } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).count, 2);
  } finally {
    await app.close();
  }
});

test('PUT /api/plugins/:id/list: rejects a body with neither csv nor rows, and a headerless CSV', async () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  const app = await buildApp(db);
  try {
    const missing = await app.inject({ method: 'PUT', url: `/api/plugins/${created.id}/list`, payload: {} });
    assert.equal(missing.statusCode, 400);

    const blank = await app.inject({ method: 'PUT', url: `/api/plugins/${created.id}/list`, payload: { csv: '' } });
    assert.equal(blank.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('PUT /api/plugins/:id/list: a ~1.2MB csv payload succeeds (proves the per-route 2MB bodyLimit override, not Fastify\'s 1MB default)', async () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  const app = await buildApp(db);
  try {
    const rowCount = 30000;
    const padding = 'x'.repeat(40); // pad each row so 30k rows clears 1MB comfortably
    const lines = ['room,note'];
    for (let i = 0; i < rowCount; i++) lines.push(`${i},${padding}`);
    const csv = lines.join('\n');
    assert.ok(Buffer.byteLength(csv, 'utf8') > 1024 * 1024, 'test payload must exceed the default 1MB bodyLimit');

    const res = await app.inject({ method: 'PUT', url: `/api/plugins/${created.id}/list`, payload: { csv } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).count, Math.min(rowCount, 5000));
  } finally {
    await app.close();
  }
});

test('DELETE /api/plugins/:id/list: clears the stored rows', async () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  replaceListRows(db, created.id, [{ room: '1' }, { room: '2' }]);
  const app = await buildApp(db);
  try {
    const res = await app.inject({ method: 'DELETE', url: `/api/plugins/${created.id}/list` });
    assert.equal(res.statusCode, 200);
    assert.equal(countListRows(db, created.id), 0);
  } finally {
    await app.close();
  }
});

test('GET/PUT/DELETE /api/plugins/:id/list on a missing plugin -> 404', async () => {
  const db = freshDb();
  const app = await buildApp(db);
  try {
    const get = await app.inject({ method: 'GET', url: '/api/plugins/999/list' });
    assert.equal(get.statusCode, 404);
    const put = await app.inject({ method: 'PUT', url: '/api/plugins/999/list', payload: { csv: 'room\n1\n' } });
    assert.equal(put.statusCode, 404);
    const del = await app.inject({ method: 'DELETE', url: '/api/plugins/999/list' });
    assert.equal(del.statusCode, 404);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// admin/plugins.js: POST /api/plugins/:id/test against a list-source plugin

test('POST /api/plugins/:id/test: runs a source:"list" recipe against its stored rows, no HTTP', async () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  replaceListRows(db, created.id, [{ room: '101' }, { room: '102' }]);
  const app = await buildApp(db);
  try {
    const res = await app.inject({ method: 'POST', url: `/api/plugins/${created.id}/test`, payload: { inputs: { room: '101' } } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.rawExcerpt, undefined);
    assert.deepEqual(body.records, [{ room: '101' }, { room: '102' }]);
    assert.deepEqual(
      body.steps.map((s) => s.name),
      ['list'],
    );
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// admin/plugins.js: GET /api/plugins/:id/export?includeRows=1

test('GET /api/plugins/:id/export: listRows only present with ?includeRows=1', async () => {
  const db = freshDb();
  const created = createPlugin(db, listBody());
  replaceListRows(db, created.id, [{ room: '101' }]);
  const app = await buildApp(db);
  try {
    const plain = await app.inject({ method: 'GET', url: `/api/plugins/${created.id}/export` });
    assert.equal('listRows' in JSON.parse(plain.body), false);

    const withRows = await app.inject({ method: 'GET', url: `/api/plugins/${created.id}/export?includeRows=1` });
    assert.deepEqual(JSON.parse(withRows.body).listRows, [{ room: '101' }]);
  } finally {
    await app.close();
  }
});
