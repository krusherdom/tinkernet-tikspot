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
  listRows,
  replaceListRows,
} from '../plugins/store.js';
import { listActiveGrants, revokeGrant } from '../plugins/grants.js';
import { runLookup, makeTokenCache } from '../plugins/engine.js';
import { renderTemplate, renderJsonTemplate, templateVars } from '../plugins/template.js';
import { getPath, parseResponse, parseCsv } from '../plugins/parsers.js';
import { httpRequest } from '../plugins/http.js';
import { emptyRecipe } from '../plugins/recipe.js';
import { logAudit } from './audit.js';
import { logEvent } from './events.js';
import { getTyped } from '../db/settings.js';
import { DEFAULT_CATALOG_URL, resolveSource, parseCatalogIndex, parseGithubFolder, extractRecipe, summarizeRecipe } from '../plugins/catalog.js';

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
    case 'csv':
      return 'text/csv, text/plain;q=0.9, */*;q=0.8';
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

// Mirrors engine.js's applyBasicAuth for this module's separate (best-effort)
// request-building pass — see the top-of-file comment for why this exists.
function applyDebugBasicAuth(headers, basic, vars) {
  if (!basic) return;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization') delete headers[k];
  }
  const user = renderTemplate(basic.user, vars, { escape: 'none' });
  const pass = renderTemplate(basic.pass, vars, { escape: 'none' });
  headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

