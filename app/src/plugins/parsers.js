// Response parsing for the guest-lookup engine: turns a JSON/XML/text HTTP
// response body into an array of plain records keyed by canonical (or
// recipe-custom) field names, plus a `parseDate` helper for the various
// stay-window date formats recipes can declare.

import { XMLParser } from 'fast-xml-parser';

// getPath(obj, 'a.b[0].c') / getPath(obj, 'a.b[*].c')
//   - dot-separated keys walk plain objects
//   - `[n]` indexes into an array
//   - `[*]` fans out over an array (or the values of a plain object) —
//     once a wildcard is hit, the result becomes an array (flattened one
//     level per wildcard)
//   - '' or null/undefined path returns `obj` unchanged
export function getPath(obj, path) {
  if (path === '' || path == null) return obj;
  const tokens = String(path)
    .replace(/\[(\d+|\*)\]/g, '.$1')
    .split('.')
    .filter((t) => t !== '');
  return walk(obj, tokens);
}

function walk(obj, tokens) {
  if (!tokens.length) return obj;
  const [token, ...rest] = tokens;

  if (token === '*') {
    if (Array.isArray(obj)) {
      return rest.length ? obj.flatMap((item) => walk(item, rest)) : obj;
    }
    if (obj && typeof obj === 'object') {
      const vals = Object.values(obj);
      return rest.length ? vals.flatMap((item) => walk(item, rest)) : vals;
    }
    return [];
  }

  if (/^\d+$/.test(token)) {
    if (!Array.isArray(obj)) return undefined;
    return walk(obj[Number(token)], rest);
  }

  if (obj == null || typeof obj !== 'object') return undefined;
  return walk(obj[token], rest);
}

function toRecordArray(root) {
  if (root === undefined || root === null) return [];
  if (Array.isArray(root)) return root;
  if (typeof root === 'object') return [root];
  return [];
}

// A field value extracted via a wildcard path comes back as an array —
// records want scalars, so take the first element.
function pickScalar(v) {
  return Array.isArray(v) ? (v.length ? v[0] : undefined) : v;
}

function mapFields(rawRecord, fieldsMap) {
  const record = {};
  for (const [canonical, path] of Object.entries(fieldsMap || {})) {
    record[canonical] = pickScalar(getPath(rawRecord, path));
  }
  return record;
}

// parseTagValue/parseAttributeValue: false keeps every value as the literal
// string from the document — a room "007" or a leading-zero postcode should
// never silently become a number.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  parseAttributeValue: false,
});

// parseResponse(recipe.parse, bodyText, opts) -> { records: [{...}], raw }
// `raw` is the value found at `parse.root` (before being normalised to an
// array), useful for debugging/admin preview. `opts.maxRecords`, when given,
// is honoured by the csv parser only (stops tokenizing once enough data rows
// are seen, so a huge guest-list export doesn't get fully materialised in
// memory just to be sliced afterwards) — json/xml/regex are unaffected and
// keep relying on the engine's own post-parse `maxRecords` slice.
export function parseResponse(parse, bodyText, opts = {}) {
  const type = parse && parse.type;
  if (type === 'xml') return parseXml(parse, bodyText);
  if (type === 'regex') return parseRegex(parse, bodyText);
  if (type === 'csv') return parseCsvResponse(parse, bodyText, opts);
  return parseJson(parse, bodyText);
}

function parseJson(parse, bodyText) {
  const parsed = bodyText ? JSON.parse(bodyText) : null;
  const root = getPath(parsed, (parse && parse.root) || '');
  const records = toRecordArray(root).map((r) => mapFields(r, parse && parse.fields));
  return { records, raw: root };
}

function parseXml(parse, bodyText) {
  const parsed = bodyText ? xmlParser.parse(bodyText) : {};
  const root = getPath(parsed, (parse && parse.root) || '');
  const records = toRecordArray(root).map((r) => mapFields(r, parse && parse.fields));
  return { records, raw: root };
}

