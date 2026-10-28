// Live view of who's online, sourced from FreeRADIUS accounting (radacct). An
// open session is a row with no acctstoptime. This works without any router
// credentials — FreeRADIUS writes radacct as the hotspot reports accounting.

// Each row also carries `owner` — the user a remembered device (user_devices)
// belongs to, matched on the session's MAC — and `by_mac`, true when the
// session itself logged in by MAC (RADIUS username == the client MAC).
export function activeSessions(db) {
  return db
    .prepare(
      `SELECT r.acctsessionid, r.username, r.framedipaddress AS ip, r.callingstationid AS mac,
              r.nasipaddress, r.acctstarttime, r.acctsessiontime AS session_secs,
              r.acctinputoctets AS in_octets, r.acctoutputoctets AS out_octets,
              (COALESCE(r.acctinputoctets,0) + COALESCE(r.acctoutputoctets,0)) AS total_octets,
              ud.username AS owner
         FROM radacct r
         LEFT JOIN user_devices ud ON ud.active = 1 AND ud.mac = UPPER(REPLACE(r.callingstationid, '-', ':'))
        WHERE r.acctstoptime IS NULL
        ORDER BY r.acctstarttime DESC`,
    )
    .all()
    .map((row) => ({
      ...row,
      by_mac: !!row.mac && String(row.username).toUpperCase().replace(/-/g, ':') === String(row.mac).toUpperCase().replace(/-/g, ':'),
    }));
}

// Aggregate usage per user across all sessions (for the accounting view).
export function usageByUser(db, { limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT username,
              COUNT(*) AS sessions,
              SUM(COALESCE(acctinputoctets,0) + COALESCE(acctoutputoctets,0)) AS total_octets,
              MAX(acctstarttime) AS last_start,
              SUM(CASE WHEN acctstoptime IS NULL THEN 1 ELSE 0 END) AS active_sessions
         FROM radacct
        GROUP BY username
        ORDER BY total_octets DESC
        LIMIT ?`,
    )
    .all(limit);
}

// Look up a single open session by acctsessionid (used by the kick flow).
export function findSession(db, acctSessionId) {
  return (
    db
      .prepare(
        `SELECT acctsessionid, username, nasipaddress, framedipaddress, callingstationid
           FROM radacct WHERE acctsessionid = ? AND acctstoptime IS NULL`,
      )
      .get(acctSessionId) ?? null
  );
}

// Optimistically close a session locally (after a successful kick). The router
// normally also sends an Acct-Stop, which is idempotent with this.
export function closeSession(db, acctSessionId) {
  db.prepare(
    `UPDATE radacct SET acctstoptime = datetime('now'), acctterminatecause = 'Admin-Reset'
      WHERE acctsessionid = ? AND acctstoptime IS NULL`,
  ).run(acctSessionId);
}
