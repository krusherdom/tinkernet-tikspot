# Security Policy

## Supported versions

Tikspot is released as a rolling line — only the **latest** published version
(`ghcr.io/krusherdom/tinkernet-tikspot:latest` and the matching git tag) receives
security fixes. Please reproduce any issue against the latest release before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's built-in advisory flow:

1. Go to the repository's **[Security](https://github.com/krusherdom/tinkernet-tikspot/security)** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version, and steps to reproduce.

This opens a private channel visible only to the maintainer — no exploit details are
made public until a fix is available.

We aim to acknowledge a report within **7 days** and to agree on a disclosure timeline
with you once the issue is confirmed.

## Scope notes

Tikspot is a **LAN-management appliance**: it runs inside a container on a MikroTik router
and its admin portal is intended to be reached over the LAN, **not exposed to the public
internet**. Within that scope it already applies several hardening measures (scrypt-hashed
admin password, signed/httpOnly/SameSite session cookies, login rate-limiting, Origin/CSRF
checks on state-changing requests, secret-redacting backups, and a RADIUS NAS secret that
fails closed). Reports that depend on deliberately exposing the admin port to the internet,
or on already having router/root access, are generally out of scope — but if in doubt,
report it and we'll discuss.
