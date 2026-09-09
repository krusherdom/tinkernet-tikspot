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
| `source` | `http`\|`list` | `http` | v3 (0.16) — `http` is everything on this page below; `list` is the built-in guest-list source — see **Built-in guest-list source** |
| `planGroup` | string | `"free"` | the plan group a successful lookup is granted into |
| `timeoutMs` | number | `8000` | per-HTTP-request timeout, 1000–30000 |
| `allowInsecureTls` | boolean | `false` | skip TLS certificate verification (self-signed dev/test servers) |
| `maxRecords` | number | `200` | cap on parsed records considered for matching, 1–5000 |
| `maxFanOut` | number | `10` | v2 — cap on parent records enriched by a `forEach` step, 1–25 (see **Steps**) |
| `requireRecords` | boolean | `false` | v3 (0.16) — top-level `request`/`parse` form only (no `steps[]`): fail immediately with `reason:'no-match'` if the request comes back with zero records, instead of falling through to `match` with an empty list. The per-step equivalent for `steps[]` is `steps[].requireRecords` — see **Multi-step lookups** |

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
| `basic` | `{user, pass}` | — | v3 (0.16) — declarative HTTP Basic auth on the token request: sets `Authorization: Basic base64(user:pass)`. `user`/`pass` are templates (typically `{{secret.clientId}}` / `{{secret.clientSecret}}`); both must be strings (`pass` may be `''`). See **Basic auth** below |
| `tokenPath` | string | `"token"` | dot/bracket path (see **`getPath` syntax**) into the auth response JSON where the token lives |
| `tokenExpiryPath` | string | — | v2 — a path to a parsable date in the auth response; when present the token is cached until that time **minus 60 s**, still bounded by `tokenTtlSecs` if that's earlier |
| `tokenTtlSecs` | number | `3600` | how long to cache the token when `tokenExpiryPath` is absent (or later) |
| `placement.in` | `header`\|`query`\|`body` | `header` | where the token goes on later requests |
| `placement.name` | string | `Authorization` | header/query-param name |
| `placement.prefix` | string | `Bearer ` | prepended to the token; `''` is honoured as *no prefix* — some APIs (RMS Cloud included) want the bare token |

**Re-auth on 401/403 (v2):** if any lookup request that used a cached token comes back
401 or 403, the engine deletes that cache entry, fetches a fresh token, and retries that
one request once. A second failure is reported as `upstream` with the status code.

### Basic auth (v3, 0.16)

