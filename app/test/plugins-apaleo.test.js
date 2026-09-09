// Integration tests for the Apaleo recipe (plugins/apaleo.json) against the
// bundled mock (examples/apaleo-mock/server.js). Exercises `auth.basic`
// (Basic auth on the OAuth2 token request) end to end with a real
// (non-stubbed) httpRequest — see app/test/plugins-v3.test.js for the
// engine-level unit test of applyBasicAuth() against a stubbed http.

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
const MOCK_DIR = path.join(REPO_ROOT, 'examples', 'apaleo-mock');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

// Matches examples/apaleo-mock/config.json.
const GOOD_SECRETS = { clientId: 'mock-client-id', clientSecret: 'mock-client-secret' };

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
    child.on('exit', (code) => reject(new Error(`apaleo-mock exited early (code ${code})`)));
    setTimeout(() => reject(new Error('timed out waiting for apaleo-mock to start')), 10000);
  });
});

after(() => {
  if (child && !child.killed) child.kill();
});

async function tokenCallCount() {
  const res = await fetch(`${baseUrl}/healthz`);
  const body = await res.json();
  return body.tokenCalls;
}

function loadRecipe(secrets = GOOD_SECRETS) {
  const wrapper = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'apaleo.json'), 'utf8'));
  assert.equal(wrapper.format, 'tikspot-plugin');
  const recipe = wrapper.recipe;
  recipe.paramValues = { ...recipe.paramValues, baseUrl, identityUrl: baseUrl, propertyId: 'BER' };
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

test('Apaleo: room + surname match -> ok, with a valid credential window', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', last_name: 'Kowalski' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.guest.label, /Kowalski/);
  assert.equal(typeof result.expiresAt, 'string');
});

test('Apaleo: room only -> no-match (minRules requires a second matching detail)', async () => {
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

test('Apaleo: CheckedOut reservation -> no-match (outside the InHouse/Confirmed status filter, so the API never returns it)', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '310', last_name: 'Alves' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'no-match' });
});

test('Apaleo: still-Confirmed reservation whose stay ended 26h ago -> outside-window', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '420', last_name: 'Lund' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside-window');
});

test('Apaleo: wrong client secret -> upstream (Basic auth on /connect/token fails)', async () => {
  const recipe = validate(loadRecipe({ ...GOOD_SECRETS, clientSecret: 'wrong-secret' }));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', last_name: 'Kowalski' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
});

test('Apaleo: token is cached and reused across lookups (/connect/token called once)', async () => {
  const recipe = validate(loadRecipe());
  const tokenCache = makeTokenCache();
  const before_ = await tokenCallCount();

  const first = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', last_name: 'Kowalski' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache,
  });
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', last_name: 'Kowalski' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache,
  });
  assert.equal(second.ok, true, JSON.stringify(second));

  const after_ = await tokenCallCount();
  assert.equal(after_ - before_, 1, 'second lookup should reuse the cached token, not call /connect/token again');
});
