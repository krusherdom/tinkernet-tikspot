// Stage 0.11-C/D DB-backed tests: announcements, events, reports, retention,
// and an HTTP-level smoke test over settings/announcements/logs routes.
// Uses a fresh in-memory better-sqlite3 DB (migrated) per test.
import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';
import Fastify from 'fastify';

import { migrate } from '../src/db/migrate.js';
import { setSetting } from '../src/db/settings.js';
import { validateAnnouncement } from '../src/admin/announcementRules.js';
import announcementRoutes, {
  activeAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  listAnnouncements,
} from '../src/admin/announcements.js';
import { logEvent, listEvents, recentProblems } from '../src/admin/events.js';
import logsRoutes, { reportSummary } from '../src/admin/logs.js';
import { pruneNow, sweepRetention } from '../src/admin/retention.js';
import settingsRoutes from '../src/admin/settingsRoutes.js';
import adminRoutes from '../src/admin/routes.js';
import { getJSON } from '../src/db/settings.js';
import {
  createDesign,
  saveDraft,
  publishDesign,
  listVersions,
  revertDesign,
  getDesign,
  activateDesign,
  designModel,
} from '../src/portal/designs.js';
import { TEMPLATES } from '../src/design/templates.js';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function insertPlan(db, name, radius_groupname) {
  db.prepare('INSERT INTO plans (name, radius_groupname) VALUES (?, ?)').run(name, radius_groupname);
}

function insertUserGroup(db, username, groupname, priority = 1) {
  db.prepare('INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, ?)').run(username, groupname, priority);
}

