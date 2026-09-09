// Integration tests for the CSV / Google Sheet guest-list recipe
// (plugins/csv-url.json) against a plain static-file server serving
// examples/csv-guest-list/guests.csv (examples/csv-guest-list/serve.js) —
// standing in for a Google Sheet "published to web" as CSV. Exercises
// `parse.type: 'csv'` end to end with a real (non-stubbed) httpRequest; see
// app/test/plugins-v3.test.js for the parser-level unit tests (quoting,
// delimiters, BOM, CRLF, etc).

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
const MOCK_DIR = path.join(REPO_ROOT, 'examples', 'csv-guest-list');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

let child;
let baseUrl;

before(async () => {
  const serverPath = path.join(MOCK_DIR, 'serve.js');
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
    child.on('exit', (code) => reject(new Error(`csv-guest-list serve.js exited early (code ${code})`)));
    setTimeout(() => reject(new Error('timed out waiting for csv-guest-list serve.js to start')), 10000);
  });
});

after(() => {
  if (child && !child.killed) child.kill();
});

function loadRecipe(csvUrl = `${baseUrl}/guests.csv`) {
  const wrapper = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'csv-url.json'), 'utf8'));
  assert.equal(wrapper.format, 'tikspot-plugin');
  const recipe = wrapper.recipe;
  recipe.paramValues = { ...recipe.paramValues, csvUrl };
  recipe.secrets = {};
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

test('CSV guest list: room + surname match -> ok', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '12', last_name: "O'Neill" }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.guest.label, /O.Neill/);
});

test("CSV guest list: a quoted field containing a comma (\"Wren, Jr.\") round-trips correctly", async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '7', last_name: 'Wren, Jr.' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.guest.record.lastName, 'Wren, Jr.');
});

test('CSV guest list: same room, wrong surname -> no-match (two guests share room 12)', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '12', last_name: 'NotARealGuest' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.deepEqual(result, { ok: false, reason: 'no-match' });
});

test('CSV guest list: stay already ended -> outside-window', async () => {
  const recipe = validate(loadRecipe());
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '203', last_name: 'Fischer' }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside-window');
});

test('CSV guest list: unreachable URL -> upstream', async () => {
  const recipe = validate(loadRecipe('http://127.0.0.1:1/no-such-sheet.csv'));
  const result = await runLookup({
    recipe,
    inputs: inputsFor(recipe, { room: '12', last_name: "O'Neill" }),
    now: Date.now(),
    http: httpRequest,
    tokenCache: makeTokenCache(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream');
});
