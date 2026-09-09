# Eventbrite

[Eventbrite](https://www.eventbrite.com/) is an events and ticketing platform. Tikspot
ships one guest-lookup recipe for its v3 API, so attendees can log into event Wi-Fi with
the email and last name they used to register — no hotel, no room number, just a ticket.

This page covers what you need before you start, how to install and configure the
recipe, and how to troubleshoot it. For the engine concepts it uses (multi-step lookups,
pagination), see [`docs/plugins/README.md`](README.md).

> **Status: verified mock.** Eventbrite's `pagination.*` and `attendees[].profile.*`
> fields come from Eventbrite's own v3 API docs; everything else on an attendee record
> beyond that (`status`, `checked_in`, `order_id`, etc.) is Tikspot's best-effort
> reconstruction from public documentation — no live Eventbrite probe was done for this
> recipe. It is tested end to end against a bundled mock
> (`examples/eventbrite-mock/`) that reproduces the documented shape as closely as
> possible. **Verify every field against a real event with Test lookup** before relying
> on this for an actual event, and please report back anything that doesn't match.

## What Eventbrite gives you

Eventbrite authenticates with a **private token** — a long-lived personal API key, found
under your Eventbrite account's **Account Settings → Developer Links → API Keys**. Sent
as `Authorization: Bearer <token>` on every request; no login call, no expiry to manage.

You'll also need the **event ID** — the numeric ID in the event's URL or from the
Eventbrite API/dashboard.

## How the recipe works

Two steps:

1. **`event`** — `GET /events/{eventId}/`, fetching the event's own start/end time. If the
   event ID is wrong, the lookup fails fast (`requireRecords: true`) instead of going on
   to fetch attendees for an event that doesn't exist.
2. **`attendees`** — `GET /events/{eventId}/attendees/?status=attending`, paginated
   through **every page** (Eventbrite returns 50 attendees per page; this recipe follows
   the `pagination.continuation` cursor up to 8 pages — 400 attendees). The event's own
   start/end time (from step 1) is stamped onto every attendee record (`extra`) as their
   check-in/check-out window, since an individual attendee record has no stay dates of
   its own — the whole event is the "stay".

The stay window uses a **6-hour leeway** and a **24-hour maximum grant** (not the usual
24 h / 168 h) — appropriate for a single-day event rather than a multi-night stay.

## Installing

1. **Admin → Guest lookup → Browse catalog**, import **Eventbrite attendees**. It arrives
   **disabled**, with no secrets.
2. Under **Secrets**, fill in your **Private token**.
3. Under **Parameters**:

   | Parameter | What to set |
   |---|---|
   | Eventbrite API base URL | `https://www.eventbriteapi.com/v3` (default), or the bundled mock's address |
   | Event ID | the numeric ID of your event |

4. **Test lookup** with a real attendee's email and last name.
5. Add a **Guest lookup** block to your event's portal page, then **enable** it.

### Trying it against the bundled mock first

`examples/eventbrite-mock/` is a zero-dependency mock with 120 fictional attendees
(enough to exercise 3 pages of pagination). Run `npm run eventbrite-mock` from the repo
root (`node:http`, no TLS, port 8096), then:

1. Set **Eventbrite API base URL** to `http://<your LAN IP>:8096/v3` — the router's
   container can't reach `127.0.0.1` on your workstation.
2. Fill in the mock's sample private token from `examples/eventbrite-mock/config.json`.
3. Set **Event ID** to `900001`.
4. Save and run **Test lookup** with email `grace.kim@example.com` and last name `Kim`
   (an attendee deliberately placed on the third page, to prove pagination works).

## Inputs

| Input | Required | Notes |
|---|---|---|
| Email | yes | |
| Last name | yes | |

Both are required **and** both must match (`match.all: true`, `minRules: 2`) — safer for
a public event than accepting either one alone.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every lookup fails with the "upstream" message | Check **Test lookup**'s diagnostics. A `401` means the private token is wrong or revoked. A `404` on the `event` step means the **Event ID** parameter is wrong, or the token doesn't have access to that event (private/org-restricted events). |
| No-match on an attendee you can see registered | Check their ticket status is `attending` (not cancelled/refunded) — the request only asks for `status=attending`. Also double-check the exact email on the order — a group booking's attendee emails are sometimes the purchaser's, not each individual's. |
| "This event is not currently running" | The 6-hour leeway is tight by design — a single-day event's window is `event start − 6h` through `event end + 6h`, capped at a 24-hour grant. If your event runs longer, or you want a wider pre/post-event window, adjust `window.leewayHours` / `window.maxGrantHours` in Raw JSON. |
| Only some pages of attendees seem to be searched | `paginate.maxPages` caps at 8 pages (400 attendees) — a larger event needs that raised in Raw JSON, up to the engine's overall 25-requests-per-lookup cap. |

## Limits and caveats

- `pagination.*` and `profile.*` fields are Eventbrite's documented shape; every other
  attendee field here (`status`, `checked_in`, `cancelled`, `refunded`, `order_id`,
  `ticket_class_name`) is a best-effort reconstruction — re-verify against a real event's
  raw response in **Test lookup** before depending on any field this doc doesn't
  explicitly attribute to Eventbrite's own docs.
- `maxRecords: 400` and `paginate.maxPages: 8` together bound this recipe to at most 400
  attendees considered per lookup — fine for most events, but a very large one may need
  both raised (and `maxFanOut`/the 25-request cap kept in mind).
- The credential granted expires at most 24 hours from now, regardless of how long the
  event itself runs — appropriate for day-of-event Wi-Fi, not a multi-day festival pass
  (raise `window.maxGrantHours` in Raw JSON for a longer event).
