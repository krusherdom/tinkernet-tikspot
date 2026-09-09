// DB-backed CRUD for guest-lookup plugins (Stage 0.13-B/C). A "plugin" row is
// a validated recipe (see plugins/recipe.js) split across two columns:
//   recipe_json  — the recipe with secrets blanked (safe to hand to the admin
//                  UI, logs, exports, ...)
//   secrets_json — the recipe's credential values, kept separate so a
//                  redacted backup can wipe just this column (see admin/backup.js)
// `getPlugin` re-merges the two for the engine; every other reader gets the
// blanked version.
//
// window.leewayHours: when the caller doesn't specify a leeway for a windowed
// recipe, we deliberately store it as *absent* (rather than letting
// validateRecipe's own 24h default bake in permanently) so the portal route
// can apply the live `plugin_leeway_hours` setting as the real default at
// lookup time — see portal/routes.js. An explicitly-set leeway always wins.

import { validateRecipe, stripSecrets } from './recipe.js';

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function getRow(db, id) {
  return db.prepare('SELECT * FROM plugins WHERE id = ?').get(Number(id)) ?? null;
}

// The stored recipe_json already has secrets blanked (see save() below), so
// this is safe to hand out as-is for public reads.
function recipeFromRow(row) {
  const recipe = parseJson(row.recipe_json, {});
  recipe.id = row.id;
  recipe.name = row.name;
  recipe.enabled = !!row.enabled;
  return recipe;
}

function secretsFromRow(row) {
  return parseJson(row.secrets_json, {}) || {};
}

// True if `rawWindow.leewayHours` was actually supplied by the caller (vs.
// left absent for the portal route's settings-driven default to fill in).
function leewayWasProvided(rawWindow) {
  return !!rawWindow && rawWindow.leewayHours !== undefined && rawWindow.leewayHours !== null && rawWindow.leewayHours !== '';
}

// Validate `input` (a raw, possibly-merged recipe object) and persist it under
// `id` (null for a new row). Returns { ok:true, id } | { ok:false, error, fields }.
//
// Secrets are write-only and merge against the *declared* keys
// (value.secretKeys, generalised from the fixed username/password/apiKey
// trio in 0.13): for each declared key, an absent or '' incoming value keeps
// whatever's already stored; an explicit `null` clears it; any other string
// overwrites it. We look at the raw (pre-validation) `input.secrets` to tell
// "not sent" / "cleared" apart, since validateRecipe always normalises every
// declared key to a string.
function save(db, id, input, existingSecrets) {
  const v = validateRecipe(input);
  if (!v.ok) return v;
  const value = v.value;

  // See the leeway note above: only keep window.leewayHours if the caller
  // actually specified it (validateRecipe always fills in a numeric default,
  // so we have to compare against the pre-validation input to tell).
  if (value.window && !leewayWasProvided(input && input.window)) {
    delete value.window.leewayHours;
  }

  const stripped = stripSecrets(value);
  delete stripped.id;
  const rawSecrets = (input && input.secrets) || {};
  const secrets = {};
  for (const k of value.secretKeys || []) {
    const rawV = rawSecrets[k];
    if (rawV === null) {
      secrets[k] = ''; // explicit clear
    } else {
      secrets[k] = (value.secrets && value.secrets[k]) || (existingSecrets && existingSecrets[k]) || '';
    }
  }

  if (id == null) {
    const info = db
      .prepare(
        `INSERT INTO plugins (name, enabled, recipe_json, secrets_json, created_at, updated_at)
         VALUES (@name, @enabled, @recipe_json, @secrets_json, datetime('now'), datetime('now'))`,
      )
      .run({
        name: value.name,
        enabled: value.enabled ? 1 : 0,
        recipe_json: JSON.stringify(stripped),
        secrets_json: JSON.stringify(secrets),
      });
    return { ok: true, id: info.lastInsertRowid };
  }

  db.prepare(
    `UPDATE plugins SET name = @name, enabled = @enabled, recipe_json = @recipe_json,
       secrets_json = @secrets_json, updated_at = datetime('now') WHERE id = @id`,
  ).run({
    id,
    name: value.name,
    enabled: value.enabled ? 1 : 0,
    recipe_json: JSON.stringify(stripped),
    secrets_json: JSON.stringify(secrets),
  });
  return { ok: true, id };
}

