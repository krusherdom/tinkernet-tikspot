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

// parseResponse(recipe.parse, bodyText) -> { records: [{...}], raw }
// `raw` is the value found at `parse.root` (before being normalised to an
// array), useful for debugging/admin preview.
export function parseResponse(parse, bodyText) {
  const type = parse && parse.type;
  if (type === 'xml') return parseXml(parse, bodyText);
  if (type === 'regex') return parseRegex(parse, bodyText);
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
