// Admin API for guest-lookup plugins (Stage 0.13-B/C): CRUD + import/export
// over app/src/plugins/store.js, a live "test this recipe" endpoint, and
// read/revoke over the RADIUS grants plugins hand out (plugins/grants.js).
// Registered under /api — the global auth gate (admin/auth.js) already
// requires a session cookie for everything here.

import {
  listPlugins,
  getPlugin,
  getPluginPublic,
  getPluginSecretsMeta,
  createPlugin,
  updatePlugin,
  deletePlugin,
  exportPlugin,
  importPlugin,
} from '../plugins/store.js';
import { listActiveGrants, revokeGrant } from '../plugins/grants.js';
import { runLookup, makeTokenCache } from '../plugins/engine.js';
import { renderTemplate, templateVars } from '../plugins/template.js';
import { getPath, parseResponse } from '../plugins/parsers.js';
import { httpRequest } from '../plugins/http.js';
import { emptyRecipe } from '../plugins/recipe.js';
import { logAudit } from './audit.js';

function safeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'plugin';
}

// ---------------------------------------------------------------------------
// A second, independent request-building pass for POST /api/plugins/:id/test,
// so the admin "test this recipe" tool can return a raw response excerpt +
// parsed records without changing engine.js's runLookup contract (which
// deliberately never returns response bodies). This mirrors engine.js's
// private buildRequest/getToken/applyTokenPlacement closely but is entirely
// best-effort: any failure here just omits rawExcerpt/records, since
// runLookup's own result (ok/reason/guest/expiresAt) is always authoritative.

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function contentTypeHeader(contentType) {
  switch (contentType) {
    case 'form':
      return 'application/x-www-form-urlencoded';
    case 'xml':
      return 'application/xml';
    case 'text':
      return 'text/plain';
    default:
      return 'application/json';
  }
}

function acceptHeader(accept) {
  switch (accept) {
    case 'xml':
      return 'application/xml';
    case 'text':
      return 'text/plain';
    default:
      return 'application/json';
  }
}

function escapeForContentType(contentType) {
  if (contentType === 'form') return 'form';
  if (contentType === 'xml') return 'xml';
  if (contentType === 'text') return 'none';
  return 'json';
}

function renderHeaders(headerTemplates, vars) {
  const headers = {};
  for (const [k, v] of Object.entries(headerTemplates || {})) {
    headers[k] = renderTemplate(String(v), vars, { escape: 'none' });
  }
  return headers;
}

function buildDebugRequest(recipe, vars) {
  const r = recipe.request;
  const url = renderTemplate(r.url, vars, { escape: 'url' });
  const headers = renderHeaders(r.headers, vars);
  let body;
  if (r.bodyTemplate) body = renderTemplate(r.bodyTemplate, vars, { escape: escapeForContentType(r.contentType) });
  if (body !== undefined && !hasHeader(headers, 'content-type')) headers['Content-Type'] = contentTypeHeader(r.contentType);
  if (r.accept && !hasHeader(headers, 'accept')) headers['Accept'] = acceptHeader(r.accept);
  return { url, method: r.method || 'GET', headers, body, timeoutMs: recipe.timeoutMs || 8000, insecureTls: !!recipe.allowInsecureTls };
}

