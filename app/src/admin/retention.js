// Retention sweep: keep the on-router SQLite file bounded. Once per router-local
// day (same daily-gate pattern as radius/midnight.js) prune radpostauth, CLOSED
// radacct rows, admin_audit and events — first by age (retention_days), then by a
// per-table row cap (retention_max_rows). Open sessions in radacct are never
// touched, so Active users is unaffected; Usage totals become "last N days".

import { getSetting, setSetting, getTyped } from '../db/settings.js';
import { routerLocalDate } from '../radius/midnight.js';
import { logEvent } from './events.js';

// Tables and the column that carries their timestamp. radacct is special-cased
// (only closed sessions, keyed on acctstoptime).
export const RETENTION_TABLES = [
  { table: 'radpostauth', tsCol: 'authdate', idCol: 'id' },
  { table: 'radacct', tsCol: 'acctstoptime', idCol: 'radacctid', closedOnly: true },
  { table: 'admin_audit', tsCol: 'created_at', idCol: 'id' },
  { table: 'events', tsCol: 'created_at', idCol: 'id' },
];

// Pure helper (unit-tested): the cutoff timestamp (SQLite datetime format) and
// row cap for a policy.
export function retentionCutoffs({ days, maxRows }, nowMs = Date.now()) {
  const dn = Number(days);
  const rn = Number(maxRows);
  const d = Math.max(1, Math.trunc(Number.isFinite(dn) ? dn : 30));
  const rows = Math.max(100, Math.trunc(Number.isFinite(rn) ? rn : 5000));
  const cutoff = new Date(nowMs - d * 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return { days: d, maxRows: rows, cutoff };
}

// Prune every table now (ignores the daily gate). Returns { table: deleted }.
export function pruneNow(db, nowMs = Date.now()) {
  const { cutoff, maxRows } = retentionCutoffs(
    { days: getTyped(db, 'retention_days'), maxRows: getTyped(db, 'retention_max_rows') },
    nowMs,
  );
  const result = {};
  const tx = db.transaction(() => {
    for (const t of RETENTION_TABLES) {
      const scope = t.closedOnly ? `${t.tsCol} IS NOT NULL` : '1=1';
      let n = db.prepare(`DELETE FROM ${t.table} WHERE ${scope} AND ${t.tsCol} < ?`).run(cutoff).changes;
      // Row cap: delete the oldest rows beyond the cap (by id).
      const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t.table} WHERE ${scope}`).get().c;
      if (c > maxRows) {
        n += db
          .prepare(
            `DELETE FROM ${t.table} WHERE ${t.idCol} IN (
               SELECT ${t.idCol} FROM ${t.table} WHERE ${scope} ORDER BY ${t.idCol} ASC LIMIT ?)`,
          )
          .run(c - maxRows).changes;
      }
      result[t.table] = n;
    }
  });
  tx();
  return result;
}

// Daily-gated sweep tick. Returns the prune result or null if nothing ran.
export function sweepRetention(db, log, nowMs = Date.now()) {
  const today = routerLocalDate(db, nowMs);
  const last = getSetting(db, 'last_retention_sweep_date', null);
  if (last === today) return null;
  setSetting(db, 'last_retention_sweep_date', today);
  const res = pruneNow(db, nowMs);
  const total = Object.values(res).reduce((a, b) => a + b, 0);
  if (total > 0) {
    logEvent(db, 'info', 'retention', `Pruned ${total} old log row(s)`, res);
    if (log) log.info(res, 'retention sweep pruned rows');
  }
  return res;
}

// Per-table row counts + DB size for the Logs "Storage" card.
export function storageStats(db) {
  const tables = ['radpostauth', 'radacct', 'admin_audit', 'events', 'radcheck', 'vouchers', 'accounts', 'mac_sessions'];
  const counts = {};
  for (const t of tables) {
    try {
      counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    } catch {
      counts[t] = null;
    }
  }
  let fileBytes = null;
  try {
    const pc = db.prepare('PRAGMA page_count').get().page_count;
    const ps = db.prepare('PRAGMA page_size').get().page_size;
    fileBytes = pc * ps;
  } catch {
    /* ignore */
  }
  return { counts, fileBytes };
}
