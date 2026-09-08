// Guest-lookup "recipe" schema + validation for pluggable captive-portal login
// (Stage 0.13, expanded in 0.15). A recipe describes how to talk to a
// hotel/venue guest system: how to authenticate, how to query it (optionally
// as a sequence of steps), how to parse the response into records, and how
// to match a portal visitor's form input against a record and decide
// whether their stay is currently active.
//
// This module is pure (no I/O, no DB) so it can be unit tested trivially and
// reused by both the admin UI (validate before save) and the portal engine
// (validate before run).
//
// v2 additions (all additive/backwards-compatible with v1 recipes):
//   - secretKeys/secretLabels: recipes can declare their own named secrets
//     instead of the fixed username/password/apiKey trio.
//   - params/paramValues: non-secret operator-configurable values, exported
//     with the recipe (unlike secrets).
//   - request.bodyJson / auth.bodyJson: structured JSON request bodies.
//   - steps[]: a sequence of HTTP requests (with optional per-record
//     forEach fan-out) instead of a single request+parse.
//   - match.minRules: require at least N *matched, non-empty* rules.
//   - auth.tokenExpiryPath / auth.bodyJson.
//   - parse.dateFormat: 'sql'.

export const RECIPE_VERSION = 2;

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

const DEFAULT_SECRET_KEYS = ['username', 'password', 'apiKey'];

const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;
const INPUT_TYPES = ['text', 'tel', 'email', 'number'];
const SECRET_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,30}$/;
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,30}$/;
const PARAM_TYPES = ['text', 'number', 'boolean', 'select'];
const STEP_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;
const MAX_SECRET_KEYS = 16;
const MAX_PARAMS = 24;
const MAX_STEPS = 4;
const REQUEST_METHODS = ['GET', 'POST'];
const REQUEST_CONTENT_TYPES = ['json', 'form', 'xml', 'text'];
const AUTH_METHODS = ['GET', 'POST'];
const AUTH_CONTENT_TYPES = ['json', 'form'];
const ACCEPT_TYPES = ['json', 'xml', 'text'];
const PARSE_TYPES = ['json', 'xml', 'regex'];
const DATE_FORMATS = ['iso', 'dmy', 'mdy', 'ymd', 'epoch', 'sql'];
const PLACEMENT_IN = ['header', 'query', 'body'];

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Accepts templated URLs (containing {{...}}) — we only check that the
// literal scheme prefix is http(s), not that the whole string is a valid
// URL. A URL may also start with a `{{...}}` placeholder (e.g.
// `{{param.baseUrl}}/authToken`, letting a recipe parameterise the entire
// host/region — see the RMS Cloud recipes) — we can't check the scheme
// literally in that case, so we trust the admin-authored recipe to resolve
// it to an http(s) base at render time.
function isHttpUrl(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return /^https?:\/\/\S+/i.test(s) || /^\{\{\s*[a-zA-Z0-9_.[\]]+\s*\}\}/.test(s);
}

function inRange(n, lo, hi) {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
}

function emptyRequest() {
  return { method: 'GET', url: '', headers: {}, contentType: 'json', bodyTemplate: '' };
}

function emptyParse() {
  return { type: 'json', root: '', fields: {}, dateFormat: 'iso' };
}

export function emptyRecipe() {
  return {
    name: '',
    enabled: true,
    planGroup: 'free',
    timeoutMs: 8000,
    allowInsecureTls: false,
    maxRecords: 200,
    secretKeys: [...DEFAULT_SECRET_KEYS],
    params: {},
    paramValues: {},
    request: emptyRequest(),
    parse: emptyParse(),
    match: { all: true, rules: [] },
    inputs: [],
    messages: { ...DEFAULT_MESSAGES },
    secrets: { username: '', password: '', apiKey: '' },
  };
}

// Applies request.bodyJson / auth.bodyJson (shared shape) onto an
// already-built request-like `result` object. Forces contentType to 'json'
// when bodyJson is present, and copies an explicit boolean `omitEmpty`.
function applyBodyJson(raw, result, path, fail) {
  if (raw.bodyJson === undefined) return;
  if (!isPlainObject(raw.bodyJson) && !Array.isArray(raw.bodyJson)) {
    fail(`${path}.bodyJson`, `${path}.bodyJson must be a JSON object or array`);
    return;
  }
  try {
    result.bodyJson = JSON.parse(JSON.stringify(raw.bodyJson));
  } catch {
    fail(`${path}.bodyJson`, `${path}.bodyJson must be JSON-serialisable`);
    return;
  }
  result.contentType = 'json';
  if (typeof raw.omitEmpty === 'boolean') result.omitEmpty = raw.omitEmpty;
}

