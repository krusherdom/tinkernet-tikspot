// Server-side block renderer: design-model block -> portal HTML (cp- classes).
// Login blocks render as real <form>s posting to the router's link-login; other
// blocks render directly. The editor renders a close visual mirror client-side;
// both share portal.css so they look identical.

import { FREE_USERNAME, FREE_PASSWORD } from '../config.js';
import { sanitizeHtml } from '../design/sanitize.js';

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const alignClass = (a) => `cp-al-${a === 'left' || a === 'right' ? a : 'center'}`;

function routerFields(ctx) {
  return (
    `<input type="hidden" name="dst" value="${esc(ctx.dst ?? '')}">` +
    `<input type="hidden" name="popup" value="true">`
  );
}

function loginForm(ctx, inner) {
  const action = ctx.preview ? '#' : esc(ctx.linkLogin ?? '');
  return (
    `<form class="cp-form" data-tikspot-login method="post" action="${action}">` +
    inner +
    routerFields(ctx) +
    `</form>`
  );
}

// SVG icons used inside input fields (inline so the portal needs no icon CDN).
const ICO = {
  user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  ticket: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v14"/></svg>',
};

function field(icon, inputHtml) {
  return `<div class="cp-field"><span class="cp-field__ico">${ICO[icon] || ''}</span>${inputHtml}</div>`;
}

// Render props.style (mt/mb/color/bg/align/hidden) into a wrapper class+style.
// `hidden` blocks render nothing on the live page but stay visible (dimmed) in
// the editor preview, via data-hidden, so the editor can still select them.
export function styleAttrs(style, ctx = {}) {
  const s = style || {};
  const decls = [];
  if (s.mt) decls.push(`margin-top:${Number(s.mt) || 0}px`);
  if (s.mb) decls.push(`margin-bottom:${Number(s.mb) || 0}px`);
  if (s.color) decls.push(`color:${s.color}`);
  if (s.bg) decls.push(`background:${s.bg}`);
  if (s.align === 'left' || s.align === 'right' || s.align === 'center') decls.push(`text-align:${s.align}`);
  const cls = ['cp-block'];
  if (s.hidden && ctx.preview) cls.push('cp-block--hidden');
  return {
    hidden: Boolean(s.hidden),
    skip: Boolean(s.hidden) && !ctx.preview,
    cls: cls.join(' '),
    style: decls.join(';'),
  };
}

function wrap(inner, block, ctx) {
  const sa = styleAttrs(block.props?.style, ctx);
  if (sa.skip) return '';
  const dataHidden = sa.hidden ? ' data-hidden="1"' : '';
  const styleAttr = sa.style ? ` style="${esc(sa.style)}"` : '';
  const dataBlockId = ` data-block-id="${esc(block.id)}"`;
  return `<div class="${sa.cls}"${dataBlockId}${dataHidden}${styleAttr}>${inner}</div>`;
}

