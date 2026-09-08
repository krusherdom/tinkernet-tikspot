// Tiny mustache-ish string templating for recipe URLs/headers/bodies.
// Deliberately minimal: only `{{a.b}}` variable interpolation, no logic,
// loops, or partials — recipes are data, not code.

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function getVar(vars, path) {
  const parts = path.split('.');
  let cur = vars;
  for (const part of parts) {
    if (cur == null) return '';
    cur = cur[part];
  }
  return cur == null ? '' : cur;
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
// of `{{...}}` placeholders — only substituted values are escaped.
export function renderTemplate(str, vars, opts = {}) {
  if (typeof str !== 'string' || !str) return '';
  const escape = opts.escape || 'none';
  return str.replace(PLACEHOLDER_RE, (_match, path) => escapeValue(getVar(vars || {}, path), escape));
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

  return {
    input,
    token: token == null ? '' : token,
    secret,
    now: nowIso || new Date().toISOString(),
  };
}