function parseRegex(parse, bodyText) {
  const text = bodyText || '';
  const recordRegexSrc = (parse && parse.recordRegex) || '';
  const fieldsMap = (parse && parse.fields) || {};

  if (recordRegexSrc) {
    // One match per record; named capture groups map to canonical fields.
    const re = new RegExp(recordRegexSrc, 'g');
    const records = [];
    for (const m of text.matchAll(re)) {
      const groups = m.groups || {};
      const record = {};
      for (const [canonical, groupName] of Object.entries(fieldsMap)) {
        record[canonical] = groups[groupName];
      }
      records.push(record);
    }
    return { records, raw: text };
  }

  // No record separator: the whole body is a single record, and each
  // `fields[x]` is its own regex whose first capture group is the value.
  const record = {};
  for (const [canonical, pattern] of Object.entries(fieldsMap)) {
    if (!pattern) {
      record[canonical] = undefined;
      continue;
    }
    const m = new RegExp(pattern).exec(text);
    record[canonical] = m ? m[1] : undefined;
  }
  return { records: [record], raw: text };
}

// ---------------------------------------------------------------------------
// CSV (0.16): parse.type: 'csv', and the built-in guest-list source's admin
// upload (PUT /api/plugins/:id/list). RFC-4180-ish: quoted fields (a `"` only
// opens quoting at the START of a field — a bare quote mid-field, e.g.
// `12"A`, is literal), doubled quotes inside a quoted field, embedded
// delimiters/newlines inside quotes, CRLF or LF line endings, an optional
// leading UTF-8 BOM stripped before parsing.

const CSV_DELIMITERS = [',', ';', '\t', 'auto'];

// Admins typing into a plain text field can't produce a literal tab
// character, so accept the two-char escape `'\t'` as an alias for a real tab.
function normalizeDelimiter(d) {
  if (d === '\\t') return '\t';
  return CSV_DELIMITERS.includes(d) ? d : ',';
}

function sniffDelimiter(text) {
  const firstLine = (text || '').split(/\r\n|\r|\n/)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  let best = ',';
  let bestCount = -1;
  for (const [d, c] of Object.entries(counts)) {
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

// Tokenizes raw CSV text into rows of raw string cells (no header handling).
// `rowCap`, when finite, stops scanning once that many rows (including a
// header row, if any — the caller passes the right count) have been
// produced.
function tokenizeCsv(text, delimiter, quote, rowCap) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === quote) {
        if (text[i + 1] === quote) {
          field += quote;
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    // A quote only opens quoting at the very start of a field — a bare quote
    // mid-field (`12"A`) is literal, not a syntax error.
    if (ch === quote && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += 1;
      if (Number.isFinite(rowCap) && rows.length >= rowCap) return rows;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// parseCsv(text, opts) -> { headers, rows }
//   opts.delimiter  ',' (default) | ';' | '\t' | '\\t' | 'auto'
//   opts.header     default true — first row is column names
//   opts.skipEmpty  default true — drop fully-blank lines
//   opts.quote      default '"' (single character)
//   opts.maxRows    optional cap on DATA rows returned (stops tokenizing early)
// `headers` is the column-name list (or `#0`, `#1`, ... when `header:false`).
// `rows` is an array of plain objects keyed by `headers`. Exported for reuse
// by the built-in guest-list source's admin upload endpoint.
export function parseCsv(text, opts = {}) {
  const quote = typeof opts.quote === 'string' && opts.quote.length === 1 ? opts.quote : '"';
  let s = text || '';
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  let delimiter = normalizeDelimiter(opts.delimiter);
  if (delimiter === 'auto') delimiter = sniffDelimiter(s);

  const header = opts.header === undefined ? true : !!opts.header;
  const skipEmpty = opts.skipEmpty === undefined ? true : !!opts.skipEmpty;
  const maxRows = Number.isFinite(opts.maxRows) && opts.maxRows >= 0 ? opts.maxRows : Infinity;
  const rowCap = Number.isFinite(maxRows) ? maxRows + (header ? 1 : 0) : Infinity;

  let table = tokenizeCsv(s, delimiter, quote, rowCap);
  if (skipEmpty) table = table.filter((row) => !(row.length === 1 && row[0].trim() === ''));

  let headers;
  let dataRows;
  if (header) {
    headers = (table[0] || []).map((h) => h.trim());
    dataRows = table.slice(1);
  } else {
    const width = table.reduce((m, r) => Math.max(m, r.length), 0);
    headers = Array.from({ length: width }, (_, i) => `#${i}`);
    dataRows = table;
  }
  if (Number.isFinite(maxRows)) dataRows = dataRows.slice(0, maxRows);

  const rows = dataRows.map((cells) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] !== undefined ? cells[i] : '';
    });
    return obj;
  });

  return { headers, rows };
}

