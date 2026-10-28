// Projection layer: app concepts (plans, users) -> FreeRADIUS SQL tables.
//
// The app owns plans/users in its own tables; FreeRADIUS authenticates against
// radcheck/radgroupreply/radusergroup. These helpers keep the RADIUS tables in
// sync. All are idempotent (delete-then-insert for the owned rows).

const MAX_UINT32 = 0xffffffff;

// Project a plan's limits onto its RADIUS group's reply attributes.
export function syncPlanToRadius(db, plan) {
  const g = plan.radius_groupname;
  db.prepare('DELETE FROM radgroupreply WHERE groupname = ?').run(g);
  const ins = db.prepare(
    'INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, ?, ?, ?)',
  );

  if (plan.rate_limit) {
    // Mikrotik-Rate-Limit string: "rx-rate/tx-rate" (e.g. "5M/5M").
    ins.run(g, 'Mikrotik-Rate-Limit', ':=', String(plan.rate_limit));
  }

  if (plan.total_limit_bytes != null) {
    // Mikrotik-Total-Limit is a uint32 byte count; values over 4 GiB need the
    // companion Gigawords attribute (high 32 bits).
    const total = Number(plan.total_limit_bytes);
    ins.run(g, 'Mikrotik-Total-Limit', ':=', String(total % (MAX_UINT32 + 1)));
    const giga = Math.floor(total / (MAX_UINT32 + 1));
    if (giga > 0) ins.run(g, 'Mikrotik-Total-Limit-Gigawords', ':=', String(giga));
  }

  if (plan.expiry_mode === 'midnight') {
    // Daily-renew plans: the real enforcer is the local-midnight CoA sweep
    // (radius/midnight.js). Project a 24h cap as a safety net so a session can't
    // outlive ~a day if a sweep is missed.
    ins.run(g, 'Session-Timeout', ':=', '86400');
  } else if (plan.session_timeout_secs != null) {
    ins.run(g, 'Session-Timeout', ':=', String(plan.session_timeout_secs));
  }
}

// Ensure a username authenticates with the given cleartext password and belongs
// to the given group. Used for the shared "free" credential, vouchers and
// accounts. If `enabled` is false the user is given an Auth-Type := Reject check
// item so the credential exists but cannot log in.
export function syncUser(db, { username, password, groupname, enabled = true }) {
  db.prepare('DELETE FROM radcheck WHERE username = ?').run(username);
  db.prepare(
    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)",
  ).run(username, password);
  if (!enabled) {
    db.prepare(
      "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Auth-Type', ':=', 'Reject')",
    ).run(username);
  }

  db.prepare('DELETE FROM radusergroup WHERE username = ?').run(username);
  if (groupname) {
    db.prepare('INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)').run(
      username,
      groupname,
    );
  }
}

// Project a remembered device (MAC re-auth) as a RADIUS user: username = MAC
// (canonical AA:BB:CC:DD:EE:FF). RouterOS login-by=mac with
// mac-auth-mode=mac-as-username sends an EMPTY User-Password, so there is no
// password row — `Auth-Type := Accept` short-circuits authentication and the
// user's plan group supplies the reply attributes. Idempotent.
export function syncMacUser(db, { mac, groupname }) {
  removeUser(db, mac);
  db.prepare(
    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Auth-Type', ':=', 'Accept')",
  ).run(mac);
  if (groupname) {
    db.prepare('INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)').run(mac, groupname);
  }
}

// Remove a username entirely from the RADIUS tables.
export function removeUser(db, username) {
  db.prepare('DELETE FROM radcheck WHERE username = ?').run(username);
  db.prepare('DELETE FROM radreply WHERE username = ?').run(username);
  db.prepare('DELETE FROM radusergroup WHERE username = ?').run(username);
}

// Remove a plan's group reply attributes (when a plan is deleted).
export function removePlanGroup(db, groupname) {
  db.prepare('DELETE FROM radgroupreply WHERE groupname = ?').run(groupname);
  db.prepare('DELETE FROM radgroupcheck WHERE groupname = ?').run(groupname);
}
