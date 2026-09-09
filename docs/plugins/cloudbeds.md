# Cloudbeds

[Cloudbeds](https://www.cloudbeds.com/) is a cloud property-management system (PMS) for
hotels, hostels and vacation rentals. Tikspot ships one guest-lookup recipe for its REST
API, so guests can log into Wi-Fi with a room number plus any one of last name, first
name, email or mobile — matched against **anyone staying in that room**, not just the
primary guest who made the booking.

This page covers what you need before you start, how to install and configure the
recipe, and how to troubleshoot it. For the engine concepts it uses (wildcard parse
paths, `anyOf` match rules), see [`docs/plugins/README.md`](README.md).

> **Status: verified mock.** This recipe is built from the developers.cloudbeds.com API
> reference and tested end to end against a bundled mock (`examples/cloudbeds-mock/`)
> that mirrors those docs. It has **not** been run against a real Cloudbeds account —
> Cloudbeds API access requires a partner/developer sandbox application — do that with
> **Test lookup** before enabling it on a production portal, and please report back
> anything that doesn't match.

## What Cloudbeds gives you

Cloudbeds authenticates with a **static API key** — no login call, no expiring token.
Every request carries it as an `x-api-key` header. Get one from your Cloudbeds
[partner/developer sandbox](https://developers.cloudbeds.com/) account, or from a live
property's Cloudbeds account if API access is enabled for it.

You'll also need your **property ID**, found in Cloudbeds under property settings or in
the sandbox dashboard.

## How the recipe works

One request: `GET /getReservations`, filtered to `status=checked_in` and the room the
guest typed (`roomName`), with `includeGuestsDetails=true` so every guest sharing that
reservation is returned, not just the primary one. The parser then fans out over **each
reservation's `guestList`** — a JSON object keyed by guest ID, not an array — using a
`data[*].guestList[*]` wildcard path, so a companion or family member staying in the same
room can also log in with their own name/email/mobile.

`status=checked_in` only: a `confirmed`-but-not-yet-arrived booking has no one in the room
yet, so it's deliberately excluded — a guest can't Wi-Fi log-in before they've checked in.

## Installing

1. **Admin → Guest lookup → Browse catalog**, import **Cloudbeds**. It arrives
   **disabled**, with no secrets.
2. Under **Secrets**, fill in your **API key**.
3. Under **Parameters**:

   | Parameter | What to set |
   |---|---|
   | Cloudbeds API base URL | `https://api.cloudbeds.com/api/v1.3` (default), or the bundled mock's address (include the `/api/v1.3` path) |
   | Property ID | your Cloudbeds property ID |

4. **Test lookup** with a checked-in reservation's room and a guest detail.
5. Add a **Guest lookup** block to your portal page, then **enable** it.

### Trying it against the bundled mock first

`examples/cloudbeds-mock/` is a zero-dependency mock with fictional sample data,
including one reservation with **two** guests sharing a room (to exercise the
`guestList` fan-out). Run `npm run cloudbeds-mock` from the repo root (`node:http`, no
TLS, port 8095), then:

1. Set **Cloudbeds API base URL** to `http://<your LAN IP>:8095/api/v1.3` — the router's
   container can't reach `127.0.0.1` on your workstation.
2. Fill in the mock's sample API key from `examples/cloudbeds-mock/config.json`.
3. Save and run **Test lookup** with room `101` and last name `Shah` (the primary guest),
   or room `205` and mobile `+353 1 000 0003` (the secondary guest sharing that room).

## Inputs

| Input | Required | Notes |
|---|---|---|
| Room number | yes | matched with `normalize: "digits"` |
| Last name | no | |
| First name | no | |
| Email | no | |
| Mobile number | no | matches either `mobile` (cell) or `phone` (landline) on file, via `anyOf` |

`minRules: 2` — room alone is never enough; at least one of the other four must also
match.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every lookup fails with the "upstream" message | Check **Test lookup**'s diagnostics for the actual HTTP status. A `401` means the API key is wrong, revoked, or lacks the reservations scope. |
| No-match on a guest you can see checked in | Confirm the **Property ID** parameter is correct, and that the reservation's status is exactly `checked_in` in Cloudbeds — a `confirmed` (not-yet-arrived) or `checked_out` booking won't be found, by design. |
| A companion guest can't log in even though they're on the reservation | Check they actually have a value on file for whichever detail they typed (email/mobile) — Cloudbeds' `guestList` entries are frequently sparser for non-primary guests. Ask which detail Cloudbeds has on file for them. |
| Correct guest, but "stay not active" | Cloudbeds returns date-only (`YYYY-MM-DD`) check-in/out dates with no time component (`dateFormat: "ymd"`) — the 24-hour leeway absorbs most of the resulting slack, but increase `window.leewayHours` in Raw JSON if guests are regularly checking in/out right at the day boundary. |

## Limits and caveats

- Endpoint/field facts come from the developers.cloudbeds.com API reference fetched
  2026-09-09 — no endpoint beyond `GET /getReservations` is used or assumed.
- Cloudbeds' `roomName` filter is applied **server-side** (fewer results to fan out over)
  **and** the room is matched again client-side — if your property's room-naming scheme
  makes the server-side filter too loose or too strict, this is still safe: the
  client-side match rule is the one that actually decides.
- Cloudbeds rate-limits its API per the plan tier on your account — keep `timeoutMs`
  reasonable for a busy portal.
