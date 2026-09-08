// Pure tests for the design model (registry, normalisation), the HTML
// sanitizer, and portal rendering. No better-sqlite3 — these run anywhere with
// just `node --test` (see unit.test.js's header comment for why that matters).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_REGISTRY,
  STYLE_FIELDS,
  THEME_FIELDS,
  blockSpec,
  defaultDesign,
  defaultTheme,
  normalizeDesign,
} from '../src/design/model.js';
import { sanitizeHtml } from '../src/design/sanitize.js';
import { renderPortalPage } from '../src/portal/render.js';
import { renderBlock } from '../src/portal/widgets.js';

const FIELD_KINDS = new Set([
  'text', 'textarea', 'slider', 'color', 'select', 'switch', 'align', 'plan', 'image', 'plugin', 'url', 'note', 'columns',
]);
const BLOCK_KINDS = new Set(['image', 'text', 'login', 'layout', 'action']);
const PAGE_NAMES = new Set(['login', 'status', 'logout']);

// ---------------------------------------------------------------------------
// Registry completeness
test('BLOCK_REGISTRY: every spec has label/icon/kind/pages/defaults/fields with valid field kinds', () => {
  assert.ok(BLOCK_REGISTRY.length >= 12);
  for (const spec of BLOCK_REGISTRY) {
    assert.equal(typeof spec.type, 'string', `${spec.type}: type`);
    assert.equal(typeof spec.label, 'string', `${spec.type}: label`);
    assert.equal(typeof spec.icon, 'string', `${spec.type}: icon`);
    assert.ok(BLOCK_KINDS.has(spec.kind), `${spec.type}: kind "${spec.kind}"`);
    assert.ok(Array.isArray(spec.pages) && spec.pages.length > 0, `${spec.type}: pages`);
    for (const p of spec.pages) assert.ok(PAGE_NAMES.has(p), `${spec.type}: unknown page "${p}"`);
    assert.equal(typeof spec.defaults, 'object', `${spec.type}: defaults`);
    assert.ok(Array.isArray(spec.fields), `${spec.type}: fields`);
    for (const f of spec.fields) {
      assert.equal(typeof f.key, 'string', `${spec.type}.${f.key}: key`);
      assert.ok(FIELD_KINDS.has(f.kind), `${spec.type}.${f.key}: unknown field kind "${f.kind}"`);
      assert.equal(typeof f.label, 'string', `${spec.type}.${f.key}: label`);
    }
  }
  assert.ok(blockSpec('logo'));
  assert.equal(blockSpec('nonexistent'), null);
});

test('login blocks no longer carry a macRemember prop, and expose a read-only note instead', () => {
  for (const type of ['free-login', 'voucher-login', 'userpass-login']) {
    const spec = blockSpec(type);
    assert.equal('macRemember' in spec.defaults, false, `${type} defaults should not include macRemember`);
    const note = spec.fields.find((f) => f.key === 'macRemember');
    assert.ok(note, `${type} should have a macRemember note field`);
    assert.equal(note.kind, 'note');
  }
});

test('BLOCK_REGISTRY includes plugin-login with a plugin-kind field sourced from /api/plugins', () => {
  const spec = blockSpec('plugin-login');
  assert.ok(spec);
  assert.equal(spec.kind, 'login');
  assert.deepEqual(spec.pages, ['login']);
  const pf = spec.fields.find((f) => f.kind === 'plugin');
  assert.ok(pf, 'plugin-login should have a field of kind "plugin"');
  assert.equal(pf.source, '/api/plugins');
});

test('logout-button is scoped to the status page only', () => {
  assert.deepEqual(blockSpec('logout-button').pages, ['status']);
});

test('STYLE_FIELDS and THEME_FIELDS cover the documented knobs', () => {
  const styleKeys = STYLE_FIELDS.map((f) => f.key).sort();
  assert.deepEqual(styleKeys, ['align', 'bg', 'color', 'hidden', 'mb', 'mt']);

  const themeKeys = new Set(THEME_FIELDS.map((f) => f.key));
  for (const k of ['cardBg', 'textColor', 'bgImage', 'buttonStyle', 'logoPosition', 'accent', 'font', 'radius', 'width']) {
    assert.ok(themeKeys.has(k), `THEME_FIELDS missing ${k}`);
  }
  const theme = defaultTheme();
  assert.equal(theme.cardBg, '#ffffff');
  assert.equal(theme.buttonStyle, 'solid');
});