// mapCsvFields(row, headers, fieldsMap) -> { canonicalOrCustomName: value }
// `fieldsMap` values are column names (case-insensitive match against
// `headers`) or `#<index>` (0-based, always valid since `header:false` rows
// are themselves keyed `#0`, `#1`, ...). An empty/absent fieldsMap passes the
// row through as-is (columns used verbatim) — used by both the csv parser
// and the built-in guest-list source (engine.js).
export function mapCsvFields(row, headers, fieldsMap) {
  if (!fieldsMap || !Object.keys(fieldsMap).length) return { ...row };
  const lowerToActual = {};
  for (const h of headers || Object.keys(row)) lowerToActual[String(h).toLowerCase()] = h;
  const out = {};
  for (const [canonical, spec] of Object.entries(fieldsMap)) {
    if (typeof spec !== 'string') {
      out[canonical] = undefined;
      continue;
    }
    const idxMatch = /^#(\d+)$/.exec(spec);
    if (idxMatch) {
      const h = (headers || [])[Number(idxMatch[1])];
      out[canonical] = h !== undefined ? row[h] : undefined;
      continue;
    }
    const actual = lowerToActual[spec.toLowerCase()];
    out[canonical] = actual !== undefined ? row[actual] : undefined;
  }
  return out;
}

function parseCsvResponse(parse, bodyText, opts = {}) {
  const { headers, rows } = parseCsv(bodyText || '', {
    delimiter: parse && parse.delimiter,
    header: parse ? parse.header : undefined,
    skipEmpty: parse ? parse.skipEmpty : undefined,
    quote: parse && parse.quote,
    maxRows: opts && opts.maxRecords,
  });
  const fieldsMap = (parse && parse.fields) || {};
  const records = rows.map((row) => mapCsvFields(row, headers, fieldsMap));
  return { records, raw: rows };
}

// parseDate(value, dateFormat) -> epoch ms, or null if unparseable/absent.
// Date-only formats (dmy/mdy/ymd) are treated as local-midnight-UTC (i.e.
// Date.UTC), so a stay window compares consistently regardless of the
// server's own timezone.
export function parseDate(value, dateFormat) {
  if (value === undefined || value === null || value === '') return null;
  const format = dateFormat || 'iso';

  if (format === 'epoch') {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    // Heuristic: anything under ~ year 2001 in ms is almost certainly seconds.
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  const s = String(value).trim();

  if (format === 'iso') {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }

  if (format === 'dmy') {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
    if (!m) return null;
    return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  }

  if (format === 'mdy') {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
    if (!m) return null;
    return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  }

  if (format === 'ymd') {
    const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s);
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  // 'sql': `YYYY-MM-DD HH:MM:SS` (also accepts a bare `YYYY-MM-DD`),
  // always interpreted as UTC — used for guest systems (e.g. RMS Cloud) that
  // return property-local wall-clock times without an offset; the window's
  // leeway absorbs the difference.
  if (format === 'sql') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(s);
    if (!m) return null;
    const [, y, mo, d, h, mi, se] = m;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0), Number(se || 0));
  }

  return null;
}
