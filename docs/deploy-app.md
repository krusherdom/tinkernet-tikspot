# Deploy Tikspot as a RouterOS "App" — zero-touch setup

RouterOS **7.22+** can deploy a container from a small YAML manifest and set up its
network for you: it creates the veth, adds it to a bridge, assigns the address, adds NAT
and publishes the ports. From Tikspot **0.17** the container does the rest: it configures
**itself** — admin password, router link, server name, RADIUS secret, an optional
guest-lookup plugin, even a restore from backup — and, if you let it, the **router's
hotspot** (RADIUS client, DNS static, walled garden, hotspot profile and server) from
environment variables at boot. A new site no longer needs the first-run wizard.

The manifest is [`deploy/tikspot.app.yml`](../deploy/tikspot.app.yml); the same app is
published as a one-entry App store in [`deploy/app-store.yml`](../deploy/app-store.yml).

> **Requires** RouterOS 7.22+ with the `container` package and
> `/system/device-mode` `container=yes` (enabling that needs a physical reset-button press
> or power cycle — a software reboot does not confirm it). The storage disk must be
> **ext4** (`/disk/format <disk> file-system=ext4`); FAT32 cannot hold containers.
> On older RouterOS use the file-based deploy ([`deploy-rb5009.md`](deploy-rb5009.md)) —
> every variable below works there too, through `/container/envs`.

## 1. One-time router preparation

```rsc
# Where apps are stored (an ext4 disk — USB/NVMe recommended).
/app/settings set disk=usb1

# A REST user for Tikspot's auto-configure. `full` is needed while it sets things up;
# you can drop it to `read` afterwards (see "After setup" below).
/user add name=tikspot group=full password="<api-password>"
```

The REST API must be reachable from the container: `/ip/service` `www` (http) or `www-ssl`
(https) enabled. The manifest defaults to `http` on the router's app-network address.

## 2. Add and configure the app

Either add the store once and pick Tikspot from the App list:

```rsc
/app/settings set app-store-urls="https://raw.githubusercontent.com/krusherdom/tinkernet-tikspot/main/deploy/app-store.yml"
```

or upload `deploy/tikspot.app.yml` and add it directly:

```rsc
/app/add network=internal yaml=[/file/get tikspot.app.yml contents]
```

Then give it the values for this site and start it:

```rsc
/app/set tikspot environment="\
TIKSPOT_ADMIN_PASSWORD=<admin-password>,\
TIKSPOT_ROUTER_PASSWORD=<api-password>,\
TIKSPOT_SERVER_NAME=portal.example.com,\
TIKSPOT_HOTSPOT_INTERFACE=bridge-guest,\
TIKSPOT_HOTSPOT_DNS_NAME=login.example.com"
/app/enable tikspot
/app/print                      ;# watch it pull and start
```

That is the whole install. On first boot the container sets the admin password, stores the
router link, and — because `TIKSPOT_AUTOCONFIGURE=1` in the manifest — creates on the
router: the RADIUS client and CoA listener, the DNS static entry and walled-garden rules
for the portal, and (because a hotspot interface was given) the hotspot profile and
server. Open `http://<router>:8088/admin` and log in.

