// Input validation helpers for the management API. Small and dependency-free.
// Each returns { ok: true, value } on success or { ok: false, error } on failure
// so callers can `reply.code(400).send({ error })` uniformly.

// MikroTik rate-limit string: "rx-rate/tx-rate", each a number with an optional
// k/M/G suffix — e.g. "5M/5M", "512k/1M", "10000000/10000000". Empty -> null.
const RATE_RE = /^\d+(\.\d+)?[kKmMgG]?\/\d+(\.\d+)?[kKmMgG]?$/;

export function validateRateLimit(v) {
  if (v == null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || !RATE_RE.test(v.trim())) {
    return { ok: false, error: 'rate_limit must look like "5M/5M" (rx/tx)' };
  }
  return { ok: true, value: v.trim() };
}

// Non-negative integer (bytes / seconds). Empty -> null (unlimited).
export function validateNonNegInt(v, field) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { ok: false, error: `${field} must be a non-negative whole number` };
  }
  return { ok: true, value: n };
}

// Plan expiry mode: 'fixed' (or empty) -> null (use session_timeout_secs); 'midnight'
// -> sessions renew at the next router-local midnight.
export function validateExpiryMode(v) {
  if (v == null || v === '' || v === 'fixed') return { ok: true, value: null };
  if (v === 'midnight') return { ok: true, value: 'midnight' };
  return { ok: false, error: "expiry_mode must be 'fixed' or 'midnight'" };
}

export const MIN_PASSWORD_LEN = 6;

export function validatePassword(v, field = 'password') {
  if (typeof v !== 'string' || v.length < MIN_PASSWORD_LEN) {
    return { ok: false, error: `${field} must be at least ${MIN_PASSWORD_LEN} characters` };
  }
  return { ok: true, value: v };
}

// ---------------------------------------------------------------------------
// Router-connection validators (POST /api/setup/router). Every field is OPTIONAL:
// the setup form always posts the whole set, and an empty value means "not set
// yet" (the wizard's Skip path), so only non-empty values are checked.

const MAX_HOST = 253;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// A DNS label: letters/digits/hyphen, not starting or ending with a hyphen.
const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const empty = (v) => v == null || String(v).trim() === '';

export function validateIPv4(v, field = 'container_ip') {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).trim();
  if (!IPV4_RE.test(s) || s.split('.').some((o) => Number(o) > 255)) {
    return { ok: false, error: `${field} must be an IPv4 address like 172.18.0.3` };
  }
  return { ok: true, value: s };
}

export function validateScheme(v) {
  if (empty(v)) return { ok: true, value: 'https' };
  const s = String(v).trim().toLowerCase();
  if (s !== 'http' && s !== 'https') return { ok: false, error: "scheme must be 'http' or 'https'" };
  return { ok: true, value: s };
}

// The router's host (or IP), optionally with a :port. No scheme, no path, no spaces.
export function validateHost(v, field = 'host') {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).trim();
  if (/\s/.test(s)) return { ok: false, error: `${field} must not contain spaces` };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    return { ok: false, error: `${field} must be just the host (no http:// prefix) — the scheme is a separate field` };
  }
  if (s.includes('/')) return { ok: false, error: `${field} must be just the host, with no path` };
  if (s.length > MAX_HOST) return { ok: false, error: `${field} must be at most ${MAX_HOST} characters` };
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(s);
  const bare = m[1];
  const port = m[2];
  if (port != null && (Number(port) < 1 || Number(port) > 65535)) {
    return { ok: false, error: `${field} has an invalid port (1-65535)` };
  }
  if (!bare) return { ok: false, error: `${field} is required` };
  const isIp = IPV4_RE.test(bare) && !bare.split('.').some((o) => Number(o) > 255);
  if (!isIp && !HOSTNAME_RE.test(bare)) {
    return { ok: false, error: `${field} must be a hostname or IPv4 address (e.g. 192.168.88.1)` };
  }
  return { ok: true, value: s };
}

