// Tiny mustache-ish string templating for recipe URLs/headers/bodies.
// Deliberately minimal: only `{{a.b}}` variable interpolation (plus `[n]`
// array indexing, via parsers.js's getPath), no logic, loops, or partials —
// recipes are data, not code.
//
// renderJsonTemplate additionally supports typed placeholders
// (`{{int:a.b}}`, `{{number:a.b}}`, `{{bool:a.b}}`, `{{raw:a.b}}`,
// `{{string:a.b}}`) for building structured JSON request bodies — see
// request.bodyJson / auth.bodyJson in recipe.js.
//
// 0.16: a small set of string HELPERS work everywhere renderTemplate runs
// (URLs, headers, bodyTemplate) AND inside renderJsonTemplate string leaves
// that aren't an exact typed placeholder:
//   {{base64:path}}      base64 of the UTF-8 value
//   {{lower:path}}, {{upper:path}}, {{trim:path}}
//   {{urlencode:path}}   encodeURIComponent, inserted as-is (never re-escaped)
//   {{digits:path}}      digits only
//   {{date:<offset>}} / {{date:<offset>:<fmt>}}
//                         ISO-8601 UTC timestamp of now + offset; offset is
//                         `[+-]<int><unit>` (m/h/d), fmt is iso (default) |
//                         ymd | sql | epoch
//   {{today}}             shorthand for {{date:0d:ymd}}
// Helpers always render a string; an unknown helper name renders ''.
// `now`/`today` are derived from the vars bag's own `now` (which callers —
// engine.js's templateVars — derive from the injected `nowMs`), so tests
// stay deterministic.

import { getPath } from './parsers.js';

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.[\]*:+-]+)\s*\}\}/g;
const TYPED_PLACEHOLDER_RE = /^\{\{\s*(int|number|bool|raw|string):([a-zA-Z0-9_.[\]*]+)\s*\}\}$/;

// True for a string that is EXACTLY one typed placeholder (`{{int:a.b}}`
// etc.) — the one case renderJsonTemplate coerces to a real JS value instead
// of running it through renderTemplate. Exported so recipe.js's best-effort
// unknown-helper scan of bodyJson leaves can skip these (they're not helpers).
export function isTypedPlaceholder(str) {
  return typeof str === 'string' && TYPED_PLACEHOLDER_RE.test(str.trim());
}

const KNOWN_HELPERS = ['base64', 'lower', 'upper', 'trim', 'urlencode', 'digits', 'date'];
const DATE_OFFSET_RE = /^([+-]?)(\d{1,6})([mhd])$/;
const DATE_FMTS = ['iso', 'ymd', 'sql', 'epoch'];
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function getVar(vars, path) {
  const v = getPath(vars, path);
  return v == null ? '' : v;
}

// The "now" a template run is anchored to: parsed back out of vars.now (an
// ISO string templateVars derives from the injected nowMs), falling back to
// the real clock only when vars.now is absent/unparseable (e.g. a test
// calling renderTemplate directly without building vars via templateVars).
function helperNowMs(vars) {
  const iso = vars && vars.now;
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

function formatDateMs(ms, fmt) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  switch (fmt) {
    case 'ymd':
      return d.toISOString().slice(0, 10);
    case 'sql':
      return d.toISOString().slice(0, 19).replace('T', ' ');
    case 'epoch':
      return String(Math.floor(ms / 1000));
    case 'iso':
    default:
      return d.toISOString();
  }
}

// `rest` is everything after "date:" — either `<offset>` or `<offset>:<fmt>`.
function evalDateHelper(rest, vars) {
  const idx = rest.indexOf(':');
  const offsetStr = idx === -1 ? rest : rest.slice(0, idx);
  const fmt = idx === -1 ? 'iso' : rest.slice(idx + 1);
  if (!DATE_FMTS.includes(fmt)) return '';
  const m = DATE_OFFSET_RE.exec(offsetStr);
  if (!m) return '';
  const sign = m[1] === '-' ? -1 : 1;
  const offsetMs = sign * Number(m[2]) * UNIT_MS[m[3]];
  return formatDateMs(helperNowMs(vars) + offsetMs, fmt);
}