// ---------------------------------------------------------------------------
// normalizeDesign
test('normalizeDesign drops unknown block types', () => {
  const d = normalizeDesign({ blocks: [{ id: 'a', type: 'bogus', props: {} }, { id: 'b', type: 'heading', props: { text: 'hi' } }] });
  assert.equal(d.blocks.length, 1);
  assert.equal(d.blocks[0].type, 'heading');
});

test('normalizeDesign refuses columns nested inside columns (one nesting level only)', () => {
  const d = normalizeDesign({
    blocks: [
      {
        id: 'c1',
        type: 'columns',
        props: {
          left: [{ id: 'nested', type: 'columns', props: { left: [], right: [] } }, { id: 't', type: 'text', props: { text: 'ok' } }],
          right: [],
        },
      },
    ],
  });
  assert.equal(d.blocks.length, 1);
  assert.equal(d.blocks[0].type, 'columns');
  assert.equal(d.blocks[0].props.left.length, 1); // the nested columns block was dropped
  assert.equal(d.blocks[0].props.left[0].type, 'text');
});

test('normalizeDesign fills style defaults and strips unknown props (e.g. dead macRemember)', () => {
  const d = normalizeDesign({
    blocks: [{ id: 'f', type: 'free-login', props: { label: 'Go', plan: 'free', macRemember: true } }],
  });
  const block = d.blocks[0];
  assert.equal(block.props.macRemember, undefined);
  assert.deepEqual(block.props.style, { mt: 0, mb: 0, color: '', bg: '', align: '', hidden: false });
});

test('normalizeDesign supplies default status/logout pages when absent, and normalises provided ones', () => {
  const d = normalizeDesign({ blocks: [] });
  assert.ok(d.pages.status.some((b) => b.type === 'logout-button'));
  assert.ok(d.pages.logout.some((b) => b.type === 'heading'));

  const d2 = normalizeDesign({ blocks: [], pages: { status: [{ id: 's', type: 'bogus' }] } });
  assert.deepEqual(d2.pages.status, []);
});

test('normalizeDesign(null) returns a full default design', () => {
  const d = normalizeDesign(null);
  const def = defaultDesign();
  assert.equal(d.blocks.length, def.blocks.length);
  assert.equal(d.theme.accent, def.theme.accent);
});

test('normalizeDesign sanitises html blocks', () => {
  const d = normalizeDesign({ blocks: [{ id: 'h', type: 'html', props: { html: '<p>hi</p><script>bad()</script>' } }] });
  assert.equal(d.blocks[0].props.html, '<p>hi</p>');
});

test('normalizeDesign rejects a non-http(s) button-link url', () => {
  const d = normalizeDesign({ blocks: [{ id: 'b', type: 'button-link', props: { url: 'javascript:alert(1)' } }] });
  assert.equal(d.blocks[0].props.url, '');
});

// ---------------------------------------------------------------------------
// sanitizeHtml
test('sanitizeHtml strips script tags and their content', () => {
  assert.equal(sanitizeHtml('<p>hi</p><script>alert(1)</script>'), '<p>hi</p>');
});

test('sanitizeHtml strips onclick and other event-handler attributes', () => {
  assert.equal(sanitizeHtml('<div onclick="evil()">hi</div>'), '<div>hi</div>');
});

test('sanitizeHtml strips a javascript: href but keeps the tag/text', () => {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">click</a>'), '<a>click</a>');
});

test('sanitizeHtml keeps allowed tags/attrs as-is', () => {
  const input = '<p>Hello <b>world</b> <a href="https://example.com" title="x">link</a></p>';
  assert.equal(sanitizeHtml(input), input);
});

test('sanitizeHtml allows data:image img src but not other data: URLs', () => {
  assert.equal(
    sanitizeHtml('<img src="data:image/png;base64,AAAA">'),
    '<img src="data:image/png;base64,AAAA">',
  );
  assert.equal(sanitizeHtml('<a href="data:text/html,evil">x</a>'), '<a>x</a>');
});

test('sanitizeHtml removes iframe/style/form entirely, with their content', () => {
  assert.equal(sanitizeHtml('<iframe src="evil"></iframe><p>ok</p>'), '<p>ok</p>');
  assert.equal(sanitizeHtml('<style>body{}</style><p>ok</p>'), '<p>ok</p>');
  assert.equal(sanitizeHtml('<form><input name=x></form><p>ok</p>'), '<p>ok</p>');
});