// Validates a `request`-shaped object (used for the top-level `request` and
// every `steps[].request`).
function validateRequestBlock(r, path, fail) {
  if (!isHttpUrl(r.url)) fail(`${path}.url`, `${path}.url must be an http(s) URL`);
  const method = REQUEST_METHODS.includes(r.method) ? r.method : 'GET';
  const contentType = REQUEST_CONTENT_TYPES.includes(r.contentType) ? r.contentType : 'json';
  const accept = ACCEPT_TYPES.includes(r.accept) ? r.accept : undefined;
  const result = {
    method,
    url: typeof r.url === 'string' ? r.url.trim() : '',
    headers: isPlainObject(r.headers) ? { ...r.headers } : {},
    contentType,
    bodyTemplate: typeof r.bodyTemplate === 'string' ? r.bodyTemplate : '',
  };
  if (accept) result.accept = accept;
  applyBodyJson(r, result, path, fail);
  return result;
}

// Validates a `parse`-shaped object (used for the top-level `parse` and
// every `steps[].parse`). Returns the normalised block; the caller collects
// `Object.keys(result.fields)` into the union used for match/window refs.
function validateParseBlock(p, path, fail) {
  const type = PARSE_TYPES.includes(p.type) ? p.type : 'json';
  const dateFormat = DATE_FORMATS.includes(p.dateFormat) ? p.dateFormat : 'iso';
  const fields = isPlainObject(p.fields) ? { ...p.fields } : {};
  return {
    type,
    root: typeof p.root === 'string' ? p.root : '',
    recordRegex: typeof p.recordRegex === 'string' ? p.recordRegex : '',
    fields,
    dateFormat,
  };
}