export function listPlugins(db) {
  return db
    .prepare('SELECT id, name, enabled, recipe_json, updated_at FROM plugins ORDER BY id')
    .all()
    .map((row) => {
      const recipe = recipeFromRow(row);
      return {
        id: row.id,
        name: row.name,
        enabled: !!row.enabled,
        inputs: recipe.inputs || [],
        planGroup: recipe.planGroup || 'free',
        updated_at: row.updated_at,
      };
    });
}

// Full recipe (secrets merged in) for the engine — never hand this to a client.
export function getPlugin(db, id) {
  const row = getRow(db, id);
  if (!row) return null;
  const recipe = recipeFromRow(row);
  recipe.secrets = secretsFromRow(row);
  return recipe;
}

// Secrets blanked — safe for the admin UI.
export function getPluginPublic(db, id) {
  const row = getRow(db, id);
  if (!row) return null;
  return recipeFromRow(row);
}

// { <declared secret key>: boolean } -> whether each secret has a stored
// value (never the values themselves) — for the admin UI's "has_secrets"
// flags. Keyed off the recipe's own secretKeys (generalised in 0.15; falls
// back to the v1 username/password/apiKey trio for older stored recipes).
export function getPluginSecretsMeta(db, id) {
  const row = getRow(db, id);
  if (!row) return null;
  const recipe = recipeFromRow(row);
  const secrets = secretsFromRow(row);
  const keys = Array.isArray(recipe.secretKeys) && recipe.secretKeys.length ? recipe.secretKeys : ['username', 'password', 'apiKey'];
  const meta = {};
  for (const k of keys) meta[k] = !!secrets[k];
  return meta;
}

export function createPlugin(db, body) {
  return save(db, null, body && typeof body === 'object' ? body : {}, null);
}

// Secrets are write-only: an absent or empty secret field in `body` keeps the
// value already on file. Every other field replaces the corresponding part of
// the stored recipe wholesale (the admin UI is expected to submit the whole
// recipe shape each time, same as the design editor's block props).
export function updatePlugin(db, id, body) {
  const row = getRow(db, id);
  if (!row) return { ok: false, error: 'plugin not found', notFound: true };
  const existing = recipeFromRow(row);
  const existingSecrets = secretsFromRow(row);
  const incoming = body && typeof body === 'object' ? body : {};
  const merged = { ...existing, ...incoming, id: row.id, secrets: { ...incoming.secrets } };
  // `auth: null` / `window: null` / `request: null` / `steps: null` are
  // explicit deletes of an optional section (a merge would otherwise keep
  // the stored one forever).
  for (const k of ['auth', 'window', 'request', 'steps']) if (incoming[k] === null) delete merged[k];
  // Flipping `source` to 'list' (e.g. via the admin's Basics "Source" select)
  // must not resurrect the PREVIOUSLY stored http shape (`request`/`auth`/
  // `steps`) via the spread above — validateRecipe rejects those outright for
  // source:'list'. Only drop them when the incoming body didn't itself send
  // a value for that key (an explicit incoming request/auth/steps alongside
  // source:'list' is still a validation error, as it should be).
  if (merged.source === 'list') {
    for (const k of ['request', 'auth', 'steps']) {
      if (!Object.prototype.hasOwnProperty.call(incoming, k)) delete merged[k];
    }
  }
  return save(db, row.id, merged, existingSecrets);
}

export function deletePlugin(db, id) {
  const info = db.prepare('DELETE FROM plugins WHERE id = ?').run(Number(id));
  return info.changes > 0;
}

