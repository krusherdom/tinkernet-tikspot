# RMS Cloud mock API

A tiny, zero-dependency stand-in for the parts of the
[RMS Hospitality REST API](https://app.swaggerhub.com/apis-docs/RMSHospitality/RMS_REST_API/1.4.45.1)
that Tikspot's two RMS Cloud recipes (`plugins/rms-cloud-surname-room.json` and
`plugins/rms-cloud-any-detail.json`) call. It exists so you can build, test and try those
recipes — and the plugin engine's newer features (structured JSON bodies, multi-step
lookups, `minRules`) — **before** you have real RMS agent credentials.

It is a plain Node script — `node:http` only, no `npm install`, no `package.json` of its
own — and it is **not** affiliated with RMS Hospitality. It only implements the endpoints
and fields documented in [`docs/plugins/rms-cloud.md`](../../docs/plugins/rms-cloud.md);
treat any behaviour beyond that as unverified against the real API.

## What it is

`server.js` serves 7 made-up reservations and 7 made-up guests out of `data.json`. Their
arrival/departure dates are relative to *when the server starts*, so a run always has a
believable mix: one guest currently checked in (room `101`, Olivia Bennett), one arriving
later today (`Room 102`, Marcus Delgado), one whose stay has already ended even though the
record still says `arrived` — real front desks don't always update status promptly (`Villa
7`, Priya Nair), one arriving in 10 days (`203`, Tomasz Wysocki), one cancelled booking
(`101`, Freya Holm), one genuinely marked `departed` (`203`, Isabelle Novak), and a second
currently-checked-in guest sharing a room name with Priya's ended stay (`Villa 7`, Grace
Sato — useful for exercising the "room + any detail" recipe's disambiguation). All names,
emails and phone numbers are fictional.

It exposes:

- `POST /authToken` — `{agentId, agentPassword, clientId, clientPassword, moduleType,
  useTrainingDatabase}` checked against `config.json` → `201 {token, expiryDate,
  rmsClientId, allowedProperties}`, or `401`. `expiryDate` is always one hour out, in
  RMS's `"YYYY-MM-DD HH:MM:SS"` format (UTC).
- Every other route requires header `authtoken: <token>` — `401` if it is missing,
  unknown, or expired.
- `POST /reservations/search?modelType=basic|full&limit=N` — body filters:
  `guestSurname[]`, `areaNames[]`, `areaNameLike`, `listOfStatus[]`, `propertyIds[]`,
  `guestIds[]`, `arriveFrom/arriveTo/departFrom/departTo`. `modelType=basic` (the
  recipes' default) returns `{id, areaId, areaName, categoryName, arrivalDate,
  departureDate, guestGiven, guestSurname, guestId, status, propertyId}`; `full` adds a
  few extra fields (`adults`, `children`).
- `POST /guests/search` — `{surname, given, email, mobile, includeReservationIds}`,
  substring/case-insensitive on the text fields.
- `GET /guests/{id}` — one guest, or `404`.
- `GET /guests/{id}/contacts` — that guest's *additional* contacts (most guests have
  none; one, id `9006`, has one).
- `GET /areas?propertyId=` — the four sample areas, optionally filtered by property.

Default credentials (see `config.json`): agent ID `1000`, agent password
`agent-secret`, client ID `11281`, client (Web Service) password `webservice-secret`.

## Running it

From the repo root:

```sh
npm run rms-mock
```

Or directly:

```sh
node examples/rms-mock/server.js
```

Flags / environment variables:

- `PORT=8091` (default) or `--port 8091` — pass `PORT=0` (or `--port 0`) to let the OS
  pick a free port; the server prints the port it actually bound, e.g.
  `listening on http://127.0.0.1:8091` (used by the automated integration test to find an
  ephemeral port).

`data.json` and `config.json` are read once at startup (not watched) — restart the
server after editing them.

## Trying the two recipes against it

1. Start the mock: `npm run rms-mock`.
2. In Tikspot's admin, **Guest lookup → Browse catalog**, import **RMS Cloud — surname +
   room** (or **room + any guest detail**).
3. Set the recipe's **RMS API base URL** parameter to `http://192.168.1.42:8091` (your
   workstation's LAN IP and the mock's port — the router's container cannot reach
   `127.0.0.1` on your dev machine).
4. Fill in the secrets from `config.json` above.
5. Run **Test lookup**:
   - room `101`, surname `Bennett` → match (currently checked in).
   - room `Villa 7`, surname `Nair` → outside-window (stay already ended).
   - room `203`, surname `Wysocki` → outside-window (arrives in 10 days).
   - room `Villa 7`, email `grace.sato@example.com` (any-detail recipe, leave surname
     blank) → match, even though another guest (`Nair`) also stayed in "Villa 7".
   - room `101` only, nothing else (any-detail recipe) → no-match — that recipe requires
     the room *and* at least one other matching detail (`minRules: 2`).

## Editing the sample data

`data.json` has three arrays: `areas`, `guests`, `reservations`. A reservation's
`arrivalDate`/`departureDate` accept either a literal `"YYYY-MM-DD HH:MM:SS"` string or a
relative token resolved once at startup: `NOW-1d`, `NOW+2h`, `NOW+0.5d`, etc. `guestId` on
a reservation must match a `guests[].id`. Give a guest a `contacts` array to exercise
`GET /guests/{id}/contacts`.