Some guest systems want plain [HTTP Basic](https://developer.mozilla.org/en-US/docs/Web/HTTP/Authentication)
instead of (or alongside) a token exchange. `basic: { user, pass }` is available on:

- `auth.basic` — applied to the token request only.
- `request.basic` — applied to the top-level lookup request (no `steps[]`).
- `steps[].request.basic` — applied to that step's request.

Each sets `Authorization: Basic base64(user:pass)`, rendered with escape mode `none`
(`template.js` always strips CR/LF from substituted values regardless of mode, so a
malicious guest input can't inject a second header). `user`/`pass` are ordinary templates
— typically `{{secret.username}}`/`{{secret.password}}` or a client-credentials pair like
`{{secret.clientId}}`/`{{secret.clientSecret}}`. Both must be strings; `pass` may be `''`.

**If a token placement also targets the `Authorization` header** (`auth.placement.in:
"header"`, the default, with `placement.name: "Authorization"`, also the default), **the
token wins** — it's applied after `basic` on the same request. Use `request.basic` only
when the guest-system endpoint itself needs Basic (no separate token step), or combine it
with a token placed somewhere else (a different header, a query param, or the body).

The rendered `Authorization: Basic …` value is never logged, returned by the admin API, or
included in `runLookup`'s diagnostics — same guarantee as every other secret-derived value.

### Request(s)

A recipe has **either** a single top-level `request` + `parse` (v1 shape, still fully
supported), **or** a `steps` array (v2, see below) — never neither.

| Field | Type | Default | Notes |
|---|---|---|---|
| `method` | `GET`\|`POST` | `GET` | |
| `url` | string | — | required, http(s), template-able |
| `headers` | `{name: template}` | `{}` | |
| `contentType` | `json`\|`form`\|`xml`\|`text` | `json` | |
| `accept` | `json`\|`xml`\|`text`\|`csv` | — | sets an `Accept` header if given; `csv` sends `Accept: text/csv, text/plain;q=0.9, */*;q=0.8` |
| `bodyTemplate` | string | `""` | literal body template |
| `bodyJson` | object/array | — | v2 — structured body (see below); wins over `bodyTemplate`, forces `contentType: "json"` |
| `omitEmpty` | boolean | `true` | v2 — only meaningful with `bodyJson`; see below |
| `basic` | `{user, pass}` | — | v3 (0.16) — see **Basic auth** above |
| `paginate` | object | — | v3 (0.16), **top-level `request` only** (no `steps[]`) — follows a cursor across pages; requires `parse.type: "json"`. See **Pagination** under **Multi-step lookups** — the shape is identical, just hung off `request` instead of a step |

> On the top-level (no-`steps[]`) form, `requireRecords` lives on the **recipe itself**
> (a sibling of `request`, not nested inside it — see the Basics table above), while
> `paginate` lives **inside** `request` as shown here. The two forms intentionally differ
> in shape from their `steps[]` equivalents (`steps[].requireRecords`, `steps[].paginate`,
> both siblings of that step's own `request`) because there's no separate "step wrapper"
> object for the single-request form to hang a sibling field off of.

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

### Template helpers (v3, 0.16)

A small set of string helpers work **everywhere** a template runs — `request`/`auth`/
`steps[].request` `url`/`headers`/`bodyTemplate`, and inside a `bodyJson` string leaf that
isn't an exact typed placeholder (`{{int:a.b}}` etc. — those keep their existing meaning;
see **Structured JSON bodies** above). A helper always renders a string.

| Helper | Result |
|---|---|
| `{{base64:path}}` | base64 of the UTF-8 value |
| `{{lower:path}}` | lower-cased |
| `{{upper:path}}` | upper-cased |
| `{{trim:path}}` | leading/trailing whitespace stripped |
| `{{urlencode:path}}` | `encodeURIComponent` — inserted **as-is**, even when the surrounding escape mode isn't `url` (it's already percent-encoded; don't double-encode it) |
| `{{digits:path}}` | digits only (handy for `phone`/`room`) |
| `{{date:<offset>}}` / `{{date:<offset>:<fmt>}}` | ISO-8601 UTC timestamp of `now + offset` — see below |
| `{{today}}` | shorthand for `{{date:0d:ymd}}` |

**`date` offsets** — `[+-]<int><unit>`, unit ∈ `m` (minutes) \| `h` \| `d`:
`{{date:-1d}}`, `{{date:+36h}}`, `{{date:0d}}` (no explicit sign = positive). **Format**
(default `iso`): `iso` (`2026-09-09T10:00:00.000Z`), `ymd` (`2026-09-09`), `sql`
(`2026-09-09 10:00:00`), `epoch` (seconds). `now`/`today`/`date` are all derived from the
same injected clock the engine passes `runLookup({ now })` — deterministic in tests, and
consistent across every template in one lookup run.

Every helper's result is escaped per the surrounding escape mode exactly like a normal
variable value (`urlencode` is the one exception, as above). **An unknown helper name
renders as an empty string** — and `validateRecipe` flags it as a validation error
wherever it can see the template (`url`, `headers`, `bodyTemplate`, `bodyJson` leaves),
e.g. `fields['request.url'] = 'unknown template helper "lowre"'` for a typo like
`{{lowre:input.name}}`.

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
| `request` | object | same shape as the top-level `request` (including `bodyJson`, `basic`) |
| `parse` | object | same shape as the top-level `parse` |
| `forEach` | string (optional) | name of an earlier step to iterate over — see below |
| `optional` | boolean (optional) | `true` → a non-2xx status, parse failure, or timeout in *this* step is ignored (that record is left unchanged) instead of failing the whole lookup |
| `requireRecords` | boolean (optional), v3 (0.16) | `true` → if this step (after parsing) yields zero records, the lookup ends immediately with `{ ok:false, reason:'no-match', detail:'step:<name>' }` instead of letting a later, unfiltered step run anyway — see **`requireRecords`** below |
| `paginate` | object (optional), v3 (0.16) | repeats this step's request, following a cursor, accumulating records — see **Pagination** below |
| `extra` | `{fieldName: template}` (optional), v3 (0.16) | stamps templated values onto every record this step produced — see **`extra`** below |

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

#### `requireRecords` (v3, 0.16)

By default, a step that comes back with zero records just hands an empty list on to the
next step (or, for the last step, to `match` — which then reports `no-match` anyway).
That's fine when the *last* step is the one filtering, but wrong for a step whose whole
job is to narrow things down before a later, broader step runs — e.g. "look up the room
id for this room number" before "search reservations for that room id". Without
`requireRecords`, an empty "room id" step would let the reservations step run with a
useless/unfiltered request. Set `requireRecords: true` on that step (or, for the
top-level `request` form with no `steps[]`, `requireRecords: true` on the *recipe* — see
the Basics table) to end the lookup right there instead:

```json
{ "ok": false, "reason": "no-match", "detail": "step:<name>" }
```

#### Pagination — `paginate` (v3, 0.16)

For an API that pages its results, `paginate` repeats a step's request, adding a cursor
from the previous page each time, and appends every page's records together:

| Field | Type | Default | Notes |
|---|---|---|---|
| `cursorPath` | string | — | required; `getPath` into the parsed JSON response body where the next-page cursor lives, e.g. `pagination.continuation` |
| `morePath` | string | — | optional; a `getPath` into a boolean in the same body — when given, pagination stops once it's falsy (in addition to stopping when `cursorPath` comes back empty) |
| `in` | `query`\|`body` | `query` | where the cursor is added on the *next* request: a query string param, or a top-level key merged into a JSON request body |
| `name` | string | — | required; the query param name or JSON body key |
| `maxPages` | number | `5` | 1–10 |

```json
"paginate": { "cursorPath": "pagination.continuation", "in": "query", "name": "cursor", "maxPages": 5 }
```

Only valid when the step's (or, for the top-level form, the recipe's) `parse.type` is
`"json"` — there's no cursor to read out of csv/xml/regex bodies, and `validateRecipe`
rejects a `paginate` paired with any other parse type. Pagination stops at whichever comes
first: `maxPages`, the lookup-wide **25-request cap** (silently — the records gathered so
far are kept, the lookup doesn't fail), `recipe.maxRecords`, or no cursor (or a falsy
`morePath`) coming back. Diagnostics add a `pages` count to that step's entry (only when
`paginate` is set — a non-paginated step's diagnostics are unchanged). Pagination is not
supported inside a `forEach` step (that already runs once per parent record).

#### `extra` (v3, 0.16)

`extra: { fieldName: template }` renders each template **once per step** (not once per
record — so `{{record.*}}` isn't in scope, only `input`/`secret`/`param`/`token`/`now`/
`steps`, including template helpers like `{{today}}`/`{{date:...}}`) and stamps the
resulting value onto **every** record that step produced, **overwriting** any existing
value of the same name. This is how a guest-list source without native check-in/check-out
dates (an Eventbrite attendee export, say) can still use `window`: fetch the event's dates
in an earlier step, then set them as `extra` on the attendee step:

```json
{
  "name": "attendees",
  "request": { "...": "..." },
  "parse": { "type": "json", "fields": { "fullName": "name", "email": "email" } },
  "extra": { "checkIn": "{{steps.event.records[0].startDate}}", "checkOut": "{{steps.event.records[0].endDate}}" }
}
```

`extra` field names count as declared parse fields for `match`/`window` validation, same
as any `parse.fields` entry.

If `steps` is present, top-level `request`/`parse` are omitted; `window` and `match`
field references are checked against the union of *every* step's `parse.fields` plus the
canonical field names.

### Parsers — `parse`

| Field | Type | Notes |
|---|---|---|
| `type` | `json`\|`xml`\|`regex`\|`csv` | default `json` |
| `root` | string | path to the array (or single object) of records; `""` = the whole body. Ignored for `csv` |
| `fields` | `{ canonicalOrCustomName: path }` | how to pull each field out of a record |
| `recordRegex` | string | `type: "regex"` only — one match per record, named groups map to `fields`. Ignored for `csv` |
| `dateFormat` | `iso`\|`dmy`\|`mdy`\|`ymd`\|`epoch`\|`sql` | how to parse the window's date fields |
| `delimiter` | `,`\|`;`\|`\t`\|`auto` | `type: "csv"` only — default `,`; `auto` sniffs the first line |
| `header` | boolean | `type: "csv"` only — default `true`; first row is column names |
| `skipEmpty` | boolean | `type: "csv"` only — default `true`; blank lines are dropped |
| `quote` | string (1 char) | `type: "csv"` only — default `"` |

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

**CSV (v3, 0.16)** — for a guest system that answers with a CSV export instead of
JSON/XML. RFC-4180-ish: quoted fields, doubled quotes (`""`) inside a quoted field,
embedded delimiters/newlines inside quotes, CRLF or LF line endings, and an optional
leading UTF-8 BOM are all handled. Set `request.accept: "csv"` to ask for it (see the
Request(s) table above).

- With `header: true` (the default), each data row becomes an object keyed by the
  **trimmed** header names, and `fields` values are column names, matched
  **case-insensitively**, or `#<index>` (0-based) for a positional lookup.
- With `header: false`, there are no header names to match against, so every `fields`
  value **must** be `#<index>` — the parser synthesizes header names `#0`, `#1`, ...
- An empty/absent `fields` passes each row through as-is, keyed by its own column (or
  `#index`) names — handy for a quick look before you write the mapping.
- `maxRecords` is honoured **while parsing** (not just afterwards, like json/xml/regex):
  the tokenizer stops once enough data rows have been read, so a huge guest-list export
  doesn't need to be fully materialised in memory just to be capped.

`parsers.js` exports `parseCsv(text, opts) -> { headers, rows }` and
`mapCsvFields(row, headers, fieldsMap) -> record` for reuse — the built-in guest-list
source's admin upload (`PUT /api/plugins/:id/list`, see below) uses the same `parseCsv`.

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
  | `name` | case/diacritic/punctuation-insensitive; hyphens, dashes and slashes count as optional word breaks (`José O'Brien` ≈ `jose obrien`, `Smith-Jones` ≈ `smith jones` ≈ `smithjones`) |
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

## Built-in guest-list source — `source: "list"` (v3, 0.16)

Not every guest system has an API — sometimes reception just has a spreadsheet. `source:
"list"` skips HTTP entirely: an admin uploads a CSV of guests (via **Admin → Guest lookup
→ Guest list**, or `PUT /api/plugins/:id/list`) and the engine matches straight against
those stored rows.

```json
{
  "name": "Weekend Wedding Guest List",
  "source": "list",
  "inputs": [{ "name": "room", "label": "Room", "type": "text", "required": true }],
  "match": { "all": true, "rules": [{ "input": "room", "field": "room", "normalize": "trim" }] },
  "window": { "start": "checkIn", "end": "checkOut" }
}
```

**What's different from `source: "http"` (the default):**

- `request`, `auth`, and `steps` are **not allowed** — `validateRecipe` rejects any of
  them being present. There's no HTTP call to configure.
- `parse` is optional, and only two of its fields are honoured:
  - `fields` — `{ canonicalOrCustomName: columnName }`, matched **case-insensitively**
    against the CSV's column names (same convention as the csv parser's `fields`, minus
    the `#<index>` form — list rows always come from a header row).
  - `dateFormat` — same meaning as everywhere else, for `window.start`/`window.end`.
  - If `fields` is absent, **columns are used as-is**: a column literally named `room`,
    `firstName`, `lastName`, `email`, `checkIn`, `checkOut`, etc. maps directly, with no
    mapping needed at all for a well-named export.
