// Admin API: block registry + design CRUD/draft/publish/version for the
// editor, the hotspot-shim zip download, and branding-asset management. These
// live under /api and the admin UI under /admin; the global auth gate
// (admin/auth.js) requires a session cookie for all of it once setup is
// complete.

import fs from 'node:fs';
import path from 'node:path';
import {
  listDesigns,
  getDesign,
  getActiveDesign,
  activateDesign,
  createDesign,
  saveDraft,
  publishDesign,
  listVersions,
  revertDesign,
  deleteDesign,
  exportDesign,
  importDesign,
  designModel,
  draftModel,
  discardDraft,
} from '../portal/designs.js';
import { renderPortalPage } from '../portal/render.js';
import { BLOCK_REGISTRY, STYLE_FIELDS, THEME_FIELDS, defaultTheme, FONTS, ACCENTS, PAGE_BGS, normalizeDesign } from '../design/model.js';
import { TEMPLATES } from '../design/templates.js';
import { buildShimZip } from '../hotspot/zip.js';
import { generateShims } from '../hotspot/shims.js';
import { routerFromSettings } from './setup.js';
import { getSetting, getJSON } from '../db/settings.js';
import { ASSETS_DIR } from '../config.js';
import { validateDesignJson } from './validate.js';
import { logAudit } from './audit.js';

function shimContentType(name) {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.txt')) return 'text/plain';
  return 'text/html';
}

// Keep uploaded filenames safe for the filesystem and for URL use.
function safeName(name) {
  return path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'file';
}

