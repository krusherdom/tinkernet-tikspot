// Per-user detail view (0.18): one page per login identity — voucher code,
// account username, plugin guest (pg-*), the shared free credential — showing
// what it is, the devices remembered against it (user_devices, see
// mac/devices.js) and the RADIUS sessions / auth attempts made by it or by any
// of its MACs (MAC re-auth logs in with username = MAC). A MAC-shaped username
// that is an active remembered device redirects to its owner.

import { FREE_USERNAME } from '../config.js';
import { normMac, listUserDevices, forgetDevice, ownerOfMac } from '../mac/devices.js';
import { logAudit } from './audit.js';

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;


// SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO -> ms; NaN when unparseable.
function toMs(s) {
  if (!s) return NaN;
  const str = String(s);
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str) ? str.replace(' ', 'T') + 'Z' : str);
}

function planById(db, id) {
  if (id == null) return null;
  const p = db.prepare('SELECT id, name, radius_groupname AS groupname FROM plans WHERE id = ?').get(id);
  return p ?? null;
}

// Plan via the RADIUS group the user is placed in (guests / free / unknown).
function planByUserGroup(db, username) {
  const p = db
    .prepare(
      `SELECT p.id, p.name, p.radius_groupname AS groupname
         FROM radusergroup g JOIN plans p ON p.radius_groupname = g.groupname
        WHERE g.username = ? ORDER BY g.priority LIMIT 1`,
    )
    .get(username);
  if (p) return p;
  const g = db.prepare('SELECT groupname FROM radusergroup WHERE username = ? ORDER BY priority LIMIT 1').get(username);
  return g ? { id: null, name: null, groupname: g.groupname } : null;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function resolveUser(db, username) {
  const name = String(username ?? '').trim();
  if (!name) return null;

  // 1. A remembered device (MAC-as-username re-auth) -> its owner.
  if (MAC_RE.test(name)) {
    const mac = normMac(name);
    const owner = mac ? ownerOfMac(db, mac) : null;
    if (owner) {
      return {
        username: mac, kind: 'mac', label: mac, owner, plan: null, status: 'active',
        expires_at: null, created_at: null, meta: {},
      };
    }
  }

  // 2. Plugin guest grant.
  if (name.startsWith('pg-')) {
    const g = db.prepare('SELECT * FROM plugin_grants WHERE username = ?').get(name);
    if (g) {
      let pluginName = null;
      if (g.plugin_id != null && tableExists(db, 'plugins')) {
        pluginName = db.prepare('SELECT name FROM plugins WHERE id = ?').get(g.plugin_id)?.name ?? null;
      }
      const expired = toMs(g.expires_at) <= Date.now();
      return {
        username: name,
        kind: 'guest',
        label: g.guest_label || name,
        plan: planByUserGroup(db, name),
        status: !g.active ? (expired ? 'expired' : 'revoked') : expired ? 'expired' : 'active',
        expires_at: g.expires_at,
        created_at: g.granted_at,
        meta: { plugin_id: g.plugin_id, plugin_name: pluginName, mac: g.mac, ip: g.ip },
      };
    }
  }

  // 3. Voucher code.
  const v = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(name);
  if (v) {
    let status = v.status;
    if (status !== 'revoked' && v.expires_at && toMs(v.expires_at) <= Date.now()) status = 'expired';
    else if (status === 'used') status = 'active';
    else if (status === 'unused' && v.valid_from && toMs(v.valid_from) > Date.now()) status = 'scheduled';
    return {
      username: name,
      kind: 'voucher',
      label: name,
      plan: planById(db, v.plan_id),
      status,
      expires_at: v.expires_at ?? v.valid_until ?? null,
      created_at: v.created_at,
      meta: {
        batch_id: v.batch_id, first_use_at: v.first_use_at,
        valid_from: v.valid_from, valid_until: v.valid_until,
      },
    };
  }

  // 4. Named account.
  const a = db.prepare('SELECT id, username, plan_id, enabled, created_at FROM accounts WHERE username = ?').get(name);
  if (a) {
    return {
      username: name,
      kind: 'account',
      label: name,
      plan: planById(db, a.plan_id),
      status: a.enabled ? 'enabled' : 'disabled',
      expires_at: null,
      created_at: a.created_at,
      meta: { id: a.id },
    };
  }

  // 5. The shared free credential.
  if (name === FREE_USERNAME) {
    return {
      username: name, kind: 'free', label: 'Free access', plan: planByUserGroup(db, name),
      status: 'active', expires_at: null, created_at: null, meta: {},
    };
  }

  // 6. Something RADIUS knows about but the app doesn't (legacy / hand-made).
  const inRadcheck = !!db.prepare('SELECT 1 FROM radcheck WHERE username = ? LIMIT 1').get(name);
  const inRadacct = !!db.prepare('SELECT 1 FROM radacct WHERE username = ? LIMIT 1').get(name);
  if (inRadcheck || inRadacct) {
    return {
      username: name, kind: 'unknown', label: name, plan: planByUserGroup(db, name),
      status: inRadcheck ? 'radius user' : 'seen', expires_at: null, created_at: null,
      meta: { radcheck: inRadcheck },
    };
  }
  return null;
}

function inList(names) {
  return names.map(() => '?').join(',');
}

export function userSessions(db, names, limit = 100) {
  return db
    .prepare(
      `SELECT radacctid, username, callingstationid AS mac, framedipaddress AS ip,
              acctstarttime AS start, acctstoptime AS stop, acctsessiontime AS secs,
              acctinputoctets AS in_octets, acctoutputoctets AS out_octets,
              acctterminatecause AS cause
         FROM radacct WHERE username IN (${inList(names)})
        ORDER BY acctstarttime DESC LIMIT ?`,
    )
    .all(...names, limit);
}

export function userAuthLog(db, names, limit = 50) {
  return db
    .prepare(
      `SELECT username, reply, authdate FROM radpostauth
        WHERE username IN (${inList(names)})
        ORDER BY authdate DESC, id DESC LIMIT ?`,
    )
    .all(...names, limit);
}

export default async function usersRoutes(app) {
  const db = app.db;

  app.get('/api/users/:username', async (req, reply) => {
    const user = resolveUser(db, req.params.username);
    if (!user) return reply.code(404).send({ error: 'not found' });
    if (user.kind === 'mac') return { redirect: user.owner };
    const devices = listUserDevices(db, user.username, { includeInactive: true }) || [];
    const names = [user.username];
    for (const d of devices) if (d.mac && !names.includes(d.mac)) names.push(d.mac);
    return {
      user,
      devices,
      sessions: userSessions(db, names),
      auth: userAuthLog(db, names),
    };
  });

  app.delete('/api/users/:username/devices/:mac', async (req, reply) => {
    const mac = normMac(req.params.mac);
    if (!mac) return reply.code(400).send({ error: 'invalid MAC address' });
    const forgot = !!(await forgetDevice(db, mac));
    logAudit(db, req, 'device.forget', `${mac} (${req.params.username})`);
    return { ok: true, forgot };
  });
}