// exportPlugin(db, id, { includeRows }) — `includeRows` (default false) adds
// a top-level `listRows` array for a source:'list' plugin. Defaulting to
// false keeps a plain Export from leaking guest PII; the admin must
// explicitly opt in (?includeRows=1 — see admin/plugins.js).
export function exportPlugin(db, id, opts = {}) {
  const row = getRow(db, id);
  if (!row) return null;
  const recipe = recipeFromRow(row);
  delete recipe.id;
  const bundle = { format: 'tikspot-plugin', version: 1, recipe };
  if (opts.includeRows && recipe.source === 'list') {
    bundle.listRows = listRows(db, id).rows;
  }
  return bundle;
}

// Accepts either the full export envelope ({format, version, recipe}) or a
// bare recipe object (e.g. one of examples/guest-api/recipes/*.json).
// Imported recipes never arrive enabled or carrying secrets — the admin
// reviews and fills in credentials before enabling — but `paramValues` (not
// secret) are preserved as authored. A `listRows` array alongside `recipe`
// (see exportPlugin's includeRows) is stored too, for a source:'list' plugin.
export function importPlugin(db, obj) {
  const recipe = obj && typeof obj === 'object' && obj.recipe && typeof obj.recipe === 'object' ? obj.recipe : obj;
  const incomingRows = obj && typeof obj === 'object' && Array.isArray(obj.listRows) ? obj.listRows : null;
  const safe = recipe && typeof recipe === 'object' ? { ...recipe, enabled: false, secrets: {} } : recipe;
  const result = createPlugin(db, safe);
  if (result.ok && incomingRows) replaceListRows(db, result.id, incomingRows);
  return result;
}

// ---------------------------------------------------------------------------
// Built-in guest-list source (Stage 0.16) — plugin_list_rows.

const MAX_LIST_ROWS = 5000;

// replaceListRows(db, pluginId, rows) — atomically replaces every stored row
// for `pluginId` with `rows` (capped at MAX_LIST_ROWS; each row coerced to a
// plain object of string values — CSV cells are already strings, but a JSON
// `{rows:[...]}` import might not be). Returns { count }.
export function replaceListRows(db, pluginId, rows) {
  const id = Number(pluginId);
  const capped = (Array.isArray(rows) ? rows : []).slice(0, MAX_LIST_ROWS).map((r) => {
    const out = {};
    if (r && typeof r === 'object') {
      for (const [k, v] of Object.entries(r)) out[k] = v == null ? '' : String(v);
    }
    return out;
  });
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM plugin_list_rows WHERE plugin_id = ?').run(id);
    const insert = db.prepare('INSERT INTO plugin_list_rows (plugin_id, row_json) VALUES (?, ?)');
    for (const row of list) insert.run(id, JSON.stringify(row));
  });
  tx(capped);
  return { count: capped.length };
}

// listRows(db, pluginId, { limit }) -> { count, rows } — `count` is the TOTAL
// row count regardless of `limit`; `rows` is capped at `limit` when given
// (e.g. the admin's 20-row sample), otherwise every row (used by the engine
// at lookup time and by export).
export function listRows(db, pluginId, opts = {}) {
  const id = Number(pluginId);
  const countRow = db.prepare('SELECT COUNT(*) AS n FROM plugin_list_rows WHERE plugin_id = ?').get(id);
  let sql = 'SELECT row_json FROM plugin_list_rows WHERE plugin_id = ? ORDER BY id';
  const params = [id];
  if (opts && Number.isFinite(opts.limit)) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }
  const rows = db
    .prepare(sql)
    .all(...params)
    .map((r) => parseJson(r.row_json, {}));
  return { count: countRow ? countRow.n : 0, rows };
}

export function countListRows(db, pluginId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM plugin_list_rows WHERE plugin_id = ?').get(Number(pluginId));
  return row ? row.n : 0;
}
