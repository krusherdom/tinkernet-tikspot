// Plugin catalog: URL resolution, index/folder parsing (pure) and the catalog
// routes end to end against a local HTTP server serving the repo's plugins/.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import Database from 'better-sqlite3';

import {
  resolveSource,
  resolveRelative,
  parseCatalogIndex,
  parseGithubFolder,
  extractRecipe,
} from '../src/plugins/catalog.js';
import { migrate } from '../src/db/migrate.js';
import pluginRoutes from '../src/admin/plugins.js';

test('resolveSource understands GitHub tree/blob/raw/api and plain URLs', () => {
  let r = resolveSource('https://github.com/o/r/tree/main/plugins');
  assert.equal(r.kind, 'folder');
  assert.equal(r.fetchUrl, 'https://api.github.com/repos/o/r/contents/plugins?ref=main');
  r = resolveSource('https://github.com/o/r/blob/dev/plugins/index.json');
  assert.equal(r.kind, 'index');
  assert.equal(r.fetchUrl, 'https://raw.githubusercontent.com/o/r/dev/plugins/index.json');
  r = resolveSource('https://raw.githubusercontent.com/o/r/main/plugins/index.json');
  assert.equal(r.kind, 'index');
  r = resolveSource('https://api.github.com/repos/o/r/contents/plugins?ref=main');
  assert.equal(r.kind, 'folder');
  assert.equal(r.gh.ref, 'main');
  r = resolveSource('https://example.com/cat/index.json');
  assert.equal(r.kind, 'index');
  assert.equal(resolveSource('ftp://x').ok, false);
  assert.equal(resolveSource('').ok, false);
});

test('parseCatalogIndex resolves relative files and validates the format', () => {
  const idx = { format: 'tikspot-plugin-catalog', version: 1, plugins: [{ id: 'a', name: 'A', file: 'a.json', tags: ['x'] }, { file: 'https://h/b.json' }, { bad: true }] };
  const r = parseCatalogIndex(idx, 'https://raw.githubusercontent.com/o/r/main/plugins/index.json');
  assert.equal(r.ok, true);
  assert.equal(r.plugins.length, 2);
  assert.equal(r.plugins[0].url, 'https://raw.githubusercontent.com/o/r/main/plugins/a.json');
  assert.equal(r.plugins[1].url, 'https://h/b.json');
  assert.equal(parseCatalogIndex({ hello: 1 }, 'https://x/i.json').ok, false);
  // A single export is a catalog of one.
  const one = parseCatalogIndex({ format: 'tikspot-plugin', recipe: { name: 'Solo', parse: { type: 'json' }, inputs: [{ name: 'room' }] } }, 'https://x/solo.json');
  assert.equal(one.plugins[0].name, 'Solo');
  assert.equal(one.plugins[0].url, 'https://x/solo.json');
  assert.equal(resolveRelative('https://x/a/index.json', '../b.json'), 'https://x/b.json');
});

test('parseGithubFolder keeps only json files and detects index.json', () => {
  const r = parseGithubFolder([
    { type: 'file', name: 'index.json', download_url: 'https://raw/x/index.json', size: 10 },
    { type: 'file', name: 'a.json', download_url: 'https://raw/x/a.json' },
    { type: 'file', name: 'README.md', download_url: 'https://raw/x/README.md' },
    { type: 'dir', name: 'sub' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 2);
  assert.equal(r.hasIndex, true);
  assert.equal(parseGithubFolder({ message: 'Not Found' }).ok, false);
});

test('extractRecipe accepts exports and bare recipes only', () => {
  assert.equal(extractRecipe({ format: 'tikspot-plugin', recipe: { name: 'x' } }).name, 'x');
  assert.equal(extractRecipe({ request: {}, parse: {}, inputs: [] }) !== null, true);
  assert.equal(extractRecipe({ foo: 1 }), null);
});

test('catalog routes: browse a local index and import a demo recipe (disabled, no secrets)', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, '../../plugins');
  const srv = http.createServer((req, res) => {
    const f = path.join(dir, path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(f)) {
      res.writeHead(404).end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const db = new Database(':memory:');
  migrate(db);
  const app = Fastify();
  app.decorate('db', db);
  await app.register(pluginRoutes);
  try {
    const browse = await app.inject({ method: 'GET', url: `/api/plugins/catalog?source=${encodeURIComponent(base + '/index.json')}` });
    assert.equal(browse.statusCode, 200, browse.body);
    const cat = browse.json();
    assert.equal(cat.kind, 'index');
    assert.ok(cat.plugins.length >= 3);
    const demo = cat.plugins.find((p) => p.id === 'demo-hotel-json');
    assert.equal(demo.parser, 'json');
    assert.deepEqual(demo.inputs, ['room', 'name']);
    assert.equal(demo.url, `${base}/demo-hotel-json.json`);

    const imp = await app.inject({ method: 'POST', url: '/api/plugins/catalog/import', payload: { url: demo.url } });
    assert.equal(imp.statusCode, 200, imp.body);
    const { id } = imp.json();
    const row = db.prepare('SELECT enabled, recipe_json, secrets_json FROM plugins WHERE id = ?').get(id);
    assert.equal(row.enabled, 0);
    assert.equal(JSON.parse(row.recipe_json).name, demo.name);
    // Secrets are normalised to empty strings — nothing is carried over from a catalog.
    assert.ok(Object.values(JSON.parse(row.secrets_json)).every((v) => v === ''));

    const bad = await app.inject({ method: 'POST', url: '/api/plugins/catalog/import', payload: { url: `${base}/README.md` } });
    assert.ok([400, 502].includes(bad.statusCode));
    const gone = await app.inject({ method: 'GET', url: `/api/plugins/catalog?source=${encodeURIComponent('http://127.0.0.1:1/x.json')}` });
    assert.equal(gone.statusCode, 502);
    assert.ok(gone.json().hint);
  } finally {
    await app.close();
    srv.close();
  }
});
