// Tiny key/value settings helpers over the `settings` table, plus the settings
// REGISTRY: every admin-editable setting with its default, type, label, help text
// and group. The Settings API/tab render from this registry, so adding a setting
// is one entry here. Values are stored as TEXT; typed reads coerce.

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value == null ? null : String(value));
}

export function getBool(db, key, fallback = false) {
  const v = getSetting(db, key, null);
  if (v == null) return fallback;
  return v === '1' || v === 'true';
}

export function getJSON(db, key, fallback = null) {
  const v = getSetting(db, key, null);
  if (v == null) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function setJSON(db, key, value) {
  setSetting(db, key, value == null ? null : JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Registry of admin-editable settings. `type`: 'int' | 'bool' | 'text' | 'select'
// | 'json'. Secrets are never registered here (they have dedicated flows).
export const SETTINGS_REGISTRY = [
  // Portal
  { key: 'portal_title', type: 'text', default: 'Connect to Wi-Fi', group: 'Portal', label: 'Browser tab title', help: 'Shown as the page title on the captive-portal login page.' },
  { key: 'status_page_text', type: 'text', default: "You're connected. Enjoy the Wi-Fi.", group: 'Portal', label: 'Connected page text', help: 'Message shown on the status page after a successful login.' },
  { key: 'logout_page_text', type: 'text', default: "You're logged out. Reconnect any time from the Wi-Fi page.", group: 'Portal', label: 'Logged-out page text', help: 'Message shown after a guest logs out.' },
  { key: 'login_method', type: 'select', default: 'pap', options: ['pap', 'chap'], group: 'Portal', label: 'Login method', help: 'PAP posts the password in clear over the local hotspot network (tested). HTTP-CHAP hashes it client-side (unverified on hardware).' },
  // Logs & retention
  { key: 'retention_days', type: 'int', default: 30, min: 1, max: 3650, group: 'Logs & retention', label: 'Keep logs for (days)', help: 'Auth attempts, closed sessions, admin activity and events older than this are pruned daily.' },
  { key: 'retention_max_rows', type: 'int', default: 5000, min: 100, max: 1000000, group: 'Logs & retention', label: 'Max rows per log table', help: 'Hard cap per table regardless of age; the oldest rows go first.' },
  // Plugins (used from 0.13)
  { key: 'plugin_leeway_hours', type: 'int', default: 24, min: 0, max: 720, group: 'Guest lookup plugins', label: 'Stay-window leeway (hours)', help: 'Guests may log in this many hours before check-in and after check-out.' },
  { key: 'plugin_catalog_url', type: 'text', default: 'https://raw.githubusercontent.com/krusherdom/tinkernet-tikspot/main/plugins/index.json', group: 'Guest lookup plugins', label: 'Plugin catalog URL', help: 'Where "Browse catalog" looks for community recipes: a catalog index.json, a GitHub folder URL (…/tree/main/plugins) or a raw/blob URL. The container needs outbound internet to fetch it.' },
  // Router
  { key: 'hotspot_profiles', type: 'json', default: null, group: 'Router', label: 'Hotspot profiles to manage', help: 'JSON array of hotspot profile names Auto-configure should point at RADIUS, e.g. ["hsprof1"]. Leave empty to manage every profile.' },
  // Health
  { key: 'egress_check_url', type: 'text', default: '', group: 'System', label: 'Egress check URL', help: 'Optional URL the container fetches on the System page to confirm outbound internet works (needed for lookup plugins). Leave blank to skip.' },
];

export function settingSpec(key) {
  return SETTINGS_REGISTRY.find((s) => s.key === key) || null;
}

// Coerce a stored TEXT value to the registry type.
export function coerceSetting(spec, raw) {
  if (raw == null || raw === '') return spec.default;
  switch (spec.type) {
    case 'int': {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.trunc(n) : spec.default;
    }
    case 'bool':
      return raw === '1' || raw === 'true';
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        return spec.default;
      }
    default:
      return String(raw);
  }
}

export function getTyped(db, key) {
  const spec = settingSpec(key);
  if (!spec) return getSetting(db, key, null);
  return coerceSetting(spec, getSetting(db, key, null));
}

// Validate an incoming value against its spec. Returns { ok, value } | { ok:false, error }.
export function validateSettingValue(spec, value) {
  switch (spec.type) {
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: `${spec.label} must be a whole number` };
      if (spec.min != null && n < spec.min) return { ok: false, error: `${spec.label} must be at least ${spec.min}` };
      if (spec.max != null && n > spec.max) return { ok: false, error: `${spec.label} must be at most ${spec.max}` };
      return { ok: true, value: String(n) };
    }
    case 'bool':
      return { ok: true, value: value === true || value === '1' || value === 'true' ? '1' : '0' };
    case 'select':
      if (!spec.options.includes(String(value))) return { ok: false, error: `${spec.label} must be one of ${spec.options.join(', ')}` };
      return { ok: true, value: String(value) };
    case 'json':
      if (value == null || (typeof value === 'string' && value.trim() === '')) return { ok: true, value: null };
      try {
        return { ok: true, value: JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value) };
      } catch {
        return { ok: false, error: `${spec.label} must be valid JSON` };
      }
    default: {
      const s = String(value ?? '');
      if (s.length > 2000) return { ok: false, error: `${spec.label} is too long` };
      return { ok: true, value: s };
    }
  }
}

// All registry settings with current values, for the API/UI.
export function listSettings(db) {
  return SETTINGS_REGISTRY.map((spec) => ({
    key: spec.key,
    type: spec.type,
    group: spec.group,
    label: spec.label,
    help: spec.help,
    options: spec.options,
    min: spec.min,
    max: spec.max,
    default: spec.default,
    value: coerceSetting(spec, getSetting(db, spec.key, null)),
  }));
}
