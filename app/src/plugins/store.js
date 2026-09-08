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
  const secrets = {
    username: (value.secrets && value.secrets.username) || (existingSecrets && existingSecrets.username) || '',
    password: (value.secrets && value.secrets.password) || (existingSecrets && existingSecrets.password) || '',
    apiKey: (value.secrets && value.secrets.apiKey) || (existingSecrets && existingSecrets.apiKey) || '',
  };

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

// { username, password, apiKey } -> whether each secret has a stored value
// (never the values themselves) — for the admin UI's "has_secrets" flags.
export function getPluginSecretsMeta(db, id) {
  const row = getRow(db, id);
  if (!row) return null;
  const secrets = secretsFromRow(row);
  return {
    username: !!secrets.username,
    password: !!secrets.password,
    apiKey: !!secrets.apiKey,
  };
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
  // `auth: null` / `window: null` are explicit deletes of an optional section
  // (a merge would otherwise keep the stored one forever).
  for (const k of ['auth', 'window']) if (incoming[k] === null) delete merged[k];
  return save(db, row.id, merged, existingSecrets);
}

export function deletePlugin(db, id) {
  const info = db.prepare('DELETE FROM plugins WHERE id = ?').run(Number(id));
  return info.changes > 0;
}

export function exportPlugin(db, id) {
  const row = getRow(db, id);
  if (!row) return null;
  const recipe = recipeFromRow(row);
  delete recipe.id;
  return { format: 'tikspot-plugin', version: 1, recipe };
}

// Accepts either the full export envelope ({format, version, recipe}) or a
// bare recipe object (e.g. one of examples/guest-api/recipes/*.json).
export function importPlugin(db, obj) {
  const recipe = obj && typeof obj === 'object' && obj.recipe && typeof obj.recipe === 'object' ? obj.recipe : obj;
  return createPlugin(db, recipe);
}
