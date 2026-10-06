# RMS Cloud

[RMS Hospitality](https://www.rmscloud.com/) ("RMS Cloud") is a property management
system (PMS) for hotels, resorts, parks and short-stay accommodation. Tikspot ships two
ready-made guest-lookup recipes for its REST API, so guests can log into Wi-Fi with the
same room number and surname (or any other detail) your front desk already has on file.

This page covers what you need before you start, how to install and configure the
recipes, and how to troubleshoot them. For the engine concepts they use (`bodyJson`,
`steps`, `minRules`, …), see [`docs/plugins/README.md`](README.md).

> **Status:** validated against the **RMS partner sandbox** on 2026-09-16 — base-URL
> discovery, login with module type `GuestServices`, reservation search, parsing of real
> reservation and guest records, and token + discovery caching across lookups — and
> against the bundled mock (`examples/rms-mock/`), which now mirrors the sandbox's actual
> behaviour. A full "guest found" run needs a booking that is in-house *today*: create a
> fictional test booking in the sandbox UI and use **Test lookup** before enabling either
> recipe on a production portal. Endpoints follow the [RMS REST API spec, version
> 1.4.45.1](https://app.swaggerhub.com/apis-docs/RMSHospitality/RMS_REST_API/1.4.45.1).

## What RMS gives you

RMS Cloud's API authenticates in two layers:

- An **agent** — a set of credentials RMS issues to a piece of software (in this case,
  your Tikspot install) that identifies *what* is calling and *what module* it was
  approved for. You get an **agent ID** and **agent password** from RMS when you (or your
  RMS partner) register for API access.
- A **client** — the specific property/company database the agent is allowed to act
  against. Your property's RMS administrator finds (or generates) the **client ID** and a
  **"Web Service password"** in RMS itself (Setup → API / Web Service credentials,
  depending on RMS version).

Both pairs are required on every login (`POST /authToken`); RMS returns a token that is
valid for **24 hours** and used on every subsequent call. The recipes cache it for its
full lifetime (`tokenTtlSecs: 86400`, bounded by the `expiryDate` RMS returns) — RMS's
certification checklist explicitly requires that a token is *not* requested per call.

Before logging in, the recipes call `GET /clientUrl/{clientId}` (unauthenticated) on the
regional **seed URL** you configure; RMS answers with the property's real API origin,
which is then used for the login and every lookup call (`auth.discover` in engine terms —
see `docs/plugins/README.md`). RMS certification requires this instead of a hard-coded
host, so the seed URL only ever has to be *some* RMS regional host.

You'll also want to know:

- **Region (seed URL)** — any RMS regional API host: Asia-Pacific/Australia
  (`restapi12`), North America (`restapi13`), Europe (`restapi14`), or China (`restapi9`).
  It is only used for the `clientUrl` discovery call above, so the default is fine unless
  RMS tells you otherwise. Each region also has a `beta` variant for RMS's staging
  environment — only use it if RMS told you to.
- **Module type** — the module RMS activated for your partner agent; RMS states it with
  your agent credentials. For Tikspot's own partner agent it is **`GuestServices`** (the
  recipes' default). Wrong value → `401` on login.
- **Property ID** (optional) — RMS's *internal* property id, the `id` field from
  `GET /properties` (small integers like `1`, `3`, `4`) — **not** the per-property
  client number (`54321`…). Passing a client number silently matches nothing.
- **Training database** — RMS accounts can have a separate training/sandbox database.
  Leave "Use RMS training database" off unless you're deliberately testing against it —
  turning it on against a live property means guests won't be found (the training
  database is empty of real reservations).

None of this is optional: without valid agent + client credentials for the right region,
every lookup fails at the login step (`401` → shown to guests as the recipe's *"upstream"*
message).

## The two recipes

Both live in [`plugins/`](../../plugins/) and are listed in the catalog
(`plugins/index.json`) as **RMS Cloud — surname + room** and **RMS Cloud — room + any
guest detail**. Both authenticate the same way and share the same parameters; they differ
only in what they ask the guest for and how many API calls they make.

### RMS Cloud — surname + room (`rms-cloud-surname-room.json`)

Asks for **room / site number** and **last name**, both required. One request:
`POST /reservations/search?modelType=full` filtered by `areaNameLike`, restricted to
`arrived`/`confirmed` reservations departing from yesterday and arriving by tomorrow
(`departFrom`/`arriveTo` — without them a busy property's 50-row page fills with
years-old "Arrived" rows and far-future bookings, as the sandbox showed). `modelType=full`
is required: RMS's `basic` model has **no** `areaName`, `guestGiven` or `guestSurname`.
The surname is deliberately **not** sent to RMS: RMS's
own surname filter is undocumented for case, hyphens and apostrophes, so Tikspot fetches
every current reservation in that room and compares the surname itself
(case/diacritic-insensitive, and `Smith-Jones`, `smith jones` and `smithjones` all match).
`minRules: 2` means room **and** surname must actually match, not just be present.

### RMS Cloud — room + any guest detail (`rms-cloud-any-detail.json`)

Asks for **room / site number** (required) plus **last name**, **first name**, **email**,
**mobile** — all optional, but `minRules: 2` requires room plus at least one of them to
actually match. Two-step lookup:

1. `reservations` — the same `POST /reservations/search`, filtered by room only (no
   surname, since the guest might not have typed one).
2. `guest` — for each reservation found, `GET /guests/{guestId}`, filling in `email` and
   `mobile` on that reservation record (without overwriting the name/room already found).
   This step is `optional`: real RMS databases contain group-master rows with
   `guestId: 0` and no name in an occupied room, and `GET /guests/0` is a `404` — the
   row is skipped rather than failing the whole lookup.

Use this one when guests might not remember which name a booking is under, or you'd
rather ask for a mobile number or email instead.

## Installing

1. Start Tikspot's admin, **Guest lookup → Browse catalog**, and import one (or both) of
   the two RMS recipes. They arrive **disabled**, with no secrets.
2. Open the recipe. Under **Secrets**, fill in:

   | Field | Value |
   |---|---|
   | Agent ID | Tikspot's RMS partner agent (from RMS) |
   | Agent password | from RMS |
   | Client ID | issued to the property by RMS Support once the *Guest Services* module is activated for the Tikspot partner |
   | Web Service password | ditto |

   For a production property, the customer emails RMS (sales@rmscloud.com) with the
   property name(s), module *Guest Services* and the partner name, then requests the
   client credentials from RMS Support and shares them with you.

3. Under **Parameters**:

   | Parameter | What to set |
   |---|---|
   | RMS API seed URL (region) | any RMS regional origin (default `https://restapi12.rmscloud.com`) — only used for `GET /clientUrl/{clientId}`; for the bundled mock, `http://<workstation LAN IP>:8091` |
   | Property ID (optional) | leave blank unless your agent can see more than one property and you want to restrict this recipe to one — use the `id` from `GET /properties`, not the client number |
   | Module type | the value RMS gave you (default `GuestServices`) |
   | Use RMS training database | leave off for a live property |

4. **Test lookup** with a real (or test) reservation's room and surname/detail. Confirm
   the parsed record looks right and the window outcome (active / not-started / ended)
   matches what you expect.
5. Add a **Guest lookup** block to your portal page pointing at this recipe, then
   **enable** it.

### Trying it without real RMS credentials first

`examples/rms-mock/` is a zero-dependency mock of the same endpoints, with fictional
sample data. Run `npm run rms-mock` from the repo root (a plain `node:http` server, no
TLS, port 8091), then in the imported recipe:

1. Set the **RMS API seed URL** parameter to `http://<your LAN IP>:8091` — the router's
   container can't reach `127.0.0.1` on your workstation, so use your machine's LAN IP,
   not `localhost`.
2. Fill in the mock's sample credentials (agent ID `1000` / password `agent-secret`,
   client ID `10042` / password `webservice-secret`).