- `match`, `window`, `inputs`, `messages`, and `planGroup` all work **exactly** like an
  `http` recipe — a list-source guest still needs to type something that matches a row,
  and a stay window still gates and expires the grant the same way.
- Because the actual column names in a future CSV upload aren't knowable when the recipe
  is saved, `validateRecipe` doesn't check `match`/`window` field references against
  `parse.fields` for a list recipe the way it does for `http` — any name is accepted.

### The CSV column contract

Upload a CSV whose **first row is the column names** (case doesn't matter — matching is
case-insensitive both for `parse.fields` values and for the "columns used as-is"
fallback). Every value is stored and matched as a plain string; `window`/`parse.dateFormat`
parsing happens at lookup time, same as an `http` recipe's response. A row can carry any
extra columns you like beyond what `match`/`window` reference — they're simply ignored.

### Admin workflow

1. **Admin → Guest lookup → (create/edit a plugin) → Basics → Source**: choose "Built-in
   guest list". This hides the Authentication/Secrets/Request/Parser/Multi-step/Parameters
   cards (there's nothing to configure there) and shows a **Guest list** card instead.
2. Paste CSV text directly, or choose a `.csv` file (read client-side into the same
   textarea) — then **Replace list**. The card shows the resulting row count, the detected
   columns, and a 5-row sample so you can confirm the mapping before saving.
3. **Clear list** empties it (e.g. before uploading a corrected file).

Under the hood, that card talks to:

| Method | Route | Body / Query | Response |
|---|---|---|---|
| `GET` | `/api/plugins/:id/list` | — | `{ count, sample: rows.slice(0,20), columns }` |
| `PUT` | `/api/plugins/:id/list` | `{ csv: "<text>" }` (header row required) **or** `{ rows: [{...}] }` | `{ count, columns }` — replaces the stored rows wholesale |
| `DELETE` | `/api/plugins/:id/list` | — | `{ ok: true }` — clears the stored rows |

Rows are capped at **5000** per plugin (extra rows are silently dropped, oldest-loaded
order, on a `PUT`); the `PUT` body limit is **2 MB** (up from Fastify's 1 MB app-wide
default) to fit a reasonably large guest list pasted or uploaded as CSV. Deleting the
plugin itself deletes its rows (`ON DELETE CASCADE` on `plugin_list_rows.plugin_id`).

### Storage, backup, and export

List rows live in their own table (`plugin_list_rows`, one row per guest, `plugin_id` FK)
rather than inside `recipe_json` — this **is** configuration, not accounting history, so a
config-only backup keeps it (it isn't in that backup's dropped-tables list) and it isn't
wiped by a redacted backup the way `secrets_json` is (a guest list has no credentials to
redact — though it does have names/rooms, which is exactly why it's excluded from
**Export** unless asked for). `GET /api/plugins/:id/export` adds a top-level `listRows`
array **only** with `?includeRows=1` — the default omits it, since a plain export is meant
to be shareable (a catalog contribution, a support attachment) without leaking guest PII.
Import (`POST /api/plugins/import`) stores `listRows` when the uploaded bundle has them.

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
  needed. `app/test/plugins-v3.test.js` covers the 0.16 additions (helpers, Basic auth,
  the csv parser, `source: "list"`, `requireRecords`, `paginate`, `extra`) the same way —
  a stub `http`, no admin/DB layer. `app/test/plugins-list-db.test.js` covers the
  DB-backed pieces specific to `source: "list"` (`plugin_list_rows` CRUD, cascade delete,
  the admin `/api/plugins/:id/list` routes, export/import with `listRows`) following
  `app/test/plugins-db.test.js`'s conventions (an in-memory, migrated better-sqlite3 DB).

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
  fire at most **25 HTTP requests total** (relevant mainly to `steps`/`forEach`/`paginate`
  recipes), and `maxFanOut` (default 10) limits how many parent records a `forEach` step
  enriches. Response bodies are capped at 2 MB.
- **The container needs outbound access** to whatever host a recipe's `request`/`auth`
  URLs point at — a masquerade rule for the container's subnet (Setup → Verify flags a
  missing one) and DNS if you use a hostname.
