# syntax=docker/dockerfile:1.7
#
# Tikspot container image.
# Multi-stage, multi-arch (linux/arm64 + linux/amd64). Target: < 250 MB.
#
# Build:
#   docker buildx build --load --provenance=false --platform linux/amd64 -t tikspot:dev -f docker/Dockerfile .
#   docker buildx build --platform linux/arm64,linux/amd64 -t tikspot:latest -f docker/Dockerfile .

ARG ALPINE_VERSION=3.21
ARG S6_OVERLAY_VERSION=3.2.0.2

# ---------------------------------------------------------------------------
# Stage 1: install Node production dependencies (incl. the native better-sqlite3,
# compiled here against musl for the target arch — buildx runs this stage once
# per platform, so the binary is correct for each). The build toolchain stays in
# this stage and never reaches the runtime image.
# ---------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS app-build
RUN apk add --no-cache nodejs npm build-base python3
WORKDIR /app
COPY app/package.json app/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY app/ ./

# ---------------------------------------------------------------------------
# Stage 2: download and unpack s6-overlay for the *target* architecture.
# ---------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS s6-fetch
ARG S6_OVERLAY_VERSION
ARG TARGETARCH
RUN apk add --no-cache curl xz
WORKDIR /s6
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) S6_ARCH=x86_64 ;; \
      arm64) S6_ARCH=aarch64 ;; \
      arm)   S6_ARCH=arm ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" -o noarch.tar.xz; \
    curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" -o arch.tar.xz; \
    mkdir -p /s6root; \
    tar -C /s6root -Jxpf noarch.tar.xz; \
    tar -C /s6root -Jxpf arch.tar.xz

# ---------------------------------------------------------------------------
# Stage 3: final runtime image.
# ---------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS runtime
ARG ALPINE_VERSION

# Runtime packages:
#  - nodejs                 : the app
#  - freeradius + sqlite    : RADIUS server sharing the SQLite DB
#  - freeradius-utils       : radtest / radclient (testing + CoA "kick" later)
#  - sqlite-libs            : shared SQLite runtime
#  - ca-certificates        : outbound TLS (registry / RouterOS REST)
RUN apk add --no-cache \
      nodejs \
      freeradius \
      freeradius-sqlite \
      freeradius-utils \
      sqlite-libs \
      ca-certificates \
    && rm -rf /var/cache/apk/* /usr/share/man /usr/share/doc

# Enable rlm_sql with the SQLite driver pointed at the shared DB, and run radiusd
# as root so it can share the DB file with the (root) Node process without
# permission juggling. These are deterministic edits to the stock config.
RUN set -eux; \
    cp /etc/raddb/mods-available/sql /etc/raddb/mods-enabled/sql; \
    sed -i \
      -e 's|driver = "rlm_sql_null"|driver = "rlm_sql_sqlite"|' \
      -e 's|filename = "${db_dir}/freeradius.db"|filename = "/data/tikspot.db"|' \
      -e 's|busy_timeout = 200|busy_timeout = 5000|' \
      /etc/raddb/mods-enabled/sql; \
    sed -i -e 's|^[[:space:]]*user = radius|	user = root|' \
           -e 's|^[[:space:]]*group = radius|	group = root|' \
      /etc/raddb/radiusd.conf

# s6-overlay runtime
COPY --from=s6-fetch /s6root/ /

# Application — bundled production node_modules (with the compiled better-sqlite3)
# plus the source. No build step at runtime.
WORKDIR /app
COPY --from=app-build /app/node_modules ./node_modules
COPY --from=app-build /app/src ./src
COPY --from=app-build /app/public ./public
COPY --from=app-build /app/package.json ./package.json
# Bundled guest-lookup plugin recipes (repo-root plugins/), so TIKSPOT_PLUGIN can
# name one by id (e.g. rms-cloud-surname-room) with no network access.
COPY plugins/ ./plugins/

# s6 service tree + init scripts.
COPY docker/s6/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
COPY docker/s6/scripts/ /etc/s6-overlay/scripts/

# Wire up the service tree:
#  - mark scripts/run files executable
#  - register services in the default 'user' bundle
#  - declare ordering: db-init depends on 00-init; radiusd & node depend on db-init
RUN set -eux; \
    chmod +x /etc/s6-overlay/scripts/*.sh /etc/s6-overlay/s6-rc.d/*/run 2>/dev/null || true; \
    mkdir -p /etc/s6-overlay/s6-rc.d/user/contents.d \
             /etc/s6-overlay/s6-rc.d/db-init/dependencies.d \
             /etc/s6-overlay/s6-rc.d/radiusd/dependencies.d \
             /etc/s6-overlay/s6-rc.d/node/dependencies.d; \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/00-init \
          /etc/s6-overlay/s6-rc.d/user/contents.d/db-init \
          /etc/s6-overlay/s6-rc.d/user/contents.d/radiusd \
          /etc/s6-overlay/s6-rc.d/user/contents.d/node \
          /etc/s6-overlay/s6-rc.d/db-init/dependencies.d/00-init \
          /etc/s6-overlay/s6-rc.d/radiusd/dependencies.d/db-init \
          /etc/s6-overlay/s6-rc.d/node/dependencies.d/db-init; \
    mkdir -p /data /var/run/radiusd

# Zero-touch bootstrap (all optional, no defaults baked in; see
# app/src/bootstrap/env.js). Secret-ish ones also accept <NAME>_FILE.
#   TIKSPOT_BOOTSTRAP=seed|enforce            seed fills unset values; enforce: env wins every boot
#   TIKSPOT_ADMIN_PASSWORD(_FILE), TIKSPOT_ADMIN_PASSWORD_RESET, TIKSPOT_SETUP_COMPLETE
#   TIKSPOT_ROUTER_HOST, TIKSPOT_ROUTER_SCHEME, TIKSPOT_ROUTER_USER, TIKSPOT_ROUTER_PASSWORD(_FILE)
#   TIKSPOT_CONTAINER_IP, TIKSPOT_SERVER_NAME, TIKSPOT_NAS_SECRET(_FILE), TIKSPOT_PORTAL_TITLE,
#   TIKSPOT_LOGIN_METHOD, TIKSPOT_HOTSPOT_PROFILES
#   TIKSPOT_AUTOCONFIGURE=0|1|always, TIKSPOT_HOTSPOT_INTERFACE, TIKSPOT_HOTSPOT_DNS_NAME,
#   TIKSPOT_HOTSPOT_PROFILE_NAME
#   TIKSPOT_PLUGIN (bundled id | /path.json | https://...), TIKSPOT_PLUGIN_NAME,
#   TIKSPOT_PLUGIN_ENABLED, TIKSPOT_PLUGIN_ATTACH, TIKSPOT_PLUGIN_SECRET_<key>(_FILE),
#   TIKSPOT_PLUGIN_PARAM_<key>, TIKSPOT_PLUGINS_DIR
#   TIKSPOT_RESTORE_FILE, TIKSPOT_RESTORE_MODE=fresh|once
ENV TIKSPOT_HOST=0.0.0.0 \
    TIKSPOT_PORT=80 \
    TIKSPOT_DB=/data/tikspot.db \
    S6_KEEP_ENV=1 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0

# Captive portal / admin (80,443); RADIUS auth/acct (1812,1813 udp); CoA (3799 udp)
EXPOSE 80 443 1812/udp 1813/udp 3799/udp

ENTRYPOINT ["/init"]
