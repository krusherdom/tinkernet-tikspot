// Guest-lookup "recipe" schema + validation for pluggable captive-portal login
// (Stage 0.13). A recipe describes how to talk to a hotel/venue guest system:
// how to authenticate, how to query it, how to parse the response into
// records, and how to match a portal visitor's form input against a record
// and decide whether their stay is currently active.
//
// This module is pure (no I/O, no DB) so it can be unit tested trivially and
// reused by both the admin UI (validate before save) and the portal engine
// (validate before run).

export const RECIPE_VERSION = 1;

// Fields the parser can populate directly by name. A recipe's `parse.fields`
// may also define additional (non-canonical) field names of its own — those
// are usable anywhere a canonical field is (match rules, window dates), but
// canonical names carry special meaning downstream (e.g. `guestLabel`).
export const CANONICAL_FIELDS = [
  'firstName',
  'lastName',
  'fullName',
  'room',
  'mobile',
  'email',
  'checkIn',
  'checkOut',
  'bookingRef',
];

// Value normalizers usable in match.rules[].normalize. See match.js.
export const NORMALIZERS = ['trim', 'name', 'phone', 'email', 'digits', 'upper'];

const DEFAULT_MESSAGES = {
  noMatch: 'We could not find a booking with those details.',
  outsideWindow: 'Your stay is not active yet, or has ended.',
  upstream: 'The guest system is not responding — please try again or ask at reception.',
};

const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;
const INPUT_TYPES = ['text', 'tel', 'email', 'number'];
const REQUEST_METHODS = ['GET', 'POST'];
const REQUEST_CONTENT_TYPES = ['json', 'form', 'xml', 'text'];
const AUTH_METHODS = ['GET', 'POST'];
const AUTH_CONTENT_TYPES = ['json', 'form'];
const ACCEPT_TYPES = ['json', 'xml', 'text'];
const PARSE_TYPES = ['json', 'xml', 'regex'];
const DATE_FORMATS = ['iso', 'dmy', 'mdy', 'ymd', 'epoch'];
const PLACEMENT_IN = ['header', 'query', 'body'];

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Accepts templated URLs (containing {{...}}) — we only check that the
// literal scheme prefix is http(s), not that the whole string is a valid URL.
function isHttpUrl(v) {
  return typeof v === 'string' && /^https?:\/\/\S+/i.test(v.trim());
}

function inRange(n, lo, hi) {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
}

export function emptyRecipe() {
  return {
    name: '',
    enabled: true,
    planGroup: 'free',
    timeoutMs: 8000,
    allowInsecureTls: false,
    maxRecords: 200,
    request: { method: 'GET', url: '', headers: {}, contentType: 'json', bodyTemplate: '' },
    parse: { type: 'json', root: '', fields: {}, dateFormat: 'iso' },
    match: { all: true, rules: [] },
    inputs: [],
    messages: { ...DEFAULT_MESSAGES },
    secrets: { username: '', password: '', apiKey: '' },
  };
}

