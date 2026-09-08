// Design persistence: draft/publish/version lifecycle over the `designs` and
// `design_versions` tables. Exactly one design is active at a time; the live
// portal renders the active design's PUBLISHED model (`grapes_json`) — a saved
// draft (`draft_json`) never reaches guests until it's published.

import { defaultDesign, normalizeDesign } from '../design/model.js';
import { TEMPLATES } from '../design/templates.js';
import { syncFreeCredentials } from '../design/credentials.js';
import { VERSION } from '../config.js';

const MAX_VERSIONS = 5;

export function getActiveDesign(db) {
  return db.prepare('SELECT * FROM designs WHERE is_active = 1 ORDER BY id LIMIT 1').get() ?? null;
}

export function listDesigns(db) {
  return db
    .prepare(
      `SELECT id, name, is_active, version, updated_at, (draft_json IS NOT NULL) AS has_draft
         FROM designs ORDER BY id`,
    )
    .all()
    .map((d) => ({ ...d, is_active: !!d.is_active, has_draft: !!d.has_draft }));
}

export function getDesign(db, id) {
  return db.prepare('SELECT * FROM designs WHERE id = ?').get(id) ?? null;
}

// Parse a design row's PUBLISHED JSON into a normalised model (theme + blocks
// + pages). Falls back to the starter design if there's nothing published yet.
export function designModel(row) {
  if (!row || !row.grapes_json) return defaultDesign();
  try {
    return normalizeDesign(JSON.parse(row.grapes_json));
  } catch {
    return defaultDesign();
  }
}

// Parse a design row's DRAFT JSON, or null if there is no unpublished draft.
export function draftModel(row) {
  if (!row || !row.draft_json) return null;
  try {
    return normalizeDesign(JSON.parse(row.draft_json));
  } catch {
    return null;
  }
}

export function activeModel(db) {
  return designModel(getActiveDesign(db));
}

export function activateDesign(db, id) {
  const tx = db.transaction((designId) => {
    db.prepare('UPDATE designs SET is_active = 0 WHERE is_active = 1').run();
    db.prepare('UPDATE designs SET is_active = 1 WHERE id = ?').run(designId);
  });
  tx(id);
  const row = getDesign(db, id);
  if (row) syncFreeCredentials(db, designModel(row));
}

// Create a new design as a DRAFT (no published version yet) from a blank
// starter, a template key, or an explicit model. Returns the new id.
export function createDesign(db, { name, template, model } = {}) {
  let base;
  if (model) {
    base = normalizeDesign(model);
  } else if (template) {
    const t = TEMPLATES.find((tpl) => tpl.key === template);
    base = normalizeDesign(t ? t.design : defaultDesign());
  } else {
    base = defaultDesign();
  }
  const info = db
    .prepare(
      `INSERT INTO designs (name, grapes_json, draft_json, html, css, is_active, version)
       VALUES (@name, NULL, @draft, '', '', 0, 0)`,
    )
    .run({ name: name || 'Untitled', draft: JSON.stringify(base) });
  return info.lastInsertRowid;
}

// Throw the unpublished draft away; the published model stays untouched.
export function discardDraft(db, id) {
  const r = db
    .prepare(`UPDATE designs SET draft_json = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(id);
  return r.changes > 0;
}

export function saveDraft(db, id, model) {
  const normalized = normalizeDesign(model);
  db.prepare(`UPDATE designs SET draft_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
    JSON.stringify(normalized),
    id,
  );
  return { saved_at: new Date().toISOString() };
}

function pruneVersions(db, designId) {
  const rows = db
    .prepare('SELECT id FROM design_versions WHERE design_id = ? ORDER BY version DESC')
    .all(designId);
  if (rows.length > MAX_VERSIONS) {
    const del = db.prepare('DELETE FROM design_versions WHERE id = ?');
    for (const row of rows.slice(MAX_VERSIONS)) del.run(row.id);
  }
}

// Publish a design: validate+normalise the given model (or the current draft,
// or — if there's no draft either — the currently published model), store it
// as `grapes_json`, clear the draft, bump `version`, and snapshot it into
// design_versions (keeping only the most recent MAX_VERSIONS). If this design
// is the active one, re-syncs the free-login RADIUS credentials it references.
export function publishDesign(db, id, model) {
  const row = getDesign(db, id);
  if (!row) return null;
  let source = model;
  if (source == null) {
    if (row.draft_json) source = JSON.parse(row.draft_json);
    else if (row.grapes_json) source = JSON.parse(row.grapes_json);
    else source = defaultDesign();
  }
  const normalized = normalizeDesign(source);
  const json = JSON.stringify(normalized);

  const version = db.transaction(() => {
    db.prepare(
      `UPDATE designs SET grapes_json = ?, draft_json = NULL, version = version + 1, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(json, id);
    const v = db.prepare('SELECT version FROM designs WHERE id = ?').get(id).version;
    db.prepare('INSERT INTO design_versions (design_id, version, model_json) VALUES (?, ?, ?)').run(id, v, json);
    return v;
  })();

  pruneVersions(db, id);

  const updated = getDesign(db, id);
  if (updated?.is_active) syncFreeCredentials(db, normalized);
  return version;
}

export function listVersions(db, id) {
  return db
    .prepare('SELECT version, created_at FROM design_versions WHERE design_id = ? ORDER BY version DESC')
    .all(id);
}

// Publish a previously-snapshotted version as a NEW version (never rewrites
// history — a revert is itself a publish).
export function revertDesign(db, id, version) {
  const row = db
    .prepare('SELECT model_json FROM design_versions WHERE design_id = ? AND version = ?')
    .get(id, version);
  if (!row) return null;
  return publishDesign(db, id, JSON.parse(row.model_json));
}

export function deleteDesign(db, id) {
  const row = getDesign(db, id);
  if (!row) return { ok: false, error: 'design not found' };
  if (row.is_active) return { ok: false, error: 'cannot delete the active design' };
  db.prepare('DELETE FROM design_versions WHERE design_id = ?').run(id);
  db.prepare('DELETE FROM designs WHERE id = ?').run(id);
  return { ok: true };
}

// Export the design's current working model (its draft if it has one,
// otherwise its published model) as a portable JSON envelope.
export function exportDesign(db, id) {
  const row = getDesign(db, id);
  if (!row) return null;
  const model = draftModel(row) || designModel(row);
  return { format: 'tikspot-design', version: VERSION, name: row.name, model };
}

// Accepts either the export envelope ({format, model, name}) or a bare model.
export function importDesign(db, { name, model } = {}) {
  const src = model && typeof model === 'object' && model.model ? model.model : model;
  const nm = name || (model && typeof model === 'object' ? model.name : null) || 'Imported design';
  return createDesign(db, { name: nm, model: src });
}

// Seed the default design as the active one if no designs exist yet.
export function ensureDefaultDesign(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM designs').get().n;
  if (count > 0) return;
  const id = createDesign(db, { name: 'Default', model: defaultDesign() });
  publishDesign(db, id, defaultDesign());
  activateDesign(db, id);
}
