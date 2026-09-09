// Integration tests for the Cloudbeds recipe (plugins/cloudbeds.json) against
// the bundled mock (examples/cloudbeds-mock/server.js). Exercises the
// `data[*].guestList[*]` wildcard parse root (fanning out over a JSON object,
// not just an array) with a real (non-stubbed) httpRequest.

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
const MOCK_DIR = path.join(REPO_ROOT, 'examples', 'cloudbeds-mock');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

// Matches examples/cloudbeds-mock/config.json.
const GOOD_SECRETS = { apiKey: 'mock-cloudbeds-api-key' };

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
    child.on('exit', (code) => reject(new Error(`cloudbeds-mock exited early (code ${code})`)));
    setTimeout(() => reject(new Error('timed out waiting for cloudbeds-mock to start')), 10000);
  });
});

after(() => {
  if (child && !child.killed) child.kill();
});

function loadRecipe(secrets = GOOD_SECRETS) {
  const wrapper = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'cloudbeds.json'), 'utf8'));
  assert.equal(wrapper.format, 'tikspot-plugin');
  const recipe = wrapper.recipe;
  recipe.paramValues = { ...recipe.paramValues, baseUrl: baseUrl + '/api/v1.3', propertyId: '12345' };
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

test('Cloudbeds: room + surname match -> ok (main guest)', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', last_name: 'Shah' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.guest.label, /Shah/);
});

test('Cloudbeds: room + mobile match -> ok (secondary guest sharing the room, via anyOf mobile/phone)', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '205', mobile: '+353 1 000 0003' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.guest.label, /Maeve Fitzgerald/);
});

test('Cloudbeds: confirmed-but-not-checked-in guest -> no-match (status=checked_in filter excludes it)', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '310', last_name: 'Haddad' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'no-match' });
});

test('Cloudbeds: room only -> no-match (minRules requires a second matching detail)', async () => {
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

test('Cloudbeds: wrong API key -> upstream (mock returns Cloudbeds\' own { success:false, message } envelope)', async () => {
  const recipe = validate(loadRecipe({ apiKey: 'wrong-key' }));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '101', last_name: 'Shah' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
});