// validateRecipe: normalises + validates a raw (e.g. admin-form-submitted or
// JSON-imported) recipe object.
//   -> { ok:true, value }                              on success
//   -> { ok:false, error, fields:{ 'a.b[0].c': msg } }  on failure
//
// `value` is always populated with best-effort defaults even when invalid,
// so a UI can re-render the form; `fields` carries every problem found (not
// just the first), keyed by a dotted/bracketed path into the recipe.
export function validateRecipe(obj) {
  const fields = {};
  const fail = (path, msg) => {
    fields[path] = msg;
  };

  if (!isPlainObject(obj)) {
    return { ok: false, error: 'recipe must be an object', fields: { '': 'recipe must be an object' } };
  }

  const value = {};

  // ---- name / basics ----
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    fail('name', 'name is required');
    value.name = '';
  } else if (obj.name.length > 80) {
    fail('name', 'name must be 80 characters or fewer');
    value.name = obj.name.slice(0, 80);
  } else {
    value.name = obj.name.trim();
  }

  value.enabled = obj.enabled === undefined ? true : !!obj.enabled;
  value.planGroup = typeof obj.planGroup === 'string' && obj.planGroup.trim() ? obj.planGroup.trim() : 'free';

  value.timeoutMs = obj.timeoutMs === undefined ? 8000 : Number(obj.timeoutMs);
  if (!inRange(value.timeoutMs, 1000, 30000)) {
    fail('timeoutMs', 'timeoutMs must be between 1000 and 30000');
  }

  value.allowInsecureTls = !!obj.allowInsecureTls;

  value.maxRecords = obj.maxRecords === undefined ? 200 : Number(obj.maxRecords);
  if (!Number.isFinite(value.maxRecords) || value.maxRecords < 1 || value.maxRecords > 5000) {
    fail('maxRecords', 'maxRecords must be between 1 and 5000');
  }

  // ---- inputs ----
  const rawInputs = Array.isArray(obj.inputs) ? obj.inputs : [];
  const seenNames = new Set();
  value.inputs = [];
  rawInputs.forEach((inp, i) => {
    const p = `inputs[${i}]`;
    if (!isPlainObject(inp)) {
      fail(p, 'input must be an object');
      return;
    }
    if (typeof inp.name !== 'string' || !INPUT_NAME_RE.test(inp.name)) {
      fail(`${p}.name`, 'name must start with a lowercase letter and contain only a-z, 0-9, _ (max 31 chars)');
      return;
    }
    if (seenNames.has(inp.name)) {
      fail(`${p}.name`, `duplicate input name "${inp.name}"`);
      return;
    }
    seenNames.add(inp.name);
    const type = INPUT_TYPES.includes(inp.type) ? inp.type : 'text';
    const label = typeof inp.label === 'string' && inp.label.trim() ? inp.label.trim() : inp.name;
    if (label.length > 80) fail(`${p}.label`, 'label must be 80 characters or fewer');
    const entry = {
      name: inp.name,
      label: label.slice(0, 80),
      type,
      required: !!inp.required,
      placeholder: typeof inp.placeholder === 'string' ? inp.placeholder : '',
    };
    if (typeof inp.autocomplete === 'string' && inp.autocomplete) entry.autocomplete = inp.autocomplete;
    value.inputs.push(entry);
  });
  const inputNames = new Set(value.inputs.map((i) => i.name));

  // ---- auth (optional) ----
  if (obj.auth !== undefined) {
    if (!isPlainObject(obj.auth)) {
      fail('auth', 'auth must be an object');
    } else {
      const a = obj.auth;
      if (!isHttpUrl(a.url)) fail('auth.url', 'auth.url must be an http(s) URL');
      const method = AUTH_METHODS.includes(a.method) ? a.method : 'POST';
      const contentType = AUTH_CONTENT_TYPES.includes(a.contentType) ? a.contentType : 'json';
      const ttl = Number(a.tokenTtlSecs);
      const placementIn = PLACEMENT_IN.includes(a.placement && a.placement.in) ? a.placement.in : 'header';
      value.auth = {
        method,
        url: typeof a.url === 'string' ? a.url.trim() : '',
        headers: isPlainObject(a.headers) ? { ...a.headers } : {},
        contentType,
        bodyTemplate: typeof a.bodyTemplate === 'string' ? a.bodyTemplate : '',
        tokenPath: typeof a.tokenPath === 'string' && a.tokenPath ? a.tokenPath : 'token',
        tokenTtlSecs: Number.isFinite(ttl) && ttl > 0 ? ttl : 3600,
        placement: {
          in: placementIn,
          name: typeof (a.placement && a.placement.name) === 'string' && a.placement.name ? a.placement.name : 'Authorization',
          prefix: typeof (a.placement && a.placement.prefix) === 'string' ? a.placement.prefix : 'Bearer ',
        },
      };
    }
  }

  // ---- request (required) ----
  if (!isPlainObject(obj.request)) {
    fail('request', 'request is required');
    value.request = emptyRecipe().request;
  } else {
    const r = obj.request;
    if (!isHttpUrl(r.url)) fail('request.url', 'request.url must be an http(s) URL');
    const method = REQUEST_METHODS.includes(r.method) ? r.method : 'GET';
    const contentType = REQUEST_CONTENT_TYPES.includes(r.contentType) ? r.contentType : 'json';
    const accept = ACCEPT_TYPES.includes(r.accept) ? r.accept : undefined;
    value.request = {
      method,
      url: typeof r.url === 'string' ? r.url.trim() : '',
      headers: isPlainObject(r.headers) ? { ...r.headers } : {},
      contentType,
      bodyTemplate: typeof r.bodyTemplate === 'string' ? r.bodyTemplate : '',
      ...(accept ? { accept } : {}),
    };
  }

  // ---- parse (required) ----
  let parseFieldKeys = [];
  if (!isPlainObject(obj.parse)) {
    fail('parse', 'parse is required');
    value.parse = emptyRecipe().parse;
  } else {
    const p = obj.parse;
    const type = PARSE_TYPES.includes(p.type) ? p.type : 'json';
    const dateFormat = DATE_FORMATS.includes(p.dateFormat) ? p.dateFormat : 'iso';
    const parseFields = isPlainObject(p.fields) ? { ...p.fields } : {};
    parseFieldKeys = Object.keys(parseFields);
    value.parse = {
      type,
      root: typeof p.root === 'string' ? p.root : '',
      recordRegex: typeof p.recordRegex === 'string' ? p.recordRegex : '',
      fields: parseFields,
      dateFormat,
    };
  }

  const validFieldRef = (name) => CANONICAL_FIELDS.includes(name) || parseFieldKeys.includes(name);

  // ---- match (required) ----
  if (!isPlainObject(obj.match) || !Array.isArray(obj.match.rules) || !obj.match.rules.length) {
    fail('match', 'match.rules must be a non-empty array');
    value.match = { all: true, rules: [] };
  } else {
    const rules = [];
    obj.match.rules.forEach((rule, i) => {
      const p = `match.rules[${i}]`;
      if (!isPlainObject(rule)) {
        fail(p, 'rule must be an object');
        return;
      }
      if (typeof rule.input !== 'string' || !inputNames.has(rule.input)) {
        fail(`${p}.input`, `input "${rule.input}" is not a declared input`);
        return;
      }
      const normalize = rule.normalize === undefined ? 'trim' : rule.normalize;
      if (!NORMALIZERS.includes(normalize)) {
        fail(`${p}.normalize`, `unknown normalizer "${rule.normalize}"`);
        return;
      }
      if (Array.isArray(rule.anyOf) && rule.anyOf.length) {
        const bad = rule.anyOf.filter((f) => !validFieldRef(f));
        if (bad.length) {
          fail(`${p}.anyOf`, `unknown field(s): ${bad.join(', ')}`);
          return;
        }
        rules.push({ input: rule.input, anyOf: [...rule.anyOf], normalize });
      } else if (typeof rule.field === 'string') {
        if (!validFieldRef(rule.field)) {
          fail(`${p}.field`, `unknown field "${rule.field}"`);
          return;
        }
        rules.push({ input: rule.input, field: rule.field, normalize });
      } else {
        fail(p, 'rule must have a "field" or non-empty "anyOf"');
      }
    });
    value.match = { all: obj.match.all === false ? false : true, rules };
  }

  // ---- window (optional) ----
  if (obj.window !== undefined) {
    if (!isPlainObject(obj.window)) {
      fail('window', 'window must be an object');
    } else {
      const w = obj.window;
      const startOk = typeof w.start === 'string' && parseFieldKeys.includes(w.start);
      const endOk = typeof w.end === 'string' && parseFieldKeys.includes(w.end);
      if (!startOk) fail('window.start', 'window.start must be one of parse.fields');
      if (!endOk) fail('window.end', 'window.end must be one of parse.fields');
      const leewayHours = w.leewayHours === undefined ? 24 : Number(w.leewayHours);
      if (!inRange(leewayHours, 0, 720)) fail('window.leewayHours', 'leewayHours must be between 0 and 720');
      const maxGrantHours = w.maxGrantHours === undefined ? 168 : Number(w.maxGrantHours);
      if (!inRange(maxGrantHours, 1, 8760)) fail('window.maxGrantHours', 'maxGrantHours must be between 1 and 8760');
      value.window = {
        start: startOk ? w.start : '',
        end: endOk ? w.end : '',
        leewayHours: inRange(leewayHours, 0, 720) ? leewayHours : 24,
        maxGrantHours: inRange(maxGrantHours, 1, 8760) ? maxGrantHours : 168,
      };
    }
  }

  // ---- messages ----
  const m = isPlainObject(obj.messages) ? obj.messages : {};
  value.messages = {
    noMatch: typeof m.noMatch === 'string' && m.noMatch ? m.noMatch : DEFAULT_MESSAGES.noMatch,
    outsideWindow: typeof m.outsideWindow === 'string' && m.outsideWindow ? m.outsideWindow : DEFAULT_MESSAGES.outsideWindow,
    upstream: typeof m.upstream === 'string' && m.upstream ? m.upstream : DEFAULT_MESSAGES.upstream,
  };

  // ---- secrets (shape-only; values are opaque credentials) ----
  const s = isPlainObject(obj.secrets) ? obj.secrets : {};
  value.secrets = {
    username: typeof s.username === 'string' ? s.username : '',
    password: typeof s.password === 'string' ? s.password : '',
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
  };

  if (obj.id !== undefined) value.id = obj.id;
  value.version = RECIPE_VERSION;

  const errorKeys = Object.keys(fields);
  if (errorKeys.length) {
    return { ok: false, error: fields[errorKeys[0]], fields };
  }
  return { ok: true, value };
}

// Returns a shallow copy of a (validated) recipe with secret values blanked —
// safe to hand to the admin UI, logs, or anywhere else outside the engine.
export function stripSecrets(recipe) {
  if (!recipe || typeof recipe !== 'object') return recipe;
  const { secrets, ...rest } = recipe;
  return { ...rest, secrets: { username: '', password: '', apiKey: '' } };
}
