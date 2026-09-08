// Central configuration, sourced from environment variables with sensible
// defaults for running inside the container. The MikroTik `/container/envs`
// mechanism (or `docker run -e`) can override any of these.

export const DB_PATH = process.env.TIKSPOT_DB ?? '/data/tikspot.db';
export const DATA_DIR = process.env.TIKSPOT_DATA_DIR ?? '/data';
export const ASSETS_DIR = process.env.TIKSPOT_ASSETS_DIR ?? `${DATA_DIR}/assets`;

export const HOST = process.env.TIKSPOT_HOST ?? '0.0.0.0';
export const PORT = Number(process.env.TIKSPOT_PORT ?? 80);
export const VERSION = process.env.TIKSPOT_VERSION ?? '0.14.0';
export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

// The credential the hotspot "Free login" button posts. It is a single shared
// RADIUS identity mapped to the free plan/group; MikroTik still tracks each
// device's session (and applies the plan's data/time/speed limits) per login.
export const FREE_USERNAME = process.env.TIKSPOT_FREE_USERNAME ?? 'free';
export const FREE_PASSWORD = process.env.TIKSPOT_FREE_PASSWORD ?? 'free';
