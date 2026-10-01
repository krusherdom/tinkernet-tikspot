// The zero-touch bootstrap outcome, stored as JSON in the `bootstrap_status`
// setting so /healthz (and an operator curl-ing it from the router) can see
// what the env provisioned without docker logs. Built only from setting/env
// NAMES, step names and statuses — never values — so it is safe to expose.
//
// Shape:
//   { at, mode, applied:[names], plugin:{name,id}|null,
//     router:{ok, steps:[{step,status}], error?, skipped?, attempts?}|null,
//     warnings:[...] }

import { getJSON, setJSON } from '../db/settings.js';

export const STATUS_KEY = 'bootstrap_status';

export function readBootstrapStatus(db) {
  try {
    const s = getJSON(db, STATUS_KEY, null);
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

export function writeBootstrapStatus(db, status) {
  setJSON(db, STATUS_KEY, status);
}

// Merge `patch` into the stored status (warnings are appended, not replaced).
export function patchBootstrapStatus(db, patch) {
  const cur = readBootstrapStatus(db) || { at: new Date().toISOString(), mode: null, applied: [], plugin: null, router: null, warnings: [] };
  const next = { ...cur, ...patch };
  if (patch.warnings) next.warnings = [...(cur.warnings || []), ...patch.warnings];
  writeBootstrapStatus(db, next);
  return next;
}
