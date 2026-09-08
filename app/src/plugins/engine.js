// Orchestrates a single guest-lookup run: optional token auth (cached),
// build + fire the request, parse the response, match the guest, check the
// stay window. Pure aside from the injected `http` (default httpRequest) and
// `tokenCache`, so it's fully testable with a stub transport.
//
// runLookup(...) never returns or throws secrets or the bearer token — only
// `{ ok, guest, expiresAt }` on success or `{ ok:false, reason, ... }` on
// failure. The DB-backed RADIUS credential minting is NOT this module's job;
// the caller does that with the returned `expiresAt`.

import { renderTemplate, templateVars } from './template.js';
import { getPath, parseResponse, parseDate } from './parsers.js';
import { findGuest, inWindow } from './match.js';
import { httpRequest as defaultHttpRequest } from './http.js';

// A Map-based token cache: key -> { token, expiresAtMs }. Callers should keep
// one instance per process (or per recipe store) and pass it into every
// runLookup call so tokens are reused across guests until they expire.
export function makeTokenCache() {
  return new Map();
}

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
    case 'json':
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
    case 'json':
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

function buildRequest(recipe, vars) {
  const r = recipe.request;
  const url = renderTemplate(r.url, vars, { escape: 'url' });
  const headers = renderHeaders(r.headers, vars);

  let body;
  if (r.bodyTemplate) {
    body = renderTemplate(r.bodyTemplate, vars, { escape: escapeForContentType(r.contentType) });
  }
  if (body !== undefined && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = contentTypeHeader(r.contentType);
  }
  if (r.accept && !hasHeader(headers, 'accept')) {
    headers['Accept'] = acceptHeader(r.accept);
  }

  return {
    url,
    method: r.method || 'GET',
    headers,
    body,
    timeoutMs: recipe.timeoutMs || 8000,
    insecureTls: !!recipe.allowInsecureTls,
  };
}

// Attaches the auth token to the already-built guest-lookup request per
// `auth.placement`. Header/query placement is exact; body placement is
// best-effort (recipes needing precise control should reference {{token}}
// directly in their bodyTemplate instead — see README notes in
// examples/guest-api).
function applyTokenPlacement(req, token, placement) {
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
      // not JSON — fall through to a best-effort form-style append
    }
    req.body = `${req.body}&${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    return req;
  }

  // default: header
  req.headers[name] = value;
  return req;
}

async function getToken(recipe, http, tokenCache, nowMs, inputs) {
  const authCfg = recipe.auth;
  const cacheKey = recipe.id || recipe.name || 'default';

  if (tokenCache && typeof tokenCache.get === 'function') {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) return cached.token;
  }

  const vars = templateVars(recipe, inputs, '', new Date(nowMs).toISOString());
  const url = renderTemplate(authCfg.url, vars, { escape: 'url' });
  const headers = renderHeaders(authCfg.headers, vars);

  let body;
  if (authCfg.bodyTemplate) {
    body = renderTemplate(authCfg.bodyTemplate, vars, { escape: authCfg.contentType === 'form' ? 'form' : 'json' });
  }
  if (body !== undefined && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = authCfg.contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
  }

  const res = await http({
    url,
    method: authCfg.method || 'POST',
    headers,
    body,
    timeoutMs: recipe.timeoutMs || 8000,
    insecureTls: !!recipe.allowInsecureTls,
  });

  if (res.status < 200 || res.status >= 300) {
    throw Object.assign(new Error(`auth failed with status ${res.status}`), { code: 'AUTH' });
  }

  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw Object.assign(new Error('auth response was not valid JSON'), { code: 'AUTH' });
  }

  const token = getPath(json, authCfg.tokenPath || 'token');
  if (!token) {
    throw Object.assign(new Error(`token not found at "${authCfg.tokenPath || 'token'}"`), { code: 'AUTH' });
  }

  if (tokenCache && typeof tokenCache.set === 'function') {
    const ttlMs = (authCfg.tokenTtlSecs || 3600) * 1000;
    // Shave 5s off the TTL so we never hand out a token that expires mid-flight.
    tokenCache.set(cacheKey, { token: String(token), expiresAtMs: nowMs + Math.max(ttlMs - 5000, 0) });
  }

  return String(token);
}

function guestLabel(record) {
  const first = (record && record.firstName) || '';
  const last = (record && record.lastName) || '';
  const full = ((record && record.fullName) || `${first} ${last}`).trim() || 'Guest';
  const room = record && record.room ? ` · room ${record.room}` : '';
  return `${full}${room}`;
}

function reasonForError(e) {
  return e && e.code === 'TIMEOUT' ? 'timeout' : 'upstream';
}

// runLookup({ recipe, inputs, now, http, tokenCache })
//   recipe:     a validated recipe (see recipe.js)
//   inputs:     the guest's submitted answers — array-of-recipe.inputs-with-
//               `value`, or a plain { name: value } object (see template.js)
//   now:        epoch ms (defaults to Date.now()) — inject for deterministic tests
//   http:       (opts) -> {status, headers, text, ms}; default httpRequest
//   tokenCache: a makeTokenCache() Map, or any {get,set} — omit to disable caching
//
// -> { ok:true, guest:{label, record}, expiresAt }
// -> { ok:false, reason:'timeout'|'upstream'|'no-match'|'outside-window', ... }
export async function runLookup({ recipe, inputs = [], now, http = defaultHttpRequest, tokenCache } = {}) {
  const nowMs = now ?? Date.now();

  let token = '';
  if (recipe.auth) {
    try {
      token = await getToken(recipe, http, tokenCache, nowMs, inputs);
    } catch (e) {
      return { ok: false, reason: reasonForError(e) };
    }
  }

  const vars = templateVars(recipe, inputs, token, new Date(nowMs).toISOString());
  const req = applyTokenPlacement(buildRequest(recipe, vars), token, recipe.auth && recipe.auth.placement);

  let res;
  try {
    res = await http(req);
  } catch (e) {
    return { ok: false, reason: reasonForError(e) };
  }

  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: 'upstream', status: res.status };
  }

  let parsed;
  try {
    parsed = parseResponse(recipe.parse, res.text);
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  const cap = recipe.maxRecords ?? 200;
  const records = (parsed.records || []).slice(0, cap);

  const guestRecord = findGuest(recipe.match, records, inputs);
  if (!guestRecord) return { ok: false, reason: 'no-match' };

  const boundParseDate = (v) => parseDate(v, recipe.parse && recipe.parse.dateFormat);
  const win = inWindow(recipe.window, guestRecord, nowMs, boundParseDate);
  if (!win.ok) return { ok: false, reason: 'outside-window', detail: win.reason };

  return {
    ok: true,
    guest: { label: guestLabel(guestRecord), record: guestRecord },
    expiresAt: win.expiresAt,
  };
}
