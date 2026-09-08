-- Tikspot application tables (Node-owned). These live in the SAME SQLite file as
-- the FreeRADIUS tables. The app is the single UI authority for plans/users; a
-- sync layer (radius/sync.js) projects them into the RADIUS tables so FreeRADIUS
-- stays the single auth authority.
--
-- Tables: app_meta, plans, settings, vouchers, accounts, mac_sessions, designs,
-- admin_audit, assets, events, announcements.

CREATE TABLE IF NOT EXISTS app_meta (
	key   TEXT PRIMARY KEY,
	value TEXT
);

-- A plan = a RADIUS group. Its limits are projected to radgroupreply rows:
--   rate_limit            -> Mikrotik-Rate-Limit  ("rx/tx", e.g. "5M/5M")
--   total_limit_bytes     -> Mikrotik-Total-Limit (+ -Gigawords for > 4 GiB)
--   session_timeout_secs  -> Session-Timeout
-- NULL limit columns mean "unlimited" (no corresponding reply attribute).
CREATE TABLE IF NOT EXISTS plans (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	name                 TEXT NOT NULL UNIQUE,
	radius_groupname     TEXT NOT NULL UNIQUE,
	kind                 TEXT NOT NULL DEFAULT 'free',   -- free | voucher | account
	rate_limit           TEXT,
	total_limit_bytes    INTEGER,
	session_timeout_secs INTEGER,
	mac_remember         INTEGER NOT NULL DEFAULT 0,     -- per-plan MAC re-auth toggle
	mac_validity_secs    INTEGER,
	-- Expiry mode: NULL/'fixed' = use session_timeout_secs; 'midnight' = sessions are
	-- CoA-disconnected at the next router-local midnight (renew daily). A 24h fallback
	-- Session-Timeout is still projected for midnight plans.
	expiry_mode          TEXT,
	created_at           TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Free-form key/value settings (router host + REST creds, radius secret,
-- container IP/hostname, server-name pointer, walled-garden list, ...).
CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT
);