3. Save and run **Test lookup**.

See `examples/rms-mock/README.md` for sample rooms/guests to try. Set the base URL back
to a real region before pointing the recipe at your actual RMS Cloud account.

## Guest contacts (`getGuestContacts`)

The recipes read email and mobile from `GET /guests/{id}` — the primary guest record
carries them and it is one request per reservation. `GET /guests/{id}/contacts`
(`getGuestContacts`) returns the *additional* contacts on a guest profile (partner,
company contact, emergency contact), each with `given`, `surname`, `email`, `mobile` and
`contactType`. If you want those people to be able to log in too, add a third step to
the "room + any guest detail" recipe that fills any still-empty fields from the first
extra contact:

```json
{
  "name": "contacts",
  "forEach": "reservations",
  "optional": true,
  "request": { "method": "GET", "url": "{{param.baseUrl}}/guests/{{record.guestId}}/contacts", "accept": "json" },
  "parse": { "type": "json", "root": "", "fields": { "contactEmail": "email", "contactMobile": "mobile" } }
}
```

then add `contactEmail` / `contactMobile` to the `anyOf` list of the email and mobile
match rules. Keep `maxFanOut` in mind: each extra step is one more request per
reservation in the room. The bundled mock serves this endpoint.

## Area naming

RMS's `areaName` is whatever your property calls that room/site — `"101"`, `"Villa 7"`,
`"Site 42"` — and both recipes match it against the guest's typed room number two ways:

- The **request** uses `areaNameLike`, a case-insensitive *substring* match server-side —
  so a guest typing `7` would also match `"Villa 7"` and `"Site 47"`. If your property has
  ambiguous area names, that's intentional slack the `match` step below tightens back up.
