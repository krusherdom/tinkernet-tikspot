// Orchestrates a guest-lookup run: optional token auth (cached), one or more
// HTTP steps (a v1 recipe is a single synthesized step; a v2 recipe may
// declare `steps[]`, including per-record `forEach` enrichment), response
// parsing, guest matching, and stay-window checking. Pure aside from the
// injected `http` (default httpRequest) and `tokenCache`, so it's fully
// testable with a stub transport.
//
// runLookup(...) never returns or throws secrets or the bearer token — only
// `{ ok, guest, expiresAt }` on success or `{ ok:false, reason, ... }` on
// failure (plus an opt-in `steps` diagnostics array — see `diagnostics`
// below). The DB-backed RADIUS credential minting is NOT this module's job;
// the caller does that with the returned `expiresAt`.

import { renderTemplate, renderJsonTemplate, templateVars } from './template.js';
import { getPath, parseResponse, parseDate } from './parsers.js';
import { findGuest, inWindow } from './match.js';
import { httpRequest as defaultHttpRequest } from './http.js';

// A Map-based token cache: key -> { token, expiresAtMs }. Callers should keep
// one instance per process (or per recipe store) and pass it into every
// runLookup call so tokens are reused across guests until they expire.
export function makeTokenCache() {
  return new Map();
}

const REQUEST_CAP = 25; // hard cap on outbound guest-system HTTP calls per lookup (excludes the auth token call)

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

