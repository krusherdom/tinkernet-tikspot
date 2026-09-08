// Logs & reports API — surfaces what RADIUS is actually seeing, so the admin can
// tell whether the router is reaching us. Sourced from FreeRADIUS's own tables:
// radpostauth (every Access-Accept/Reject) and radacct (accounting), plus the
// app's own admin_audit (who did what) and events (what the container did).
// All local DB — no router connection needed.

import JSZip from 'jszip';
import { listEvents, LEVELS } from './events.js';
import { pruneNow, storageStats } from './retention.js';
import { getSetting, getTyped } from '../db/settings.js';
import { logAudit } from './audit.js';

// Clamp a ?days= parameter. Defaults to the configured retention window so the
// export covers exactly what the device still has.
function windowDays(db, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Math.max(1, Number(getTyped(db, 'retention_days')) || 30);
  return Math.min(Math.trunc(n), 3650);
}

// RFC4180-ish CSV: quote every field, double embedded quotes, strip CR.
function csvCell(v) {
  if (v == null) return '""';
  return `"${String(v).replace(/\r/g, '').replace(/"/g, '""')}"`;
}
export function toCsv(columns, rows) {
  const head = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\n');
  return rows.length ? `${head}\n${body}\n` : `${head}\n`;
}

// ---------------------------------------------------------------------------
// Reports: a small activity summary over the last N days, built entirely from
// the RADIUS tables. A user's plan is their radusergroup row (lowest priority
// wins) mapped to plans.radius_groupname; anything unmapped is "other".
export function reportSummary(db, days) {
  const since = `-${days} days`;

  const loginsPerDay = db
    .prepare(
      `SELECT date(authdate) AS date,
              SUM(CASE WHEN reply LIKE '%Accept%' THEN 1 ELSE 0 END) AS accepts,
              SUM(CASE WHEN reply LIKE '%Accept%' THEN 0 ELSE 1 END) AS rejects
         FROM radpostauth
        WHERE authdate >= datetime('now', ?)
        GROUP BY date ORDER BY date`,
    )
    .all(since);

  const byPlan = db
    .prepare(
      `SELECT COALESCE(p.name, 'other') AS plan,
              COUNT(*) AS sessions,
              SUM(COALESCE(a.acctinputoctets, 0)) AS bytesIn,
              SUM(COALESCE(a.acctoutputoctets, 0)) AS bytesOut,
              COUNT(DISTINCT a.username) AS users
         FROM radacct a
         LEFT JOIN plans p ON p.radius_groupname = (
                SELECT g.groupname FROM radusergroup g
                 WHERE g.username = a.username ORDER BY g.priority, g.id LIMIT 1)
        WHERE a.acctstarttime >= datetime('now', ?)
        GROUP BY plan ORDER BY sessions DESC`,
    )
    .all(since);

  const topUsers = db
    .prepare(
      `SELECT username, COUNT(*) AS sessions,
              SUM(COALESCE(acctinputoctets, 0) + COALESCE(acctoutputoctets, 0)) AS bytes
         FROM radacct
        WHERE acctstarttime >= datetime('now', ?)
        GROUP BY username ORDER BY bytes DESC, sessions DESC LIMIT 10`,
    )
    .all(since);

  const acct = db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              SUM(COALESCE(acctinputoctets, 0) + COALESCE(acctoutputoctets, 0)) AS bytes
         FROM radacct WHERE acctstarttime >= datetime('now', ?)`,
    )
    .get(since);

  const totals = {
    accepts: loginsPerDay.reduce((a, r) => a + (r.accepts || 0), 0),
    rejects: loginsPerDay.reduce((a, r) => a + (r.rejects || 0), 0),
    sessions: acct?.sessions || 0,
    bytes: acct?.bytes || 0,
  };

  return { days, loginsPerDay, byPlan, topUsers, totals };
}

export default async function logsRoutes(app) {
  const db = app.db;

  app.get('/api/logs/auth', async (req) => {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 500);
    const attempts = db
      .prepare(`SELECT id, username, reply, authdate FROM radpostauth ORDER BY id DESC LIMIT ?`)
      .all(limit)
      .map((r) => ({ ...r, accept: /accept/i.test(r.reply || '') }));

    const since = db
      .prepare(
        `SELECT reply, COUNT(*) AS n FROM radpostauth
          WHERE authdate >= datetime('now','-1 day') GROUP BY reply`,
      )
      .all();
    let accepts24h = 0;
    let rejects24h = 0;
    for (const c of since) {
      if (/accept/i.test(c.reply || '')) accepts24h += c.n;
      else rejects24h += c.n;
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM radpostauth').get().n;
    const lastAcct = db
      .prepare('SELECT MAX(acctstarttime) AS t FROM radacct')
      .get().t;

    return { attempts, accepts24h, rejects24h, total, lastAccounting: lastAcct };
  });

  // Admin action audit trail (plan/voucher/account CRUD, kicks, restores, backups).
  app.get('/api/logs/admin', async (req) => {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 500);
    const entries = db
      .prepare('SELECT id, action, detail, ip, created_at FROM admin_audit ORDER BY id DESC LIMIT ?')
      .all(limit);
    return { entries };
  });

  // App event log (sweep failures, radiusd reloads, CoA results, plugin lookups).
  // ?level= filters to that level *and above*; ?source= is an exact match.
  app.get('/api/logs/events', async (req) => {
    const level = req.query?.level || '';
    const events = listEvents(db, {
      level: LEVELS.includes(level) ? level : undefined,
      source: req.query?.source || undefined,
      limit: req.query?.limit,
    });
    const sources = db.prepare('SELECT DISTINCT source FROM events ORDER BY source').all().map((r) => r.source);
    return { events, sources, levels: LEVELS };
  });

  // What the DB is holding + the policy that bounds it.
  app.get('/api/logs/storage', async () => {
    const stats = storageStats(db);
    return {
      ...stats,
      retention: {
        retention_days: getTyped(db, 'retention_days'),
        retention_max_rows: getTyped(db, 'retention_max_rows'),
      },
      last_retention_sweep_date: getSetting(db, 'last_retention_sweep_date', null),
    };
  });

  app.post('/api/logs/prune', async (req) => {
    const pruned = pruneNow(db);
    const total = Object.values(pruned).reduce((a, b) => a + b, 0);
    logAudit(db, req, 'logs.prune', `${total} row(s)`);
    return { ok: true, pruned, total, ...storageStats(db) };
  });

  // CSV bundle of the last N days, for spreadsheets / off-device retention.
  app.get('/api/logs/export', async (req, reply) => {
    const days = windowDays(db, req.query?.days);
    const since = `-${days} days`;

    const auth = db
      .prepare(
        `SELECT id, username, reply, authdate FROM radpostauth
          WHERE authdate >= datetime('now', ?) ORDER BY id`,
      )
      .all(since);
    const admin = db
      .prepare(
        `SELECT id, action, detail, ip, created_at FROM admin_audit
          WHERE created_at >= datetime('now', ?) ORDER BY id`,
      )
      .all(since);
    const events = db
      .prepare(
        `SELECT id, level, source, message, detail, created_at FROM events
          WHERE created_at >= datetime('now', ?) ORDER BY id`,
      )
      .all(since);
    const sessions = db
      .prepare(
        `SELECT radacctid, username, callingstationid AS mac, framedipaddress AS ip,
                acctstarttime, acctstoptime, acctsessiontime, acctinputoctets, acctoutputoctets,
                acctterminatecause
           FROM radacct
          WHERE acctstoptime IS NOT NULL AND acctstoptime >= datetime('now', ?) ORDER BY radacctid`,
      )
      .all(since);

    const zip = new JSZip();
    zip.file('auth.csv', toCsv(['id', 'username', 'reply', 'authdate'], auth));
    zip.file('admin.csv', toCsv(['id', 'action', 'detail', 'ip', 'created_at'], admin));
    zip.file('events.csv', toCsv(['id', 'level', 'source', 'message', 'detail', 'created_at'], events));
    zip.file(
      'sessions.csv',
      toCsv(
        ['radacctid', 'username', 'mac', 'ip', 'acctstarttime', 'acctstoptime', 'acctsessiontime', 'acctinputoctets', 'acctoutputoctets', 'acctterminatecause'],
        sessions,
      ),
    );

    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const stamp = new Date().toISOString().slice(0, 10);
    logAudit(db, req, 'logs.export', `${days} day(s)`);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="tikspot-logs-${days}d-${stamp}.zip"`)
      .send(buf);
  });

  // Activity summary for the Reports view.
  app.get('/api/reports/summary', async (req) => reportSummary(db, windowDays(db, req.query?.days)));
}
