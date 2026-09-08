// Guest-lookup RADIUS grants: mint a short-lived credential for a guest a
// plugin (recipe) just admitted, and sweep expired ones. Mirrors the
// mac_sessions pattern in mac/grants.js — mint via radius/sync.js's syncUser,
// track expires_at ourselves, sweeper calls removeUser.

import { randomInt } from 'node:crypto';
import { syncUser, removeUser } from '../radius/sync.js';

const DEFAULT_MAX_GRANT_HOURS = 168;
const HOUR_MS = 3600 * 1000;

// Unambiguous alphabets (no 0/O/1/I/l) so a printed/typed username or password
// is never mistaken for a different character.
const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function randomFrom(alphabet, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

function uniqueUsername(db) {
  for (let i = 0; i < 25; i++) {
    const candidate = 'pg-' + randomFrom(BASE32, 6);
    if (!db.prepare('SELECT 1 FROM plugin_grants WHERE username = ?').get(candidate)) return candidate;
  }
  throw new Error('could not allocate a unique guest username');
}

// grantGuest(db, { plugin, guest, expiresAt, mac, ip, inputs }) -> { username, password, expiresAt }
//
// `plugin` is the recipe (as returned by plugins/store.js's getPlugin), used
// for planGroup (RADIUS group) and window.maxGrantHours (a safety cap applied
// on top of whatever the engine already computed, in case a recipe's window
// math or a clock skew hands back something further out than intended).
// `inputs` is the array-of-recipe.inputs-with-value the guest submitted; only
// the values (never secrets) are stored, for support/troubleshooting.
export function grantGuest(db, { plugin, guest, expiresAt, mac, ip, inputs } = {}) {
  const username = uniqueUsername(db);
  const password = randomFrom(ALNUM, 12);

  const maxGrantHours = (plugin && plugin.window && plugin.window.maxGrantHours) || DEFAULT_MAX_GRANT_HOURS;
  const cap = Date.now() + maxGrantHours * HOUR_MS;
  const engineExpiresMs = expiresAt ? Date.parse(expiresAt) : cap;
  const finalExpiresMs = Number.isFinite(engineExpiresMs) ? Math.min(engineExpiresMs, cap) : cap;
  const finalExpiresAt = new Date(finalExpiresMs).toISOString();

  syncUser(db, { username, password, groupname: (plugin && plugin.planGroup) || 'free' });

  const inputValues = {};
  if (Array.isArray(inputs)) {
    for (const i of inputs) {
      if (i && typeof i.name === 'string') inputValues[i.name] = i.value == null ? '' : i.value;
    }
  }

  db.prepare(
    `INSERT INTO plugin_grants (plugin_id, username, mac, ip, guest_label, inputs_json, granted_at, expires_at, active)
     VALUES (@plugin_id, @username, @mac, @ip, @guest_label, @inputs_json, datetime('now'), @expires_at, 1)`,
  ).run({
    plugin_id: (plugin && plugin.id) ?? null,
    username,
    mac: mac || null,
    ip: ip || null,
    guest_label: (guest && guest.label) || null,
    inputs_json: JSON.stringify(inputValues),
    expires_at: finalExpiresAt,
  });

  return { username, password, expiresAt: finalExpiresAt };
}

// Remove expired guest-lookup grants (and their RADIUS users). Returns the
// count removed, same shape as mac/grants.js's sweepMacSessions.
export function sweepPluginGrants(db) {
  const expired = db
    .prepare("SELECT username FROM plugin_grants WHERE active = 1 AND expires_at <= datetime('now')")
    .all();
  const tx = db.transaction(() => {
    for (const { username } of expired) {
      removeUser(db, username);
      db.prepare('UPDATE plugin_grants SET active = 0 WHERE username = ?').run(username);
    }
  });
  tx();
  return expired.length;
}

export function listActiveGrants(db) {
  return db
    .prepare(
      `SELECT g.id, g.plugin_id, p.name AS plugin_name, g.username, g.mac, g.ip,
              g.guest_label, g.granted_at, g.expires_at
         FROM plugin_grants g LEFT JOIN plugins p ON p.id = g.plugin_id
        WHERE g.active = 1 ORDER BY g.expires_at`,
    )
    .all();
}

export function revokeGrant(db, id) {
  const row = db.prepare('SELECT * FROM plugin_grants WHERE id = ?').get(Number(id));
  if (!row) return false;
  removeUser(db, row.username);
  db.prepare('UPDATE plugin_grants SET active = 0 WHERE id = ?').run(row.id);
  return true;
}
