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

The three demos target `examples/guest-api/` (run `npm run guest-api` on a machine the
router's container can reach, then change the recipe's host to that machine's LAN IP).

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
