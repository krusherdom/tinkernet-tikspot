// Zero-touch deployment, network half: runs in the Node server AFTER it is
// listening (fire-and-forget — never blocks or crashes startup):
//   1. TIKSPOT_PLUGIN=<url>: fetch + import the recipe (db-init has no network
//      guarantees, so URL sources are deferred to here).
//   2. TIKSPOT_AUTOCONFIGURE=1|always: run Auto-configure (+ hotspot
//      provisioning when TIKSPOT_HOTSPOT_INTERFACE is set), retrying until
//      the router answers — on a cold boot the container often comes up
//      before the router's REST service.
// A signature of the inputs (secrets hashed) is remembered in
// `bootstrap_router_sig` so an unchanged config isn't re-pushed every boot
// (=1); =always re-runs every boot.

import { createHash } from 'node:crypto';
import { getSetting, setSetting } from '../db/settings.js';
import { routerFromSettings, runAutoConfigure, detectContainerIp } from '../admin/setup.js';
import { fetchCatalogRecipe } from '../admin/plugins.js';
import { ensureNasSecret } from '../radius/nas.js';
import { logEvent as defaultLogEvent } from '../admin/events.js';
import { applyPluginRecipe } from './apply.js';
import { patchBootstrapStatus } from './status.js';

export const SIG_KEY = 'bootstrap_router_sig';
export const DEFAULT_DELAYS = [0, 5000, 15000, 30000, 60000, 120000];

const sha = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');

// Stable JSON (sorted keys) so the signature doesn't depend on key order.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// sha256 over everything Auto-configure pushes. Secrets enter only as their
// own hashes, so the stored signature reveals nothing.
export function routerSignature(db, spec) {
  return sha(
    stable({
      scheme: getSetting(db, 'router_scheme', 'https'),
      host: getSetting(db, 'router_host', ''),
      user: getSetting(db, 'router_user', 'admin'),
      containerIp: getSetting(db, 'container_ip', ''),
      serverName: getSetting(db, 'server_name', ''),
      profiles: getSetting(db, 'hotspot_profiles', ''),
      hotspot: spec?.hotspot || null,
      routerPass: sha(getSetting(db, 'router_pass', '')),
      nasSecret: sha(getSetting(db, 'nas_secret', '')),
    }),
  );
}

const sleep = (ms) =>
  new Promise((resolve) => {
    if (!ms) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.(); // never keep the process (or a test run) alive
  });

// Retry `fn` over `delays` until `done(result)`; returns the last result.
async function withRetries(delays, fn, done) {
  let last;
  for (let i = 0; i < delays.length; i++) {
    await sleep(delays[i]);
    last = await fn(i + 1);
    if (done(last)) return last;
  }
  return last;
}

async function bootstrapUrlPlugin(db, spec, { fetchRecipe, delays, warnings }) {
  const fetched = await withRetries(delays, () => fetchRecipe(spec.plugin.ref), (r) => r.ok || r.status !== 502);
  if (!fetched.ok) {
    warnings.push(`TIKSPOT_PLUGIN URL could not be imported: ${fetched.error}`);
    return null;
  }
  const applied = [];
  const plugin = applyPluginRecipe(db, fetched.recipe, spec, { applied, warnings });
  return { plugin, applied };
}