// `r` is a request-shaped block (recipe.request, or the first step's request
// for a v2 steps-only recipe — see debugFetch).
function buildDebugRequest(recipe, r, vars) {
  const url = renderTemplate(r.url, vars, { escape: 'url' });
  const headers = renderHeaders(r.headers, vars);
  applyDebugBasicAuth(headers, r.basic, vars);
  let body;
  if (r.bodyJson !== undefined) {
    const omitEmpty = r.omitEmpty === false ? false : true;
    body = JSON.stringify(renderJsonTemplate(r.bodyJson, vars, { omitEmpty }));
  } else if (r.bodyTemplate) {
    body = renderTemplate(r.bodyTemplate, vars, { escape: escapeForContentType(r.contentType) });
  }
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
  applyDebugBasicAuth(headers, a.basic, vars);
  let body;
  if (a.bodyJson !== undefined) {
    const omitEmpty = a.omitEmpty === true; // default false for auth bodies, matching engine.js
    body = JSON.stringify(renderJsonTemplate(a.bodyJson, vars, { omitEmpty }));
  } else if (a.bodyTemplate) {
    body = renderTemplate(a.bodyTemplate, vars, { escape: a.contentType === 'form' ? 'form' : 'json' });
  }
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

// A v2 steps-only recipe has no top-level request/parse — fall back to the
// first step's, purely for this best-effort raw-response preview (the real
// match/window logic in runLookup already walks every step correctly).
function debugRequestParse(recipe) {
  const firstStep = Array.isArray(recipe.steps) && recipe.steps.length ? recipe.steps[0] : null;
  return {
    request: recipe.request || (firstStep && firstStep.request),
    parse: recipe.parse || (firstStep && firstStep.parse),
  };
}

async function debugFetch(recipe, inputs) {
  try {
    const { request, parse } = debugRequestParse(recipe);
    if (!request || !parse) return { rawExcerpt: undefined, records: undefined };
    let token = '';
    if (recipe.auth) token = (await getDebugToken(recipe)) || '';
    const vars = templateVars(recipe, inputs, token, new Date().toISOString());
    const req = applyDebugTokenPlacement(buildDebugRequest(recipe, request, vars), token, recipe.auth && recipe.auth.placement);
    const res = await httpRequest(req);
    const rawExcerpt = (res.text || '').slice(0, 2048);
    let records = [];
    try {
      records = (parseResponse(parse, res.text).records || []).slice(0, 5);
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

  // ---- Catalog: browse recipes published on GitHub / any HTTP host ----------
  async function fetchJson(url) {
    const r = await httpRequest({
      url,
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json, application/json;q=0.9, */*;q=0.1', 'User-Agent': 'tikspot-plugin-catalog' },
      timeoutMs: 10000,
    });
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(`HTTP ${r.status} from ${url}`);
      err.status = r.status;
      throw err;
    }
    try {
      return JSON.parse(r.text);
    } catch {
      throw new Error(`response from ${url} is not JSON`);
    }
  }

  // GET /api/plugins/catalog?source=<url>  (default: the plugin_catalog_url setting)
  app.get('/api/plugins/catalog', async (req, reply) => {
    const source = String(req.query?.source || getTyped(db, 'plugin_catalog_url') || DEFAULT_CATALOG_URL);
    const res = resolveSource(source);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    try {
      if (res.kind === 'folder') {
        const listing = parseGithubFolder(await fetchJson(res.fetchUrl));
        if (!listing.ok) return reply.code(400).send({ error: listing.error, source });
        const idx = listing.files.find((f) => f.name.toLowerCase() === 'index.json');
        if (idx) {
          const parsed = parseCatalogIndex(await fetchJson(idx.url), idx.url);
          if (parsed.ok) return { source, kind: 'index', indexUrl: idx.url, ...parsed };
        }
        // No index: describe each plugin file (bounded).
        const plugins = [];
        for (const f of listing.files.slice(0, 30)) {
          try {
            const recipe = extractRecipe(await fetchJson(f.url));
            if (recipe) plugins.push({ id: f.name.replace(/\.json$/i, ''), ...summarizeRecipe(recipe), description: '', tags: [], url: f.url });
          } catch {
            /* skip unreadable file */
          }
        }
        return { source, kind: 'folder', plugins };
      }
      const parsed = parseCatalogIndex(await fetchJson(res.fetchUrl), res.fetchUrl);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error, source });
      return { source, kind: 'index', indexUrl: res.fetchUrl, ...parsed };
    } catch (err) {
      const msg = String(err?.message || err);
      logEvent(db, 'warn', 'plugin', 'Catalog fetch failed', { source, error: msg });
      return reply.code(502).send({
        error: `could not fetch the catalog: ${msg}`,
        hint: 'The container needs outbound internet (a srcnat masquerade for its subnet — see Router setup → Verify) and DNS.',
        source,
      });
    }
  });

  // POST /api/plugins/catalog/import {url}  -> fetch one plugin file and import it (disabled).
  app.post('/api/plugins/catalog/import', async (req, reply) => {
    const url = String(req.body?.url || '').trim();
    const res = resolveSource(url);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    let recipe;
    try {
      recipe = extractRecipe(await fetchJson(res.fetchUrl));
    } catch (err) {
      return reply.code(502).send({ error: `could not fetch the plugin: ${String(err?.message || err)}` });
    }
    if (!recipe) return reply.code(400).send({ error: 'that file is not a Tikspot plugin export' });
    // importPlugin() itself blanks secrets and forces enabled:false — the admin reviews first.
    const result = importPlugin(db, recipe);
    if (!result.ok) return reply.code(400).send({ error: result.error, fields: result.fields });
    logAudit(db, req, 'plugin.catalog-import', `#${result.id} from ${res.fetchUrl}`);
    return { ok: true, id: result.id, name: recipe.name || '' };
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

  // ?includeRows=1 additionally includes a source:'list' plugin's guest-list
  // rows in the export — off by default since those rows are guest PII.
  app.get('/api/plugins/:id/export', async (req, reply) => {
    const id = Number(req.params.id);
    const includeRows = String(req.query?.includeRows || '') === '1';
    const bundle = exportPlugin(db, id, { includeRows });
    if (!bundle) return reply.code(404).send({ error: 'not found' });
    const safe = safeName(bundle.recipe?.name || `plugin-${id}`);
    reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${safe}.tikspot-plugin.json"`)
      .send(JSON.stringify(bundle, null, 2));
  });

  // ---- Built-in guest-list source (source:'list') ---------------------------

  app.get('/api/plugins/:id/list', async (req, reply) => {
    const id = Number(req.params.id);
    const recipe = getPluginPublic(db, id);
    if (!recipe) return reply.code(404).send({ error: 'not found' });
    const { count, rows } = listRows(db, id);
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { count, sample: rows.slice(0, 20), columns };
  });

  // body: { csv: '<text>' } (header row required) or { rows: [{...}, ...] }.
  // 2 MB body limit (Fastify's fastify-wide default is 1 MB) for a
  // reasonably large guest list pasted/uploaded as CSV.
  app.put('/api/plugins/:id/list', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const id = Number(req.params.id);
    const recipe = getPluginPublic(db, id);
    if (!recipe) return reply.code(404).send({ error: 'not found' });

    const body = req.body || {};
    let rows;
    let columns;
    if (typeof body.csv === 'string') {
      const parsed = parseCsv(body.csv, { header: true });
      if (!parsed.headers.length) return reply.code(400).send({ error: 'CSV must have a header row' });
      rows = parsed.rows;
      columns = parsed.headers;
    } else if (Array.isArray(body.rows)) {
      rows = body.rows;
      columns = rows.length ? Object.keys(rows[0]) : [];
    } else {
      return reply.code(400).send({ error: 'expected { csv: "<text>" } or { rows: [...] }' });
    }

    const result = replaceListRows(db, id, rows);
    logAudit(db, req, 'plugin.list-replace', `#${id} -> ${result.count} rows`);
    return { count: result.count, columns };
  });

  app.delete('/api/plugins/:id/list', async (req, reply) => {
    const id = Number(req.params.id);
    const recipe = getPluginPublic(db, id);
    if (!recipe) return reply.code(404).send({ error: 'not found' });
    replaceListRows(db, id, []);
    logAudit(db, req, 'plugin.list-replace', `#${id} -> cleared`);
    return { ok: true };
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

    // source:'list' has no HTTP request to run — the engine matches directly
    // against the plugin's stored guest-list rows.
    const records = recipe.source === 'list' ? listRows(db, id).rows : undefined;

    const start = Date.now();
    let result;
    try {
      result = await runLookup({ recipe, inputs, tokenCache: makeTokenCache(), diagnostics: true, records });
    } catch (err) {
      result = { ok: false, reason: 'upstream', detail: String(err?.message || err) };
    }
    const debug = recipe.source === 'list' ? { rawExcerpt: undefined, records: (records || []).slice(0, 5) } : await debugFetch(recipe, inputs);
    const ms = Date.now() - start;

    logAudit(db, req, 'plugin.test', `#${id} -> ${result.ok ? 'ok' : result.reason}`);
    return { ...result, rawExcerpt: debug.rawExcerpt, records: debug.records, ms };
  });
}