-- Voucher codes. Each code is a RADIUS user (radcheck Cleartext-Password = code,
-- radusergroup -> the plan's group). status: unused | used | revoked.
CREATE TABLE IF NOT EXISTS vouchers (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	code                 TEXT NOT NULL UNIQUE,
	plan_id              INTEGER REFERENCES plans(id) ON DELETE SET NULL,
	status               TEXT NOT NULL DEFAULT 'unused',
	batch_id             TEXT,
	mac_remember_override INTEGER,
	created_at           TEXT NOT NULL DEFAULT (datetime('now')),
	first_use_at         TEXT,
	expires_at           TEXT,
	-- Optional absolute validity window (date-gated vouchers). NULL = no gate.
	valid_from           TEXT,
	valid_until          TEXT
);
CREATE INDEX IF NOT EXISTS vouchers_batch ON vouchers(batch_id);
CREATE INDEX IF NOT EXISTS vouchers_status ON vouchers(status);

-- Named user accounts (e.g. staff / paid). username -> radcheck + radusergroup.
CREATE TABLE IF NOT EXISTS accounts (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	username             TEXT NOT NULL UNIQUE,
	password             TEXT NOT NULL,
	plan_id              INTEGER REFERENCES plans(id) ON DELETE SET NULL,
	enabled              INTEGER NOT NULL DEFAULT 1,
	mac_remember_override INTEGER,
	created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Remembered devices for MAC re-auth. When a user logs in on a mac_remember plan,
-- the grant processor records their MAC here AND as a RADIUS user (username = MAC,
-- Cleartext-Password = MAC, with an Expiration check item) so a returning device
-- (MikroTik login-by=mac) auto-authenticates until the validity window closes.
CREATE TABLE IF NOT EXISTS mac_sessions (
	id                   INTEGER PRIMARY KEY AUTOINCREMENT,
	mac                  TEXT NOT NULL UNIQUE,
	identity             TEXT,
	plan_id              INTEGER REFERENCES plans(id) ON DELETE SET NULL,
	rate_limit           TEXT,
	total_limit_bytes    INTEGER,
	session_timeout_secs INTEGER,
	granted_at           TEXT NOT NULL DEFAULT (datetime('now')),
	expires_at           TEXT NOT NULL,
	active               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS mac_sessions_active ON mac_sessions(active, expires_at);

-- Saved captive-portal page designs. `grapes_json` holds the PUBLISHED design
-- model JSON (theme + blocks + per-page block lists) that the live portal
-- renders from; `draft_json` holds an unpublished working copy the editor is
-- still editing (NULL when there is no draft). (`html`/`css` are legacy/unused
-- now.) `version` counts publishes (0 = never published). Exactly one design
-- is active at a time.
CREATE TABLE IF NOT EXISTS designs (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT NOT NULL,
	grapes_json TEXT,
	draft_json TEXT,
	html       TEXT NOT NULL DEFAULT '',
	css        TEXT NOT NULL DEFAULT '',
	is_active  INTEGER NOT NULL DEFAULT 0,
	version    INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Snapshots of published design versions (up to 5 kept per design, oldest
-- pruned on publish) so an admin can revert. Reverting publishes the stored
-- model again as a new version rather than rewriting history.
CREATE TABLE IF NOT EXISTS design_versions (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	design_id  INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
	version    INTEGER NOT NULL,
	model_json TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS design_versions_design ON design_versions(design_id, version);

-- Admin action audit trail. Append-only record of state-changing admin actions
-- (plan/voucher/account CRUD, kicks, restores, backups) for accountability.
CREATE TABLE IF NOT EXISTS admin_audit (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	action     TEXT NOT NULL,
	detail     TEXT,
	ip         TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit(id);
CREATE INDEX IF NOT EXISTS admin_audit_created_at ON admin_audit(created_at);

-- App event log (sweep failures, radiusd reload results, CoA no-ACKs, plugin
-- lookups, backup/restore). level: debug | info | warn | error. Pruned by the
-- retention sweep; warn/error rows feed the admin notice strip.
CREATE TABLE IF NOT EXISTS events (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	level      TEXT NOT NULL DEFAULT 'info',
	source     TEXT NOT NULL DEFAULT 'app',
	message    TEXT NOT NULL,
	detail     TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS events_level ON events(level, id);

-- Admin-authored announcements shown on the portal login page, the status page
-- and/or the admin dashboard, optionally only inside a time window.
-- severity: info | warning | danger | success. targets: JSON array of
-- 'portal' | 'status' | 'admin'.
CREATE TABLE IF NOT EXISTS announcements (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	title      TEXT NOT NULL DEFAULT '',
	body       TEXT NOT NULL DEFAULT '',
	severity   TEXT NOT NULL DEFAULT 'info',
	targets    TEXT NOT NULL DEFAULT '["portal"]',
	starts_at  TEXT,
	ends_at    TEXT,
	enabled    INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Branding assets (images/fonts/css) uploaded by the admin and served by the
-- container at /assets/<filename> (referenced by the live portal page). The
-- bytes live on the /data volume; this table is the index.
CREATE TABLE IF NOT EXISTS assets (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	filename   TEXT NOT NULL UNIQUE,
	mime       TEXT,
	bytes      INTEGER,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pluggable guest-lookup "recipes" (Stage 0.13): how to talk to a hotel/venue
-- guest system to admit a captive-portal visitor without a plan/voucher/
-- account. `recipe_json` is the validated, secret-stripped recipe (see
-- app/src/plugins/recipe.js); `secrets_json` holds the recipe's credential
-- values (username/password/apiKey) separately so a redacted backup can wipe
-- just this column. `enabled` is mirrored from the recipe for quick filtering.
CREATE TABLE IF NOT EXISTS plugins (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	name         TEXT NOT NULL,
	enabled      INTEGER NOT NULL DEFAULT 1,
	recipe_json  TEXT NOT NULL,
	secrets_json TEXT NOT NULL DEFAULT '{}',
	created_at   TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per admitted guest-lookup visitor: the minted RADIUS credential
-- (username/password projected via radius/sync.js), which plugin admitted
-- them, and when the grant expires (the sweeper removes the RADIUS user and
-- flips `active` off once `expires_at` passes — see plugins/grants.js).
CREATE TABLE IF NOT EXISTS plugin_grants (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	plugin_id   INTEGER REFERENCES plugins(id) ON DELETE SET NULL,
	username    TEXT NOT NULL UNIQUE,
	mac         TEXT,
	ip          TEXT,
	guest_label TEXT,
	inputs_json TEXT,
	granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
	expires_at  TEXT NOT NULL,
	active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS plugin_grants_active ON plugin_grants(active, expires_at);
