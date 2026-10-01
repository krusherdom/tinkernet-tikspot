// Zero-touch deployment, boot-time half (run by db-init, app/src/init.js):
//   • maybeRestoreFromFile — BEFORE the DB is opened, stage a backup zip named
//     by TIKSPOT_RESTORE_FILE (promoteStagedRestore then swaps it in).
//   • applyBootstrap — AFTER migrate/seed, write the env-provided settings,
//     admin password and guest-lookup plugin, and attach the plugin to the
//     live portal design.
// The router half (Auto-configure + hotspot provisioning) needs the network
// and runs after the server is listening — see bootstrap/router.js.
//
// Semantics: TIKSPOT_BOOTSTRAP=seed (default) only fills what is unset, so the
// admin UI stays authoritative after first boot; =enforce makes the env win on
// every boot (a container re-created from the same envs converges).
//
// Nothing here may stop the container from starting: every failure becomes a
// warning in the returned/stored status. Secret VALUES are never logged,
// returned or stored in the status — only names.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { getSetting, setSetting } from '../db/settings.js';
import { hashPassword, verifyPassword } from '../admin/auth.js';
import { applyBackupZip } from '../admin/backup.js';
import { listPlugins, getPlugin, getPluginPublic, importPlugin, updatePlugin } from '../plugins/store.js';
import { extractRecipe } from '../plugins/catalog.js';
import { getActiveDesign, designModel, draftModel, publishDesign, saveDraft } from '../portal/designs.js';
import { newBlock } from '../design/model.js';
import { logEvent } from '../admin/events.js';
import { hasBootstrap } from './env.js';
import { writeBootstrapStatus } from './status.js';
import { DB_PATH, DATA_DIR, ASSETS_DIR } from '../config.js';

const consoleLog = {
  info: (m) => console.log(`[tikspot-bootstrap] ${m}`),
  warn: (m) => console.warn(`[tikspot-bootstrap] WARN ${m}`),
};

const empty = (v) => v == null || v === '';

// ---------------------------------------------------------------------------
// Restore from file

