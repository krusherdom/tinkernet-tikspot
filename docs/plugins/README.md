# Building your own Tikspot plugin

A Tikspot **guest-lookup plugin** is a single JSON file — a **recipe** — that tells the
captive portal how to verify a guest against a system you already run (a hotel PMS, a
membership API, a spreadsheet behind a small web service…) instead of a voucher or
account. This page is the field-by-field reference for writing one by hand or reading one
someone else wrote. For the concept and the guest-facing flow, start with
[`docs/guest-lookup-plugins.md`](../guest-lookup-plugins.md); this page goes deeper.

If your target system is **RMS Cloud**, skip straight to
[`docs/plugins/rms-cloud.md`](rms-cloud.md) — the two bundled RMS recipes already do most
of the work.

## The lookup flow, in engine terms

1. The portal collects the recipe's `inputs` (room, surname, email…) and posts them to
   the container.
2. If the recipe has `auth`, the engine logs in (once, then caches the token) and gets a
   token to attach to later requests.
3. The engine runs the recipe's request(s) — either the single top-level `request`, or
   the sequence in `steps` — and parses each response into an array of **records** with
   `parse`.
4. `match` picks the one record (if any) that matches everything the guest typed.
5. `window` checks that record's stay is currently active (with a leeway), and computes
   how long a granted credential should last.
6. On success the container mints a temporary RADIUS login and redirects the guest in;
   on failure it shows one of the recipe's `messages`.

Every step above is data (a recipe), not code — this file lists every field that data can
contain.

## Recipe shape

A recipe file (as stored in `plugins/*.json`, exported from the admin, or accepted by
`POST /api/plugins/import`) is wrapped like this:

```json
{
  "format": "tikspot-plugin",
  "version": 2,
  "recipe": { "...": "the fields below" }
}
```

`version` is the **recipe schema** version, not the app version — `1` recipes (no
`secretKeys`/`params`/`steps`/etc.) still work unchanged; the engine normalises them on
load. Everything from here on describes the `recipe` object.

### Basics

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | — | required, ≤ 80 chars |
| `enabled` | boolean | `true` | a plugin must be enabled to appear on the portal |
| `planGroup` | string | `"free"` | the plan group a successful lookup is granted into |
| `timeoutMs` | number | `8000` | per-HTTP-request timeout, 1000–30000 |
| `allowInsecureTls` | boolean | `false` | skip TLS certificate verification (self-signed dev/test servers) |
| `maxRecords` | number | `200` | cap on parsed records considered for matching, 1–5000 |
| `maxFanOut` | number | `10` | v2 — cap on parent records enriched by a `forEach` step, 1–25 (see **Steps**) |

### Secrets vs. parameters

Two different kinds of "settings a recipe needs", handled very differently:

- **Secrets** (`secretKeys`) — credentials. Write-only: never returned by the API, never
  included in an export, always blanked on catalog import.
- **Parameters** (`params` / `paramValues`) — everything else an operator configures that
  *isn't* secret (a base URL, a property ID, a feature flag). Exported and imported
  **with** the recipe, so re-importing an update doesn't lose them.

| Field | Type | Notes |
|---|---|---|
| `secretKeys` | `string[]` | which secret fields this recipe needs; default `['username','password','apiKey']` (v1 behaviour) when omitted. Each key matches `/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/`, max 16 keys, unique |
| `secretLabels` | `{ key: 'Label' }` | optional, human-readable label per key for the admin UI |
| `secrets` | `{ key: value }` | the actual values (write-only — see below). Not present in exports/catalog files |
| `params` | `{ name: {label, help?, type?, default?, options?} }` | declares non-secret operator settings. `type` ∈ `text` \| `number` \| `boolean` \| `select` (default `text`); `select` needs `options: [{value,label}]`. Name rules same as `secretKeys`, max 24 |
| `paramValues` | `{ name: value }` | the operator's chosen values; coerced by `type` on validation (number → `Number` — fails if `NaN`; boolean → `true`/`false`, also accepts `'true'/'false'/1/0`; select → must be one of `options`; text → string as-is). Missing → the param's `default` |