function applyDebugTokenPlacement(req, token, placement) {
  if (!token || !placement) return req;
  const name = placement.name || 'Authorization';
  const value = (placement.prefix || '') + token;
  if (placement.in === 'query') {
    const u = new URL(req.url);
    u.searchParams.set(name, value);
    req.url = u.toString();
    return req;
  }
  if (placement.in === 'body') {
    if (req.body === undefined) {
      req.body = value;
      return req;
    }
    try {
      const parsed = JSON.parse(req.body);
      if (parsed && typeof parsed === 'object') {
        parsed[name] = value;
        req.body = JSON.stringify(parsed);
        return req;
      }
    } catch {
      // not JSON — fall through
    }
    req.body = `${req.body}&${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    return req;
  }
  req.headers[name] = value;
  return req;
}

async function getDebugToken(recipe) {
  const a = recipe.auth;
  const vars = templateVars(recipe, [], '', new Date().toISOString());
  const url = renderTemplate(a.url, vars, { escape: 'url' });
  const headers = renderHeaders(a.headers, vars);
  let body;
  if (a.bodyTemplate) body = renderTemplate(a.bodyTemplate, vars, { escape: a.contentType === 'form' ? 'form' : 'json' });
  if (body !== undefined && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = a.contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
  }
  const res = await httpRequest({ url, method: a.method || 'POST', headers, body, timeoutMs: recipe.timeoutMs || 8000, insecureTls: !!recipe.allowInsecureTls });
  if (res.status < 200 || res.status >= 300) return null;
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    return null;
  }
  const token = getPath(json, a.tokenPath || 'token');
  return token ? String(token) : null;
}

async function debugFetch(recipe, inputs) {
  try {
    let token = '';
    if (recipe.auth) token = (await getDebugToken(recipe)) || '';
    const vars = templateVars(recipe, inputs, token, new Date().toISOString());
    const req = applyDebugTokenPlacement(buildDebugRequest(recipe, vars), token, recipe.auth && recipe.auth.placement);
    const res = await httpRequest(req);
    const rawExcerpt = (res.text || '').slice(0, 2048);
    let records = [];
    try {
      records = (parseResponse(recipe.parse, res.text).records || []).slice(0, 5);
    } catch {
      records = [];
    }
    return { rawExcerpt, records };
  } catch {
    return { rawExcerpt: undefined, records: undefined };
  }
}

export default async function pluginRoutes(app) {
  const db = app.db;

  app.get('/api/plugins', async () => ({ plugins: listPlugins(db) }));

  // Declared before /api/plugins/:id so these literal paths always win.
  app.get('/api/plugins/recipe-template', async () => emptyRecipe());
  app.get('/api/plugins/grants', async () => ({ grants: listActiveGrants(db) }));

  app.delete('/api/plugins/grants/:id', async (req, reply) => {
    const ok = revokeGrant(db, Number(req.params.id));
    if (!ok) return reply.code(404).send({ error: 'not found' });
    logAudit(db, req, 'guest.revoke', `#${req.params.id}`);
    return { ok: true };
  });

  app.post('/api/plugins/import', async (req, reply) => {
    const result = importPlugin(db, req.body ?? {});
    if (!result.ok) return reply.code(400).send({ error: result.error, fields: result.fields });
    logAudit(db, req, 'plugin.import', `#${result.id}`);
    return { ok: true, id: result.id };
  });

  app.post('/api/plugins', async (req, reply) => {
    const result = createPlugin(db, req.body ?? {});
    if (!result.ok) return reply.code(400).send({ error: result.error, fields: result.fields });
    logAudit(db, req, 'plugin.create', `#${result.id}`);
    return { ok: true, id: result.id };
  });

  app.get('/api/plugins/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const recipe = getPluginPublic(db, id);
    if (!recipe) return reply.code(404).send({ error: 'not found' });
    return { ...recipe, has_secrets: getPluginSecretsMeta(db, id) };
  });

  app.get('/api/plugins/:id/export', async (req, reply) => {
    const id = Number(req.params.id);
    const bundle = exportPlugin(db, id);
    if (!bundle) return reply.code(404).send({ error: 'not found' });
    const safe = safeName(bundle.recipe?.name || `plugin-${id}`);
    reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${safe}.tikspot-plugin.json"`)
      .send(JSON.stringify(bundle, null, 2));
  });

  app.patch('/api/plugins/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const result = updatePlugin(db, id, req.body ?? {});
    if (!result.ok) {
      if (result.notFound) return reply.code(404).send({ error: result.error });
      return reply.code(400).send({ error: result.error, fields: result.fields });
    }
    logAudit(db, req, 'plugin.update', `#${id}`);
    return { ok: true };
  });

  app.delete('/api/plugins/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const ok = deletePlugin(db, id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    logAudit(db, req, 'plugin.delete', `#${id}`);
    return { ok: true };
  });

  // Runs the recipe for real (fresh token cache — never touches the shared
  // portal one) against admin-supplied test inputs. Never returns secrets;
  // rawExcerpt/records are the guest system's *response* (test data), not
  // recipe credentials.
  app.post('/api/plugins/:id/test', async (req, reply) => {
    const id = Number(req.params.id);
    const recipe = getPlugin(db, id);
    if (!recipe) return reply.code(404).send({ error: 'not found' });

    const inputsBody = (req.body && req.body.inputs) || {};
    const inputs = (recipe.inputs || []).map((inp) => ({
      name: inp.name,
      required: !!inp.required,
      value: inputsBody[inp.name] ?? '',
    }));

    const start = Date.now();
    let result;
    try {
      result = await runLookup({ recipe, inputs, tokenCache: makeTokenCache() });
    } catch (err) {
      result = { ok: false, reason: 'upstream', detail: String(err?.message || err) };
    }
    const debug = await debugFetch(recipe, inputs);
    const ms = Date.now() - start;

    logAudit(db, req, 'plugin.test', `#${id} -> ${result.ok ? 'ok' : result.reason}`);
    return { ...result, rawExcerpt: debug.rawExcerpt, records: debug.records, ms };
  });
}
