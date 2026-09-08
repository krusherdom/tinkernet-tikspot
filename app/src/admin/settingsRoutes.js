// Settings API — a thin HTTP layer over the SETTINGS_REGISTRY in db/settings.js.
// The registry is the single source of truth: the UI renders its fields from
// GET /api/settings, and PATCH validates against the same specs. Adding a
// setting is one registry entry, no changes here.
//
// Secrets (router password, RADIUS secret, admin password) are deliberately NOT
// in the registry — they have their own dedicated setup flows.

import { listSettings, settingSpec, setSetting, validateSettingValue } from '../db/settings.js';
import { logAudit } from './audit.js';

// Group the flat registry list into the ordered groups the Settings tab renders.
export function groupedSettings(db) {
  const groups = [];
  const byName = new Map();
  for (const s of listSettings(db)) {
    let g = byName.get(s.group);
    if (!g) {
      g = { name: s.group, settings: [] };
      byName.set(s.group, g);
      groups.push(g);
    }
    g.settings.push(s);
  }
  return groups;
}

/**
 * Validate a whole patch body against the registry. Nothing is written unless
 * every key passes, so a bad field can't half-apply a form.
 * @returns {{ok:true, updates:Array<[string,string]>} | {ok:false, error:string, fields:object}}
 */
export function validateSettingsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'expected an object of setting keys', fields: {} };
  }
  const keys = Object.keys(body);
  if (!keys.length) return { ok: false, error: 'no settings supplied', fields: {} };

  const fields = {};
  const updates = [];
  for (const key of keys) {
    const spec = settingSpec(key);
    if (!spec) {
      fields[key] = 'Unknown setting';
      continue;
    }
    const res = validateSettingValue(spec, body[key]);
    if (!res.ok) fields[key] = res.error;
    else updates.push([key, res.value]);
  }
  const bad = Object.keys(fields);
  if (bad.length) return { ok: false, error: fields[bad[0]], fields };
  return { ok: true, updates };
}

export default async function settingsRoutes(app) {
  const db = app.db;

  app.get('/api/settings', async () => ({ groups: groupedSettings(db) }));

  app.patch('/api/settings', async (req, reply) => {
    const res = validateSettingsPatch(req.body);
    if (!res.ok) return reply.code(400).send({ error: res.error, fields: res.fields });
    const tx = db.transaction(() => {
      for (const [key, value] of res.updates) setSetting(db, key, value);
    });
    tx();
    logAudit(db, req, 'settings.update', res.updates.map(([k]) => k).join(', '));
    return { groups: groupedSettings(db) };
  });
}
