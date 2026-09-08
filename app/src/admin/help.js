// Static help content for the admin "Help" tab: a router-setup checklist and a
// symptom -> likely cause -> where-to-check table. Pure data (no DB, no HTTP) so
// it is trivial to unit-test and safe to import from setup.js without cycles.

const REPO_BASE = 'https://github.com/omegatron/tinkernet-tikspot/blob/main';
const DOCS_BASE = `${REPO_BASE}/docs`;

// Internal reference paths used to build individual checklist/symptom links.
export const DOCS = {
  setupMikrotik: `${DOCS_BASE}/setup-mikrotik.md`,
  deployRb5009: `${DOCS_BASE}/deploy-rb5009.md`,
  deployApp: `${DOCS_BASE}/deploy-app.md`,
  backupMigrate: `${DOCS_BASE}/backup-migrate.md`,
  primer: `${REPO_BASE}/mikrotik_container_primer.md`,
};

// The top-level "docs" list returned by GET /api/help — every reference doc,
// as a flat list of {title, url} links.
export const DOC_LINKS = [
  { title: 'Setting up a MikroTik router', url: DOCS.setupMikrotik },
  { title: 'Deploying on a RB5009', url: DOCS.deployRb5009 },
  { title: 'Deploying the app', url: DOCS.deployApp },
  { title: 'Backup & migration', url: DOCS.backupMigrate },
  { title: 'MikroTik container primer', url: DOCS.primer },
];

// Checklist of things that bite people setting up the router side. Each `docs`
// entry is a full URL (built from setup-mikrotik.md's anchors, kept in sync with
// the `docs:` slugs used by rest.js verifyConfig's mk() calls).
export const HELP_CHECKLIST = [
  {
    id: 'device-mode',
    title: 'Container mode needs a physical confirmation',
    body: '`/system/device-mode/update container=yes` requires pressing the reset button or power-cycling the router when prompted — it will not take effect from a remote session alone. Skip this if the router already runs another container (e.g. Pi-hole); device-mode is already enabled.',
    docs: DOCS.primer,
  },
  {
    id: 'veth-before-container',
    title: 'Create the veth BEFORE /container/add',
    body: '`/container/add interface=<veth>` requires the veth interface to already exist. Create it with `/interface/veth/add`, verify with `/interface/veth/print`, then add the container — not the other way round.',
    docs: `${DOCS.setupMikrotik}#veth-before-container`,
  },
  {
    id: 'root-dir-vs-data',
    title: 'root-dir is scratch space, /data is durable',
    body: '`root-dir` is where the container\'s layers extract and gets recreated on every rebuild. Only the `/data` **mount** is durable — the SQLite DB, assets, designs, TLS cert and secrets must all live under it, or an upgrade silently wipes them.',
    docs: `${DOCS.setupMikrotik}#root-dir-vs-data`,
  },
  {
    id: 'radius-incoming-coa',
    title: 'Enable CoA / kick support',
    body: '`/radius incoming set accept=yes port=3799` — without this the router silently ignores Disconnect-Request packets, so the admin "Kick" button has no effect even though it reports success.',
    docs: `${DOCS.setupMikrotik}#radius-incoming-coa`,
  },
  {
    id: 'masquerade',
    title: 'Masquerade the container subnet for outbound internet',
    body: 'Guest-lookup plugins and the System page\'s egress check need the container to reach the internet. Add a srcnat masquerade rule covering the container subnet, e.g. `/ip/firewall/nat/add chain=srcnat action=masquerade src-address=172.18.0.0/24`.',
    docs: `${DOCS.setupMikrotik}#masquerade`,
  },
  {
    id: 'server-name-not-local',
    title: 'server-name must not end in .local',
    body: '`.local` is reserved for mDNS/Bonjour — phones resolve it by multicast, not through the router\'s DNS, so the captive portal would be unreachable for many clients. Use a plain name like `hotspot.tikspot`, or just the container IP.',
    docs: `${DOCS.setupMikrotik}#dns-static`,
  },
  {
    id: 'api-user-full-then-read',
    title: 'API user: full for setup, then read',
    body: 'Auto-configure and pushing hotspot files need a RouterOS API user in group `full`. Once Verify is green, downgrade it to `read` for day-to-day operation, and only switch it back to `full` temporarily to re-run setup or push files.',
    docs: `${DOCS.setupMikrotik}#api-user-full-then-read`,
  },
  {
    id: 'push-after-design-changes',
    title: 'Push hotspot files again after design changes',
    body: 'The router\'s hotspot directory only holds small redirect-shim files; they rarely change. But if you regenerate them (new server-name, new login method) you must push/upload them again — editing the portal design alone does not touch the router.',
    docs: `${DOCS.setupMikrotik}#push-after-design-changes`,
  },
  {
    id: 'upgrade-is-stop-remove-readd',
    title: 'Upgrading = stop / remove / re-add',
    body: 'RouterOS containers are upgraded by stopping and removing the `/container` entry, then re-adding it with the new image tar. `/data` is a separate mount and survives untouched.',
    docs: `${DOCS.deployRb5009}#updating-later`,
  },
  {
    id: 'first-triage-step',
    title: 'First triage step: fetch /healthz from the router',
    body: 'Before touching RADIUS or the hotspot config, confirm the router can reach the container at all: `/tool/fetch url="http://<container-ip>/healthz" output=user`. If that fails, nothing else about the hotspot can work — it is routing/firewall, not RADIUS.',
    docs: `${DOCS.setupMikrotik}#router-reachability`,
  },
];