// The MikroTik hotspot server-name, stored as "host" or "host|label". Only the
// host part before the "|" is a network name; a ".local" TLD is rejected because
// it is claimed by mDNS/Bonjour and phones resolve it via multicast, not the
// router's DNS — the captive portal would be unreachable for many clients.
export function validateServerName(v) {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v).trim();
  if (s.length > MAX_HOST) return { ok: false, error: `server_name must be at most ${MAX_HOST} characters` };
  const host = s.split('|')[0].trim();
  if (!host) return { ok: false, error: 'server_name must start with a hostname or IP (use "host|label" for a display name)' };
  if (/\s/.test(host)) return { ok: false, error: 'the host part of server_name must not contain spaces' };
  if (/\.local$/i.test(host)) {
    return {
      ok: false,
      error: 'a ".local" name is reserved for mDNS/Bonjour — phones resolve it by multicast, not through the router, so the portal would be unreachable. Use a plain name like "hotspot.tikspot" or the container IP.',
    };
  }
  const isIp = IPV4_RE.test(host) && !host.split('.').some((o) => Number(o) > 255);
  if (!isIp && !HOSTNAME_RE.test(host)) {
    return { ok: false, error: 'the host part of server_name must be a hostname or IPv4 address' };
  }
  return { ok: true, value: s };
}

export const MIN_SECRET_LEN = 8;

// The RADIUS shared secret. Only validated when provided — an empty value means
// "leave the existing secret alone".
export function validateSecret(v, field = 'nas_secret') {
  if (empty(v)) return { ok: true, value: '' };
  const s = String(v);
  if (s.length < MIN_SECRET_LEN) {
    return { ok: false, error: `${field} must be at least ${MIN_SECRET_LEN} characters` };
  }
  if (/\s/.test(s)) return { ok: false, error: `${field} must not contain spaces` };
  return { ok: true, value: s };
}

// Validate a whole router-settings payload. Returns { ok:true, values } or
// { ok:false, fields:{name:msg}, error } so the route can 400 with per-field errors.
export function validateRouterSettings(b) {
  const checks = {
    scheme: validateScheme(b.scheme),
    host: validateHost(b.host, 'host'),
    container_ip: validateIPv4(b.container_ip, 'container_ip'),
    server_name: validateServerName(b.server_name),
    nas_secret: validateSecret(b.nas_secret),
  };
  const fields = {};
  const values = {};
  for (const [k, r] of Object.entries(checks)) {
    if (b[k] === undefined) continue; // not being changed
    if (r.ok) values[k] = r.value;
    else fields[k] = r.error;
  }
  if (Object.keys(fields).length) {
    return { ok: false, fields, error: Object.values(fields)[0] };
  }
  return { ok: true, values };
}

// Validate a design model payload before persisting: must be a plain object or
// a JSON string that parses to one, and not absurdly large (DoS / storage-bloat
// guard). null -> ok/null (nothing to update). Returns the PARSED object as
// `value` either way, so callers always hand normalizeDesign() an object.
export const MAX_DESIGN_BYTES = 512 * 1024;

export function validateDesignJson(v) {
  if (v == null) return { ok: true, value: null };
  if (typeof v === 'string') {
    if (Buffer.byteLength(v, 'utf8') > MAX_DESIGN_BYTES) {
      return { ok: false, error: 'design is too large (max 512 KB)' };
    }
    try {
      return { ok: true, value: JSON.parse(v) };
    } catch {
      return { ok: false, error: 'design must be valid JSON' };
    }
  }
  if (typeof v === 'object') {
    let str;
    try {
      str = JSON.stringify(v);
    } catch {
      return { ok: false, error: 'design must be valid JSON' };
    }
    if (Buffer.byteLength(str, 'utf8') > MAX_DESIGN_BYTES) {
      return { ok: false, error: 'design is too large (max 512 KB)' };
    }
    return { ok: true, value: v };
  }
  return { ok: false, error: 'design must be a JSON object or string' };
}
