// Starter templates offered when creating a new design. Each is a complete
// `{key, name, description, design}` — `design` is fed straight through
// normalizeDesign() (createDesign() does this), so it need not specify
// `pages` (the default status/logout pages are filled in) and any block
// field it omits falls back to that block's registry default.

import { defaultTheme, STYLE_DEFAULTS, blockSpec } from './model.js';

function b(type, props = {}, style = {}) {
  const spec = blockSpec(type);
  const base = type === 'columns' ? { left: [], right: [] } : { ...(spec?.defaults || {}) };
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    props: { ...base, ...props, style: { ...STYLE_DEFAULTS, ...style } },
  };
}

function theme(overrides) {
  return { ...defaultTheme(), ...overrides };
}

const hotel = {
  key: 'hotel',
  name: 'Hotel',
  description: 'Elegant, dark blue theme with a room/name login for guests.',
  design: {
    theme: theme({
      pageBg: '#10243A',
      pageBg2: '#1B1430',
      accent: '#9C7BFF',
      font: 'Georgia',
      buttonStyle: 'pill',
      radius: 14,
    }),
    blocks: [
      b('logo', { text: 'The Harbourview Hotel', width: 170 }),
      b('heading', { text: 'Welcome, guest' }),
      b(
        'text',
        {
          text: 'Complimentary Wi‑Fi for registered guests. Enter your room number and surname to connect.',
        },
      ),
      // Placeholder until the 0.13 guest-lookup plugin ships a dedicated
      // room/reservation block — an account-style login stands in for now.
      b('userpass-login', { label: 'Connect', userPlaceholder: 'Room number', passPlaceholder: 'Surname' }),
      b('text', { text: 'Guest lookup by reservation arrives in a future update.', muted: true }),
      b('divider'),
      b('voucher-login', { label: 'Staff / event voucher', placeholder: 'Voucher code' }),
      b('text', { text: 'Powered by Tikspot', align: 'center', muted: true }),
    ],
  },
};

const cafe = {
  key: 'cafe',
  name: 'Café',
  description: 'Warm, friendly theme with a one-tap free connect.',
  design: {
    theme: theme({
      pageBg: '#2A1020',
      pageBg2: '#F5B544',
      accent: '#F5B544',
      font: 'Inter',
      buttonStyle: 'solid',
      radius: 12,
    }),
    blocks: [
      b('logo', { text: 'Corner Bean Café' }),
      b('heading', { text: 'Welcome — grab a seat' }),
      b('text', { text: 'Free Wi‑Fi while you enjoy your coffee. Tap below to get connected.' }),
      b('terms-checkbox', { text: 'I agree to the Wi‑Fi usage policy', url: '' }),
      b('free-login', { label: 'Connect for free' }),
      b('text', { text: 'Ask a barista if you need a hand.', align: 'center', muted: true }),
    ],
  },
};

const event = {
  key: 'event',
  name: 'Event',
  description: 'Bold theme for a conference or venue with access-code login.',
  design: {
    theme: theme({
      pageBg: '#0A0D12',
      pageBg2: '#E85B9E',
      accent: '#E85B9E',
      font: 'IBM Plex Sans',
      buttonStyle: 'outline',
      radius: 8,
    }),
    blocks: [
      b('logo', { text: 'CONNECT 2026' }),
      b('heading', { text: "You're at CONNECT 2026" }),
      b('text', { text: 'Enter the access code from your badge to join the event Wi‑Fi.' }),
      b('voucher-login', { label: 'Join the network', placeholder: 'Access code' }),
      b('divider'),
      b('button-link', { label: 'View the schedule', url: 'https://example.com/schedule', style: 'outline' }),
      b('text', { text: 'Powered by Tikspot', align: 'center', muted: true }),
    ],
  },
};

const minimal = {
  key: 'minimal',
  name: 'Minimal',
  description: 'Plain, no-frills page: a heading and a single free-connect button.',
  design: {
    theme: theme({
      pageBg: '#0E2233',
      pageBg2: '#2F8CEE',
      accent: '#2F8CEE',
      font: 'system-ui',
      buttonStyle: 'solid',
      radius: 10,
    }),
    blocks: [
      b('heading', { text: 'Connect' }),
      b('free-login', { label: 'Connect' }),
      b('spacer', { size: 8 }),
      b('text', { text: 'Powered by Tikspot', align: 'center', muted: true }),
    ],
  },
};

export const TEMPLATES = [hotel, cafe, event, minimal];
