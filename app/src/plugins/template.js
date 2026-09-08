// Tiny mustache-ish string templating for recipe URLs/headers/bodies.
// Deliberately minimal: only `{{a.b}}` variable interpolation (plus `[n]`
// array indexing, via parsers.js's getPath), no logic, loops, or partials —
// recipes are data, not code.
//
// renderJsonTemplate additionally supports typed placeholders
// (`{{int:a.b}}`, `{{number:a.b}}`, `{{bool:a.b}}`, `{{raw:a.b}}`,
// `{{string:a.b}}`) for building structured JSON request bodies — see
// request.bodyJson / auth.bodyJson in recipe.js.

import { getPath } from './parsers.js';

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g;
const TYPED_PLACEHOLDER_RE = /^\{\{\s*(int|number|bool|raw|string):([a-zA-Z0-9_.[\]]+)\s*\}\}$/;

function getVar(vars, path) {
  const v = getPath(vars, path);
  return v == null ? '' : v;
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
  return str.replace(PLACEHOLDER_RE, (_match, path) => {
    // Operator-declared params (e.g. a base URL / region origin) are trusted
    // configuration, not guest input, so in URL templates they are inserted
    // verbatim — a param may legitimately hold "https://host:port".
    const mode = escape === 'url' && path.startsWith('param.') ? 'none' : escape;
    return escapeValue(getVar(vars || {}, path), mode);
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