// resolveHelper(content, vars) -> { value, verbatim } for a recognised
// helper invocation, or null when `content` isn't a helper call at all (a
// plain variable path — including the bare `now`, unchanged). An unknown
// `name:rest` form still counts as "a helper" (so it renders '' rather than
// falling through to a literal variable lookup on a garbage path).
function resolveHelper(content, vars) {
  if (content === 'today') return { value: evalDateHelper('0d:ymd', vars), verbatim: false };
  const idx = content.indexOf(':');
  if (idx === -1) return null;
  const name = content.slice(0, idx);
  const rest = content.slice(idx + 1);
  switch (name) {
    case 'base64':
      return { value: Buffer.from(String(getVar(vars, rest)), 'utf8').toString('base64'), verbatim: false };
    case 'lower':
      return { value: String(getVar(vars, rest)).toLowerCase(), verbatim: false };
    case 'upper':
      return { value: String(getVar(vars, rest)).toUpperCase(), verbatim: false };
    case 'trim':
      return { value: String(getVar(vars, rest)).trim(), verbatim: false };
    case 'urlencode':
      return { value: encodeURIComponent(String(getVar(vars, rest))), verbatim: true };
    case 'digits':
      return { value: String(getVar(vars, rest)).replace(/\D/g, ''), verbatim: false };
    case 'date':
      return { value: evalDateHelper(rest, vars), verbatim: false };
    default:
      return { value: '', verbatim: false }; // unknown helper -> ''
  }
}

// findUnknownHelpers(str) -> string[] of distinct unrecognised helper names
// referenced in `str` (best-effort; used by recipe.js's validateRecipe to
// flag typos like `{{lowre:input.name}}` in url/headers/bodyTemplate/bodyJson
// strings). A plain variable path (no `:`) is never a helper and is ignored;
// `today`/`now` are recognised built-ins, not helpers.
export function findUnknownHelpers(str) {
  if (typeof str !== 'string' || !str) return [];
  const found = new Set();
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m;
  while ((m = re.exec(str))) {
    const content = m[1];
    if (content === 'today' || content === 'now') continue;
    const idx = content.indexOf(':');
    if (idx === -1) continue;
    const name = content.slice(0, idx);
    if (!KNOWN_HELPERS.includes(name)) found.add(name);
  }
  return [...found];
}

function escapeValue(raw, mode) {
  // Strip CR/LF from every substituted value regardless of mode — a cheap,
  // always-on defense against header/request-line injection via guest input.
  const s = String(raw).replace(/[\r\n]/g, ' ');
  switch (mode) {
    case 'json':
      // Escape as the *contents* of a JSON string (caller supplies the quotes
      // in bodyTemplate, e.g. `{"room":"{{input.room}}"}`).
      return JSON.stringify(s).slice(1, -1);
    case 'form':
      return encodeURIComponent(s).replace(/%20/g, '+');
    case 'xml':
      return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    case 'url':
      return encodeURIComponent(s);
    case 'none':
    default:
      return s;
  }
}

// renderTemplate('{{input.room}}', {input:{room:'12'}}, {escape:'url'}) -> '12'
// Missing variables resolve to ''. `str` itself is returned unescaped outside
// of `{{...}}` placeholders — only substituted values are escaped. Paths may
// use `[n]` array indexing (e.g. `{{steps.res.records[0].guestId}}`).
export function renderTemplate(str, vars, opts = {}) {
  if (typeof str !== 'string' || !str) return '';
  const escape = opts.escape || 'none';
  return str.replace(PLACEHOLDER_RE, (_match, content) => {
    const helper = resolveHelper(content, vars || {});
    if (helper) {
      // urlencode is already percent-encoded and inserted as-is regardless
      // of the surrounding escape mode; every other helper's string result
      // is escaped per that mode, same as a normal variable value.
      return helper.verbatim ? helper.value : escapeValue(helper.value, escape);
    }
    // Operator-declared params (e.g. a base URL / region origin) are trusted
    // configuration, not guest input, so in URL templates they are inserted
    // verbatim — a param may legitimately hold "https://host:port".
    const mode = escape === 'url' && content.startsWith('param.') ? 'none' : escape;
    return escapeValue(getVar(vars || {}, content), mode);
  });
}

