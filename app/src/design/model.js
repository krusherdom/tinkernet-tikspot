// The captive-portal design model. A design = a theme + an ordered list of
// blocks for the login page, plus per-page block lists for the post-login
// status page and the logout page. This is the single source of truth for
// what block types exist, their fields and defaults — the editor renders its
// property panels from BLOCK_REGISTRY/STYLE_FIELDS/THEME_FIELDS (served over
// GET /api/blocks) instead of duplicating the list client-side, and both the
// live portal (portal/widgets.js) and the editor canvas render from the same
// model, so what you design is exactly what guests see.

import { sanitizeHtml } from './sanitize.js';

export const FONTS = ['Helvetica', 'Inter', 'Verdana', 'IBM Plex Sans', 'Georgia', 'system-ui'];
export const ACCENTS = ['#2F8CEE', '#1761B0', '#E85B9E', '#ADE84F', '#F5B544', '#9C7BFF'];
export const PAGE_BGS = ['#0E2233', '#0A0D12', '#10243A', '#1B1430', '#0C3C37', '#2A1020'];

export const PAGES = ['login', 'status', 'logout'];

// Common per-block style knobs (props.style on every block). Rendered by
// styleAttrs() in portal/widgets.js.
export const STYLE_DEFAULTS = { mt: 0, mb: 0, color: '', bg: '', align: '', hidden: false };

export const STYLE_FIELDS = [
  { key: 'mt', kind: 'slider', label: 'Space above', min: 0, max: 64, step: 2, unit: 'px' },
  { key: 'mb', kind: 'slider', label: 'Space below', min: 0, max: 64, step: 2, unit: 'px' },
  { key: 'color', kind: 'color', label: 'Text colour' },
  { key: 'bg', kind: 'color', label: 'Background' },
  { key: 'align', kind: 'align', label: 'Alignment' },
  { key: 'hidden', kind: 'switch', label: 'Hidden', hint: 'Kept in the design but not shown on the live page.' },
];

// A read-only note shown where the old per-block "remember this device" toggle
// used to live — MAC re-auth is now a per-plan setting, not per-block.
const MAC_REMEMBER_NOTE = {
  key: 'macRemember',
  kind: 'note',
  label: 'Remember device (MAC)',
  text: 'Controlled by the selected plan, not here — edit the plan to change MAC re-auth.',
};