// Symptom -> likely cause -> where to check. Sourced from
// mikrotik_container_primer.md §9, extended with the RADIUS/CoA/portal cases
// that show up once the app itself is running.
export const SYMPTOMS = [
  {
    symptom: 'Container stays status=stopped after add',
    cause: 'OCI-format tar (RouterOS needs legacy docker-archive), disk full, or a root-dir/mount path typo',
    check: '/log/print where topics~"container"; /container/print detail; free space on the storage disk',
  },
  {
    symptom: '"could not load next layer" in the container log',
    cause: 'The image tar is OCI format, not the legacy docker-archive RouterOS expects',
    check: 'Re-export via skopeo to docker-archive (see the container primer §3)',
  },
  {
    symptom: 'Container runs but is unreachable from the admin UI',
    cause: 'Router-side routing/firewall between your PC and the container subnet',
    check: '/tool/fetch http://<container-ip>/healthz from the router first — isolates the container from client-side networking',
  },
  {
    symptom: 'No internet from the container (plugin lookups / egress check fail)',
    cause: 'Missing srcnat masquerade rule for the container subnet',
    check: 'Add the masquerade rule (see #masquerade); confirm on the System page egress check',
  },
  {
    symptom: '/container/add fails with "no interface"',
    cause: 'The veth was not created before the container',
    check: 'Create the veth first, confirm with /interface/veth/print, then add the container',
  },
  {
    symptom: 'Build fails downloading s6-overlay (HTTP 504)',
    cause: 'GitHub release CDN flake, not a config error',
    check: 'Retry the build; the Dockerfile already retries curl, but a fresh run can still hit it',
  },
  {
    symptom: 'Size gate fails or reports an implausible image size',
    cause: '`docker images` / `docker image inspect` misreport size on Docker Desktop\'s containerd store',
    check: 'Trust scripts/check-size.mjs (sums `docker history` layers) instead',
  },
  {
    symptom: 'RADIUS server is not responding (client sees a timeout, not a reject)',
    cause: 'Shared-secret mismatch between the router and clients.conf, or radiusd did not reload after the secret changed',
    check: 'Run Verify (RADIUS client check); on the System page confirm radiusd is up; re-run Auto-configure or rotate the secret',
  },
  {
    symptom: '"Kick" reports success but the client stays connected (no ACK)',
    cause: '/radius incoming is not accept=yes port=3799, so the router ignores the Disconnect-Request',
    check: 'Verify → "RADIUS incoming (CoA / kick)"; run `/radius incoming set accept=yes port=3799`',
  },
  {
    symptom: 'The captive portal page never loads for guests',
    cause: 'Pre-login clients cannot reach the container — missing walled-garden entry',
    check: 'Verify → "Walled-garden allows <container-ip>"; confirm the walled-garden IP/host rules',
  },
];

export function buildHelp() {
  return { checklist: HELP_CHECKLIST, docs: DOC_LINKS, symptoms: SYMPTOMS };
}
