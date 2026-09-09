# Tikspot plugin catalog

Community **guest-lookup recipes** for Tikspot. A recipe tells the captive portal how to
verify a guest against an external system (hotel PMS, membership API, booking sheet…):
which API to call, how to log in, how to parse JSON / XML / text, which fields identify a
guest and which dates bound their stay. See `docs/guest-lookup-plugins.md` for the model.

The admin's **Guest lookup → Browse catalog** reads this folder (via `index.json`) and
imports a recipe with one click. Imported recipes arrive **disabled and without secrets**;
review the URLs, add credentials, run **Test lookup**, then enable.

## Files

| File | What |
|---|---|
| `index.json` | The catalog: `{ format: "tikspot-plugin-catalog", plugins: [ … ] }` |
| `demo-hotel-json.json` | Demo hotel API, JSON + username/password token login |
| `demo-hotel-xml.json` | Demo hotel API, XML + `X-Api-Key` header |
| `demo-hotel-regex.json` | Demo hotel API, plain text parsed with a named-group regex |
| `rms-cloud-surname-room.json` | RMS Cloud (real PMS), room + surname |
| `rms-cloud-any-detail.json` | RMS Cloud (real PMS), room + any one of last name / first name / email / mobile (multi-step) |
| `mews-connector.json` | Mews Connector API (real PMS), room + any guest detail (multi-step, embedded tokens) |
| `apaleo.json` | Apaleo (real PMS), room + any guest detail (OAuth2 + HTTP Basic auth) |
| `cloudbeds.json` | Cloudbeds (real PMS), room + any guest detail (static API key) |
| `csv-url.json` | Any CSV over HTTP (e.g. a published Google Sheet), room + any guest detail, no login |
| `eventbrite.json` | Eventbrite attendees, email + last name (multi-step, pagination) |

The three demo files target `examples/guest-api/` (run `npm run guest-api` on a machine
the router's container can reach, then change the recipe's host to that machine's LAN IP).

The two RMS Cloud recipes target the real [RMS Hospitality](https://www.rmscloud.com/)
REST API — see [`docs/plugins/rms-cloud.md`](../docs/plugins/rms-cloud.md) for
prerequisites, setup, and how to try them against the bundled mock
(`examples/rms-mock/`) before you have real credentials.

The five 0.16 recipes each have their own doc page under
[`docs/plugins/`](../docs/plugins/) (`mews.md`, `apaleo.md`, `cloudbeds.md`,
`csv-and-guest-list.md`, `eventbrite.md`) with prerequisites, setup, and a bundled mock to
try before you have real credentials. See
[`docs/plugins/README.md`](../docs/plugins/README.md#supported-systems) for the full
supported-systems matrix, including PMSs that are documented but not yet shipped as a
recipe.

### The `verified` field

Every catalog entry in `index.json` carries `"verified": "live" | "mock"`:

- **`live`** — the recipe has actually been run against the real vendor's API (even a
  public demo/sandbox), not just a bundled mock.
- **`mock`** — the recipe is built from the vendor's published API docs and tested against
  a bundled mock that mirrors those docs, but has **not** been run against the real
  service. Treat it as a strong starting point: verify with **Test lookup** against your
  own account before relying on it, and please report back anything that doesn't match —
  vendor APIs occasionally vary by account/version.

Each recipe's own `description` field, and its doc page, restate this plainly.

## Pointing Tikspot at a different catalog

Settings → *Guest lookup plugins* → **Plugin catalog URL** accepts:

- a catalog `index.json` (raw or `blob` GitHub URL, or any HTTPS host),
- a GitHub **folder** URL such as `https://github.com/<you>/<repo>/tree/main/plugins`
  (uses the GitHub contents API; an `index.json` there is used if present, otherwise every
  `*.json` that is a Tikspot plugin export is listed),
- a single exported plugin file.

The container fetches the catalog itself, so it needs outbound internet (a srcnat
masquerade for its subnet — *Router setup → Verify* flags a missing one) and DNS.

## Contributing a recipe

1. Build and test it in your Tikspot admin, then **Export** it (secrets are stripped).
2. Save the file here as `<vendor-or-system>-<flavour>.json` (keep `"enabled": false`).
3. Add an entry to `index.json`:
   ```json
   {
     "id": "acme-pms-json",
     "name": "Acme PMS (JSON)",
     "description": "One or two sentences: what system, which inputs, any quirks.",
     "author": "your name or handle",
     "file": "acme-pms-json.json",
     "tags": ["hotel", "json", "token-auth"],
     "requires": "Acme PMS ≥ 4.2 with the guest-search API enabled",
     "parser": "json",
     "inputs": ["room", "name"]
   }
   ```
4. Open a pull request. Never include real credentials, hostnames of production systems,
   or guest data in the recipe or its description.

`file` may also be an absolute URL if the recipe lives elsewhere.
