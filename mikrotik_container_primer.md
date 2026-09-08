# MikroTik Container Primer (RB5009 / RouterOS v7)

Everything this project learned about building OCI images and running them as RouterOS
`container`s — focused on the **RB5009** series but applicable to any arm64 RouterOS
device. This is the field guide we wish we'd had on day one. For the step-by-step
deploy, see [`docs/deploy-rb5009.md`](docs/deploy-rb5009.md); this file is the *why*
behind those steps.

> **Confirmed working:** RB5009 on **RouterOS 7.22**, container boots and serves
> end-to-end. RouterOS **7.4+** is the floor for the `container` package; we target 7.22+.

---

## 1. The platform in one paragraph

RouterOS v7 has a native `container` feature: it runs a **single OCI container per
`/container` entry** directly on the router, no Docker daemon. It is *not* Docker —
there's no `docker run`, no compose, no port-publish-by-default, no image registry cache.
You hand it a flattened image (a tar or a registry ref), a **veth** network interface, a
**root-dir** to extract layers into, optional **mount(s)** for persistence, and it runs
the entrypoint. Think "PID 1 in a namespace on the router," nothing more.

Key consequences that bite you if you assume Docker semantics:

- **No port mapping.** The container gets an IP on a bridge. You reach it by IP, or you
  add a `dst-nat` rule to publish a router port to it. There is no `-p 8088:80`.
- **No `docker exec` from RouterOS directly** in older builds — use `/container/shell`
  (7.6+) or test from the router with `/tool/fetch`.
- **One process tree.** If your image needs multiple daemons (we run Node **and**
  FreeRADIUS), you need a real init/supervisor inside the image (we use **s6-overlay v3**).
- **Resources are tight.** The router's RAM and disk are the budget. Keep the image small
  and don't assume swap.

---

## 2. Hardware & device-mode prerequisites

- **CPU arch matters.** RB5009 is **arm64** — build `linux/arm64` images. (hAP ax2/ax3
  are also arm64; x86/CHR is amd64; MIPS devices **cannot** run containers at all.)
- **Storage.** RB5009 has NAND and can host the image internally, but in practice we run
  off a **USB/NVMe disk mounted at `/appdisk`** (the same pattern as a pihole container).
  The extracted image needs ~150–160 MB of free space on that disk — `root-dir` is where
  layers unpack, and it is *not* the same as your `/data` mount.
- **Enable container mode once:** `/system/device-mode/update container=yes`. This
  requires a **physical confirmation** — press the reset button or power-cycle when
  prompted. If the device already runs a container (e.g. pihole), this is already done
  and no reboot dance is needed.
- Confirm the package is present: `/system/package/print` should list `container`.

---

## 3. The image must be a **legacy docker-archive**, not OCI

This is the single biggest gotcha and cost us the most time.

**RouterOS cannot unpack the OCI-format tar** that modern Docker Desktop (containerd image
store) produces. It fails at extraction with:

```
download/extract error: could not load next layer
```

The container will sit at `status=stopped` forever. The image is fine; the *tar format* is
wrong. RouterOS wants the **legacy docker v2s2 "docker-archive"** format.

Our fix (automated in `scripts/export-rb5009.ps1`, `npm run export:rb5009`): build an OCI
archive, then convert it with **skopeo** (run *inside a throwaway container* so nothing
extra installs on Windows):

```powershell
# 1. Build the arm64 image to an OCI archive
docker buildx build --provenance=false --platform linux/arm64 `
    -o type=oci,dest=dist/tikspot-oci.tar -f docker/Dockerfile .

# 2. Convert OCI -> legacy docker-archive (v2s2, uncompressed)
docker run --rm -v "${PWD}/dist:/work" quay.io/skopeo/stable copy `
    --format v2s2 --dest-compress=false `
    oci-archive:/work/tikspot-oci.tar `
    docker-archive:/work/tikspot-rb5009.tar:tikspot:latest
```

Notes baked in from experience:
- `--provenance=false` (and `--sbom=false` for `--load` builds) — provenance/SBOM
  attestations add extra manifest entries that confuse the single-image extraction.
- `--format v2s2 --dest-compress=false` — RouterOS wants the old schema-2 manifest,
  uncompressed layers.
- **skopeo won't overwrite** an existing destination tar — delete it first.
- The resulting `dist/tikspot-rb5009.tar` is ~137 MB; transfer it to `/appdisk`.