function coerceTyped(type, raw) {
  switch (type) {
    case 'int': {
      if (raw === undefined || raw === null || raw === '') return '';
      const n = parseInt(raw, 10);
      return Number.isNaN(n) ? '' : n;
    }
    case 'number': {
      if (raw === undefined || raw === null || raw === '') return '';
      const n = Number(raw);
      return Number.isNaN(n) ? '' : n;
    }
    case 'bool': {
      if (raw === undefined || raw === null || raw === '') return '';
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
      if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
      return Boolean(raw);
    }
    case 'raw':
      return raw;
    case 'string':
    default:
      return raw == null ? '' : String(raw);
  }
}

// A value counts as "empty" for omitEmpty pruning purposes: '', null,
// undefined, [], {}. Literal booleans (incl. false) and numbers (incl. 0)
// are never pruned.
function isEmptyForPrune(v) {
  if (v === '' || v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// Prunes empty values recursively, leaves-up, so an array/object that becomes
// empty only after its own children are pruned is itself removed from its
// parent (e.g. `["{{input.name}}"]` with a blank name -> [] -> removed).
function pruneEmpty(node) {
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) {
      const pruned = pruneEmpty(item);
      if (!isEmptyForPrune(pruned)) out.push(pruned);
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const pruned = pruneEmpty(v);
      if (!isEmptyForPrune(pruned)) out[k] = pruned;
    }
    return out;
  }
  return node;
}

// renderJsonTemplate(tree, vars, {omitEmpty}) — walks a plain JSON tree
// (object/array/string/number/boolean/null), rendering every string as a
// template. A string that is EXACTLY one typed placeholder
// (`{{int:a.b}}` etc.) is replaced with a typed JS value instead of a
// string (so numbers/booleans/raw objects survive into the JSON body);
// every other string goes through the normal (untyped, unescaped)
// renderTemplate. `omitEmpty` (default true) recursively strips
// ''/null/undefined/[]/{} from the result; pass `{omitEmpty:false}` to keep
// them as-is.
export function renderJsonTemplate(tree, vars, opts = {}) {
  const omitEmpty = opts.omitEmpty !== false;

  function renderNode(node) {
    if (typeof node === 'string') {
      const m = TYPED_PLACEHOLDER_RE.exec(node.trim());
      if (m) {
        const [, type, path] = m;
        return coerceTyped(type, getPath(vars || {}, path));
      }
      return renderTemplate(node, vars, { escape: 'none' });
    }
    if (Array.isArray(node)) return node.map(renderNode);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = renderNode(v);
      return out;
    }
    return node; // numbers, booleans, null: literal, unrendered
  }

  const rendered = renderNode(tree);
  return omitEmpty ? pruneEmpty(rendered) : rendered;
}

// Builds the variable bag used by renderTemplate for a recipe run.
//
// `inputs` accepts either shape (both are used across this codebase):
//   - an array shaped like recipe.inputs, each with a `value` added:
//       [{ name:'room', required:true, value:'101' }, ...]
//   - a plain object map of name -> value: { room: '101' }
// The array form is preferred (it lets match.js honor `required`); see
// README notes in engine.js for why.
export function templateVars(recipe, inputs, token, nowIso) {
  const input = {};
  if (Array.isArray(inputs)) {
    for (const i of inputs) {
      if (i && typeof i.name === 'string') input[i.name] = i.value == null ? '' : i.value;
    }
  } else if (inputs && typeof inputs === 'object') {
    for (const [k, v] of Object.entries(inputs)) input[k] = v == null ? '' : v;
  }

  const secret = {};
  const s = recipe && recipe.secrets;
  if (s && typeof s === 'object') {
    for (const [k, v] of Object.entries(s)) secret[k] = v == null ? '' : v;
  }

  const param = {};
  const pv = recipe && recipe.paramValues;
  if (pv && typeof pv === 'object') {
    for (const [k, v] of Object.entries(pv)) param[k] = v == null ? '' : v;
  }

  return {
    input,
    token: token == null ? '' : token,
    secret,
    param,
    now: nowIso || new Date().toISOString(),
  };
}
