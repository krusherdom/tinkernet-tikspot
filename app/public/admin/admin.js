/* Tikspot admin dashboard (vanilla SPA). Tabs: active users, plans, vouchers,
   accounts. Talks to the /api/* management endpoints. */
(function () {
  var view = document.getElementById('view');
  var toastsEl = document.getElementById('toasts');
  var noticesEl = document.getElementById('notices');
  var logSub = 'auth';

  // ---- helpers ----
  function api(path, opts) {
    opts = opts || {};
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
      opts.body = JSON.stringify(opts.body);
    }
    var exempt = path === '/api/auth/status' || path === '/api/auth/login';
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        if (t) { try { j = JSON.parse(t); } catch (e) { j = {}; } }
        if (!r.ok) {
          if (r.status === 401 && !exempt) { renderLogin(); }
          var msg = j.error || ('HTTP ' + r.status);
          var err = new Error(msg);
          err.status = r.status;
          if (j.fields) err.fields = j.fields;
          if (j.hint) err.hint = j.hint;
          throw err;
        }
        return j;
      });
    });
  }
  function toast(msg, opts) {
    var level = 'info';
    if (opts === true) level = 'err';
    else if (opts && opts.level) level = opts.level;
    var el = document.createElement('div');
    el.className = 'toast toast-' + level;
    el.textContent = msg;
    toastsEl.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    while (toastsEl.children.length > 3) toastsEl.removeChild(toastsEl.firstChild);
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, 2600);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function mb(bytes) { return bytes == null ? '∞' : (bytes / 1048576).toFixed(bytes < 1048576 ? 1 : 0) + ' MB'; }
  function octets(o) { o = o || 0; return o >= 1048576 ? (o / 1048576).toFixed(1) + ' MB' : (o / 1024).toFixed(0) + ' KB'; }
  function mins(secs) { return secs == null ? '∞' : Math.round(secs / 60) + ' min'; }
  function planLimits(p) {
    var b = [];
    if (p.rate_limit) b.push(p.rate_limit);
    if (p.total_limit_bytes != null) b.push(mb(p.total_limit_bytes));
    if (p.expiry_mode === 'midnight') b.push('renews at midnight');
    else if (p.session_timeout_secs != null) b.push(mins(p.session_timeout_secs));
    return b.join(' · ') || '—';
  }

  // ---- tabs ----
  var tabs = {};

  tabs.active = function () {
    Promise.all([api('/api/active'), api('/api/usage')]).then(function (res) {
      var act = res[0].active, usage = res[1].usage;
      var rows = act.length
        ? act.map(function (s) {
            return '<tr><td class="mono">' + esc(s.username) + '</td><td class="mono">' + esc(s.mac || '—') +
              '</td><td class="mono">' + esc(s.ip || '—') + '</td><td>' + esc(s.acctstarttime || '—') +
              '</td><td>' + octets(s.total_octets) + '</td><td><button class="btn sm danger" data-kick="' +
              esc(s.acctsessionid) + '">Kick</button></td></tr>';
          }).join('')
        : '<tr><td colspan="6" class="empty">No active sessions. (They appear here once the hotspot sends accounting.)</td></tr>';
      var usageRows = usage.length
        ? usage.map(function (u) {
            return '<tr><td class="mono">' + esc(u.username) + '</td><td>' + u.sessions + '</td><td>' +
              octets(u.total_octets) + '</td><td>' + esc(u.last_start || '—') + '</td></tr>';
          }).join('')
        : '<tr><td colspan="4" class="empty">No usage recorded yet.</td></tr>';
      view.innerHTML =
        '<h1>Active users</h1><p class="sub">Live sessions from RADIUS accounting. Kick sends a CoA Disconnect to the router.</p>' +
        '<div class="card"><table><thead><tr><th>User</th><th>MAC</th><th>IP</th><th>Started</th><th>Usage</th><th></th></tr></thead><tbody>' +
        rows + '</tbody></table></div>' +
        '<div class="card"><h2>Usage by user</h2><table><thead><tr><th>User</th><th>Sessions</th><th>Total</th><th>Last seen</th></tr></thead><tbody>' +
        usageRows + '</tbody></table></div>';
      view.querySelectorAll('[data-kick]').forEach(function (b) {
        b.onclick = function () {
          b.disabled = true;
          api('/api/active/' + encodeURIComponent(b.dataset.kick) + '/kick', { method: 'POST' })
            .then(function (r) { toast(r.ok ? 'User disconnected' : 'Kick sent (no ACK): ' + r.output, !r.ok); tabs.active(); })
            .catch(function (e) { toast(e.message, true); b.disabled = false; });
        };
      });
    }).catch(function (e) { toast(e.message, true); });
  };

  tabs.plans = function () {
    api('/api/plans').then(function (r) {
      var rows = r.plans.map(function (p) {
        var del = p.radius_groupname === 'free' ? '' :
          '<button class="btn sm danger" data-del="' + p.id + '">Delete</button>';
        return '<tr><td>' + esc(p.name) + '</td><td><span class="muted">' + esc(p.kind) + '</span></td><td>' +
          planLimits(p) + '</td><td>' + (p.mac_remember ? 'yes' : 'no') + '</td><td>' + p.members + '</td><td>' + del + '</td></tr>';
      }).join('');
      view.innerHTML =
        '<h1>Plans</h1><p class="sub">A plan = a set of MikroTik limits (speed / data / time). Vouchers and accounts attach to a plan.</p>' +
        '<div class="card"><table><thead><tr><th>Name</th><th>Kind</th><th>Limits</th><th>MAC</th><th>Members</th><th></th></tr></thead><tbody>' +
        rows + '</tbody></table></div>' +
        '<div class="card"><h2>New plan</h2><div class="row">' +
        field('p-name', 'Name', '<input id="p-name" placeholder="e.g. Day pass">') +
        field('p-rate', 'Rate limit', '<input id="p-rate" placeholder="5M/5M">') +
        field('p-data', 'Data (MB)', '<input id="p-data" type="number" placeholder="∞">') +
        field('p-time', 'Time (min)', '<input id="p-time" type="number" placeholder="∞">') +
        field('p-expiry', 'Expiry', '<select id="p-expiry"><option value="fixed">Fixed time</option><option value="midnight">At midnight (daily)</option></select>') +
        field('p-mac', 'Remember MAC', '<select id="p-mac"><option value="0">no</option><option value="1">yes</option></select>') +
        '<button class="btn primary" id="p-add">Add plan</button></div></div>';
      // "At midnight" replaces the fixed time limit, so disable the Time field for it.
      var pExpiry = view.querySelector('#p-expiry');
      pExpiry.onchange = function () {
        var t = view.querySelector('#p-time');
        t.disabled = pExpiry.value === 'midnight';
        t.placeholder = pExpiry.value === 'midnight' ? 'renews at midnight' : '∞';
      };
      view.querySelector('#p-add').onclick = function () {
        var midnight = val('p-expiry') === 'midnight';
        var body = {
          name: val('p-name'), rate_limit: val('p-rate') || null,
          total_limit_bytes: numOrNull('p-data', 1048576),
          session_timeout_secs: midnight ? null : numOrNull('p-time', 60),
          mac_remember: val('p-mac') === '1',
          expiry_mode: val('p-expiry'),
        };
        if (!body.name) return toast('Name required', true);
        api('/api/plans', { method: 'POST', body: body }).then(function () { toast('Plan added'); tabs.plans(); }).catch(function (e) { toast(e.message, true); });
      };
      view.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Delete this plan?')) return;
          api('/api/plans/' + b.dataset.del, { method: 'DELETE' }).then(function () { toast('Deleted'); tabs.plans(); }).catch(function (e) { toast(e.message, true); });
        };
      });
    }).catch(function (e) { toast(e.message, true); });
  };

  function voucherRows(vouchers) {
    if (!vouchers.length) return '<tr><td colspan="6" class="empty">No vouchers yet — generate a batch above.</td></tr>';
    return vouchers.map(function (v) {
      var st = v.validity || v.status;
      var rev = (st === 'unused' || st === 'active' || st === 'scheduled') ? '<button class="btn sm danger" data-rev="' + v.id + '">Revoke</button>' : '';
      var win = (v.valid_from || v.valid_until)
        ? esc((v.valid_from || '').slice(0, 10) || '∞') + ' → ' + esc((v.valid_until || '').slice(0, 10) || '∞')
        : '<span class="muted">—</span>';
      return '<tr><td class="mono">' + esc(v.code) + '</td><td>' + esc(v.plan_name || '—') + '</td><td><span class="pill ' +
        st + '">' + st + '</span></td><td class="muted">' + win + '</td><td class="muted">' + esc(v.batch_id || '') + '</td><td>' + rev + '</td></tr>';
    }).join('');
  }
  function bindRevoke() {
    view.querySelectorAll('[data-rev]').forEach(function (b) {
      b.onclick = function () {
        api('/api/vouchers/' + b.dataset.rev + '/revoke', { method: 'POST' })
          .then(function () { toast('Revoked'); tabs.vouchers(); }).catch(function (e) { toast(e.message, true); });
      };
    });
  }

  tabs.vouchers = function () {
    Promise.all([api('/api/plans'), api('/api/vouchers')]).then(function (res) {
      var plans = res[0].plans, vouchers = res[1].vouchers;
      var planOpts = plans.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('');
      view.innerHTML =
        '<h1>Vouchers</h1><p class="sub">Generate printable codes tied to a plan. Each code is a one-line login. Add a date window for time-limited campaigns.</p>' +
        '<div class="card"><h2>Generate batch</h2><div class="row">' +
        field('v-plan', 'Plan', '<select id="v-plan">' + planOpts + '</select>') +
        field('v-count', 'Count', '<input id="v-count" type="number" value="10" min="1" max="1000">') +
        field('v-len', 'Code length', '<input id="v-len" type="number" value="8" min="4" max="16">') +
        field('v-from', 'Valid from (optional)', '<input id="v-from" type="date">') +
        field('v-until', 'Valid until (optional)', '<input id="v-until" type="date">') +
        '<button class="btn primary" id="v-gen"' + (plans.length ? '' : ' disabled') + '>Generate</button></div>' +
        (plans.length ? '' : '<p class="muted" style="margin-top:10px">Create a plan first.</p>') +
        '<div id="v-out"></div></div>' +
        '<div class="card"><table><thead><tr><th>Code</th><th>Plan</th><th>Status</th><th>Valid</th><th>Batch</th><th></th></tr></thead>' +
        '<tbody id="v-tbody">' + voucherRows(vouchers) + '</tbody></table></div>';
      bindRevoke();
      var gen = view.querySelector('#v-gen');
      if (gen) gen.onclick = function () {
        gen.disabled = true;
        api('/api/vouchers/batch', { method: 'POST', body: { plan_id: Number(val('v-plan')), count: Number(val('v-count')), length: Number(val('v-len')), valid_from: val('v-from') || null, valid_until: val('v-until') || null } })
          .then(function (r) {
            var codes = r.codes.map(function (c) { return '<div class="c">' + esc(c) + '</div>'; }).join('');
            view.querySelector('#v-out').innerHTML =
              '<p class="muted" style="margin-top:14px">Batch <b>' + esc(r.batch_id) + '</b> · ' + r.count + ' codes · ' + esc(r.plan) +
              ' &nbsp;<a class="btn sm" href="/api/vouchers/print?batch=' + encodeURIComponent(r.batch_id) + '" target="_blank">Print</a></p>' +
              '<div class="codes">' + codes + '</div>';
            toast('Generated ' + r.count + ' vouchers');
            gen.disabled = false;
            api('/api/vouchers').then(function (rr) { view.querySelector('#v-tbody').innerHTML = voucherRows(rr.vouchers); bindRevoke(); });
          }).catch(function (e) { toast(e.message, true); gen.disabled = false; });
      };
    }).catch(function (e) { toast(e.message, true); });
  };

  tabs.accounts = function () {
    Promise.all([api('/api/plans'), api('/api/accounts')]).then(function (res) {
      var plans = res[0].plans, accounts = res[1].accounts;
      var planOpts = '<option value="">(no plan)</option>' + plans.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('');
      var rows = accounts.length ? accounts.map(function (a) {
        return '<tr><td class="mono">' + esc(a.username) + '</td><td>' + esc(a.plan_name || '—') + '</td><td><span class="pill ' +
          (a.enabled ? 'on">enabled' : 'off">disabled') + '</span></td><td>' +
          '<button class="btn sm" data-toggle="' + a.id + '" data-en="' + a.enabled + '">' + (a.enabled ? 'Disable' : 'Enable') + '</button> ' +
          '<button class="btn sm danger" data-del="' + a.id + '">Delete</button></td></tr>';
      }).join('') : '<tr><td colspan="4" class="empty">No accounts yet.</td></tr>';
      view.innerHTML =
        '<h1>Accounts</h1><p class="sub">Named username/password logins (e.g. staff or paid users).</p>' +
        '<div class="card"><h2>New account</h2><div class="row">' +
        field('a-user', 'Username', '<input id="a-user" autocomplete="off">') +
        field('a-pass', 'Password', '<input id="a-pass" autocomplete="off">') +
        field('a-plan', 'Plan', '<select id="a-plan">' + planOpts + '</select>') +
        '<button class="btn primary" id="a-add">Add account</button></div></div>' +
        '<div class="card"><table><thead><tr><th>Username</th><th>Plan</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      view.querySelector('#a-add').onclick = function () {
        var body = { username: val('a-user'), password: val('a-pass'), plan_id: val('a-plan') ? Number(val('a-plan')) : null };
        if (!body.username || !body.password) return toast('Username and password required', true);
        api('/api/accounts', { method: 'POST', body: body }).then(function () { toast('Account added'); tabs.accounts(); }).catch(function (e) { toast(e.message, true); });
      };
      view.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () { if (!confirm('Delete account?')) return; api('/api/accounts/' + b.dataset.del, { method: 'DELETE' }).then(function () { toast('Deleted'); tabs.accounts(); }).catch(function (e) { toast(e.message, true); }); };
      });
      view.querySelectorAll('[data-toggle]').forEach(function (b) {
        b.onclick = function () { api('/api/accounts/' + b.dataset.toggle, { method: 'PATCH', body: { enabled: b.dataset.en !== '1' } }).then(function () { tabs.accounts(); }).catch(function (e) { toast(e.message, true); }); };
      });
    }).catch(function (e) { toast(e.message, true); });
  };

  tabs.devices = function () {
    api('/api/mac').then(function (r) {
      var rows = r.mac_sessions.length ? r.mac_sessions.map(function (m) {
        return '<tr><td class="mono">' + esc(m.mac) + '</td><td class="mono">' + esc(m.identity || '—') +
          '</td><td>' + esc(m.plan_name || '—') + '</td><td>' + esc(m.expires_at) + '</td>' +
          '<td><button class="btn sm danger" data-forget="' + esc(m.mac) + '">Forget</button></td></tr>';
      }).join('') : '<tr><td colspan="5" class="empty">No remembered devices. They appear when someone logs in on a MAC-remember plan.</td></tr>';
      view.innerHTML = '<h1>Remembered devices</h1><p class="sub">Devices that auto-reconnect by MAC until their window expires. Forgetting one sends them back to the portal.</p>' +
        '<div class="card"><table><thead><tr><th>MAC</th><th>First login</th><th>Plan</th><th>Expires</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      view.querySelectorAll('[data-forget]').forEach(function (b) {
        b.onclick = function () { api('/api/mac/' + encodeURIComponent(b.dataset.forget), { method: 'DELETE' }).then(function () { toast('Device forgotten'); tabs.devices(); }).catch(function (e) { toast(e.message, true); }); };
      });
    }).catch(function (e) { toast(e.message, true); });
  };

  // Router-config form (shared by the wizard and the Router setup tab).
  var ROUTER_FIELD_MAP = { scheme: 'r-scheme', host: 'r-host', username: 'r-user', container_ip: 'r-cip', server_name: 'r-sn', nas_secret: 'r-sec' };
  function routerFormHtml(st) {
    st = st || {};
    var s = st.router || {};
    var hasSecret = !!st.has_nas_secret;
    return '<div class="row">' +
      fieldH('r-scheme', 'Scheme', '<select id="r-scheme"><option value="https"' + (s.scheme === 'https' ? ' selected' : '') + '>https</option><option value="http"' + (s.scheme === 'http' ? ' selected' : '') + '>http</option></select>', 'https needs <code>/ip service enable www-ssl</code> on the router.') +
      fieldH('r-host', 'Router host/IP', '<input id="r-host" value="' + esc(s.host || '') + '" placeholder="192.168.88.1">', 'The router\'s LAN address as seen from this container.') +
      fieldH('r-user', 'API user', '<input id="r-user" value="' + esc(s.username || 'admin') + '">', 'Use a <code>full</code> user for setup, then <code>/user set [find name=X] group=read</code>.') +
      field('r-pass', 'API password', '<input id="r-pass" type="password" placeholder="(unchanged)">') +
      '</div><div class="row" style="margin-top:10px">' +
      fieldH('r-cip', 'Container IP', '<input id="r-cip" value="' + esc(s.container_ip || st.detected_ip || '') + '" placeholder="' + esc(st.detected_ip || '172.18.0.2') + '">',
        'This container\'s own address on the router\'s bridge.' + (st.detected_ip ? ' Detected from inside the container: <code>' + esc(st.detected_ip) + '</code>' + (s.container_ip && s.container_ip !== st.detected_ip ? ' — <b>differs from the saved value</b>.' : '.') : '')) +
      fieldH('r-sn', 'Hotspot server-name', '<input id="r-sn" value="' + esc(s.server_name || '') + '" placeholder="hotspot.tikspot">', '<code>host|label</code> format — never a <code>.local</code> name.') +
      '<div class="field"><label for="r-sec">RADIUS secret</label><div class="row" style="gap:8px;align-items:center;flex-wrap:nowrap">' +
      '<input id="r-sec" placeholder="shared secret" style="flex:1;min-width:0">' +
      '<span class="pill ' + (hasSecret ? 'set' : 'notset') + '">' + (hasSecret ? 'set' : 'not set') + '</span>' +
      '<button type="button" class="btn sm" id="r-rotate">Rotate</button>' +
      '</div></div>' +
      '</div>';
  }
  function saveRouter() {
    clearFieldErrors();
    var body = { scheme: val('r-scheme'), host: val('r-host'), username: val('r-user'),
      container_ip: val('r-cip'), server_name: val('r-sn') };
    if (val('r-pass')) body.password = val('r-pass');
    if (val('r-sec')) body.nas_secret = val('r-sec');
    return api('/api/setup/router', { method: 'POST', body: body }).then(function (r) {
      if (r && r.warning) toast(r.warning, { level: 'warn' });
      return r;
    }).catch(function (e) {
      if (e.fields) showFieldErrors(e.fields, ROUTER_FIELD_MAP);
      throw e;
    });
  }
  function bindRotate(root) {
    var btn = root.querySelector('#r-rotate');
    if (!btn) return;
    btn.onclick = function () {
      if (!confirm('Rotate the RADIUS shared secret? You must re-run Auto-configure afterwards to push the new secret to the router.')) return;
      btn.disabled = true;
      api('/api/setup/rotate-secret', { method: 'POST' }).then(function (r) {
        toast(r.note || 'Secret rotated', r.degraded ? { level: 'warn' } : { level: 'ok' });
        if (r.warning) toast(r.warning, { level: 'warn' });
        var pill = root.querySelector('#r-sec').parentNode.querySelector('.pill');
        if (pill) { pill.className = 'pill set'; pill.textContent = 'set'; }
        btn.disabled = false;
      }).catch(function (e) { toast(e.message, true); btn.disabled = false; });
    };
  }

  // Render the per-component Verify result: status is pass / fail / unknown.
  function renderVerify(r) {
    var checks = (r && r.checks) || [];
    if (!checks.length) return '<span class="bad">No checks returned.</span>';
    var head = '<p class="' + (r.ok ? 'ok' : 'bad') + '">' + (r.ok ? '✓ All required components are configured' : '✗ Some required components are missing') + '</p>';
    return head + '<div class="v-list">' + checks.map(function (c) {
      var cls = c.status === 'pass' ? 'v-pass' : c.status === 'fail' ? 'v-fail' : 'v-unknown';
      var mark = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '○';
      var line = '<div class="v-row ' + cls + '"><div class="v-head">' + mark + ' ' + esc(c.component) + (c.required ? '' : ' <span class="muted">(optional)</span>') + '</div>';
      if (c.status === 'pass' && c.raw) line += '<code class="v-raw">' + esc(c.raw) + '</code>';
      if (c.status === 'fail' && c.detail) line += '<div class="muted v-detail">' + esc(c.detail) + '</div>';
      if (c.status === 'unknown') line += '<div class="muted v-detail">couldn\'t read' + (c.detail ? ': ' + esc(c.detail) : '') + '</div>';
      if (c.hint) line += '<div class="muted v-hint">' + esc(c.hint) + '</div>';
      if (c.docs) line += '<div><a href="' + esc(c.docs) + '" target="_blank" rel="noopener">docs</a></div>';
      return line + '</div>';
    }).join('') + '</div>';
  }
  // Render Auto-configure's per-step results as done/failed/skipped pills.
  function renderSteps(steps) {
    steps = steps || [];
    if (!steps.length) return '<p class="muted">No steps returned.</p>';
    return '<div class="v-list">' + steps.map(function (s) {
      var pc = s.status === 'done' ? 'on' : s.status === 'failed' ? 'off' : 'warn';
      return '<div class="v-row"><div class="v-head"><span class="pill ' + pc + '">' + esc(s.status) + '</span> <b>' + esc(s.step) + '</b></div>' +
        (s.detail ? '<div class="muted v-detail">' + esc(s.detail) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }
  // Shared "manual setup script" card, used by the Router tab and the wizard.
  function scriptCardHtml() {
    return '<div class="card"><h2>Manual setup script</h2><p class="muted">Prefer not to give the container write access? Generate the idempotent RouterOS commands and paste them into the router terminal instead of Auto-configure (safe to re-run).</p>' +
      '<button class="btn" id="r-script">Generate setup script</button><div id="r-script-out" style="margin-top:12px"></div></div>';
  }
  function bindScript(root) {
    var btn = root.querySelector('#r-script');
    if (!btn) return;
    btn.onclick = function () {
      var o = root.querySelector('#r-script-out');
      o.innerHTML = '<p class="muted">Generating…</p>';
      api('/api/setup/script').then(function (r) {
        var script = r.script || '';
        o.innerHTML = '<div class="row" style="gap:8px;margin-bottom:8px"><button class="btn sm" id="r-script-copy">Copy</button>' +
          '<a class="btn sm" id="r-script-dl" download="tikspot-setup.rsc">Download .rsc</a>' +
          '<span class="muted">Contains your RADIUS secret — handle accordingly.</span></div>' +
          '<pre class="cfg">' + esc(script) + '</pre>';
        o.querySelector('#r-script-dl').href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(script);
        o.querySelector('#r-script-copy').onclick = function () {
          navigator.clipboard.writeText(script).then(function () { toast('Copied'); }).catch(function () { toast('Copy failed', true); });
        };
      }).catch(function (e) { o.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
    };
  }

  // Render the router objects Tikspot manages, grouped by type.
  function renderManaged(objs) {
    objs = objs || {};
    var labels = { 'radius': 'RADIUS client', 'dns-static': 'DNS static', 'hotspot-profile': 'Hotspot profile', 'walled-garden-ip': 'Walled-garden IP', 'walled-garden-host': 'Walled-garden host' };
    var order = ['radius', 'dns-static', 'hotspot-profile', 'walled-garden-ip', 'walled-garden-host'];
    var total = 0, html = '';
    order.forEach(function (key) {
      var rows = objs[key] || [];
      total += rows.length;
      if (!rows.length) return;
      html += '<h3 style="margin:14px 0 6px">' + esc(labels[key] || key) + ' <span class="muted">(' + rows.length + ')</span></h3>';
      html += '<table><tbody>' + rows.map(function (r) {
        var pairs = Object.keys(r).filter(function (k) { return k !== 'id' && k !== 'comment'; })
          .map(function (k) { return '<span class="mono">' + esc(k) + '</span>=' + esc(String(r[k] == null ? '' : r[k])); }).join(' &nbsp;·&nbsp; ');
        return '<tr><td>' + pairs + '</td></tr>';
      }).join('') + '</tbody></table>';
    });
    if (!total) return '<p class="empty">No Tikspot-tagged objects found on the router yet — run Auto-configure first.</p>';
    return html;
  }

  tabs.router = function () {
    api('/api/setup/state').then(function (st) {
      view.innerHTML = '<h1>Router setup</h1><p class="sub">Point the container at your MikroTik so it can auto-configure RADIUS, the hotspot profile, DNS and the walled-garden.</p>' +
        '<div class="card"><h2>Connection</h2>' + routerFormHtml(st) +
        '<div class="row" style="margin-top:14px">' +
        '<button class="btn" id="r-save">Save</button>' +
        '<button class="btn" id="r-probe">Test connection</button>' +
        '<button class="btn primary" id="r-auto">Auto-configure</button>' +
        '<button class="btn" id="r-verify">Verify</button></div>' +
        '<p class="muted" style="margin-top:10px">Tip: use a dedicated API user (group <span class="mono">full</span>) for setup. Once Auto-configure (or the manual script below) succeeds and <b>Verify</b> is green, downgrade it to read-only on the router: <span class="mono">/user set [find name=&lt;user&gt;] group=read</span>. Tikspot only needs read access afterwards (health, Verify, active users); re-running setup or pushing hotspot files needs <span class="mono">full</span> again.</p>' +
        '<div id="r-out" style="margin-top:12px"></div></div>' +
        scriptCardHtml() +
        '<div class="card"><h2>Tikspot router objects</h2><p class="muted">Everything Tikspot configured on the router is tagged with a "Tikspot portal (managed…)" comment. Query it here to audit what\'s in place.</p>' +
        '<button class="btn" id="r-objs">Query router objects</button><div id="r-objs-out" style="margin-top:12px"></div></div>';
      var out = view.querySelector('#r-out');
      bindScript(view);
      bindRotate(view);
      view.querySelector('#r-objs').onclick = function () {
        var o = view.querySelector('#r-objs-out');
        o.innerHTML = '<p class="muted">Querying…</p>';
        api('/api/setup/router-objects').then(function (r) { o.innerHTML = renderManaged(r.objects); })
          .catch(function (e) { o.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
      };
      view.querySelector('#r-save').onclick = function () { saveRouter().then(function () { toast('Saved', { level: 'ok' }); }).catch(function (e) { toast(e.message, true); }); };
      view.querySelector('#r-probe').onclick = function () {
        out.innerHTML = '<p class="muted">Testing…</p>';
        saveRouter().then(function () { return api('/api/setup/probe', { method: 'POST' }); }).then(function (r) {
          var html = '<span class="ok">Connected — RouterOS ' + esc(r.version || '') + ' ' + esc(r.board || '') + '</span>';
          if (r.canWrite === false) html += '<div class="notice-line warn" style="margin-top:8px"><span class="dot"></span> <span>API user looks read-only — Auto-configure will fail; use the setup script or a <span class="mono">full</span> user.</span></div>';
          out.innerHTML = html;
        }).catch(function (e) { out.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
      };
      view.querySelector('#r-auto').onclick = function () {
        out.innerHTML = '<p class="muted">Configuring…</p>';
        saveRouter().then(function () { return api('/api/setup/autoconfig', { method: 'POST' }); }).then(function (r) {
          var html = renderSteps(r.steps);
          if (r.error) html += '<p class="bad" style="margin-top:8px">' + esc(r.error) + '</p>';
          if (r.warning) html += '<p style="margin-top:8px;color:var(--amber)">' + esc(r.warning) + '</p>';
          out.innerHTML = html;
          toast(r.ok ? 'Router configured' : 'Auto-configure had errors', { level: r.ok ? 'ok' : 'warn' });
          if (r.unreachable) return;
          var vp = document.createElement('p'); vp.className = 'muted'; vp.textContent = 'Verifying…';
          out.appendChild(vp);
          return api('/api/setup/verify', { method: 'POST' }).then(function (v) {
            vp.remove();
            out.insertAdjacentHTML('beforeend', renderVerify(v));
          });
        }).catch(function (e) { out.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
      };
      view.querySelector('#r-verify').onclick = function () {
        out.innerHTML = '<p class="muted">Verifying…</p>';
        saveRouter().then(function () { return api('/api/setup/verify', { method: 'POST' }); })
          .then(function (r) { out.innerHTML = renderVerify(r); })
          .catch(function (e) { out.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
      };
    }).catch(function (e) { toast(e.message, true); });
  };

  // ---- system / health ----
  function card(title, body) { return '<div class="card"><h2>' + esc(title) + '</h2>' + body + '</div>'; }
  function kv(pairs) {
    return '<table>' + pairs.map(function (p) {
      return '<tr><td class="muted" style="width:170px">' + esc(p[0]) + '</td><td>' + (p[2] ? p[1] : esc(p[1])) + '</td></tr>';
    }).join('') + '</table>';
  }
  function fmtUptime(s) {
    s = Number(s) || 0; var d = Math.floor(s / 86400); s %= 86400; var h = Math.floor(s / 3600); var m = Math.floor((s % 3600) / 60);
    return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
  }
  tabs.system = function () {
    view.innerHTML = '<h1>System</h1><p class="sub">Container + MikroTik health. This is also what a backup captures about the device.</p><div id="sys"><p class="muted">Loading…</p></div>';
    api('/api/system/health').then(function (h) {
      var c = h.container || {};
      var html = card('This container', kv([
        ['Tikspot version', 'v' + (c.version || '')],
        ['Node runtime', c.node || '—'],
        ['App uptime', fmtUptime(c.uptimeSecs)],
        ['/data free', c.data ? (octets(c.data.freeBytes) + ' free of ' + octets(c.data.totalBytes)) : '—'],
      ]));
      var svc = h.services || {};
      function svcPill(s) {
        s = s || {};
        if (s.ok === true) return '<span class="pill on">ok</span>';
        if (s.ok === false) return '<span class="pill off">fail</span>';
        return '<span class="pill warn">unknown outside container</span>';
      }
      html += card('Services', kv([
        ['RADIUS daemon', svcPill(svc.radiusd) + (svc.radiusd && svc.radiusd.method ? ' <span class="muted">via ' + esc(svc.radiusd.method) + '</span>' : '') + (svc.radiusd && svc.radiusd.detail ? ' <span class="muted">' + esc(svc.radiusd.detail) + '</span>' : ''), true],
        ['Database', svcPill(svc.db) + (svc.db && svc.db.detail ? ' <span class="muted">' + esc(svc.db.detail) + '</span>' : ''), true],
      ]) + (svc.db && svc.db.counts ? '<p class="muted" style="margin-top:8px">Rows — ' + Object.keys(svc.db.counts).map(function (k) { return esc(k) + ': ' + svc.db.counts[k]; }).join(' · ') + '</p>' : ''));
      var eg = h.egress || {};
      if (!eg.configured) {
        html += card('Egress', '<p class="muted">Not configured — set an Egress check URL on the <a href="#settings" data-tab="settings">Settings</a> tab to confirm the container can reach the internet (needed for lookup plugins).</p>');
      } else {
        html += card('Egress', kv([
          ['Status', (eg.ok ? '<span class="pill on">ok</span>' : '<span class="pill off">fail</span>') +
            (eg.status ? ' <span class="muted">HTTP ' + esc(String(eg.status)) + '</span>' : '') +
            (eg.error ? ' <span class="muted">' + esc(eg.error) + '</span>' : ''), true],
        ]));
      }
      if (!h.routerConfigured) {
        html += '<div class="card"><p class="muted">No router connection configured — add it on the <a href="#router" data-tab="router">Router setup</a> tab to see MikroTik CPU/memory, clock &amp; NTP, and where this container is mounted.</p></div>';
      } else if (h.error && !h.router) {
        html += '<div class="card"><p class="bad">Couldn\'t reach the router: ' + esc(h.error) + '</p></div>';
      } else {
        var r = h.router || {};
        html += card('Router resources', kv([
          ['Board', r.board || '—'], ['RouterOS', r.version || '—'], ['Architecture', r.arch || '—'],
          ['CPU load', r.cpuLoad != null ? r.cpuLoad + '%' : '—'],
          ['Memory used', (r.totalMemory && r.freeMemory != null) ? (octets(r.totalMemory - r.freeMemory) + ' / ' + octets(r.totalMemory)) : '—'],
          ['Uptime', r.uptime || '—'],
        ]));
        html += card('Clock &amp; NTP', kv([
          ['Router time', h.clock ? (h.clock.date + ' ' + h.clock.time) : '—'],
          ['Timezone', h.clock ? h.clock.timezone : '—'],
          ['NTP enabled', h.ntp ? h.ntp.enabled : '—'],
          ['NTP status', h.ntp ? h.ntp.status : '—'],
          ['NTP servers', h.ntp ? (h.ntp.servers || '—') : '—'],
        ]));
        if (h.ntpOk === false) html += '<div class="card" style="border-color:var(--amber)"><b style="color:var(--amber)">⚠ Router NTP is not synchronised.</b> <span class="muted">Date-gated vouchers rely on the MikroTik\'s clock — enable and sync NTP on the router.</span></div>';
        var pl = h.placement || {}, pc = pl.container, pv = pl.veth;
        html += card('This container on the router', kv([
          ['Container IP', pl.containerIp || '—'],
          ['Container name', pc ? pc.name : '—'],
          ['Status', pc ? pc.status : '—'],
          ['Root dir', pc ? (pc.rootDir || '—') : '—'],
          ['Mounts', pc ? (pc.mounts || '—') : '—'],
          ['veth', pv ? (pv.name + '  ' + pv.address) : '—'],
        ]));
      }
      document.getElementById('sys').innerHTML = html;
    }).catch(function (e) { toast(e.message, true); document.getElementById('sys').innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  };

  // ---- logs (sub-tabbed: auth, admin, events, reports, storage) ----
  var LOG_SUBS = [['auth', 'Auth'], ['admin', 'Admin activity'], ['events', 'Events'], ['reports', 'Reports'], ['storage', 'Storage']];
  function logSubnav() {
    return '<div class="subnav">' + LOG_SUBS.map(function (s) {
      return '<button type="button" class="subnav-b' + (logSub === s[0] ? ' is-on' : '') + '" data-sub="' + s[0] + '">' + s[1] + '</button>';
    }).join('') + '</div>';
  }
  function renderLogsAuth(body) {
    api('/api/logs/auth').then(function (r) {
      var rows = r.attempts.length ? r.attempts.map(function (a) {
        return '<tr><td class="muted">' + esc(a.authdate || '') + '</td><td class="mono">' + esc(a.username) + '</td><td><span class="pill ' + (a.accept ? 'on">accept' : 'off">reject') + '</span></td></tr>';
      }).join('') : '<tr><td colspan="3" class="empty">No RADIUS attempts logged yet — connect a client through the hotspot, or run a test login.</td></tr>';
      body.innerHTML =
        '<p class="sub">Recent RADIUS authentication attempts (from FreeRADIUS). Use this to confirm the router is actually reaching Tikspot.</p>' +
        '<div class="card"><div class="row" style="gap:32px">' +
        '<div><div class="muted">Accepted (24h)</div><div style="font-size:24px;color:var(--lime)">' + r.accepts24h + '</div></div>' +
        '<div><div class="muted">Rejected (24h)</div><div style="font-size:24px;color:var(--red)">' + r.rejects24h + '</div></div>' +
        '<div><div class="muted">Total logged</div><div style="font-size:24px">' + r.total + '</div></div></div></div>' +
        '<div class="card"><table><thead><tr><th>Time</th><th>Username</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }).catch(function (e) { body.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function renderLogsAdmin(body) {
    api('/api/logs/admin').then(function (r) {
      var rows = r.entries.length ? r.entries.map(function (a) {
        return '<tr><td class="muted">' + esc(a.created_at || '') + '</td><td class="mono">' + esc(a.action) + '</td><td>' + esc(a.detail || '') + '</td><td class="muted">' + esc(a.ip || '') + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="empty">No admin actions recorded yet.</td></tr>';
      body.innerHTML = '<p class="sub">A record of state-changing admin actions on this device.</p>' +
        '<div class="card"><table><thead><tr><th>Time</th><th>Action</th><th>Detail</th><th>From</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }).catch(function (e) { body.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function renderLogsEvents(body) {
    var level = '', source = '';
    function load() {
      var qs = ['limit=200'];
      if (level) qs.push('level=' + encodeURIComponent(level));
      if (source) qs.push('source=' + encodeURIComponent(source));
      api('/api/logs/events?' + qs.join('&')).then(function (r) {
        var levels = r.levels || ['info', 'warn', 'error'];
        var sources = r.sources || [];
        var events = r.events || [];
        var rows = events.length ? events.map(function (e) {
          var pc = e.level === 'error' ? 'off' : e.level === 'warn' ? 'warn' : 'on';
          var row = '<tr class="ev-row" data-id="' + e.id + '"><td class="muted">' + esc(e.created_at || '') + '</td>' +
            '<td><span class="pill ' + pc + '">' + esc(e.level) + '</span></td>' +
            '<td class="mono">' + esc(e.source) + '</td><td>' + esc(e.message) + '</td></tr>';
          if (e.detail) row += '<tr class="ev-detail" data-detail-for="' + e.id + '" hidden><td colspan="4"><pre class="cfg">' +
            esc(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2)) + '</pre></td></tr>';
          return row;
        }).join('') : '<tr><td colspan="4" class="empty">No events logged yet.</td></tr>';
        body.innerHTML =
          '<p class="sub">Structured application events — warnings, errors and notable state changes.</p>' +
          '<div class="card"><div class="row">' +
          field('ev-level', 'Level', '<select id="ev-level"><option value="">all</option>' + levels.map(function (l) { return '<option value="' + esc(l) + '"' + (l === level ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') + '</select>') +
          field('ev-source', 'Source', '<select id="ev-source"><option value="">all</option>' + sources.map(function (s) { return '<option value="' + esc(s) + '"' + (s === source ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>') +
          '</div></div>' +
          '<div class="card"><table><thead><tr><th>Time</th><th>Level</th><th>Source</th><th>Message</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        body.querySelector('#ev-level').onchange = function () { level = val('ev-level'); load(); };
        body.querySelector('#ev-source').onchange = function () { source = val('ev-source'); load(); };
        body.querySelectorAll('.ev-row').forEach(function (tr) {
          tr.style.cursor = 'pointer';
          tr.onclick = function () {
            var d = body.querySelector('[data-detail-for="' + tr.dataset.id + '"]');
            if (d) d.hidden = !d.hidden;
          };
        });
      }).catch(function (e) { body.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
    }
    load();
  }
  function renderLogsReports(body) {
    function loadReport(days) {
      body.innerHTML = '<p class="muted">Loading…</p>';
      api('/api/reports/summary?days=' + encodeURIComponent(days)).then(function (r) {
        var t = r.totals || {};
        var maxLogins = Math.max(1, (r.loginsPerDay || []).reduce(function (m, d) { return Math.max(m, d.accepts + d.rejects); }, 0));
        var loginsRows = (r.loginsPerDay || []).map(function (d) {
          var w = Math.round(((d.accepts + d.rejects) / maxLogins) * 100);
          return '<tr><td class="muted">' + esc(d.date) + '</td><td>' + d.accepts + '</td><td>' + d.rejects + '</td>' +
            '<td><div class="bar-cell"><div class="bar" style="width:' + w + '%"></div></div></td></tr>';
        }).join('') || '<tr><td colspan="4" class="empty">No data.</td></tr>';
        var planRows = (r.byPlan || []).map(function (p) {
          return '<tr><td>' + esc(p.plan) + '</td><td>' + p.sessions + '</td><td>' + octets(p.bytesIn) + '</td><td>' + octets(p.bytesOut) + '</td><td>' + p.users + '</td></tr>';
        }).join('') || '<tr><td colspan="5" class="empty">No data.</td></tr>';
        var userRows = (r.topUsers || []).map(function (u) {
          return '<tr><td class="mono">' + esc(u.username) + '</td><td>' + u.sessions + '</td><td>' + octets(u.bytes) + '</td></tr>';
        }).join('') || '<tr><td colspan="3" class="empty">No data.</td></tr>';
        body.innerHTML =
          '<p class="sub">Usage over the last N days.</p>' +
          '<div class="card"><div class="row" style="align-items:flex-end">' +
          field('rp-days', 'Days', '<input id="rp-days" type="number" min="1" max="365" value="' + esc(r.days || days) + '">') +
          '<button class="btn sm" id="rp-go">Update</button></div>' +
          '<div class="row" style="gap:32px;margin-top:14px">' +
          '<div><div class="muted">Accepts</div><div style="font-size:22px;color:var(--lime)">' + (t.accepts || 0) + '</div></div>' +
          '<div><div class="muted">Rejects</div><div style="font-size:22px;color:var(--red)">' + (t.rejects || 0) + '</div></div>' +
          '<div><div class="muted">Sessions</div><div style="font-size:22px">' + (t.sessions || 0) + '</div></div>' +
          '<div><div class="muted">Total data</div><div style="font-size:22px">' + octets(t.bytes) + '</div></div></div></div>' +
          '<div class="card"><h2>Logins per day</h2><table><thead><tr><th>Date</th><th>Accepts</th><th>Rejects</th><th>Volume</th></tr></thead><tbody>' + loginsRows + '</tbody></table></div>' +
          '<div class="card"><h2>By plan</h2><table><thead><tr><th>Plan</th><th>Sessions</th><th>In</th><th>Out</th><th>Users</th></tr></thead><tbody>' + planRows + '</tbody></table></div>' +
          '<div class="card"><h2>Top users</h2><table><thead><tr><th>User</th><th>Sessions</th><th>Total</th></tr></thead><tbody>' + userRows + '</tbody></table></div>';
        body.querySelector('#rp-go').onclick = function () { loadReport(Number(val('rp-days')) || 30); };
      }).catch(function (e) { body.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
    }
    api('/api/logs/storage').then(function (st) {
      loadReport((st.retention && st.retention.retention_days) || 30);
    }).catch(function () { loadReport(30); });
  }
  function renderLogsStorage(body) {
    function load() {
      api('/api/logs/storage').then(function (st) {
        var counts = st.counts || {};
        var rows = Object.keys(counts).map(function (k) { return '<tr><td class="mono">' + esc(k) + '</td><td>' + counts[k] + '</td></tr>'; }).join('') || '<tr><td colspan="2" class="empty">No tables.</td></tr>';
        var ret = st.retention || {};
        var defDays = ret.retention_days != null ? ret.retention_days : 30;
        body.innerHTML =
          '<p class="sub">How much log data this device is holding, and its retention policy.</p>' +
          '<div class="card"><h2>Row counts</h2><table><thead><tr><th>Table</th><th>Rows</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<p class="muted" style="margin-top:10px">Database file size: ' + octets(st.fileBytes) + '</p></div>' +
          '<div class="card"><h2>Retention</h2><p class="muted">Retention days: ' + (ret.retention_days != null ? ret.retention_days : '∞') +
          ' · Max rows: ' + (ret.retention_max_rows != null ? ret.retention_max_rows : '∞') +
          ' · Last sweep: ' + esc(st.last_retention_sweep_date || 'never') +
          ' — change these on <a href="#settings" data-tab="settings">Settings</a>.</p>' +
          '<button class="btn" id="lg-prune">Prune now</button></div>' +
          '<div class="card"><h2>Export</h2><div class="row" style="align-items:flex-end">' +
          field('ex-days', 'Days', '<input id="ex-days" type="number" min="1" max="3650" value="' + defDays + '">') +
          '<a class="btn" id="ex-go" href="/api/logs/export?days=' + defDays + '" download>Export CSV (zip)</a></div></div>';
        body.querySelector('#lg-prune').onclick = function () {
          if (!confirm('Prune logs older than the retention window now?')) return;
          api('/api/logs/prune', { method: 'POST' }).then(function (r) { toast('Pruned ' + r.total + ' row(s)', { level: 'ok' }); load(); }).catch(function (e) { toast(e.message, true); });
        };
        body.querySelector('#ex-days').oninput = function () {
          body.querySelector('#ex-go').href = '/api/logs/export?days=' + encodeURIComponent(val('ex-days') || 30);
        };
      }).catch(function (e) { body.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
    }
    load();
  }
  tabs.logs = function () {
    if (!LOG_SUBS.some(function (s) { return s[0] === logSub; })) logSub = 'auth';
    view.innerHTML = '<h1>Logs</h1>' + logSubnav() + '<div id="logbody"><p class="muted">Loading…</p></div>';
    view.querySelectorAll('[data-sub]').forEach(function (b) {
      b.onclick = function () { show('logs/' + b.dataset.sub); };
    });
    var body = document.getElementById('logbody');
    if (logSub === 'admin') renderLogsAdmin(body);
    else if (logSub === 'events') renderLogsEvents(body);
    else if (logSub === 'reports') renderLogsReports(body);
    else if (logSub === 'storage') renderLogsStorage(body);
    else renderLogsAuth(body);
  };

  tabs.backup = function () {
    view.innerHTML =
      '<h1>Backup &amp; migrate</h1><p class="sub">Move this whole setup — plans, vouchers, accounts, page designs, settings and branding — to another device.</p>' +
      '<div class="card"><h2>Download backup</h2><p class="muted">A zip with the database, branding assets and a snapshot of this container\'s router placement.</p>' +
      '<label class="row" style="gap:8px;align-items:center;margin:6px 0"><input type="checkbox" id="bk-secrets"><span>Include secrets (router password, RADIUS secret, admin login) — needed for a full migration. <b style="color:var(--amber)">Store securely.</b></span></label>' +
      '<a class="btn primary" id="bk-download" href="/api/backup" download>Download backup .zip</a> <span class="muted" id="bk-mode">Secrets are excluded — safe to share.</span></div>' +
      '<div class="card"><h2>Config-only backup</h2><p class="muted">A small bundle of plans, vouchers, accounts, designs and settings — <b>no session/accounting history and no secrets</b>. Safe to store off-device. Restoring it starts accounting history fresh.</p>' +
      '<a class="btn" href="/api/backup?config=1" download>Download config-only .zip</a></div>' +
      '<div class="card"><h2>Restore</h2><p class="muted">Upload a backup zip (full or config-only) — it is staged, then applied when the container restarts.</p>' +
      '<div class="row"><input type="file" id="bk-file" accept=".zip,application/zip"><button class="btn" id="bk-restore">Restore</button></div>' +
      '<div id="bk-out" style="margin-top:12px"></div></div>';
    var bkSecrets = document.getElementById('bk-secrets');
    bkSecrets.onchange = function () {
      var on = bkSecrets.checked;
      document.getElementById('bk-download').href = on ? '/api/backup?secrets=1' : '/api/backup';
      document.getElementById('bk-mode').textContent = on
        ? 'Secrets included — keep this file private.'
        : 'Secrets are excluded — safe to share.';
    };
    document.getElementById('bk-restore').onclick = function () {
      var f = document.getElementById('bk-file').files[0];
      if (!f) return toast('Choose a backup zip first', true);
      if (!confirm('Restore from this backup? It replaces ALL current data when the container restarts.')) return;
      var fd = new FormData(); fd.append('file', f);
      fetch('/api/restore', { method: 'POST', body: fd }).then(function (r) { return r.json(); }).then(function (res) {
        if (res.ok) document.getElementById('bk-out').innerHTML = '<p class="ok">' + esc(res.message) + ' (' + res.assets_restored + ' asset(s))</p><pre class="cfg">Finish on the router:\n/container/stop [find name=app-tikspot]\n/container/start [find name=app-tikspot]</pre>';
        else toast(res.error || 'Restore failed', true);
      }).catch(function (e) { toast(e.message, true); });
    };
  };

  // ---- settings ----
  function settingFieldId(key) { return 'st-' + String(key).replace(/[^a-zA-Z0-9_-]/g, '_'); }
  function settingInputHtml(s, id) {
    if (s.type === 'select') {
      var opts = (s.options || []).map(function (o) { return '<option value="' + esc(o) + '"' + (String(o) === String(s.value) ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('');
      return '<select id="' + id + '">' + opts + '</select>';
    }
    if (s.type === 'json') {
      var v; try { v = JSON.stringify(s.value, null, 2); } catch (e) { v = ''; }
      return '<textarea id="' + id + '" rows="4">' + esc(v == null ? '' : v) + '</textarea>';
    }
    if (s.type === 'int') {
      return '<input type="number" id="' + id + '"' + (s.min != null ? ' min="' + s.min + '"' : '') + (s.max != null ? ' max="' + s.max + '"' : '') + ' value="' + esc(s.value == null ? '' : s.value) + '">';
    }
    return '<input type="text" id="' + id + '" value="' + esc(s.value == null ? '' : s.value) + '">';
  }
  function renderSettingsGroups(groups) {
    var html = groups.map(function (g, gi) {
      var fields = (g.settings || []).map(function (s) {
        var id = settingFieldId(s.key);
        var label = esc(s.label || s.key) + (s.help ? ' ' + help(s.help) : '');
        if (s.type === 'bool') {
          return '<div class="field" style="margin-bottom:12px"><label class="row" style="gap:8px;align-items:center"><input type="checkbox" id="' + id + '"' + (s.value ? ' checked' : '') + '><span>' + label + '</span></label></div>';
        }
        return '<div class="field" style="margin-bottom:12px"><label for="' + id + '">' + label + '</label>' + settingInputHtml(s, id) + '</div>';
      }).join('');
      return '<div class="card"><h2>' + esc(g.name) + '</h2>' + fields + '<button class="btn primary" data-save-group="' + gi + '">Save</button></div>';
    }).join('');
    document.getElementById('st').innerHTML = html || '<p class="empty">No settings.</p>';
    document.querySelectorAll('[data-save-group]').forEach(function (btn) {
      btn.onclick = function () {
        clearFieldErrors();
        var g = groups[Number(btn.dataset.saveGroup)];
        var body = {};
        var badJson = false;
        (g.settings || []).forEach(function (s) {
          var id = settingFieldId(s.key);
          var el = document.getElementById(id);
          if (!el) return;
          if (s.type === 'bool') body[s.key] = el.checked;
          else if (s.type === 'int') body[s.key] = el.value === '' ? null : Number(el.value);
          else if (s.type === 'json') {
            try { body[s.key] = el.value.trim() === '' ? null : JSON.parse(el.value); }
            catch (e) { badJson = true; el.classList.add('is-err'); el.insertAdjacentHTML('afterend', '<span class="field-err">Invalid JSON</span>'); }
          } else body[s.key] = el.value;
        });
        if (badJson) return toast('Fix the JSON field before saving', true);
        btn.disabled = true;
        api('/api/settings', { method: 'PATCH', body: body }).then(function (r) {
          toast('Saved', { level: 'ok' });
          renderSettingsGroups(r.groups || groups);
        }).catch(function (e) {
          btn.disabled = false;
          if (e.fields) {
            var map = {};
            Object.keys(e.fields).forEach(function (k) { map[k] = settingFieldId(k); });
            showFieldErrors(e.fields, map);
          }
          toast(e.message, true);
        });
      };
    });
  }
  tabs.settings = function () {
    view.innerHTML = '<h1>Settings</h1><p class="sub">Server-side configuration, grouped. Each group saves independently.</p><div id="st"><p class="muted">Loading…</p></div>';
    api('/api/settings').then(function (r) { renderSettingsGroups(r.groups || []); })
      .catch(function (e) { document.getElementById('st').innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  };

  // ---- announcements ----
  var annEditing = null;
  function isoToLocal(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function localToIso(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  function announcementFormHtml(a) {
    a = a || {};
    var severities = ['info', 'warning', 'danger', 'success'];
    var targetsAll = ['portal', 'status', 'admin'];
    var targets = a.targets || [];
    return '<div class="card"><h2>' + (a.id ? 'Edit announcement' : 'New announcement') + '</h2>' +
      field('an-title', 'Title', '<input id="an-title" value="' + esc(a.title || '') + '">') +
      '<div class="field" style="margin:10px 0"><label for="an-body">Body</label><textarea id="an-body" rows="3">' + esc(a.body || '') + '</textarea></div>' +
      '<div class="row">' +
      field('an-severity', 'Severity', '<select id="an-severity">' + severities.map(function (s) { return '<option value="' + s + '"' + (a.severity === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>') +
      field('an-starts', 'Starts', '<input id="an-starts" type="datetime-local" value="' + isoToLocal(a.starts_at) + '">') +
      field('an-ends', 'Ends', '<input id="an-ends" type="datetime-local" value="' + isoToLocal(a.ends_at) + '">') +
      '</div>' +
      '<div class="field" style="margin:10px 0"><label>Targets</label><div class="row" style="gap:14px">' +
      targetsAll.map(function (t) { return '<label class="row" style="gap:6px;align-items:center"><input type="checkbox" data-target="' + t + '"' + (targets.indexOf(t) !== -1 ? ' checked' : '') + '> ' + t + '</label>'; }).join('') +
      '</div></div>' +
      '<label class="row" style="gap:8px;align-items:center;margin:10px 0"><input type="checkbox" id="an-enabled"' + (a.enabled !== 0 ? ' checked' : '') + '> <span>Enabled</span></label>' +
      '<div id="an-preview" style="margin:14px 0"></div>' +
      '<div class="row"><button class="btn primary" id="an-save">' + (a.id ? 'Update' : 'Create') + '</button>' +
      (a.id ? '<button class="btn" id="an-cancel">Cancel</button>' : '') + '</div></div>';
  }
  function bindAnnouncementForm(a) {
    function updatePreview() {
      var sev = val('an-severity') || 'info';
      var title = val('an-title') || '(untitled)';
      var body = document.getElementById('an-body').value;
      document.getElementById('an-preview').innerHTML =
        '<div class="notice ' + esc(sev) + '"><div class="notice-body"><b>' + esc(title) + '</b>' + (body ? '<span>' + esc(body) + '</span>' : '') + '</div></div>';
    }
    ['an-title', 'an-body', 'an-severity'].forEach(function (id) {
      var el = document.getElementById(id);
      el.addEventListener('input', updatePreview);
      el.addEventListener('change', updatePreview);
    });
    updatePreview();
    document.getElementById('an-save').onclick = function () {
      clearFieldErrors();
      var targets = [];
      view.querySelectorAll('[data-target]').forEach(function (c) { if (c.checked) targets.push(c.dataset.target); });
      var body = {
        title: val('an-title'), body: document.getElementById('an-body').value,
        severity: val('an-severity'), targets: targets,
        starts_at: localToIso(val('an-starts')), ends_at: localToIso(val('an-ends')),
        enabled: document.getElementById('an-enabled').checked ? 1 : 0,
      };
      var req = a && a.id
        ? api('/api/announcements/' + a.id, { method: 'PATCH', body: body })
        : api('/api/announcements', { method: 'POST', body: body });
      req.then(function () { toast(a && a.id ? 'Updated' : 'Created', { level: 'ok' }); annEditing = null; loadAnnouncements(); })
        .catch(function (e) {
          if (e.fields) showFieldErrors(e.fields, { title: 'an-title', body: 'an-body', severity: 'an-severity', starts_at: 'an-starts', ends_at: 'an-ends' });
          toast(e.message, true);
        });
    };
    var cancel = document.getElementById('an-cancel');
    if (cancel) cancel.onclick = function () { annEditing = null; loadAnnouncements(); };
  }
  function bindAnnouncementRows() {
    view.querySelectorAll('[data-toggle-en]').forEach(function (c) {
      c.onchange = function () {
        api('/api/announcements/' + c.dataset.toggleEn, { method: 'PATCH', body: { enabled: c.checked ? 1 : 0 } })
          .then(function () { toast('Updated', { level: 'ok' }); loadAnnouncements(); })
          .catch(function (e) { toast(e.message, true); c.checked = !c.checked; });
      };
    });
    view.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { annEditing = Number(b.dataset.edit); loadAnnouncements(); };
    });
    view.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Delete this announcement?')) return;
        api('/api/announcements/' + b.dataset.del, { method: 'DELETE' })
          .then(function () { toast('Deleted', { level: 'ok' }); if (annEditing === Number(b.dataset.del)) annEditing = null; loadAnnouncements(); })
          .catch(function (e) { toast(e.message, true); });
      };
    });
  }
  function renderAnnouncements(list) {
    var editing = annEditing != null ? (list.filter(function (a) { return a.id === annEditing; })[0] || null) : null;
    var rows = list.length ? list.map(function (a) {
      var win = (a.starts_at || a.ends_at)
        ? esc(isoToLocal(a.starts_at).replace('T', ' ') || '∞') + ' → ' + esc(isoToLocal(a.ends_at).replace('T', ' ') || '∞')
        : '<span class="muted">always</span>';
      return '<tr><td>' + esc(a.title) + '</td><td><span class="pill ' + esc(a.severity) + '">' + esc(a.severity) + '</span></td>' +
        '<td class="muted">' + esc((a.targets || []).join(', ')) + '</td><td class="muted">' + win + '</td>' +
        '<td><span class="pill ' + esc(a.state) + '">' + esc(a.state) + '</span></td>' +
        '<td><input type="checkbox" data-toggle-en="' + a.id + '"' + (a.enabled ? ' checked' : '') + '></td>' +
        '<td><button class="btn sm" data-edit="' + a.id + '">Edit</button> <button class="btn sm danger" data-del="' + a.id + '">Delete</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">No announcements yet.</td></tr>';
    view.innerHTML =
      '<h1>Announcements</h1><p class="sub">Banners shown on the portal, status page and/or here in admin.</p>' +
      '<div class="card"><table><thead><tr><th>Title</th><th>Severity</th><th>Targets</th><th>Window</th><th>State</th><th>Enabled</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      announcementFormHtml(editing);
    bindAnnouncementRows();
    bindAnnouncementForm(editing);
  }
  function loadAnnouncements() {
    api('/api/announcements').then(function (r) { renderAnnouncements(r.announcements || []); })
      .catch(function (e) { view.innerHTML = '<h1>Announcements</h1><p class="bad">' + esc(e.message) + '</p>'; });
  }
  tabs.announcements = function () { annEditing = null; loadAnnouncements(); };

  // ---- help ----
  tabs.help = function () {
    view.innerHTML = '<h1>Help &amp; setup checklist</h1><p class="sub">Loading…</p>';
    api('/api/help').then(function (r) {
      var checklist = (r.checklist || []).map(function (c) {
        return '<div class="card"><h2>' + esc(c.title) + '</h2><p>' + esc(c.body) + '</p>' +
          (c.docs ? '<a href="' + esc(c.docs) + '" target="_blank" rel="noopener">docs →</a>' : '') + '</div>';
      }).join('');
      var symptomRows = (r.symptoms || []).map(function (s) {
        return '<tr><td>' + esc(s.symptom) + '</td><td>' + esc(s.cause) + '</td><td>' + esc(s.check) + '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="empty">No known issues listed.</td></tr>';
      var docLinks = (r.docs || []).map(function (d) {
        return '<li><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.title) + '</a></li>';
      }).join('');
      view.innerHTML =
        '<h1>Help &amp; setup checklist</h1><p class="sub">Common setup steps, known symptoms and reference docs.</p>' +
        checklist +
        '<div class="card"><h2>Troubleshooting</h2><table><thead><tr><th>Symptom</th><th>Likely cause</th><th>Check</th></tr></thead><tbody>' + symptomRows + '</tbody></table></div>' +
        (docLinks ? '<div class="card"><h2>Documentation</h2><ul class="kvs">' + docLinks + '</ul></div>' : '');
    }).catch(function (e) { view.innerHTML = '<h1>Help &amp; setup checklist</h1><p class="bad">' + esc(e.message) + '</p>'; });
  };

  // ---- designs (captive-portal page designs) ----
  // One design is live at a time; the rest are drafts/alternatives you can open
  // in the portal editor. Editing happens in /admin/editor.html — this tab is
  // the library view (open / set live / export / delete / new / import).
  tabs.designs = function () {
    api('/api/designs').then(function (r) {
      var designs = r.designs || [];
      var rows = designs.length
        ? designs.map(function (d) {
            var live = d.is_active ? '<span class="pill on">live</span>' : '';
            var draft = d.has_draft ? '<span class="pill scheduled">draft</span>' : '<span class="muted">—</span>';
            var when = (d.updated_at || '').replace('T', ' ').slice(0, 16);
            var ver = d.version ? 'v' + d.version : '<span class="muted">unpublished</span>';
            return '<tr><td>' + esc(d.name) + ' ' + live + '</td><td class="mono">' + ver + '</td><td>' +
              draft + '</td><td class="muted">' + esc(when || '—') + '</td><td>' +
              '<a class="btn sm" href="/admin/editor.html?id=' + encodeURIComponent(d.id) + '">Open</a> ' +
              (d.is_active ? '' : '<button class="btn sm" data-live="' + esc(d.id) + '">Set live</button> ') +
              '<a class="btn sm" href="/api/designs/' + encodeURIComponent(d.id) + '/export" download>Export</a> ' +
              (d.is_active ? '' : '<button class="btn sm danger" data-ddel="' + esc(d.id) + '">Delete</button>') +
              '</td></tr>';
          }).join('')
        : '<tr><td colspan="5" class="empty">No designs yet — start one from a template.</td></tr>';
      view.innerHTML =
        '<h1>Designs</h1><p class="sub">Captive-portal page designs. The <b>live</b> one is what guests see at ' +
        '<a href="/login" target="_blank" rel="noopener">/login</a>; edit any of them in the portal editor.</p>' +
        '<div class="card"><table><thead><tr><th>Name</th><th>Version</th><th>Draft</th><th>Updated</th><th></th></tr></thead><tbody>' +
        rows + '</tbody></table></div>' +
        '<div class="card"><h2>Add a design</h2><div class="row">' +
        '<button class="btn primary" id="d-new">New from template</button>' +
        '<button class="btn" id="d-import">Import JSON</button>' +
        '<input type="file" id="d-file" accept="application/json,.json" style="display:none">' +
        '</div><div id="d-tpls" style="margin-top:14px"></div></div>';

      view.querySelectorAll('[data-live]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Make this design the live portal page?')) return;
          api('/api/designs/' + b.dataset.live + '/activate', { method: 'POST' })
            .then(function () { toast('Design is live'); tabs.designs(); })
            .catch(function (e) { toast(e.message, true); });
        };
      });
      view.querySelectorAll('[data-ddel]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Delete this design permanently?')) return;
          api('/api/designs/' + b.dataset.ddel, { method: 'DELETE' })
            .then(function () { toast('Deleted'); tabs.designs(); })
            .catch(function (e) { toast(e.message, true); });
        };
      });
      var tplBox = view.querySelector('#d-tpls');
      view.querySelector('#d-new').onclick = function () {
        tplBox.innerHTML = '<p class="muted">Loading templates…</p>';
        api('/api/designs/templates').then(function (t) {
          var list = t.templates || [];
          tplBox.innerHTML = list.length
            ? '<table><tbody>' + list.map(function (x) {
                return '<tr><td><b>' + esc(x.name) + '</b><div class="muted">' + esc(x.description || '') + '</div></td>' +
                  '<td style="width:1%"><button class="btn sm primary" data-tpl="' + esc(x.key) + '">Create</button></td></tr>';
              }).join('') + '</tbody></table>'
            : '<p class="muted">The server offers no templates.</p>';
          tplBox.querySelectorAll('[data-tpl]').forEach(function (b) {
            b.onclick = function () {
              api('/api/designs', { method: 'POST', body: { name: 'New design', template: b.dataset.tpl } })
                .then(function (res) { location.href = '/admin/editor.html?id=' + encodeURIComponent(res.id); })
                .catch(function (e) { toast(e.message, true); });
            };
          });
        }).catch(function (e) { tplBox.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
      };
      var fileEl = view.querySelector('#d-file');
      view.querySelector('#d-import').onclick = function () { fileEl.value = ''; fileEl.click(); };
      fileEl.onchange = function () {
        var f = fileEl.files[0];
        if (!f) return;
        f.text().then(function (txt) {
          var obj;
          try { obj = JSON.parse(txt); } catch (e) { throw new Error('That file is not valid JSON'); }
          return api('/api/designs/import', { method: 'POST', body: obj });
        }).then(function (res) { toast('Imported'); location.href = '/admin/editor.html?id=' + encodeURIComponent(res.id); })
          .catch(function (e) { toast(e.message, true); });
      };
    }).catch(function (e) {
      view.innerHTML = '<h1>Designs</h1><p class="sub">Captive-portal page designs.</p><p class="bad">' + esc(e.message) + '</p>';
    });
  };

  // ---- guest-lookup plugins (Stage 0.13-C) ----
  // A "plugin" is a recipe describing how to ask a hotel/venue guest system
  // whether a visitor has an active booking. This tab is the library + a
  // guided editor over the recipe schema in app/src/plugins/recipe.js, plus a
  // live Test panel over POST /api/plugins/:id/test.
  var CANON_FIELDS = ['firstName', 'lastName', 'fullName', 'room', 'mobile', 'email', 'checkIn', 'checkOut', 'bookingRef'];
  var NORMALIZERS = ['trim', 'name', 'phone', 'email', 'digits', 'upper'];
  var GUEST_API_DOCS = 'https://github.com/omegatron/tinkernet-tikspot/blob/main/examples/guest-api/README.md';
  var CATALOG_DEFAULT_URL = 'https://raw.githubusercontent.com/omegatron/tinkernet-tikspot/main/plugins/index.json';
  var routeSub = '';          // the part after "tab/" in the hash
  var guestsTimer = null;     // Guests tab auto-refresh
  var pg = null;              // plugin editor state (null when listing)
  var pgFocusTest = false;    // scroll to the Test card after the next render

  function clearTabTimers() { if (guestsTimer) { clearInterval(guestsTimer); guestsTimer = null; } }

  // -- small html builders bound to the editor draft by dotted path --
  function pgOpts(list, cur) {
    return list.map(function (o) {
      var v = o instanceof Array ? o[0] : o, l = o instanceof Array ? o[1] : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }
  function pgSel(bind, list, cur, attrs) { return '<select data-bind="' + bind + '"' + (attrs || '') + '>' + pgOpts(list, cur) + '</select>'; }
  function pgTxt(bind, cur, attrs) { return '<input data-bind="' + bind + '" value="' + esc(cur == null ? '' : cur) + '"' + (attrs || '') + '>'; }
  function pgTa(bind, cur, attrs) { return '<textarea data-bind="' + bind + '"' + (attrs || '') + '>' + esc(cur == null ? '' : cur) + '</textarea>'; }
  function pgChk(bind, cur, label, attrs) {
    return '<label class="pg-chk"><input type="checkbox" data-bind="' + bind + '"' + (cur ? ' checked' : '') + (attrs || '') + '><span>' + label + '</span></label>';
  }
  function pgGetPath(obj, path) {
    var p = path.split('.'), o = obj;
    for (var i = 0; i < p.length; i++) { if (o == null) return undefined; o = o[p[i]]; }
    return o;
  }
  function pgSetPath(obj, path, v) {
    var p = path.split('.'), o = obj;
    for (var i = 0; i < p.length - 1; i++) o = o[p[i]];
    o[p[p.length - 1]] = v;
  }
  function pgRows(o) {
    return Object.keys(o || {}).map(function (k) { return { k: k, v: String(o[k] == null ? '' : o[k]) }; });
  }
  function pgRowsToObj(rows) {
    var o = {};
    (rows || []).forEach(function (r) { if (String(r.k).trim()) o[String(r.k).trim()] = r.v; });
    return o;
  }
  function pgNum(v, fallback) {
    if (v === '' || v == null) return fallback;
    var n = Number(v);
    return isNaN(n) ? fallback : n;
  }

  // options array <-> "value|label" per-line text, used by select-type params
  function pgOptionsToText(options) {
    return (options || []).map(function (o) {
      if (o && typeof o === 'object') return String(o.value) + (o.label != null && String(o.label) !== String(o.value) ? '|' + o.label : '');
      return String(o);
    }).join('\n');
  }
  function pgOptionsFromText(text) {
    return String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (line) {
      var i = line.indexOf('|');
      return i === -1 ? { value: line, label: line } : { value: line.slice(0, i).trim(), label: line.slice(i + 1).trim() };
    });
  }
  function pgSecretPlaceholders(keys) {
    return (keys || []).map(function (k) { return '<code>{{secret.' + esc(k) + '}}</code>'; }).join(' / ');
  }

  // recipe (server shape) -> editor draft (ordered rows, on/off toggles).
  // `_orig` keeps a clone of the loaded recipe so pgRecipeFromDraft can
  // round-trip anything the guided form doesn't manage (steps, maxFanOut,
  // auth.bodyJson, request.bodyJson, ...) instead of rebuilding from scratch.
  function pgDraftFromRecipe(r) {
    r = r || {};
    var a = r.auth || {}, pl = a.placement || {}, w = r.window || {}, rq = r.request || {}, ps = r.parse || {}, mt = r.match || {};
    var secretKeys = (r.secretKeys && r.secretKeys.length) ? r.secretKeys.slice() : ['username', 'password', 'apiKey'];
    var secretLabels = {};
    Object.keys(r.secretLabels || {}).forEach(function (k) { secretLabels[k] = r.secretLabels[k]; });
    var paramsObj = r.params || {}, paramValuesObj = r.paramValues || {};
    var paramRows = Object.keys(paramsObj).map(function (name) {
      var p = paramsObj[name] || {};
      var dflt = p.default == null ? '' : p.default;
      return {
        name: name, label: p.label || '', help: p.help || '', type: p.type || 'text',
        default: String(dflt), optionsText: pgOptionsToText(p.options),
        value: String(Object.prototype.hasOwnProperty.call(paramValuesObj, name) ? paramValuesObj[name] : dflt),
      };
    });
    return {
      _orig: JSON.parse(JSON.stringify(r)),
      name: r.name || '', enabled: r.enabled !== false, planGroup: r.planGroup || 'free',
      timeoutMs: r.timeoutMs == null ? '' : String(r.timeoutMs),
      allowInsecureTls: !!r.allowInsecureTls,
      maxRecords: r.maxRecords == null ? '' : String(r.maxRecords),
      authOn: !!r.auth,
      auth: {
        method: a.method || 'POST', url: a.url || '', contentType: a.contentType || 'json',
        bodyTemplate: a.bodyTemplate || '', tokenPath: a.tokenPath || 'token',
        tokenTtlSecs: a.tokenTtlSecs == null ? '' : String(a.tokenTtlSecs),
        placement: { in: pl.in || 'header', name: pl.name || 'Authorization', prefix: pl.prefix == null ? 'Bearer ' : pl.prefix },
      },
      authHeaderRows: pgRows(a.headers),
      request: {
        method: rq.method || 'GET', url: rq.url || '', contentType: rq.contentType || 'json',
        accept: rq.accept || '', bodyTemplate: rq.bodyTemplate || '',
      },
      headerRows: pgRows(rq.headers),
      parse: { type: ps.type || 'json', root: ps.root || '', recordRegex: ps.recordRegex || '', dateFormat: ps.dateFormat || 'iso' },
      fieldRows: Object.keys(ps.fields || {}).map(function (k) { return { key: k, path: String(ps.fields[k] == null ? '' : ps.fields[k]) }; }),
      match: {
        all: mt.all !== false,
        minRules: mt.minRules == null ? '' : String(mt.minRules),
        rules: (mt.rules || []).map(function (ru) {
          var any = ru.anyOf && ru.anyOf.length;
          return { input: ru.input || '', mode: any ? 'anyOf' : 'field', field: ru.field || '', anyOf: any ? ru.anyOf.slice() : [], normalize: ru.normalize || 'trim' };
        }),
      },
      windowOn: !!r.window,
      window: {
        start: w.start || '', end: w.end || '',
        leewayHours: w.leewayHours == null ? '' : String(w.leewayHours),
        maxGrantHours: w.maxGrantHours == null ? '' : String(w.maxGrantHours),
      },
      inputs: (r.inputs || []).map(function (i) {
        return { name: i.name || '', label: i.label || '', type: i.type || 'text', required: !!i.required,
          placeholder: i.placeholder || '', autocomplete: i.autocomplete || '' };
      }),
      messages: { noMatch: (r.messages && r.messages.noMatch) || '', outsideWindow: (r.messages && r.messages.outsideWindow) || '', upstream: (r.messages && r.messages.upstream) || '' },
      secretKeys: secretKeys,
      secretLabels: secretLabels,
      params: paramRows,
      hasSteps: !!(r.steps && r.steps.length),
      stepsCount: (r.steps && r.steps.length) || 0,
    };
  }

  // editor draft -> recipe (server shape). Blank numbers are omitted so the
  // server's own defaults apply (window.leewayHours especially: absent means
  // "use the global default from Settings"). Everything the guided form
  // doesn't manage (steps, maxFanOut, auth.bodyJson, auth.tokenExpiryPath,
  // request.bodyJson, request.omitEmpty, ...) round-trips untouched from
  // draft._orig instead of being rebuilt from scratch.
  function pgRecipeFromDraft(d, secrets) {
    var r = d._orig ? JSON.parse(JSON.stringify(d._orig)) : {};
    delete r.id; delete r.has_secrets; delete r.version; delete r.created_at; delete r.updated_at; delete r.secrets;
    r.name = d.name; r.enabled = !!d.enabled; r.planGroup = d.planGroup || 'free';
    if (d.timeoutMs !== '') r.timeoutMs = pgNum(d.timeoutMs, 8000); else delete r.timeoutMs;
    r.allowInsecureTls = !!d.allowInsecureTls;
    if (d.maxRecords !== '') r.maxRecords = pgNum(d.maxRecords, 200); else delete r.maxRecords;
    if (d.authOn) {
      r.auth = Object.assign({}, r.auth, {
        method: d.auth.method, url: d.auth.url, headers: pgRowsToObj(d.authHeaderRows),
        contentType: d.auth.contentType, bodyTemplate: d.auth.bodyTemplate, tokenPath: d.auth.tokenPath,
        placement: { in: d.auth.placement.in, name: d.auth.placement.name, prefix: d.auth.placement.prefix },
      });
      if (d.auth.tokenTtlSecs !== '') r.auth.tokenTtlSecs = pgNum(d.auth.tokenTtlSecs, 3600); else delete r.auth.tokenTtlSecs;
    }
    // authOn off: leave r.auth exactly as loaded (or absent for a new plugin) —
    // an update that omits `auth` keeps the stored step; only Raw JSON's
    // explicit `auth: null` clears it.
    if (!d.hasSteps) {
      r.request = Object.assign({}, r.request, {
        method: d.request.method, url: d.request.url, headers: pgRowsToObj(d.headerRows),
        contentType: d.request.contentType, bodyTemplate: d.request.bodyTemplate,
      });
      if (d.request.accept) r.request.accept = d.request.accept; else delete r.request.accept;
      var fields = {};
      d.fieldRows.forEach(function (f) { if (String(f.key).trim()) fields[String(f.key).trim()] = f.path; });
      r.parse = Object.assign({}, r.parse, { type: d.parse.type, root: d.parse.root, recordRegex: d.parse.recordRegex, fields: fields, dateFormat: d.parse.dateFormat });
    }
    // hasSteps: the guided form doesn't touch request/parse/steps — they
    // round-trip from _orig untouched (edit them in Raw JSON instead).
    r.match = Object.assign({}, r.match, {
      all: !!d.match.all,
      rules: d.match.rules.map(function (ru) {
        return ru.mode === 'anyOf'
          ? { input: ru.input, anyOf: ru.anyOf.slice(), normalize: ru.normalize }
          : { input: ru.input, field: ru.field, normalize: ru.normalize };
      }),
    });
    if (d.match.minRules !== '') r.match.minRules = pgNum(d.match.minRules, 0); else delete r.match.minRules;
    if (d.windowOn) {
      r.window = { start: d.window.start, end: d.window.end };
      if (d.window.leewayHours !== '') r.window.leewayHours = pgNum(d.window.leewayHours, 24);
      if (d.window.maxGrantHours !== '') r.window.maxGrantHours = pgNum(d.window.maxGrantHours, 168);
    }
    r.inputs = d.inputs.map(function (i) {
      var o = { name: i.name, label: i.label, type: i.type, required: !!i.required, placeholder: i.placeholder };
      if (i.autocomplete) o.autocomplete = i.autocomplete;
      return o;
    });
    r.messages = { noMatch: d.messages.noMatch, outsideWindow: d.messages.outsideWindow, upstream: d.messages.upstream };
    r.secretKeys = d.secretKeys.slice();
    var secretLabels = {};
    Object.keys(d.secretLabels || {}).forEach(function (k) { if (d.secretKeys.indexOf(k) !== -1 && d.secretLabels[k]) secretLabels[k] = d.secretLabels[k]; });
    if (Object.keys(secretLabels).length) r.secretLabels = secretLabels; else delete r.secretLabels;
    r.params = {};
    r.paramValues = {};
    d.params.forEach(function (p) {
      var name = String(p.name || '').trim();
      if (!name) return;
      var entry = { type: p.type || 'text' };
      if (p.label) entry.label = p.label;
      if (p.help) entry.help = p.help;
      if (p.type === 'select') entry.options = pgOptionsFromText(p.optionsText);
      if (p.default !== '') entry.default = p.default;
      r.params[name] = entry;
      if (p.type === 'boolean') {
        r.paramValues[name] = p.value === true || p.value === 'true';
      } else if (p.value !== '' && p.value != null) {
        r.paramValues[name] = p.value;
      }
    });
    if (secrets) {
      var sOut = {};
      d.secretKeys.forEach(function (k) { if (secrets[k]) sOut[k] = secrets[k]; });
      r.secrets = sOut;
    }
    return r;
  }
  function pgDirty() {
    if (!pg) return false;
    if (pg.draft.secretKeys.some(function (k) { return !!pg.secrets[k]; })) return true;
    return JSON.stringify(pgRecipeFromDraft(pg.draft)) !== pg.savedJson;
  }
  function pgAllFields() {
    var seen = {}, out = [];
    CANON_FIELDS.concat(pg.draft.fieldRows.map(function (f) { return String(f.key).trim(); }))
      .forEach(function (f) { if (f && !seen[f]) { seen[f] = 1; out.push(f); } });
    return out;
  }

  // ---- list ----
  function pgList() {
    api('/api/plugins').then(function (r) {
      var list = r.plugins || [];
      var rows = list.length ? list.map(function (p) {
        var ins = (p.inputs || []).map(function (i) { return i.name; }).join(', ');
        return '<tr><td><b>' + esc(p.name) + '</b></td>' +
          '<td><span class="pill ' + (p.enabled ? 'on">enabled' : 'off">disabled') + '</span></td>' +
          '<td class="mono">' + esc(p.planGroup || 'free') + '</td>' +
          '<td class="muted">' + (ins ? esc(ins) : '—') + '</td>' +
          '<td class="muted">' + esc(sqlLocal(p.updated_at) || '—') + '</td>' +
          '<td class="pg-actions"><a class="btn sm" href="#plugins/' + p.id + '" data-tab="plugins/' + p.id + '">Edit</a> ' +
          '<button class="btn sm" data-pgtest="' + p.id + '">Test</button> ' +
          '<a class="btn sm" href="/api/plugins/' + p.id + '/export" download>Export</a> ' +
          '<button class="btn sm" data-pgdup="' + p.id + '">Duplicate</button> ' +
          '<button class="btn sm danger" data-pgdel="' + p.id + '">Delete</button></td></tr>';
      }).join('') : '<tr><td colspan="6" class="empty">No lookup plugins yet — create one, or import a recipe JSON.</td></tr>';
      view.innerHTML =
        '<h1>Guest lookup</h1>' +
        '<p class="sub">Let guests sign in with details your booking system already knows — a room number and a surname, say — instead of a voucher. ' +
        'A <b>lookup plugin</b> is a recipe: how to authenticate to that system, what to ask it, how to read the answer, and which fields must match. ' +
        'Add a <i>guest lookup</i> block to a portal design to show it. ' +
        '<a href="' + GUEST_API_DOCS + '" target="_blank" rel="noopener">Recipe guide &amp; demo API →</a></p>' +
        '<div class="card"><table><thead><tr><th>Name</th><th>Status</th><th>Plan group</th><th>Guest inputs</th><th>Updated</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' +
        '<div class="card"><h2>Add a plugin</h2><div class="row">' +
        '<a class="btn primary" href="#plugins/new" data-tab="plugins/new">New plugin</a>' +
        '<button class="btn" id="pg-import">Import JSON</button>' +
        '<input type="file" id="pg-file" accept="application/json,.json" style="display:none">' +
        '</div><p class="hint" style="margin-top:10px">Import accepts either an exported <span class="mono">.tikspot-plugin.json</span> bundle or a bare recipe file such as ' +
        '<span class="mono">examples/guest-api/recipes/hotel-json.json</span>. ' + help('Exports never contain secrets — re-enter the username / password / API key after importing.') + '</p></div>' +
        '<div class="card"><h2>Plugin catalog</h2>' +
        '<p class="hint" style="margin:-6px 0 14px">Browse community-published recipes and import one to review. ' +
        help('Accepts a catalog index.json URL, a GitHub folder link (…/tree/main/plugins), or a raw/blob file URL. The container needs outbound internet to reach it.') + '</p>' +
        '<div class="row"><div class="field" style="flex:2 1 380px"><label for="pg-cat-url">Catalog source</label>' +
        '<input type="text" id="pg-cat-url" style="width:100%" placeholder="' + esc(CATALOG_DEFAULT_URL) + '"></div>' +
        '<button class="btn primary" id="pg-cat-go">Browse</button></div>' +
        '<p class="hint" style="margin-top:8px"><a href="#" id="pg-cat-savedefault">Save as default</a></p>' +
        '<div id="pg-cat-results"></div><div id="pg-cat-foot"></div></div>';

      var installedNames = list.map(function (p) { return p.name; });
      var catUrlEl = view.querySelector('#pg-cat-url');
      var catResultsEl = view.querySelector('#pg-cat-results');
      var catFootEl = view.querySelector('#pg-cat-foot');
      catUrlEl.value = CATALOG_DEFAULT_URL;
      api('/api/settings').then(function (r) {
        (r.groups || []).forEach(function (g) {
          (g.settings || []).forEach(function (s) {
            if (s.key === 'plugin_catalog_url' && s.value) catUrlEl.value = s.value;
          });
        });
      }).catch(function () { /* keep the built-in default */ });
      view.querySelector('#pg-cat-go').onclick = function () {
        pgCatalogLoad(val('pg-cat-url') || CATALOG_DEFAULT_URL, installedNames, catResultsEl, catFootEl);
      };
      view.querySelector('#pg-cat-savedefault').onclick = function (e) {
        e.preventDefault();
        var u = val('pg-cat-url') || CATALOG_DEFAULT_URL;
        api('/api/settings', { method: 'PATCH', body: { plugin_catalog_url: u } })
          .then(function () { toast('Saved as default catalog', { level: 'ok' }); })
          .catch(function (err) { toast(err.message, true); });
      };

      view.querySelectorAll('[data-pgtest]').forEach(function (b) {
        b.onclick = function () { pgFocusTest = true; show('plugins/' + b.dataset.pgtest); };
      });
      view.querySelectorAll('[data-pgdel]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Delete this lookup plugin? Guests already granted access keep it until their grant expires.')) return;
          api('/api/plugins/' + b.dataset.pgdel, { method: 'DELETE' })
            .then(function () { toast('Deleted', { level: 'ok' }); pgList(); }).catch(function (e) { toast(e.message, true); });
        };
      });
      view.querySelectorAll('[data-pgdup]').forEach(function (b) {
        b.onclick = function () {
          api('/api/plugins/' + b.dataset.pgdup).then(function (rec) {
            delete rec.id; delete rec.has_secrets; delete rec.version;
            rec.name = (rec.name || 'Plugin') + ' (copy)';
            rec.enabled = false;
            return api('/api/plugins', { method: 'POST', body: rec });
          }).then(function (res) {
            toast('Duplicated — secrets were not copied, re-enter them', { level: 'warn' });
            show('plugins/' + res.id);
          }).catch(function (e) { toast(e.message, true); });
        };
      });
      var fileEl = view.querySelector('#pg-file');
      view.querySelector('#pg-import').onclick = function () { fileEl.value = ''; fileEl.click(); };
      fileEl.onchange = function () {
        var f = fileEl.files[0];
        if (!f) return;
        f.text().then(function (t) {
          var obj;
          try { obj = JSON.parse(t); } catch (e) { throw new Error('That file is not valid JSON'); }
          return api('/api/plugins/import', { method: 'POST', body: obj });
        }).then(function (res) { toast('Imported', { level: 'ok' }); show('plugins/' + res.id); })
          .catch(function (e) { toast(e.message, true); });
      };
    }).catch(function (e) { view.innerHTML = '<h1>Guest lookup</h1><p class="bad">' + esc(e.message) + '</p>'; });
  }

  // ---- guest lookup: browse-catalog card (list view only) ----
  function pgCatalogRow(p, installedNames) {
    var installed = installedNames.indexOf(p.name) !== -1;
    var inputs = (p.inputs || []).map(function (i) { return '<span class="chip">' + esc(i) + '</span>'; }).join('');
    var tags = (p.tags || []).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('');
    return '<div class="cat-row">' +
      '<div class="cat-main"><b>' + esc(p.name) + '</b>' +
      (p.description ? '<div class="muted">' + esc(p.description) + '</div>' : '') +
      (p.author ? '<div class="muted" style="font-size:11.5px">by ' + esc(p.author) + '</div>' : '') +
      (p.requires ? '<div class="muted" style="font-size:11.5px">Requires: ' + esc(p.requires) + '</div>' : '') +
      '</div>' +
      '<div class="cat-meta">' +
      '<span class="pill ' + (p.parser ? 'info">' + esc(p.parser) : 'disabled">no parser') + '</span>' +
      (inputs ? '<div class="chips">' + inputs + '</div>' : '') +
      (tags ? '<div class="chips">' + tags + '</div>' : '') +
      '</div>' +
      '<div class="cat-actions">' +
      (installed ? '<span class="pill disabled">installed</span>' : '') +
      '<button class="btn sm primary" data-catimp="' + esc(p.url) + '" data-catname="' + esc(p.name) + '">Import</button>' +
      '</div></div>';
  }
  function pgCatalogLoad(source, installedNames, resultsEl, footEl) {
    resultsEl.innerHTML = '<p class="muted">Loading…</p>';
    footEl.innerHTML = '';
    api('/api/plugins/catalog?source=' + encodeURIComponent(source)).then(function (r) {
      var plugins = r.plugins || [];
      resultsEl.innerHTML = plugins.length
        ? '<div class="cat-grid">' + plugins.map(function (p) { return pgCatalogRow(p, installedNames); }).join('') + '</div>'
        : '<p class="empty">No plugins found in this catalog.</p>';
      var bits = [];
      if (r.kind) bits.push('kind: ' + esc(r.kind));
      if (r.updated) bits.push('updated: ' + esc(r.updated));
      bits.push('source: ' + esc(r.source || source));
      footEl.innerHTML = '<p class="muted cat-foot">' + bits.join(' · ') + '</p>';
      resultsEl.querySelectorAll('[data-catimp]').forEach(function (b) {
        b.onclick = function () {
          b.disabled = true;
          api('/api/plugins/catalog/import', { method: 'POST', body: { url: b.dataset.catimp } }).then(function (res) {
            toast('Imported \'' + (res.name || b.dataset.catname) + '\' (disabled) — add secrets/URL, test, then enable', { level: 'ok' });
            show('plugins/' + res.id);
          }).catch(function (e) { b.disabled = false; toast(e.message, true); });
        };
      });
    }).catch(function (e) {
      if (e.status === 502) {
        resultsEl.innerHTML = '<div class="notice-inline"><b>' + esc(e.message) + '</b>' +
          (e.hint ? '<div>' + esc(e.hint) + '</div>' : '') + '</div>';
      } else {
        resultsEl.innerHTML = '<p class="bad">' + esc(e.message) + '</p>';
      }
    });
  }

  // ---- editor ----
  function pgOpenEditor(id) {
    view.innerHTML = '<h1>Guest lookup</h1><p class="muted">Loading…</p>';
    var jobs = [api('/api/plans'), id == null ? api('/api/plugins/recipe-template') : api('/api/plugins/' + id)];
    Promise.all(jobs).then(function (res) {
      var recipe = res[1] || {};
      var hasSecrets = recipe.has_secrets || {};
      delete recipe.has_secrets;
      var draft = pgDraftFromRecipe(recipe);
      draft.secretKeys.forEach(function (k) { if (!(k in hasSecrets)) hasSecrets[k] = false; });
      pg = {
        id: id == null ? null : Number(recipe.id || id),
        draft: draft,
        savedJson: JSON.stringify(pgRecipeFromDraft(draft)),
        hasSecrets: hasSecrets,
        hadAuth: !!recipe.auth, hadWindow: !!recipe.window,
        secrets: {},
        plans: (res[0] && res[0].plans) || [],
        raw: false, rawText: '',
        testInputs: {}, testResult: null, testRunning: false,
        errorSummary: null,
      };
      pgRender();
    }).catch(function (e) { view.innerHTML = '<h1>Guest lookup</h1><p class="bad">' + esc(e.message) + '</p>'; });
  }

  function pgSectionBasics() {
    var d = pg.draft;
    var groups = [], seen = {};
    pg.plans.forEach(function (p) {
      if (!p.radius_groupname || seen[p.radius_groupname]) return;
      seen[p.radius_groupname] = 1;
      groups.push([p.radius_groupname, p.name + '  (' + p.radius_groupname + ')']);
    });
    if (d.planGroup && !seen[d.planGroup]) groups.unshift([d.planGroup, d.planGroup + '  (no matching plan)']);
    return '<div class="card pg-sec"><h2>Basics</h2><div class="row pg-r">' +
      fieldH('pg-name', 'Name', pgTxt('name', d.name, ' id="pg-name" data-path="name" placeholder="Hotel guest system"'), 'Shown in this list and in the portal editor.') +
      fieldH('pg-plan', 'Plan group', pgSel('planGroup', groups, d.planGroup, ' id="pg-plan" data-path="planGroup"'), 'The RADIUS group a matched guest is put in — i.e. which plan\'s limits they get.') +
      fieldH('pg-timeout', 'Timeout (ms)', pgTxt('timeoutMs', d.timeoutMs, ' id="pg-timeout" type="number" min="1000" max="30000" data-path="timeoutMs" placeholder="8000"'), '1000–30000. How long to wait for the guest system.') +
      fieldH('pg-max', 'Max records', pgTxt('maxRecords', d.maxRecords, ' id="pg-max" type="number" min="1" max="5000" data-path="maxRecords" placeholder="200"'), 'Safety cap on how many records a response may contain.') +
      '</div><div class="pg-toggles">' +
      pgChk('enabled', d.enabled, 'Enabled ' + help('Disabled plugins stay configured but refuse guest logins.')) +
      pgChk('allowInsecureTls', d.allowInsecureTls, 'Allow insecure TLS ' + help('Accept self-signed / expired certificates on the guest system. Only for a trusted LAN address.')) +
      '</div></div>';
  }

  function pgKvRows(rows, addAct, delAct, bindBase, ph) {
    var body = rows.length ? rows.map(function (r, i) {
      return '<div class="kv-row">' +
        '<input class="kv-k" data-bind="' + bindBase + '.' + i + '.k" value="' + esc(r.k) + '" placeholder="' + esc(ph[0]) + '">' +
        '<input class="kv-v" data-bind="' + bindBase + '.' + i + '.v" value="' + esc(r.v) + '" placeholder="' + esc(ph[1]) + '">' +
        '<button type="button" class="btn sm kv-x" data-act="' + delAct + ':' + i + '" title="Remove">×</button></div>';
    }).join('') : '<p class="muted kv-empty">None.</p>';
    return '<div class="kv-list">' + body + '</div><button type="button" class="btn sm" data-act="' + addAct + '">+ Add header</button>';
  }

  function pgSectionAuth() {
    var d = pg.draft, a = d.auth;
    var head = '<div class="card pg-sec"><h2>Authentication</h2>' +
      '<p class="hint">Some guest systems want a login call first, and give back a token to send on every lookup. Skip this if a static API key header is all you need.</p>' +
      '<div class="pg-toggles">' + pgChk('authOn', d.authOn, 'This API needs a login step', ' data-restructure') + '</div>';
    if (!d.authOn) return head + pgSectionSecrets() + '</div>';
    return head +
      '<div class="row pg-r">' +
      fieldH('pg-au-m', 'Method', pgSel('auth.method', ['POST', 'GET'], a.method, ' id="pg-au-m"'), '') +
      fieldH('pg-au-u', 'Token URL', pgTxt('auth.url', a.url, ' id="pg-au-u" data-path="auth.url" placeholder="https://pms.example.com/auth/token" class="wide"'), 'Where to POST the credentials.') +
      fieldH('pg-au-ct', 'Content type', pgSel('auth.contentType', ['json', 'form'], a.contentType, ' id="pg-au-ct"'), '') +
      '</div>' +
      '<div class="field pg-f"><label for="pg-au-b">Body template</label>' +
      pgTa('auth.bodyTemplate', a.bodyTemplate, ' id="pg-au-b" rows="3" class="mono-ta"') +
      '<span class="hint">Reference your declared secrets: ' + pgSecretPlaceholders(d.secretKeys) + '.</span></div>' +
      '<div class="field pg-f"><label>Login headers</label>' + pgKvRows(d.authHeaderRows, 'add-ahdr', 'del-ahdr', 'authHeaderRows', ['Header', 'Value']) + '</div>' +
      '<div class="row pg-r">' +
      fieldH('pg-au-tp', 'Token path', pgTxt('auth.tokenPath', a.tokenPath, ' id="pg-au-tp" placeholder="token"'), 'Dotted path to the token in the JSON reply, e.g. <code>data.access_token</code>.') +
      fieldH('pg-au-ttl', 'Token TTL (s)', pgTxt('auth.tokenTtlSecs', a.tokenTtlSecs, ' id="pg-au-ttl" type="number" min="1" placeholder="3600"'), 'How long to reuse a token before logging in again.') +
      '</div><div class="row pg-r">' +
      fieldH('pg-au-pi', 'Send token in', pgSel('auth.placement.in', ['header', 'query', 'body'], a.placement.in, ' id="pg-au-pi"'), '') +
      fieldH('pg-au-pn', 'Name', pgTxt('auth.placement.name', a.placement.name, ' id="pg-au-pn" placeholder="Authorization"'), 'Header / query / body key the token goes under.') +
      fieldH('pg-au-pp', 'Prefix', pgTxt('auth.placement.prefix', a.placement.prefix, ' id="pg-au-pp" placeholder="Bearer "'), 'Prepended to the token value.') +
      '</div>' + pgSectionSecrets() + '</div>';
  }

  function pgSectionSecrets() {
    var d = pg.draft, h = pg.hasSecrets || {};
    var defaultHints = {
      username: 'Template as <code>{{secret.username}}</code>.',
      password: 'Template as <code>{{secret.password}}</code>.',
      apiKey: 'Template as <code>{{secret.apiKey}}</code> — often in a header.',
    };
    var rows = d.secretKeys.map(function (key, ix) {
      var stored = !!h[key];
      var label = d.secretLabels[key] || key;
      var hint = defaultHints[key] || ('Template as <code>{{secret.' + esc(key) + '}}</code>.');
      return '<div class="field pg-f"><label for="pg-s-' + esc(key) + '" style="display:flex;align-items:center;justify-content:space-between;gap:6px">' +
        '<span>' + esc(label) + '</span>' +
        '<button type="button" class="btn sm kv-x" data-act="del-secretkey:' + ix + '" title="Remove this secret key">×</button></label>' +
        '<div class="pg-secret"><input id="pg-s-' + esc(key) + '" type="password" autocomplete="new-password" data-secret="' + esc(key) + '" value="" placeholder="' + (stored ? '(unchanged)' : 'not set') + '">' +
        '<span class="pill ' + (stored ? 'set">stored' : 'notset">empty') + '</span></div>' +
        '<span class="hint">' + hint + '</span></div>';
    }).join('');
    return '<div class="pg-sub"><h3>Secrets</h3>' +
      '<p class="hint">Stored separately from the recipe and never sent back to this page. Leave a box blank to keep what is already stored.</p>' +
      '<div class="row pg-r">' + rows + '</div>' +
      '<div class="row pg-r" style="margin-top:10px"><div class="field pg-f" style="flex:1 1 200px">' +
      '<label for="pg-newsecret">Add secret key</label><input id="pg-newsecret" placeholder="e.g. clientId"></div>' +
      '<button type="button" class="btn sm" data-act="add-secretkey">+ Add</button></div>' +
      '</div>';
  }

  function pgSectionRequest() {
    var d = pg.draft, rq = d.request;
    return '<div class="card pg-sec"><h2>Request</h2>' +
      '<p class="hint">The call that looks a guest up. Everything here can use <code>{{input.&lt;name&gt;}}</code> for what the visitor typed, <code>{{secret.…}}</code>, and <code>{{token}}</code>.</p>' +
      '<div class="row pg-r">' +
      fieldH('pg-rq-m', 'Method', pgSel('request.method', ['GET', 'POST'], rq.method, ' id="pg-rq-m"'), '') +
      fieldH('pg-rq-u', 'URL', pgTxt('request.url', rq.url, ' id="pg-rq-u" data-path="request.url" class="wide" placeholder="https://pms.example.com/guests?room={{input.room}}"'), 'e.g. <code>https://pms.example.com/guests?room={{input.room}}</code> — values are URL-escaped for you.') +
      '</div><div class="row pg-r">' +
      fieldH('pg-rq-ct', 'Body content type', pgSel('request.contentType', ['json', 'form', 'xml', 'text'], rq.contentType, ' id="pg-rq-ct"'), 'Only matters when there is a body.') +
      fieldH('pg-rq-ac', 'Accept', pgSel('request.accept', [['', '(none)'], 'json', 'xml', 'text'], rq.accept, ' id="pg-rq-ac"'), 'Sets the <code>Accept</code> header if the API needs one.') +
      '</div>' +
      '<div class="field pg-f"><label>Headers</label>' + pgKvRows(d.headerRows, 'add-hdr', 'del-hdr', 'headerRows', ['X-Api-Key', '{{secret.' + (d.secretKeys[d.secretKeys.length - 1] || 'apiKey') + '}}']) + '</div>' +
      '<div class="field pg-f"><label for="pg-rq-b">Body template</label>' + pgTa('request.bodyTemplate', rq.bodyTemplate, ' id="pg-rq-b" rows="3" class="mono-ta" placeholder="(leave empty for GET)"') +
      '<span class="hint">Rendered and escaped for the content type above.</span></div></div>';
  }

  function pgSectionParser() {
    var d = pg.draft, ps = d.parse;
    var ctx = '';
    if (ps.type === 'regex') {
      ctx = '<div class="field pg-f"><label for="pg-ps-rx">Record regex</label>' + pgTa('parse.recordRegex', ps.recordRegex, ' id="pg-ps-rx" rows="3" class="mono-ta" data-path="parse.recordRegex"') +
        '<span class="hint">One match per record, using named groups: <code>Room: (?&lt;room&gt;\\S+)</code>. Group names become field names.</span></div>';
    } else {
      ctx = fieldH('pg-ps-root', 'Root path', pgTxt('parse.root', ps.root, ' id="pg-ps-root" data-path="parse.root" placeholder="' + (ps.type === 'xml' ? 'guests.guest' : 'guests') + '"'),
        ps.type === 'xml' ? 'Dotted path to the repeating element, e.g. <code>guests.guest</code>. Blank = the document root.'
          : 'Dotted path to the array of records, e.g. <code>data.bookings</code>. Blank = the response itself.');
    }
    var rows = d.fieldRows.length ? d.fieldRows.map(function (f, i) {
      return '<div class="kv-row">' +
        '<select class="kv-pick" data-fieldpick="' + i + '"><option value="">canonical…</option>' + pgOpts(CANON_FIELDS, '') + '</select>' +
        '<input class="kv-k" data-bind="fieldRows.' + i + '.key" value="' + esc(f.key) + '" placeholder="field name">' +
        '<span class="kv-arrow">→</span>' +
        '<input class="kv-v" data-bind="fieldRows.' + i + '.path" value="' + esc(f.path) + '" placeholder="' + (ps.type === 'regex' ? 'capture group' : 'path in the record') + '">' +
        '<button type="button" class="btn sm kv-x" data-act="del-field:' + i + '" title="Remove">×</button></div>';
    }).join('') : '<p class="muted kv-empty">No fields mapped yet.</p>';
    return '<div class="card pg-sec"><h2>Parser</h2>' +
      '<p class="hint">Turns the response into records, then names the bits you care about. Canonical names carry meaning downstream — <code>firstName</code>/<code>lastName</code>/<code>room</code> build the guest label; <code>checkIn</code>/<code>checkOut</code> feed the stay window.</p>' +
      '<div class="row pg-r">' +
      fieldH('pg-ps-t', 'Response type', pgSel('parse.type', ['json', 'xml', 'regex'], ps.type, ' id="pg-ps-t" data-restructure'), '') +
      ctx +
      fieldH('pg-ps-df', 'Date format', pgSel('parse.dateFormat', ['iso', 'dmy', 'mdy', 'ymd', 'epoch', 'sql'], ps.dateFormat, ' id="pg-ps-df"'), 'How check-in / check-out dates are written in the response. <code>sql</code> = <code>YYYY-MM-DD HH:MM:SS</code> (UTC).') +
      '</div>' +
      '<div class="field pg-f"><label>Field map</label><div class="kv-list">' + rows + '</div>' +
      '<button type="button" class="btn sm" data-act="add-field">+ Add field</button>' +
      '<span class="hint">Left: the name you will use in match rules. Right: where to read it from each record' + (ps.type === 'regex' ? ' (the capture group name).' : ' (a dotted path inside the record).') + '</span></div></div>';
  }

  function pgSectionMatch() {
    var d = pg.draft;
    var inputNames = d.inputs.map(function (i) { return i.name; }).filter(Boolean);
    var allFields = pgAllFields();
    var rows = d.match.rules.length ? d.match.rules.map(function (ru, i) {
      var inOpts = inputNames.slice();
      if (ru.input && inOpts.indexOf(ru.input) === -1) inOpts.unshift(ru.input);
      var target;
      if (ru.mode === 'anyOf') {
        var chips = ru.anyOf.map(function (f, j) {
          return '<span class="chip">' + esc(f) + '<button type="button" data-act="del-any:' + i + ':' + j + '" title="Remove">×</button></span>';
        }).join('');
        var remaining = allFields.filter(function (f) { return ru.anyOf.indexOf(f) === -1; });
        target = '<div class="chips" data-path="match.rules[' + i + '].anyOf">' + (chips || '<span class="muted">no fields yet</span>') +
          '<select class="chip-add" data-addany="' + i + '"><option value="">+ field…</option>' + pgOpts(remaining, '') + '</select></div>';
      } else {
        var fOpts = allFields.slice();
        if (ru.field && fOpts.indexOf(ru.field) === -1) fOpts.unshift(ru.field);
        target = '<select data-bind="match.rules.' + i + '.field" data-path="match.rules[' + i + '].field"><option value="">select…</option>' + pgOpts(fOpts, ru.field) + '</select>';
      }
      return '<div class="rule-row">' +
        '<select data-bind="match.rules.' + i + '.input" data-path="match.rules[' + i + '].input"><option value="">input…</option>' + pgOpts(inOpts, ru.input) + '</select>' +
        '<select data-bind="match.rules.' + i + '.mode" data-restructure>' + pgOpts([['field', 'matches'], ['anyOf', 'matches any of']], ru.mode) + '</select>' +
        '<div class="rule-target">' + target + '</div>' +
        '<select data-bind="match.rules.' + i + '.normalize" data-path="match.rules[' + i + '].normalize" title="normalize">' + pgOpts(NORMALIZERS, ru.normalize) + '</select>' +
        '<button type="button" class="btn sm kv-x" data-act="del-rule:' + i + '" title="Remove">×</button></div>';
    }).join('') : '<p class="muted kv-empty">No rules yet — a plugin needs at least one.</p>';
    return '<div class="card pg-sec"><h2>Match rules</h2>' +
      '<p class="hint">Compare what the visitor typed against a parsed field. <b>normalize</b> loosens the comparison: <code>name</code> ignores case/accents/punctuation, <code>phone</code>/<code>digits</code> compare digits only, <code>trim</code> is an exact match after trimming.</p>' +
      '<div class="rule-list">' + rows + '</div>' +
      '<button type="button" class="btn sm" data-act="add-rule">+ Add rule</button>' +
      '<div class="pg-toggles" style="margin-top:12px">' + pgChk('match.all', d.match.all, 'Guest must match every rule ' + help('Off: matching any single rule is enough.')) + '</div>' +
      '<div class="row pg-r" style="margin-top:12px">' +
      fieldH('pg-m-minrules', 'Minimum satisfied rules', pgTxt('match.minRules', d.match.minRules, ' id="pg-m-minrules" type="number" min="0" data-path="match.minRules" placeholder="0"'),
        'A rule is "satisfied" when its input was non-empty and it matched. Require at least this many satisfied rules, on top of the check above — e.g. a required room plus at least one of several optional identifiers. 0 = off (today\'s behaviour).') +
      '</div>' +
      (d.inputs.length ? '' : '<p class="hint" style="color:var(--amber)">Define at least one guest input below first — rules point at inputs by name.</p>') +
      '</div>';
  }

  function pgSectionWindow() {
    var d = pg.draft, w = d.window;
    var dateFields = d.fieldRows.map(function (f) { return String(f.key).trim(); }).filter(Boolean);
    var head = '<div class="card pg-sec"><h2>Stay window</h2>' +
      '<p class="hint">Only admit a matched guest while their stay is current. Without this, any matching record gets in.</p>' +
      '<div class="pg-toggles">' + pgChk('windowOn', d.windowOn, 'Check the booking dates', ' data-restructure') + '</div>';
    if (!d.windowOn) return head + '</div>';
    var sOpts = dateFields.slice(), eOpts = dateFields.slice();
    if (w.start && sOpts.indexOf(w.start) === -1) sOpts.unshift(w.start);
    if (w.end && eOpts.indexOf(w.end) === -1) eOpts.unshift(w.end);
    return head + '<div class="row pg-r">' +
      fieldH('pg-w-s', 'Start field', '<select data-bind="window.start" id="pg-w-s" data-path="window.start"><option value="">select…</option>' + pgOpts(sOpts, w.start) + '</select>', 'Must be one of your mapped fields (usually <code>checkIn</code>).') +
      fieldH('pg-w-e', 'End field', '<select data-bind="window.end" id="pg-w-e" data-path="window.end"><option value="">select…</option>' + pgOpts(eOpts, w.end) + '</select>', 'Usually <code>checkOut</code>.') +
      fieldH('pg-w-l', 'Leeway (hours)', pgTxt('window.leewayHours', w.leewayHours, ' id="pg-w-l" type="number" min="0" max="720" data-path="window.leewayHours" placeholder="(global default)"'), 'Grace either side of the stay — early arrivals, late check-outs. Blank = use the global default from <a href="#settings" data-tab="settings">Settings</a>.') +
      fieldH('pg-w-g', 'Max grant (hours)', pgTxt('window.maxGrantHours', w.maxGrantHours, ' id="pg-w-g" type="number" min="1" max="8760" data-path="window.maxGrantHours" placeholder="168"'), 'Hard cap on how long one login is valid, whatever the dates say.') +
      '</div></div>';
  }

  function pgSectionInputs() {
    var d = pg.draft;
    var rows = d.inputs.length ? d.inputs.map(function (i, ix) {
      return '<div class="in-row">' +
        '<input class="in-name" data-bind="inputs.' + ix + '.name" data-path="inputs[' + ix + '].name" value="' + esc(i.name) + '" placeholder="room" data-restructure>' +
        '<input class="in-label" data-bind="inputs.' + ix + '.label" data-path="inputs[' + ix + '].label" value="' + esc(i.label) + '" placeholder="Room number">' +
        '<select data-bind="inputs.' + ix + '.type">' + pgOpts(['text', 'tel', 'email', 'number'], i.type) + '</select>' +
        '<label class="pg-chk in-req"><input type="checkbox" data-bind="inputs.' + ix + '.required"' + (i.required ? ' checked' : '') + '><span>required</span></label>' +
        '<input class="in-ph" data-bind="inputs.' + ix + '.placeholder" value="' + esc(i.placeholder) + '" placeholder="e.g. 101">' +
        '<span class="in-move"><button type="button" class="btn sm kv-x" data-act="move-input:' + ix + ':-1" title="Move up">↑</button>' +
        '<button type="button" class="btn sm kv-x" data-act="move-input:' + ix + ':1" title="Move down">↓</button>' +
        '<button type="button" class="btn sm kv-x" data-act="del-input:' + ix + '" title="Remove">×</button></span></div>';
    }).join('') : '<p class="muted kv-empty">No inputs — the login block would have nothing to ask for.</p>';
    return '<div class="card pg-sec"><h2>Guest inputs</h2>' +
      '<p class="hint">The boxes the portal shows a visitor. <b>Name</b> is the slug you reference as <code>{{input.&lt;name&gt;}}</code> and in match rules (lowercase letters, digits and <code>_</code>); <b>label</b> is what the guest reads.</p>' +
      '<div class="in-head"><span>Name</span><span>Label</span><span>Type</span><span></span><span>Placeholder</span><span></span></div>' +
      '<div class="in-list">' + rows + '</div>' +
      '<button type="button" class="btn sm" data-act="add-input">+ Add input</button></div>';
  }

  function pgSectionStepsNotice() {
    return '<div class="card pg-sec"><h2>Multi-step lookup</h2>' +
      '<p class="hint">This recipe uses ' + pg.draft.stepsCount + ' steps — edit them in Raw JSON.</p></div>';
  }

  // One value widget for a declared param, bound to params.<ix>.value
  // (falls back to the param's own default at render time — see pgDraftFromRecipe).
  function pgParamValueField(p, ix) {
    var label = p.label || p.name;
    var id = 'pg-pv-' + ix;
    if (p.type === 'boolean') {
      return '<div class="field pg-f">' + pgChk('params.' + ix + '.value', p.value === true || p.value === 'true', esc(label) + (p.help ? ' ' + help(p.help) : '')) + '</div>';
    }
    var input;
    if (p.type === 'select') {
      var opts = pgOptionsFromText(p.optionsText).map(function (o) { return [o.value, o.label]; });
      input = pgSel('params.' + ix + '.value', opts, p.value, ' id="' + id + '"');
    } else if (p.type === 'number') {
      input = pgTxt('params.' + ix + '.value', p.value, ' id="' + id + '" type="number"');
    } else {
      input = pgTxt('params.' + ix + '.value', p.value, ' id="' + id + '"');
    }
    return fieldH(id, esc(label), input, p.help ? esc(p.help) : '');
  }

  function pgSectionParamValues() {
    var d = pg.draft, htmls = [];
    d.params.forEach(function (p, ix) { if (String(p.name || '').trim()) htmls.push(pgParamValueField(p, ix)); });
    if (!htmls.length) return '<p class="muted kv-empty">No parameters declared yet — add one below.</p>';
    return '<div class="row pg-r">' + htmls.join('') + '</div>';
  }

  function pgSectionParamsDeclare() {
    var d = pg.draft;
    var rows = d.params.length ? d.params.map(function (p, ix) {
      var showOpts = p.type === 'select';
      return '<div class="kv-row">' +
        '<input class="kv-k" data-bind="params.' + ix + '.name" value="' + esc(p.name) + '" placeholder="name" data-restructure>' +
        '<input class="kv-v" data-bind="params.' + ix + '.label" value="' + esc(p.label) + '" placeholder="Label">' +
        '<select class="kv-pick" data-bind="params.' + ix + '.type" data-restructure>' + pgOpts(['text', 'number', 'boolean', 'select'], p.type) + '</select>' +
        '<input data-bind="params.' + ix + '.default" value="' + esc(p.default) + '" placeholder="default" style="flex:1 1 120px">' +
        '<button type="button" class="btn sm kv-x" data-act="del-param:' + ix + '" title="Remove">×</button></div>' +
        (showOpts ? '<div class="field pg-f"><label>Options (one per line, <span class="mono">value|label</span>)</label>' +
          pgTa('params.' + ix + '.optionsText', p.optionsText, ' rows="2" class="mono-ta"') + '</div>' : '') +
        '<div class="field pg-f" style="margin-bottom:10px"><label>Help text</label>' + pgTxt('params.' + ix + '.help', p.help, '') + '</div>';
    }).join('') : '<p class="muted kv-empty">No parameters declared yet.</p>';
    return '<div class="pg-sub"><h3>Declare parameters</h3>' +
      '<p class="hint">Operator-facing config — regions, feature flags, limits (not secret — exported with the recipe). Reference as <code>{{param.&lt;name&gt;}}</code>.</p>' +
      '<div class="kv-list">' + rows + '</div>' +
      '<button type="button" class="btn sm" data-act="add-param">+ Add parameter</button></div>';
  }

  function pgSectionParams() {
    return '<div class="card pg-sec"><h2>Parameters</h2>' +
      '<p class="hint">Non-secret configuration this recipe needs.</p>' +
      pgSectionParamValues() + pgSectionParamsDeclare() + '</div>';
  }

  function pgSectionMessages() {
    var m = pg.draft.messages;
    return '<div class="card pg-sec"><h2>Messages</h2>' +
      '<p class="hint">What the portal tells a visitor when the lookup does not admit them. Leave blank for the built-in wording.</p>' +
      '<div class="field pg-f"><label for="pg-m1">No match</label>' + pgTa('messages.noMatch', m.noMatch, ' id="pg-m1" rows="2"') + '</div>' +
      '<div class="field pg-f"><label for="pg-m2">Outside the stay window</label>' + pgTa('messages.outsideWindow', m.outsideWindow, ' id="pg-m2" rows="2"') + '</div>' +
      '<div class="field pg-f"><label for="pg-m3">Guest system unreachable</label>' + pgTa('messages.upstream', m.upstream, ' id="pg-m3" rows="2"') + '</div></div>';
  }

  function pgTestCard() {
    var d = pg.draft;
    var body;
    if (pg.id == null) {
      body = '<p class="empty">Save the plugin first — testing runs the saved recipe (including its stored secrets) against the real guest system.</p>';
    } else if (!d.inputs.length) {
      body = '<p class="empty">Add at least one guest input to test with.</p>';
    } else {
      body = '<div class="row pg-r">' + d.inputs.map(function (i) {
        return field('pg-t-' + i.name, esc(i.label || i.name) + (i.required ? ' *' : ''),
          '<input id="pg-t-' + esc(i.name) + '" data-testin="' + esc(i.name) + '" type="' + esc(i.type === 'number' ? 'number' : i.type) + '" value="' + esc(pg.testInputs[i.name] || '') + '" placeholder="' + esc(i.placeholder || '') + '">');
      }).join('') + '<button type="button" class="btn primary" data-act="run-test"' + (pg.testRunning ? ' disabled' : '') + '>' + (pg.testRunning ? 'Running…' : 'Run lookup') + '</button></div>';
    }
    return '<div class="card pg-sec" id="pg-test"><h2>Test</h2>' +
      '<p class="hint">Runs the saved recipe against the live guest system with a fresh token — nothing is granted, no guest is logged in.</p>' +
      body + '<div id="pg-test-out">' + (pg.testResult ? pgTestResultHtml(pg.testResult) : '') + '</div></div>';
  }

  function pgTestResultHtml(r) {
    var head, cls;
    if (r.ok) {
      cls = 'ok';
      head = 'Guest found: ' + esc((r.guest && r.guest.label) || '(unlabelled)') +
        (r.expiresAt ? ' — would be granted until ' + esc(localStamp(r.expiresAt)) + ' <span class="muted">(' + esc(relTime(r.expiresAt)) + ')</span>' : '');
    } else {
      cls = r.reason === 'no-match' || r.reason === 'outside-window' ? 'warn' : 'fail';
      var labels = { 'no-match': 'No matching booking', 'outside-window': 'Found, but outside the stay window',
        upstream: 'Guest system error', timeout: 'Timed out' };
      head = labels[r.reason] || ('Failed' + (r.reason ? ' (' + esc(r.reason) + ')' : ''));
      if (r.status) head += ' <span class="muted">HTTP ' + esc(String(r.status)) + '</span>';
      if (r.detail) head += '<div class="muted tr-detail">' + esc(r.detail) + '</div>';
    }
    var html = '<div class="test-result tr-' + cls + '"><div class="tr-head">' + head + '</div>' +
      '<div class="muted tr-ms">' + (r.ms != null ? r.ms + ' ms' : '') + '</div></div>';
    var recs = r.records || [];
    if (recs.length) {
      var cols = [];
      recs.forEach(function (rec) { Object.keys(rec || {}).forEach(function (k) { if (cols.indexOf(k) === -1) cols.push(k); }); });
      html += '<h3 class="tr-h3">Parsed records (first ' + recs.length + ')</h3><div class="tr-table"><table><thead><tr>' +
        cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        recs.map(function (rec) {
          return '<tr>' + cols.map(function (c) { return '<td class="mono">' + esc(rec && rec[c] == null ? '' : rec[c]) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>';
    } else if (r.ok || r.reason === 'no-match') {
      html += '<p class="muted tr-h3">No records were parsed from the response — check the parser root / field map.</p>';
    }
    if (r.rawExcerpt) {
      html += '<details class="tr-raw"><summary>Raw response excerpt</summary><pre class="cfg">' + esc(r.rawExcerpt) + '</pre></details>';
    }
    return html;
  }

  function pgRender() {
    // The page (not .content) is the scroll container — body is a flex column
    // that grows, so restore window scroll around a full re-render.
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop || 0;
    var act = document.activeElement;
    var focusBind = act && act.dataset ? act.dataset.bind : null;
    var selStart = act && focusBind && act.selectionStart != null ? act.selectionStart : null;

    var d = pg.draft;
    var title = pg.id == null ? 'New lookup plugin' : 'Edit lookup plugin';
    var head = '<h1>' + title + '</h1><p class="sub">' +
      (pg.id == null ? 'Describe how to ask your guest system about a visitor. ' : 'Plugin #' + pg.id + '. ') +
      '<a href="' + GUEST_API_DOCS + '" target="_blank" rel="noopener">Recipe guide →</a></p>';

    var bar = '<div class="pg-bar"><button type="button" class="btn primary" data-act="save">Save</button>' +
      '<button type="button" class="btn" data-act="cancel">Cancel</button>' +
      '<button type="button" class="btn right" data-act="raw">' + (pg.raw ? 'Guided form' : 'Raw JSON') + '</button></div>';

    var body;
    if (pg.raw) {
      body = '<div class="card pg-sec"><h2>Raw recipe JSON</h2>' +
        '<p class="hint">The whole recipe as the API sees it. Switching back to the guided form parses this; invalid JSON keeps you here. Secrets you type here are sent on save — blank values keep whatever is stored.</p>' +
        '<textarea id="pg-raw" class="raw-json" spellcheck="false">' + esc(pg.rawText) + '</textarea></div>';
    } else {
      body = pgSectionBasics() + pgSectionAuth() +
        (d.hasSteps ? pgSectionStepsNotice() : (pgSectionRequest() + pgSectionParser())) +
        pgSectionMatch() + pgSectionWindow() + pgSectionInputs() + pgSectionParams() + pgSectionMessages();
    }
    var errs = pg.errorSummary && pg.errorSummary.length
      ? '<div class="card pg-errs"><h2>Could not save</h2><ul>' + pg.errorSummary.map(function (e) {
          return '<li><span class="mono">' + esc(e[0] || '(recipe)') + '</span> — ' + esc(e[1]) + '</li>';
        }).join('') + '</ul></div>'
      : '';
    view.innerHTML = head + bar + errs + body + pgTestCard() + bar;
    pgBind(view);

    if (pgFocusTest) {
      pgFocusTest = false;
      // After a frame, so a hash change's own scroll-to-top has already run.
      requestAnimationFrame(function () {
        var t = document.getElementById('pg-test');
        if (t) t.scrollIntoView({ block: 'start' });
      });
    } else {
      window.scrollTo(0, scrollTop);
    }
    if (focusBind) {
      var el = view.querySelector('[data-bind="' + focusBind + '"]');
      if (el) { el.focus(); if (selStart != null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selStart); } catch (e) { /* number inputs */ } } }
    }
  }

  function pgBind(root) {
    root.querySelectorAll('[data-bind]').forEach(function (el) {
      var path = el.dataset.bind;
      var isChk = el.type === 'checkbox';
      var ev = (isChk || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(ev, function () {
        pgSetPath(pg.draft, path, isChk ? el.checked : el.value);
        // Text inputs restructure on `change` (below), not on every keystroke.
        if (el.hasAttribute('data-restructure') && ev === 'change') pgRender();
      });
      if (!isChk && el.tagName !== 'SELECT' && el.hasAttribute('data-restructure')) {
        el.addEventListener('change', function () { pgRender(); });
      }
    });
    root.querySelectorAll('[data-secret]').forEach(function (el) {
      el.addEventListener('input', function () { pg.secrets[el.dataset.secret] = el.value; });
    });
    root.querySelectorAll('[data-testin]').forEach(function (el) {
      el.addEventListener('input', function () { pg.testInputs[el.dataset.testin] = el.value; });
    });
    root.querySelectorAll('[data-fieldpick]').forEach(function (el) {
      el.addEventListener('change', function () {
        if (!el.value) return;
        pg.draft.fieldRows[Number(el.dataset.fieldpick)].key = el.value;
        if (!pg.draft.fieldRows[Number(el.dataset.fieldpick)].path) pg.draft.fieldRows[Number(el.dataset.fieldpick)].path = el.value;
        pgRender();
      });
    });
    root.querySelectorAll('[data-addany]').forEach(function (el) {
      el.addEventListener('change', function () {
        if (!el.value) return;
        pg.draft.match.rules[Number(el.dataset.addany)].anyOf.push(el.value);
        pgRender();
      });
    });
    var raw = root.querySelector('#pg-raw');
    if (raw) raw.addEventListener('input', function () { pg.rawText = raw.value; });
    root.querySelectorAll('[data-act]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.preventDefault(); pgAction(el.dataset.act); });
    });
  }

  function pgAction(spec) {
    var p = spec.split(':'), a = p[0], d = pg.draft;
    if (a === 'add-hdr') { d.headerRows.push({ k: '', v: '' }); return pgRender(); }
    if (a === 'del-hdr') { d.headerRows.splice(Number(p[1]), 1); return pgRender(); }
    if (a === 'add-ahdr') { d.authHeaderRows.push({ k: '', v: '' }); return pgRender(); }
    if (a === 'del-ahdr') { d.authHeaderRows.splice(Number(p[1]), 1); return pgRender(); }
    if (a === 'add-field') { d.fieldRows.push({ key: '', path: '' }); return pgRender(); }
    if (a === 'del-field') { d.fieldRows.splice(Number(p[1]), 1); return pgRender(); }
    if (a === 'add-rule') {
      d.match.rules.push({ input: (d.inputs[0] && d.inputs[0].name) || '', mode: 'field', field: '', anyOf: [], normalize: 'trim' });
      return pgRender();
    }
    if (a === 'del-rule') { d.match.rules.splice(Number(p[1]), 1); return pgRender(); }
    if (a === 'del-any') { d.match.rules[Number(p[1])].anyOf.splice(Number(p[2]), 1); return pgRender(); }
    if (a === 'add-input') { d.inputs.push({ name: '', label: '', type: 'text', required: true, placeholder: '', autocomplete: '' }); return pgRender(); }
    if (a === 'del-input') { d.inputs.splice(Number(p[1]), 1); return pgRender(); }
    if (a === 'move-input') {
      var i = Number(p[1]), j = i + Number(p[2]);
      if (j < 0 || j >= d.inputs.length) return;
      var tmp = d.inputs[i]; d.inputs[i] = d.inputs[j]; d.inputs[j] = tmp;
      return pgRender();
    }
    if (a === 'add-param') { d.params.push({ name: '', label: '', help: '', type: 'text', default: '', optionsText: '', value: '' }); return pgRender(); }
    if (a === 'del-param') { d.params.splice(Number(p[1]), 1); return pgRender(); }
    if (a === 'add-secretkey') {
      var skEl = document.getElementById('pg-newsecret');
      var sk = skEl ? skEl.value.trim() : '';
      if (!sk) return;
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(sk)) return toast('Secret key must start with a letter, then letters/digits/underscore (max 31 chars)', true);
      if (d.secretKeys.indexOf(sk) !== -1) return toast('That secret key already exists', true);
      if (d.secretKeys.length >= 16) return toast('A recipe can declare at most 16 secret keys', true);
      d.secretKeys.push(sk);
      return pgRender();
    }
    if (a === 'del-secretkey') {
      var skIx = Number(p[1]), removed = d.secretKeys[skIx];
      d.secretKeys.splice(skIx, 1);
      if (removed) { delete pg.secrets[removed]; if (pg.hasSecrets) delete pg.hasSecrets[removed]; delete d.secretLabels[removed]; }
      return pgRender();
    }
    if (a === 'cancel') { pg = null; return show('plugins'); }
    if (a === 'raw') return pgToggleRaw();
    if (a === 'save') return pgSave().catch(function () { /* surfaced as a toast + inline errors */ });
    if (a === 'run-test') return pgRunTest();
  }

  // Never echoes stored secret values back into the guided form — this only
  // picks up secret values the admin just typed directly into the Raw JSON
  // textarea, so they aren't lost when switching back to the guided form.
  function pgSecretsFromParsed(parsed) {
    var keys = (parsed && parsed.secretKeys && parsed.secretKeys.length) ? parsed.secretKeys : ['username', 'password', 'apiKey'];
    var out = {};
    if (parsed && parsed.secrets && typeof parsed.secrets === 'object') {
      keys.forEach(function (k) { if (parsed.secrets[k]) out[k] = parsed.secrets[k]; });
    }
    return out;
  }

  function pgToggleRaw() {
    if (!pg.raw) {
      pg.rawText = JSON.stringify(pgRecipeFromDraft(pg.draft, pg.secrets), null, 2);
      pg.raw = true;
      return pgRender();
    }
    var parsed;
    try { parsed = JSON.parse(pg.rawText); } catch (e) { return toast('That is not valid JSON — ' + e.message, true); }
    if (!parsed || typeof parsed !== 'object' || parsed instanceof Array) return toast('The recipe must be a JSON object', true);
    if (parsed.recipe && typeof parsed.recipe === 'object') parsed = parsed.recipe;
    if (parsed.secrets && typeof parsed.secrets === 'object') pg.secrets = pgSecretsFromParsed(parsed);
    pg.draft = pgDraftFromRecipe(parsed);
    pg.draft.secretKeys.forEach(function (k) { if (!(k in pg.hasSecrets)) pg.hasSecrets[k] = false; });
    pg.raw = false;
    pg.errorSummary = null;
    pgRender();
    toast('Parsed', { level: 'ok' });
  }

  // Map a 400's {fields:{'dotted.path': msg}} onto the matching data-path
  // input; anything with no control (match, parse, '') goes to a summary card.
  function pgShowErrors(fields) {
    clearFieldErrors();
    var summary = [];
    Object.keys(fields || {}).forEach(function (k) {
      var el = view.querySelector('[data-path="' + k.replace(/"/g, '\\"') + '"]');
      if (!el) { summary.push([k, fields[k]]); return; }
      el.classList.add('is-err');
      var msg = document.createElement('span');
      msg.className = 'field-err';
      msg.textContent = fields[k];
      el.insertAdjacentElement('afterend', msg);
    });
    return summary;
  }

  function pgSave() {
    if (pg.raw) {
      var parsed;
      try { parsed = JSON.parse(pg.rawText); } catch (e) { return toast('That is not valid JSON — ' + e.message, true); }
      if (parsed && parsed.recipe && typeof parsed.recipe === 'object') parsed = parsed.recipe;
      if (parsed && parsed.secrets) pg.secrets = pgSecretsFromParsed(parsed);
      pg.draft = pgDraftFromRecipe(parsed || {});
      pg.draft.secretKeys.forEach(function (k) { if (!(k in pg.hasSecrets)) pg.hasSecrets[k] = false; });
      pg.raw = false;
      pgRender();
    }
    var body = pgRecipeFromDraft(pg.draft, pg.secrets);
    var req = pg.id == null
      ? api('/api/plugins', { method: 'POST', body: body })
      : api('/api/plugins/' + pg.id, { method: 'PATCH', body: body });
    return req.then(function (res) {
      toast('Saved', { level: 'ok' });
      if (pg.id != null && pg.hadAuth && !pg.draft.authOn) toast('Note: the stored authentication step cannot be removed by an update — re-create the plugin to drop it', { level: 'warn' });
      if (pg.id != null && pg.hadWindow && !pg.draft.windowOn) toast('Note: the stored stay window cannot be removed by an update — re-create the plugin to drop it', { level: 'warn' });
      var id = pg.id == null ? res.id : pg.id;
      pg = null;
      show('plugins/' + id);
    }).catch(function (e) {
      // Re-render either way, so a summary card from a previous failed save
      // never outlives the errors that produced it.
      var extra = e.fields ? pgShowErrors(e.fields) : [];
      pg.errorSummary = extra.length ? extra : null;
      pgRender();
      if (e.fields) pgShowErrors(e.fields);
      toast(e.message, true);
      throw e;
    });
  }

  function pgRunTest() {
    if (pg.id == null) return toast('Save the plugin before testing', true);
    if (pgDirty()) {
      if (!confirm('Test runs the saved recipe. Save your changes first?')) return;
      return pgSave().then(function () { toast('Saved — press Run lookup again', { level: 'ok' }); }).catch(function () {});
    }
    pg.testRunning = true;
    pgRender();
    var out = document.getElementById('pg-test-out');
    if (out) out.innerHTML = '<p class="muted">Running…</p>';
    api('/api/plugins/' + pg.id + '/test', { method: 'POST', body: { inputs: pg.testInputs } })
      .then(function (r) {
        pg.testRunning = false;
        pg.testResult = r;
        pgFocusTest = true;
        pgRender();
      }).catch(function (e) {
        pg.testRunning = false;
        pg.testResult = null;
        pgRender();
        toast(e.message, true);
      });
  }

  tabs.plugins = function () {
    var sub = routeSub;
    if (sub === 'new') return pgOpenEditor(null);
    if (sub && /^\d+$/.test(sub)) return pgOpenEditor(Number(sub));
    pg = null;
    pgList();
  };

  // ---- guests (active plugin grants) ----
  // SQLite datetime('now') columns are "YYYY-MM-DD HH:MM:SS" in UTC with no
  // zone marker — V8 would read them as local time, so pin them to UTC.
  function sqlLocal(s) {
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T') + 'Z';
    return localStamp(s);
  }
  function localStamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function relTime(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var delta = t - Date.now(), abs = Math.abs(delta), s;
    if (abs < 60000) s = Math.round(abs / 1000) + 's';
    else if (abs < 3600000) s = Math.round(abs / 60000) + 'm';
    else if (abs < 86400000) s = Math.round(abs / 3600000) + 'h';
    else s = Math.round(abs / 86400000) + 'd';
    return delta >= 0 ? 'in ' + s : s + ' ago';
  }
  function renderGuests(grants) {
    var rows = grants.length ? grants.map(function (g) {
      var rel = relTime(g.expires_at);
      var soon = Date.parse(g.expires_at) - Date.now() < 3600000;
      return '<tr><td><b>' + esc(g.guest_label || '—') + '</b></td>' +
        '<td>' + esc(g.plugin_name || '<deleted>') + '</td>' +
        '<td class="mono">' + esc(g.username) + '</td>' +
        '<td class="mono">' + esc(g.mac || '—') + '</td>' +
        '<td class="mono">' + esc(g.ip || '—') + '</td>' +
        '<td class="muted">' + esc(sqlLocal(g.granted_at) || '—') + '</td>' +
        '<td>' + esc(localStamp(g.expires_at)) + ' <span class="pill ' + (soon ? 'warn' : 'on') + '">' + esc(rel) + '</span></td>' +
        '<td><button class="btn sm danger" data-grev="' + g.id + '">Revoke</button></td></tr>';
    }).join('')
      : '<tr><td colspan="8" class="empty">No active guests. A row appears here when someone signs in through a <a href="#plugins" data-tab="plugins">guest lookup</a> block on the portal — it is their temporary RADIUS login and when it expires.</td></tr>';
    view.innerHTML =
      '<h1>Guests</h1><p class="sub">Temporary logins handed out by guest-lookup plugins. Each one is a real RADIUS account that disappears by itself when the stay window ends — revoke to cut someone off now.</p>' +
      '<div class="card"><table><thead><tr><th>Guest</th><th>Plugin</th><th>Username</th><th>MAC</th><th>IP</th><th>Granted</th><th>Expires</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table><p class="hint" style="margin-top:10px">Refreshes every 30 seconds while this tab is open.</p></div>';
    view.querySelectorAll('[data-grev]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Revoke this guest\'s access now? Their device drops off at the next re-auth.')) return;
        api('/api/plugins/grants/' + b.dataset.grev, { method: 'DELETE' })
          .then(function () { toast('Revoked', { level: 'ok' }); loadGuests(); })
          .catch(function (e) { toast(e.message, true); });
      };
    });
  }
  function loadGuests() {
    return api('/api/plugins/grants').then(function (r) { renderGuests(r.grants || []); })
      .catch(function (e) { view.innerHTML = '<h1>Guests</h1><p class="bad">' + esc(e.message) + '</p>'; });
  }
  tabs.guests = function () {
    view.innerHTML = '<h1>Guests</h1><p class="muted">Loading…</p>';
    loadGuests();
    guestsTimer = setInterval(function () {
      if (current !== 'guests' || document.body.classList.contains('gated')) return clearTabTimers();
      api('/api/plugins/grants').then(function (r) { renderGuests(r.grants || []); }).catch(function () {});
    }, 30000);
  };

  // ---- tiny view helpers ----
  function field(id, label, inner) { return '<div class="field"><label for="' + id + '">' + label + '</label>' + inner + '</div>'; }
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function numOrNull(id, mult) { var v = val(id); return v === '' ? null : Math.round(Number(v) * (mult || 1)); }
  function help(text) { return '<span class="help" tabindex="0" data-tip="' + esc(text) + '">?</span>'; }
  function fieldH(id, label, inner, hint) {
    return '<div class="field"><label for="' + id + '">' + label + '</label>' + inner +
      (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>';
  }
  // Mark inputs with inline errors from a 400 {fields:{key:msg}} response.
  // `map` optionally translates server field-keys to DOM ids (default: same key).
  function showFieldErrors(fields, map) {
    clearFieldErrors();
    Object.keys(fields || {}).forEach(function (k) {
      var id = (map && map[k]) || k;
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.add('is-err');
      var msg = document.createElement('span');
      msg.className = 'field-err';
      msg.textContent = fields[k];
      el.insertAdjacentElement('afterend', msg);
    });
  }
  function clearFieldErrors() {
    view.querySelectorAll('.is-err').forEach(function (e) { e.classList.remove('is-err'); });
    view.querySelectorAll('.field-err').forEach(function (e) { e.parentNode.removeChild(e); });
  }

  // ---- nav ----
  var current = '';
  var TITLES = { active: 'Active users', devices: 'Remembered devices', plans: 'Plans', vouchers: 'Vouchers',
    accounts: 'Accounts', plugins: 'Guest lookup', guests: 'Guests', logs: 'Logs', settings: 'Settings',
    announcements: 'Announcements', system: 'System', router: 'Router setup', backup: 'Backup', help: 'Help',
    designs: 'Designs' };
  function show(tab, opts) {
    opts = opts || {};
    clearTabTimers();
    var base = tab.split('/')[0];
    routeSub = tab.indexOf('/') !== -1 ? tab.slice(tab.indexOf('/') + 1) : '';
    if (base === 'logs' && routeSub) logSub = routeSub;
    document.querySelectorAll('#nav a[data-tab]').forEach(function (a) { a.classList.toggle('active', a.dataset.tab === base); });
    current = tab;
    (tabs[base] || tabs.active)();
    document.title = 'Tikspot · ' + (TITLES[base] || 'Admin');
    if (!opts.noHash && location.hash.slice(1) !== tab) location.hash = tab;
    renderNotices();
  }
  window.addEventListener('hashchange', function () {
    var h = (location.hash || '#active').slice(1);
    if (h !== current && !document.body.classList.contains('gated')) show(h, { noHash: true });
  });
  // Delegated: any in-app link with data-tab (nav, notices, cross-links inside a tab body).
  document.body.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-tab]');
    if (a) { e.preventDefault(); show(a.dataset.tab); }
  });
  document.getElementById('logout').onclick = function () {
    api('/api/auth/logout', { method: 'POST' }).then(boot);
  };

  // ---- gate: login / first-run wizard / dashboard ----
  function gateOn() { clearTabTimers(); document.body.classList.add('gated'); noticesEl.innerHTML = ''; }
  function gateOff() { document.body.classList.remove('gated'); }

  // ---- notice strip (admin-target announcements + system problems) ----
  function dismissedMap() {
    try { return JSON.parse(localStorage.getItem('tk-dismissed') || '{}'); } catch (e) { return {}; }
  }
  function setDismissed(id, updated_at) {
    var m = dismissedMap(); m[id] = updated_at; localStorage.setItem('tk-dismissed', JSON.stringify(m));
  }
  function renderNotices() {
    if (document.body.classList.contains('gated')) return;
    api('/api/notices').then(function (r) {
      var dismissed = dismissedMap();
      var anns = (r.announcements || []).filter(function (a) { return dismissed[a.id] !== a.updated_at; });
      var probs = r.problems || [];
      if (!anns.length && !probs.length) { noticesEl.innerHTML = ''; return; }
      var html = anns.map(function (a) {
        return '<div class="notice ' + esc(a.severity) + '"><div class="notice-body"><b>' + esc(a.title) + '</b>' +
          (a.body ? '<span>' + esc(a.body) + '</span>' : '') + '</div>' +
          '<button class="notice-x" data-dismiss="' + a.id + '" data-upd="' + esc(a.updated_at) + '" title="Dismiss">×</button></div>';
      }).join('') + probs.map(function (p) {
        return '<div class="notice-line ' + esc(p.level) + '"><span class="dot"></span> <span>' + esc(p.message) +
          '</span> <a href="#logs/events" data-tab="logs/events">View events</a></div>';
      }).join('');
      noticesEl.innerHTML = html;
      noticesEl.querySelectorAll('[data-dismiss]').forEach(function (b) {
        b.onclick = function () { setDismissed(b.dataset.dismiss, b.dataset.upd); renderNotices(); };
      });
    }).catch(function () { /* not fatal if not landed yet */ });
  }

  function renderLogin() {
    gateOn();
    document.title = 'Tikspot · Log in';
    view.innerHTML = '<div class="gate"><h1>Tikspot admin</h1><p class="sub">Enter the admin password.</p>' +
      '<div class="field"><input id="lg-pw" type="password" placeholder="Password" autofocus></div>' +
      '<button class="btn primary" id="lg-go">Log in</button></div>';
    function go() {
      api('/api/auth/login', { method: 'POST', body: { password: val('lg-pw') } })
        .then(function () { boot(); }).catch(function (e) { toast(e.message, true); });
    }
    view.querySelector('#lg-go').onclick = go;
    view.querySelector('#lg-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }

  function renderWizard(step) {
    gateOn();
    document.title = 'Tikspot · Setup';
    step = step || 1;
    var steps = '<div class="steps"><span' + (step === 1 ? ' class="b"' : '') + '><b>1.</b> Password</span>' +
      '<span' + (step === 2 ? ' class="b"' : '') + '>2. Router</span><span' + (step === 3 ? ' class="b"' : '') + '>3. Done</span></div>';
    if (step === 1) {
      view.innerHTML = '<div class="gate">' + steps + '<h1>Welcome to Tikspot</h1>' +
        '<p class="sub">Set an admin password to secure this portal.</p>' +
        '<div class="field"><input id="w-pw" type="password" placeholder="New password (min 6 chars)"></div>' +
        '<div class="field"><input id="w-pw2" type="password" placeholder="Confirm password"></div>' +
        '<button class="btn primary" id="w-next">Continue</button></div>';
      view.querySelector('#w-next').onclick = function () {
        if (val('w-pw').length < 6) return toast('Password too short', true);
        if (val('w-pw') !== val('w-pw2')) return toast('Passwords do not match', true);
        api('/api/setup/admin', { method: 'POST', body: { password: val('w-pw') } })
          .then(function () { renderWizard(2); }).catch(function (e) { toast(e.message, true); });
      };
    } else if (step === 2) {
      api('/api/setup/state').then(function (st) {
        view.innerHTML = '<div class="gate" style="max-width:620px">' + steps + '<h1>Connect your MikroTik</h1>' +
          '<p class="sub">Optional, but lets Tikspot configure the router for you. You can skip and do it later.</p>' +
          routerFormHtml(st) +
          '<div class="row" style="margin-top:14px">' +
          '<button class="btn" id="w-probe">Test connection</button>' +
          '<button class="btn primary" id="w-auto">Auto-configure</button>' +
          '<button class="btn" id="w-skip">Skip</button></div><div id="w-out" style="margin-top:12px"></div>' +
          scriptCardHtml() +
          '<div class="row" style="margin-top:14px"><button class="btn primary" id="w-next">Next</button></div></div>';
        var out = view.querySelector('#w-out');
        bindScript(view);
        bindRotate(view);
        view.querySelector('#w-probe').onclick = function () {
          out.innerHTML = '<p class="muted">Testing…</p>';
          saveRouter().then(function () { return api('/api/setup/probe', { method: 'POST' }); }).then(function (r) {
            var html = '<span class="ok">Connected — RouterOS ' + esc(r.version || '') + ' ' + esc(r.board || '') + '</span>';
            if (r.canWrite === false) html += '<div class="notice-line warn" style="margin-top:8px"><span class="dot"></span> <span>API user looks read-only — Auto-configure will fail; use the setup script or a <span class="mono">full</span> user.</span></div>';
            out.innerHTML = html;
          }).catch(function (e) { out.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
        };
        view.querySelector('#w-auto').onclick = function () {
          out.innerHTML = '<p class="muted">Configuring…</p>';
          saveRouter().then(function () { return api('/api/setup/autoconfig', { method: 'POST' }); }).then(function (r) {
            var html = renderSteps(r.steps);
            if (r.error) html += '<p class="bad" style="margin-top:8px">' + esc(r.error) + '</p>';
            if (r.warning) html += '<p style="margin-top:8px;color:var(--amber)">' + esc(r.warning) + '</p>';
            out.innerHTML = html;
            if (r.unreachable) return;
            var vp = document.createElement('p'); vp.className = 'muted'; vp.textContent = 'Verifying…';
            out.appendChild(vp);
            return api('/api/setup/verify', { method: 'POST' }).then(function (v) {
              vp.remove();
              out.insertAdjacentHTML('beforeend', renderVerify(v));
            });
          }).catch(function (e) { out.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
        };
        view.querySelector('#w-skip').onclick = function () { renderWizard(3); };
        view.querySelector('#w-next').onclick = function () { saveRouter().then(function () { renderWizard(3); }).catch(function (e) { toast(e.message, true); }); };
      });
    } else {
      view.innerHTML = '<div class="gate">' + steps + '<h1>All set 🎉</h1>' +
        '<p class="sub">Design your portal page, then download the hotspot files for your MikroTik.</p>' +
        '<div class="kvs">Next steps:<br>• <a href="/admin/editor.html">Open the portal editor</a><br>' +
        '• Download the hotspot files (from the editor)<br>• Upload them to your router’s hotspot directory</div>' +
        '<div style="margin-top:18px"><button class="btn primary" id="w-finish">Go to dashboard</button></div></div>';
      view.querySelector('#w-finish').onclick = function () {
        api('/api/setup/finish', { method: 'POST' }).then(function () { boot(); }).catch(function (e) { toast(e.message, true); });
      };
    }
  }

  function boot() {
    api('/api/auth/status').then(function (s) {
      document.getElementById('ver').textContent = ' v' + (s.version || '');
      if (!s.setup_complete) { renderWizard(1); return; }
      if (!s.authenticated) { renderLogin(); return; }
      gateOff();
      show((location.hash || '#active').slice(1));
    }).catch(function (e) { toast(e.message, true); });
  }
  boot();
})();
