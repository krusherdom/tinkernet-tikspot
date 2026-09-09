# CSV / Google Sheet, and the built-in guest list

Not every venue runs a PMS with an API. If your guest list already lives in a
spreadsheet — a wedding, a short-term rental, a small B&B, a one-off event — Tikspot has
two ways to use it directly, no API integration required:

1. **`csv-url.json`** — a catalog recipe that fetches a CSV over HTTP on every lookup
   (e.g. a Google Sheet "published to web"). Covered below.
2. **The built-in guest list** (`source: "list"`) — paste or upload a CSV directly into
   the plugin in the admin; Tikspot stores the rows itself and looks guests up against
   its own copy, no external URL involved. See [**The built-in guest
   list**](#the-built-in-guest-list) below.

Both use the same column names and the same match/window rules — pick whichever fits: a
live Google Sheet your front desk keeps editing (option 1), or a one-time upload for an
event that doesn't change (option 2, or either, really — option 2 also supports
replacing the list later).

> **Status: verified mock.** `csv-url.json` is tested end to end against a bundled static
> file server (`examples/csv-guest-list/`). It has no vendor API to diverge from — any
> URL serving well-formed CSV works — so there's little "live vs. mock" distinction here;
> "mock" just means the milieu tested is a plain file server, not a live Google Sheet.

## `csv-url.json` — CSV over HTTP

### Preparing a Google Sheet

1. In Google Sheets: **File → Share → Publish to web**.
2. Choose the specific sheet/tab with your guest list, and **CSV** as the format (not
   "Web page").
3. Publish, and copy the link — it looks like
   `https://docs.google.com/spreadsheets/d/e/.../pub?output=csv`.
4. Make sure the header row uses the column names below (order doesn't matter).

Any other URL serving plain `text/csv` (a static file host, a small internal tool) works
the same way — the recipe sends no authentication, so use a link that doesn't require a
login.

### Columns

| Column | Canonical field | Required |
|---|---|---|
| `first_name` | `firstName` | no |
| `last_name` | `lastName` | recommended |
| `room` | `room` | recommended |
| `email` | `email` | no |
| `mobile` | `mobile` | no |
| `check_in` | `checkIn` | for the stay window |
| `check_out` | `checkOut` | for the stay window |

Dates are read as `YYYY-MM-DD` (`dateFormat: "ymd"`).

### Installing

1. **Admin → Guest lookup → Browse catalog**, import **CSV / Google Sheet guest list**.
   It arrives **disabled**.
2. Under **Parameters**, set **CSV URL** to your published sheet/file link.
3. **Test lookup** with a room and last name from your sheet.
4. Add a **Guest lookup** block to your portal page, then **enable** it.

### Trying it against the bundled mock first

`examples/csv-guest-list/` has a fictional `guests.csv` and a zero-dependency static file
server (`serve.js`). Run `npm run csv-guest-list` from the repo root (`node:http`, no
TLS, port 8092), then set **CSV URL** to `http://<your LAN IP>:8092/guests.csv` and test
with room `12` and last name `O'Neill`.

### Inputs

| Input | Required | Notes |
|---|---|---|
| Room / site number | yes | matched with `normalize: "digits"` |
| Last name | no | |
| Email | no | |
| Mobile number | no | |

`minRules: 2` — room alone is never enough; at least one of last name / email / mobile
must also match.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| "The guest list could not be loaded" | The URL isn't reachable from the container, isn't actually CSV (check it isn't an HTML "you don't have access" page), or requires a login. Fetch the URL yourself first. |
| No-match on a row you can see | Check the header row's column names exactly match those above (case-insensitive is fine, but spelling must match) — a `Room #` column, say, won't auto-map to `room`. |
| Correct guest, but "stay not active" | Check the `check_in`/`check_out` values are `YYYY-MM-DD` and actually bracket today; the 24-hour leeway absorbs the rest. |
| Quoted fields with commas look wrong | The CSV parser is RFC-4180-ish (quoted fields, doubled `""` quotes, embedded commas/newlines inside quotes) — if your spreadsheet export uses a different quoting convention, open **Test lookup**'s raw-response view to see exactly what was parsed. |

## The built-in guest list

For a guest list that doesn't need to live anywhere else — no spreadsheet URL, no server
— create a plugin with **Source: Built-in guest list** in the admin instead of the usual
"Guest system over HTTP". There's no Authentication, Request or Parser card for this
kind: just a **Guest list** card where you paste CSV text (first row = column names) or
choose a file, see a row count and a 5-row sample, and **Replace list**. Tikspot stores
the rows itself (in its own database, not re-fetched from anywhere), so a lookup never
needs outbound network access at all.

The same column names as above map automatically; **Match rules**, **Stay window**,
**Guest inputs** and **Messages** all work exactly like an HTTP recipe — pick the columns
you want to match on the same way.

Use this when:

- You don't want to stand up or maintain a published spreadsheet link.
- The guest list is fixed for the duration of an event and you'd rather upload it once.
- You want Tikspot itself to hold the only copy (no third-party sheet host in the loop).

Use `csv-url.json` instead when your source of truth keeps changing and you want every
lookup to see the latest version live, without re-uploading.

## Limits and caveats

- `csv-url.json` sends no authentication and follows normal HTTP redirects — don't use it
  for a URL that returns sensitive data to unauthenticated callers beyond your guest list
  itself.
- The built-in guest list caps at 5000 rows per plugin and a 2 MB upload per replace.
- Both are capped by the recipe's own `maxRecords` (2000 for `csv-url.json`) — a much
  larger guest list should be trimmed to just the current stay period before uploading.