Still to do by hand: upload the hotspot shim files (**Hotspot files → Push to router**, or
download and copy them into the router's `hotspot/` directory), and design the page.

### Which network?

- **`network=internal`** *(recommended)* — the container gets its own NATed subnet, routed
  by the router. Guests reach the portal through the gateway.
- **`network=lan`** — the container sits on the LAN bridge
  (`/app/settings lan-bridge`).

**Do not put the container on the guest bridge.** Access points with *client isolation*
only let guests talk to the gateway, so a portal on the guest subnet is silently
unreachable — typically it "works on a laptop on the wire" and fails on phones.

### Choosing the server name

`TIKSPOT_SERVER_NAME` becomes the hotspot **server's name** on the router, and that is the
host guests are redirected to (`http://<server-name>/login`). Use a **real hostname you
control**, and publish a public A record for it pointing at the container's address — a
private address in public DNS is fine. Made-up names (`hotspot.tikspot`, anything
`.local`) fail on devices that use encrypted DNS or mDNS and never ask the router. If you
have no domain, leave the default (`[containerIP]`): an IP always works.

`TIKSPOT_HOTSPOT_DNS_NAME` is the *router's own* hotspot endpoint. It must be a
**different** name: RouterOS adds a dynamic DNS record for it pointing at the router,
which would shadow the portal's record.

## 3. Variable reference

All optional. Set them in the manifest's `environment:` or override per install with
`/app/set tikspot environment="NAME=value,..."` (file-based installs: `/container/envs`).
A value RouterOS could not resolve — still literally `[secret:admin_password]` or
`[containerIP]` — is treated as not set.

`TIKSPOT_BOOTSTRAP` chooses how values are applied: **`seed`** (default) fills only
settings that are still empty, so changes made later in the admin UI are kept;
**`enforce`** makes the environment win on every boot.

Variables marked 🔑 also accept `<NAME>_FILE=/path` (read from a file — works with
RouterOS `secrets:` mounted under `/run/secrets/`).

| Variable | Meaning |
|---|---|
| `TIKSPOT_BOOTSTRAP` | `seed` (default) or `enforce` — see above |
| `TIKSPOT_ADMIN_PASSWORD` 🔑 | Admin password (min 6 characters). Supplying it also marks setup complete, skipping the wizard |
| `TIKSPOT_ADMIN_PASSWORD_RESET` | `1` forces the admin password to the value above on this boot, whatever is stored. **The lock-out fix** — see below |
| `TIKSPOT_SETUP_COMPLETE` | `1`/`0` to force the first-run wizard off/on |
| `TIKSPOT_ROUTER_HOST` | Router address for the REST API (`[routerIP]`) |
| `TIKSPOT_ROUTER_SCHEME` | `http` or `https` (default `https`; the manifest sets `http`) |
| `TIKSPOT_ROUTER_USER` | REST user (manifest default `tikspot`) |
| `TIKSPOT_ROUTER_PASSWORD` 🔑 | REST user's password |
| `TIKSPOT_CONTAINER_IP` | The container's own address (`[containerIP]`) — what the router's RADIUS client and walled garden point at |
| `TIKSPOT_SERVER_NAME` | Hotspot server name / portal host — see "Choosing the server name" |
| `TIKSPOT_NAS_SECRET` 🔑 | RADIUS shared secret. Unset = a unique random one is generated and synced to the router |
| `TIKSPOT_PORTAL_TITLE` | Browser title of the portal page |
| `TIKSPOT_LOGIN_METHOD` | `pap` (default) or `chap` |
| `TIKSPOT_HOTSPOT_PROFILES` | Comma-separated hotspot profile names to manage (default: all) |
| `TIKSPOT_AUTOCONFIGURE` | `1` = configure the router once per set of inputs; `always` = every boot; unset/`0` = never (use **Router setup → Auto-configure** instead) |
| `TIKSPOT_HOTSPOT_INTERFACE` | Guest bridge/interface. When set, auto-configure also creates the hotspot **profile** and **server** on it and fills an empty DHCP `dns-server` |
| `TIKSPOT_HOTSPOT_PROFILE_NAME` | Name of the profile it creates (default `tikspot`) |
| `TIKSPOT_HOTSPOT_DNS_NAME` | Optional name for the router's own hotspot endpoint; must differ from the server name |
| `TIKSPOT_PLUGIN` | Guest-lookup recipe to install: a bundled id (`rms-cloud-surname-room`, `mews-connector`, … — see [`plugins/`](../plugins/)), a file path, or an `https://` URL |
| `TIKSPOT_PLUGIN_NAME` | Name to give it (default: the recipe's own name) |
| `TIKSPOT_PLUGIN_SECRET_<key>` 🔑 | A recipe secret, e.g. `TIKSPOT_PLUGIN_SECRET_clientId` |
| `TIKSPOT_PLUGIN_PARAM_<key>` | A recipe parameter, e.g. `TIKSPOT_PLUGIN_PARAM_moduleType`. Keys the recipe does not declare are ignored with a warning |
| `TIKSPOT_PLUGIN_ENABLED` | `1` to enable the plugin. In `seed` mode this applies when the plugin is first created — one you later disable in the UI stays disabled |
| `TIKSPOT_PLUGIN_ATTACH` | `1` to point the active page design's Guest lookup block at it (adding the block if there is none) |
| `TIKSPOT_RESTORE_FILE` | Path to a Tikspot backup `.zip` to restore at boot (manifest default `/data/import/backup.zip`; ignored if the file is absent) |
| `TIKSPOT_RESTORE_MODE` | `fresh` (default) = only on an install with no admin password yet; `once` = once per distinct file |

`/healthz` reports what the last boot did under `bootstrap` — which settings were applied,
the plugin, each router step and any warnings (names and results only, never values). A
router that is not reachable yet is retried for a few minutes in the background; the
container starts regardless.

**Router setup → Verify** now also checks that a hotspot server exists whose *name* equals
the server name — the mismatch that makes guests land on the router's built-in page.

## 4. Recipes

**Locked out of the admin.**

```rsc
/app/set tikspot environment="TIKSPOT_ADMIN_PASSWORD=<new-password>,TIKSPOT_ADMIN_PASSWORD_RESET=1"
/app/disable tikspot; /app/enable tikspot
# log in, then remove the RESET flag so a later restart doesn't undo a UI password change
```

**A site with a PMS guest lookup, ready on first boot** (RMS Cloud shown):

```rsc
/app/set tikspot environment="\
TIKSPOT_ADMIN_PASSWORD=<admin-password>,TIKSPOT_ROUTER_PASSWORD=<api-password>,\
TIKSPOT_SERVER_NAME=portal.example.com,TIKSPOT_HOTSPOT_INTERFACE=bridge-guest,\
TIKSPOT_PLUGIN=rms-cloud-surname-room,\
TIKSPOT_PLUGIN_SECRET_agentId=<agent-id>,TIKSPOT_PLUGIN_SECRET_agentPassword=<agent-password>,\
TIKSPOT_PLUGIN_SECRET_clientId=<client-id>,TIKSPOT_PLUGIN_SECRET_clientPassword=<web-service-password>"
```

**Move an install to a new router.** Download a backup from the old one (**Backup**,
with secrets if you want the router link and RADIUS secret carried over), copy it to the
new router's app storage as `data/import/backup.zip`, then add and enable the app. With
`TIKSPOT_RESTORE_MODE=fresh` it is restored once, on the empty install; environment values
are applied on top (in `seed` mode they only fill gaps the backup left).

## 5. After setup

- **Drop the API user to read-only** once **Router setup → Verify** is green:
  `/user set [find name=tikspot] group=read`. Tikspot only needs read access for health,
  Verify and the active-user list; give `full` back temporarily to re-run auto-configure.
- **Environment values are visible** to anyone who can read `/app` or `/container` on the
  router. Prefer `secrets:` / `_FILE` where your RouterOS supports them, or clear the
  password variables after the first boot — in `seed` mode they are not needed again.
- **Updates:** change the image tag in the app's YAML (or enable `auto-update`) and
  restart; `/data` persists.

## File-based alternative (no registry)

On RouterOS < 7.22, or if you keep the image as a tar, see
[`deploy-rb5009.md`](deploy-rb5009.md). You create the veth yourself there, but the
container-side bootstrap is identical — put the same variables in a `/container/envs`
list.

## Image

The release workflow publishes a multi-arch (arm64 + amd64) image on each version tag:
`ghcr.io/krusherdom/tinkernet-tikspot:<version>` (and `:latest` for final releases).
RouterOS pulls the matching architecture.

## References

- Container Apps manual — https://manual.mikrotik.com/docs/containers/apps/
