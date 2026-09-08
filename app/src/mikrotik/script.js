// Generate idempotent RouterOS console commands that configure the hotspot exactly
// like Auto-configure (rest.js autoConfigure), so an operator can paste them into the
// router terminal instead of giving the container write credentials. Every object is
// keyed by the managed comment, so the script is safe to re-run (set-or-add).

import { MANAGED_COMMENT, isIpHost, COA_PORT } from './rest.js';

// Quote + escape a value for a RouterOS string argument.
function q(v) {
  return '"' + String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// One idempotent "update the managed entry, or create it" block.
function block(label, menu, findExpr, setArgs, addArgs) {
  return (
    `:if ([:len [${menu} find ${findExpr}]] > 0) do={\n` +
    `  ${menu} set [find ${findExpr}] ${setArgs}\n` +
    `  :put "Tikspot ${label}: updated"\n` +
    `} else={\n` +
    `  ${menu} add ${addArgs}\n` +
    `  :put "Tikspot ${label}: created"\n` +
    `}\n`
  );
}

export function buildSetupScript({ containerIp, serverHost, nasSecret }) {
  const ip = containerIp || '';
  const host = String(serverHost || '').trim();
  const useHostname = host && !isIpHost(host);
  const cmt = MANAGED_COMMENT;
  const find = `comment=${q(cmt)}`;

  let s = '';
  s += '# Tikspot — manual hotspot setup (idempotent; safe to re-run).\n';
  s += '# Paste into the RouterOS terminal, or save as tikspot-setup.rsc and /import it.\n';
  s += '# Equivalent to the admin "Auto-configure" — nothing else on the router is touched.\n';
  s += '# CONTAINS YOUR RADIUS SECRET — treat this script as sensitive.\n\n';

  // RADIUS client -> the container.
  s += block(
    'RADIUS client',
    '/radius',
    find,
    `address=${q(ip)} secret=${q(nasSecret)} service=hotspot`,
    `address=${q(ip)} secret=${q(nasSecret)} service=hotspot comment=${q(cmt)}`,
  );
  s += '\n';

  // CoA / Disconnect-Request listener — without this the router ignores "Kick".
  s += '# Accept RADIUS CoA / Disconnect-Requests (needed for admin "Kick"):\n';
  s += `/radius incoming set accept=yes port=${COA_PORT}\n`;
  s += ':put "Tikspot RADIUS incoming: accept=yes"\n\n';

  // Every hotspot profile -> use RADIUS (mirrors autoConfigure, which patches all).
  s += '# Point every hotspot profile at RADIUS:\n';
  // (hotspot profiles have no comment field — do not add one.)
  s += `/ip/hotspot/profile set [find] use-radius=yes login-by="mac-cookie,http-chap,http-pap,mac"\n`;
  s += ':put "Tikspot hotspot profiles: use-radius enabled"\n\n';

  // Walled-garden IP so pre-login clients can reach the container.
  s += block(
    'walled-garden IP',
    '/ip/hotspot/walled-garden/ip',
    find,
    `action=accept dst-address=${q(ip)}`,
    `action=accept dst-address=${q(ip)} comment=${q(cmt)}`,
  );
  s += '\n';

  if (useHostname) {
    // Clients must be able to use the router as their resolver.
    s += '# Let hotspot clients resolve names through the router:\n';
    s += '/ip/dns set allow-remote-requests=yes\n';
    s += ':put "Tikspot DNS: allow-remote-requests=yes"\n\n';
    // DNS static so clients resolve the server-name to the container.
    s += block(
      'DNS static',
      '/ip/dns/static',
      find,
      `name=${q(host)} address=${q(ip)}`,
      `name=${q(host)} address=${q(ip)} comment=${q(cmt)}`,
    );
    s += '\n';
    // Walled-garden host entry for the server-name.
    s += block(
      'walled-garden host',
      '/ip/hotspot/walled-garden',
      find,
      `action=allow dst-host=${q(host)}`,
      `action=allow dst-host=${q(host)} comment=${q(cmt)}`,
    );
    s += '\n';
  } else if (host) {
    s += `# server-name is an IP (${host}) — no DNS static / host walled-garden needed.\n\n`;
  }

  s += ':put "Tikspot manual setup complete. Run Verify in the admin to confirm."\n';
  return s;
}
