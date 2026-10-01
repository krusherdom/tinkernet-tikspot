// Zero-touch deployment: read the TIKSPOT_* bootstrap environment into one
// normalised spec object. Pure (no DB, no network) so it is trivially testable.
//
// Rules shared by every variable:
//   • '' is "unset" — RouterOS /container/envs happily passes empty strings.
//   • A value that still looks like an unresolved RouterOS placeholder
//     ("[secret:admin_password]", "[containerIP]") is ignored with a warning:
//     the operator's deploy script forgot to substitute it, and seeding the
//     literal would e.g. set the admin password to "[secret:...]".
//   • Secret-ish variables also accept <NAME>_FILE (Docker/K8s secrets style);
//     the plain variable wins when both are set.
//   • Invalid values never throw — they land in `warnings` and are ignored, so a
//     typo can't stop the container from booting.

import fs from 'node:fs';
import { validateHost, validateIPv4, validateServerName, validateSecret } from '../admin/validate.js';

const PREFIX = 'TIKSPOT_';
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);
const PLACEHOLDER = /^\[.*\]$/;

function defaultReadFile(p) {
  return fs.readFileSync(p, 'utf8');
}

// Build the per-call reader: raw(name) -> trimmed non-empty string | null.
function makeReader(env, readFile, warnings) {
  function clean(name, value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (PLACEHOLDER.test(s)) {
      // The value itself is not echoed: a bracketed string could be a real secret.
      warnings.push(`${name} looks like an unresolved RouterOS placeholder ("[...]") — ignored`);
      return null;
    }
    return s;
  }
  // Plain value only.
  const plain = (name) => clean(name, env[name]);
  // Plain value, else the trimmed contents of the file named by <name>_FILE.
  function secret(name) {
    const v = plain(name);
    if (v != null) return v;
    const file = clean(`${name}_FILE`, env[`${name}_FILE`]);
    if (!file) return null;
    try {
      // Never echo the file contents into a warning — only the name.
      return clean(name, readFile(file));
    } catch (err) {
      warnings.push(`${name}_FILE could not be read (${err?.code || 'error'}) — ignored`);
      return null;
    }
  }
  return { plain, secret };
}

function parseBool(name, v, warnings) {
  if (v == null) return null;
  const s = v.toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  warnings.push(`${name} must be 1/0, true/false or yes/no — ignored`);
  return null;
}

// Run a validate.js-style validator ({ok,value}|{ok:false,error}). The error
// text names the problem but never echoes the value (it may be a secret).
function validated(name, v, fn, warnings) {
  if (v == null) return null;
  const res = fn(v);
  if (!res.ok) {
    warnings.push(`${name} is invalid (${res.error}) — ignored`);
    return null;
  }
  return res.value || null;
}

function parseEnum(name, v, allowed, warnings) {
  if (v == null) return null;
  const s = v.toLowerCase();
  if (allowed.includes(s)) return s;
  warnings.push(`${name} must be one of ${allowed.join(', ')} — ignored`);
  return null;
}

// Collect TIKSPOT_PLUGIN_SECRET_<key> / TIKSPOT_PLUGIN_PARAM_<key>. Keys stay
// case-sensitive after the prefix (recipes use camelCase: clientId). For the
// secret map, <key>_FILE variants are folded in (plain wins).
function prefixMap(env, prefix, reader, { secrets = false } = {}) {
  const out = {};
  const keys = new Set();
  for (const name of Object.keys(env)) {
    if (!name.startsWith(prefix)) continue;
    let key = name.slice(prefix.length);
    if (secrets && key.endsWith('_FILE')) key = key.slice(0, -'_FILE'.length);
    if (key) keys.add(key);
  }
  for (const key of keys) {
    const v = secrets ? reader.secret(prefix + key) : reader.plain(prefix + key);
    if (v != null) out[key] = v;
  }
  return out;
}

