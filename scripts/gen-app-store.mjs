// Regenerates deploy/app-store.yml (a one-element YAML array — the shape RouterOS expects
// from a custom App store URL) from deploy/tikspot.app.yml, so the two never drift.
//
//   node scripts/gen-app-store.mjs
import fs from 'node:fs';

const manifestUrl = new URL('../deploy/tikspot.app.yml', import.meta.url);
const storeUrl = new URL('../deploy/app-store.yml', import.meta.url);

const src = fs.readFileSync(manifestUrl, 'utf8').replace(/\r\n/g, '\n').split('\n');
const start = src.findIndex((l) => l.startsWith('name: '));
if (start === -1) throw new Error('tikspot.app.yml: no top-level "name:" key found');
const body = src.slice(start);
while (body.length && body[body.length - 1] === '') body.pop();

const header = [
  '# Tikspot custom App store for RouterOS 7.22+ — GENERATED from tikspot.app.yml',
  '# (regenerate with: node scripts/gen-app-store.mjs). Point a router at the raw URL of this',
  '# file to list Tikspot in its App list:',
  '#',
  '#   /app/settings set app-store-urls="https://raw.githubusercontent.com/krusherdom/tinkernet-tikspot/main/deploy/app-store.yml"',
  '#',
  '# then enable and configure it like any other App (see docs/deploy-app.md).',
  '',
];

// First key gets the "- " list marker; everything else is indented two spaces.
const out = [...header, ...body.map((l, i) => (i === 0 ? `- ${l}` : l === '' ? '' : `  ${l}`)), ''];
fs.writeFileSync(storeUrl, out.join('\n'));
console.log('wrote deploy/app-store.yml');
