# RMS Cloud

[RMS Hospitality](https://www.rmscloud.com/) ("RMS Cloud") is a property management
system (PMS) for hotels, resorts, parks and short-stay accommodation. Tikspot ships two
ready-made guest-lookup recipes for its REST API, so guests can log into Wi-Fi with the
same room number and surname (or any other detail) your front desk already has on file.

This page covers what you need before you start, how to install and configure the
recipes, and how to troubleshoot them. For the engine concepts they use (`bodyJson`,
`steps`, `minRules`, …), see [`docs/plugins/README.md`](README.md).

> **Status:** these recipes are built and verified against the bundled mock
> (`examples/rms-mock/`), matching the endpoints and fields documented in the [RMS REST
> API spec, version 1.4.45.1](https://app.swaggerhub.com/apis-docs/RMSHospitality/RMS_REST_API/1.4.45.1).
> They have **not yet been run against a live RMS Cloud account** — do that with **Test
> lookup** before enabling either recipe on a production portal, and please report back
> anything that doesn't match.

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

Both pairs are required on every login (`POST /authToken`); RMS returns a short-lived
token used on every subsequent call.

You'll also want to know:

- **Region** — which regional API host your account lives on: Asia-Pacific/Australia
  (`restapi12`), North America (`restapi13`), Europe (`restapi14`), or China (`restapi9`).
  Ask RMS support or your onboarding contact if you're not sure. Each region also has a
  `beta` variant for RMS's staging environment — only use it if RMS told you to.
- **Module type** — a string RMS associates with your agent's API access, commonly
  `"distribution"`. RMS tells you the correct value when they set up your agent.
  Wrong value → `401` on login.
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
`POST /reservations/search` filtered by `areaNameLike` only, restricted to
`arrived`/`confirmed` reservations. The surname is deliberately **not** sent to RMS: RMS's
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

Use this one when guests might not remember which name a booking is under, or you'd
rather ask for a mobile number or email instead.

## Installing

1. Start Tikspot's admin, **Guest lookup → Browse catalog**, and import one (or both) of
   the two RMS recipes. They arrive **disabled**, with no secrets.
2. Open the recipe. Under **Secrets**, fill in:

   | Field | Value |
   |---|---|
   | Agent ID | from RMS |
   | Agent password | from RMS |
   | Client ID | from your property's RMS admin |
   | Web Service password | from your property's RMS admin |

3. Under **Parameters**:

   | Parameter | What to set |
   |---|---|
   | RMS API base URL | your account's regional origin (see above), e.g. `https://restapi13.rmscloud.com`; for the bundled mock, `http://<workstation LAN IP>:8091` |
   | Property ID (optional) | leave blank unless your agent can see more than one property and you want to restrict this recipe to one |
   | Module type | the value RMS gave you (default `distribution`) |
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

1. Set the **RMS API base URL** parameter to `http://<your LAN IP>:8091` — the router's
   container can't reach `127.0.0.1` on your workstation, so use your machine's LAN IP,
   not `localhost`.
2. Fill in the mock's sample credentials (agent ID `1000` / password `agent-secret`,
   client ID `11281` / password `webservice-secret`).
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
- The **match rule** compares with `normalize: "digits"` — it strips everything but
  digits from both the guest's input and the record's `areaName`, so `"Villa 7"` vs. `"7"`
  is a match but `"Villa 7"` vs. `"71"` is not. If your property uses non-numeric area
  names (all-letters cabin names, say), change this rule's `normalize` to `trim` or
  `name` in Raw JSON.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every lookup fails with the "upstream" message | Login (`POST /authToken`) is failing — wrong agent/client credentials, wrong region, or wrong module type. Check **Test lookup**'s diagnostics for the actual HTTP status. |
| `401` specifically | Bad credentials, or an expired/misconfigured token cache — the engine automatically retries once on a `401`/`403` with a fresh token, so a *persistent* 401 means the credentials themselves are wrong (or the account lacks API access for that module type). |
| No-match on a reservation you can see in RMS | Check `listOfStatus` — both recipes only search `arrived`/`confirmed`. A `quote`, `unconfirmed`, or `pencil` booking won't be found; that's deliberate (a lookup plugin should confirm real, current bookings, not tentative ones). If you need a different status set, edit `listOfStatus` in Raw JSON. Also check **Area naming** above if the room number has letters or extra characters. |
| No-match on the "any detail" recipe even with room + email both correct | `minRules: 2` requires *room and at least one other rule* to both actually match — if the email on file in RMS differs from what the guest typed (a booking-agent alias address, for instance), only the room rule is satisfied and the match fails. Ask which email/mobile RMS has on file, or lower the recipe's expectations to `minRules: 1` if that's acceptable for your property. |
| Correct guest, but "stay not active" | RMS returns each property's **local wall-clock time** with no time-zone offset (`dateFormat: "sql"`, interpreted as UTC by the engine — see `docs/plugins/README.md`). The recipes' default 24-hour leeway absorbs most timezone differences, but a property many hours from UTC right at midnight check-in/out could occasionally fall just outside it. Increase `window.leewayHours` in Raw JSON if this happens routinely for your property's timezone. |
| Guest details (email/mobile) never fill in on the "any detail" recipe | Check `maxFanOut` (default 10) — if a room search returns more candidate reservations than that, only the first `maxFanOut` are enriched with guest details; the rest keep whatever the reservation search alone provided (name, room, dates, but no email/mobile). Narrow the search (e.g. set the **Property ID** parameter) or raise `maxFanOut` in Raw JSON. |

## Limits and caveats

- **Live validation pending real credentials** — see the status note at the top. Treat
  the recipes as a strong starting point, not a guarantee; re-verify field names against
  your RMS account's actual API responses (RMS occasionally varies fields by property
  configuration) using **Test lookup**'s raw-response view.
- Both recipes only request `modelType=basic` — RMS's smaller reservation shape. If you
  need a `full`-model field these recipes don't map, add it to `parse.fields` in Raw JSON;
  the mock server also implements `modelType=full` for testing that change.
- The RMS facts this integration relies on (endpoints, request/response shapes, status
  enum values) come from the [RMS REST API 1.4.45.1
  spec](https://app.swaggerhub.com/apis-docs/RMSHospitality/RMS_REST_API/1.4.45.1) — no
  endpoints beyond `POST /authToken`, `POST /reservations/search`, `POST /guests/search`,
  `GET /guests/{id}`, `GET /guests/{id}/contacts`, and `GET /areas` are used or assumed.
- RMS Cloud rate-limits its API; a busy portal doing many lookups per minute should keep
  `timeoutMs` reasonable and avoid unnecessarily broad searches (fill in **Property ID**
  when you can).
