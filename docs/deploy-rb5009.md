# Deploying Tikspot on a MikroTik RB5009

> ✅ **Confirmed working** on a MikroTik **RB5009 running RouterOS 7.22** (container boots,
> captive portal serves, FreeRADIUS returns Access-Accept end-to-end). Supported on
> RouterOS 7.22 and later.

Written to match a real RB5009 (RouterOS 7.22) that already runs containers off a USB
disk mounted at **`/appdisk`** — the same pattern as a pihole container:

```
/container/add ... interface=veth-app-pihole layer-dir=/appdisk/apps/layers \
    mount=/appdisk/apps/pihole/config:/etc/pihole:rw \
    root-dir=/appdisk/apps/pihole/pihole_root name=app-pihole remote-image=...
```

We do the same, but import from the exported **`dist/tikspot-rb5009.tar`** (`file=`)
instead of pulling a registry image, and mount `/data` for persistence.

> Because you already run pihole, `device-mode container=yes` and the `container`
> package are already in place — no reboot/reset dance needed.

## 0. Build & export the image (on your PC)

RouterOS can't unpack the OCI-format tar that Docker Desktop's containerd store
produces (`could not load next layer`). The export script builds the arm64 image and
converts it — via skopeo run in a container, so nothing extra to install — into the
**legacy docker-archive** format RouterOS accepts:

```powershell
npm run export:rb5009      # -> dist/tikspot-rb5009.tar  (~137 MB)
```

(Equivalent manual steps and a registry-pull alternative are in the troubleshooting
section.)

Pick a free container IP on your existing container bridge. Pihole is `172.18.0.2`, so
this guide uses **`172.18.0.3`** for Tikspot. Confirm your bridge name + subnet first:

```rsc
/interface/veth/print                 ;# see veth-app-pihole's address/gateway
/ip/address/print                     ;# find the container bridge + its subnet/gateway
/interface/bridge/print               ;# the bridge veth-app-pihole is a port of
```