function validateAuthBlock(a, path, fail) {
  if (!isHttpUrl(a.url)) fail(`${path}.url`, `${path}.url must be an http(s) URL`);
  const method = AUTH_METHODS.includes(a.method) ? a.method : 'POST';
  const contentType = AUTH_CONTENT_TYPES.includes(a.contentType) ? a.contentType : 'json';
  const ttl = Number(a.tokenTtlSecs);
  const placementIn = PLACEMENT_IN.includes(a.placement && a.placement.in) ? a.placement.in : 'header';
  const result = {
    method,
    url: typeof a.url === 'string' ? a.url.trim() : '',
    headers: isPlainObject(a.headers) ? { ...a.headers } : {},
    contentType,
    bodyTemplate: typeof a.bodyTemplate === 'string' ? a.bodyTemplate : '',
    tokenPath: typeof a.tokenPath === 'string' && a.tokenPath ? a.tokenPath : 'token',
    tokenExpiryPath: typeof a.tokenExpiryPath === 'string' && a.tokenExpiryPath.trim() ? a.tokenExpiryPath.trim() : '',
    tokenTtlSecs: Number.isFinite(ttl) && ttl > 0 ? ttl : 3600,
    placement: {
      in: placementIn,
      name: typeof (a.placement && a.placement.name) === 'string' && a.placement.name ? a.placement.name : 'Authorization',
      prefix: typeof (a.placement && a.placement.prefix) === 'string' ? a.placement.prefix : 'Bearer ',
    },
  };
  applyBodyJson(a, result, path, fail);
  return result;
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

  value.maxFanOut = obj.maxFanOut === undefined ? 10 : Number(obj.maxFanOut);
  if (!inRange(value.maxFanOut, 1, 25)) {
    fail('maxFanOut', 'maxFanOut must be between 1 and 25');
    value.maxFanOut = 10;
  }

  // ---- declared secrets ----
  let secretKeys;
  if (obj.secretKeys === undefined) {
    secretKeys = [...DEFAULT_SECRET_KEYS];
  } else if (!Array.isArray(obj.secretKeys)) {
    fail('secretKeys', 'secretKeys must be an array of strings');
    secretKeys = [...DEFAULT_SECRET_KEYS];
  } else {
    const seen = new Set();
    const keys = [];
    obj.secretKeys.forEach((k, i) => {
      const p = `secretKeys[${i}]`;
      if (typeof k !== 'string' || !SECRET_KEY_RE.test(k)) {
        fail(p, 'secret key must start with a letter and contain only a-z, A-Z, 0-9, _ (max 31 chars)');
        return;
      }
      if (seen.has(k)) {
        fail(p, `duplicate secret key "${k}"`);
        return;
      }
      seen.add(k);
      keys.push(k);
    });
    if (keys.length > MAX_SECRET_KEYS) {
      fail('secretKeys', `secretKeys supports at most ${MAX_SECRET_KEYS} keys`);
    }
    secretKeys = keys.slice(0, MAX_SECRET_KEYS);
  }
  value.secretKeys = secretKeys;

  const secretLabels = {};
  if (obj.secretLabels !== undefined) {
    if (!isPlainObject(obj.secretLabels)) {
      fail('secretLabels', 'secretLabels must be an object');
    } else {
      for (const [k, v] of Object.entries(obj.secretLabels)) {
        if (typeof v === 'string' && v.trim()) secretLabels[k] = v.trim().slice(0, 80);
      }
    }
  }
  value.secretLabels = secretLabels;

  // ---- non-secret parameters ----
  const params = {};
  if (obj.params !== undefined) {
    if (!isPlainObject(obj.params)) {
      fail('params', 'params must be an object');
    } else {
      const names = Object.keys(obj.params);
      if (names.length > MAX_PARAMS) fail('params', `params supports at most ${MAX_PARAMS} entries`);
      names.slice(0, MAX_PARAMS).forEach((name) => {
        const p = `params.${name}`;
        if (!PARAM_NAME_RE.test(name)) {
          fail(p, 'param name must start with a letter and contain only a-z, A-Z, 0-9, _ (max 31 chars)');
          return;
        }
        const def = obj.params[name];
        if (!isPlainObject(def)) {
          fail(p, 'param definition must be an object');
          return;
        }
        const type = PARAM_TYPES.includes(def.type) ? def.type : 'text';
        const label = typeof def.label === 'string' && def.label.trim() ? def.label.trim().slice(0, 80) : name;
        const entry = { label, type };
        if (typeof def.help === 'string' && def.help.trim()) entry.help = def.help.trim().slice(0, 300);
        if (def.default !== undefined) entry.default = def.default;
        if (type === 'select') {
          const options = Array.isArray(def.options)
            ? def.options
                .filter((o) => isPlainObject(o) && o.value !== undefined)
                .map((o) => ({ value: o.value, label: typeof o.label === 'string' && o.label ? o.label : String(o.value) }))
            : [];
          if (!options.length) fail(`${p}.options`, 'select params need at least one option');
          entry.options = options;
        }
        params[name] = entry;
      });
    }
  }
  value.params = params;

  // paramValues: coerced by declared param type. Missing -> default.
  const rawParamValues = isPlainObject(obj.paramValues) ? obj.paramValues : {};
  value.paramValues = {};
  Object.entries(params).forEach(([name, def]) => {
    const p = `paramValues.${name}`;
    const hasRaw = Object.prototype.hasOwnProperty.call(rawParamValues, name);
    let raw = hasRaw ? rawParamValues[name] : undefined;
    const rawIsEmpty = raw === undefined || raw === null || raw === '';
    if (rawIsEmpty) {
      raw = def.default !== undefined ? def.default : def.type === 'boolean' ? false : '';
    }

    if (def.type === 'number') {
      if (raw === '' || raw === undefined || raw === null) {
        value.paramValues[name] = '';
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          fail(p, `${name} must be a number`);
          value.paramValues[name] = '';
        } else {
          value.paramValues[name] = n;
        }
      }
    } else if (def.type === 'boolean') {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') {
        value.paramValues[name] = true;
      } else if (raw === false || raw === 'false' || raw === 0 || raw === '0' || raw === '' || raw === undefined) {
        value.paramValues[name] = false;
      } else {
        fail(p, `${name} must be a boolean`);
        value.paramValues[name] = false;
      }
    } else if (def.type === 'select') {
      const options = def.options || [];
      if (raw === '' || raw === undefined || raw === null) {
        value.paramValues[name] = '';
      } else {
        const found = options.find((o) => String(o.value) === String(raw));
        if (!found) {
          fail(p, `${name} must be one of the declared options`);
          value.paramValues[name] = '';
        } else {
          value.paramValues[name] = found.value;
        }
      }
    } else {
      value.paramValues[name] = raw == null ? '' : String(raw);
    }
  });

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
      value.auth = validateAuthBlock(obj.auth, 'auth', fail);
    }
  }

  // ---- request/parse OR steps ----
  const hasSteps = Array.isArray(obj.steps) && obj.steps.length > 0;
  let parseFieldKeys = [];

  if (!hasSteps) {
    if (!isPlainObject(obj.request)) {
      fail('request', 'request is required');
      value.request = emptyRequest();
    } else {
      value.request = validateRequestBlock(obj.request, 'request', fail);
    }

    if (!isPlainObject(obj.parse)) {
      fail('parse', 'parse is required');
      value.parse = emptyParse();
    } else {
      value.parse = validateParseBlock(obj.parse, 'parse', fail);
      parseFieldKeys = Object.keys(value.parse.fields);
    }
  } else {
    // Steps present: top-level request/parse are optional, but validated if given.
    if (obj.request !== undefined) {
      if (!isPlainObject(obj.request)) fail('request', 'request must be an object');
      else value.request = validateRequestBlock(obj.request, 'request', fail);
    }
    if (obj.parse !== undefined) {
      if (!isPlainObject(obj.parse)) fail('parse', 'parse must be an object');
      else {
        value.parse = validateParseBlock(obj.parse, 'parse', fail);
        parseFieldKeys = Object.keys(value.parse.fields);
      }
    }

    if (obj.steps.length > MAX_STEPS) {
      fail('steps', `steps supports at most ${MAX_STEPS} steps`);
    }
    const stepNames = new Set(); // names of already-processed (earlier) steps
    const steps = [];
    obj.steps.slice(0, MAX_STEPS).forEach((step, i) => {
      const p = `steps[${i}]`;
      if (!isPlainObject(step)) {
        fail(p, 'step must be an object');
        return;
      }
      if (typeof step.name !== 'string' || !STEP_NAME_RE.test(step.name)) {
        fail(`${p}.name`, 'step name must start with a lowercase letter and contain only a-z, 0-9, _ (max 31 chars)');
        return;
      }
      if (stepNames.has(step.name)) {
        fail(`${p}.name`, `duplicate step name "${step.name}"`);
        return;
      }

      let forEachName;
      if (step.forEach !== undefined) {
        if (typeof step.forEach !== 'string' || !stepNames.has(step.forEach)) {
          fail(`${p}.forEach`, 'forEach must reference an earlier step name');
        } else {
          forEachName = step.forEach;
        }
      }

      stepNames.add(step.name);

      let request;
      if (!isPlainObject(step.request)) {
        fail(`${p}.request`, 'request is required');
        request = emptyRequest();
      } else {
        request = validateRequestBlock(step.request, `${p}.request`, fail);
      }

      let parse;
      if (!isPlainObject(step.parse)) {
        fail(`${p}.parse`, 'parse is required');
        parse = emptyParse();
      } else {
        parse = validateParseBlock(step.parse, `${p}.parse`, fail);
        parseFieldKeys.push(...Object.keys(parse.fields));
      }

      const entry = { name: step.name, request, parse };
      if (forEachName) entry.forEach = forEachName;
      if (step.optional !== undefined) entry.optional = !!step.optional;
      steps.push(entry);
    });
    value.steps = steps;
  }

  const validFieldRef = (name) => CANONICAL_FIELDS.includes(name) || parseFieldKeys.includes(name);

  // ---- match (required) ----
  if (!isPlainObject(obj.match) || !Array.isArray(obj.match.rules) || !obj.match.rules.length) {
    fail('match', 'match.rules must be a non-empty array');
    value.match = { all: true, rules: [], minRules: 0 };
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
    let minRules = obj.match.minRules === undefined ? 0 : Number(obj.match.minRules);
    if (!Number.isInteger(minRules) || minRules < 0 || minRules > rules.length) {
      fail('match.minRules', `match.minRules must be an integer between 0 and ${rules.length}`);
      minRules = 0;
    }
    value.match = { all: obj.match.all === false ? false : true, rules, minRules };
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

  // ---- secrets (shape-only; values are opaque credentials) — exactly the declared keys ----
  const s = isPlainObject(obj.secrets) ? obj.secrets : {};
  value.secrets = {};
  for (const k of secretKeys) {
    value.secrets[k] = typeof s[k] === 'string' ? s[k] : '';
  }

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
// Blanks every key in recipe.secretKeys (falling back to the v1 default trio
// when secretKeys is absent, e.g. for a not-yet-revalidated raw v1 object).
export function stripSecrets(recipe) {
  if (!recipe || typeof recipe !== 'object') return recipe;
  const { secrets, ...rest } = recipe;
  const keys = Array.isArray(recipe.secretKeys) && recipe.secretKeys.length ? recipe.secretKeys : DEFAULT_SECRET_KEYS;
  const blanked = {};
  for (const k of keys) blanked[k] = '';
  return { ...rest, secrets: blanked };
}
