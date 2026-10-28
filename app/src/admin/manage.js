// Management API: plans, vouchers, accounts, and live active-users/usage + kick.

import {
  syncPlanToRadius,
  syncUser,
  removeUser,
  removePlanGroup,
} from '../radius/sync.js';
import { activeSessions, usageByUser, findSession, closeSession } from '../radius/active.js';
import { disconnectSession } from '../radius/coa.js';
import { generateUniqueCodes, batchId } from '../voucher/codes.js';
import { sweepVouchers, voucherValidity } from '../voucher/sweeper.js';
import { getNasSecret } from '../radius/nas.js';
import { validateRateLimit, validateNonNegInt, validatePassword, validateExpiryMode } from './validate.js';
import { logAudit } from './audit.js';
import { forgetUserDevices, forgetDevice, ownerOfMac } from '../mac/devices.js';

// HTML-escape for the server-rendered print sheet.
function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'plan';
}

function uniqueGroupname(db, base) {
  let g = base;
  let n = 1;
  while (db.prepare('SELECT 1 FROM plans WHERE radius_groupname = ?').get(g)) g = `${base}-${++n}`;
  return g;
}

function getPlan(db, id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id) ?? null;
}

// Validate the editable limit fields shared by plan create/update. Returns the
// coerced values, or { error } for the caller to send as a 400.
function validatePlanLimits(b) {
  const rate = validateRateLimit(b.rate_limit);
  if (!rate.ok) return { error: rate.error };
  const total = validateNonNegInt(b.total_limit_bytes, 'total_limit_bytes');
  if (!total.ok) return { error: total.error };
  const session = validateNonNegInt(b.session_timeout_secs, 'session_timeout_secs');
  if (!session.ok) return { error: session.error };
  const macValidity = validateNonNegInt(b.mac_validity_secs, 'mac_validity_secs');
  if (!macValidity.ok) return { error: macValidity.error };
  return {
    rate_limit: rate.value,
    total_limit_bytes: total.value,
    session_timeout_secs: session.value,
    mac_validity_secs: macValidity.value,
  };
}

