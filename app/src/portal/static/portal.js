/* Tikspot captive-portal runtime (served at /m/portal.js).
 *
 * The page is hosted by the container, but login must be completed against the
 * MikroTik router. Each login widget is a <form data-tikspot-login> whose action
 * is the router's link-login URL (injected server-side from the redirect the
 * MikroTik shim sent us). By default we submit PAP (plaintext password over the
 * local hotspot network) — a native form POST, no JS required for correctness.
 *
 * When window.TIKSPOT.chap is enabled and the router supplied a CHAP id +
 * challenge, we hash the password client-side with md5.js before submitting
 * (HTTP-CHAP), matching MikroTik's login flow.
 *   NOTE: the CHAP path needs verification against real hardware; PAP is the
 *   tested default. login-by on the hotspot profile must include the method used.
 *
 * The page's CSP forbids inline scripts, so the runtime payload is not an
 * inline `window.TIKSPOT=...` assignment — it's a JSON blob on
 * `<body data-tikspot="...">`. This external script reads it and re-populates
 * window.TIKSPOT for compatibility with anything else that expects it.
 */
(function () {
  var T = {};
  try {
    T = JSON.parse(document.body.getAttribute('data-tikspot') || '{}') || {};
  } catch (e) {
    T = {};
  }
  window.TIKSPOT = T;

  function hexToStr(hex) {
    if (!hex) return '';
    var out = '';
    for (var i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return out;
  }

  function chapPassword(plain) {
    // MikroTik HTTP-CHAP: MD5(chap-id . password . chap-challenge), with id and
    // challenge as raw bytes. The router passes the challenge as hex here.
    var id = hexToStr(T.chapId);
    var chal = hexToStr(T.chapChallenge);
    return window.hexMD5(id + plain + chal);
  }

  // Direct-load guard: no link-login means the form can't reach the router. Stop
  // the submit and draw attention to the notice instead of silently doing nothing.
  function flashNotice() {
    var n = document.getElementById('tk-notice');
    if (!n) return;
    n.scrollIntoView({ behavior: 'smooth', block: 'center' });
    n.classList.remove('flash');
    void n.offsetWidth; // restart the animation
    n.classList.add('flash');
  }

  function wireDirect(form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      flashNotice();
    });
    var btn = form.querySelector('[type=submit], button');
    if (btn) btn.classList.add('cp-btn-disabled');
  }

  function wire(form) {
    form.addEventListener('submit', function (ev) {
      var btn = form.querySelector('[type=submit], button');
      // CHAP: replace the password value with the hashed form before posting.
      if (T.chap && T.chapId && T.chapChallenge && typeof window.hexMD5 === 'function') {
        var pw = form.querySelector('input[name=password]');
        if (pw && !form.dataset.tikspotHashed) {
          pw.value = chapPassword(pw.value);
          form.dataset.tikspotHashed = '1';
        }
      }
      if (btn) {
        btn.disabled = true;
        if (btn.dataset.busyText) btn.textContent = btn.dataset.busyText;
      }
      // Let the native POST to the router proceed.
    });
  }

  // Mirror an input's value into another named field as the user types (used by
  // the voucher widget, where the code is both the username and the password).
  // Replaces an inline oninput handler so the rendered HTML carries no JS.
  function wireMirror(form) {
    var inputs = form.querySelectorAll('[data-tk-mirror]');
    for (var i = 0; i < inputs.length; i++) {
      (function (input) {
        var targetName = input.getAttribute('data-tk-mirror');
        input.addEventListener('input', function () {
          var target = form.querySelector('[name="' + targetName + '"]');
          if (target) target.value = input.value;
        });
      })(inputs[i]);
    }
  }

  // Terms gating: a terms-checkbox block renders <input data-tk-terms required>.
  // Until every required terms box on the page is ticked, every login form's
  // submit button stays disabled (independent of the direct/CHAP wiring above).
  function wireTerms() {
    var boxes = document.querySelectorAll('[data-tk-terms][required]');
    if (!boxes.length) return;
    var buttons = document.querySelectorAll('form[data-tikspot-login] [type=submit], form[data-tikspot-login] button');

    function allChecked() {
      for (var i = 0; i < boxes.length; i++) {
        if (!boxes[i].checked) return false;
      }
      return true;
    }

    function update() {
      var ok = allChecked();
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = !ok;
        buttons[i].classList.toggle('cp-btn-disabled', !ok);
      }
    }

    for (var i = 0; i < boxes.length; i++) {
      boxes[i].addEventListener('change', update);
    }
    update();
  }

  // A form marked data-tk-autosubmit submits itself on load (used by 0.13's
  // guest-lookup auto-login flow). Shows a "Connecting…" note in place of the
  // submit button so the page doesn't look stuck.
  function wireAutosubmit() {
    var forms = document.querySelectorAll('form[data-tk-autosubmit]');
    for (var i = 0; i < forms.length; i++) {
      (function (form) {
        var btn = form.querySelector('[type=submit], button');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Connecting…';
        }
        if (T.direct || !T.linkLogin) return; // nothing to submit to
        setTimeout(function () {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
        }, 50);
      })(forms[i]);
    }
  }

  function init() {
    var forms = document.querySelectorAll('form[data-tikspot-login]');
    for (var i = 0; i < forms.length; i++) {
      wireMirror(forms[i]);
      if (T.direct || !T.linkLogin) wireDirect(forms[i]);
      else wire(forms[i]);
    }
    // Guest-lookup forms (0.13) post to our own container, not the router, but
    // still need a router session to eventually complete — same direct-load
    // guard as the login forms above.
    if (T.direct || !T.linkLogin) {
      var lookupForms = document.querySelectorAll('form[data-tikspot-lookup]');
      for (var j = 0; j < lookupForms.length; j++) wireDirect(lookupForms[j]);
    }
    wireTerms();
    wireAutosubmit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