let acctUniqueCounter = 0;
function insertRadacct(db, { username, acctstarttime, acctstoptime = null, acctinputoctets = 0, acctoutputoctets = 0 }) {
  const acctuniqueid = `test-${++acctUniqueCounter}`;
  db.prepare(
    `INSERT INTO radacct (acctuniqueid, username, acctstarttime, acctstoptime, acctinputoctets, acctoutputoctets)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(acctuniqueid, username, acctstarttime, acctstoptime, acctinputoctets, acctoutputoctets);
}

function insertPostAuth(db, { username, reply, authdate }) {
  db.prepare('INSERT INTO radpostauth (username, pass, reply, authdate) VALUES (?, ?, ?, ?)').run(username, 'x', reply, authdate);
}

// ---------------------------------------------------------------------------
// activeAnnouncements
test('activeAnnouncements honours targets and window, sorted danger first', () => {
  const db = freshDb();
  const hourMs = 3600 * 1000;
  const future = new Date(Date.now() + 24 * hourMs).toISOString();
  const past = new Date(Date.now() - 24 * hourMs).toISOString();

  const mkVal = (overrides) => validateAnnouncement({ title: 'x', targets: ['portal'], ...overrides }).value;

  createAnnouncement(db, mkVal({ title: 'warning-now', severity: 'warning' })); // active, portal
  createAnnouncement(db, mkVal({ title: 'danger-scheduled', severity: 'danger', starts_at: future })); // not yet active
  createAnnouncement(db, mkVal({ title: 'danger-status-only', severity: 'danger', targets: ['status'] })); // wrong target
  createAnnouncement(db, mkVal({ title: 'danger-expired', severity: 'danger', ends_at: past })); // expired
  createAnnouncement(db, mkVal({ title: 'danger-disabled', severity: 'danger', enabled: 0 })); // disabled
  createAnnouncement(db, mkVal({ title: 'danger-now', severity: 'danger' })); // active, portal

  const active = activeAnnouncements(db, 'portal');
  assert.deepEqual(
    active.map((a) => a.title),
    ['danger-now', 'warning-now'],
  );

  // Same danger-severity announcement also shows for its own extra target.
  const statusActive = activeAnnouncements(db, 'status');
  assert.deepEqual(statusActive.map((a) => a.title), ['danger-status-only']);
});

test('activeAnnouncements never throws if the table is missing (defensive)', () => {
  const db = new Database(':memory:'); // no migrate() -> no announcements table
  assert.deepEqual(activeAnnouncements(db, 'portal'), []);
});

// ---------------------------------------------------------------------------
// createAnnouncement / updateAnnouncement / listAnnouncements
test('createAnnouncement/updateAnnouncement/listAnnouncements round-trip with state', () => {
  const db = freshDb();
  const v = validateAnnouncement({ title: 'Hello', body: 'World', severity: 'info', targets: ['portal'] }).value;
  const created = createAnnouncement(db, v);
  assert.equal(created.title, 'Hello');
  assert.equal(created.body, 'World');
  assert.equal(created.severity, 'info');
  assert.deepEqual(created.targets, ['portal']);
  assert.equal(created.enabled, 1);

  const v2 = validateAnnouncement({
    title: 'Hello v2',
    body: 'World',
    severity: 'danger',
    targets: ['portal', 'admin'],
    enabled: false,
  }).value;
  const updated = updateAnnouncement(db, created.id, v2);
  assert.equal(updated.id, created.id);
  assert.equal(updated.title, 'Hello v2');
  assert.equal(updated.severity, 'danger');
  assert.deepEqual(updated.targets, ['portal', 'admin']);
  assert.equal(updated.enabled, 0);

  const list = listAnnouncements(db);
  const row = list.find((a) => a.id === created.id);
  assert.ok(row, 'updated row should be listed');
  assert.equal(row.state, 'disabled');

  // Re-enable and confirm state flips to active.
  const v3 = { ...v2, enabled: 1 };
  updateAnnouncement(db, created.id, v3);
  const listed = listAnnouncements(db).find((a) => a.id === created.id);
  assert.equal(listed.state, 'active');
});

// ---------------------------------------------------------------------------
// listEvents / recentProblems
test('listEvents level filter (warn returns warn+error) and recentProblems', () => {
  const db = freshDb();
  logEvent(db, 'debug', 'app', 'debug msg');
  logEvent(db, 'info', 'app', 'info msg');
  logEvent(db, 'warn', 'radius', 'warn msg');
  logEvent(db, 'error', 'radius', 'error msg');

  const all = listEvents(db, {});
  assert.equal(all.length, 4);

  const warnAndUp = listEvents(db, { level: 'warn' });
  assert.equal(warnAndUp.length, 2);
  assert.deepEqual(
    warnAndUp.map((e) => e.level).sort(),
    ['error', 'warn'],
  );

  const bySource = listEvents(db, { source: 'radius' });
  assert.equal(bySource.length, 2);

  const problems = recentProblems(db, { hours: 24, limit: 10 });
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => p.level === 'warn' || p.level === 'error'));

  // Per-attempt lookup outcomes are rolled up into one line with a count;
  // other plugin problems still show individually.
  logEvent(db, 'warn', 'plugin', 'Lookup refused: room 101 / name Smith — guest system error (HTTP 500) (plugin P)');
  logEvent(db, 'warn', 'plugin', 'Lookup refused: room 102 / name Jones — guest system timed out (plugin P)');
  logEvent(db, 'error', 'plugin', 'Lookup failed: boom');
  logEvent(db, 'warn', 'plugin', 'Catalog fetch failed: 503');
  const rolled = recentProblems(db, { hours: 24, limit: 10 });
  assert.equal(rolled.filter((p) => /^Lookup /.test(p.message)).length, 0, 'no per-attempt rows');
  const roll = rolled.find((p) => p.rollup);
  assert.ok(roll, 'roll-up present');
  assert.equal(roll.count, 3);
  assert.match(roll.message, /^3 guest lookups failed/);
  assert.equal(roll.link, 'logs/events');
  assert.ok(rolled.some((p) => p.message === 'Catalog fetch failed: 503'));
  assert.equal(rolled.length, 4); // roll-up + catalog + the two radius rows
});

// ---------------------------------------------------------------------------
// reportSummary
test('reportSummary aggregates radpostauth accepts/rejects and radacct usage by plan', () => {
  const db = freshDb();

  const nowStr = db.prepare("SELECT datetime('now') AS t").get().t;
  insertPostAuth(db, { username: 'alice', reply: 'Access-Accept', authdate: nowStr });
  insertPostAuth(db, { username: 'alice', reply: 'Access-Accept', authdate: nowStr });
  insertPostAuth(db, { username: 'bob', reply: 'Access-Reject', authdate: nowStr });

  insertPlan(db, 'Basic', 'grp_basic');
  insertUserGroup(db, 'alice', 'grp_basic');
  // bob has no radusergroup row -> falls into 'other'.

  insertRadacct(db, { username: 'alice', acctstarttime: nowStr, acctinputoctets: 1000, acctoutputoctets: 2000 });
  insertRadacct(db, { username: 'bob', acctstarttime: nowStr, acctinputoctets: 300, acctoutputoctets: 400 });

  const summary = reportSummary(db, 7);
  assert.equal(summary.days, 7);
  assert.equal(summary.totals.accepts, 2);
  assert.equal(summary.totals.rejects, 1);
  assert.equal(summary.totals.sessions, 2);
  assert.equal(summary.totals.bytes, 1000 + 2000 + 300 + 400);

  const basic = summary.byPlan.find((p) => p.plan === 'Basic');
  assert.ok(basic, 'expected a Basic plan bucket');
  assert.equal(basic.sessions, 1);
  assert.equal(basic.users, 1);
  assert.equal(Number(basic.bytesIn), 1000);
  assert.equal(Number(basic.bytesOut), 2000);

  const other = summary.byPlan.find((p) => p.plan === 'other');
  assert.ok(other, 'expected an "other" bucket for unmapped users');
  assert.equal(other.sessions, 1);
  assert.equal(other.users, 1);

  const topUsernames = summary.topUsers.map((u) => u.username);
  assert.ok(topUsernames.includes('alice'));
  assert.ok(topUsernames.includes('bob'));
  // alice has more total bytes (3000) than bob (700) -> ranked first.
  assert.equal(topUsernames[0], 'alice');
});

// ---------------------------------------------------------------------------
// pruneNow
test('pruneNow deletes rows older than retention_days by age; open radacct rows always survive', () => {
  const db = freshDb();
  const nowMs = Date.UTC(2026, 8, 8, 12, 0, 0); // 2026-09-08T12:00:00Z
  setSetting(db, 'retention_days', '10');
  setSetting(db, 'retention_max_rows', '5000');

  insertPostAuth(db, { username: 'old', reply: 'Access-Accept', authdate: '2026-01-01 00:00:00' }); // > 10d old
  insertPostAuth(db, { username: 'new', reply: 'Access-Accept', authdate: '2026-09-07 00:00:00' }); // within window

  insertRadacct(db, { username: 'closed-old', acctstarttime: '2025-12-01 00:00:00', acctstoptime: '2026-01-01 00:00:00' });
  insertRadacct(db, { username: 'closed-new', acctstarttime: '2026-09-06 00:00:00', acctstoptime: '2026-09-07 00:00:00' });
  insertRadacct(db, { username: 'still-open', acctstarttime: '2020-01-01 00:00:00', acctstoptime: null });

  const result = pruneNow(db, nowMs);

  assert.equal(result.radpostauth, 1);
  assert.equal(result.radacct, 1);

  const remainingAuth = db.prepare('SELECT username FROM radpostauth').all().map((r) => r.username);
  assert.deepEqual(remainingAuth, ['new']);

  const remainingAcct = db.prepare('SELECT username FROM radacct ORDER BY username').all().map((r) => r.username);
  assert.deepEqual(remainingAcct, ['closed-new', 'still-open']);
});

test('pruneNow enforces the retention_max_rows cap, deleting the oldest rows first', () => {
  const db = freshDb();
  const nowMs = Date.UTC(2026, 8, 8, 12, 0, 0);
  setSetting(db, 'retention_days', '3650'); // effectively no age-based pruning
  // retentionCutoffs floors maxRows at 100 regardless of the stored value, so
  // the cap only bites once a table actually exceeds that floor.
  setSetting(db, 'retention_max_rows', '100');

  const total = 105;
  for (let i = 0; i < total; i++) {
    db.prepare('INSERT INTO events (level, source, message) VALUES (?, ?, ?)').run('info', 'app', `msg ${i}`);
  }
  const idsBefore = db.prepare('SELECT id FROM events ORDER BY id').all().map((r) => r.id);
  assert.equal(idsBefore.length, total);

  const result = pruneNow(db, nowMs);
  assert.equal(result.events, 5);

  const remaining = db.prepare('SELECT id FROM events ORDER BY id').all().map((r) => r.id);
  assert.equal(remaining.length, 100);
  assert.deepEqual(remaining, idsBefore.slice(5)); // the five oldest (lowest id) were removed
});

// ---------------------------------------------------------------------------
// sweepRetention daily gate
test('sweepRetention runs at most once per router-local day', () => {
  const db = freshDb();
  const day1 = Date.UTC(2026, 8, 8, 12, 0, 0);
  const day1Later = day1 + 3600 * 1000; // same day, later hour
  const day2 = day1 + 24 * 3600 * 1000;

  const first = sweepRetention(db, null, day1);
  assert.notEqual(first, null);
  assert.equal(typeof first, 'object');

  const second = sweepRetention(db, null, day1Later);
  assert.equal(second, null);

  const third = sweepRetention(db, null, day2);
  assert.notEqual(third, null);
});

// ---------------------------------------------------------------------------
// HTTP integration: settings, announcements, logs routes over Fastify.inject()
test('HTTP: settings PATCH/GET, announcements POST/notices, logs storage/export', async () => {
  const db = freshDb();
  const app = Fastify();
  app.decorate('db', db);
  await app.register(settingsRoutes);
  await app.register(announcementRoutes);
  await app.register(logsRoutes);

  // PATCH /api/settings with a bad int -> 400 with fields
  let res = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { retention_days: 'x' } });
  assert.equal(res.statusCode, 400);
  let body = res.json();
  assert.ok(body.fields && body.fields.retention_days);

  // PATCH /api/settings with a good value -> 200
  res = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { retention_days: 45 } });
  assert.equal(res.statusCode, 200);

  // GET /api/settings reflects the new value
  res = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.statusCode, 200);
  body = res.json();
  const flat = body.groups.flatMap((g) => g.settings);
  const rd = flat.find((s) => s.key === 'retention_days');
  assert.ok(rd);
  assert.equal(rd.value, 45);

  // POST /api/announcements
  res = await app.inject({
    method: 'POST',
    url: '/api/announcements',
    payload: { title: 'Scheduled maintenance', body: 'Tonight', severity: 'danger', targets: ['admin'] },
  });
  assert.equal(res.statusCode, 200);
  body = res.json();
  assert.equal(body.announcement.title, 'Scheduled maintenance');

  // GET /api/notices picks it up (target 'admin')
  res = await app.inject({ method: 'GET', url: '/api/notices' });
  assert.equal(res.statusCode, 200);
  body = res.json();
  assert.ok(body.announcements.some((a) => a.title === 'Scheduled maintenance'));
  assert.ok(Array.isArray(body.problems));

  // GET /api/logs/storage shape
  res = await app.inject({ method: 'GET', url: '/api/logs/storage' });
  assert.equal(res.statusCode, 200);
  body = res.json();
  assert.ok(body.counts && typeof body.counts === 'object');
  assert.ok('fileBytes' in body);
  assert.equal(body.retention.retention_days, 45);
  assert.ok('retention_max_rows' in body.retention);

  // GET /api/logs/export?days=7 -> zip
  res = await app.inject({ method: 'GET', url: '/api/logs/export?days=7' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.match(res.headers['content-disposition'], /attachment; filename="tikspot-logs-7d-.*\.zip"/);
  assert.ok(res.rawPayload.length > 0);
});

// ---------------------------------------------------------------------------
// Design draft -> publish -> versions -> revert
test('design lifecycle: draft, publish, version cap of 5, and revert publishes a new version', () => {
  const db = freshDb();
  const id = createDesign(db, { name: 'My design' });
  let row = getDesign(db, id);
  assert.equal(row.version, 0);
  assert.ok(row.draft_json); // createDesign seeds a draft

  saveDraft(db, id, { blocks: [{ id: 'h', type: 'heading', props: { text: 'Draft heading' } }] });
  row = getDesign(db, id);
  assert.ok(JSON.parse(row.draft_json).blocks.some((b) => b.props.text === 'Draft heading'));

  const v1 = publishDesign(db, id); // publishes the current draft
  assert.equal(v1, 1);
  row = getDesign(db, id);
  assert.equal(row.draft_json, null);
  assert.ok(JSON.parse(row.grapes_json).blocks.some((b) => b.props.text === 'Draft heading'));

  // Publish 5 more times (versions 2..6) -> only the newest 5 are kept.
  for (let i = 2; i <= 6; i++) {
    publishDesign(db, id, { blocks: [{ id: 'h', type: 'heading', props: { text: `v${i}` } }] });
  }
  const versions = listVersions(db, id);
  assert.equal(versions.length, 5); // v1 was pruned; v2-v6 remain
  assert.deepEqual(versions.map((v) => v.version), [6, 5, 4, 3, 2]);

  assert.equal(revertDesign(db, id, 1), null); // v1 was pruned away

  const reverted = revertDesign(db, id, 3);
  assert.equal(reverted, 7); // revert publishes as a NEW version, not a rewrite
  row = getDesign(db, id);
  assert.ok(JSON.parse(row.grapes_json).blocks.some((b) => b.props.text === 'v3'));

  assert.equal(revertDesign(db, id, 999), null); // no such version
});

// ---------------------------------------------------------------------------
// Free-login credential sync on publish
test('publishing a design with a free-login on a non-free plan syncs free-<group> into radcheck, and removes it once unreferenced', () => {
  const db = freshDb();
  insertPlan(db, 'Staff', 'staff');
  const id = createDesign(db, {
    model: { blocks: [{ id: 'f', type: 'free-login', props: { label: 'Staff', plan: 'staff' } }] },
  });
  activateDesign(db, id); // must be the active design for syncFreeCredentials to run on publish
  publishDesign(db, id);

  let cred = db.prepare("SELECT value FROM radcheck WHERE username = 'free-staff' AND attribute = 'Cleartext-Password'").get();
  assert.ok(cred, 'expected a free-staff radcheck row');
  const group = db.prepare("SELECT groupname FROM radusergroup WHERE username = 'free-staff'").get();
  assert.equal(group.groupname, 'staff');
  const stored = getJSON(db, 'free_credentials', {});
  assert.equal(stored.staff, cred.value);

  // Publish again without the free-login block -> the free-staff user is torn down.
  publishDesign(db, id, { blocks: [{ id: 'h', type: 'heading', props: { text: 'no more free login' } }] });
  cred = db.prepare("SELECT 1 FROM radcheck WHERE username = 'free-staff'").get();
  assert.equal(cred, undefined);
});

// ---------------------------------------------------------------------------
// Templates
test('createDesign from each template normalizes into a usable design', () => {
  const db = freshDb();
  for (const t of TEMPLATES) {
    const id = createDesign(db, { name: t.name, template: t.key });
    const row = getDesign(db, id);
    const model = JSON.parse(row.draft_json);
    assert.ok(Array.isArray(model.blocks) && model.blocks.length > 0, `${t.key}: has blocks`);
    assert.ok(model.theme && model.theme.accent, `${t.key}: has a theme`);
    assert.ok(model.pages && Array.isArray(model.pages.status), `${t.key}: has default pages`);
  }
});

// ---------------------------------------------------------------------------
// Asset delete 409 when referenced by the active design
test('DELETE /api/assets/:id is refused (409) when the active design references it, and works once it does not', async () => {
  const db = freshDb();
  const app = Fastify();
  app.decorate('db', db);
  await app.register(adminRoutes);

  db.prepare("INSERT INTO assets (filename, mime, bytes) VALUES ('logo.png', 'image/png', 100)").run();
  const asset = db.prepare("SELECT id FROM assets WHERE filename = 'logo.png'").get();

  const id = createDesign(db, { model: { blocks: [{ id: 'l', type: 'logo', props: { src: '/assets/logo.png' } }] } });
  activateDesign(db, id);
  publishDesign(db, id);

  let res = await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}` });
  assert.equal(res.statusCode, 409);

  publishDesign(db, id, { blocks: [{ id: 'h', type: 'heading', props: { text: 'no logo' } }] });
  res = await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}` });
  assert.equal(res.statusCode, 200);
  assert.equal(db.prepare('SELECT 1 FROM assets WHERE id = ?').get(asset.id), undefined);
});

// ---------------------------------------------------------------------------
// HTTP: block registry + design routes end-to-end
test('HTTP: GET /api/blocks and the design create/draft/publish/activate/versions flow', async () => {
  const db = freshDb();
  const app = Fastify();
  app.decorate('db', db);
  await app.register(adminRoutes);

  let res = await app.inject({ method: 'GET', url: '/api/blocks' });
  assert.equal(res.statusCode, 200);
  let body = res.json();
  assert.ok(Array.isArray(body.blocks) && body.blocks.length > 0);
  assert.ok(Array.isArray(body.styleFields));
  assert.ok(Array.isArray(body.themeFields));
  assert.ok(body.theme && body.theme.accent);

  res = await app.inject({ method: 'POST', url: '/api/designs', payload: { name: 'New design', template: 'minimal' } });
  assert.equal(res.statusCode, 200);
  const id = res.json().id;

  res = await app.inject({ method: 'GET', url: `/api/designs/${id}` });
  body = res.json();
  assert.equal(body.version, 0);
  assert.ok(body.draft);

  res = await app.inject({
    method: 'POST',
    url: `/api/designs/${id}/draft`,
    payload: { model: { blocks: [{ id: 'h', type: 'heading', props: { text: 'Hi there' } }] } },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().ok);

  res = await app.inject({ method: 'POST', url: `/api/designs/${id}/publish`, payload: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().version, 1);

  res = await app.inject({ method: 'POST', url: `/api/designs/${id}/activate` });
  assert.equal(res.statusCode, 200);

  res = await app.inject({ method: 'GET', url: '/api/designs/active' });
  body = res.json();
  assert.equal(body.id, id);
  assert.ok(body.model.blocks.some((b) => b.props.text === 'Hi there'));

  res = await app.inject({ method: 'GET', url: `/api/designs/${id}/versions` });
  assert.equal(res.json().versions.length, 1);

  // Export -> re-import as a new design.
  res = await app.inject({ method: 'GET', url: `/api/designs/${id}/export` });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-disposition'], /attachment; filename=".*\.tikspot-design\.json"/);
  const bundle = res.json();
  assert.equal(bundle.format, 'tikspot-design');

  res = await app.inject({ method: 'POST', url: '/api/designs/import', payload: bundle });
  assert.equal(res.statusCode, 200);
  const importedId = res.json().id;
  assert.notEqual(importedId, id);

  // Preview renders HTML with no live router link.
  res = await app.inject({
    method: 'POST',
    url: '/api/designs/preview',
    payload: { design: designModel(getDesign(db, id)), page: 'login' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.payload, /Hi there/);

  // Cannot delete the active design.
  res = await app.inject({ method: 'DELETE', url: `/api/designs/${id}` });
  assert.equal(res.statusCode, 400);
  // But an inactive (imported) one can be deleted.
  res = await app.inject({ method: 'DELETE', url: `/api/designs/${importedId}` });
  assert.equal(res.statusCode, 200);
});

test('HTTP: GET /api/vouchers/print renders a batch sheet with cols, validity, escaping and no revoked codes', async () => {
  const { default: manageRoutes } = await import('../src/admin/manage.js');
  const db = freshDb();
  const app = Fastify();
  app.decorate('db', db);
  await app.register(manageRoutes);

  let res = await app.inject({ method: 'POST', url: '/api/plans', payload: { name: '<b>Day</b> pass', rate_limit: '2M/2M' } });
  assert.equal(res.statusCode, 200, res.body);
  const planId = res.json().id;

  res = await app.inject({
    method: 'POST',
    url: '/api/vouchers/batch',
    payload: { plan_id: planId, count: 3, valid_from: '2099-07-01', valid_until: '2099-07-31' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const { batch_id: batchId, codes } = res.json();
  assert.equal(codes.length, 3);

  res = await app.inject({ method: 'GET', url: `/api/vouchers?batch=${batchId}` });
  const revoked = res.json().vouchers[0];
  res = await app.inject({ method: 'POST', url: `/api/vouchers/${revoked.id}/revoke` });
  assert.equal(res.statusCode, 200, res.body);

  res = await app.inject({ method: 'GET', url: `/api/vouchers/print?batch=${batchId}` });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  const html = res.body;
  assert.match(html, /break-inside/);
  assert.match(html, /--cols:3/);
  for (const c of codes.filter((c) => c !== revoked.code)) assert.ok(html.includes(c), `missing ${c}`);
  assert.ok(!html.includes(revoked.code), 'revoked code must not print');
  assert.ok(html.includes('&lt;b&gt;Day&lt;/b&gt; pass'), 'plan name is escaped');
  assert.ok(!html.includes('<b>Day</b>'));
  assert.ok(html.includes('2M/2M'));
  assert.ok(html.includes('Valid 1/7/2099 – 31/7/2099'));
  assert.match(html, /2 voucher\(s\)/);

  for (const [q, want] of [['4', 4], ['9', 4], ['1', 2], ['2', 2], ['abc', 3]]) {
    res = await app.inject({ method: 'GET', url: `/api/vouchers/print?batch=${batchId}&cols=${q}` });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes(`--cols:${want}`), `cols=${q} -> --cols:${want}`);
  }

  res = await app.inject({ method: 'GET', url: '/api/vouchers/print?all=1' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /2 voucher\(s\)/);
  await app.close();
});

// ---------------------------------------------------------------------------
// /api/plans: edit any plan (incl. the seeded free one); a partial PATCH keeps
// the limits it doesn't mention; DELETE refuses the free plan.
test('HTTP: PATCH /api/plans/:id edits limits (free plan too) without wiping omitted ones', async () => {
  const { default: manageRoutes } = await import('../src/admin/manage.js');
  const { seedDefaults } = await import('../src/seed.js');
  const db = freshDb();
  seedDefaults(db);
  const app = Fastify();
  app.decorate('db', db);
  await app.register(manageRoutes);

  const free = db.prepare("SELECT * FROM plans WHERE radius_groupname = 'free'").get();
  assert.ok(free, 'free plan seeded');
  const groupReply = (g) => db.prepare('SELECT attribute, value FROM radgroupreply WHERE groupname = ? ORDER BY attribute').all(g);
  assert.ok(groupReply('free').some((r) => r.attribute === 'Mikrotik-Total-Limit'), 'seeded free plan has a data cap');

  // Full edit of the free plan: new rate, no data cap, no session timeout, MAC validity 3 days.
  let res = await app.inject({
    method: 'PATCH',
    url: `/api/plans/${free.id}`,
    payload: { name: 'Free', rate_limit: '100M/20M', total_limit_bytes: null, session_timeout_secs: null, mac_remember: true, mac_validity_secs: 3 * 86400, expiry_mode: 'fixed' },
  });
  assert.equal(res.statusCode, 200, res.body);
  let row = db.prepare('SELECT * FROM plans WHERE id = ?').get(free.id);
  assert.equal(row.rate_limit, '100M/20M');
  assert.equal(row.total_limit_bytes, null);
  assert.equal(row.session_timeout_secs, null);
  assert.equal(row.mac_remember, 1);
  assert.equal(row.mac_validity_secs, 3 * 86400);
  const reply = groupReply('free');
  assert.deepEqual(reply.map((r) => r.attribute), ['Mikrotik-Rate-Limit']);
  assert.equal(reply[0].value, '100M/20M');

  // Partial PATCH (name only) leaves every limit alone.
  res = await app.inject({ method: 'PATCH', url: `/api/plans/${free.id}`, payload: { name: 'Free Wi-Fi' } });
  assert.equal(res.statusCode, 200, res.body);
  row = db.prepare('SELECT * FROM plans WHERE id = ?').get(free.id);
  assert.equal(row.name, 'Free Wi-Fi');
  assert.equal(row.rate_limit, '100M/20M');
  assert.equal(row.mac_validity_secs, 3 * 86400);
  assert.equal(row.radius_groupname, 'free', 'group name is immutable');

  // An explicit null clears a limit.
  res = await app.inject({ method: 'PATCH', url: `/api/plans/${free.id}`, payload: { rate_limit: null } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(db.prepare('SELECT rate_limit FROM plans WHERE id = ?').get(free.id).rate_limit, null);
  assert.equal(groupReply('free').length, 0);

  // Validation still applies; the free plan still can't be deleted.
  res = await app.inject({ method: 'PATCH', url: `/api/plans/${free.id}`, payload: { rate_limit: 'fast' } });
  assert.equal(res.statusCode, 400);
  res = await app.inject({ method: 'DELETE', url: `/api/plans/${free.id}` });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /free plan/);
});
