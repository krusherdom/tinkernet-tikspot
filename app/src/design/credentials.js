// Free-login plan wiring. A `free-login` block can point at any plan (group),
// not just the built-in "free" one — but the portal needs an actual RADIUS
// identity to submit for it. `syncFreeCredentials` keeps one shared
// `free-<group>` RADIUS user per referenced group (random password, stashed in
// the `free_credentials` setting so the same identity survives a re-publish),
// and tears one down once no published free-login block references it anymore.
// The built-in "free" plan keeps using FREE_USERNAME/FREE_PASSWORD from config.

import crypto from 'node:crypto';
import { syncUser, removeUser } from '../radius/sync.js';
import { getJSON, setJSON } from '../db/settings.js';

const SETTING_KEY = 'free_credentials';

function randomPassword(len = 16) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

// Every group a free-login block (top level or inside a column) references,
// excluding the built-in "free" plan.
export function collectFreeGroups(blocks) {
  const groups = new Set();
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'free-login') {
        const plan = b.props?.plan;
        if (plan && plan !== 'free') groups.add(String(plan));
      } else if (b.type === 'columns') {
        walk(b.props?.left);
        walk(b.props?.right);
      }
    }
  };
  walk(blocks);
  return groups;
}

// Ensure a `free-<group>` RADIUS user exists for every non-"free" plan a
// free-login block in `design.blocks` references, and remove any that are no
// longer referenced. Only the login page's blocks matter — free-login is a
// login-page-only block type.
export function syncFreeCredentials(db, design) {
  const groups = collectFreeGroups(design?.blocks);
  const creds = { ...(getJSON(db, SETTING_KEY, {}) || {}) };
  let changed = false;

  for (const group of groups) {
    if (!creds[group]) {
      creds[group] = randomPassword(16);
      changed = true;
    }
    syncUser(db, { username: `free-${group}`, password: creds[group], groupname: group });
  }

  for (const group of Object.keys(creds)) {
    if (!groups.has(group)) {
      removeUser(db, `free-${group}`);
      delete creds[group];
      changed = true;
    }
  }

  if (changed) setJSON(db, SETTING_KEY, creds);
  return creds;
}