// The block registry: every block type the editor offers and the portal can
// render. `kind` is a coarse category for the editor's block picker; `pages`
// lists which page(s) a block type may be used on.
export const BLOCK_REGISTRY = [
  {
    type: 'logo',
    label: 'Logo / image',
    icon: 'image',
    kind: 'image',
    pages: ['login', 'status', 'logout'],
    defaults: { src: '', text: 'Welcome', width: 150, alt: 'logo' },
    fields: [
      { key: 'src', kind: 'image', label: 'Image' },
      { key: 'text', kind: 'text', label: 'Fallback text', hint: 'Shown when no image is set.' },
      { key: 'width', kind: 'slider', label: 'Width', min: 40, max: 400, step: 5, unit: 'px' },
      { key: 'alt', kind: 'text', label: 'Alt text' },
    ],
  },
  {
    type: 'heading',
    label: 'Heading',
    icon: 'heading',
    kind: 'text',
    pages: ['login', 'status', 'logout'],
    defaults: { text: 'Connect to our Wi‑Fi', size: 24, align: 'center' },
    fields: [
      { key: 'text', kind: 'text', label: 'Text' },
      { key: 'size', kind: 'slider', label: 'Font size', min: 14, max: 48, step: 1, unit: 'px' },
      { key: 'align', kind: 'align', label: 'Alignment' },
    ],
  },
  {
    type: 'text',
    label: 'Paragraph',
    icon: 'type',
    kind: 'text',
    pages: ['login', 'status', 'logout'],
    defaults: { text: 'Tap a button below to get online.', align: 'center', muted: false },
    fields: [
      { key: 'text', kind: 'textarea', label: 'Text' },
      { key: 'align', kind: 'align', label: 'Alignment' },
      { key: 'muted', kind: 'switch', label: 'Muted (smaller, lighter)' },
    ],
  },
  {
    type: 'free-login',
    label: 'Free login',
    icon: 'zap',
    kind: 'login',
    pages: ['login'],
    defaults: { label: 'Connect for free', plan: 'free' },
    fields: [
      { key: 'label', kind: 'text', label: 'Button label' },
      { key: 'plan', kind: 'plan', label: 'Plan', hint: 'Which plan (RADIUS group) this button grants.', source: '/api/plans' },
      MAC_REMEMBER_NOTE,
    ],
  },
  {
    type: 'voucher-login',
    label: 'Voucher login',
    icon: 'ticket',
    kind: 'login',
    pages: ['login'],
    defaults: { label: 'Use voucher', placeholder: 'Enter voucher code' },
    fields: [
      { key: 'label', kind: 'text', label: 'Button label' },
      { key: 'placeholder', kind: 'text', label: 'Field placeholder' },
      MAC_REMEMBER_NOTE,
    ],
  },
  {
    type: 'userpass-login',
    label: 'Account login',
    icon: 'user',
    kind: 'login',
    pages: ['login'],
    defaults: { label: 'Log in', userPlaceholder: 'Username', passPlaceholder: 'Password' },
    fields: [
      { key: 'label', kind: 'text', label: 'Button label' },
      { key: 'userPlaceholder', kind: 'text', label: 'Username placeholder' },
      { key: 'passPlaceholder', kind: 'text', label: 'Password placeholder' },
      MAC_REMEMBER_NOTE,
    ],
  },
  {
    type: 'plugin-login',
    label: 'Guest lookup login',
    icon: 'search',
    kind: 'login',
    pages: ['login'],
    defaults: { label: 'Continue', pluginId: '', intro: '' },
    fields: [
      { key: 'pluginId', kind: 'plugin', label: 'Lookup plugin', source: '/api/plugins', hint: 'Which guest-lookup plugin (recipe) this form uses.' },
      { key: 'label', kind: 'text', label: 'Button text' },
      { key: 'intro', kind: 'textarea', label: 'Intro text', hint: 'Optional short text shown above the fields.' },
      {
        key: 'pluginInputsNote',
        kind: 'note',
        label: 'Form fields',
        text: 'The fields shown to guests (room, name, ...) come from the selected plugin — edit them on the Plugins page.',
      },
    ],
  },
  {
    type: 'spacer',
    label: 'Spacer',
    icon: 'move-vertical',
    kind: 'layout',
    pages: ['login', 'status', 'logout'],
    defaults: { size: 16 },
    fields: [{ key: 'size', kind: 'slider', label: 'Height', min: 4, max: 96, step: 2, unit: 'px' }],
  },
  {
    type: 'button-link',
    label: 'Button link',
    icon: 'link',
    kind: 'action',
    pages: ['login', 'status', 'logout'],
    defaults: { label: 'Learn more', url: 'https://', style: 'solid' },
    fields: [
      { key: 'label', kind: 'text', label: 'Label' },
      { key: 'url', kind: 'url', label: 'Link URL', hint: 'Must be http(s).' },
      {
        key: 'style',
        kind: 'select',
        label: 'Style',
        options: [
          { value: 'solid', label: 'Solid' },
          { value: 'outline', label: 'Outline' },
        ],
      },
    ],
  },
  {
    type: 'divider',
    label: 'Divider',
    icon: 'minus',
    kind: 'layout',
    pages: ['login', 'status', 'logout'],
    defaults: {},
    fields: [],
  },
  {
    type: 'terms-checkbox',
    label: 'Terms checkbox',
    icon: 'check-square',
    kind: 'action',
    pages: ['login'],
    defaults: { text: 'I agree to the terms of use', url: '', required: true },
    fields: [
      { key: 'text', kind: 'text', label: 'Label text' },
      { key: 'url', kind: 'url', label: 'Terms link (optional)' },
      { key: 'required', kind: 'switch', label: 'Required before login', hint: 'Login buttons stay disabled until this is ticked.' },
    ],
  },
  {
    type: 'columns',
    label: 'Columns',
    icon: 'columns',
    kind: 'layout',
    pages: ['login', 'status', 'logout'],
    defaults: { left: [], right: [] },
    fields: [
      { key: 'left', kind: 'columns', label: 'Left column' },
      { key: 'right', kind: 'columns', label: 'Right column' },
    ],
  },
  {
    type: 'html',
    label: 'Custom HTML',
    icon: 'code',
    kind: 'text',
    pages: ['login', 'status', 'logout'],
    defaults: { html: '' },
    fields: [
      {
        key: 'html',
        kind: 'textarea',
        label: 'HTML',
        hint: 'Sanitised on save: scripts, styles, forms and event handlers are stripped.',
      },
    ],
  },
  {
    type: 'logout-button',
    label: 'Log out button',
    icon: 'log-out',
    kind: 'action',
    pages: ['status'],
    defaults: { label: 'Log out' },
    fields: [{ key: 'label', kind: 'text', label: 'Button label' }],
  },
];

