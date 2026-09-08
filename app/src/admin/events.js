// App event log: things the operator should be able to see later without docker
// logs — sweep failures, radiusd reload results, CoA no-ACKs, plugin lookups,
// backup/restore. Stored in the `events` table, pruned by the retention sweep,
// surfaced via GET /api/logs/events and (level >= warn) the admin notice strip.
//
// Same contract as audit.js: logging must never break the action it records.

export const LEVELS = ['debug', 'info', 'warn', 'error'];

export function logEvent(db, level, source, message, detail) {
  try {
    const lvl = LEVELS.includes(level) ? level : 'info';
    let det = null;
    if (detail != null) {
      try {
        det = typeof detail === 'string' ? detail : JSON.stringify(detail);
      } catch {
        det = String(detail);
      }
      if (det.length > 4000) det = det.slice(0, 4000) + '...';
    }
    db.prepare('INSERT INTO events (level, source, message, detail) VALUES (?, ?, ?, ?)').run(
      lvl,
      String(source || 'app'),
      String(message || ''),
      det,
    );
  } catch {
    // never throw
  }
}

export function listEvents(db, { level, source, limit = 100 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const where = [];
  const params = [];
  if (level && LEVELS.includes(level)) {
    // level filter = this level and above
    const lvls = LEVELS.slice(LEVELS.indexOf(level));
    where.push(`level IN (${lvls.map(() => '?').join(',')})`);
    params.push(...lvls);
  }
  if (source) {
    where.push('source = ?');
    params.push(String(source));
  }
  const sql =
    `SELECT id, level, source, message, detail, created_at FROM events` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...params, lim);
}

// Recent warn/error events for the admin notice strip.
export function recentProblems(db, { hours = 24, limit = 10 } = {}) {
  return db
    .prepare(
      `SELECT id, level, source, message, created_at FROM events
        WHERE level IN ('warn','error') AND created_at >= datetime('now', ?)
        ORDER BY id DESC LIMIT ?`,
    )
    .all(`-${Math.max(1, Number(hours) || 24)} hours`, Math.min(Math.max(Number(limit) || 10, 1), 50));
}