export default async function manageRoutes(app) {
  const db = app.db;

  // ---- Plans -------------------------------------------------------------
  app.get('/api/plans', async () => ({
    plans: db
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM radusergroup rug WHERE rug.groupname = p.radius_groupname) AS members
           FROM plans p ORDER BY p.id`,
      )
      .all(),
  }));

  app.post('/api/plans', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.name) return reply.code(400).send({ error: 'name is required' });
    const limits = validatePlanLimits(b);
    if (limits.error) return reply.code(400).send({ error: limits.error });
    const expiry = validateExpiryMode(b.expiry_mode);
    if (!expiry.ok) return reply.code(400).send({ error: expiry.error });
    const groupname = uniqueGroupname(db, slugify(b.name));
    const plan = {
      name: b.name,
      radius_groupname: groupname,
      kind: b.kind ?? 'voucher',
      rate_limit: limits.rate_limit,
      total_limit_bytes: limits.total_limit_bytes,
      session_timeout_secs: limits.session_timeout_secs,
      mac_remember: b.mac_remember ? 1 : 0,
      mac_validity_secs: limits.mac_validity_secs,
      expiry_mode: expiry.value,
    };
    const info = db
      .prepare(
        `INSERT INTO plans (name, radius_groupname, kind, rate_limit, total_limit_bytes,
                            session_timeout_secs, mac_remember, mac_validity_secs, expiry_mode)
         VALUES (@name,@radius_groupname,@kind,@rate_limit,@total_limit_bytes,
                 @session_timeout_secs,@mac_remember,@mac_validity_secs,@expiry_mode)`,
      )
      .run(plan);
    syncPlanToRadius(db, getPlan(db, info.lastInsertRowid));
    logAudit(db, req, 'plan.create', `${plan.name} (#${info.lastInsertRowid})`);
    return { ok: true, id: info.lastInsertRowid };
  });

  app.patch('/api/plans/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const plan = getPlan(db, id);
    if (!plan) return reply.code(404).send({ error: 'not found' });
    const b = req.body ?? {};
    const limits = validatePlanLimits(b);
    if (limits.error) return reply.code(400).send({ error: limits.error });
    const expiry = validateExpiryMode(b.expiry_mode);
    if (!expiry.ok) return reply.code(400).send({ error: expiry.error });
    // expiry_mode is only updated when the field is present in the request.
    const expiryProvided = b.expiry_mode !== undefined;
    // radius_groupname is immutable (members reference it); limits/name editable.
    // A limit is only changed when its key is present in the body (an explicit
    // null clears it) — so PATCH {name} never wipes the limits. The free plan
    // is editable like any other; only DELETE refuses it.
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    db.prepare(
      `UPDATE plans SET
         name = COALESCE(@name, name),
         kind = COALESCE(@kind, kind),
         rate_limit = CASE WHEN @has_rate = 1 THEN @rate_limit ELSE rate_limit END,
         total_limit_bytes = CASE WHEN @has_total = 1 THEN @total_limit_bytes ELSE total_limit_bytes END,
         session_timeout_secs = CASE WHEN @has_session = 1 THEN @session_timeout_secs ELSE session_timeout_secs END,
         mac_remember = COALESCE(@mac_remember, mac_remember),
         mac_validity_secs = CASE WHEN @has_mac_validity = 1 THEN @mac_validity_secs ELSE mac_validity_secs END,
         expiry_mode = CASE WHEN @expiry_provided = 1 THEN @expiry_mode ELSE expiry_mode END,
         updated_at = datetime('now')
       WHERE id = @id`,
    ).run({
      id,
      name: b.name ?? null,
      kind: b.kind ?? null,
      has_rate: has('rate_limit') ? 1 : 0,
      rate_limit: limits.rate_limit,
      has_total: has('total_limit_bytes') ? 1 : 0,
      total_limit_bytes: limits.total_limit_bytes,
      has_session: has('session_timeout_secs') ? 1 : 0,
      session_timeout_secs: limits.session_timeout_secs,
      mac_remember: b.mac_remember == null ? null : b.mac_remember ? 1 : 0,
      has_mac_validity: has('mac_validity_secs') ? 1 : 0,
      mac_validity_secs: limits.mac_validity_secs,
      expiry_provided: expiryProvided ? 1 : 0,
      expiry_mode: expiry.value,
    });
    const updated = getPlan(db, id);
    syncPlanToRadius(db, updated);
    logAudit(db, req, 'plan.update', `${updated.name} (#${id})`);
    return { ok: true, plan: updated };
  });

  app.delete('/api/plans/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const plan = getPlan(db, id);
    if (!plan) return reply.code(404).send({ error: 'not found' });
    if (plan.radius_groupname === 'free') {
      return reply.code(400).send({ error: 'the free plan cannot be deleted' });
    }
    removePlanGroup(db, plan.radius_groupname);
    db.prepare('DELETE FROM plans WHERE id = ?').run(id);
    logAudit(db, req, 'plan.delete', `${plan.name} (#${id})`);
    return { ok: true };
  });

  // ---- Vouchers ----------------------------------------------------------
  app.post('/api/vouchers/batch', async (req, reply) => {
    const b = req.body ?? {};
    const plan = getPlan(db, Number(b.plan_id));
    if (!plan) return reply.code(400).send({ error: 'valid plan_id is required' });
    const count = Math.min(Math.max(Number(b.count) || 0, 1), 1000);
    const length = Math.min(Math.max(Number(b.length) || 8, 4), 16);
    const codes = generateUniqueCodes(db, count, length);
    const bid = batchId(Date.now());
    // Optional absolute validity window. A date like "2026-07-01" becomes a full
    // day; empty -> null (no gate).
    const validFrom = b.valid_from ? `${b.valid_from} 00:00:00`.slice(0, 19) : null;
    const validUntil = b.valid_until ? `${b.valid_until} 23:59:59`.slice(0, 19) : null;
    const gated = Boolean(validFrom || validUntil);

    const insV = db.prepare(
      `INSERT INTO vouchers (code, plan_id, status, batch_id, valid_from, valid_until)
       VALUES (?, ?, 'unused', ?, ?, ?)`,
    );
    const tx = db.transaction(() => {
      for (const code of codes) {
        insV.run(code, plan.id, bid, validFrom, validUntil);
        // Ungated vouchers work immediately; gated ones are activated by the
        // sweeper once their window opens.
        if (!gated) syncUser(db, { username: code, password: code, groupname: plan.radius_groupname });
      }
    });
    tx();
    if (gated) sweepVouchers(db); // create credentials for any already in-window
    logAudit(db, req, 'voucher.batch', `${codes.length} × ${plan.name} (batch ${bid})`);
    return { ok: true, batch_id: bid, plan: plan.name, count: codes.length, codes, valid_from: validFrom, valid_until: validUntil };
  });

  app.get('/api/vouchers', async (req) => {
    const { status, batch } = req.query ?? {};
    const where = [];
    const args = [];
    if (status) { where.push('v.status = ?'); args.push(status); }
    if (batch) { where.push('v.batch_id = ?'); args.push(batch); }
    const sql = `SELECT v.id, v.code, v.status, v.batch_id, v.created_at, v.first_use_at,
                        v.valid_from, v.valid_until, p.name AS plan_name, p.radius_groupname
                   FROM vouchers v LEFT JOIN plans p ON p.id = v.plan_id
                  ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY v.id DESC LIMIT 2000`;
    const nowIso = db.prepare("SELECT datetime('now') AS t").get().t;
    const vouchers = db.prepare(sql).all(...args).map((v) => ({ ...v, validity: voucherValidity(v, nowIso) }));
    return { vouchers };
  });

  // Printable sheet of vouchers (by batch, all unused with ?all=1, or the latest
  // 200 unused). Opens ready to print; ?cols=2|3|4 sets cards per row.
  app.get('/api/vouchers/print', async (req, reply) => {
    const { batch, all } = req.query ?? {};
    const colsRaw = Number.parseInt(req.query?.cols, 10);
    const cols = Number.isFinite(colsRaw) ? Math.min(Math.max(colsRaw, 2), 4) : 3;
    const select = `SELECT v.code, v.valid_from, v.valid_until, p.name AS plan_name, p.rate_limit,
                           p.session_timeout_secs, p.total_limit_bytes
                      FROM vouchers v LEFT JOIN plans p ON p.id = v.plan_id`;
    const rows = batch
      ? db.prepare(`${select} WHERE v.batch_id = ? AND v.status = 'unused' ORDER BY v.code`).all(batch)
      : all === '1' || all === 'true'
        ? db.prepare(`${select} WHERE v.status = 'unused' ORDER BY v.id DESC`).all()
        : db.prepare(`${select} WHERE v.status = 'unused' ORDER BY v.id DESC LIMIT 200`).all();
    const human = (r) => {
      const bits = [];
      if (r.session_timeout_secs) bits.push(Math.round(r.session_timeout_secs / 60) + ' min');
      if (r.total_limit_bytes) bits.push(Math.round(r.total_limit_bytes / 1048576) + ' MB');
      if (r.rate_limit) bits.push(r.rate_limit);
      return bits.join(' · ');
    };
    // "2026-07-01 00:00:00" -> "1/7/2026" (stored dates are already router-local).
    const dmy = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
      return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : '';
    };
    const validity = (r) => {
      const from = dmy(r.valid_from);
      const until = dmy(r.valid_until);
      if (from && until) return `Valid ${from} – ${until}`;
      if (from) return `Valid from ${from}`;
      if (until) return `Valid until ${until}`;
      return '';
    };
    const cards = rows
      .map((r) => {
        const valid = validity(r);
        return (
          `<div class="v"><div class="code">${esc(r.code)}</div>` +
          `<div class="plan">${esc(r.plan_name || '')}</div>` +
          `<div class="meta">${esc(human(r))}</div>` +
          (valid ? `<div class="valid">${esc(valid)}</div>` : '') +
          `</div>`
        );
      })
      .join('');
    const colOpts = [2, 3, 4]
      .map((n) => `<option value="${n}"${n === cols ? ' selected' : ''}>${n}</option>`)
      .join('');
    reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>Vouchers</title><style>
@page{size:auto;margin:10mm}
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:18px;color:#111}
.noprint{display:flex;gap:12px;align-items:center;margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(var(--cols,3),1fr);gap:10px}
.v{border:1px dashed #666;border-radius:10px;padding:14px;text-align:center;break-inside:avoid;page-break-inside:avoid;min-height:38mm;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;display:flex;flex-direction:column;justify-content:center}
.code{font-size:22px;font-weight:700;letter-spacing:2px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.plan{margin-top:6px;font-size:13px;color:#333}.meta,.valid{font-size:11px;color:#555;margin-top:2px}
@media print{
body{margin:0}
.noprint{display:none}
.grid{gap:4mm}
.v{padding:4mm;border-radius:3mm;border:0.3mm dashed #666}
.code{font-size:16pt;letter-spacing:1pt}
.plan{margin-top:1.5mm;font-size:10pt}
.meta,.valid{font-size:8pt;margin-top:0.5mm}
}
</style></head><body>
<div class="noprint">${rows.length} voucher(s).
<label>Columns <select id="cols" onchange="var u=new URL(location.href);u.searchParams.set('cols',this.value);location.href=u.href">${colOpts}</select></label>
<button onclick="print()">Print</button></div>
<div class="grid" style="--cols:${cols}">${cards}</div></body></html>`);
  });

  app.post('/api/vouchers/:id/revoke', async (req, reply) => {
    const v = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(Number(req.params.id));
    if (!v) return reply.code(404).send({ error: 'not found' });
    removeUser(db, v.code);
    db.prepare("UPDATE vouchers SET status = 'revoked' WHERE id = ?").run(v.id);
    const forgot = forgetUserDevices(db, v.code);
    logAudit(db, req, 'voucher.revoke', v.code + (forgot ? ` (forgot ${forgot} device${forgot === 1 ? '' : 's'})` : ''));
    return { ok: true, forgotDevices: forgot };
  });

  // ---- Accounts ----------------------------------------------------------
  app.get('/api/accounts', async () => ({
    accounts: db
      .prepare(
        `SELECT a.id, a.username, a.enabled, a.created_at, a.plan_id, p.name AS plan_name
           FROM accounts a LEFT JOIN plans p ON p.id = a.plan_id ORDER BY a.id`,
      )
      .all(),
  }));

  app.post('/api/accounts', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.username || !b.password) {
      return reply.code(400).send({ error: 'username and password are required' });
    }
    const pw = validatePassword(b.password);
    if (!pw.ok) return reply.code(400).send({ error: pw.error });
    const plan = b.plan_id ? getPlan(db, Number(b.plan_id)) : null;
    try {
      const info = db
        .prepare(
          `INSERT INTO accounts (username, password, plan_id, enabled, mac_remember_override)
           VALUES (@username, @password, @plan_id, @enabled, @mac)`,
        )
        .run({
          username: b.username,
          password: b.password,
          plan_id: plan?.id ?? null,
          enabled: b.enabled === false ? 0 : 1,
          mac: b.mac_remember_override ?? null,
        });
      syncUser(db, {
        username: b.username,
        password: b.password,
        groupname: plan?.radius_groupname,
        enabled: b.enabled !== false,
      });
      logAudit(db, req, 'account.create', b.username);
      return { ok: true, id: info.lastInsertRowid };
    } catch (err) {
      if (String(err).includes('UNIQUE')) return reply.code(409).send({ error: 'username exists' });
      throw err;
    }
  });

  app.patch('/api/accounts/:id', async (req, reply) => {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(req.params.id));
    if (!acc) return reply.code(404).send({ error: 'not found' });
    const b = req.body ?? {};
    // Only validate/replace the password when the caller actually supplied one;
    // an absent field keeps the existing password (an empty string is rejected).
    let password = acc.password;
    if (b.password !== undefined) {
      const pw = validatePassword(b.password);
      if (!pw.ok) return reply.code(400).send({ error: pw.error });
      password = pw.value;
    }
    const enabled = b.enabled == null ? acc.enabled : b.enabled ? 1 : 0;
    const planId = b.plan_id === undefined ? acc.plan_id : b.plan_id;
    const plan = planId ? getPlan(db, Number(planId)) : null;
    db.prepare(
      `UPDATE accounts SET password = ?, enabled = ?, plan_id = ? WHERE id = ?`,
    ).run(password, enabled, plan?.id ?? null, acc.id);
    syncUser(db, {
      username: acc.username,
      password,
      groupname: plan?.radius_groupname,
      enabled: enabled === 1,
    });
    // Disabling an account forgets its remembered devices (MAC re-auth).
    const forgot = enabled === 1 ? 0 : forgetUserDevices(db, acc.username);
    logAudit(db, req, 'account.update', acc.username + (forgot ? ` (forgot ${forgot} device${forgot === 1 ? '' : 's'})` : ''));
    return { ok: true, ...(forgot ? { forgotDevices: forgot } : {}) };
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(req.params.id));
    if (!acc) return reply.code(404).send({ error: 'not found' });
    removeUser(db, acc.username);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id);
    const forgot = forgetUserDevices(db, acc.username);
    logAudit(db, req, 'account.delete', acc.username + (forgot ? ` (forgot ${forgot} device${forgot === 1 ? '' : 's'})` : ''));
    return { ok: true, forgotDevices: forgot };
  });

  // ---- Active users / usage / kick --------------------------------------
  app.get('/api/active', async () => ({ active: activeSessions(db) }));
  app.get('/api/usage', async () => ({ usage: usageByUser(db) }));

  app.post('/api/active/:sessionId/kick', async (req, reply) => {
    const session = findSession(db, req.params.sessionId);
    if (!session) return reply.code(404).send({ error: 'no such active session' });
    let secret;
    try {
      secret = getNasSecret(db); // throws if not configured — no insecure default
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
    const result = await disconnectSession({
      nasip: session.nasipaddress,
      secret,
      acctSessionId: session.acctsessionid,
      username: session.username,
      framedIp: session.framedipaddress,
    });
    // Kicking also forgets the device's MAC re-auth (else login-by=mac would
    // silently re-admit it) unless the caller sends { forget: false }.
    let forgot = false;
    if (result.ok) {
      closeSession(db, session.acctsessionid);
      const wantForget = !(req.body && req.body.forget === false);
      if (wantForget && session.callingstationid && ownerOfMac(db, session.callingstationid)) {
        forgot = forgetDevice(db, session.callingstationid);
      }
      logAudit(
        db,
        req,
        'session.kick',
        session.username + (forgot ? ` (forgot device ${session.callingstationid})` : ''),
      );
    }
    return { ok: result.ok, output: result.output, forgot };
  });
}
