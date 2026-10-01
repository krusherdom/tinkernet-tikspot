// Generator for the MikroTik hotspot "shim" files — the small set of files the
// admin uploads to the router's hotspot directory. They are NOT the login page;
// they are thin redirectors that hand the hotspot session off to the live portal
// hosted by this container.
//
// The flow: MikroTik serves login.html, whose
// JS reads $(server-name) (a "host|label" convention), takes the host part, and
// POSTs the session context (mac, ip, link-login, dst, error, chap-id,
// chap-challenge, ...) to http://<host>/login (explicit scheme: the shim may be
// served over HTTPS by the router while the container only speaks HTTP, and a
// scheme-relative URL would inherit https). <host> resolves to this container
// (router DNS static + walled-garden), which renders the real page.
//
// The files are mostly static — MikroTik substitutes the $(...) variables at
// serve time. We template only the portal path so it stays in one place.

const PORTAL = { login: '/login', status: '/status', logout: '/logout' };

// Common hidden fields carrying the hotspot session context to the container.
function contextFields() {
  return `    <input type="hidden" name="mac" value="$(mac)">
    <input type="hidden" name="ip" value="$(ip)">
    <input type="hidden" name="username" value="$(username)">
    <input type="hidden" name="link-login" value="$(link-login)">
    <input type="hidden" name="link-logout" value="$(link-logout)">
    <input type="hidden" name="link-status" value="$(link-status)">
    <input type="hidden" name="dst" value="$(link-orig)">
    <input type="hidden" name="error" value="$(error)">
    <input type="hidden" name="hostname" value="$(hostname)">
    <input type="hidden" name="identity" value="$(identity)">
    <input type="hidden" name="chap-id" value="$(chap-id)">
    <input type="hidden" name="chap-challenge" value="$(chap-challenge)">`;
}

// A redirect shim: POST the context to //<server-host><path> and auto-submit.
function redirectShim(title, path, loading) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family:sans-serif;text-align:center;padding:40px;color:#444">
  <form name="tikspot" id="tikspot-form" method="post" action="http://$(server-name)${path}">
${contextFields()}
  </form>
  <p id="msg">${loading}</p>
  <script>
    // $(server-name) may be "host|label" — use only the host part as the target.
    var sn = '$(server-name)';
    var host = sn.split('|')[0];
    var f = document.getElementById('tikspot-form');
    f.setAttribute('action', 'http://' + host + '${path}');
    f.submit();
  </script>
</body>
</html>
`;
}

// After a successful login MikroTik shows alogin.html; send the user on to their
// original destination.
function alogin() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Connected</title>
  <meta http-equiv="refresh" content="0; url=$(link-orig)">
</head>
<body style="font-family:sans-serif;text-align:center;padding:40px;color:#444">
  <p>You are connected. Redirecting…</p>
  <script>location.href = '$(link-orig)' || '/';</script>
</body>
</html>
`;
}

function apiJson() {
  // RFC 8908 captive-portal API. Points clients at the container-hosted page.
  return `{
  "captive": $(if logged-in == 'yes')false$(else)true$(endif),
  "user-portal-url": "http://$(server-name)${PORTAL.login}"
}
`;
}

function errorsTxt() {
  return `$(error)
`;
}

// Return [{ name, content }] for the whole shim set.
export function generateShims() {
  return [
    { name: 'login.html', content: redirectShim('Connecting…', PORTAL.login, 'Connecting you to the network…') },
    { name: 'status.html', content: redirectShim('Status', PORTAL.status, 'Loading…') },
    { name: 'logout.html', content: redirectShim('Logout', PORTAL.logout, 'Logging out…') },
    { name: 'alogin.html', content: alogin() },
    { name: 'rlogin.html', content: redirectShim('Connecting…', PORTAL.login, 'Connecting…') },
    { name: 'error.html', content: redirectShim('Error', PORTAL.login, 'Please wait…') },
    { name: 'errors.txt', content: errorsTxt() },
    { name: 'api.json', content: apiJson() },
  ];
}