async function autoConfigureRouter(db, spec, { makeRouter, delays, applyNas, warnings }) {
  const router = makeRouter(db);
  if (!router) {
    warnings.push('TIKSPOT_AUTOCONFIGURE is set but no router host is configured (TIKSPOT_ROUTER_HOST) — skipped');
    return null;
  }
  if (!getSetting(db, 'container_ip', '')) {
    // Same default the setup wizard prefills: our own veth address.
    const ip = detectContainerIp();
    if (!ip) {
      warnings.push('TIKSPOT_AUTOCONFIGURE: no container IP configured or detectable (TIKSPOT_CONTAINER_IP) — skipped');
      return null;
    }
    setSetting(db, 'container_ip', ip);
    warnings.push('TIKSPOT_CONTAINER_IP not set — using the detected container address');
  }
  // Make sure the secret exists before signing (Auto-configure would otherwise
  // generate one mid-run and the next boot's signature would differ).
  ensureNasSecret(db);
  const sig = routerSignature(db, spec);
  if (spec.autoconfigure !== 'always' && getSetting(db, SIG_KEY, null) === sig) {
    return { ok: true, skipped: true, steps: [] };
  }

  let attempts = 0;
  const result = await withRetries(
    delays,
    async (n) => {
      attempts = n;
      try {
        return await runAutoConfigure(db, { hotspot: spec.hotspot, router, applyNas });
      } catch (err) {
        return { ok: false, steps: [], error: String(err?.message || err), unreachable: true };
      }
    },
    // Retry only while the router is unreachable — a 403 or a config error
    // won't fix itself by waiting.
    (r) => !(r.unreachable && !r.steps.some((s) => s.status === 'done')),
  );

  if (result.ok) setSetting(db, SIG_KEY, sig);
  const out = { ok: !!result.ok, steps: result.steps.map((s) => ({ step: s.step, status: s.status })), attempts };
  if (result.error) out.error = result.error;
  if (result.unreachable) out.unreachable = true;
  return out;
}

/**
 * Fire-and-forget router bootstrap. Resolves (never rejects) with the router
 * outcome once done; callers in production ignore the promise.
 */
export async function startRouterBootstrap(
  db,
  spec,
  {
    log = console,
    logEvent = defaultLogEvent,
    makeRouter = routerFromSettings,
    delays = DEFAULT_DELAYS,
    fetchRecipe = fetchCatalogRecipe,
    applyNas,
  } = {},
) {
  const warnings = [];
  let router = null;
  try {
    if (!spec) return null;
    if (spec.plugin?.source === 'url') {
      const r = await bootstrapUrlPlugin(db, spec, { fetchRecipe, delays, warnings });
      if (r?.plugin) patchBootstrapStatus(db, { plugin: r.plugin, applied: [...(readApplied(db)), ...r.applied] });
    }
    if (spec.autoconfigure) {
      router = await autoConfigureRouter(db, spec, { makeRouter, delays, applyNas, warnings });
    }
    if (!spec.autoconfigure && !warnings.length && spec.plugin?.source !== 'url') return null;

    patchBootstrapStatus(db, { router, warnings });
    const level = (router && !router.ok) || warnings.length ? 'warn' : 'info';
    const msg = !router
      ? spec.autoconfigure ? 'Router bootstrap: Auto-configure skipped (see warnings)' : 'Router bootstrap: plugin import done'
      : router.skipped
        ? 'Router bootstrap: config unchanged since last success — skipped'
        : router.ok
          ? `Router bootstrap: Auto-configure succeeded (attempt ${router.attempts})`
          : `Router bootstrap: Auto-configure failed after ${router.attempts} attempt(s)`;
    logEvent(db, level, 'bootstrap', msg, [router?.error, ...warnings].filter(Boolean).join('\n') || undefined);
    (level === 'warn' ? log.warn : log.info)?.call(log, `[tikspot-bootstrap] ${msg}`);
    return router;
  } catch (err) {
    // Last-resort guard: bootstrap must never take the server down.
    try {
      patchBootstrapStatus(db, { router: { ok: false, steps: [], error: String(err?.message || err) }, warnings });
      logEvent(db, 'warn', 'bootstrap', 'Router bootstrap crashed', String(err?.message || err));
    } catch { /* ignore */ }
    return { ok: false, steps: [], error: String(err?.message || err) };
  }
}

function readApplied(db) {
  try {
    const s = JSON.parse(getSetting(db, 'bootstrap_status', 'null'));
    return Array.isArray(s?.applied) ? s.applied : [];
  } catch {
    return [];
  }
}
