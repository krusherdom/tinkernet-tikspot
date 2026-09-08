/* Tikspot captive-portal editor — registry-driven.
 *
 * Everything the editor offers comes from the server: GET /api/blocks returns the
 * block registry (types, fields, defaults), the style fields and the theme fields.
 * The canvas is a real <iframe srcdoc> filled by POST /api/designs/preview, so the
 * preview is byte-for-byte the page guests get (forms inert).
 *
 * Design model: { theme:{...}, blocks:[block], pages:{ status:[block], logout:[block] } }
 * block        : { id, type, props:{ ..., style:{mt,mb,color,bg,align,hidden} } }
 * columns block: props.left:[block], props.right:[block]  (one nesting level only)
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- icons ---
  // Lucide paths, inlined (the admin ships no icon font/CDN).
  var P = {
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    heading: '<path d="M6 12h12M6 20V4M18 20V4"/>',
    type: '<path d="M4 7V5h16v2M9 19h6M12 5v14"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.8-1.6l9.4-10.8a.5.5 0 0 1 .9.4L11.5 9.5a1 1 0 0 0 .8 1.5H20a1 1 0 0 1 .8 1.6l-9.4 10.8a.5.5 0 0 1-.9-.4l1.9-7.5a1 1 0 0 0-.8-1.5z"/>',
    ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v14"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    'move-vertical': '<path d="M8 18L12 22 16 18M8 6L12 2 16 6M12 2v20"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    wifi: '<path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 20 0M12 20h.01"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    'align-left': '<path d="M3 6h18M3 12h12M3 18h15"/>',
    'align-center': '<path d="M3 6h18M6 12h12M4 18h16"/>',
    'align-right': '<path d="M3 6h18M9 12h12M6 18h15"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    minus: '<path d="M5 12h14"/>',
    'check-square': '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    'layout-template': '<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>',
    history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v6h6"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  };
  function svg(name, size) {
    size = size || 16;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || P.file) + '</svg>';
  }

  // ------------------------------------------------------------ constants ---
  var PAGES = [
    { id: 'login', label: 'Login page', icon: 'wifi' },
    { id: 'status', label: 'Connected page', icon: 'check-square' },
    { id: 'logout', label: 'Logged-out page', icon: 'log-out' },
  ];
  var DEVICES = { desktop: { w: 1280, h: 800 }, mobile: { w: 390, h: 844 } };
  var ALIGN_OPTS = [
    { value: 'left', icon: 'align-left' },
    { value: 'center', icon: 'align-center' },
    { value: 'right', icon: 'align-right' },
  ];
  var FALLBACK_COLORS = ['#2F8CEE', '#1761B0', '#E85B9E', '#ADE84F', '#F5B544', '#9C7BFF'];
  // Card / text colours want paper-and-ink choices, not the neon accent set.
  var NEUTRALS = ['#FFFFFF', '#F7F9FC', '#E6EDF3', '#5A6976', '#16202B', '#0A0D12'];

  // ---------------------------------------------------------------- state ---
  var registry = null;       // { blocks, styleFields, themeFields, theme, fonts, accents, pageBgs }
  var defs = {};             // type -> block definition
  var model = null;          // the design model being edited
  var design = { id: null, name: 'Untitled', version: 0, hasDraft: false };
  var page = 'login';
  var selected = null;
  var tab = 'content';
  var device = 'desktop';
  var plans = [];
  var plugins = [];
  var assets = [];
  var host = '';
  var dirty = false;
  var savedAt = null;
  var bootError = null;
  var previewError = null;
  var dragType = null;       // palette drag: { type, listKey }
  var dragLayer = null;      // layer reorder drag: { listKey, index }
  var uid = 0;

  var undoStack = [];
  var redoStack = [];
  var lastSnapAt = 0;

  // ------------------------------------------------------------- utilities --
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function newId() { return 'b' + Date.now().toString(36) + (uid++).toString(36); }
  function $(id) { return document.getElementById(id); }

  function api(path, opts) {
    opts = opts || {};
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        if (t) { try { j = JSON.parse(t); } catch (e) { j = {}; } }
        if (!r.ok) {
          var err = new Error(j.error || (path + ' → HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }
  function soft(path) { return api(path).catch(function () { return null; }); }

  var toastEl = null;
  function toast(msg, err) {
    if (!toastEl) toastEl = $('ed-toast');
    toastEl.textContent = msg;
    toastEl.className = 'ed-toast show' + (err ? ' ed-toast--err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.className = 'ed-toast'; }, 2800);
  }

  function getPath(root, path) {
    var parts = path.split('.'), o = root;
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }
  function setPath(root, path, value) {
    var parts = path.split('.'), o = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
  }

  // ------------------------------------------------------- model plumbing ---
  function normalize(m) {
    var out = m && typeof m === 'object' ? m : {};
    if (!out.theme || typeof out.theme !== 'object') out.theme = clone((registry && registry.theme) || {});
    if (!Array.isArray(out.blocks)) out.blocks = [];
    if (!out.pages || typeof out.pages !== 'object') out.pages = {};
    if (!Array.isArray(out.pages.status)) out.pages.status = [];
    if (!Array.isArray(out.pages.logout)) out.pages.logout = [];
    return out;
  }
  function pageList(p) {
    if (p === 'login') return model.blocks;
    if (!Array.isArray(model.pages[p])) model.pages[p] = [];
    return model.pages[p];
  }
  // A "columns" block is one whose registry entry declares fields of kind
  // 'columns' — each such field key is one side holding a nested block list.
  function isColumnsType(type) {
    if (type === 'columns') return true;
    var d = defs[type];
    return !!(d && (d.fields || []).some(function (f) { return f.kind === 'columns'; }));
  }
  function isColumns(b) { return isColumnsType(b.type); }
  function colSides(b) {
    var d = defs[b.type];
    var keys = ((d && d.fields) || []).filter(function (f) { return f.kind === 'columns'; })
      .map(function (f) { return f.key; });
    return keys.length ? keys : ['left', 'right'];
  }
  // Visit every editable list on the current page: the root list plus each
  // columns block's sides (one nesting level — no columns inside columns).
  function eachList(cb) {
    var root = pageList(page);
    cb(root, 'root', null);
    for (var i = 0; i < root.length; i++) {
      var b = root[i];
      if (!isColumns(b)) continue;
      colSides(b).forEach(function (side) {
        if (!Array.isArray(b.props[side])) b.props[side] = [];
        cb(b.props[side], b.id + ':' + side, b.id);
      });
    }
  }
  function findBlock(id) {
    if (!id || !model) return null;
    var found = null;
    eachList(function (list, key, parentId) {
      if (found) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { found = { block: list[i], list: list, index: i, listKey: key, parentId: parentId }; return; }
      }
    });
    return found;
  }
  function listByKey(key) {
    var out = null;
    eachList(function (list, k) { if (k === key) out = list; });
    return out;
  }
  function allBlocksOnPage() {
    var out = [];
    eachList(function (list) { for (var i = 0; i < list.length; i++) out.push(list[i]); });
    return out;
  }
  // Blocks in rendered document order (a columns block is immediately followed
  // by its nested children) — used to line the model up with the preview DOM.
  function preorderBlocks() {
    var out = [];
    (function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        out.push(b);
        if (isColumns(b)) colSides(b).forEach(function (side) { walk(b.props[side] || []); });
      }
    })(pageList(page));
    return out;
  }

  // ------------------------------------------------------------- history ----
  function pushSnap(coalesce) {
    var now = Date.now();
    if (coalesce && now - lastSnapAt < 600) { lastSnapAt = now; return; }
    undoStack.push(JSON.stringify(model));
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
    lastSnapAt = now;
  }
  function doUndo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(model));
    model = normalize(JSON.parse(undoStack.pop()));
    afterHistory();
  }
  function doRedo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(model));
    model = normalize(JSON.parse(redoStack.pop()));
    afterHistory();
  }
  function afterHistory() {
    lastSnapAt = 0;
    if (selected && !findBlock(selected)) selected = null;
    markDirty();
    refreshAll();
  }

  // ------------------------------------------------------- draft autosave ---
  var saveTimer = null;
  var editGen = 0; // bumped on every edit, so a slow save can't clear a newer one
  function markDirty() {
    dirty = true;
    editGen++;
    refreshTop();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveDraft(); }, 1500);
  }
  function saveDraft(silent) {
    clearTimeout(saveTimer);
    if (!design.id || !dirty) return Promise.resolve();
    var snapshot = clone(model);
    var gen = editGen;
    return api('/api/designs/' + design.id + '/draft', { method: 'POST', body: { model: snapshot } })
      .then(function (r) {
        if (gen === editGen) dirty = false; // edits made while saving stay pending
        design.hasDraft = true;
        savedAt = r && r.saved_at ? new Date(r.saved_at) : new Date();
        refreshTop();
      })
      .catch(function (e) {
        refreshTop();
        if (!silent) toast('Draft not saved: ' + e.message, true);
      });
  }

  // ------------------------------------------------------------- preview ----
  var prevTimer = null, prevSeq = 0;
  function schedulePreview() { clearTimeout(prevTimer); prevTimer = setTimeout(renderPreview, 150); }
  function renderPreview() {
    var frame = $('ed-iframe');
    if (!frame || !model) return;
    var seq = ++prevSeq;
    var scroll = 0;
    try { scroll = frame.contentWindow ? frame.contentWindow.scrollY || 0 : 0; } catch (e) { /* ignore */ }
    fetch('/api/designs/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ design: model, page: page }),
    })
      .then(function (r) {
        return r.text().then(function (t) {
          if (!r.ok) throw new Error('POST /api/designs/preview → HTTP ' + r.status);
          return t;
        });
      })
      .then(function (html) {
        if (seq !== prevSeq) return;
        previewError = null;
        frame.onload = function () { decorateFrame(scroll); };
        frame.srcdoc = html;
        setCanvasNote('');
      })
      .catch(function (e) {
        if (seq !== prevSeq) return;
        previewError = e.message;
        frame.srcdoc = '<style>body{margin:0;font:14px/1.5 system-ui;background:#12161c;color:#9AA9B7;' +
          'display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center}</style>' +
          '<div><b style="color:#F2585B">Preview unavailable</b><br>' + esc(e.message) +
          '<br><small>The editor keeps editing the model — only the rendered preview is missing.</small></div>';
        setCanvasNote(e.message);
      });
  }
  function setCanvasNote(msg) {
    var el = $('ed-note');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  var FRAME_CSS =
    '[data-block-id]{cursor:pointer;position:relative}' +
    '[data-block-id]:hover{outline:1px dashed rgba(47,140,238,.55);outline-offset:2px}' +
    '.ed-sel{outline:2px solid #2F8CEE !important;outline-offset:2px;border-radius:4px}' +
    '.ed-hidden{opacity:.32;filter:grayscale(.5)}' +
    '.ed-tag{position:absolute;top:-9px;left:0;transform:translateY(-100%);z-index:9999;display:flex;' +
    'align-items:center;gap:6px;background:#2F8CEE;color:#06080B;font:600 9px/1 ui-monospace,monospace;' +
    'letter-spacing:.1em;text-transform:uppercase;padding:4px 6px;border-radius:4px;white-space:nowrap}' +
    '.ed-tag button{all:unset;cursor:pointer;display:inline-flex;line-height:0}';

  function decorateFrame(scroll) {
    var frame = $('ed-iframe');
    var doc;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc) return;
    var st = doc.createElement('style');
    st.textContent = FRAME_CSS;
    (doc.head || doc.documentElement).appendChild(st);

    doc.addEventListener('submit', function (e) { e.preventDefault(); });
    // Clicks inside the iframe never reach the parent document, so close any
    // open top-bar menu here too.
    doc.addEventListener('click', closeMenus, true);
    doc.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-block-id]') : null;
      if (el) {
        e.preventDefault();
        e.stopPropagation();
        select(el.getAttribute('data-block-id'));
      } else {
        select(null);
      }
    }, true);
    doc.addEventListener('keydown', onKey);

    if (!ensureBlockIds(doc) && allBlocksOnPage().length) {
      setCanvasNote('Preview blocks are not clickable — the rendered page carries no data-block-id. Use the layers panel.');
    }

    paintFrame();
    try { if (scroll) frame.contentWindow.scrollTo(0, scroll); } catch (e) { /* ignore */ }
  }

  // The rendered page is expected to tag every block wrapper with
  // data-block-id. If a server build doesn't, fall back to matching the
  // .cp-block wrappers against the model in document order — but only when the
  // counts line up exactly, so we never mis-attribute a click.
  function ensureBlockIds(doc) {
    if (doc.querySelector('[data-block-id]')) return true;
    var els = doc.querySelectorAll('.cp-block');
    var list = preorderBlocks();
    if (!els.length || els.length !== list.length) return false;
    for (var i = 0; i < els.length; i++) els[i].setAttribute('data-block-id', list[i].id);
    return true;
  }

  // Selection outline + "hidden" dimming, applied without a re-render.
  function paintFrame() {
    var frame = $('ed-iframe');
    var doc;
    try { doc = frame && frame.contentDocument; } catch (e) { return; }
    if (!doc || !doc.body) return;
    var hidden = {};
    allBlocksOnPage().forEach(function (b) {
      if (b.props && b.props.style && b.props.style.hidden) hidden[b.id] = true;
    });
    Array.prototype.forEach.call(doc.querySelectorAll('.ed-tag'), function (t) { t.remove(); });
    Array.prototype.forEach.call(doc.querySelectorAll('[data-block-id]'), function (el) {
      var id = el.getAttribute('data-block-id');
      el.classList.toggle('ed-hidden', !!hidden[id]);
      el.classList.toggle('ed-sel', id === selected);
      if (id !== selected) return;
      var f = findBlock(id);
      var label = f && defs[f.block.type] ? defs[f.block.type].label : (f ? f.block.type : '');
      var tag = doc.createElement('div');
      tag.className = 'ed-tag';
      tag.innerHTML = '<span>' + esc(label) + '</span><button type="button" title="Delete block">' + svg('trash', 12) + '</button>';
      tag.querySelector('button').addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        removeBlock(id);
      });
      el.appendChild(tag);
    });
  }

  // ---------------------------------------------------------------- shell ---
  function buildShell() {
    var pageSeg = PAGES.map(function (p) {
      return '<button class="ed-pagebtn" data-page="' + p.id + '">' + svg(p.icon, 14) + '<span>' + esc(p.label) + '</span></button>';
    }).join('');
    $('ed-root').innerHTML =
      '<div class="ed-app">' +
      '<header class="ed-top">' +
      '<div class="ed-top__left">' +
      '<a class="ed-btn ed-exit" id="ed-exit" href="/admin/" title="Back to the dashboard">' + svg('back', 15) + '<span class="ed-btnlbl">Exit</span></a>' +
      '<a class="ed-brand" href="/admin/"><img src="/ds/assets/logo-robot.png" alt=""><b>Tikspot</b></a>' +
      '<span class="ed-top__divider"></span>' +
      '<div class="ed-top__page"><div class="ed-top__crumb">// design</div>' +
      '<input class="ed-name" id="ed-name" spellcheck="false" title="Design name — press Enter to rename"></div>' +
      '<span class="ed-badge" id="ed-badge">…</span>' +
      '</div>' +
      '<div class="ed-top__center">' +
      '<div class="ed-pageseg" id="ed-pageseg">' + pageSeg + '</div>' +
      '<div class="ed-seg">' +
      '<button class="ed-seg__btn" data-dev="desktop" title="Desktop 1280×800">' + svg('monitor') + '</button>' +
      '<button class="ed-seg__btn" data-dev="mobile" title="Mobile 390×844">' + svg('smartphone') + '</button>' +
      '</div></div>' +
      '<div class="ed-top__right">' +
      '<button class="ed-iconbtn" id="ed-undo" title="Undo (Ctrl+Z)">' + svg('undo', 16) + '</button>' +
      '<button class="ed-iconbtn" id="ed-redo" title="Redo (Ctrl+Shift+Z)">' + svg('redo', 16) + '</button>' +
      menuHtml('ed-hist', svg('history', 15) + '<span class="ed-btnlbl">History</span>', '') +
      menuHtml('ed-designs', svg('layout-template', 15) + '<span class="ed-btnlbl">Designs</span>',
        '<button data-act="new">' + svg('plus', 15) + ' New from template…</button>' +
        '<button data-act="dup">' + svg('copy', 15) + ' Duplicate this design</button>' +
        '<button data-act="switch">' + svg('layout-template', 15) + ' Switch to…</button>' +
        '<div class="ed-menu__sep"></div>' +
        '<button data-act="import">' + svg('upload', 15) + ' Import JSON…</button>' +
        '<a data-act="export" id="ed-export" href="#">' + svg('download', 15) + ' Export JSON</a>' +
        '<div class="ed-menu__sep"></div>' +
        '<button data-act="activate">' + svg('rocket', 15) + ' Set as live</button>' +
        '<button data-act="discard">' + svg('undo', 15) + ' Discard draft</button>' +
        '<button data-act="delete" class="is-danger">' + svg('trash', 15) + ' Delete design</button>') +
      menuHtml('ed-files', svg('code', 15) + '<span class="ed-btnlbl">Files</span>',
        '<a href="/api/hotspot/shim.zip" download="tikspot-hotspot.zip">' + svg('save', 15) + ' Download .zip</a>' +
        '<button data-act="push">' + svg('rocket', 15) + ' Push to router</button>' +
        '<div class="ed-menu__sep"></div>' +
        '<a id="ed-newtab" href="/login?preview=1" target="_blank" rel="noopener">' + svg('eye', 15) + ' Preview in new tab</a>') +
      '<span class="ed-top__saved" id="ed-saved"></span>' +
      '<button class="ed-btn ed-btn--primary" id="ed-publish">' + svg('rocket', 15) + ' Publish</button>' +
      '</div></header>' +
      '<div class="ed-main">' +
      '<aside class="ed-left" id="ed-left"></aside>' +
      '<main class="ed-canvas">' +
      '<div class="ed-canvas__bar"><span id="ed-dims"></span><span class="ed-canvas__note" id="ed-note" hidden></span>' +
      '<span class="ed-keys">Del remove · Ctrl+D duplicate · Ctrl+Z undo · Esc deselect</span></div>' +
      '<div class="ed-canvas__scroll" id="ed-scroll">' +
      '<div class="ed-frame" id="ed-frame">' +
      '<div class="ed-frame__chrome"><span class="ed-frame__dot"></span><span class="ed-frame__dot"></span><span class="ed-frame__dot"></span>' +
      '<span class="ed-frame__url" id="ed-url"></span></div>' +
      '<div class="ed-stage" id="ed-stage"><iframe id="ed-iframe" title="Portal preview"></iframe></div>' +
      '</div></div></main>' +
      '<aside class="ed-right" id="ed-right"></aside>' +
      '</div></div>';

    document.querySelectorAll('[data-dev]').forEach(function (b) {
      b.onclick = function () { device = b.dataset.dev; refreshTop(); applyScale(); };
    });
    document.querySelectorAll('[data-page]').forEach(function (b) {
      b.onclick = function () { switchPage(b.dataset.page); };
    });
    $('ed-undo').onclick = doUndo;
    $('ed-redo').onclick = doRedo;
    $('ed-publish').onclick = publish;
    bindMenus();
    bindName();
    bindExit();

    // Drop target for palette drags — dropping anywhere on the canvas appends.
    var scroll = $('ed-scroll');
    scroll.ondragover = function (e) { if (dragType) { e.preventDefault(); scroll.classList.add('drop-armed'); } };
    scroll.ondragleave = function () { scroll.classList.remove('drop-armed'); };
    scroll.ondrop = function (e) {
      e.preventDefault(); scroll.classList.remove('drop-armed');
      if (dragType) { addBlock(dragType.type, dragType.listKey); dragType = null; }
    };

    if (window.ResizeObserver) new ResizeObserver(applyScale).observe(scroll);
    else window.addEventListener('resize', applyScale);
  }

  function menuHtml(id, label, items) {
    return '<div class="ed-hswrap"><button class="ed-btn" id="' + id + '-btn">' + label + ' ' + svg('chevron-down', 13) + '</button>' +
      '<div class="ed-menu" id="' + id + '-menu" hidden>' + items + '</div></div>';
  }
  function closeMenus() {
    document.querySelectorAll('.ed-menu').forEach(function (m) { m.hidden = true; });
  }
  function bindMenus() {
    ['ed-hist', 'ed-designs', 'ed-files'].forEach(function (id) {
      var btn = $(id + '-btn'), menu = $(id + '-menu');
      btn.onclick = function (e) {
        e.stopPropagation();
        var wasOpen = !menu.hidden;
        closeMenus();
        menu.hidden = wasOpen;
        if (!wasOpen && id === 'ed-hist') loadVersions(menu);
      };
      menu.onclick = function (e) { e.stopPropagation(); };
    });
    document.addEventListener('click', closeMenus);
    $('ed-designs-menu').querySelectorAll('[data-act]').forEach(function (b) {
      if (b.dataset.act === 'export') return;
      b.onclick = function () { closeMenus(); designAction(b.dataset.act); };
    });
    $('ed-files-menu').querySelector('[data-act="push"]').onclick = function () { closeMenus(); pushHotspot(); };
  }
  function bindName() {
    var el = $('ed-name');
    el.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } };
    el.onblur = function () {
      var name = el.value.trim();
      if (!design.id || !name || name === design.name) { el.value = design.name; return; }
      api('/api/designs/' + design.id, { method: 'PATCH', body: { name: name } })
        .then(function () { design.name = name; toast('Renamed'); })
        .catch(function (e) { el.value = design.name; toast(e.message, true); });
    };
  }
  function bindExit() {
    $('ed-exit').onclick = function (e) {
      e.preventDefault();
      if (dirty && !confirm('You have unsaved changes. Leave the editor anyway?')) return;
      dirty = false;
      location.href = '/admin/';
    };
  }

  function pushHotspot() {
    toast('Pushing hotspot files to the router…');
    api('/api/hotspot/push', { method: 'POST' })
      .then(function (j) {
        if (j.ok) toast('Pushed ' + j.pushed + '/' + j.total + ' files into ' + j.htmlDir + '/ on the router');
        else {
          var bad = (j.results || []).filter(function (x) { return !x.ok; }).map(function (x) { return x.name; }).join(', ');
          toast('Pushed ' + j.pushed + '/' + j.total + ' — failed: ' + bad, true);
        }
      })
      .catch(function (e) { toast(e.message, true); });
  }

  // ------------------------------------------------------------- top bar ----
  function refreshTop() {
    document.querySelectorAll('[data-dev]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.dev === device); });
    document.querySelectorAll('[data-page]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.page === page); });
    var d = DEVICES[device];
    $('ed-dims').textContent = d.w + ' × ' + d.h;
    var name = $('ed-name');
    if (name && name !== document.activeElement) name.value = design.name || '';
    $('ed-undo').disabled = !undoStack.length;
    $('ed-redo').disabled = !redoStack.length;

    var badge = $('ed-badge');
    if (dirty) { badge.className = 'ed-badge ed-badge--amber'; badge.textContent = 'Draft — unsaved'; }
    else if (savedAt) {
      badge.className = 'ed-badge ed-badge--cyan';
      badge.textContent = 'Draft saved ' + pad(savedAt.getHours()) + ':' + pad(savedAt.getMinutes());
    } else if (design.hasDraft) {
      badge.className = 'ed-badge ed-badge--cyan';
      badge.textContent = design.version ? 'Draft (unpublished changes)' : 'Draft — never published';
    } else if (!design.version) { badge.className = 'ed-badge ed-badge--amber'; badge.textContent = 'Not published yet'; }
    else { badge.className = 'ed-badge ed-badge--lime'; badge.textContent = 'Published v' + design.version; }
    $('ed-saved').innerHTML = design.isActive ? svg('check', 13) + ' Live' : '';

    var url = $('ed-url');
    var pageUrl = page === 'login' ? '/login' : page === 'status' ? '/status' : '/logout';
    url.innerHTML = svg('wifi', 12) + ' ' + esc(host || 'wifi.local') + pageUrl;
    var tabLink = $('ed-newtab');
    tabLink.href = '/login?preview=1' + (page === 'login' ? '' : '&page=' + page);
    var exp = $('ed-export');
    if (exp) exp.href = design.id ? '/api/designs/' + design.id + '/export' : '#';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function applyScale() {
    var d = DEVICES[device];
    var scroll = $('ed-scroll'), stage = $('ed-stage'), frame = $('ed-frame'), iframe = $('ed-iframe');
    if (!scroll || !stage) return;
    var avail = Math.max(240, scroll.clientWidth - 56);
    var availH = Math.max(240, scroll.clientHeight - 110);
    var k = Math.min(1, avail / d.w, availH / d.h);
    iframe.style.width = d.w + 'px';
    iframe.style.height = d.h + 'px';
    iframe.style.transform = 'scale(' + k + ')';
    stage.style.width = Math.round(d.w * k) + 'px';
    stage.style.height = Math.round(d.h * k) + 'px';
    frame.style.width = Math.round(d.w * k) + 'px';
  }

  // ------------------------------------------------ left: palette + layers --
  function refreshLeft() {
    var left = $('ed-left');
    if (bootError) {
      left.innerHTML = '<div class="ed-panel__label">// editor api</div><div class="ed-error">' + esc(bootError) + '</div>';
      return;
    }
    var list = (registry.blocks || []).filter(function (b) {
      return !b.pages || !b.pages.length || b.pages.indexOf(page) !== -1;
    });
    var chips = list.length
      ? list.map(function (b) {
          return '<button class="ed-chip" draggable="true" data-add="' + esc(b.type) + '" title="Drag or click to add ' + esc(b.label) + '">' +
            svg(b.icon, 17) + '<span>' + esc(b.label) + '</span></button>';
        }).join('')
      : '<div class="ed-hint">No blocks available for this page.</div>';

    left.innerHTML =
      '<div class="ed-panel__label">// add block</div><div class="ed-palette">' + chips + '</div>' +
      '<div class="ed-panel__label" style="margin-top:22px">// ' + esc(pageLabel(page)) + ' layers</div>' +
      '<div class="ed-layers" id="ed-layers">' + layersHtml() + '</div>';

    left.querySelectorAll('[data-add]').forEach(function (c) {
      c.onclick = function () { addBlock(c.dataset.add, 'root'); };
      c.ondragstart = function (e) { dragType = { type: c.dataset.add, listKey: 'root' }; e.dataTransfer.effectAllowed = 'copy'; };
      c.ondragend = function () { dragType = null; };
    });
    bindListControls(left);
  }
  function pageLabel(p) {
    for (var i = 0; i < PAGES.length; i++) if (PAGES[i].id === p) return PAGES[i].label;
    return p;
  }

  function layersHtml() {
    var root = pageList(page);
    if (!root.length) return '<div class="ed-hint">No blocks yet — add one above.</div>';
    return root.map(function (b, i) {
      var html = layerRow(b, i, 'root');
      if (isColumns(b)) {
        html += '<div class="ed-sublists">' + colSides(b).map(function (side) {
          var sub = b.props[side] || [];
          return '<div class="ed-sublist">' +
            '<div class="ed-sublist__lbl">' + side + '</div>' +
            (sub.length ? sub.map(function (c, j) { return layerRow(c, j, b.id + ':' + side, true); }).join('')
              : '<div class="ed-hint ed-hint--pad">empty</div>') +
            addSelect(b.id + ':' + side) +
            '</div>';
        }).join('') + '</div>';
      }
      return html;
    }).join('');
  }
  function layerRow(b, idx, listKey, nested) {
    var d = defs[b.type] || { label: b.type, icon: 'file' };
    var hidden = b.props && b.props.style && b.props.style.hidden;
    return '<div class="ed-layer' + (selected === b.id ? ' is-active' : '') + (nested ? ' is-nested' : '') +
      (hidden ? ' is-hidden' : '') + '" draggable="true" data-id="' + esc(b.id) + '" data-list="' + esc(listKey) + '" data-idx="' + idx + '">' +
      svg(d.icon, 15) + '<span class="ed-layer__name">' + esc(layerName(b)) + '</span>' +
      '<span class="ed-layer__grip">' + svg('grip', 14) + '</span></div>';
  }
  function layerName(b) {
    var d = defs[b.type] || { label: b.type, fields: [] };
    var f = (d.fields || []).filter(function (x) { return x.kind === 'text' || x.kind === 'textarea'; })[0];
    var v = f ? b.props[f.key] : '';
    return d.label + (v ? ' · ' + String(v).slice(0, 18) : '');
  }
  // "+ add block" dropdown used by both the layers tree and the inspector.
  function addSelect(listKey) {
    var opts = (registry.blocks || []).filter(function (b) {
      if (b.pages && b.pages.length && b.pages.indexOf(page) === -1) return false;
      return !isColumnsType(b.type); // one nesting level: no columns inside columns
    }).map(function (b) { return '<option value="' + esc(b.type) + '">' + esc(b.label) + '</option>'; }).join('');
    return '<select class="ed-addsel" data-addto="' + esc(listKey) + '"><option value="">+ add block</option>' + opts + '</select>';
  }

  // Shared bindings for layer rows / add-selects / move + delete buttons.
  function bindListControls(scope) {
    scope.querySelectorAll('.ed-layer').forEach(function (l) {
      l.onclick = function () { select(l.dataset.id); };
      l.ondragstart = function (e) {
        dragLayer = { listKey: l.dataset.list, index: +l.dataset.idx };
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', l.dataset.id); } catch (err) { /* ignore */ }
      };
      l.ondragend = function () { dragLayer = null; };
      l.ondragover = function (e) {
        if (dragLayer && dragLayer.listKey === l.dataset.list) { e.preventDefault(); l.classList.add('drag-over'); }
      };
      l.ondragleave = function () { l.classList.remove('drag-over'); };
      l.ondrop = function (e) {
        e.preventDefault(); e.stopPropagation(); l.classList.remove('drag-over');
        if (dragLayer && dragLayer.listKey === l.dataset.list) moveBlock(dragLayer.listKey, dragLayer.index, +l.dataset.idx);
        dragLayer = null;
      };
    });
    scope.querySelectorAll('[data-addto]').forEach(function (s) {
      s.onchange = function () { if (s.value) { addBlock(s.value, s.dataset.addto); } s.value = ''; };
      s.onclick = function (e) { e.stopPropagation(); };
    });
    scope.querySelectorAll('[data-move]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var parts = b.dataset.move.split('|'); // listKey|index|dir
        moveBlock(parts[0], +parts[1], +parts[1] + (+parts[2]));
      };
    });
    scope.querySelectorAll('[data-delblock]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); removeBlock(b.dataset.delblock); };
    });
    scope.querySelectorAll('[data-selblock]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); select(b.dataset.selblock); };
    });
  }

  // ------------------------------------------------------------ inspector ---
  function fieldWrap(label, inner, hint) {
    return '<div class="ed-field"><span class="ed-field__lbl">' + esc(label) + '</span>' + inner +
      (hint ? '<span class="ed-hint">' + esc(hint) + '</span>' : '') + '</div>';
  }
  function optsFor(f) {
    if (Array.isArray(f.options) && f.options.length) {
      return f.options.map(function (o) { return typeof o === 'string' ? { value: o, label: o } : o; });
    }
    // `source` may be a bare name ("plans") or an endpoint path ("/api/plans").
    var s = String(f.source || '').replace(/\/+$/, '').replace(/^.*\//, '');
    if (s === 'plans') return plans.map(function (p) { return { value: p.radius_groupname, label: p.name }; });
    if (s === 'plugins') return plugins.map(function (p) { return { value: p.id, label: p.name }; });
    if (s && registry && Array.isArray(registry[s])) {
      return registry[s].map(function (v) { return typeof v === 'string' ? { value: v, label: v } : v; });
    }
    return [];
  }
  function colorPresets(f) {
    var o = optsFor(f);
    if (o.length) return o.map(function (x) { return x.value; });
    var key = String(f.key || '');
    if (/^pageBg/.test(key) && registry && registry.pageBgs && registry.pageBgs.length) return registry.pageBgs;
    if (/card|text|color$/i.test(key)) return NEUTRALS;
    return (registry && registry.accents) || FALLBACK_COLORS;
  }

  function ctlFor(f, path, val) {
    switch (f.kind) {
      case 'textarea':
        return '<textarea class="ed-textarea" rows="3" data-txt="' + esc(path) + '">' + esc(val == null ? '' : val) + '</textarea>';
      case 'slider': {
        var min = f.min == null ? 0 : f.min, max = f.max == null ? 100 : f.max, step = f.step || 1;
        var n = val == null || val === '' ? min : +val;
        return '<div class="ed-slider"><input type="range" data-num="' + esc(path) + '" data-unit="' + esc(f.unit || '') +
          '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + n + '">' +
          '<span class="ed-slider__val">' + n + esc(f.unit || '') + '</span></div>';
      }
      case 'color': {
        var v = val || '';
        var presets = colorPresets(f).map(function (c) {
          return '<button class="ed-sw' + (String(v).toLowerCase() === String(c).toLowerCase() ? ' is-on' : '') +
            '" data-sw="' + esc(path) + '" data-c="' + esc(c) + '" style="background:' + esc(c) + '" title="' + esc(c) + '"></button>';
        }).join('');
        return '<div class="ed-swatches">' + presets + '</div><div class="ed-cp">' +
          '<input type="color" class="ed-cp__color" data-cp="' + esc(path) + '" value="' + esc(/^#[0-9a-fA-F]{6}$/.test(v) ? v : '#000000') + '" title="Pick any colour">' +
          '<input type="text" class="ed-cp__hex" data-hex="' + esc(path) + '" value="' + esc(v) + '" maxlength="7" spellcheck="false" placeholder="#______">' +
          // Per-block style colours are optional overrides, so they can be cleared;
          // theme colours always need a value.
          (path.indexOf('props.style.') === 0
            ? '<button class="ed-btn ed-btn--tiny" data-clear="' + esc(path) + '" title="Use the theme colour">Clear</button>'
            : '') + '</div>';
      }
      case 'select':
      case 'plan':
      case 'plugin': {
        var opts = optsFor(f);
        if (f.kind === 'plugin' && !opts.length) {
          return '<select class="ed-select" data-txt="' + esc(path) + '" disabled><option>No plugins installed</option></select>';
        }
        if (f.kind === 'plan' && !opts.length) opts = [{ value: 'free', label: 'Free' }];
        var body = opts.map(function (o) {
          return '<option value="' + esc(o.value) + '"' + (String(val) === String(o.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('');
        var blank = opts.some(function (o) { return String(o.value) === String(val); }) ? '' :
          '<option value="' + esc(val == null ? '' : val) + '" selected>' + esc(val == null || val === '' ? '—' : val) + '</option>';
        return '<select class="ed-select" data-txt="' + esc(path) + '">' + blank + body + '</select>';
      }
      case 'switch':
        return '<label class="ed-switch">' + esc(f.label) + '<input type="checkbox" data-bool="' + esc(path) + '"' +
          (val ? ' checked' : '') + '><span class="ed-switch__track"></span></label>';
      case 'align': {
        var aopts = (optsFor(f).length ? optsFor(f) : ALIGN_OPTS);
        return '<div class="ed-segctl">' + aopts.map(function (o) {
          var ico = o.icon || ({ left: 'align-left', center: 'align-center', right: 'align-right' }[o.value]);
          return '<button class="ed-segctl__b' + (val === o.value ? ' is-on' : '') + '" data-seg="' + esc(path) +
            '" data-v="' + esc(o.value) + '" title="' + esc(o.label || o.value) + '">' +
            (ico ? svg(ico, 15) : esc(o.label || o.value)) + '</button>';
        }).join('') + '</div>';
      }
      case 'image': {
        var thumb = val ? '<img src="' + esc(val) + '" alt="">' : svg('image', 20);
        return '<div class="ed-imgfield"><div class="ed-imgfield__thumb">' + thumb + '</div>' +
          '<div class="ed-imgfield__acts"><button class="ed-btn ed-btn--tiny" data-pick="' + esc(path) + '">' +
          (val ? 'Replace…' : 'Choose image…') + '</button>' +
          (val ? '<button class="ed-btn ed-btn--tiny" data-clear="' + esc(path) + '">Clear</button>' : '') + '</div></div>';
      }
      case 'url':
        return '<input class="ed-input" type="url" data-url="' + esc(path) + '" value="' + esc(val == null ? '' : val) +
          '" placeholder="https://example.com" spellcheck="false">';
      case 'note':
        return '<div class="ed-note">' + esc(f.text || f.hint || '') + '</div>';
      case 'columns':
        return columnsSide(f.key);
      case 'text':
      default:
        return '<input class="ed-input" data-txt="' + esc(path) + '" value="' + esc(val == null ? '' : val) + '">';
    }
  }
  function renderField(f, path, val) {
    if (f.kind === 'switch') {
      return '<div class="ed-field ed-field--sw">' + ctlFor(f, path, val) +
        (f.hint ? '<span class="ed-hint">' + esc(f.hint) + '</span>' : '') + '</div>';
    }
    if (f.kind === 'note') return '<div class="ed-field">' + ctlFor(f, path, val) + '</div>';
    return fieldWrap(f.label || f.key, ctlFor(f, path, val), f.hint);
  }

  // One column side: its nested blocks with add / reorder / delete. Selecting a
  // nested block loads it into this same inspector.
  function columnsSide(side) {
    var f = findBlock(selected);
    if (!f) return '';
    var b = f.block;
    var list = Array.isArray(b.props[side]) ? b.props[side] : [];
    var key = b.id + ':' + side;
    var rows = list.length ? list.map(function (c, i) {
      var d = defs[c.type] || { label: c.type, icon: 'file' };
      return '<div class="ed-colrow' + (selected === c.id ? ' is-active' : '') + '" data-selblock="' + esc(c.id) + '">' +
        svg(d.icon, 14) + '<span>' + esc(layerName(c)) + '</span>' +
        '<button class="ed-mini" data-move="' + esc(key) + '|' + i + '|-1" title="Move up">↑</button>' +
        '<button class="ed-mini" data-move="' + esc(key) + '|' + i + '|1" title="Move down">↓</button>' +
        '<button class="ed-mini is-danger" data-delblock="' + esc(c.id) + '" title="Delete">' + svg('x', 12) + '</button></div>';
    }).join('') : '<div class="ed-hint ed-hint--pad">empty</div>';
    return '<div class="ed-col">' + rows + addSelect(key) + '</div>';
  }
  function columnsCtl() {
    var f = findBlock(selected);
    if (!f) return '';
    return '<div class="ed-cols">' + colSides(f.block).map(function (side) {
      return '<div class="ed-col__lbl">' + esc(side) + ' column</div>' + columnsSide(side);
    }).join('') + '</div>';
  }

  function refreshInspector() {
    var right = $('ed-right');
    if (bootError) { right.innerHTML = '<div class="ed-insp__body"><div class="ed-error">' + esc(bootError) + '</div></div>'; return; }
    var f = selected ? findBlock(selected) : null;
    if (selected && !f) { selected = null; }

    if (!f) {
      var themeFields = registry.themeFields || [];
      right.innerHTML =
        '<div class="ed-insp__head"><div><div class="ed-insp__title">Page theme</div>' +
        '<div class="ed-insp__type">' + esc(pageLabel(page)) + '</div></div>' +
        '<span class="ed-badge ed-badge--cyan">page</span></div>' +
        '<div class="ed-insp__body">' +
        (themeFields.length
          ? themeFields.map(function (tf) { return renderField(tf, 'theme.' + tf.key, getPath(model, 'theme.' + tf.key)); }).join('')
          : '<div class="ed-hint">The registry returned no theme fields.</div>') +
        '<div class="ed-hint">The theme applies to every page. Select a block to edit its own content and style.</div>' +
        '</div>';
      bindInspector(right);
      return;
    }

    var b = f.block;
    var d = defs[b.type] || { label: b.type, fields: [], kind: '' };
    var fields = d.fields || [];
    var body;
    if (tab === 'style') {
      var sf = registry.styleFields || [];
      body = sf.length
        ? sf.map(function (x) { return renderField(x, 'props.style.' + x.key, getPath(b, 'props.style.' + x.key)); }).join('')
        : '<div class="ed-hint">The registry returned no style fields.</div>';
    } else {
      body = fields.map(function (x) { return renderField(x, 'props.' + x.key, getPath(b, 'props.' + x.key)); }).join('');
      // Layout blocks always get their sub-list editor, even if the registry
      // doesn't declare a `columns` field for them.
      if (isColumns(b) && !fields.some(function (x) { return x.kind === 'columns'; })) {
        body += fieldWrap('Columns', columnsCtl());
      }
      if (!body) body = '<div class="ed-hint">This block has no editable content.</div>';
    }
    right.innerHTML =
      '<div class="ed-insp__head"><div><div class="ed-insp__title">' + esc(d.label) + '</div>' +
      '<div class="ed-insp__type">' + esc(b.type) + (f.parentId ? ' · in ' + esc(f.listKey.split(':')[1]) + ' column' : '') + '</div></div>' +
      '<span class="ed-badge ed-badge--cyan">block</span></div>' +
      '<div class="ed-insp__tabs">' +
      '<button data-tab="content" class="' + (tab === 'content' ? 'is-on' : '') + '">Content</button>' +
      '<button data-tab="style" class="' + (tab === 'style' ? 'is-on' : '') + '">Style</button></div>' +
      '<div class="ed-insp__body">' + body + '</div>';
    bindInspector(right);
  }

  function inspRoot() {
    var f = selected ? findBlock(selected) : null;
    return f ? f.block : model;
  }
  function applyEdit(path, value, coalesce) {
    pushSnap(coalesce);
    setPath(inspRoot(), path, value);
    markDirty();
    schedulePreview();
  }
  function syncColor(path, value) {
    var R = $('ed-right'), lc = String(value).toLowerCase();
    R.querySelectorAll('[data-cp="' + path + '"]').forEach(function (e) { if (/^#[0-9a-fA-F]{6}$/.test(value) && e.value.toLowerCase() !== lc) e.value = value; });
    R.querySelectorAll('[data-hex="' + path + '"]').forEach(function (e) { if (e !== document.activeElement) e.value = value; });
    R.querySelectorAll('[data-sw="' + path + '"]').forEach(function (e) { e.classList.toggle('is-on', (e.dataset.c || '').toLowerCase() === lc); });
  }

  function bindInspector(R) {
    R.querySelectorAll('.ed-insp__tabs [data-tab]').forEach(function (t) {
      t.onclick = function () { tab = t.dataset.tab; refreshInspector(); };
    });
    R.querySelectorAll('[data-txt]').forEach(function (t) {
      t.oninput = function () {
        applyEdit(t.dataset.txt, t.value, t.tagName !== 'SELECT');
        refreshLeft();
      };
      t.onblur = function () { if (dirty) saveDraft(true); };
    });
    R.querySelectorAll('[data-url]').forEach(function (u) {
      u.oninput = function () {
        var v = u.value.trim();
        u.classList.toggle('is-err', !!v && !/^https?:\/\/\S+$/i.test(v));
        applyEdit(u.dataset.url, v, true);
      };
      u.onblur = function () { if (dirty) saveDraft(true); };
    });
    R.querySelectorAll('[data-num]').forEach(function (n) {
      n.oninput = function () {
        applyEdit(n.dataset.num, +n.value, true);
        n.nextElementSibling.textContent = n.value + (n.dataset.unit || '');
      };
      n.onchange = function () { if (dirty) saveDraft(true); };
    });
    R.querySelectorAll('[data-bool]').forEach(function (c) {
      c.onchange = function () { applyEdit(c.dataset.bool, c.checked); paintFrame(); refreshLeft(); };
    });
    R.querySelectorAll('[data-seg]').forEach(function (g) {
      g.onclick = function () { applyEdit(g.dataset.seg, g.dataset.v); refreshInspector(); };
    });
    R.querySelectorAll('[data-sw]').forEach(function (s) {
      s.onclick = function () { applyEdit(s.dataset.sw, s.dataset.c); syncColor(s.dataset.sw, s.dataset.c); };
    });
    R.querySelectorAll('[data-cp]').forEach(function (c) {
      c.oninput = function () { applyEdit(c.dataset.cp, c.value, true); syncColor(c.dataset.cp, c.value); };
      c.onchange = function () { if (dirty) saveDraft(true); };
    });
    R.querySelectorAll('[data-hex]').forEach(function (h) {
      h.oninput = function () {
        var v = h.value.trim();
        if (!/^#?[0-9a-fA-F]{6}$/.test(v)) return;
        if (v[0] !== '#') v = '#' + v;
        applyEdit(h.dataset.hex, v, true); syncColor(h.dataset.hex, v);
      };
    });
    R.querySelectorAll('[data-clear]').forEach(function (b) {
      b.onclick = function () { applyEdit(b.dataset.clear, ''); refreshInspector(); };
    });
    R.querySelectorAll('[data-pick]').forEach(function (b) {
      b.onclick = function () {
        openAssetPicker(function (url) { applyEdit(b.dataset.pick, url); refreshInspector(); });
      };
    });
    bindListControls(R);
  }

  // -------------------------------------------------------------- actions ---
  function select(id) {
    if (selected === id) { paintFrame(); return; }
    selected = id;
    tab = 'content';
    refreshLeft();
    refreshInspector();
    paintFrame();
  }
  function switchPage(p) {
    if (page === p) return;
    page = p;
    selected = null;
    tab = 'content';
    refreshAll();
  }
  function defaultsFor(type) {
    var d = defs[type];
    var props = d && d.defaults ? clone(d.defaults) : {};
    if (!props.style || typeof props.style !== 'object') props.style = {};
    if (isColumnsType(type)) {
      colSides({ type: type }).forEach(function (side) { if (!Array.isArray(props[side])) props[side] = []; });
    }
    return props;
  }
  function addBlock(type, listKey) {
    var list = listByKey(listKey || 'root');
    if (!list) return;
    pushSnap();
    var b = { id: newId(), type: type, props: defaultsFor(type) };
    list.push(b);
    selected = b.id;
    tab = 'content';
    markDirty();
    refreshAll();
  }
  function removeBlock(id) {
    var f = findBlock(id);
    if (!f) return;
    pushSnap();
    f.list.splice(f.index, 1);
    if (selected === id) selected = null;
    markDirty();
    refreshAll();
  }
  function moveBlock(listKey, from, to) {
    var list = listByKey(listKey);
    if (!list || from === to || to < 0 || to >= list.length) return;
    pushSnap();
    var b = list.splice(from, 1)[0];
    list.splice(to, 0, b);
    markDirty();
    refreshAll();
  }
  function reId(b) {
    b.id = newId();
    if (b.props && isColumns(b)) {
      colSides(b).forEach(function (side) {
        if (Array.isArray(b.props[side])) b.props[side].forEach(reId);
      });
    }
    return b;
  }
  function duplicate() {
    var f = selected ? findBlock(selected) : null;
    if (!f) return;
    pushSnap();
    var copy = reId(clone(f.block));
    f.list.splice(f.index + 1, 0, copy);
    selected = copy.id;
    markDirty();
    refreshAll();
    toast('Block duplicated');
  }

  function refreshAll() {
    refreshTop();
    refreshLeft();
    refreshInspector();
    applyScale();
    schedulePreview();
  }

  // ------------------------------------------------------------- keyboard ---
  function onKey(e) {
    var t = e.target || {};
    var tag = (t.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
    var mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Escape') {
      if (!$('ed-modal').hidden) { closeModal(); return; }
      closeMenus();
      if (typing && t.blur) t.blur();
      select(null);
      return;
    }
    if (typing) return; // let inputs keep their native editing keys
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return; }
    if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicate(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); removeBlock(selected); }
  }

  // ---------------------------------------------------------------- modal ---
  function openModal(title, bodyHtml, wide) {
    var m = $('ed-modal');
    m.innerHTML = '<div class="ed-modal__back"></div><div class="ed-modal__box' + (wide ? ' is-wide' : '') + '">' +
      '<div class="ed-modal__head"><h3>' + esc(title) + '</h3><button class="ed-iconbtn" data-close title="Close">' + svg('x', 16) + '</button></div>' +
      '<div class="ed-modal__body">' + bodyHtml + '</div></div>';
    m.hidden = false;
    m.querySelector('.ed-modal__back').onclick = closeModal;
    m.querySelector('[data-close]').onclick = closeModal;
    return m.querySelector('.ed-modal__body');
  }
  function closeModal() { var m = $('ed-modal'); m.hidden = true; m.innerHTML = ''; }

  // --------------------------------------------------------- asset picker ---
  function openAssetPicker(onPick) {
    var body = openModal('Images', '<div class="ed-assets" id="ed-assets"><div class="ed-hint">Loading…</div></div>' +
      '<div class="ed-assets__foot"><button class="ed-btn ed-btn--primary" id="ed-assup">' + svg('upload', 15) + ' Upload image</button>' +
      '<span class="ed-hint">…or drop a file anywhere in this panel.</span></div>', true);

    function paint() {
      var grid = $('ed-assets');
      grid.innerHTML = assets.length
        ? assets.map(function (a) {
            return '<div class="ed-asset" data-url="' + esc(a.url) + '" title="' + esc(a.filename) + '">' +
              '<img src="' + esc(a.url) + '" alt="" loading="lazy">' +
              '<div class="ed-asset__name">' + esc(a.filename) + '</div>' +
              '<button class="ed-asset__del" data-delasset="' + esc(a.id) + '" title="Delete image">' + svg('trash', 12) + '</button></div>';
          }).join('')
        : '<div class="ed-hint">No images yet — upload one.</div>';
      grid.querySelectorAll('[data-url]').forEach(function (el) {
        el.onclick = function () { onPick(el.dataset.url); closeModal(); };
      });
      grid.querySelectorAll('[data-delasset]').forEach(function (b) {
        b.onclick = function (e) {
          e.stopPropagation();
          if (!confirm('Delete this image? Blocks still pointing at it will break.')) return;
          api('/api/assets/' + b.dataset.delasset, { method: 'DELETE' })
            .then(function () { toast('Image deleted'); return reload(); })
            .catch(function (err) { toast(err.status === 409 ? 'That image is in use by a design' : err.message, true); });
        };
      });
    }
    function reload() {
      return soft('/api/assets').then(function (r) { assets = (r && r.assets) || []; paint(); });
    }
    function upload(file) {
      if (!file) return;
      var fd = new FormData();
      fd.append('file', file);
      toast('Uploading ' + file.name + '…');
      fetch('/api/assets', { method: 'POST', body: fd })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
        .then(function (a) { toast('Uploaded'); return reload().then(function () { onPick(a.url); closeModal(); }); })
        .catch(function (e) { toast(e.message, true); });
    }
    $('ed-assup').onclick = function () {
      var input = $('ed-file');
      input.value = '';
      input.onchange = function () { upload(input.files[0]); };
      input.click();
    };
    body.ondragover = function (e) { e.preventDefault(); body.classList.add('is-drop'); };
    body.ondragleave = function () { body.classList.remove('is-drop'); };
    body.ondrop = function (e) {
      e.preventDefault(); body.classList.remove('is-drop');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
    };
    reload();
  }

  // ------------------------------------------------------ designs actions ---
  function designAction(act) {
    if (act === 'new') return openTemplates();
    if (act === 'switch') return openSwitch();
    if (act === 'import') return importJson();
    if (act === 'dup') return duplicateDesign();
    if (act === 'activate') return activateDesign();
    if (act === 'discard') return discardDraft();
    if (act === 'delete') return deleteDesign();
  }
  function openTemplates() {
    var body = openModal('New design', '<div class="ed-hint">Loading templates…</div>');
    api('/api/designs/templates').then(function (r) {
      var list = (r.templates || []);
      body.innerHTML =
        '<div class="ed-field"><span class="ed-field__lbl">Name</span><input class="ed-input" id="ed-tplname" value="New design"></div>' +
        '<div class="ed-tpls">' + (list.length ? list.map(function (t) {
          return '<button class="ed-tpl" data-tpl="' + esc(t.key) + '">' + svg('layout-template', 18) +
            '<div><b>' + esc(t.name) + '</b><span>' + esc(t.description || '') + '</span></div></button>';
        }).join('') : '<div class="ed-hint">No templates offered by the server.</div>') + '</div>';
      body.querySelectorAll('[data-tpl]').forEach(function (b) {
        b.onclick = function () {
          var name = ($('ed-tplname').value || '').trim() || 'New design';
          b.disabled = true;
          api('/api/designs', { method: 'POST', body: { name: name, template: b.dataset.tpl } })
            .then(function (r2) { closeModal(); openDesign(r2.id); })
            .catch(function (e) { b.disabled = false; toast(e.message, true); });
        };
      });
    }).catch(function (e) { body.innerHTML = '<div class="ed-error">' + esc(e.message) + '</div>'; });
  }
  function openSwitch() {
    var body = openModal('Switch design', '<div class="ed-hint">Loading…</div>');
    api('/api/designs').then(function (r) {
      var list = r.designs || [];
      body.innerHTML = '<div class="ed-dlist">' + (list.length ? list.map(function (d) {
        return '<button class="ed-drow' + (d.id === design.id ? ' is-on' : '') + '" data-open="' + d.id + '">' +
          '<b>' + esc(d.name) + '</b>' + (d.is_active ? '<span class="ed-pill is-live">live</span>' : '') +
          (d.has_draft ? '<span class="ed-pill">draft</span>' : '') +
          '<span class="ed-drow__meta">v' + (d.version || 1) + ' · ' + esc((d.updated_at || '').slice(0, 16).replace('T', ' ')) + '</span></button>';
      }).join('') : '<div class="ed-hint">No designs yet.</div>') + '</div>';
      body.querySelectorAll('[data-open]').forEach(function (b) {
        b.onclick = function () { closeModal(); openDesign(b.dataset.open); };
      });
    }).catch(function (e) { body.innerHTML = '<div class="ed-error">' + esc(e.message) + '</div>'; });
  }
  function openDesign(id) {
    var go = function () { dirty = false; location.href = '/admin/editor.html?id=' + encodeURIComponent(id); };
    if (dirty) saveDraft(true).then(go); else go();
  }
  function importJson() {
    var input = $('ed-json');
    input.value = '';
    input.onchange = function () {
      var f = input.files[0];
      if (!f) return;
      f.text().then(function (t) {
        var obj;
        try { obj = JSON.parse(t); } catch (e) { throw new Error('That file is not valid JSON'); }
        return api('/api/designs/import', { method: 'POST', body: obj });
      }).then(function (r) { toast('Imported'); openDesign(r.id); })
        .catch(function (e) { toast(e.message, true); });
    };
    input.click();
  }
  function duplicateDesign() {
    if (!design.id) return;
    api('/api/designs/' + design.id + '/export')
      .then(function (obj) {
        if (obj && obj.name) obj.name = obj.name + ' copy';
        return api('/api/designs/import', { method: 'POST', body: obj });
      })
      .then(function (r) { toast('Duplicated'); openDesign(r.id); })
      .catch(function (e) { toast(e.message, true); });
  }
  function activateDesign() {
    if (!design.id) return;
    if (!confirm('Make “' + design.name + '” the live portal page?')) return;
    api('/api/designs/' + design.id + '/activate', { method: 'POST' })
      .then(function () { design.isActive = true; refreshTop(); toast('This design is now live'); })
      .catch(function (e) { toast(e.message, true); });
  }
  function deleteDesign() {
    if (!design.id) return;
    if (design.isActive) return toast('The live design cannot be deleted — set another one live first.', true);
    if (!confirm('Delete “' + design.name + '” permanently?')) return;
    api('/api/designs/' + design.id, { method: 'DELETE' })
      .then(function () { dirty = false; location.href = '/admin/editor.html'; })
      .catch(function (e) { toast(e.message, true); });
  }
  function discardDraft() {
    if (!design.id) return;
    if (!confirm('Throw away the unpublished draft and go back to the published version?')) return;
    api('/api/designs/' + design.id + '/draft', { method: 'DELETE' }).then(function () {
      return api('/api/designs/' + design.id);
    }).then(function (d) {
      model = normalize(clone(d.model));
      undoStack.length = 0; redoStack.length = 0;
      selected = null;
      design.version = d.version || design.version;
      design.draft = null;
      dirty = false; savedAt = null;
      refreshAll();
      toast('Draft discarded — back to the published version');
    }).catch(function (e) { toast(e.message, true); });
  }

  function publish() {
    if (!design.id) return toast('No design open', true);
    var btn = $('ed-publish');
    btn.disabled = true;
    api('/api/designs/' + design.id + '/publish', { method: 'POST', body: { model: model } })
      .then(function (r) {
        design.version = r.version || (design.version + 1);
        design.hasDraft = false;
        dirty = false;
        savedAt = null;
        refreshTop();
        toast('Published v' + design.version + ' — the portal is updated');
      })
      .catch(function (e) { toast(e.message, true); })
      .then(function () { btn.disabled = false; });
  }

  function loadVersions(menu) {
    menu.innerHTML = '<div class="ed-hint ed-hint--pad">Loading…</div>';
    if (!design.id) { menu.innerHTML = '<div class="ed-hint ed-hint--pad">No design open.</div>'; return; }
    api('/api/designs/' + design.id + '/versions').then(function (r) {
      var vs = r.versions || [];
      menu.innerHTML = vs.length ? vs.map(function (v) {
        return '<div class="ed-vrow"><span>v' + v.version + '</span>' +
          '<span class="ed-vrow__at">' + esc((v.created_at || '').slice(0, 16).replace('T', ' ')) + '</span>' +
          '<button data-rev="' + v.version + '">Revert</button></div>';
      }).join('') : '<div class="ed-hint ed-hint--pad">No published versions yet.</div>';
      menu.querySelectorAll('[data-rev]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Revert this design to v' + b.dataset.rev + '? The current draft is replaced.')) return;
          closeMenus();
          api('/api/designs/' + design.id + '/revert', { method: 'POST', body: { version: +b.dataset.rev } })
            .then(function () { return api('/api/designs/' + design.id); })
            .then(function (d) {
              applyDesignPayload(d);
              undoStack.length = 0; redoStack.length = 0;
              dirty = false; savedAt = null;
              refreshAll();
              toast('Reverted to v' + b.dataset.rev);
            })
            .catch(function (e) { toast(e.message, true); });
        };
      });
    }).catch(function (e) { menu.innerHTML = '<div class="ed-error">' + esc(e.message) + '</div>'; });
  }

  // ----------------------------------------------------------------- boot ---
  function applyDesignPayload(d) {
    design.id = d.id;
    design.name = d.name || 'Untitled';
    design.version = Number(d.version) || 0;
    design.hasDraft = !!d.draft;
    design.isActive = d.is_active != null ? !!d.is_active : design.isActive;
    model = normalize(clone(d.draft || d.model || {}));
  }

  function boot() {
    buildShell();
    var qid = new URLSearchParams(location.search).get('id');
    Promise.all([
      api('/api/blocks').catch(function (e) { bootError = 'Editor registry unavailable — GET /api/blocks failed (' + e.message + '). ' +
        'The Stage 0.12 server API is required.'; return null; }),
      soft('/api/plans'),
      soft('/api/assets'),
      soft('/api/plugins'),
      soft('/api/setup/state'),
      api(qid ? '/api/designs/' + encodeURIComponent(qid) : '/api/designs/active').catch(function () { return null; }),
      soft('/api/designs'),
    ]).then(function (res) {
      registry = res[0] || { blocks: [], styleFields: [], themeFields: [], theme: {}, fonts: [], accents: [], pageBgs: [] };
      (registry.blocks || []).forEach(function (b) { defs[b.type] = b; });
      plans = (res[1] && res[1].plans) || [];
      assets = (res[2] && res[2].assets) || [];
      plugins = (res[3] && res[3].plugins) || [];
      if (res[4] && res[4].router && res[4].router.server_name) host = String(res[4].router.server_name).split('|')[0];

      if (res[5]) applyDesignPayload(res[5]);
      else model = normalize({ theme: clone(registry.theme || {}), blocks: [] });

      // /api/designs/:id doesn't say whether it's the live one — the list does.
      var all = (res[6] && res[6].designs) || [];
      for (var i = 0; i < all.length; i++) {
        if (String(all[i].id) === String(design.id)) { design.isActive = !!all[i].is_active; break; }
      }

      refreshAll();
      if (!res[5] && !bootError) {
        toast('No design found — create one from a template.', true);
        openTemplates();
      }
    });
  }

  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', function () { if (dirty) saveDraft(true); });
  window.addEventListener('beforeunload', function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  boot();
})();
