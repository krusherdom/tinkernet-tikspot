#!/command/with-contenv sh
# Tikspot one-shot init, runs before long-running services start.
#
# Just ensures the persistent data directory (and FreeRADIUS's run dir) exist
# and announces itself. The heavier lifting — creating/migrating the shared
# SQLite DB, seeding the default plan/credential, generating the RADIUS NAS
# secret, and rendering FreeRADIUS's clients.conf from it — happens in the
# next oneshot, `db-init` (see docker/s6/s6-rc.d/db-init and app/src/init.js),
# which runs after this and before radiusd/node start.
set -e

DATA_DIR="${TIKSPOT_DATA_DIR:-/data}"

echo "[tikspot-init] starting (data dir: ${DATA_DIR})"
mkdir -p "${DATA_DIR}"
# FreeRADIUS run dir (pid/control socket); /var/run can be a fresh tmpfs.
mkdir -p /var/run/radiusd
echo "[tikspot-init] ready"