Templates see these as `{{secret.<key>}}` and `{{param.<name>}}` respectively.
`stripSecrets(recipe)` blanks every declared `secretKeys` entry — used before an API
response, an export, or a log line ever leaves the engine.

### Authentication (optional) — `auth`

Only needed if your system requires a login call before the lookup request(s).

| Field | Type | Default | Notes |
|---|---|---|---|
| `method` | `GET`\|`POST` | `POST` | |
| `url` | string | — | required, http(s), template-able |
| `headers` | `{name: template}` | `{}` | |
| `contentType` | `json`\|`form` | `json` | how `bodyTemplate` is encoded/escaped |
| `bodyTemplate` | string | `""` | a literal string template, e.g. `{"user":"{{secret.username}}"}` |
| `bodyJson` | object/array | — | v2 — a structured body instead of `bodyTemplate` (see **Structured JSON bodies**); when present it wins and `contentType` is forced to `json` |
| `tokenPath` | string | `"token"` | dot/bracket path (see **`getPath` syntax**) into the auth response JSON where the token lives |
| `tokenExpiryPath` | string | — | v2 — a path to a parsable date in the auth response; when present the token is cached until that time **minus 60 s**, still bounded by `tokenTtlSecs` if that's earlier |
| `tokenTtlSecs` | number | `3600` | how long to cache the token when `tokenExpiryPath` is absent (or later) |
| `placement.in` | `header`\|`query`\|`body` | `header` | where the token goes on later requests |
| `placement.name` | string | `Authorization` | header/query-param name |
| `placement.prefix` | string | `Bearer ` | prepended to the token; `''` is honoured as *no prefix* — some APIs (RMS Cloud included) want the bare token |

**Re-auth on 401/403 (v2):** if any lookup request that used a cached token comes back
401 or 403, the engine deletes that cache entry, fetches a fresh token, and retries that
one request once. A second failure is reported as `upstream` with the status code.

### Request(s)

A recipe has **either** a single top-level `request` + `parse` (v1 shape, still fully
supported), **or** a `steps` array (v2, see below) — never neither.

| Field | Type | Default | Notes |
|---|---|---|---|
| `method` | `GET`\|`POST` | `GET` | |
| `url` | string | — | required, http(s), template-able |
| `headers` | `{name: template}` | `{}` | |
| `contentType` | `json`\|`form`\|`xml`\|`text` | `json` | |
| `accept` | `json`\|`xml`\|`text` | — | sets an `Accept` header if given |
| `bodyTemplate` | string | `""` | literal body template |
| `bodyJson` | object/array | — | v2 — structured body (see below); wins over `bodyTemplate`, forces `contentType: "json"` |
| `omitEmpty` | boolean | `true` | v2 — only meaningful with `bodyJson`; see below |

> **URL templating and params.** `url` fields (on `request`, each `steps[].request`, and
> `auth`) must start with a literal `http://` / `https://` **or** with a `{{param.…}}`
> placeholder. Values substituted into a URL are percent-encoded — except `param.*`
> values, which are operator configuration (not guest input) and are inserted verbatim.
> That lets one param select the whole origin, e.g.
> `"url": "{{param.baseUrl}}/authToken"` with `baseUrl` = `https://api.example.com`,
> and lets an operator point the same recipe at a local mock (`http://192.168.1.42:8091`)
> from the admin UI without editing the recipe. This is how the two RMS Cloud recipes'
> base URL works — see [`docs/plugins/rms-cloud.md`](rms-cloud.md).

### Structured JSON bodies — `bodyJson`

