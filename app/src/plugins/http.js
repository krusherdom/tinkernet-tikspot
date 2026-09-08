// Minimal HTTP(S) client for the guest-lookup engine. Deliberately built on
// node:http/https rather than fetch/undici so we can disable TLS
// verification per-recipe (self-signed guest-system certs are common) the
// same way src/mikrotik/rest.js does for router connections.
//
// httpRequest(...) -> { status, headers, text, ms }
// Throws Error with .code = 'TIMEOUT' | 'NETWORK' | 'TOO_LARGE'.

import http from 'node:http';
import https from 'node:https';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB response cap
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

function toBuffer(body) {
  if (body == null) return null;
  return Buffer.isBuffer(body) ? body : Buffer.from(String(body));
}

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function httpRequest(opts) {
  return doRequest(opts, 0, Date.now());
}

function doRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 8000, insecureTls = false }, redirectCount, startedAt) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(makeError(`invalid URL: ${url}`, 'NETWORK'));
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(makeError(`unsupported URL scheme: ${target.protocol}`, 'NETWORK'));
      return;
    }

    const mod = target.protocol === 'https:' ? https : http;
    const data = toBuffer(body);
    const reqHeaders = { ...headers };
    if (data && reqHeaders['Content-Length'] == null && reqHeaders['content-length'] == null) {
      reqHeaders['Content-Length'] = data.length;
    }

    const reqOpts = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: reqHeaders,
      timeout: timeoutMs, // socket-level idle timeout (backup to the deadline below)
    };
    if (target.protocol === 'https:' && insecureTls) reqOpts.rejectUnauthorized = false;

    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };

    const deadline = setTimeout(() => {
      finish(() => {
        req.destroy();
        reject(makeError(`request timed out after ${timeoutMs}ms`, 'TIMEOUT'));
      });
    }, timeoutMs);

    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      let total = 0;
      let tooLarge = false;

      res.on('data', (chunk) => {
        if (tooLarge) return;
        total += chunk.length;
        if (total > MAX_BYTES) {
          tooLarge = true;
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (tooLarge) {
          finish(() => reject(makeError(`response exceeded ${MAX_BYTES} bytes`, 'TOO_LARGE')));
          return;
        }

        const status = res.statusCode;
        const location = res.headers.location;
        if (REDIRECT_STATUSES.has(status) && location && redirectCount < MAX_REDIRECTS) {
          let nextUrl = null;
          try {
            nextUrl = new URL(location, target);
          } catch {
            nextUrl = null;
          }
          // Follow only same-scheme redirects, or upgrades to https — never
          // silently downgrade an https request to http.
          if (nextUrl && (nextUrl.protocol === target.protocol || nextUrl.protocol === 'https:')) {
            finish(() => {
              const nextMethod = status === 307 || status === 308 ? method : 'GET';
              const nextBody = status === 307 || status === 308 ? body : undefined;
              resolve(
                doRequest(
                  { url: nextUrl.href, method: nextMethod, headers, body: nextBody, timeoutMs, insecureTls },
                  redirectCount + 1,
                  startedAt,
                ),
              );
            });
            return;
          }
        }

        const text = Buffer.concat(chunks).toString('utf8');
        finish(() => resolve({ status, headers: res.headers, text, ms: Date.now() - startedAt }));
      });

      res.on('error', (e) => {
        finish(() => reject(makeError(e.message, 'NETWORK')));
      });
    });

    req.on('error', (e) => {
      finish(() => reject(makeError(e.message, 'NETWORK')));
    });
    req.on('timeout', () => {
      finish(() => {
        req.destroy();
        reject(makeError('socket timed out', 'TIMEOUT'));
      });
    });

    if (data) req.write(data);
    req.end();
  });
}
