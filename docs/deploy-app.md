# Deploy Tikspot as a RouterOS "App" (auto-provisioned network)

RouterOS **7.22+** can deploy a container from a small YAML manifest **and set up the
network for you**. Per MikroTik's docs, choosing a `network` makes RouterOS automatically
*"create a veth interface, add it to the configured bridge, and apply NAT rules"*, and
declared `ports` become automatic firewall-redirects. So moving Tikspot to a new arm64
router no longer needs the manual veth / bridge / IP steps in
[`deploy-rb5009.md`](deploy-rb5009.md).

The manifest is [`deploy/tikspot.app.yml`](../deploy/tikspot.app.yml).

> **Requires RouterOS 7.22+** with the `container` package and `device-mode container=yes`.
> On older RouterOS, use the file-based deploy ([`deploy-rb5009.md`](deploy-rb5009.md)).

## 1. Where the image comes from
The repo's release workflow publishes a **multi-arch (arm64 + amd64)** image to the GitHub
Container Registry on each version tag:

```
ghcr.io/krusherdom/tinkernet-tikspot:0.10.0   (and :latest)
```

RouterOS pulls the arm64 variant automatically. The GHCR package must be **Public** (the
maintainer sets this once: repo → Packages → the `tikspot` package → Package settings →
visibility → Public) — then anyone can pull it with no credentials.

> **Pulling from GHCR:** RouterOS uses `/container/config registry-url` as its default
> registry. If your router pulls from a fully-qualified image name (`ghcr.io/...`)
> directly, no change is needed. If the pull fails, set the registry for the pull:
> ```rsc
> /container/config/set registry-url=https://ghcr.io tmpdir=disk1/pull-tmp
> ```
> Note this is **global** — if you also run containers from Docker Hub (e.g. pihole),
> switch it back afterwards, or use the file-based deploy for Tikspot instead.

## 2. Add the app (auto-creates the network)
Upload `deploy/tikspot.app.yml` to the router (WinBox/WebFig → Files, or `scp`), then:

```rsc
# Put it on the LAN so the portal/RADIUS get a router-reachable IP, and let RouterOS
# create the veth/bridge/IP/NAT for you:
/app/add network=lan yaml=[/file/get tikspot.app.yml contents]

# (alternative: /app/add network=lan  then  /app/edit tikspot yaml  and paste it)
/app/enable tikspot
/app/print                         ;# watch it pull + come up
```

## 3. Confirm it's alive
```rsc
:put [/app/get tikspot ip]                              ;# the container's IP
/tool/fetch url="http://$[/app/get tikspot ip]/healthz" output=user
# expect: {"status":"ok","service":"tikspot","version":"0.10.0",...}
```

## 4. First-run wizard (this is where RADIUS gets wired)
Open the admin — `http://<router>:8088/admin` (the `ports` mapping) or
`http://<container-ip>/admin` directly — and:
1. Set an admin password.
2. **Router setup** → enter the router host + an API user/password, set the **server-name**
   (use the **container IP**, or a real hostname you own — **never a `.local` name**, which
   clients resolve via mDNS and won't reach), then **Auto-configure**. This creates the
   RADIUS client, sets the hotspot profile to use RADIUS, adds the DNS static + walled-garden,
   and **syncs the generated NAS secret** to the router — all tagged so **Verify** can show
   each component pass/fail.
3. Design the portal, then **Hotspot files → Push to router** (or download + upload them).

## Network mode
- `network=lan` (recommended) — the container gets a real LAN IP that the router's RADIUS
  client and hotspot clients can reach directly.
- `network=internal` — behind NAT; inbound RADIUS then depends on the `ports` redirects.

## File-based alternative (no registry)
If you don't want to use a registry (or you're on RouterOS < 7.22, or you keep
`registry-url` pointed at Docker Hub for other containers), build and load the image as a
tar instead — see [`deploy-rb5009.md`](deploy-rb5009.md). That path is unaffected by the
Apps system and always works; you create the veth manually there.

## Tested / status
Tikspot itself is **confirmed working on a MikroTik RB5009 running RouterOS 7.22**
(container boots, captive portal serves, and live RADIUS returns Access-Accept) — verified
via the file-based deploy. The **`/app`-manifest path on this page targets RouterOS 7.22+**;
if the Apps auto-provisioning behaves differently on your firmware (registry pull, the
`network` mode, or port mapping), fall back to the file-based deploy below — it always
works. If you confirm the App path on your hardware, please note the working
`network`/`ports`/registry settings here.

## References
- RouterOS Apps — https://help.mikrotik.com/docs/spaces/ROS/pages/343244823/Apps
- Container Apps manual — https://manual.mikrotik.com/docs/containers/apps/
