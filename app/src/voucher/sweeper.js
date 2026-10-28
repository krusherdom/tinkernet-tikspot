// Date-gated vouchers: enable a voucher's RADIUS credential only while it is
// inside its [valid_from, valid_until] window, and expire it afterwards. Mirrors
// the remembered-devices sweeper (app/src/mac/devices.js) and runs on the same
// interval. An expired voucher's remembered devices are forgotten with it.
// Time comes from the container clock, which is the MikroTik host clock.

import { syncUser, removeUser } from '../radius/sync.js';
import { forgetUserDevices } from '../mac/devices.js';

function hasCred(db, code) {
  return !!db.prepare('SELECT 1 FROM radcheck WHERE username = ? LIMIT 1').get(code);
}

export function sweepVouchers(db) {
  // datetime() parses both 'YYYY-MM-DD' and full timestamps, so comparisons are
  // robust regardless of how the dates were entered.
  const rows = db
    .prepare(
      `SELECT v.id, v.code, p.radius_groupname AS groupname,
              (v.valid_until IS NOT NULL AND datetime(v.valid_until) < datetime('now')) AS afterEnd,
              (v.valid_from  IS NOT NULL AND datetime(v.valid_from)  > datetime('now')) AS beforeStart
         FROM vouchers v LEFT JOIN plans p ON p.id = v.plan_id
        WHERE (v.valid_from IS NOT NULL OR v.valid_until IS NOT NULL)
          AND v.status NOT IN ('revoked','used','expired')`,
    )
    .all();

  let changed = 0;
  const tx = db.transaction(() => {
    for (const v of rows) {
      if (v.afterEnd) {
        if (hasCred(db, v.code)) removeUser(db, v.code);
        db.prepare("UPDATE vouchers SET status = 'expired' WHERE id = ?").run(v.id);
        forgetUserDevices(db, v.code);
        changed++;
      } else if (v.beforeStart) {
        // not yet valid — make sure no credential exists
        if (hasCred(db, v.code)) { removeUser(db, v.code); changed++; }
      } else {
        // inside the window — ensure the credential exists
        if (!hasCred(db, v.code) && v.groupname) {
          syncUser(db, { username: v.code, password: v.code, groupname: v.groupname });
          changed++;
        }
      }
    }
  });
  tx();
  return changed;
}

// Display status for the UI, computed from the stored status + the window.
export function voucherValidity(v, nowIso) {
  if (v.status === 'revoked' || v.status === 'used' || v.status === 'expired') return v.status;
  if (v.valid_from || v.valid_until) {
    if (v.valid_until && v.valid_until < nowIso) return 'expired';
    if (v.valid_from && v.valid_from > nowIso) return 'scheduled';
    return 'active'; // inside its window, not yet used
  }
  return v.status; // ungated -> 'unused'
}
