// Guest matching + stay-window logic. Pure functions, no I/O.

// normalize(value, mode) — used both directly and internally by matchRecord.
export function normalize(value, mode) {
  const s = value == null ? '' : String(value);
  switch (mode) {
    case 'trim':
      return s.trim();
    case 'name':
      return s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // strip diacritics
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '') // strip punctuation
        .replace(/\s+/g, ' ')
        .trim();
    case 'phone':
    case 'digits':
      return s.replace(/\D/g, '');
    case 'email':
      return s.trim().toLowerCase();
    case 'upper':
      return s.trim().toUpperCase();
    default:
      return s.trim();
  }
}

// `inputs` (the guest's submitted answers) is accepted in either shape:
//   - array shaped like recipe.inputs with `value` added (preferred — carries
//     `required` so "empty input on an optional field passes" can be honored)
//   - plain object map { name: value } (required is then assumed false)
function resolveInput(inputs, name) {
  if (Array.isArray(inputs)) {
    const def = inputs.find((i) => i && i.name === name);
    return { value: def ? def.value : undefined, required: !!(def && def.required) };
  }
  if (inputs && typeof inputs === 'object') {
    return { value: inputs[name], required: false };
  }
  return { value: undefined, required: false };
}

function isEmptyValue(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function valuesMatch(inputVal, recordVal, mode) {
  if (recordVal === undefined || recordVal === null) return false;
  if (mode === 'phone') {
    const a = normalize(inputVal, 'phone');
    const b = normalize(recordVal, 'phone');
    if (!a || !b) return false;
    // Compare the last 9 digits when both sides have at least that many —
    // tolerates country-code / leading-zero mismatches (e.g. +44 7…  vs 07…).
    if (a.length >= 9 && b.length >= 9) return a.slice(-9) === b.slice(-9);
    return a === b;
  }
  return normalize(inputVal, mode) === normalize(recordVal, mode);
}

function evalRule(rule, record, inputs) {
  const { value, required } = resolveInput(inputs, rule.input);
  if (isEmptyValue(value)) return !required;
  const mode = rule.normalize || 'trim';
  const candidates = Array.isArray(rule.anyOf) && rule.anyOf.length ? rule.anyOf : [rule.field];
  return candidates.some((f) => valuesMatch(value, record ? record[f] : undefined, mode));
}

// matchRecord(matchSpec, record, inputs) -> boolean
// matchSpec = { all: true|false, rules:[{input, field|anyOf, normalize}] }
export function matchRecord(matchSpec, record, inputs) {
  const rules = (matchSpec && matchSpec.rules) || [];
  if (!rules.length) return false;
  const results = rules.map((rule) => evalRule(rule, record, inputs));
  return matchSpec.all === false ? results.some(Boolean) : results.every(Boolean);
}

// findGuest(matchSpec, records, inputs) -> first matching record, or null.
export function findGuest(matchSpec, records, inputs) {
  const list = Array.isArray(records) ? records : [];
  for (const record of list) {
    if (matchRecord(matchSpec, record, inputs)) return record;
  }
  return null;
}

const DEFAULT_MAX_GRANT_HOURS = 168;
const HOUR_MS = 3600 * 1000;

// inWindow(windowSpec, record, nowMs, parseDate) -> { ok, reason?, expiresAt }
//
// `parseDate` is a *unary* function (value) -> epochMs|null, already bound to
// the recipe's dateFormat by the caller (see engine.js), so this module has
// no dependency on parsers.js.
//
// windowSpec absent entirely -> always ok, granted maxGrantHours (default
// 168) from now. windowSpec present but the record is missing either date ->
// 'missing-dates'. Otherwise a two-sided leeway window: the stay is "in
// window" while `start - leeway <= now <= end + leeway`, and the credential
// expires at min(end + leeway, now + maxGrantHours).
export function inWindow(windowSpec, record, nowMs, parseDate) {
  const maxGrantHours =
    windowSpec && windowSpec.maxGrantHours != null ? windowSpec.maxGrantHours : DEFAULT_MAX_GRANT_HOURS;

  if (!windowSpec) {
    return { ok: true, expiresAt: new Date(nowMs + maxGrantHours * HOUR_MS).toISOString() };
  }

  const leewayHours = windowSpec.leewayHours != null ? windowSpec.leewayHours : 24;
  const leewayMs = leewayHours * HOUR_MS;

  const startRaw = record ? record[windowSpec.start] : undefined;
  const endRaw = record ? record[windowSpec.end] : undefined;
  const startMs = startRaw != null ? parseDate(startRaw) : null;
  const endMs = endRaw != null ? parseDate(endRaw) : null;

  if (startMs == null || endMs == null) {
    return { ok: false, reason: 'missing-dates', expiresAt: null };
  }
  if (nowMs < startMs - leewayMs) {
    return { ok: false, reason: 'not-started', expiresAt: null };
  }
  if (nowMs > endMs + leewayMs) {
    return { ok: false, reason: 'ended', expiresAt: null };
  }

  const cap = nowMs + maxGrantHours * HOUR_MS;
  const expiresMs = Math.min(endMs + leewayMs, cap);
  return { ok: true, expiresAt: new Date(expiresMs).toISOString() };
}