- The **match rule** compares with `normalize: "roomNumber"` — the *last* run of digits
  in each side with leading zeros dropped, so `"01 120"` (a block prefix, as in the RMS
  sandbox), `"Deluxe 002 - 10"` and `"Villa 7"` match a typed `120`, `10` and `7`, while
  `"Villa 7"` vs. `"71"` does not. If your property uses non-numeric area names
  (all-letters cabin names, say), change this rule's `normalize` to `trim` or `name` in
  Raw JSON.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every lookup fails with the "upstream" message | Either base-URL discovery (`GET /clientUrl/{clientId}`; a wrong client ID is a `404`) or login (`POST /authToken`) is failing — wrong agent/client credentials or wrong module type. **Test lookup**'s diagnostics show a `discover` step first, then the lookup steps, with the HTTP status. |
| `401` specifically | Bad credentials, or an expired/misconfigured token cache — the engine automatically retries once on a `401`/`403` with a fresh token, so a *persistent* 401 means the credentials themselves are wrong (or the account lacks API access for that module type). |
| No-match on a reservation you can see in RMS | Check `listOfStatus` — both recipes only search `arrived`/`confirmed`. A `quote`, `unconfirmed`, or `pencil` booking won't be found; that's deliberate (a lookup plugin should confirm real, current bookings, not tentative ones). If you need a different status set, edit `listOfStatus` in Raw JSON. A stay that ended more than a day ago, or arrives more than a day from now, is filtered out by the server (`departFrom`/`arriveTo`) and also reports no-match. Also check **Area naming** above if the room number has letters or extra characters, and that the **Property ID** parameter (if set) is RMS's internal property `id`, not the client number. |
| No-match on the "any detail" recipe even with room + email both correct | `minRules: 2` requires *room and at least one other rule* to both actually match — if the email on file in RMS differs from what the guest typed (a booking-agent alias address, for instance), only the room rule is satisfied and the match fails. Ask which email/mobile RMS has on file, or lower the recipe's expectations to `minRules: 1` if that's acceptable for your property. |
| **"no booking found (search returned 0 records)"** in the event log for a guest who is checked in | The search itself returned nothing, so the typed details were never compared. Almost always the **router clock**: the container takes its time from RouterOS, and both recipes filter server-side with `arriveTo={{date:+1d:sql}}` / `departFrom={{date:-1d:sql}}` computed from that clock. A router whose NTP has never synced (`/system/ntp/client print` shows status `waiting`) can be hours or days out, and a guest who arrived today falls outside the window RMS is asked for. Tikspot measures this: the event log gets a `clock` warning ("Container clock is N min behind the guest system") and **Test lookup** shows the skew in red. Fix `/system/clock` + NTP on the router (UDP 123 and DNS must be allowed out). |
| Correct guest, but "stay not active" | RMS returns each property's **local wall-clock time** with no time-zone offset (`dateFormat: "sql"`, interpreted as UTC by the engine — see `docs/plugins/README.md`). The recipes' default 24-hour leeway absorbs most timezone differences, but a property many hours from UTC right at midnight check-in/out could occasionally fall just outside it. Increase `window.leewayHours` in Raw JSON if this happens routinely for your property's timezone. |
| Guest details (email/mobile) never fill in on the "any detail" recipe | Check `maxFanOut` (default 10) — if a room search returns more candidate reservations than that, only the first `maxFanOut` are enriched with guest details; the rest keep whatever the reservation search alone provided (name, room, dates, but no email/mobile). Narrow the search (e.g. set the **Property ID** parameter) or raise `maxFanOut` in Raw JSON. |

## Limits and caveats

- **Validated on the RMS sandbox, not yet on a production property** — see the status
  note at the top. Reservation fields (`areaName`, `guestGiven`, `guestSurname`,
  `arrivalDate`, `departureDate`, `status`, `guestId`) and the guest step were confirmed
  against real sandbox responses. Re-check with **Test lookup**'s raw-response view on
  your own property.
- Both recipes request `modelType=full` (the `basic` model lacks the name and room
  fields). Any other `full`-model field can be added to `parse.fields` in Raw JSON.
- RMS returns each property's **local wall-clock time**; the recipes' 24 h leeway and the
  ±1 day server-side date filters absorb the offset.
- The RMS facts this integration relies on (endpoints, request/response shapes, status
  enum values) come from the [RMS REST API 1.4.45.1
  spec](https://app.swaggerhub.com/apis-docs/RMSHospitality/RMS_REST_API/1.4.45.1) — no
  endpoints beyond `GET /clientUrl/{clientId}`, `POST /authToken`,
  `POST /reservations/search`, `POST /guests/search`, `GET /guests/{id}`,
  `GET /guests/{id}/contacts`, `GET /properties` and `GET /areas` are used or assumed.
- **Certification** — for general availability RMS requires its Partner API
  Certification (form + a test-script session with RMS). The parts this integration
  touches: CONN-01 base-URL discovery (done), CONN-02 token caching (done, 24 h),
  single-property connections (one client ID per recipe), guest lookup by
  `areaNameLike`. Webhooks, ARI, payments and the rest do not apply to a lookup-only
  integration.
- RMS Cloud rate-limits its API; a busy portal doing many lookups per minute should keep
  `timeoutMs` reasonable and avoid unnecessarily broad searches (fill in **Property ID**
  when you can).