function buildStepRequest(recipe, step, vars) {
  const r = step.request;
  const url = renderTemplate(r.url, vars, { escape: 'url' });
  const headers = renderHeaders(r.headers, vars);

  let body;
  if (r.bodyJson !== undefined) {
    const omitEmpty = r.omitEmpty === false ? false : true; // default true for request bodies
    body = JSON.stringify(renderJsonTemplate(r.bodyJson, vars, { omitEmpty }));
  } else if (r.bodyTemplate) {
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
// directly in their bodyTemplate/bodyJson instead — see README notes in
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

function tokenCacheKey(recipe) {
  return recipe.id || recipe.name || 'default';
}

// fetchToken: fetches (or, unless forceRefresh, reuses a cached) auth token.
// Returns { token, fromCache }: `fromCache` tells the caller whether this
// token came from the cache (relevant for the 401/403 retry policy below —
// we only invalidate + retry when the token we just tried was a stale cached
// one, not a token we just minted fresh this call).
async function fetchToken(recipe, http, tokenCache, nowMs, inputs, forceRefresh) {
  const authCfg = recipe.auth;
  const cacheKey = tokenCacheKey(recipe);

  if (!forceRefresh && tokenCache && typeof tokenCache.get === 'function') {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) return { token: cached.token, fromCache: true };
  }

  const vars = templateVars(recipe, inputs, '', new Date(nowMs).toISOString());
  const url = renderTemplate(authCfg.url, vars, { escape: 'url' });
  const headers = renderHeaders(authCfg.headers, vars);

  let body;
  if (authCfg.bodyJson !== undefined) {
    const omitEmpty = authCfg.omitEmpty === true; // default false for auth bodies
    body = JSON.stringify(renderJsonTemplate(authCfg.bodyJson, vars, { omitEmpty }));
  } else if (authCfg.bodyTemplate) {
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
    let expiresAtMs = nowMs + Math.max(ttlMs - 5000, 0);
    if (authCfg.tokenExpiryPath) {
      const rawExpiry = getPath(json, authCfg.tokenExpiryPath);
      const parsedExpiry = parseDate(rawExpiry, 'iso');
      if (parsedExpiry != null) {
        // Cache until 60s before the server-declared expiry, but never later
        // than the ttl-based bound above.
        expiresAtMs = Math.min(expiresAtMs, parsedExpiry - 60000);
      }
    }
    tokenCache.set(cacheKey, { token: String(token), expiresAtMs });
  }

  return { token: String(token), fromCache: false };
}

function stepVars(recipe, inputs, token, nowIso, stepResults, record) {
  const vars = templateVars(recipe, inputs, token, nowIso);
  vars.steps = stepResults;
  if (record !== undefined) vars.record = record;
  return vars;
}

// Fires one HTTP request for `step` (optionally bound to a forEach `record`),
// counting it against the shared per-lookup request cap. Throws a
// REQUEST_CAP-coded error instead of firing once the cap is reached.
async function fireStep(recipe, step, vars, http, requestState) {
  if (requestState.n >= requestState.cap) {
    throw Object.assign(new Error('request cap exceeded'), { code: 'REQUEST_CAP' });
  }
  requestState.n += 1;
  const req = applyTokenPlacement(buildStepRequest(recipe, step, vars), vars.token, recipe.auth && recipe.auth.placement);
  return http(req);
}

// Fires a step's request, retrying once (with a freshly-minted token) if the
// response is 401/403 AND the token we used came from the cache (a token we
// *just* minted this run failing again isn't worth a second round-trip).
async function fireStepWithReauth({ recipe, step, inputs, nowMs, nowIso, stepResults, record, token, tokenFromCache, http, tokenCache, requestState }) {
  let currentToken = token;
  let currentFromCache = tokenFromCache;
  let vars = stepVars(recipe, inputs, currentToken, nowIso, stepResults, record);
  let res = await fireStep(recipe, step, vars, http, requestState);

  if ((res.status === 401 || res.status === 403) && recipe.auth && currentFromCache) {
    if (tokenCache && typeof tokenCache.delete === 'function') tokenCache.delete(tokenCacheKey(recipe));
    const refreshed = await fetchToken(recipe, http, tokenCache, nowMs, inputs, true);
    currentToken = refreshed.token;
    currentFromCache = false;
    vars = stepVars(recipe, inputs, currentToken, nowIso, stepResults, record);
    res = await fireStep(recipe, step, vars, http, requestState);
  }

  return { res, token: currentToken, fromCache: currentFromCache };
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

function withSteps(result, diagnostics, stepDiag) {
  if (!diagnostics) return result;
  return { ...result, steps: stepDiag };
}

// runLookup({ recipe, inputs, now, http, tokenCache, diagnostics })
//   recipe:      a validated recipe (see recipe.js) — v1 (single request+
//                parse) or v2 (steps[])
//   inputs:      the guest's submitted answers — array-of-recipe.inputs-with-
//                `value`, or a plain { name: value } object (see template.js)
//   now:         epoch ms (defaults to Date.now()) — inject for deterministic tests
//   http:        (opts) -> {status, headers, text, ms}; default httpRequest
//   tokenCache:  a makeTokenCache() Map, or any {get,set,delete} — omit to disable caching
//   diagnostics: when true, adds `steps: [{name, status, ms, records}]` to
//                the result (records is a count, never the response body) —
//                used by the admin "test this recipe" endpoint only, never
//                by the portal lookup path.
//
// -> { ok:true, guest:{label, record}, expiresAt }
// -> { ok:false, reason:'timeout'|'upstream'|'no-match'|'outside-window', ... }
export async function runLookup({ recipe, inputs = [], now, http = defaultHttpRequest, tokenCache, diagnostics = false } = {}) {
  const nowMs = now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  let token = '';
  let tokenFromCache = false;
  if (recipe.auth) {
    try {
      const res = await fetchToken(recipe, http, tokenCache, nowMs, inputs, false);
      token = res.token;
      tokenFromCache = res.fromCache;
    } catch (e) {
      return { ok: false, reason: reasonForError(e) };
    }
  }

  const steps =
    Array.isArray(recipe.steps) && recipe.steps.length
      ? recipe.steps
      : [{ name: 'main', request: recipe.request, parse: recipe.parse }];

  const maxFanOut = Number.isFinite(recipe.maxFanOut) && recipe.maxFanOut > 0 ? recipe.maxFanOut : 10;
  const requestState = { n: 0, cap: REQUEST_CAP };
  const stepResults = {};
  const stepDiag = [];
  let candidateRecords = [];
  let lastParse = recipe.parse;

  for (const step of steps) {
    const t0 = Date.now();

    if (step.forEach) {
      const parents = (stepResults[step.forEach] && stepResults[step.forEach].records) || [];
      const toEnrich = parents.slice(0, maxFanOut);
      let failure = null;

      for (const parentRecord of toEnrich) {
        try {
          const fired = await fireStepWithReauth({
            recipe,
            step,
            inputs,
            nowMs,
            nowIso,
            stepResults,
            record: parentRecord,
            token,
            tokenFromCache,
            http,
            tokenCache,
            requestState,
          });
          token = fired.token;
          tokenFromCache = fired.fromCache;

          if (fired.res.status < 200 || fired.res.status >= 300) {
            throw Object.assign(new Error(`step "${step.name}" failed with status ${fired.res.status}`), {
              code: 'STEP_HTTP',
              status: fired.res.status,
            });
          }
          let parsed;
          try {
            parsed = parseResponse(step.parse, fired.res.text);
          } catch {
            throw Object.assign(new Error(`step "${step.name}" response could not be parsed`), { code: 'STEP_PARSE' });
          }
          const first = parsed.records && parsed.records[0];
          if (first) {
            for (const [k, v] of Object.entries(first)) {
              if (parentRecord[k] === undefined || parentRecord[k] === null || parentRecord[k] === '') {
                parentRecord[k] = v;
              }
            }
          }
        } catch (e) {
          if (e && e.code === 'REQUEST_CAP') {
            stepDiag.push({ name: step.name, status: 'error', ms: Date.now() - t0, records: parents.length });
            return withSteps({ ok: false, reason: 'upstream', detail: 'request-cap' }, diagnostics, stepDiag);
          }
          if (step.optional) continue; // ignore this record's enrichment failure, try the next
          failure = e;
          break;
        }
      }

      if (failure) {
        stepDiag.push({ name: step.name, status: 'error', ms: Date.now() - t0, records: parents.length });
        if (failure.code === 'STEP_HTTP') {
          return withSteps({ ok: false, reason: 'upstream', status: failure.status }, diagnostics, stepDiag);
        }
        if (failure.code === 'STEP_PARSE') {
          return withSteps({ ok: false, reason: 'upstream' }, diagnostics, stepDiag);
        }
        return withSteps({ ok: false, reason: reasonForError(failure) }, diagnostics, stepDiag);
      }

      stepResults[step.name] = { records: parents };
      stepDiag.push({ name: step.name, status: 'ok', ms: Date.now() - t0, records: parents.length });
    } else {
      try {
        const fired = await fireStepWithReauth({
          recipe,
          step,
          inputs,
          nowMs,
          nowIso,
          stepResults,
          record: undefined,
          token,
          tokenFromCache,
          http,
          tokenCache,
          requestState,
        });
        token = fired.token;
        tokenFromCache = fired.fromCache;

        if (fired.res.status < 200 || fired.res.status >= 300) {
          throw Object.assign(new Error(`step "${step.name}" failed with status ${fired.res.status}`), {
            code: 'STEP_HTTP',
            status: fired.res.status,
          });
        }
        let parsed;
        try {
          parsed = parseResponse(step.parse, fired.res.text);
        } catch {
          throw Object.assign(new Error(`step "${step.name}" response could not be parsed`), { code: 'STEP_PARSE' });
        }
        const records = parsed.records || [];
        stepResults[step.name] = { records };
        candidateRecords = records;
        lastParse = step.parse;
        stepDiag.push({ name: step.name, status: 'ok', ms: Date.now() - t0, records: records.length });
      } catch (e) {
        if (e && e.code === 'REQUEST_CAP') {
          stepDiag.push({ name: step.name, status: 'error', ms: Date.now() - t0, records: 0 });
          return withSteps({ ok: false, reason: 'upstream', detail: 'request-cap' }, diagnostics, stepDiag);
        }
        if (step.optional) {
          stepResults[step.name] = { records: [] };
          candidateRecords = [];
          lastParse = step.parse;
          stepDiag.push({ name: step.name, status: 'skipped', ms: Date.now() - t0, records: 0 });
          continue;
        }
        stepDiag.push({ name: step.name, status: 'error', ms: Date.now() - t0, records: 0 });
        if (e.code === 'STEP_HTTP') {
          return withSteps({ ok: false, reason: 'upstream', status: e.status }, diagnostics, stepDiag);
        }
        if (e.code === 'STEP_PARSE') {
          return withSteps({ ok: false, reason: 'upstream' }, diagnostics, stepDiag);
        }
        return withSteps({ ok: false, reason: reasonForError(e) }, diagnostics, stepDiag);
      }
    }
  }

  const cap = recipe.maxRecords ?? 200;
  const records = candidateRecords.slice(0, cap);

  const guestRecord = findGuest(recipe.match, records, inputs);
  if (!guestRecord) return withSteps({ ok: false, reason: 'no-match' }, diagnostics, stepDiag);

  const boundParseDate = (v) => parseDate(v, lastParse && lastParse.dateFormat);
  const win = inWindow(recipe.window, guestRecord, nowMs, boundParseDate);
  if (!win.ok) return withSteps({ ok: false, reason: 'outside-window', detail: win.reason }, diagnostics, stepDiag);

  return withSteps(
    {
      ok: true,
      guest: { label: guestLabel(guestRecord), record: guestRecord },
      expiresAt: win.expiresAt,
    },
    diagnostics,
    stepDiag,
  );
}
