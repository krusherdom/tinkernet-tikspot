# Apaleo

[Apaleo](https://apaleo.com/) is a cloud property-management system (PMS) built API-first
for hotels and hotel groups. Tikspot ships one guest-lookup recipe for its **Booking API**,
so guests can log into Wi-Fi with a room number plus any one of last name, first name,
email or mobile.

This page covers what you need before you start, how to install and configure the
recipe, and how to troubleshoot it. For the engine concepts it uses (OAuth2 token auth,
HTTP Basic auth, template helpers like `{{date:-1d:ymd}}`), see
[`docs/plugins/README.md`](README.md).

> **Status: verified mock.** This recipe is built from Apaleo's own published Swagger
> spec (`api.apaleo.com/swagger/booking-v1/swagger.json`) and developer guides, and is
> tested end to end against a bundled mock (`examples/apaleo-mock/`) that mirrors those
> docs. It has **not** been run against a real Apaleo account — do that with **Test
> lookup** before enabling it on a production portal, and please report back anything
> that doesn't match.

## What Apaleo gives you

Apaleo requires an **API client** — a client ID and client secret pair, created in the
Apaleo backoffice or via [apaleo.dev](https://apaleo.dev/) (a free developer account is
enough to try this recipe against your own demo property). The client needs the
`reservations.read` scope.

Every request first exchanges that client ID/secret for a short-lived **bearer token**
(`POST https://identity.apaleo.com/connect/token`), sent as **HTTP Basic auth** on the
token request itself — Tikspot's `auth.basic` field does this for you; you never see the
raw `Authorization: Basic …` header.

You'll also need your **property code** — a short code Apaleo assigns each property
(e.g. `BER`), visible in the backoffice under property settings.

## How the recipe works

One request: `GET /booking/v1/reservations`, filtered to your property, status
`InHouse` or `Confirmed`, and a stay window of yesterday through tomorrow
(`dateFilter=Stay&from={{date:-1d:ymd}}&to={{date:+1d:ymd}}`) — a generous window; the
engine's own `window` check (24-hour leeway) narrows it further per guest. Apaleo returns
the guest's unit (room) name and primary-guest contact details directly on each
reservation, so no second step is needed.

## Installing

1. **Admin → Guest lookup → Browse catalog**, import **Apaleo**. It arrives **disabled**,
   with no secrets.
2. Under **Secrets**:

   | Field | Value |
   |---|---|
   | Client ID | from Apaleo/apaleo.dev |
   | Client secret | from Apaleo/apaleo.dev |

3. Under **Parameters**:

   | Parameter | What to set |
   |---|---|
   | Apaleo API base URL | `https://api.apaleo.com` (default), or the bundled mock's address |
   | Apaleo identity URL | `https://identity.apaleo.com` (default), or the bundled mock's address |
   | Property code | your property's short code, e.g. `BER` |

4. **Test lookup** with a real (or demo) reservation's room and a guest detail.
5. Add a **Guest lookup** block to your portal page, then **enable** it.

### Trying it against the bundled mock first

`examples/apaleo-mock/` is a zero-dependency mock serving both the identity (token) and
booking endpoints on one port, with fictional sample data. Run `npm run apaleo-mock` from
the repo root (`node:http`, no TLS, port 8094), then:

1. Set both **Apaleo API base URL** and **Apaleo identity URL** to
   `http://<your LAN IP>:8094` — the router's container can't reach `127.0.0.1` on your
   workstation.
2. Fill in the mock's sample client ID/secret from `examples/apaleo-mock/config.json`.
3. Set **Property code** to `BER`.
4. Save and run **Test lookup** with room `101` and last name `Kowalski`.

## Inputs

| Input | Required | Notes |
|---|---|---|
| Room number | yes | matched with `normalize: "digits"` |
| Last name | no | |
| First name | no | |
| Email | no | |
| Mobile number | no | |

`minRules: 2` — room alone is never enough; at least one of the other four must also
match.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every lookup fails with the "upstream" message | Check **Test lookup**'s diagnostics for the actual HTTP status. A `401` on the token step means the client ID/secret is wrong, or the client lacks the `reservations.read` scope. |
| No-match on a reservation you can see in Apaleo | Check its status is `InHouse` or `Confirmed` — a `Canceled`, `NoShow` or already-`CheckedOut` reservation won't be found, by design. Also confirm the **Property code** parameter matches the reservation's property. |
| Correct guest, but "stay not active" | Apaleo returns full ISO-8601 timestamps with an explicit UTC offset, so there's no timezone ambiguity — a genuinely inactive stay outside the 24-hour leeway. Increase `window.leewayHours` in Raw JSON if needed. |
| Token errors even with correct-looking credentials | Confirm the **Apaleo identity URL** parameter points at `identity.apaleo.com`, not the booking API host — they're different hosts, unlike some PMSs that use one origin for everything. |

## Limits and caveats

- Endpoint/field facts come from Apaleo's own Swagger spec and apaleo.dev developer
  guides fetched 2026-09-09 — no endpoints beyond `POST /connect/token` and
  `GET /booking/v1/reservations` are used or assumed.
- Only `unit.name`, `primaryGuest.*`, `arrival`/`departure` and `status` are mapped; if
  your property needs a different field (e.g. `unitGroup.name` instead of `unit.name`),
  add it to `parse.fields` in Raw JSON.
- The bearer token is cached for up to 3000 seconds (Apaleo tokens are typically valid an
  hour; this recipe refreshes a little early) and automatically retried once on a
  `401`/`403`.
