# Running Tikspot on a MikroTik router

This guide covers getting the Tikspot container onto a RouterOS device and pointed at your hotspot. Most of these steps can be done **for you** by the in-app setup wizard; this document is the manual reference and explains what the wizard does under the hood — see also [§9](#verify-checks-reference) for exactly what the wizard's **Verify** step checks and where each check lives.

## 1. Requirements

- **RouterOS v7.4 or later** with the **`container`** package installed (`/system/package/print` should list `container`).
- A device whose CPU supports containers: **arm64** (hAP ax2/ax3, RB5009), **x86/CHR**, or **arm32v5** (older hAP ac2 — needs external storage). MIPS-based devices are not supported.
- **Storage for the image + data.** Devices with only 16 MB flash (e.g. hAP ac2) must use an external USB/NVMe disk. Devices with NAND (ax2/ax3, RB5009) can host the image internally; you still want a mounted volume for `/data`.
- Container mode enabled: `/system/device-mode/update container=yes` (this requires a physical confirmation — press the reset button or power-cycle when prompted).

## 2. Get the image onto the router

Two options:

**A. Import a pre-built tarball** (works on low-flash devices, no registry pull):

```
# On your workstation:
docker buildx build --load --platform linux/arm64 -t tikspot:latest -f docker/Dockerfile .
docker save tikspot:latest -o tikspot-arm64.tar
# Upload tikspot-arm64.tar to the router (WinBox Files, or scp/ftp), then:
/container/add file=tikspot-arm64.tar interface=veth-tikspot root-dir=usb1/tikspot/root \
    mounts=tikspot-data envlist=tikspot
```

**B. Pull from a registry** (needs RAM headroom; the image decompresses in memory):

```
/container/config/set registry-url=https://registry-1.docker.io tmpdir=usb1/tmp
/container/add remote-image=YOURREPO/tikspot:latest interface=veth-tikspot ...
```

<a id="veth-before-container"></a>
## 3. Networking (veth + bridge)

**Create the veth before adding the container** — `/container/add interface=...`
requires the interface to already exist; if you add the container first it has
no interface at all.

```
/interface/veth/add name=veth-tikspot address=172.18.0.3/24 gateway=172.18.0.1
/interface/bridge/add name=br-containers
/interface/bridge/port/add bridge=br-containers interface=veth-tikspot
/ip/address/add address=172.18.0.1/24 interface=br-containers
```

The container is reachable from the router at `172.18.0.3`. Hotspot clients reach the
captive portal through the **walled-garden** (configured in step 5 / by the wizard).

<a id="root-dir-vs-data"></a>
## 4. Persistent storage

`root-dir` (in `/container/add`) is scratch space where image layers are
extracted into — it gets recreated on every rebuild. The separate **mount**
below is the durable volume:

```
/container/add ... mount=usb1/tikspot/data:/data:rw ...
```

Everything stateful (the SQLite DB, branding assets, saved page designs, TLS cert,
secrets, logs) lives under `/data`, so it survives container rebuilds and upgrades —
an upgrade is just stop / remove / re-add with the same mount (see
[deploy-rb5009.md](deploy-rb5009.md#updating-later)).

## 5. Start it and verify

```
/container/start [find where root-dir~"tikspot"]
# Give it a few seconds, then from the router:
/tool/fetch url="http://172.18.0.3/healthz" output=user
```

You should see `{"status":"ok","service":"tikspot",...}`.

## 6. Point the hotspot at Tikspot

**Easiest: use the setup wizard.** Open `http://<container-ip>/admin` — on first run it
walks you through setting an admin password and (optionally) connecting your MikroTik.
On the **Router setup** step, enter the router's IP + API credentials, the container IP,
the hotspot server-name and the RADIUS secret, then click **Auto-configure**. Over the
RouterOS REST API it will: add the RADIUS client pointing at the container, set each
hotspot profile to `use-radius` + `login-by=mac-cookie,http-chap,http-pap,mac`, add the
DNS static entry for the server-name, and walled-garden the container. **Test
connection** and **Verify** are there too. You can re-run any of this later from the
Router setup tab.

<a id="api-user-full-then-read"></a>
**API user permissions.** Create a *dedicated* RouterOS user for Tikspot in group `full`
for the setup, e.g. `/user add name=tikspot group=full password=...`. Once Auto-configure
succeeds and **Verify** is green, downgrade it to read-only so the container can't change
the router during normal operation: `/user set [find name=tikspot] group=read`. Tikspot
only needs read access afterwards (health, Verify, active-user list); re-running setup or
pushing hotspot files needs `full` again temporarily.

**No-write option.** If you'd rather never give the container write access, use the
**Manual setup script** button on the Router setup tab — it generates the exact idempotent
RouterOS commands (the Auto-configure equivalent), which you paste into the router terminal
yourself. Keep the API user read-only the whole time.

If you'd rather do it by hand, the same steps are:

1. Add the container as a RADIUS server (`/radius add address=172.18.0.3 secret=... service=hotspot`).
2. Set the hotspot profile to use RADIUS and the right login methods, **including `mac`**
   for MAC re-auth
   (`/ip/hotspot/profile set ... use-radius=yes login-by=mac-cookie,http-chap,http-pap,mac`).
3. Enable RADIUS CoA so "Kick" works (`/radius incoming set accept=yes port=3799`).
4. Name the hotspot server so its redirect points at the container, and add a
   DNS static entry + walled-garden entry so unauthenticated clients can reach it.
5. Add a srcnat masquerade rule so the container has outbound internet.
6. Download the redirect-shim zip from the admin portal and upload it to the
   router's hotspot directory.

Each of these is broken out in detail, with what **Verify** checks for it, in
[§9 below](#verify-checks-reference).

## 7. Testing the RADIUS layer

The container's FreeRADIUS is wired up and seeded with a **Free** plan and a shared
`free` credential out of the box. You can verify it without a router.

From inside the container (`docker exec ... sh` or the router's container shell):

```sh
# Free login → Access-Accept with the plan's MikroTik limits.
# <nas-secret> is the RADIUS shared secret shown on the Router setup tab (Tikspot
# generates a real random secret on first boot — there is no fixed test secret).
radtest free free 127.0.0.1 0 <nas-secret>
```

Expect `Mikrotik-Rate-Limit = "5M/5M"`, `Mikrotik-Total-Limit = 209715200`
(200 MiB) and `Session-Timeout = 3600`. These come from the `plans` table, projected
into RADIUS by the app — edit the plan and the limits change here too.

To point a **real MikroTik** at the container's RADIUS (manual, pre-wizard):

```
/radius add address=<container-ip> secret=<nas-secret> service=hotspot \
    authentication-port=1812 accounting-port=1813 timeout=3s
/ip/hotspot/profile set <profile> use-radius=yes \
    login-by=mac-cookie,http-chap,http-pap,mac radius-accounting=yes
```

> `clients.conf` inside the container is **rendered from the configured NAS
> secret** at boot (and re-rendered live whenever you change it in the wizard) —
> every client block (`localhost`, the LAN range) uses that same secret. There is
> no separate hardcoded "testing" secret; whatever secret the Router setup tab
> shows is the one both `radtest` and your router must use.

## 8. The portal page & the shim files

Tikspot hosts the **real login page** itself (so you can edit it live and use real
images). The MikroTik only holds small **redirect-shim** files that hand the hotspot
session to the container.

1. **Design the page.** Open the admin editor at `http://<container-ip>/admin`, drag
   on Hotspot blocks (Free login / Voucher / Account / Logo), edit their text via the
   settings panel, and click **Save & publish**. Preview at
   `http://<container-ip>/login`.

2. **Make the container reachable as the hotspot's server name.** The shim redirects
   to `//$(server-name)/login`, so `server-name` must resolve to the container and be
   allowed through the walled-garden. Note the two walled-garden menus are **not**
   interchangeable: `dst-address` rules (matching by IP) live under
   `/ip/hotspot/walled-garden/ip`, while `dst-host` rules (matching by hostname) live
   under the plain `/ip/hotspot/walled-garden` — putting a `dst-host` rule under
   `walled-garden/ip` silently never matches:

   ```
   /ip/dns/static/add name=<server-name-host> address=<container-ip>
   /ip/hotspot/walled-garden/add action=allow dst-host=<server-name-host>
   /ip/hotspot/walled-garden/ip/add action=accept dst-address=<container-ip>
   ```

   Name the hotspot server (or its DNS name) so `$(server-name)` is
   `<server-name-host>` (optionally `host|Label` — the shim uses the part before `|`).
   `server-name` must **not** end in `.local` — that TLD is reserved for mDNS/Bonjour,
   so phones resolve it by multicast instead of through the router's DNS, and the
   portal becomes unreachable for them.

<a id="push-after-design-changes"></a>
3. **Download & upload the shim files.** In the editor, **Download hotspot files**
   (`/api/hotspot/shim.zip`), then upload the extracted files into the router's
   hotspot directory (WinBox Files drag-and-drop, FTP, or `/tool fetch`). Re-download
   and re-upload after any change that affects the shim (server-name, login method) —
   editing the portal page design itself does not require re-pushing these files.

How it flows: client → router serves `login.html` shim → shim POSTs the session
context (mac, ip, `link-login`, `chap-id`, …) to `//<server-name>/login` → the
container renders your page → the user's login form POSTs back to the router's
`$(link-login)` to authenticate (PAP by default; HTTP-CHAP optional).

> Auto-configuring the DNS static + walled-garden + server name over the RouterOS
> API is the job of the setup wizard's **Auto-configure** step; the steps above are
> the manual path (also available as a ready-made script — see [§6](#6-point-the-hotspot-at-tikspot)).

<a id="verify-checks-reference"></a>
## 9. Verify checks reference

The wizard's **Verify** button re-reads the router's config and reports each of the
following as pass / fail / unknown (a read that failed — e.g. no permission — is
reported as unknown, never as a silent fail). This section is what each check means
and the command that fixes it; Verify's own "docs" links point straight at these
anchors.

<a id="radius-client"></a>
### RADIUS client

The router needs a `/radius` entry pointing at the container with `service=hotspot`,
so hotspot logins are authenticated by Tikspot:

```
/radius add address=<container-ip> secret=<nas-secret> service=hotspot
```

<a id="radius-incoming-coa"></a>
### RADIUS incoming (CoA / kick)

Without `accept=yes` on `/radius incoming`, the router silently ignores
Disconnect-Request packets, so the admin "Kick" button has no effect:

```
/radius incoming set accept=yes port=3799
```

<a id="hotspot-profile"></a>
### Hotspot server uses a RADIUS profile

At least one `/ip/hotspot` server must reference a `/ip/hotspot/profile` with
`use-radius=yes`, or logins never reach Tikspot at all:

```
/ip/hotspot/profile set [find] use-radius=yes
```

<a id="login-methods"></a>
### Login methods

The RADIUS-enabled profile's `login-by` must include `http-pap` (the method
Tikspot's portal form posts) and `mac` (MAC re-auth for remembered devices);
`http-chap` is optional (CHAP hashes the password client-side, unverified on
hardware):

```
/ip/hotspot/profile set [find] login-by=mac-cookie,http-chap,http-pap,mac
```

<a id="dns-static"></a>
### DNS static

If `server-name` is a hostname (not a literal IP), clients resolve it through the
router — add a static A record pointing it at the container:

```
/ip/dns/static/add name=<server-name-host> address=<container-ip>
```

A literal-IP server-name needs no DNS entry at all.

<a id="remote-dns-requests"></a>
### Router answers client DNS queries

Also only relevant for a hostname server-name: the router must accept DNS queries
from hotspot clients, or they can never resolve the name above:

```
/ip/dns/set allow-remote-requests=yes
```

<a id="walled-garden"></a>
### Walled garden

Pre-login clients must be allowed to reach the container **before** they've
authenticated, or the portal page itself never loads. Add both the IP rule (always
needed) and, for a hostname server-name, the host rule — remember these are two
different menus (see [§8](#8-the-portal-page--the-shim-files)):

```
/ip/hotspot/walled-garden/ip/add action=accept dst-address=<container-ip>
/ip/hotspot/walled-garden/add action=allow dst-host=<server-name-host>
```

<a id="masquerade"></a>
### Masquerade

Optional, but without it the container has no outbound internet — guest-lookup
plugins and the System page's egress check will fail:

```
/ip/firewall/nat/add chain=srcnat action=masquerade src-address=172.18.0.0/24
```

<a id="container-status"></a>
### Container status

Optional/informational: confirms the `/container` entry matching this container is
`status=running` with `start-on-boot=yes`, so the portal survives a router reboot
without manual intervention:

```
/container/set [find name=app-tikspot] start-on-boot=yes
```

<a id="router-reachability"></a>
### Router reachability

The first triage step, and the one Verify always runs regardless of everything
else: can the router reach the container at all?

```
/tool/fetch url="http://<container-ip>/healthz" output=user
```

If this fails, none of the checks above matter yet — it's a routing/firewall
problem between the router and the container, not a RADIUS or hotspot config
problem.
