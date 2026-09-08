// Announcements: short admin-authored banners shown on the captive-portal login
// page, the post-login status page and/or the admin dashboard, optionally only
// inside a time window ("Pool closed 9-11 Saturday", "Wi-Fi maintenance tonight").
//
// The pure window/validation rules live in announcementRules.js so they can be
// unit-tested without better-sqlite3; this module is the DB + HTTP layer.

import { logAudit } from './audit.js';
import { recentProblems } from './events.js';
import {
  announcementState,
  compareAnnouncements,
  isActiveAt,
  parseTargets,
  validateAnnouncement,
} from './announcementRules.js';

export { isActiveAt, validateAnnouncement };

const SELECT_ALL =
  'SELECT id, title, body, severity, targets, starts_at, ends_at, enabled, created_at, updated_at FROM announcements';

function shape(row) {
  return { ...row, targets: parseTargets(row.targets), enabled: row.enabled ? 1 : 0 };
}

/**
 * Announcements that should render right now for one surface.
 * @param {object} db
 * @param {'portal'|'status'|'admin'} target
 * @param {string} [nowIso]
 */
export function activeAnnouncements(db, target, nowIso) {
  let rows;
  try {
    rows = db.prepare(`${SELECT_ALL} WHERE enabled = 1`).all();
  } catch {
    // Table missing (pre-v5 DB mid-upgrade) must never take the portal down.
    return [];
  }
  return rows
    .map(shape)
    .filter((a) => a.targets.includes(target) && isActiveAt(a, nowIso))
    .sort(compareAnnouncements);
}

export function listAnnouncements(db, nowIso) {
  return db
    .prepare(`${SELECT_ALL} ORDER BY id DESC`)
    .all()
    .map(shape)
    .map((a) => ({ ...a, state: announcementState(a, nowIso) }));
}

export function getAnnouncement(db, id) {
  const row = db.prepare(`${SELECT_ALL} WHERE id = ?`).get(id);
  return row ? shape(row) : null;
}

export function createAnnouncement(db, v) {
  const info = db
    .prepare(
      `INSERT INTO announcements (title, body, severity, targets, starts_at, ends_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(v.title, v.body, v.severity, JSON.stringify(v.targets), v.starts_at, v.ends_at, v.enabled);
  return getAnnouncement(db, info.lastInsertRowid);
}

export function updateAnnouncement(db, id, v) {
  db.prepare(
    `UPDATE announcements
        SET title = ?, body = ?, severity = ?, targets = ?, starts_at = ?, ends_at = ?, enabled = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(v.title, v.body, v.severity, JSON.stringify(v.targets), v.starts_at, v.ends_at, v.enabled, id);
  return getAnnouncement(db, id);
}

export default async function announcementRoutes(app) {
  const db = app.db;

  app.get('/api/announcements', async () => ({ announcements: listAnnouncements(db) }));

  app.post('/api/announcements', async (req, reply) => {
    const v = validateAnnouncement(req.body);
    if (!v.ok) return reply.code(400).send({ error: v.error, fields: v.fields });
    const row = createAnnouncement(db, v.value);
    logAudit(db, req, 'announcement.create', `${row.title} (#${row.id})`);
    return { announcement: { ...row, state: announcementState(row) } };
  });

  app.patch('/api/announcements/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getAnnouncement(db, id);
    if (!existing) return reply.code(404).send({ error: 'announcement not found' });
    // PATCH semantics: merge over the current row so a partial body (e.g. just
    // {enabled:false} from the table toggle) is valid.
    const merged = { ...existing, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
    const v = validateAnnouncement(merged);
    if (!v.ok) return reply.code(400).send({ error: v.error, fields: v.fields });
    const row = updateAnnouncement(db, id, v.value);
    logAudit(db, req, 'announcement.update', `${row.title} (#${id})`);
    return { announcement: { ...row, state: announcementState(row) } };
  });

  app.delete('/api/announcements/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getAnnouncement(db, id);
    if (!existing) return reply.code(404).send({ error: 'announcement not found' });
    db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
    logAudit(db, req, 'announcement.delete', `${existing.title} (#${id})`);
    return { ok: true };
  });

  // What the admin dashboard's notice strip shows: live admin-target
  // announcements plus anything that went wrong in the last day.
  app.get('/api/notices', async () => ({
    announcements: activeAnnouncements(db, 'admin'),
    problems: recentProblems(db, { hours: 24, limit: 10 }),
  }));
}