// ---------------------------------------------------------------------------
// renderPortalPage
test('renderPortalPage emits the CSP meta tag, a data-tikspot body attribute, and no inline TIKSPOT script', () => {
  const html = renderPortalPage(defaultDesign(), { linkLogin: 'http://router/login' });
  assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
  assert.match(html, /<body data-tikspot="/);
  assert.doesNotMatch(html, /window\.TIKSPOT\s*=/);
  assert.match(html, /<script src="\/m\/portal\.js">/);
});

test('renderPortalPage renders columns, terms-checkbox, button-link and divider', () => {
  const design = normalizeDesign({
    blocks: [
      { id: 'bl', type: 'button-link', props: { label: 'Go', url: 'https://example.com', style: 'outline' } },
      { id: 'dv', type: 'divider', props: {} },
      { id: 'tc', type: 'terms-checkbox', props: { text: 'I agree', url: 'https://example.com/terms', required: true } },
      {
        id: 'cols',
        type: 'columns',
        props: { left: [{ id: 'l1', type: 'text', props: { text: 'left side' } }], right: [{ id: 'r1', type: 'text', props: { text: 'right side' } }] },
      },
    ],
  });
  const html = renderPortalPage(design, {});
  assert.match(html, /cp-btn--outline/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /<hr class="cp-divider">/);
  assert.match(html, /data-tk-terms required/);
  assert.match(html, /cp-cols/);
  assert.match(html, /left side/);
  assert.match(html, /right side/);
});

test('every rendered block (including nested columns children) carries data-block-id', () => {
  const design = normalizeDesign({
    blocks: [
      { id: 'top-heading', type: 'heading', props: { text: 'hi' } },
      {
        id: 'cols',
        type: 'columns',
        props: {
          left: [{ id: 'nested-text', type: 'text', props: { text: 'left side' } }],
          right: [],
        },
      },
    ],
  });
  const html = renderPortalPage(design, {});
  assert.match(html, /data-block-id="top-heading"/);
  assert.match(html, /data-block-id="cols"/);
  assert.match(html, /data-block-id="nested-text"/);
});

test('the status page renders a logout-button form posting to ctx.linkLogout', () => {
  const html = renderPortalPage(defaultDesign(), { page: 'status', linkLogout: 'http://router/logout' });
  assert.match(html, /action="http:\/\/router\/logout"/);
  assert.match(html, /You&#39;re connected|You're connected/);
});

test('free-login for a non-free plan uses ctx.freeCreds, not the shared FREE_USERNAME', () => {
  const design = normalizeDesign({ blocks: [{ id: 'f', type: 'free-login', props: { label: 'Go', plan: 'staff' } }] });
  const html = renderPortalPage(design, { freeCreds: { staff: 'sekret123456789' } });
  assert.match(html, /value="free-staff"/);
  assert.match(html, /value="sekret123456789"/);
});

test('plugin-login renders a lookup form with the plugin recipe inputs, posting to /portal/lookup/<id>', () => {
  const block = { id: 'pl', type: 'plugin-login', props: { label: 'Continue', pluginId: '3', intro: 'Enter your stay details' } };
  const ctx = {
    plugins: {
      3: {
        id: 3,
        name: 'Hotel',
        enabled: true,
        inputs: [
          { name: 'room', label: 'Room number', type: 'text', required: true },
          { name: 'name', label: 'Last name', type: 'text', required: true },
        ],
      },
    },
    mac: 'AA:BB:CC:DD:EE:FF',
  };
  const html = renderBlock(block, ctx);
  assert.match(html, /action="\/portal\/lookup\/3"/);
  assert.match(html, /data-tikspot-lookup/);
  assert.match(html, /name="in_room"/);
  assert.match(html, / required/);
  assert.match(html, /name="in_name"/);
  assert.match(html, /Enter your stay details/);
  assert.match(html, /name="mac" value="AA:BB:CC:DD:EE:FF"/);
});

test('plugin-login with a missing/disabled plugin renders nothing live, a muted note in preview', () => {
  const block = { id: 'pl', type: 'plugin-login', props: { label: 'Continue', pluginId: 'missing' } };
  assert.equal(renderBlock(block, { plugins: {} }), '');
  assert.match(renderBlock(block, { plugins: {}, preview: true }), /not configured/);

  const disabledCtx = { plugins: { 5: { id: 5, name: 'Hotel', enabled: false, inputs: [] } } };
  assert.equal(renderBlock({ id: 'pl2', type: 'plugin-login', props: { pluginId: '5' } }, disabledCtx), '');
});

test('a block with style.hidden is skipped on the live page but kept (dimmed) in preview', () => {
  const hiddenBlock = { id: 'h', type: 'text', props: { text: 'secret', style: { hidden: true } } };
  const live = renderBlock(hiddenBlock, { preview: false });
  assert.equal(live, '');
  const preview = renderBlock(hiddenBlock, { preview: true });
  assert.match(preview, /data-hidden="1"/);
  assert.match(preview, /secret/);
});