const REGISTRY_BY_TYPE = new Map(BLOCK_REGISTRY.map((s) => [s.type, s]));

export function blockSpec(type) {
  return REGISTRY_BY_TYPE.get(type) || null;
}

export const BLOCK_TYPES = BLOCK_REGISTRY.map((s) => s.type);
const BLOCK_TYPE_SET = new Set(BLOCK_TYPES);
export const LOGIN_TYPES = new Set(BLOCK_REGISTRY.filter((s) => s.kind === 'login').map((s) => s.type));

// Theme: page background gradient, card look, accent, font, button shape and
// logo alignment. THEME_FIELDS describes each knob for the editor, like a
// block's `fields`.
export function defaultTheme() {
  return {
    pageBg: '#0E2233',
    pageBg2: '#2F8CEE',
    accent: '#2F8CEE',
    radius: 10,
    width: 420,
    font: 'Helvetica',
    cardBg: '#ffffff',
    textColor: '#0f172a',
    bgImage: '',
    buttonStyle: 'solid',
    logoPosition: 'center',
  };
}

const THEME_KEYS = Object.keys(defaultTheme());

export const THEME_FIELDS = [
  { key: 'pageBg', kind: 'color', label: 'Page background (top)' },
  { key: 'pageBg2', kind: 'color', label: 'Page background (glow)' },
  { key: 'bgImage', kind: 'image', label: 'Page background image', hint: 'Optional — layered over the gradient.' },
  { key: 'cardBg', kind: 'color', label: 'Card background' },
  { key: 'textColor', kind: 'color', label: 'Text colour' },
  { key: 'accent', kind: 'color', label: 'Accent colour' },
  { key: 'radius', kind: 'slider', label: 'Corner radius', min: 0, max: 24, step: 1, unit: 'px' },
  { key: 'width', kind: 'slider', label: 'Card width', min: 320, max: 560, step: 10, unit: 'px' },
  { key: 'font', kind: 'select', label: 'Font', options: FONTS.map((f) => ({ value: f, label: f })) },
  {
    key: 'buttonStyle',
    kind: 'select',
    label: 'Button style',
    options: [
      { value: 'solid', label: 'Solid' },
      { value: 'outline', label: 'Outline' },
      { value: 'pill', label: 'Pill' },
    ],
  },
  {
    key: 'logoPosition',
    kind: 'select',
    label: 'Logo position',
    options: [
      { value: 'center', label: 'Center' },
      { value: 'left', label: 'Left' },
    ],
  },
];

function clampNum(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normalizeStyle(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    mt: clampNum(r.mt, STYLE_DEFAULTS.mt, 0, 64),
    mb: clampNum(r.mb, STYLE_DEFAULTS.mb, 0, 64),
    color: typeof r.color === 'string' ? r.color : STYLE_DEFAULTS.color,
    bg: typeof r.bg === 'string' ? r.bg : STYLE_DEFAULTS.bg,
    align: ['left', 'center', 'right'].includes(r.align) ? r.align : STYLE_DEFAULTS.align,
    hidden: r.hidden === true,
  };
}

function normalizeTheme(raw) {
  const base = defaultTheme();
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...base };
  for (const key of THEME_KEYS) {
    if (key in r) out[key] = r[key];
  }
  return out;
}

// Merge incoming props onto a block's spec defaults, keeping only known keys
// (this is what makes a dead prop like the old per-block `macRemember` actually
// go away instead of round-tripping forever) plus the common style block.
function normalizeProps(type, rawProps) {
  const spec = blockSpec(type);
  const defaults = spec?.defaults || {};
  const raw = rawProps && typeof rawProps === 'object' ? rawProps : {};
  const props = {};
  for (const key of Object.keys(defaults)) {
    props[key] = key in raw ? raw[key] : defaults[key];
  }
  if (type === 'html') {
    props.html = sanitizeHtml(String(props.html ?? ''));
  }
  if (type === 'button-link') {
    const u = String(props.url ?? '').trim();
    props.url = /^https?:\/\//i.test(u) ? u : '';
  }
  props.style = normalizeStyle(raw.style);
  return props;
}

function randomId(prefix, i) {
  return `${prefix}${i}-${Math.random().toString(36).slice(2, 8)}`;
}