function classifyPlugin(v) {
  if (v == null) return null;
  if (/^https?:\/\//i.test(v)) return { kind: 'url', value: v };
  // Absolute POSIX path, or a Windows drive path in dev.
  if (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) return { kind: 'file', value: v };
  if (/^[A-Za-z0-9._-]+$/.test(v)) return { kind: 'bundled', value: v.replace(/\.json$/i, '') };
  return { kind: 'invalid', value: v };
}

/**
 * readBootstrapEnv(env, { readFile }) -> spec
 * Every field is null when its variable is unset/ignored.
 */
export function readBootstrapEnv(env = process.env, { readFile = defaultReadFile } = {}) {
  const warnings = [];
  const r = makeReader(env || {}, readFile, warnings);
  const P = (n) => PREFIX + n;

  const mode = parseEnum(P('BOOTSTRAP'), r.plain(P('BOOTSTRAP')), ['seed', 'enforce'], warnings) || 'seed';

  // --- admin ---------------------------------------------------------------
  let adminPassword = r.secret(P('ADMIN_PASSWORD'));
  if (adminPassword != null && adminPassword.length < 6) {
    warnings.push(`${P('ADMIN_PASSWORD')} must be at least 6 characters — ignored`);
    adminPassword = null;
  }
  const adminPasswordReset = parseBool(P('ADMIN_PASSWORD_RESET'), r.plain(P('ADMIN_PASSWORD_RESET')), warnings) === true;
  const setupExplicit = parseBool(P('SETUP_COMPLETE'), r.plain(P('SETUP_COMPLETE')), warnings);
  // Supplying the admin password means the operator is provisioning
  // headlessly — skip the first-run wizard unless they say otherwise.
  const setupComplete = setupExplicit != null ? setupExplicit : adminPassword != null ? true : null;

  // --- router ----------------------------------------------------------------
  // Same validators the setup wizard uses, so env and UI accept the same values.
  const routerScheme = parseEnum(P('ROUTER_SCHEME'), r.plain(P('ROUTER_SCHEME')), ['http', 'https'], warnings);
  const routerHost = validated(P('ROUTER_HOST'), r.plain(P('ROUTER_HOST')), (v) => validateHost(v, 'host'), warnings);
  const routerUser = r.plain(P('ROUTER_USER'));
  const routerPassword = r.secret(P('ROUTER_PASSWORD'));

  // --- network / RADIUS -----------------------------------------------------
  const ipRaw = r.plain(P('CONTAINER_IP'));
  // Tolerate "172.18.0.3/24" (the veth address as RouterOS prints it).
  const containerIp = validated(P('CONTAINER_IP'), ipRaw && ipRaw.replace(/\/\d+$/, ''), (v) => validateIPv4(v), warnings);
  const serverName = validated(P('SERVER_NAME'), r.plain(P('SERVER_NAME')), validateServerName, warnings);
  const nasSecret = validated(P('NAS_SECRET'), r.secret(P('NAS_SECRET')), (v) => validateSecret(v), warnings);
  const portalTitle = r.plain(P('PORTAL_TITLE'));
  const loginMethod = parseEnum(P('LOGIN_METHOD'), r.plain(P('LOGIN_METHOD')), ['pap', 'chap'], warnings);
  const profilesRaw = r.plain(P('HOTSPOT_PROFILES'));
  // "*" (or "all") means "manage every profile" — it CLEARS a previously stored filter.
  // Needed because a seeded filter otherwise has no way back to "all" (there is no UI
  // for it), e.g. after the named profile has been deleted on the router.
  const hotspotProfilesAll = profilesRaw ? ['*', 'all'].includes(profilesRaw.trim().toLowerCase()) : false;
  const hotspotProfiles = profilesRaw && !hotspotProfilesAll
    ? profilesRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  // --- router auto-configure + hotspot provisioning -------------------------
  const acRaw = r.plain(P('AUTOCONFIGURE'));
  let autoconfigure = null;
  if (acRaw != null) {
    const s = acRaw.toLowerCase();
    if (s === 'always') autoconfigure = 'always';
    else if (TRUTHY.has(s)) autoconfigure = 'once';
    else if (!FALSY.has(s)) warnings.push(`${P('AUTOCONFIGURE')} must be 0, 1 or always — ignored`);
  }
  const hsInterface = r.plain(P('HOTSPOT_INTERFACE'));
  const hotspot = hsInterface
    ? {
        interface: hsInterface,
        profileName: r.plain(P('HOTSPOT_PROFILE_NAME')) || 'tikspot',
        dnsName: r.plain(P('HOTSPOT_DNS_NAME')),
      }
    : null;
  if (!hsInterface && (r.plain(P('HOTSPOT_DNS_NAME')) || r.plain(P('HOTSPOT_PROFILE_NAME')))) {
    warnings.push(`${P('HOTSPOT_DNS_NAME')}/${P('HOTSPOT_PROFILE_NAME')} need ${P('HOTSPOT_INTERFACE')} — hotspot provisioning skipped`);
  }

  // --- plugin -----------------------------------------------------------------
  let plugin = null;
  const pluginSrc = classifyPlugin(r.plain(P('PLUGIN')));
  if (pluginSrc && pluginSrc.kind === 'invalid') {
    warnings.push(`${P('PLUGIN')} must be a bundled recipe id, an absolute file path or an http(s) URL — ignored`);
  } else if (pluginSrc) {
    plugin = {
      source: pluginSrc.kind,
      ref: pluginSrc.value,
      name: r.plain(P('PLUGIN_NAME')),
      enabled: parseBool(P('PLUGIN_ENABLED'), r.plain(P('PLUGIN_ENABLED')), warnings),
      attach: parseBool(P('PLUGIN_ATTACH'), r.plain(P('PLUGIN_ATTACH')), warnings) === true,
      secrets: prefixMap(env || {}, P('PLUGIN_SECRET_'), r, { secrets: true }),
      params: prefixMap(env || {}, P('PLUGIN_PARAM_'), r),
    };
  }

  // --- restore ------------------------------------------------------------------
  const restoreFile = r.plain(P('RESTORE_FILE'));
  const restoreMode = parseEnum(P('RESTORE_MODE'), r.plain(P('RESTORE_MODE')), ['fresh', 'once'], warnings) || 'fresh';

  return {
    mode,
    admin: { password: adminPassword, reset: adminPasswordReset },
    setupComplete,
    router: { scheme: routerScheme, host: routerHost, user: routerUser, password: routerPassword },
    containerIp,
    serverName,
    nasSecret,
    portalTitle,
    loginMethod,
    hotspotProfiles,
    hotspotProfilesAll,
    autoconfigure,
    hotspot,
    plugin,
    restore: restoreFile ? { file: restoreFile, mode: restoreMode } : null,
    warnings,
  };
}

// A copy of the spec that is safe to log: every secret replaced by a marker
// saying only whether it was supplied.
export function redact(spec) {
  if (!spec) return spec;
  const mark = (v) => (v == null ? null : '[set]');
  const out = JSON.parse(JSON.stringify(spec));
  out.admin.password = mark(spec.admin?.password);
  out.router.password = mark(spec.router?.password);
  out.nasSecret = mark(spec.nasSecret);
  if (out.plugin) {
    out.plugin.secrets = Object.fromEntries(Object.keys(spec.plugin.secrets || {}).map((k) => [k, '[set]']));
  }
  return out;
}

// True when the spec asks for anything at all (keeps quiet boots quiet).
export function hasBootstrap(spec) {
  if (!spec) return false;
  return Boolean(
    spec.admin.password || spec.setupComplete != null || spec.router.host || spec.router.user ||
      spec.router.password || spec.router.scheme || spec.containerIp || spec.serverName || spec.nasSecret ||
      spec.portalTitle || spec.loginMethod || spec.hotspotProfiles || spec.hotspotProfilesAll || spec.autoconfigure || spec.hotspot ||
      spec.plugin || spec.restore || spec.warnings.length,
  );
}
