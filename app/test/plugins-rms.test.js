// Integration tests for the RMS Cloud guest-lookup recipes
// (plugins/rms-cloud-surname-room.json, plugins/rms-cloud-any-detail.json)
// against the bundled mock RMS Cloud API (examples/rms-mock/server.js).
//
// This exercises plugin-engine v2 features end to end with a real (non-stubbed)
// httpRequest: secretKeys/params/paramValues, auth.bodyJson with typed
// placeholders, tokenExpiryPath-based token caching, a bare (prefix: '')
// token placement header, request.bodyJson + omitEmpty pruning, a multi-step
// (steps/forEach) lookup, and match.minRules. See app/test/plugins-v2.test.js
// for the engine-level unit tests of those features against a stubbed http.
//
// Requires plugin-engine v2 (recipe.js/template.js/engine.js) to be in place —
// see the 0.15 contract, sections 1 and 2. If those changes haven't landed
// yet, several tests below will fail validation or produce the wrong
// secrets/body — that's expected until the engine work is merged, not a bug
// in the recipes or the mock.

// engine.js parses `auth.tokenExpiryPath` with parseDate(..., 'iso') — for a
// "YYYY-MM-DD HH:MM:SS" value (what RMS, and this mock, return) that's V8's
// local-time interpretation of the space form. Tikspot's container always
// runs in UTC, which is what the contract for this feature assumes; force
// the same here so this test is deterministic on a dev machine in any other
// timezone (see docs/plugins/README.md's date-format note).
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
const RMS_MOCK_DIR = path.join(REPO_ROOT, 'examples', 'rms-mock');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

// Matches examples/rms-mock/config.json.
const GOOD_SECRETS = {
  agentId: '1000',
  agentPassword: 'agent-secret',
  clientId: '11281',
  clientPassword: 'webservice-secret',
};

let child;
let baseUrl;

before(async () => {
  const serverPath = path.join(RMS_MOCK_DIR, 'server.js');
  assert.ok(fs.existsSync(serverPath), `expected ${serverPath} to exist`);

  child = spawn(process.execPath, [serverPath], {
    cwd: RMS_MOCK_DIR,
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
    child.on('exit', (code) => reject(new Error(`rms-mock server exited early (code ${code})`)));
    setTimeout(() => reject(new Error('timed out waiting for rms-mock server to start')), 10000);
  });
});

after(() => {
  if (child && !child.killed) child.kill();
});

// The mock's /healthz exposes a running authTokenCalls counter — a more
// reliable way to assert "the token was cached and reused" than scraping
// stdout logs for POST /authToken lines.
async function authTokenCallCount() {
  const res = await fetch(`${baseUrl}/healthz`);
  const body = await res.json();
  return body.authTokenCalls;
}

// Loads a catalog recipe file and points it at the local mock via the
// `baseUrl` param — exactly what an operator does in the admin UI.
function loadRmsRecipe(file, secrets = GOOD_SECRETS) {
  const wrapper = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, file), 'utf8'));
  assert.equal(wrapper.format, 'tikspot-plugin');
  const recipe = wrapper.recipe;

  recipe.paramValues = {
    ...recipe.paramValues,
    baseUrl,
    moduleType: 'distribution',
    useTrainingDatabase: false,
  };
  recipe.secrets = { ...secrets };
  return recipe;
}

function validate(recipe) {
  const v = validateRecipe(recipe);
  assert.equal(v.ok, true, `recipe should validate: ${JSON.stringify(v.fields)}`);
  return v.value;
}

// Builds an `inputs` array (name/value/required) from a validated recipe's
// declared `inputs[]`, so `required` flags line up with what match.js expects.
function inputsFor(recipe, values) {
  return recipe.inputs.map((i) => ({ name: i.name, required: i.required, value: values[i.name] ?? '' }));
}

// -----------------------------------------------------------------------
// Recipe A — RMS Cloud — surname + room
// -----------------------------------------------------------------------

test('RMS Cloud (surname + room): room + surname match -> ok with expiresAt', async () => {
  const recipe = validate(loadRmsRecipe('rms-cloud-surname-room.json'));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', name: 'Bennett' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.guest.label, /Bennett/);
  assert.equal(typeof result.expiresAt, 'string');
});

test('RMS Cloud (surname + room): wrong surname -> no-match', async () => {
  const recipe = validate(loadRmsRecipe('rms-cloud-surname-room.json'));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', name: 'NotARealGuest' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'no-match' });
});

test('RMS Cloud (surname + room): stay already ended -> outside-window', async () => {
  const recipe = validate(loadRmsRecipe('rms-cloud-surname-room.json'));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: 'Villa 7', name: 'Nair' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside-window');
});

test('RMS Cloud (surname + room): bad secrets -> upstream', async () => {
  const recipe = validate(loadRmsRecipe('rms-cloud-surname-room.json', { ...GOOD_SECRETS, clientPassword: 'wrong-password' }));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', name: 'Bennett' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
});

test('RMS Cloud (surname + room): token is cached and reused across lookups (authToken called once)', async () => {
  const recipe = validate(loadRmsRecipe('rms-cloud-surname-room.json'));
  const tokenCache = makeTokenCache();
  const before_ = await authTokenCallCount();

  const first = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', name: 'Bennett' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache,
  });
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', name: 'Bennett' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache,
  });
  assert.equal(second.ok, true, JSON.stringify(second));

  const after_ = await authTokenCallCount();
  assert.equal(after_ - before_, 1, 'second lookup should reuse the cached token, not call /authToken again');
});

// -----------------------------------------------------------------------
// Recipe B — RMS Cloud — room + any guest detail (multi-step)
// -----------------------------------------------------------------------

test('RMS Cloud (any detail): room + email only -> ok, even with a same-room ended stay present', async () => {
  const recipe = validate(loadRmsRecipe('rms-cloud-any-detail.json'));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: 'Villa 7', email: 'grace.sato@example.com' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.guest.label, /Sato/);
});

test('RMS Cloud (any detail): room only -> no-match (minRules requires a second matching detail)', async () => {
  const recipe = validate(loadRmsRecipe('rms-cloud-any-detail.json'));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'no-match' });
});
