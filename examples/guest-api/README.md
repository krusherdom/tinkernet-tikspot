# Demo guest API

A tiny, zero-dependency stand-in for a hotel/venue "guest system" HTTP API,
used to develop and test Tikspot's pluggable guest-lookup login (recipes in
`app/src/plugins/`). It's a plain Node script — `node:http` only, no
`npm install`, no `package.json` of its own.

## What it is

`server.js` serves 8 made-up guests out of `guests.json`. Their check-in/
check-out dates are relative to *when the server starts* (see below), so the
demo always has a believable mix of guests: currently staying (including one
checking out today and one who checked in today), one who left a few days
ago, one arriving in a few days, and one arriving over a month out.

It exposes:

- `POST /auth/token` — JSON or form `username`/`password` -> `{token, expiresIn}`, or 401.
- `GET /guests` — filter by `room`, `lastName`, `firstName`, `mobile`, `email`, `bookingRef`
  (names/email/ref are case-insensitive "contains"; mobile matches on trailing digits).
  Add `?format=json|xml|text` (or an `Accept` header) to pick the response shape.
- `GET /reservations/:room` — a single guest by room, or 404.
- `GET /healthz` — liveness + guest count.

Every guest endpoint requires either `Authorization: Bearer <token>` (from
`/auth/token`) or `X-Api-Key: <apiKey>` — otherwise 401.

Default credentials (see `config.json`): username `frontdesk`, password
`letmein`, API key `demo-key-123`.

## Running it

From the repo root:

```sh
npm run guest-api
```

Or directly:

```sh
node examples/guest-api/server.js
```

Useful environment variables / flags:

- `PORT=8090` (default) or `--port 8090` — pass `PORT=0` to let the OS pick a
  free port; the server prints the port it actually bound, e.g.
  `listening on http://127.0.0.1:8090`.
- `FIXED_DATES=1` — anchor all the guests' relative check-in/check-out dates
  to a fixed instant instead of the real clock, so runs are reproducible
  (used by the automated integration test).

`guests.json` and `config.json` are re-read automatically whenever you save
them (via `fs.watchFile`) — no restart needed while you edit sample data.

### Finding the workstation's LAN IP

The MikroTik router (and the Tikspot container running on it) can't reach
`127.0.0.1` on your dev machine — they need your machine's LAN IP. Find it
with:

- Windows: `ipconfig` (look for the `IPv4 Address` under your active adapter, e.g. `192.168.1.42`)
- macOS: `ipconfig getifaddr en0` (or `en1` for Wi-Fi on some Macs)
- Linux: `hostname -I` or `ip -4 addr show`

Make sure your dev machine and the router are on the same network/VLAN, and
that nothing (Windows Firewall, etc.) is blocking inbound connections to the
port `server.js` is listening on.

## The three sample recipes

`recipes/` has one complete recipe per transport style this guest API can
answer with, all asking for the same two inputs (`room`, `name` — matched
against first *or* last name) and windowing on `checkIn`/`checkOut` with a
24h leeway:

- **`hotel-json.json`** — JSON responses, with `auth`: it logs into
  `/auth/token` with the username/password in `secrets`, then sends the
  returned token as `Authorization: Bearer <token>` on every guest lookup
  (cached until it expires).
- **`hotel-xml.json`** — XML responses (`?format=xml`), authenticated with a
  static `X-Api-Key` header from `secrets.apiKey` (no token exchange).
- **`hotel-regex.json`** — plain-text responses (`?format=text`), parsed with
  a single regex with named capture groups (one match per guest line), also
  using `X-Api-Key`.

Every recipe file has `BASE_URL` baked into its `request.url` (and, for the
JSON recipe, `auth.url`) as the placeholder:

```
http://192.168.1.10:8090
```

**Replace this with your dev machine's LAN IP and the port `server.js` is
listening on** before importing a recipe into the admin UI — otherwise the
router's container won't be able to reach your demo API.

### Importing a recipe

However the (forthcoming) admin UI ends up importing recipes, these files
are plain JSON matching the shape `validateRecipe()` in
`app/src/plugins/recipe.js` expects — paste/upload the file, fix the
`BASE_URL`, and fill in `secrets` if they aren't already set (the JSON
recipe needs `secrets.username`/`secrets.password`; the XML and regex
recipes need `secrets.apiKey`).

## Editing `guests.json`

Each guest has `firstName`, `lastName`, `room`, `mobile`, `email`,
`bookingRef`, `checkIn`, `checkOut`. `checkIn`/`checkOut` accept either:

- a relative token resolved once at server startup: `NOW-2d`, `NOW+3h`, `NOW+0.5d`, etc.
- a literal ISO 8601 timestamp, e.g. `"2026-01-01T12:00:00Z"`.

Add, remove, or edit guests and save the file — the running server picks up
the change within about a second, without a restart. (Reloading re-resolves
any `NOW±` tokens against the *original* startup instant, not the moment you
saved, so the demo's relative "currently staying" / "checked out" / "arriving
soon" story stays stable for the life of the server run.)
