// Pure helpers for locating THIS container in a RouterOS config snapshot.
//
// Kept dependency-free (no DB, no HTTP) so both the System health view and the
// router Verify can use it without importing each other — rest.js -> system.js ->
// setup.js -> rest.js would otherwise be a cycle.

// Find the /container entry that corresponds to the container at `ip`, by matching
// the IP to a veth address, then the veth to a container. Falls back to the only
// container on the router when there is exactly one.
export function matchPlacement(ip, containers, veths, addrs) {
  ip = String(ip || '').trim();
  if (!ip) return null;
  const list = Array.isArray(containers) ? containers : [];
  const vs = Array.isArray(veths) ? veths : [];
  const as = Array.isArray(addrs) ? addrs : [];
  const veth = vs.find((v) => String(v.address || '').split('/')[0] === ip);
  const ipEntry = as.find((a) => String(a.address || '').split('/')[0] === ip);
  let container = null;
  if (veth) container = list.find((c) => c.interface === veth.name) || null;
  if (!container && list.length === 1) container = list[0];
  return {
    containerIp: ip,
    veth: veth ? { name: veth.name, address: veth.address, gateway: veth.gateway } : null,
    ipBinding: ipEntry ? { address: ipEntry.address, interface: ipEntry.interface } : null,
    container: container
      ? {
          name: container.name,
          // RouterOS 7.23 REST exposes `running=true|false` (no `status` field);
          // older builds had `status`. Normalise to a status string.
          status:
            container.status ??
            (container.running === 'true' || container.running === true
              ? 'running'
              : container.running === 'false' || container.running === false
                ? 'stopped'
                : undefined),
          rootDir: container['root-dir'],
          mounts: container.mount || container.mounts || '',
          interface: container.interface,
          startOnBoot: container['start-on-boot'],
        }
      : null,
  };
}

// ---- tiny IPv4 helpers (used by the masquerade / walled-garden checks) ----
export function ipToInt(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

// Does `cidr` ("10.0.0.0/8", "10.0.0.5", "10.0.0.0/24") contain `ip`?
export function cidrCovers(cidr, ip) {
  const target = ipToInt(ip);
  if (target == null) return false;
  const s = String(cidr || '').trim();
  if (!s) return false;
  const [base, bitsRaw] = s.split('/');
  const b = ipToInt(base);
  if (b == null) return false;
  const bits = bitsRaw == null ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((b & mask) >>> 0) === ((target & mask) >>> 0);
}