const RENDERERS = {
  logo(p) {
    if (p.src) {
      const w = p.width ? ` style="max-width:${esc(p.width)}px"` : '';
      return `<div class="cp-logo"><img src="${esc(p.src)}" alt="${esc(p.alt || 'logo')}"${w}></div>`;
    }
    return p.text ? `<div class="cp-logo"><span class="cp-logo__txt">${esc(p.text)}</span></div>` : '';
  },
  heading(p) {
    const sz = p.size ? ` style="font-size:${esc(p.size)}px"` : '';
    return `<h1 class="cp-heading ${alignClass(p.align)}"${sz}>${esc(p.text)}</h1>`;
  },
  text(p) {
    return `<p class="cp-text ${p.muted ? 'is-muted ' : ''}${alignClass(p.align)}">${esc(p.text)}</p>`;
  },
  spacer(p) {
    return `<div class="cp-spacer" style="height:${esc(p.size ?? 16)}px"></div>`;
  },
  'button-link'(p) {
    const style = p.style === 'outline' ? 'outline' : 'solid';
    const href = /^https?:\/\//i.test(String(p.url || '')) ? esc(p.url) : '#';
    return `<a class="cp-btn cp-btn--${style}" href="${href}" rel="noopener">${esc(p.label || 'Learn more')}</a>`;
  },
  divider() {
    return '<hr class="cp-divider">';
  },
  'terms-checkbox'(p) {
    const link = p.url ? ` <a href="${esc(p.url)}" target="_blank" rel="noopener">Terms</a>` : '';
    return (
      `<label class="cp-terms"><input type="checkbox" data-tk-terms${p.required !== false ? ' required' : ''}> ` +
      `${esc(p.text || 'I agree to the terms of use')}${link}</label>`
    );
  },
  columns(p, ctx) {
    return (
      `<div class="cp-cols"><div class="cp-col">${renderBlocks(p.left, ctx)}</div>` +
      `<div class="cp-col">${renderBlocks(p.right, ctx)}</div></div>`
    );
  },
  html(p) {
    return `<div class="cp-html">${sanitizeHtml(String(p.html || ''))}</div>`;
  },
  'logout-button'(p, ctx) {
    const action = ctx.preview ? '#' : esc(ctx.linkLogout ?? '');
    return (
      `<form class="cp-form" method="post" action="${action}">` +
      `<button type="submit" class="cp-btn">${esc(p.label || 'Log out')}</button></form>`
    );
  },
  'free-login'(p, ctx) {
    const group = p.plan && p.plan !== 'free' ? String(p.plan) : 'free';
    const username = group === 'free' ? FREE_USERNAME : `free-${group}`;
    const password = group === 'free' ? FREE_PASSWORD : (ctx.freeCreds && ctx.freeCreds[group]) || '';
    return loginForm(
      ctx,
      `<input type="hidden" name="username" value="${esc(username)}">` +
        `<input type="hidden" name="password" value="${esc(password)}">` +
        `<button type="submit" class="cp-btn">${esc(p.label || 'Connect for free')}</button>`,
    );
  },
  'voucher-login'(p, ctx) {
    // The voucher code IS the password: portal.js mirrors this field into the
    // hidden password input (data-tk-mirror) — no inline handler, so a future
    // unescaped placeholder can't smuggle an event handler into the page.
    return loginForm(
      ctx,
      field(
        'ticket',
        `<input name="username" autocomplete="off" autocapitalize="characters" aria-label="Voucher code" placeholder="${esc(p.placeholder || 'Enter voucher code')}" data-tk-mirror="password" required>`,
      ) +
        `<input type="hidden" name="password" value="">` +
        `<button type="submit" class="cp-btn">${esc(p.label || 'Use voucher')}</button>`,
    );
  },
  // ctx.plugins is a map of id (string) -> {id, name, inputs, enabled, ...}
  // supplied by the portal route (portal/routes.js) from plugins/store.js's
  // listPlugins(). Renders one text-ish input per recipe.inputs entry, plus
  // the hotspot-session context as hidden fields (the POST target is our own
  // container, not the router, so it can't reuse loginForm()'s action/dst-only
  // shape) and posts to POST /portal/lookup/:id.
  'plugin-login'(p, ctx) {
    const plugin = ctx.plugins && ctx.plugins[String(p.pluginId)];
    if (!plugin || !plugin.enabled) {
      return ctx.preview ? `<p class="cp-text is-muted">Guest lookup is not configured.</p>` : '';
    }
    const action = ctx.preview ? '#' : `/portal/lookup/${esc(plugin.id)}`;
    const intro = p.intro ? `<p class="cp-text">${esc(p.intro)}</p>` : '';
    const inputsHtml = (plugin.inputs || [])
      .map((inp) => {
        const type = ['text', 'tel', 'email', 'number'].includes(inp.type) ? inp.type : 'text';
        const label = inp.label || inp.name;
        return field(
          '',
          `<input type="${type}" name="in_${esc(inp.name)}" placeholder="${esc(label)}" aria-label="${esc(label)}"${inp.required ? ' required' : ''}>`,
        );
      })
      .join('');
    const hiddenCtx =
      `<input type="hidden" name="mac" value="${esc(ctx.mac ?? '')}">` +
      `<input type="hidden" name="ip" value="${esc(ctx.ip ?? '')}">` +
      `<input type="hidden" name="link-login" value="${esc(ctx.linkLogin ?? '')}">` +
      `<input type="hidden" name="link-logout" value="${esc(ctx.linkLogout ?? '')}">` +
      `<input type="hidden" name="dst" value="${esc(ctx.dst ?? '')}">` +
      `<input type="hidden" name="chap-id" value="${esc(ctx.chapId ?? '')}">` +
      `<input type="hidden" name="chap-challenge" value="${esc(ctx.chapChallenge ?? '')}">`;
    return (
      `<form class="cp-form" method="post" action="${action}" data-tikspot-lookup>` +
      intro +
      inputsHtml +
      hiddenCtx +
      `<button type="submit" class="cp-btn">${esc(p.label || 'Continue')}</button>` +
      `</form>`
    );
  },
  'userpass-login'(p, ctx) {
    return loginForm(
      ctx,
      field('user', `<input name="username" aria-label="${esc(p.userPlaceholder || 'Username')}" placeholder="${esc(p.userPlaceholder || 'Username')}" autocomplete="username" required>`) +
        field('lock', `<input type="password" name="password" aria-label="${esc(p.passPlaceholder || 'Password')}" placeholder="${esc(p.passPlaceholder || 'Password')}" autocomplete="current-password" required>`) +
        `<button type="submit" class="cp-btn">${esc(p.label || 'Log in')}</button>`,
    );
  },
};

export function renderBlock(block, ctx = {}) {
  const fn = RENDERERS[block.type];
  if (!fn) return '';
  const inner = fn(block.props || {}, ctx);
  if (!inner) return '';
  return wrap(inner, block, ctx);
}

export function renderBlocks(blocks, ctx = {}) {
  return (blocks || []).map((b) => renderBlock(b, ctx)).join('\n');
}
