// Render a design model into the live captive-portal page.
//
// design = { theme, blocks, pages:{status,logout} }. `ctx.page` picks which
// block list renders ('login' | 'status' | 'logout', default 'login'). Blocks
// render via widgets.js (login blocks become real forms posting to the
// router's link-login); the theme sets the page background/card look and the
// cp- CSS vars. The portal CSS is inlined so a captive client needs a single
// request.

import fs from 'node:fs';
import { renderBlocks, esc } from './widgets.js';
import { normalizeDesign, pageBlocks } from '../design/model.js';

const PORTAL_CSS = fs.readFileSync(new URL('./static/portal.css', import.meta.url), 'utf8');

function errorBanner(error) {
  if (!error) return '';
  return `<div class="cp-error" role="alert">${esc(error)}</div>`;
}

// Admin-authored announcements targeted at the portal ("Pool closed 9-11",
// "Maintenance tonight"). Rendered above the design's blocks so a guest can't
// miss them; everything is escaped — the admin writes plain text, not HTML.
function announcementBanners(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list
    .map((a) => {
      const sev = ['info', 'warning', 'danger', 'success'].includes(a?.severity) ? a.severity : 'info';
      const body = a?.body ? ` ${esc(a.body)}` : '';
      return (
        `<div class="cp-notice cp-notice--${sev}" role="status">` +
        `<strong>${esc(a?.title ?? '')}</strong>${body}</div>`
      );
    })
    .join('\n');
}

// Rendered instead of the design's blocks when ctx.autosubmit is set (a
// guest-lookup plugin just admitted the visitor — see POST /portal/lookup/:id
// in portal/routes.js). A hidden login form auto-submits itself to the
// router's link-login via portal.js's data-tk-autosubmit wiring; the visible
// "Continue" button is the no-JS/blocked-JS fallback. CSP-compatible: no
// inline script, only existing cp- classes.
function connectingCard(ctx) {
  const a = ctx.autosubmit || {};
  const label = a.label ? esc(a.label) : 'you';
  return (
    `<h1 class="cp-heading cp-al-center">Connecting…</h1>` +
    `<p class="cp-text cp-al-center">Signing you in as ${label}</p>` +
    `<form class="cp-form" data-tikspot-login data-tk-autosubmit method="post" action="${esc(ctx.linkLogin ?? '')}">` +
    `<input type="hidden" name="username" value="${esc(a.username ?? '')}">` +
    `<input type="hidden" name="password" value="${esc(a.password ?? '')}">` +
    `<input type="hidden" name="dst" value="${esc(ctx.dst ?? '')}">` +
    `<input type="hidden" name="popup" value="true">` +
    `<button type="submit" class="cp-btn">Continue</button>` +
    `</form>`
  );
}

function directLoadNotice(host) {
  const link = host ? ` <a href="http://${esc(host)}/">Open the Wi‑Fi login</a>` : '';
  return (
    `<div class="cp-notice" id="tk-notice" role="alert">` +
    `<strong>You're not connected through the Wi‑Fi yet.</strong> ` +
    `Join the network and you'll be brought here automatically — the buttons below ` +
    `won't work until then.${link}</div>`
  );
}

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action *";

/**
 * @param {{theme:object, blocks:Array, pages:object}} design
 * @param {object} ctx  hotspot session + flags (linkLogin, linkLogout, dst,
 *                       error, chap*, preview, page, hotspotHost, title,
 *                       announcements[], freeCreds)
 */
export function renderPortalPage(design, ctx = {}) {
  const d = normalizeDesign(design);
  const t = d.theme;
  const page = ['login', 'status', 'logout'].includes(ctx.page) ? ctx.page : 'login';

  const directLoad = Boolean(page === 'login' && !ctx.linkLogin && !ctx.preview);
  const useChap = Boolean(ctx.chap && ctx.chapId);

  const blocksHtml = ctx.autosubmit ? connectingCard(ctx) : renderBlocks(pageBlocks(d, page), ctx);

  const runtime = {
    linkLogin: ctx.linkLogin ?? '',
    linkLogout: ctx.linkLogout ?? '',
    dst: ctx.dst ?? '',
    chapId: ctx.chapId ?? '',
    chapChallenge: ctx.chapChallenge ?? '',
    chap: useChap,
    direct: directLoad,
    hotspotHost: ctx.hotspotHost ?? '',
    preview: Boolean(ctx.preview),
    page,
  };

  const scripts = useChap
    ? `<script src="/m/md5.js"></script><script src="/m/portal.js"></script>`
    : `<script src="/m/portal.js"></script>`;

  const bgImage = t.bgImage ? `,url('${esc(t.bgImage)}') center/cover no-repeat` : '';
  const pageStyle =
    `background:radial-gradient(120% 90% at 50% -10%, ${esc(t.pageBg2)} 0%, ${esc(t.pageBg)} 60%)${bgImage};` +
    `--cp-w:${esc(t.width)}px;--cp-accent:${esc(t.accent)};--cp-radius:${esc(t.radius)}px;` +
    `--cp-font:${esc(t.font)},system-ui,sans-serif;--cp-card-bg:${esc(t.cardBg)};--cp-text:${esc(t.textColor)};` +
    `min-height:100vh`;

  const cardClass = ['cp-card', t.logoPosition === 'left' ? 'cp-logo-left' : ''].filter(Boolean).join(' ');

  const bodyData = esc(JSON.stringify(runtime));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${(ctx.title ?? 'Connect to Wi‑Fi').replace(/[<>]/g, '')}</title>
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%}${PORTAL_CSS}</style>
</head>
<body data-tikspot="${bodyData}">
<div class="cp-page" style="${pageStyle}">
<div class="${cardClass}" data-btn-style="${esc(t.buttonStyle)}">
${directLoad ? directLoadNotice(ctx.hotspotHost) : ''}
${errorBanner(ctx.error)}
${announcementBanners(ctx.announcements)}
${blocksHtml}
</div>
</div>
${scripts}
</body>
</html>`;
}