- **Basic auth is never logged.** `auth.basic`/`request.basic`'s rendered
  `Authorization: Basic …` value never appears in the admin API, `runLookup`'s result, or
  its diagnostics — same guarantee as a token or a secret value.
- **A guest list is PII, handled like one.** `source: "list"` rows are excluded from
  **Export** unless `?includeRows=1` is explicitly passed, capped at 5000 rows per plugin,
  and the admin upload endpoint has its own 2 MB body limit (independent of the app-wide
  1 MB default) rather than a blanket increase to every route.

## Supported systems

Every catalog recipe (`plugins/index.json`) carries a `verified` field — `"live"` (run
against the real vendor's API or a public demo) or `"mock"` (built from the vendor's
published docs, tested against a bundled mock, but not yet run against the real service).
See [`plugins/README.md`](../../plugins/README.md#the-verified-field) for what that
distinction means in practice, and each system's own doc page for specifics.

| System | Recipe | Auth | Verified | Docs |
|---|---|---|---|---|
| Demo hotel API (this repo's own `examples/guest-api/`) | `demo-hotel-json.json`, `demo-hotel-xml.json`, `demo-hotel-regex.json` | username/password token, or API key | mock | [`guest-lookup-plugins.md`](../guest-lookup-plugins.md) |
| RMS Cloud | `rms-cloud-surname-room.json`, `rms-cloud-any-detail.json` | agent + client credentials → token | mock | [`rms-cloud.md`](rms-cloud.md) |
| Mews | `mews-connector.json` | client + access token pair, embedded per request | **live** (public demo) | [`mews.md`](mews.md) |
| Apaleo | `apaleo.json` | OAuth2 client credentials, HTTP Basic on the token request | mock | [`apaleo.md`](apaleo.md) |
| Cloudbeds | `cloudbeds.json` | static API key (`x-api-key`) | mock | [`cloudbeds.md`](cloudbeds.md) |
| CSV / Google Sheet, or the built-in guest list | `csv-url.json`, or `source: "list"` | none | mock | [`csv-and-guest-list.md`](csv-and-guest-list.md) |
| Eventbrite | `eventbrite.json` | private token (bearer) | mock | [`eventbrite.md`](eventbrite.md) |

### Documented, not yet shipped as a recipe

These systems are on the radar but don't have a catalog recipe yet — notes here so the
next contributor doesn't have to re-research the auth model from scratch:

| System | Auth model | Notes |
|---|---|---|
| Oracle OPERA Cloud (OHIP) | OAuth2 client credentials **plus** an `x-app-key` header identifying the app | Self-service developer portal at `opera-cloud-apis.oracle.com`; scoped per hotel chain/property, so a recipe would need a `hotelId` (and often `externalSystemId`) parameter alongside the usual client credentials. |
| Guesty | OAuth2 client credentials, `POST https://open-api.guesty.com/oauth2/token`, scope `open-api` | Standard client-credentials shape — should map cleanly onto the same `auth` block as Apaleo's, once the reservations-search endpoint and field names are confirmed against a sandbox. |
| Hostaway | `POST /v1/accessTokens`, `grant_type=client_credentials`, tokens valid ~24 months | Unusually long-lived tokens mean `tokenTtlSecs` would need to be set deliberately short of the real expiry (or `tokenExpiryPath` used) so a leaked/rotated credential doesn't stay cached indefinitely. |
| Beds24 (v2 API) | Multi-step: a one-time **invite code** is exchanged for a long-lived **refresh token**, which is then exchanged for short-lived access tokens | Doesn't fit the current single-step `auth` block cleanly (the invite-code exchange is a one-time setup action, not a per-lookup token fetch) — would need either a small admin-side "connect" flow, or documenting the refresh-token exchange as a manual one-time **Secrets** setup step. |

**Out of scope:** serial/legacy PMS interfaces such as **OPERA FIAS** (a proprietary
serial/socket protocol, not HTTP) aren't a fit for this recipe model at all — a plugin
here always speaks HTTP(S). A property on FIAS-only integration would need a small
translation service in front of it exposing a REST/CSV API, which could then use any of
the HTTP-based recipes above (or the built-in guest list, if the export is periodic
rather than live).