**Alternative:** push to a registry and use `remote-image=...` on `/container/add`. This
avoids the format dance entirely but decompresses **in RAM**, so it needs headroom and a
`tmpdir` on disk (`/container/config/set registry-url=... tmpdir=appdisk/tmp`). On a
low-RAM device the tarball-import path is safer.

---

## 4. Building a small, multi-arch image that RouterOS likes

Lessons encoded in `docker/Dockerfile`:

- **Multi-stage, Alpine (musl) base.** `alpine:3.21`. Final image ~90–155 MB depending on
  what's bundled. Strip `/usr/share/man` and `/usr/share/doc`, `rm -rf /var/cache/apk/*`.
- **Build native deps per-arch in a build stage.** `better-sqlite3` is native — compile it
  against musl with `build-base python3` in an `app-build` stage; buildx runs that stage
  **once per target platform**, so each arch gets a correct binary. The toolchain never
  reaches the runtime image.
- **The Node binary is the size floor.** Node alone is ~50 MB stripped — you will not get
  meaningfully under that. We dropped an initial 100 MB target to a **250 MB hard ceiling**
  rather than fight it.
- **Gate the size in CI/build.** `scripts/check-size.mjs` sums **`docker history` layer
  sizes** (true uncompressed footprint) and fails over budget. Do **not** trust
  `docker images` / `docker image inspect` — they misreport on Docker Desktop's containerd
  store. Wired into `npm run build:local`.
- **Don't bundle (esbuild) if you have native deps.** We tried; `better-sqlite3` made it
  more trouble than worth. Ship `src/` + production `node_modules`. The 250 MB budget makes
  bundling-for-size moot.
- **Fetch external assets with retries.** Downloading s6-overlay from GitHub release CDN
  hit transient 504s. Add `--retry 5 --retry-delay 3 --retry-all-errors` to every `curl`
  in the build (see `failed_commands.md [1]`). Not a config error — just CDN flakiness.

Build commands:
```
npm run build:local     # amd64, --load, runs the size gate (fast local sanity)
npm run build:release   # multi-arch linux/arm64,linux/amd64
npm run export:rb5009   # arm64 -> RouterOS docker-archive tar
```

---

## 5. Multiple processes in one container: s6-overlay v3

RouterOS runs one entrypoint. We need Node (Fastify) **and** FreeRADIUS up together, in
order, with a DB-migration step first. **s6-overlay v3** is the supervisor.

- Entrypoint is `/init` (s6). Set `ENTRYPOINT ["/init"]`.
- Download the **correct arch** of s6 (`TARGETARCH` → `amd64`=x86_64, `arm64`=aarch64).
- Commit the service tree under `docker/s6/s6-rc.d/`: a `00-init` **oneshot** prepares
  `/data`, a `db-init` oneshot runs migrations/seed, then `radiusd` and `node` **longruns**.
