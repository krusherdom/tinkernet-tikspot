# Mews

[Mews](https://www.mews.com/) is a cloud property-management system (PMS) for hotels,
hostels and short-stay accommodation. Tikspot ships one guest-lookup recipe for its
**Connector API**, so guests can log into Wi-Fi with a room number plus any one of last
name, first name, email or mobile — whatever your front desk already has on file.

This page covers what you need before you start, how to install and configure the
recipe, and how to troubleshoot it. For the engine concepts it uses (`bodyJson`, `steps`,
`minRules`, template helpers like `{{date:-1d}}`), see
[`docs/plugins/README.md`](README.md).

> **Status: verified live.** This recipe has been run against Mews's own public demo
> (`api.mews-demo.com`) using the demo credentials Mews publishes on its own docs site —
> see the live-probe test in `app/test/plugins-mews.test.js` (set `MEWS_LIVE=1` to run
> it yourself). It has not been run against a paying Mews property; every property is
> configured a little differently, so re-verify with **Test lookup** before relying on it
> for a real event or stay.

## What Mews gives you

Mews's Connector API has **no separate login call**. Every request body carries two
credentials directly:

- A **Client token** — identifies the integration (Tikspot) to Mews. Mews issues one per
  integration; for trying this recipe before you have your own, Mews publishes a demo
  Client token on its own docs site (see below).
- An **Access token** — identifies which property/enterprise the request acts against.
  Your Mews administrator generates one under **Mews Operations → Settings → API access**
  (wording varies by Mews edition).

Both are sent as plain fields in every JSON request body — there's no `Authorization`
header and no token to cache or refresh.

## How the recipe works

Three steps, in order:

1. **`room`** — `POST resources/getAll` filtered by the room name the guest typed. Mews
   can return **more than one resource sharing the same display name** (e.g. two
   housekeeping records both called "101") — this step keeps all of them, not just the
   first, using a `[*]` wildcard template (`{{raw:steps.room.records[*].resourceId}}` in
   the next step). If no resource matches at all, the lookup stops here as `no-match`
   (`requireRecords: true`) rather than making two more pointless API calls.
2. **`reservations`** — `POST reservations/getAll/2023-06-06`, searching every resource
   found in step 1, restricted to reservations currently `Started` or `Confirmed` and
   overlapping a ±1-day window around now (`{{date:-1d}}` / `{{date:+1d}}`). The room name
   found in step 1 is stamped onto every reservation record (`extra`), since the
   reservation itself doesn't carry it.
3. **`guest`** — for each reservation found, `POST customers/getAll`, filling in the
   guest's name, email and mobile.

## Installing

1. **Admin → Guest lookup → Browse catalog**, import **Mews Connector API**. It arrives
   **disabled**, with no secrets.
2. Under **Secrets**:

   | Field | Value |
   |---|---|
   | Client token (from Mews) | your integration's Client token |
   | Access token (from the property) | your property's Access token |

3. Under **Parameters**:

   | Parameter | What to set |
   |---|---|
   | Mews Connector API base URL | `https://api.mews.com` for production, `https://api.mews-demo.com` for Mews's public demo, or the bundled mock's address |
   | Client application name | any short name identifying this integration to Mews (default "Tikspot hotspot") |

4. **Test lookup** with a real (or demo) reservation's room and a guest detail. Confirm
   the parsed record and window outcome look right.
5. Add a **Guest lookup** block to your portal page, then **enable** it.

### Trying it against the public Mews demo

Mews publishes working demo credentials on its own "Environments" documentation page —
search "Mews Connector API environments" or check `docs.mews.com`. Set the base URL
parameter to `https://api.mews-demo.com` and paste in the demo Client token / Access
token. The demo is shared by everyone trying the API, so it's **rate limited** — an
occasional "Mews is not responding" message under load is expected, not a bug.

### Trying it against the bundled mock first

`examples/mews-mock/` is a zero-dependency mock of the same three endpoints, with
fictional sample data (including two resources sharing the display name "101", to
exercise the same-name behaviour described above). Run `npm run mews-mock` from the repo
root (`node:http`, no TLS, port 8093), then:

1. Set **Mews Connector API base URL** to `http://<your LAN IP>:8093` — the router's
   container can't reach `127.0.0.1` on your workstation.
2. Fill in the mock's sample tokens from `examples/mews-mock/config.json`.
3. Save and run **Test lookup** with room `101` and last name `Voss`.

## Inputs

| Input | Required | Notes |
|---|---|---|
| Room number | yes | matched with `normalize: "digits"` |
| Last name | no | |
| First name | no | |
| Email | no | |
| Mobile number | no | |

`minRules: 2` — room alone is never enough; at least one of the other four must also
match a reservation's guest record.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every lookup fails with the "upstream" message | A bad Client/Access token pair — Mews returns `401 { "Message": "Invalid access token." }` for either. Double-check both were pasted in full (they're long, hyphenated strings). |
| No-match on a room you can see in Mews | Check the resource's display **Name** exactly matches what the guest typed (case-insensitive, but not a substring match — unlike RMS Cloud's `areaNameLike`, Mews's `Names` filter is exact). Also check the reservation's `State` is `Started` or `Confirmed` — a `Requested` or `Canceled` booking won't be found, by design. |
| Guest found but "stay not active" | Mews returns full ISO-8601 UTC timestamps, so there's no timezone ambiguity here (unlike RMS Cloud's date-only wall-clock format) — a genuinely inactive stay outside the 24-hour leeway. Increase `window.leewayHours` in Raw JSON if your property needs more slack around midnight check-in/out. |
| Occasional "upstream" against the public demo only | The demo is shared and rate-limited (`429 Too many requests`) — this is expected under load, not a bug. Retry, or use the bundled mock for repeated testing. |

## Limits and caveats

- Field/endpoint facts come from a probe of `docs.mews.com/connector-api` and the public
  demo done 2026-09-09 — see the ADDENDUM notes referenced in this repo's build history.
  Mews occasionally adds fields; unmapped ones are simply ignored.
- Every property this agent/access-token pair can see is searched (there is no
  property-scoping parameter for this recipe, unlike RMS Cloud's optional Property ID) —
  if your Mews access spans multiple properties, room names should be unique across them.
- Mews's public demo is rate-limited; production accounts have their own published rate
  limits — keep `timeoutMs` reasonable for a busy portal.