// depth 0 = top level; columns are only allowed at depth 0 (one nesting level:
// a column's own children may not themselves be `columns`).
function normalizeBlock(raw, i, depth) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type;
  if (!BLOCK_TYPE_SET.has(type)) return null;
  if (type === 'columns' && depth > 0) return null;
  const id = String(raw.id || randomId('b', i));
  if (type === 'columns') {
    const rawProps = raw.props && typeof raw.props === 'object' ? raw.props : {};
    return {
      id,
      type,
      props: {
        left: normalizeBlockList(rawProps.left, depth + 1),
        right: normalizeBlockList(rawProps.right, depth + 1),
        style: normalizeStyle(rawProps.style),
      },
    };
  }
  return { id, type, props: normalizeProps(type, raw.props) };
}

export function normalizeBlockList(list, depth = 0) {
  if (!Array.isArray(list)) return [];
  return list.map((b, i) => normalizeBlock(b, i, depth)).filter(Boolean);
}

let counter = 0;
export function newBlock(type, idSeed) {
  const id = 'b' + (idSeed ?? `${Date.now().toString(36)}${(counter++).toString(36)}`);
  const spec = blockSpec(type);
  const defaults = spec?.defaults || {};
  const props = type === 'columns' ? { left: [], right: [] } : { ...defaults };
  props.style = { ...STYLE_DEFAULTS };
  return { id, type, props };
}

function defaultStatusBlocks() {
  return [
    { id: 'status-head', type: 'heading', props: { ...blockSpec('heading').defaults, text: "You're connected", style: { ...STYLE_DEFAULTS } } },
    {
      id: 'status-text',
      type: 'text',
      props: { ...blockSpec('text').defaults, text: 'Enjoy the Wi‑Fi — you can close this page.', style: { ...STYLE_DEFAULTS } },
    },
    { id: 'status-logout', type: 'logout-button', props: { ...blockSpec('logout-button').defaults, style: { ...STYLE_DEFAULTS } } },
  ];
}

function defaultLogoutBlocks() {
  return [
    { id: 'logout-head', type: 'heading', props: { ...blockSpec('heading').defaults, text: "You're logged out", style: { ...STYLE_DEFAULTS } } },
    {
      id: 'logout-text',
      type: 'text',
      props: { ...blockSpec('text').defaults, text: 'Reconnect any time from the Wi‑Fi page.', style: { ...STYLE_DEFAULTS } },
    },
  ];
}

// The starter template — a polished, ready-to-use page so the editor (and
// /login) never open empty.
export function defaultDesign() {
  return {
    theme: defaultTheme(),
    blocks: [
      { id: 'b-logo', type: 'logo', props: { src: '', text: 'Our Wi‑Fi', width: 150, alt: 'logo', style: { ...STYLE_DEFAULTS } } },
      {
        id: 'b-head',
        type: 'heading',
        props: { text: 'Welcome — get connected', size: 24, align: 'center', style: { ...STYLE_DEFAULTS } },
      },
      {
        id: 'b-intro',
        type: 'text',
        props: { text: 'Choose how you’d like to get online.', align: 'center', muted: false, style: { ...STYLE_DEFAULTS } },
      },
      { id: 'b-free', type: 'free-login', props: { label: 'Connect for free', plan: 'free', style: { ...STYLE_DEFAULTS } } },
      {
        id: 'b-vouch',
        type: 'voucher-login',
        props: { label: 'Use a voucher', placeholder: 'Enter voucher code', style: { ...STYLE_DEFAULTS } },
      },
      { id: 'b-foot', type: 'text', props: { text: 'Powered by Tikspot', align: 'center', muted: true, style: { ...STYLE_DEFAULTS } } },
    ],
    pages: { status: defaultStatusBlocks(), logout: defaultLogoutBlocks() },
  };
}

// Validate/normalise a model coming from the editor or the DB. Unknown block
// types are dropped; a `columns` block nested inside another `columns` is
// dropped (one nesting level only); every block gets its style defaults
// filled in; `html` block content is sanitised.
export function normalizeDesign(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const theme = normalizeTheme(src.theme);
  const blocks = Array.isArray(src.blocks) ? normalizeBlockList(src.blocks, 0) : defaultDesign().blocks;
  const pagesSrc = src.pages && typeof src.pages === 'object' ? src.pages : {};
  const status = Array.isArray(pagesSrc.status) ? normalizeBlockList(pagesSrc.status, 0) : defaultStatusBlocks();
  const logout = Array.isArray(pagesSrc.logout) ? normalizeBlockList(pagesSrc.logout, 0) : defaultLogoutBlocks();
  return { theme, blocks, pages: { status, logout } };
}

// Pick the block list for a given page name off a normalised design.
export function pageBlocks(design, page) {
  if (page === 'status') return design.pages?.status ?? [];
  if (page === 'logout') return design.pages?.logout ?? [];
  return design.blocks ?? [];
}
