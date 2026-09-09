// Integration tests for the Mews Connector recipe (plugins/mews-connector.json)
// against the bundled mock (examples/mews-mock/server.js).
//
// See app/test/plugins-rms.test.js for the pattern this follows: spawn the
// mock with PORT=0, read its bound port off stdout, validate the catalog
// recipe, drive it with runLookup() + a real (non-stubbed) httpRequest.
//
// The reservations step's `AssignedResourceIds` uses
// `{{raw:steps.room.records[*].resourceId}}` per the 0.16 recipes contract
// ADDENDUM, so that Mews resources sharing a display name (e.g. two "101"s
// with different Ids, both matched by the room step below) are ALL searched
// for reservations, not just the first. This exercises `[*]` wildcard support
// inside a typed `{{raw:...}}` placeholder (app/src/plugins/template.js).

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
const MOCK_DIR = path.join(REPO_ROOT, 'examples', 'mews-mock');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

// Matches examples/mews-mock/config.json.
const GOOD_SECRETS = {
  clientToken: 'MOCKCT-E0D439EE522F44368DC78E1BFB03710C-D24FB11DBE31D4621C4817E028D9E1D',
  accessToken: 'MOCKAT-C66EF7B239D24632943D115EDE9CB810-EA00F8FD8294692C940F6B5A8F9453D',
};

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
    child.on('exit', (code) => reject(new Error(`mews-mock exited early (code ${code})`)));
    setTimeout(() => reject(new Error('timed out waiting for mews-mock to start')), 10000);
  });
});

after(() => {
  if (child && !child.killed) child.kill();
});

function loadRecipe(secrets = GOOD_SECRETS) {
  const wrapper = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'mews-connector.json'), 'utf8'));
  assert.equal(wrapper.format, 'tikspot-plugin');
  const recipe = wrapper.recipe;
  recipe.paramValues = { ...recipe.paramValues, baseUrl, clientName: 'Tikspot test' };
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

test('Mews Connector: room + surname match -> ok (room step matches two same-named resources; [*] wildcard fans reservations search out to both)', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', last_name: 'Voss' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.guest.label, /Voss/);
});

test('Mews Connector: room only -> no-match (minRules requires a second matching detail)', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'no-match' });
});

test('Mews Connector: bad tokens -> upstream (mock returns Mews\'s own 401 { Message } envelope)', async () => {
  const recipe = validate(loadRecipe({ clientToken: 'wrong', accessToken: 'wrong' }));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', last_name: 'Voss' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
});

test('Mews Connector: unknown room -> no-match (requireRecords fails the room step fast)', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: 'no-such-room', last_name: 'Nobody' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-match');
});

// -----------------------------------------------------------------------
// Optional live probe against the real public Mews demo — only runs when
// MEWS_LIVE=1 is set. The demo's data is outside our control (and rate
// limited), so this only asserts the recipe reaches a well-formed outcome,
// not a specific one, and prints what happened.
// -----------------------------------------------------------------------

const DEMO_CLIENT_TOKEN = 'E0D439EE522F44368DC78E1BFB03710C-D24FB11DBE31D4621C4817E028D9E1D';
const DEMO_ACCESS_TOKEN = 'C66EF7B239D24632943D115EDE9CB810-EA00F8FD8294692C940F6B5A8F9453D';

test('Mews Connector: live public demo probe (skipped unless MEWS_LIVE=1)', { skip: process.env.MEWS_LIVE !== '1' }, async () => {
  const wrapper = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'mews-connector.json'), 'utf8'));
  const recipe = wrapper.recipe;
  recipe.paramValues = { ...recipe.paramValues, baseUrl: 'https://api.mews-demo.com', clientName: 'Tikspot live test' };
  recipe.secrets = { clientToken: DEMO_CLIENT_TOKEN, accessToken: DEMO_ACCESS_TOKEN };
  const v = validate(recipe);
  const result = await runLookup({
    recipe: v,
    inputs: inputsFor(v, { room: '101', last_name: 'Cogifor' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  console.log('Mews live demo probe result:', JSON.stringify(result));
  assert.ok(result.ok === true || result.reason === 'no-match' || result.reason === 'upstream', `unexpected live outcome: ${JSON.stringify(result)}`);
});
