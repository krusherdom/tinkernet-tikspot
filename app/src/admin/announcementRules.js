// Pure announcement rules — no DB, no imports. Kept separate from
// announcements.js so the window/validation logic is unit-testable without
// better-sqlite3 (test/unit.test.js must stay native-free).
//
// An announcement is a short admin-authored banner shown on the captive-portal
// login page, the post-login status page and/or the admin dashboard, optionally
// only inside a start/end window.

export const SEVERITIES = ['info', 'warning', 'danger', 'success'];
export const TARGETS = ['portal', 'status', 'admin'];

// Display order for a stack of banners: the loudest first.
const SEVERITY_RANK = { danger: 0, warning: 1, info: 2, success: 3 };

export const MAX_TITLE = 120;
export const MAX_BODY = 2000;

// Parse a timestamp to epoch ms. Accepts ISO ("2026-01-01T10:00:00.000Z") and
// SQLite's own "YYYY-MM-DD HH:MM:SS" (which is UTC). Returns null when absent
// or unparseable — callers that care about "invalid" use normalizeIso().
export function parseTs(v) {
  if (v == null || v === '') return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Validate + canonicalise one datetime field. '' / null / undefined => null.
export function normalizeIso(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const s = String(v).trim();
  if (!s) return { ok: true, value: null };
  const t = parseTs(s);
  if (t == null) return { ok: false, error: 'must be a date/time' };
  return { ok: true, value: new Date(t).toISOString() };
}

// Is this announcement live right now? `a` is a DB row (or a plain object) with
// enabled / starts_at / ends_at.
export function isActiveAt(a, nowIso) {
  if (!a) return false;
  const enabled = a.enabled === 1 || a.enabled === true || a.enabled === '1';
  if (!enabled) return false;
  const now = parseTs(nowIso) ?? Date.now();
  const start = parseTs(a.starts_at);
  const end = parseTs(a.ends_at);
  if (start != null && start > now) return false;
  if (end != null && end < now) return false;
  return true;
}

// Lifecycle label for the admin table.
export function announcementState(a, nowIso) {
  const enabled = a.enabled === 1 || a.enabled === true || a.enabled === '1';
  if (!enabled) return 'disabled';
  const now = parseTs(nowIso) ?? Date.now();
  const start = parseTs(a.starts_at);
  const end = parseTs(a.ends_at);
  if (start != null && start > now) return 'scheduled';
  if (end != null && end < now) return 'expired';
  return 'active';
}

// Sort comparator: severity (danger first) then newest id first.
export function compareAnnouncements(a, b) {
  const ra = SEVERITY_RANK[a.severity] ?? 9;
  const rb = SEVERITY_RANK[b.severity] ?? 9;
  if (ra !== rb) return ra - rb;
  return (b.id ?? 0) - (a.id ?? 0);
}

// Parse the stored `targets` TEXT column (a JSON array) defensively.
export function parseTargets(raw) {
  if (Array.isArray(raw)) return raw.filter((t) => TARGETS.includes(t));
  try {
    const arr = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(arr) ? arr.filter((t) => TARGETS.includes(t)) : [];
  } catch {
    return [];
  }
}

/**
 * Validate an incoming announcement payload.
 * @returns {{ok:true, value:object} | {ok:false, error:string, fields:object}}
 */
export function validateAnnouncement(body) {
  const b = body && typeof body === 'object' ? body : {};
  const fields = {};

  const title = String(b.title ?? '').trim();
  if (!title) fields.title = 'A title is required';
  else if (title.length > MAX_TITLE) fields.title = `Title must be ${MAX_TITLE} characters or fewer`;

  const text = String(b.body ?? '').trim();
  if (text.length > MAX_BODY) fields.body = `Message must be ${MAX_BODY} characters or fewer`;

  const severity = String(b.severity ?? 'info').trim() || 'info';
  if (!SEVERITIES.includes(severity)) fields.severity = `Severity must be one of ${SEVERITIES.join(', ')}`;

  const rawTargets = Array.isArray(b.targets) ? b.targets : b.targets == null ? [] : [b.targets];
  const targets = [];
  for (const t of rawTargets) {
    const s = String(t);
    if (!TARGETS.includes(s)) {
      fields.targets = `Targets must be a subset of ${TARGETS.join(', ')}`;
      break;
    }
    if (!targets.includes(s)) targets.push(s);
  }
  if (!fields.targets && !targets.length) fields.targets = 'Pick at least one place to show this';

  const start = normalizeIso(b.starts_at);
  if (!start.ok) fields.starts_at = `Start ${start.error}`;
  const end = normalizeIso(b.ends_at);
  if (!end.ok) fields.ends_at = `End ${end.error}`;
  if (start.ok && end.ok && start.value && end.value && parseTs(end.value) < parseTs(start.value)) {
    fields.ends_at = 'End must be after the start';
  }

  const keys = Object.keys(fields);
  if (keys.length) return { ok: false, error: fields[keys[0]], fields };

  return {
    ok: true,
    value: {
      title,
      body: text,
      severity,
      targets,
      starts_at: start.value,
      ends_at: end.value,
      enabled: b.enabled === undefined ? 1 : b.enabled === true || b.enabled === 1 || b.enabled === '1' ? 1 : 0,
    },
  };
}