Adjust the addresses below to match what you find (gateway = the bridge's address).

---

## 1. Create a veth for Tikspot and add it to the container bridge

```rsc
# Use the same subnet/gateway as your existing container bridge.
/interface/veth/add name=veth-app-tikspot address=172.18.0.3/24 gateway=172.18.0.1

# Replace "containers" with whatever bridge veth-app-pihole is on.
/interface/bridge/port/add bridge=containers interface=veth-app-tikspot
```

(If your pihole veth's gateway is the bridge IP, e.g. `172.18.0.1`, reuse it. The bridge
already has its `/ip/address`, so you don't add another.)

> **Do this before step 4.** `/container/add interface=veth-app-tikspot` requires the
> veth to already exist — if you add the container first it won't have an interface.
> Verify with `/interface/veth/print` (you should see `veth-app-tikspot`) and
> `/interface/bridge/port/print` (it should be a port of your container bridge).

## 2. Upload the image tar to the USB disk

Transfer `dist/tikspot-rb5009.tar` onto the `/appdisk` disk:

- **WinBox/WebFig → Files**, open the **`appdisk`** folder, drag the tar in, **or**
- from your PC: `scp dist/tikspot-rb5009.tar admin@192.168.88.1:appdisk/`

It should then show as `appdisk/tikspot-rb5009.tar` in `/file/print`.

## 3. (Optional) environment variables

Defaults are fine. Only if you want to pin the CoA/NAS shared secret up front:

```rsc
/container/envs/add list=ENV_TIKSPOT key=TIKSPOT_NAS_SECRET value="choose-a-secret"
```

(You can also set the secret later in the admin wizard.)

## 4. Add and start the container

```rsc
/container/add \
    file=appdisk/tikspot-rb5009.tar \
    interface=veth-app-tikspot \
    layer-dir=/appdisk/apps/layers \
    root-dir=/appdisk/apps/tikspot/tikspot_root \
    mount=/appdisk/apps/tikspot/data:/data:rw \
    name=app-tikspot \
    hostname=tikspot \
    logging=yes \
    start-on-boot=yes
    # add: envlist=ENV_TIKSPOT   ;# only if you created the env list in step 3

/container/print                      ;# wait until extraction finishes (status=stopped)
/container/start [find name=app-tikspot]
/container/print                      ;# status should become running
```

Watch extraction/boot in the log:

```rsc
/log/print where topics~"container"
```

Verify the app is alive (from the router):

```rsc
/tool/fetch url="http://172.18.0.3/healthz" output=user
# expect: {"status":"ok","service":"tikspot",...}
```

## 5. Reach the admin portal

The container bridge is a router interface, so LAN clients route to `172.18.0.3` via the
router. From a PC on the LAN:

```
http://172.18.0.3/admin
```

If your firewall blocks forwarding into the container subnet (or you just prefer a router
port), publish it:

```rsc
/ip/firewall/nat/add chain=dstnat dst-port=8088 protocol=tcp \
    action=dst-nat to-addresses=172.18.0.3 to-ports=80
# then browse http://192.168.88.1:8088/admin
```

## 6. Finish in the browser (wizard)

1. First visit runs the **setup wizard** — set an admin password.
2. **Router setup** step:
   - Scheme `https` (needs `www-ssl` enabled) or `http` (needs `www` enabled):
     `/ip/service/enable www-ssl`
   - Router host `192.168.88.1`, an API user + password.
   - Container IP `172.18.0.3`, Hotspot server-name (e.g. `hotspot.tikspot` — not
     `.local`, that TLD is reserved for mDNS and phones won't resolve it through the
     router), a RADIUS secret (match step 3 if you set one).
   - **Test connection**, then **Auto-configure** — adds the RADIUS client → the
     container, enables RADIUS CoA (`/radius incoming set accept=yes port=3799`, needed
     for the admin "Kick" button to actually work), sets each hotspot profile to
     `use-radius` + `login-by=mac-cookie,http-chap,http-pap,mac`, adds the DNS static
     for the server-name, and walled-gardens the container.
   - **Not covered by Auto-configure:** the srcnat masquerade for the container's
     outbound internet (guest-lookup plugins, the System page's egress check) — add it
     once, manually:
     ```rsc
     /ip/firewall/nat/add chain=srcnat action=masquerade src-address=172.18.0.0/24
     ```
3. Open the **Portal editor**, design the page, **Save & publish**, then **Download
   hotspot files** and upload them into the router's hotspot directory.

Full detail on what each of the above does and how the wizard's **Verify** step checks
it lives in [setup-mikrotik.md §9](setup-mikrotik.md#verify-checks-reference).

## Updating later

```rsc
/container/stop [find name=app-tikspot]
/container/remove [find name=app-tikspot]
# upload the new appdisk/tikspot-rb5009.tar, then repeat step 4.
# /appdisk/apps/tikspot/data (the /data mount) persists — plans, vouchers and designs
# survive the upgrade.
```

## Notes & troubleshooting

- **Container stays `stopped`** → `/log/print where topics~"container"` and
  `/container/print detail`. Usually a `root-dir`/`mount` path typo or low disk space on
  `/appdisk` (the image needs ~155 MB extracted).
- **No internet from the container** (needed for the wizard's outbound bits) → ensure a
  srcnat masquerade covers the container subnet, e.g.
  `/ip/firewall/nat/add chain=srcnat action=masquerade src-address=172.18.0.0/24`.
- **Admin unreachable** → first confirm `/tool/fetch http://172.18.0.3/healthz` works
  from the router; that isolates the container from router-side routing/firewall.
- **`download/extract error: could not load next layer`** → the tar is in the OCI
  format RouterOS can't unpack. Use `npm run export:rb5009` (it converts to the legacy
  docker-archive via skopeo). The manual equivalent:
  ```powershell
  docker buildx build --provenance=false --platform linux/arm64 -o type=oci,dest=dist/tikspot-oci.tar -f docker/Dockerfile .
  docker run --rm -v "${PWD}/dist:/work" quay.io/skopeo/stable copy --format v2s2 --dest-compress=false `
    oci-archive:/work/tikspot-oci.tar docker-archive:/work/tikspot-rb5009.tar:tikspot:latest
  ```
  Alternatively, push the image to a registry and use `remote-image=...` on
  `/container/add` (the way your pihole container loads) instead of `file=`.
- **RADIUS**: the router's `/radius` entry must point at `172.18.0.3` with the shared
  secret; the wizard's Auto-configure adds it for you.