// Does the live DB already hold a configured install? (fresh mode only
// restores into an empty/unconfigured one.) Opened read-only and closed
// before promoteStagedRestore touches the file.
function liveDbConfigured(dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get();
    return Boolean(row && row.value);
  } catch {
    return false; // no settings table yet => unconfigured
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Stage TIKSPOT_RESTORE_FILE for promotion. Runs BEFORE the DB is opened.
 *   fresh (default) — only when the live DB is missing or has no admin password
 *   once            — once per file content (sha256 remembered in
 *                     <DATA_DIR>/.bootstrap-restore)
 * Returns { restored, from_version?, assets_restored?, reason? } and pushes any
 * problem onto spec.warnings. Never throws.
 */
export async function maybeRestoreFromFile(
  spec,
  { log = consoleLog, dbPath = DB_PATH, dataDir = DATA_DIR, assetsDir = ASSETS_DIR } = {},
) {
  // Collected only — applyBootstrap logs every spec warning once, later.
  const warn = (m) => { if (spec?.warnings) spec.warnings.push(m); else log.warn(m); };
  const r = spec?.restore;
  if (!r || !r.file) return { restored: false, reason: 'not requested' };
  try {
    if (!fs.existsSync(r.file)) {
      warn(`TIKSPOT_RESTORE_FILE not found (${r.file}) — continuing without restore`);
      return { restored: false, reason: 'missing file' };
    }
    const buf = fs.readFileSync(r.file);
    const sha = createHash('sha256').update(buf).digest('hex');
    const marker = path.join(dataDir, '.bootstrap-restore');
    let last = '';
    try { last = fs.readFileSync(marker, 'utf8').trim(); } catch { /* first time */ }

    if (r.mode === 'once') {
      if (last === sha) return { restored: false, reason: 'already restored this file' };
    } else {
      if (liveDbConfigured(dbPath)) return { restored: false, reason: 'live DB already configured' };
      // A redacted backup has no admin password, so "fresh" would otherwise
      // re-restore the same file on every boot and wipe everything since.
      if (last === sha && fs.existsSync(dbPath)) return { restored: false, reason: 'already restored this file' };
    }

    const staged = await applyBackupZip(buf, { stagePath: path.join(dataDir, 'tikspot.db.restore'), assetsDir });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(marker, sha + '\n');
    log.info(`staged restore from ${path.basename(r.file)} (v${staged.from_version ?? '?'}, ${staged.assets_restored} assets)`);
    return { restored: true, ...staged };
  } catch (err) {
    warn(`TIKSPOT_RESTORE_FILE could not be restored: ${String(err?.message || err)}`);
    return { restored: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Settings

// seed: write only when unset/empty; enforce: write whenever it differs.
function seedSetting(db, key, value, mode, applied) {
  if (value == null) return;
  const v = String(value);
  const cur = getSetting(db, key, null);
  if (mode === 'enforce' ? cur === v : !empty(cur)) return;
  setSetting(db, key, v);
  applied.push(key);
}

// The admin password is special: hashed, and RESET forces it even in seed
// mode. An unchanged password is not re-hashed (no re-salt every boot, and
// `applied` stays honest).
function applyAdminPassword(db, spec, applied) {
  const pw = spec.admin?.password;
  if (!pw) return;
  const stored = getSetting(db, 'admin_password_hash', null);
  const force = spec.admin.reset || spec.mode === 'enforce';
  if (stored && !force) return;
  if (stored && verifyPassword(pw, stored)) return;
  setSetting(db, 'admin_password_hash', hashPassword(pw));
  applied.push('admin_password');
}

export function applySettings(db, spec, applied = []) {
  const m = spec.mode;
  applyAdminPassword(db, spec, applied);
  if (spec.setupComplete != null) seedSetting(db, 'setup_complete', spec.setupComplete ? '1' : '0', m, applied);
  const rt = spec.router || {};
  // Scheme defaults to https (as in the wizard) once a host is provided — but
  // a default only ever seeds; enforce pushes only what the env actually says.
  if (rt.scheme) seedSetting(db, 'router_scheme', rt.scheme, m, applied);
  else if (rt.host) seedSetting(db, 'router_scheme', 'https', 'seed', applied);
  seedSetting(db, 'router_host', rt.host, m, applied);
  seedSetting(db, 'router_user', rt.user, m, applied);
  seedSetting(db, 'router_pass', rt.password, m, applied);
  seedSetting(db, 'container_ip', spec.containerIp, m, applied);
  seedSetting(db, 'server_name', spec.serverName, m, applied);
  seedSetting(db, 'nas_secret', spec.nasSecret, m, applied);
  seedSetting(db, 'portal_title', spec.portalTitle, m, applied);
  seedSetting(db, 'login_method', spec.loginMethod, m, applied);
  // Stored like the Settings registry stores it: a JSON array.
  seedSetting(db, 'hotspot_profiles', spec.hotspotProfiles?.length ? JSON.stringify(spec.hotspotProfiles) : null, m, applied);
  return applied;
}

// ---------------------------------------------------------------------------
// Plugin

// Where bundled recipes live: TIKSPOT_PLUGINS_DIR, the image's /app/plugins,
// or the repo's plugins/ folder in development.
export function pluginsDir(env = process.env) {
  if (env.TIKSPOT_PLUGINS_DIR) return env.TIKSPOT_PLUGINS_DIR;
  const candidates = ['/app/plugins', fileURLToPath(new URL('../../../plugins', import.meta.url))];
  return candidates.find((d) => fs.existsSync(d)) || candidates[0];
}

/**
 * Load the recipe named by spec.plugin from disk. URL sources are deferred to
 * the router phase (network may not be up yet in db-init).
 *   { ok:true, recipe } | { ok:false, deferred:true } | { ok:false, error }
 */
export function loadPluginRecipe(pluginSpec, { dir = pluginsDir() } = {}) {
  if (!pluginSpec) return { ok: false, error: 'no plugin requested' };
  if (pluginSpec.source === 'url') return { ok: false, deferred: true };
  const file = pluginSpec.source === 'bundled' ? path.join(dir, `${pluginSpec.ref}.json`) : pluginSpec.ref;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, error: `TIKSPOT_PLUGIN ${pluginSpec.source === 'bundled' ? `"${pluginSpec.ref}" is not a bundled recipe` : 'file could not be read'} (${err?.code || 'invalid JSON'})` };
  }
  // An export envelope, or a bare recipe object (steps-only recipes have no
  // top-level request/parse, which extractRecipe's bare check requires).
  const bare = json && typeof json === 'object' && json.format == null && json.name ? json : null;
  const recipe = extractRecipe(json) || bare;
  if (!recipe) return { ok: false, error: 'TIKSPOT_PLUGIN is not a Tikspot plugin export' };
  return { ok: true, recipe };
}

// Is a stored param value "set by someone"? One equal to the recipe's declared
// default counts as unset — validateRecipe fills defaults in on import, so
// otherwise seed mode could never override e.g. a region URL default.
function paramIsSet(value, def) {
  if (empty(value)) return false;
  const dflt = def && def.default !== undefined ? def.default : def?.type === 'boolean' ? false : '';
  return String(value) !== String(dflt);
}

/**
 * Create (once, by final name) and configure a plugin from `recipe`:
 * secrets, paramValues (merged over existing) and enabled. Seed mode keeps
 * existing non-empty secrets/params and only enables on creation; enforce
 * overwrites every boot. Returns { ok, id, name, created, changed:[names],
 * warnings:[...] } — names only, never values.
 */
export function ensurePlugin(db, recipe, pluginSpec, mode = 'seed') {
  const warnings = [];
  const name = String(pluginSpec?.name || recipe?.name || '').trim();
  if (!name) return { ok: false, warnings: ['TIKSPOT_PLUGIN recipe has no name — set TIKSPOT_PLUGIN_NAME'] };

  let created = false;
  let id = listPlugins(db).find((p) => p.name === name)?.id;
  if (id == null) {
    // importPlugin forces enabled:false and blank secrets — set below.
    const res = importPlugin(db, { ...recipe, name });
    if (!res.ok) return { ok: false, warnings: [`TIKSPOT_PLUGIN could not be imported: ${res.error}`] };
    id = Number(res.id);
    created = true;
  }

  const full = getPlugin(db, id);
  const pub = getPluginPublic(db, id);
  const declaredSecrets = Array.isArray(full.secretKeys) ? full.secretKeys : [];
  const declaredParams = pub.params || {};
  const changed = [];
  const body = {};

  const secrets = {};
  for (const [k, v] of Object.entries(pluginSpec?.secrets || {})) {
    if (!declaredSecrets.includes(k)) {
      warnings.push(`TIKSPOT_PLUGIN_SECRET_${k}: the recipe declares no secret "${k}" (has: ${declaredSecrets.join(', ') || 'none'}) — ignored`);
      continue;
    }
    const cur = full.secrets?.[k];
    if (mode !== 'enforce' && !empty(cur)) continue;
    if (cur === v) continue;
    secrets[k] = v;
    changed.push(`secret:${k}`);
  }
  if (Object.keys(secrets).length) body.secrets = secrets;

  const params = { ...(pub.paramValues || {}) };
  let paramsChanged = false;
  for (const [k, v] of Object.entries(pluginSpec?.params || {})) {
    if (!Object.prototype.hasOwnProperty.call(declaredParams, k)) {
      warnings.push(`TIKSPOT_PLUGIN_PARAM_${k}: the recipe declares no param "${k}" — ignored`);
      continue;
    }
    if (mode !== 'enforce' && paramIsSet(params[k], declaredParams[k])) continue;
    if (String(params[k]) === String(v)) continue;
    params[k] = v;
    paramsChanged = true;
    changed.push(`param:${k}`);
  }
  // updatePlugin replaces paramValues wholesale, hence the merged copy.
  if (paramsChanged) body.paramValues = params;

  if (pluginSpec?.enabled != null && (created || mode === 'enforce') && !!pub.enabled !== pluginSpec.enabled) {
    body.enabled = pluginSpec.enabled;
    changed.push('enabled');
  }

  if (Object.keys(body).length) {
    const res = updatePlugin(db, id, body);
    if (!res.ok) {
      warnings.push(`TIKSPOT_PLUGIN settings rejected by the recipe validator: ${res.error}`);
      return { ok: false, id, name, created, changed: [], warnings };
    }
  }
  return { ok: true, id, name, created, changed, warnings };
}

// ---------------------------------------------------------------------------
// Design attach

const LOGIN_TYPES = new Set(['free-login', 'voucher-login', 'userpass-login']);

function* walkBlocks(blocks) {
  for (const b of blocks || []) {
    yield b;
    if (b.type === 'columns') {
      yield* walkBlocks(b.props?.left);
      yield* walkBlocks(b.props?.right);
    }
  }
}

/**
 * Point the login page of `model` at plugin `pluginId`:
 *   • a plugin-login block already pointing at a real plugin -> leave it all
 *   • else the first plugin-login with an empty/dangling pluginId -> fill it
 *   • else insert one just before the first free/voucher/userpass login block
 *     (or append).
 * Returns { model, changed } (model is a modified deep copy).
 */
export function attachPluginToModel(model, pluginId, validIds) {
  const m = JSON.parse(JSON.stringify(model));
  const ids = new Set([...validIds].map(String));
  const pls = [...walkBlocks(m.blocks)].filter((b) => b.type === 'plugin-login');
  if (pls.some((b) => ids.has(String(b.props?.pluginId ?? '')))) return { model: m, changed: false };
  if (pls.length) {
    pls[0].props = { ...pls[0].props, pluginId: String(pluginId) };
    return { model: m, changed: true };
  }
  const block = newBlock('plugin-login');
  block.props = { ...block.props, label: 'Continue', pluginId: String(pluginId), intro: '' };
  const at = (m.blocks || []).findIndex((b) => LOGIN_TYPES.has(b.type));
  m.blocks = m.blocks || [];
  if (at === -1) m.blocks.push(block);
  else m.blocks.splice(at, 0, block);
  return { model: m, changed: true };
}

/**
 * Attach plugin `pluginId` to the ACTIVE design: the published model (so the
 * live page updates) and, if one exists, the unpublished draft (so the editor
 * doesn't silently drop it on the next publish). Publishes only on change, so
 * boots don't churn design versions. Returns { changed, designId }.
 */
export function attachPluginToActiveDesign(db, pluginId) {
  const row = getActiveDesign(db);
  if (!row) return { changed: false, error: 'no active design' };
  const validIds = listPlugins(db).map((p) => p.id);
  const draft = draftModel(row);
  const pub = attachPluginToModel(designModel(row), pluginId, validIds);
  let changed = false;
  if (pub.changed) {
    publishDesign(db, row.id, pub.model); // clears draft_json — restored below
    changed = true;
  }
  if (draft) {
    const d = attachPluginToModel(draft, pluginId, validIds);
    if (d.changed || pub.changed) {
      saveDraft(db, row.id, d.model);
      changed = changed || d.changed;
    }
  }
  return { changed, designId: row.id };
}

/**
 * Apply a resolved recipe + the spec's plugin options (shared with the router
 * phase, which uses it for URL sources). Pushes onto `applied`/`warnings`.
 * Returns { name, id } | null.
 */
export function applyPluginRecipe(db, recipe, spec, { applied, warnings }) {
  const res = ensurePlugin(db, recipe, spec.plugin, spec.mode);
  warnings.push(...res.warnings);
  if (!res.ok && res.id == null) return null;
  if (res.created) applied.push('plugin');
  for (const c of res.changed || []) applied.push(`plugin.${c}`);
  if (spec.plugin.attach) {
    try {
      const a = attachPluginToActiveDesign(db, res.id);
      if (a.error) warnings.push(`TIKSPOT_PLUGIN_ATTACH: ${a.error}`);
      else if (a.changed) applied.push('design.plugin-login');
    } catch (err) {
      warnings.push(`TIKSPOT_PLUGIN_ATTACH failed: ${String(err?.message || err)}`);
    }
  }
  return { name: res.name, id: res.id };
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Apply the bootstrap spec to an open, migrated DB. Synchronous; never throws.
 * Writes `bootstrap_status` (router: null — bootstrap/router.js fills it in)
 * and returns { applied, plugin, warnings }.
 */
export function applyBootstrap(db, spec, { log = consoleLog, restore = null, pluginDir } = {}) {
  const applied = [];
  const warnings = [...(spec?.warnings || [])];
  let plugin = null;
  if (!spec || !hasBootstrap(spec)) return { applied, plugin, warnings };

  if (restore?.restored) applied.push('restore_file');
  try {
    applySettings(db, spec, applied);
  } catch (err) {
    warnings.push(`settings bootstrap failed: ${String(err?.message || err)}`);
  }

  if (spec.plugin && spec.plugin.source !== 'url') {
    try {
      const loaded = loadPluginRecipe(spec.plugin, pluginDir ? { dir: pluginDir } : undefined);
      if (!loaded.ok) warnings.push(loaded.error);
      else plugin = applyPluginRecipe(db, loaded.recipe, spec, { applied, warnings });
    } catch (err) {
      warnings.push(`plugin bootstrap failed: ${String(err?.message || err)}`);
    }
  }

  try {
    writeBootstrapStatus(db, { at: new Date().toISOString(), mode: spec.mode, applied, plugin, router: null, warnings });
    logEvent(
      db,
      warnings.length ? 'warn' : 'info',
      'bootstrap',
      `Environment bootstrap (${spec.mode}): ${applied.length ? applied.join(', ') : 'nothing to change'}`,
      warnings.length ? warnings.join('\n') : undefined,
    );
  } catch { /* status is best-effort */ }

  log.info(`${spec.mode}: applied ${applied.length ? applied.join(', ') : 'nothing'}`);
  for (const w of warnings) log.warn(w);
  return { applied, plugin, warnings };
}