`bodyTemplate` is a string you build by hand (fine for a couple of fields, tedious for
nested/array bodies like most modern REST APIs). `bodyJson` (on `request`, a `steps[]`
entry's `request`, or `auth`) is a plain JSON object/array — the engine renders it in
place, so it looks exactly like the request body you want to send:

```json
"bodyJson": {
  "guestSurname": ["{{input.name}}"],
  "areaNameLike": "{{input.room}}",
  "listOfStatus": ["arrived", "confirmed"],
  "propertyIds": ["{{int:param.propertyId}}"]
}
```

Rendering rules:

- Every string is templated the normal way (`{{input.room}}` etc.), **unless** it is
  *exactly one* typed placeholder — see below.
- **Typed placeholders** — a string that is nothing but `{{type:path}}` renders as a real
  JSON value instead of a string:

  | Placeholder | Result |
  |---|---|
  | `{{int:path}}` | integer (`parseInt`); empty/non-numeric input renders as *empty* |
  | `{{number:path}}` | `Number(...)`; same empty-on-NaN behaviour |
  | `{{bool:path}}` | `true`/`false` from `'true'/'false'/'1'/'0'/true/false`; `''` → empty |
  | `{{raw:path}}` | the variable's actual JS value (object/array/number), unmodified |
  | `{{string:path}}` | the default string behaviour, explicit |

  Example: `"agentId": "{{int:secret.agentId}}"` sends a JSON number, not `"1000"` as a
  string — RMS Cloud (and most APIs) reject a quoted number.

- **`omitEmpty`** (default `true` for `bodyJson`, `false` for `auth.bodyJson`) — after
  rendering, empty values are pruned **from the leaves up**: `''`, `null`, `undefined`,
  `[]`, and `{}`. So `"propertyIds": ["{{int:param.propertyId}}"]` with an unset
  `propertyId` param renders to `[]`, which is then removed from its parent entirely —
  the field is simply absent from the request, which is usually what an optional-filter
  API expects. Literal booleans and numbers you wrote directly in the JSON (not template
  results) are never pruned. Set `request.omitEmpty: false` to send empty
  fields/arrays as-is instead.

Every template (in `bodyJson`, `bodyTemplate`, URLs, headers) can also index into arrays:
`{{steps.reservations.records[0].guestId}}` — see **`getPath` syntax** below.

### Multi-step lookups — `steps`

For an API where one call isn't enough — search reservations, then fetch each guest's
contact details, for instance.

```json
"steps": [
  { "name": "reservations", "request": { "...": "..." }, "parse": { "...": "..." } },
  { "name": "guest", "forEach": "reservations", "request": { "...": "..." }, "parse": { "...": "..." } }
]
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | `/^[a-z][a-z0-9_]{0,30}$/`, unique, max 4 steps total |
| `request` | object | same shape as the top-level `request` (including `bodyJson`) |
| `parse` | object | same shape as the top-level `parse` |
| `forEach` | string (optional) | name of an earlier step to iterate over — see below |
| `optional` | boolean (optional) | `true` → a non-2xx status, parse failure, or timeout in *this* step is ignored (that record is left unchanged) instead of failing the whole lookup |

Execution is sequential, in array order.

- A **normal** (non-`forEach`) step runs once. Its parsed records become
  `{{steps.<name>.records}}` for later steps, and the **last** normal step's records are
  the candidate list handed to `match`.
- A **`forEach`** step runs once *per record* of the named earlier step, with
  `{{record.<field>}}` bound to that parent record (e.g.
  `{{param.baseUrl}}/guests/{{record.guestId}}`, where `baseUrl` is a param holding the
  API origin — see the note on URL templating above). Its parsed
  **first** result record is
  merged into the parent record — but only into fields the parent doesn't already have
  (**parent wins** on a conflict). This is how the RMS "any detail" recipe fills in
  `email`/`mobile` on top of the reservation fields without overwriting `firstName`/
  `lastName`/`room` it already found.
- **Fan-out cap** — `maxFanOut` (recipe-level, default 10, 1–25): parent records beyond
  the cap are left un-enriched by that `forEach` step rather than firing unlimited
  requests. There's also a hard cap of **25 HTTP requests per lookup** overall; hitting it
  fails the lookup as `{ ok:false, reason:'upstream', detail:'request-cap' }`.

Template variables available inside a step: `input`, `secret`, `param`, `token`, `now`,
`steps` (completed steps so far, as `{name:{records:[...]}}`), and — inside a `forEach`
step only — `record`.

If `steps` is present, top-level `request`/`parse` are omitted; `window` and `match`
field references are checked against the union of *every* step's `parse.fields` plus the
canonical field names.

### Parsers — `parse`

| Field | Type | Notes |
|---|---|---|
| `type` | `json`\|`xml`\|`regex` | default `json` |
| `root` | string | path to the array (or single object) of records; `""` = the whole body |
| `fields` | `{ canonicalOrCustomName: path }` | how to pull each field out of a record |
| `recordRegex` | string | `type: "regex"` only — one match per record, named groups map to `fields` |
| `dateFormat` | `iso`\|`dmy`\|`mdy`\|`ymd`\|`epoch`\|`sql` | how to parse the window's date fields |

**Field names** — `firstName`, `lastName`, `fullName`, `room`, `mobile`, `email`,
`checkIn`, `checkOut`, `bookingRef` are *canonical*: nothing forces you to populate them,
but the portal's guest-summary label and any future built-ins understand them. Anything
else in `fields` is a perfectly valid custom field name, usable in `match` and `window`
exactly like a canonical one.

**`getPath` syntax** — used for `parse.root`, `parse.fields[x]` (JSON/XML), `auth.tokenPath`
/ `tokenExpiryPath`, and template lookups like `{{steps.name.records[0].x}}`:

| Path | Meaning |
|---|---|
| `a.b.c` | nested object keys |
| `a.b[0].c` | array index |
| `a.b[*].c` | fan out over every array element (or every value of a plain object); the field's own value then becomes the **first** element found (records want scalars) |
| `""` | the whole document |

**XML** uses the same paths; an attribute is `@name` (e.g. `fields: {"id": "@id"}` for
`<guest id="7">`). **Regex** with a `recordRegex` runs once per match with named capture
groups (`(?<firstName>...)`); with `recordRegex: ""` the whole body is one record and each
`fields[x]` is its own regex whose first capture group is the value.

**Dates** — `dateFormat: "sql"` (v2) parses `YYYY-MM-DD HH:MM:SS` (also accepts a
date-only `YYYY-MM-DD`) as **UTC**. Use it for APIs (RMS Cloud included) that return
property-local wall-clock time without a zone offset — the window's leeway hours absorb
the difference between that and UTC in practice. `iso` also happens to work in this
container (which always runs UTC), but `sql` says what you mean.

### Matching — `match`

| Field | Type | Notes |
|---|---|---|
| `all` | boolean | default `true` — require every rule to pass (`false` = any one rule) |
| `rules` | array | see below |
| `minRules` | number | v2, default `0` — see below |

Each rule: `{ input, field | anyOf: [...], normalize }`.

- `input` — the name of a declared `inputs[]` entry.
- `field` — a single record field to compare against, **or** `anyOf` — a list of fields,
  any one of which matching is enough (e.g. match `name` against `firstName` *or*
  `lastName`).
- `normalize` — how both sides are compared:

  | Normalizer | Behaviour |
  |---|---|
  | `trim` (default) | trims whitespace only |
  | `name` | case/diacritic/punctuation-insensitive (`José O'Brien` ≈ `jose obrien`) |
  | `phone` | digits only, compares the **last 9 digits** if both sides have ≥ 9 (tolerates country-code/leading-zero differences) |
  | `digits` | digits only, exact match |
  | `email` | trimmed + lower-cased |
  | `upper` | trimmed + upper-cased |

- An **empty input on a rule whose `inputs[]` entry is not `required`** automatically
  passes that rule (lets an optional field simply not narrow the search). An empty input
  on a *required* field fails the rule (and so the match, under `all: true`).
- **`minRules`** (v2) — beyond the all/any pass/fail above, count how many rules were
  **satisfied** (input was non-empty *and* matched). The record only matches if that count
  is ≥ `minRules`. This is how a recipe can say "room is required, but also require at
  least one more matching identifier" without making every optional input individually
  required: `room` (required) + four optional identifiers, `minRules: 2` means room alone
  is never enough — one more must also match.

### Stay window — `window` (optional)

| Field | Type | Default | Notes |
|---|---|---|---|
| `start`, `end` | string | — | field names (from `parse.fields`), the stay's bounds |
| `leewayHours` | number | `24` | grace either side of `start`/`end` |
| `maxGrantHours` | number | `168` | hard cap on how long a granted credential lasts, from *now* |

No `window` at all → always "in window", granted `maxGrantHours` from now. A window with
a record missing either date → `outside-window` / `missing-dates`. Otherwise the stay is
"active" while `start - leeway ≤ now ≤ end + leeway`, and the credential expires at
`min(end + leeway, now + maxGrantHours)`.

### Guest inputs — `inputs[]`

What the login page shows: `{ name, label, type, required, placeholder, autocomplete? }`.
`name` matches `/^[a-z][a-z0-9_]{0,30}$/`, unique per recipe. `type` ∈ `text`\|`tel`\|
`email`\|`number`.

### Messages — `messages`

`{ noMatch, outsideWindow, upstream }` — what the guest sees on each failure. Falls back
to sensible defaults if omitted.

## Testing a recipe

- **Admin → Guest lookup → Test lookup**: enter sample inputs, see the outcome, the
  parsed records, and (for multi-step recipes) a per-step breakdown with timing —
  everything a diagnostic needs, still with secrets/tokens redacted.
- **Run it against a local mock** before you touch a production system:
  `examples/guest-api/` (JSON/XML/regex, single request) and `examples/rms-mock/`
  (structured JSON bodies, multi-step, RMS Cloud shape) are both zero-dependency
  `node:http` scripts you can point a recipe at from your workstation.
- **Automated tests** follow the same pattern used by
  `app/test/plugins.test.js`/`app/test/plugins-rms.test.js`: spawn the mock with
  `PORT=0`, read the bound port off its `listening on http://127.0.0.1:<port>` stdout
  line, load a recipe with `validateRecipe`, and drive it with `runLookup` +
  `makeTokenCache()` from `app/src/plugins/{recipe,engine}.js` — no admin/DB layer
  needed.

## Publishing to the catalog

1. In the admin, get the recipe working and tested, then **Export** (this strips
   secrets automatically).
2. Save it under `plugins/<vendor-or-system>-<flavour>.json`, `"enabled": false`.
3. Add an entry to [`plugins/index.json`](../../plugins/index.json):

   ```json
   {
     "id": "acme-pms-json",
     "name": "Acme PMS (JSON)",
     "description": "One or two sentences.",
     "author": "your name or handle",
     "file": "acme-pms-json.json",
     "tags": ["hotel", "json", "token-auth"],
     "requires": "Acme PMS ≥ 4.2 with the guest-search API enabled",
     "parser": "json",
     "inputs": ["room", "name"]
   }
   ```
4. Open a pull request. See [`plugins/README.md`](../../plugins/README.md) for the full
   contribution checklist — never include real credentials, production hostnames, or
   guest data.

## Security notes

- **Secrets never leave the engine unredacted.** `secrets` is write-only: the admin API
  never echoes values back (`has_secrets` is a boolean map, not the values), exports and
  catalog imports always blank every `secretKeys` entry, and `runLookup`'s result never
  contains a token or secret value even on failure.
- **TLS is verified by default.** `allowInsecureTls` exists for self-signed dev/test
  servers only — never enable it against a real system reachable over the internet.
- **Requests are bounded.** Each HTTP call has `timeoutMs` (default 8 s); a lookup can
  fire at most **25 HTTP requests total** (relevant mainly to `steps`/`forEach` recipes),
  and `maxFanOut` (default 10) limits how many parent records a `forEach` step enriches.
  Response bodies are capped at 2 MB.
- **The container needs outbound access** to whatever host a recipe's `request`/`auth`
  URLs point at — a masquerade rule for the container's subnet (Setup → Verify flags a
  missing one) and DNS if you use a hostname.
