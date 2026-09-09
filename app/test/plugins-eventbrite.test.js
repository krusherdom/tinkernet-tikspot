// Integration tests for the Eventbrite attendees recipe
// (plugins/eventbrite.json) against the bundled mock
// (examples/eventbrite-mock/server.js). Exercises `steps[].requireRecords`,
// `steps[].paginate` (3 pages of 50 attendees) and `steps[].extra` end to end
// with a real (non-stubbed) httpRequest.

process.env.TZ = 'UTC';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateRecipe } from '../src/plugins/recipe.js';
import { runLookup, makeTokenCache } from '../src/plugins/engine.js';
import { httpRequest } from '../src/plugins/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const MOCK_DIR = path.join(REPO_ROOT, 'examples', 'eventbrite-mock');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

// Matches examples/eventbrite-mock/config.json.
const GOOD_SECRETS = { token: 'mock-eventbrite-private-token' };

let child;
let baseUrl;

before(async () => {
  const serverPath = path.join(MOCK_DIR, 'server.js');
  assert.ok(fs.existsSync(serverPath), `expected ${serverPath} to exist`);

  child = spawn(process.execPath, [serverPath], {
    cwd: MOCK_DIR,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  baseUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
      if (m) {
        child.stdout.off('data', onData);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`eventbrite-mock exited early (code ${code})`)));
    setTimeout(() => reject(new Error('timed out waiting for eventbrite-mock to start')), 10000);
  });
});

after(() => {
  if (child && !child.killed) child.kill();
});

function loadRecipe(secrets = GOOD_SECRETS, eventId = '900001') {
  const wrapper = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'eventbrite.json'), 'utf8'));
  assert.equal(wrapper.format, 'tikspot-plugin');
  const recipe = wrapper.recipe;
  recipe.paramValues = { ...recipe.paramValues, baseUrl: baseUrl + '/v3', eventId };
  recipe.secrets = { ...secrets };
  return recipe;
}

function validate(recipe) {
  const v = validateRecipe(recipe);
  assert.equal(v.ok, true, `recipe should validate: ${JSON.stringify(v.fields)}`);
  return v.value;
}

function inputsFor(recipe, values) {
  return recipe.inputs.map((i) => ({ name: i.name, required: i.required, value: values[i.name] ?? '' }));
}

test('Eventbrite: attendee on page 3 (of 3, 50/page over 120 attendees) -> ok, paginated through', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { email: 'grace.kim@example.com', last_name: 'Kim' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
    diagnostics: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.guest.label, /Grace Kim/);
  assert.equal(typeof result.expiresAt, 'string');

  const attendeesStep = result.steps.find((s) => s.name === 'attendees');
  assert.ok(attendeesStep, 'expected an "attendees" step in diagnostics');
  assert.equal(attendeesStep.records, 120, 'expected all 120 attendees to have been paginated through');
  assert.equal(attendeesStep.pages, 3, 'expected pagination count (3 pages of 50) in diagnostics');
});

test('Eventbrite: wrong email -> no-match', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { email: 'not-a-real-attendee@example.com', last_name: 'Nobody' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'no-match' });
});

test("Eventbrite: bad token -> upstream (mock returns Eventbrite's own { status_code, error, error_description } envelope)", async () => {
  const recipe = validate(loadRecipe({ token: 'wrong-token' }));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { email: 'grace.kim@example.com', last_name: 'Kim' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
});

test('Eventbrite: unknown event ID -> upstream (requireRecords / 404 on the event step)', async () => {
  const recipe = validate(loadRecipe(GOOD_SECRETS, 'no-such-event'));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { email: 'grace.kim@example.com', last_name: 'Kim' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
});