- **Declare ordering with dependency marker files**, and create the *empty* dependency /
  contents marker files with `RUN touch` in the Dockerfile — do **not** commit empty files
  to git (they don't survive reliably). Our order:
  `00-init → db-init → {radiusd, node}`.
- Useful env: `S6_KEEP_ENV=1` (pass RouterOS-provided env through to services),
  `S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0` (don't time out waiting on longruns).

The migration-before-services ordering matters: both FreeRADIUS (`rlm_sql`) and Node
(`better-sqlite3`) open the **same SQLite file**, so the schema must exist before either
starts. SQLite is opened **WAL + busy_timeout** on both sides so the two processes can
share it; radiusd runs as **root** (config edit) so it shares the root-owned DB without
permission juggling.

---

## 6. Networking: veth + bridge (do this *before* `/container/add`)

```rsc
# 1. Create the veth FIRST — /container/add interface=... requires it to already exist.
/interface/veth/add name=veth-app-tikspot address=172.18.0.3/24 gateway=172.18.0.1

# 2. Add it to your existing container bridge (reuse the one pihole etc. use).
/interface/bridge/port/add bridge=containers interface=veth-app-tikspot
```

- **Order is load-bearing.** If you `/container/add interface=veth-app-tikspot` before the
  veth exists, the container has no interface. Create the veth, verify with
  `/interface/veth/print`, *then* add the container.
- **Reuse the existing container subnet/gateway.** Find it first:
  `/interface/veth/print`, `/ip/address/print`, `/interface/bridge/print`. The gateway is
  the **bridge's own IP**; the bridge already has its `/ip/address`, so you don't add
  another. Pick a free IP on that subnet (pihole `.2` → Tikspot `.3`).
- **The bridge is a router interface**, so LAN clients route to the container IP through
  the router automatically. To publish on a router port instead:
  ```rsc
  /ip/firewall/nat/add chain=dstnat dst-port=8088 protocol=tcp \
      action=dst-nat to-addresses=172.18.0.3 to-ports=80
  ```
- **Container needs outbound internet?** Ensure a srcnat masquerade covers its subnet:
  `/ip/firewall/nat/add chain=srcnat action=masquerade src-address=172.18.0.0/24`.

---

## 7. Persistence: mount `/data`, keep everything stateful there

```rsc
mount=/appdisk/apps/tikspot/data:/data:rw
```

- **`root-dir` ≠ mount.** `root-dir` is scratch space where layers extract; it's recreated
  on rebuild. The **mount** is your durable volume.
- Put *all* state under the single mounted volume: SQLite DB, uploaded assets, saved page
  designs, TLS cert, secrets, logs. Then **upgrades are trivial** — stop/remove the
  container, drop in the new tar, re-add; `/data` survives untouched.
- The mounted volume may exceed the image size budget — that's fine, the size gate only
  covers the image.

---

## 8. Adding & running the container (RB5009 shape)

```rsc
/container/add \
    file=appdisk/tikspot-rb5009.tar \
    interface=veth-app-tikspot \
    layer-dir=/appdisk/apps/layers \
    root-dir=/appdisk/apps/tikspot/tikspot_root \
    mount=/appdisk/apps/tikspot/data:/data:rw \
    name=app-tikspot hostname=tikspot \
    logging=yes start-on-boot=yes
    # envlist=ENV_TIKSPOT   ;# only if you defined env vars

/container/print                       ;# wait for extraction: status -> stopped
/container/start [find name=app-tikspot]
/container/print                       ;# status -> running
```

- **`layer-dir`** lets multiple containers share extracted base layers — point it at a
  common dir (`/appdisk/apps/layers`).
- **`logging=yes`** routes container stdout into the RouterOS log. Watch boot/extraction:
  `/log/print where topics~"container"`.
- **Env vars** are a separate object: `/container/envs/add list=ENV_TIKSPOT key=... value=...`
  then reference `envlist=ENV_TIKSPOT`.
- After `add`, it **extracts first** (status stays `stopped`); only then `start`.

**Health check from the router** (isolates container from router-side firewall/routing):
```rsc
/tool/fetch url="http://172.18.0.3/healthz" output=user
# expect: {"status":"ok","service":"tikspot",...}
```

---

## 9. Debugging checklist (what actually goes wrong)

| Symptom | Most likely cause | Check |
|---|---|---|
| Stays `status=stopped` after add | OCI tar (wrong format) **or** disk full **or** `root-dir`/`mount` path typo | `/log/print where topics~"container"`; `/container/print detail`; free space on `/appdisk` |
| `could not load next layer` | Image is OCI format | Re-export via skopeo → docker-archive (§3) |
| Container runs but unreachable | Router-side routing/firewall | `/tool/fetch http://<ip>/healthz` from the router *first* |
| No internet from container | Missing srcnat masquerade for the subnet | Add the masquerade rule (§6) |
| Add fails: no interface | veth created after the container | Create veth first, `/interface/veth/print` (§6) |
| Build fails at s6 download (504) | GitHub CDN flake, not config | retry flags on curl; re-run (`failed_commands.md [1]`) |
| Size gate fails / wrong number | Read `docker images` instead of `docker history` | Use `scripts/check-size.mjs` (sums history) |

---

## 10. Upgrading

```rsc
/container/stop   [find name=app-tikspot]
/container/remove [find name=app-tikspot]
# upload the new appdisk/tikspot-rb5009.tar, then repeat the /container/add (§8).
# /appdisk/apps/tikspot/data persists — DB, vouchers, designs survive.
```

---

## TL;DR — the five things RouterOS containers taught us

1. **Convert OCI → docker-archive (skopeo, v2s2, uncompressed)** or RouterOS won't extract.
2. **Create the veth before the container**, reuse the existing container bridge/subnet.
3. **One mounted `/data` volume holds all state** → upgrades are stop/remove/re-add.
4. **Multi-process needs a real supervisor inside** (s6-overlay v3), ordered oneshots first.
5. **Keep the image small and measure it honestly** (`docker history`, not `docker images`),
   build per-arch (arm64 for RB5009), and `/tool/fetch /healthz` from the router to triage.