export default async function adminRoutes(app) {
  const db = app.db;

  // ---- Block/theme registry ----------------------------------------------
  // The single source of truth for the editor's block picker + property
  // panels — see design/model.js. Avoids the editor duplicating this list.
  app.get('/api/blocks', async () => ({
    blocks: BLOCK_REGISTRY,
    styleFields: STYLE_FIELDS,
    themeFields: THEME_FIELDS,
    theme: defaultTheme(),
    fonts: FONTS,
    accents: ACCENTS,
    pageBgs: PAGE_BGS,
  }));

  // ---- Designs ------------------------------------------------------------
  app.get('/api/designs', async () => ({ designs: listDesigns(db) }));

  // Must be declared before /api/designs/:id.
  app.get('/api/designs/templates', async () => ({
    templates: TEMPLATES.map(({ key, name, description }) => ({ key, name, description })),
  }));

  app.get('/api/designs/active', async (_req, reply) => {
    const row = getActiveDesign(db);
    if (!row) return reply.code(404).send({ error: 'no active design' });
    return { id: row.id, name: row.name, version: row.version, model: designModel(row), draft: draftModel(row) };
  });

  app.get('/api/designs/:id', async (req, reply) => {
    const row = getDesign(db, Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { id: row.id, name: row.name, version: row.version, model: designModel(row), draft: draftModel(row) };
  });

  // New shape: {name, template?, model?} -> create a draft design.
  // Back-compat shape (old editor): {id?, grapes_json, activate?} -> publish
  // (creating the design first if no id was given).
  app.post('/api/designs', async (req, reply) => {
    const body = req.body ?? {};
    if ('grapes_json' in body) {
      const dj = validateDesignJson(body.grapes_json);
      if (!dj.ok) return reply.code(400).send({ error: dj.error });
      let id = body.id ? Number(body.id) : null;
      if (!id) {
        id = createDesign(db, { name: body.name, model: dj.value ?? undefined });
      }
      const version = publishDesign(db, id, dj.value ?? undefined);
      if (body.activate) activateDesign(db, id);
      logAudit(db, req, body.id ? 'design.update' : 'design.create', body.name ?? `#${id}`);
      return { ok: true, id, version };
    }
    const id = createDesign(db, { name: body.name, template: body.template, model: body.model });
    logAudit(db, req, 'design.create', body.name ?? `#${id}`);
    return { id };
  });

  app.post('/api/designs/:id/draft', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getDesign(db, id)) return reply.code(404).send({ error: 'not found' });
    const dj = validateDesignJson(req.body?.model);
    if (!dj.ok) return reply.code(400).send({ error: dj.error });
    const { saved_at } = saveDraft(db, id, dj.value);
    logAudit(db, req, 'design.draft', `#${id}`);
    return { ok: true, saved_at };
  });

  app.delete('/api/designs/:id/draft', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getDesign(db, id)) return reply.code(404).send({ error: 'not found' });
    discardDraft(db, id);
    logAudit(db, req, 'design.draft-discard', `#${id}`);
    return { ok: true };
  });

  app.post('/api/designs/:id/publish', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getDesign(db, id)) return reply.code(404).send({ error: 'not found' });
    let model;
    if (req.body?.model !== undefined) {
      const dj = validateDesignJson(req.body.model);
      if (!dj.ok) return reply.code(400).send({ error: dj.error });
      model = dj.value;
    }
    const version = publishDesign(db, id, model);
    logAudit(db, req, 'design.publish', `#${id} v${version}`);
    return { ok: true, version };
  });

  app.post('/api/designs/:id/activate', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getDesign(db, id)) return reply.code(404).send({ error: 'not found' });
    activateDesign(db, id);
    logAudit(db, req, 'design.activate', `#${id}`);
    return { ok: true };
  });

  app.delete('/api/designs/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const result = deleteDesign(db, id);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    logAudit(db, req, 'design.delete', `#${id}`);
    return { ok: true };
  });

  app.get('/api/designs/:id/versions', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getDesign(db, id)) return reply.code(404).send({ error: 'not found' });
    return { versions: listVersions(db, id) };
  });

  app.post('/api/designs/:id/revert', async (req, reply) => {
    const id = Number(req.params.id);
    const version = Number(req.body?.version);
    const newVersion = revertDesign(db, id, version);
    if (newVersion == null) return reply.code(404).send({ error: 'version not found' });
    logAudit(db, req, 'design.revert', `#${id} -> v${version} (as v${newVersion})`);
    return { ok: true, version: newVersion };
  });

  app.get('/api/designs/:id/export', async (req, reply) => {
    const id = Number(req.params.id);
    const bundle = exportDesign(db, id);
    if (!bundle) return reply.code(404).send({ error: 'not found' });
    const safe = safeName(bundle.name || `design-${id}`);
    reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${safe}.tikspot-design.json"`)
      .send(JSON.stringify(bundle, null, 2));
  });

  app.post('/api/designs/import', async (req, reply) => {
    const body = req.body ?? {};
    const model = body.model ?? body; // tolerate the raw export envelope being posted
    if (!model || typeof model !== 'object') return reply.code(400).send({ error: 'model is required' });
    const id = importDesign(db, { name: body.name, model });
    logAudit(db, req, 'design.import', body.name ?? `#${id}`);
    return { id };
  });

  app.patch('/api/designs/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = getDesign(db, id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    db.prepare("UPDATE designs SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
    logAudit(db, req, 'design.rename', `#${id} -> ${name}`);
    return { ok: true };
  });

  // Renders {design, page} into HTML for the editor's preview iframe (srcdoc).
  // No real router session — login forms post to '#' (inert).
  app.post('/api/designs/preview', async (req, reply) => {
    const dj = validateDesignJson(req.body?.design);
    if (!dj.ok) return reply.code(400).send({ error: dj.error });
    const page = ['login', 'status', 'logout'].includes(req.body?.page) ? req.body.page : 'login';
    const model = normalizeDesign(dj.value);
    const html = renderPortalPage(model, {
      preview: true,
      page,
      freeCreds: getJSON(db, 'free_credentials', {}) || {},
    });
    reply.type('text/html').send(html);
  });

  // ---- Hotspot shim files ------------------------------------------------
  // Option 1: download the zip.
  app.get('/api/hotspot/shim.zip', async (_req, reply) => {
    const buf = await buildShimZip();
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', 'attachment; filename="tikspot-hotspot.zip"')
      .send(buf);
  });

  // Public: the individual shim files, so the router can pull them with /tool/fetch.
  // Not sensitive (redirect HTML); the auth gate allowlists /hotspot-files/.
  app.get('/hotspot-files/:name', async (req, reply) => {
    const f = generateShims().find((s) => s.name === req.params.name);
    if (!f) return reply.code(404).send('not found');
    reply.type(shimContentType(f.name)).send(f.content);
  });

  // Option 2: push the shim files straight onto the router's hotspot directory
  // over the REST API (the router /tool/fetch'es each file from this container).
  app.post('/api/hotspot/push', async (req, reply) => {
    const router = routerFromSettings(db);
    if (!router) return reply.code(400).send({ error: 'Router not configured — set it up on the Router setup tab first.' });
    const containerIp = (getSetting(db, 'container_ip', '') || '').trim();
    if (!containerIp) return reply.code(400).send({ error: 'Container IP not set — add it on the Router setup tab.' });

    // Where the hotspot serves HTML from (default "hotspot"); read from a profile.
    let htmlDir = 'hotspot';
    try {
      const profiles = await router.list('/ip/hotspot/profile');
      const d = profiles.map((p) => p['html-directory']).find(Boolean);
      if (d) htmlDir = String(d).replace(/\/+$/, '');
    } catch { /* fall back to "hotspot" */ }

    const files = generateShims();
    const results = [];
    for (const f of files) {
      const url = `http://${containerIp}/hotspot-files/${f.name}`;
      const dst = `${htmlDir}/${f.name}`;
      try {
        const r = await router.call('POST', '/tool/fetch', { url, 'dst-path': dst, mode: 'http' });
        const status = r && (r.status || r['status']);
        const ok = !status || /finish|done|success/i.test(String(status));
        results.push({ name: f.name, ok, status: status || 'ok' });
      } catch (err) {
        results.push({ name: f.name, ok: false, status: String(err.message ?? err) });
      }
    }
    const pushed = results.filter((r) => r.ok).length;
    logAudit(db, req, 'hotspot.push', `${pushed}/${files.length}`);
    return { ok: pushed === files.length, htmlDir, pushed, total: files.length, results };
  });

  // ---- Branding assets ---------------------------------------------------
  app.get('/api/assets', async () => ({
    assets: db
      .prepare('SELECT id, filename, mime, bytes, created_at FROM assets ORDER BY id')
      .all()
      .map((a) => ({ ...a, url: `/assets/${a.filename}` })),
  }));

  app.post('/api/assets', async (req, reply) => {
    const file = await req.file?.();
    if (!file) return reply.code(400).send({ error: 'expected a multipart file upload' });
    const filename = safeName(file.filename);
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    const dest = path.join(ASSETS_DIR, filename);
    const buf = await file.toBuffer();
    fs.writeFileSync(dest, buf);
    db.prepare(
      `INSERT INTO assets (filename, mime, bytes) VALUES (@filename, @mime, @bytes)
       ON CONFLICT(filename) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes`,
    ).run({ filename, mime: file.mimetype ?? null, bytes: buf.length });
    const row = db.prepare('SELECT id, created_at FROM assets WHERE filename = ?').get(filename);
    logAudit(db, req, 'asset.upload', filename);
    return {
      ok: true,
      id: row.id,
      filename,
      mime: file.mimetype ?? null,
      bytes: buf.length,
      created_at: row.created_at,
      url: `/assets/${filename}`,
    };
  });

  // 409 if the active design's published or draft JSON still mentions this
  // file (a plain substring search over `src`/`bgImage` values — best-effort,
  // not a full block walk, but catches the normal cases).
  app.delete('/api/assets/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const active = getActiveDesign(db);
    const haystack = active ? `${active.grapes_json || ''}\n${active.draft_json || ''}` : '';
    if (haystack.includes(`/assets/${row.filename}`)) {
      return reply.code(409).send({ error: 'this asset is used by the active design' });
    }
    db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    try {
      fs.unlinkSync(path.join(ASSETS_DIR, row.filename));
    } catch { /* file already gone is fine */ }
    logAudit(db, req, 'asset.delete', row.filename);
    return { ok: true };
  });
}
