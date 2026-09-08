// Plugin catalog: discover community recipes published on GitHub (or any HTTP
// host) and import them. A "source" is either
//   • a catalog index file  — JSON { format:'tikspot-plugin-catalog', plugins:[...] }
//   • a folder              — every *.json in it that is a tikspot-plugin export
// Given a GitHub web URL (blob/tree), a raw URL or the contents-API URL we
// normalise to something fetchable. Pure helpers here; the network + DB glue
// lives in admin/plugins.js. Recipes from a catalog are imported DISABLED with
// secrets empty — the admin reviews and fills them in before enabling.

export const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/omegatron/tinkernet-tikspot/main/plugins/index.json';

const GH_WEB = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/(blob|tree)\/([^/]+)\/?(.*)$/;
const GH_RAW = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/;
const GH_API = /^https?:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/?([^?]*)(?:\?ref=([^&]+))?$/;

/**
 * Classify a source URL. Returns { kind:'index'|'folder'|'file', fetchUrl, gh? }.
 * - GitHub tree URL  -> folder via the contents API
 * - GitHub blob/raw URL ending in .json -> index (or single file)
 * - anything else ending in .json -> index; otherwise folder (contents API only for GitHub)
 */
export function resolveSource(input) {
  const s = String(input || '').trim();
  if (!s) return { ok: false, error: 'catalog URL is empty' };
  if (!/^https?:\/\//i.test(s)) return { ok: false, error: 'catalog URL must start with http(s)://' };
  let m;
  if ((m = s.match(GH_WEB))) {
    const [, owner, repo, kind, ref, path] = m;
    if (kind === 'tree') {
      return { ok: true, kind: 'folder', fetchUrl: `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, gh: { owner, repo, ref, path } };
    }
    return { ok: true, kind: path.endsWith('.json') ? 'index' : 'file', fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, gh: { owner, repo, ref, path } };
  }
  if ((m = s.match(GH_RAW))) {
    const [, owner, repo, ref, path] = m;
    return { ok: true, kind: path.endsWith('.json') ? 'index' : 'file', fetchUrl: s, gh: { owner, repo, ref, path } };
  }
  if ((m = s.match(GH_API))) {
    const [, owner, repo, path, ref] = m;
    return { ok: true, kind: 'folder', fetchUrl: s, gh: { owner, repo, ref: ref || 'main', path: path || '' } };
  }
  return { ok: true, kind: s.replace(/[?#].*$/, '').endsWith('.json') ? 'index' : 'folder', fetchUrl: s, gh: null };
}

// Resolve a relative `file` from a catalog index against the index's own URL.
export function resolveRelative(baseUrl, file) {
  try {
    return new URL(file, baseUrl).toString();
  } catch {
    return null;
  }
}

function summarizeRecipe(recipe) {
  return {
    name: recipe?.name || '(unnamed)',
    parser: recipe?.parse?.type || null,
    inputs: Array.isArray(recipe?.inputs) ? recipe.inputs.map((i) => i.name) : [],
    hasAuth: Boolean(recipe?.auth),
    hasWindow: Boolean(recipe?.window),
  };
}

/**
 * Turn a fetched catalog index (already JSON-parsed) into the list the UI shows.
 * Each entry gets an absolute `url` for import. Unknown shapes are rejected.
 */
export function parseCatalogIndex(json, indexUrl) {
  if (!json || typeof json !== 'object') return { ok: false, error: 'catalog is not a JSON object' };
  if (json.format !== 'tikspot-plugin-catalog' || !Array.isArray(json.plugins)) {
    // Allow a bare tikspot-plugin export to be "a catalog of one".
    if (json.format === 'tikspot-plugin' && json.recipe) {
      return { ok: true, plugins: [{ id: json.recipe.name || 'plugin', url: indexUrl, ...summarizeRecipe(json.recipe), description: '', tags: [] }] };
    }
    return { ok: false, error: 'not a tikspot-plugin-catalog (expected {format:"tikspot-plugin-catalog", plugins:[...]})' };
  }
  const plugins = [];
  for (const p of json.plugins.slice(0, 200)) {
    if (!p || typeof p !== 'object' || !p.file) continue;
    const url = resolveRelative(indexUrl, String(p.file));
    if (!url) continue;
    plugins.push({
      id: String(p.id || p.file),
      name: String(p.name || p.id || p.file),
      description: String(p.description || ''),
      author: p.author ? String(p.author) : '',
      tags: Array.isArray(p.tags) ? p.tags.map(String).slice(0, 12) : [],
      requires: p.requires ? String(p.requires) : '',
      parser: p.parser ? String(p.parser) : null,
      inputs: Array.isArray(p.inputs) ? p.inputs.map(String) : [],
      url,
    });
  }
  return { ok: true, plugins, updated: json.updated || null, catalogVersion: json.version || null };
}

/**
 * Turn a GitHub contents-API folder listing into candidate files (name, download
 * url). Only *.json files; index.json is honoured if present (caller decides).
 */
export function parseGithubFolder(json) {
  if (!Array.isArray(json)) return { ok: false, error: 'folder listing is not an array (is the URL a folder?)' };
  const files = json
    .filter((e) => e && e.type === 'file' && /\.json$/i.test(String(e.name)) && e.download_url)
    .map((e) => ({ name: String(e.name), url: String(e.download_url), size: Number(e.size) || 0 }))
    .slice(0, 50);
  return { ok: true, files, hasIndex: files.some((f) => f.name.toLowerCase() === 'index.json') };
}

// A fetched plugin file must be a tikspot-plugin export (or a bare recipe).
export function extractRecipe(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.format === 'tikspot-plugin' && json.recipe && typeof json.recipe === 'object') return json.recipe;
  if (json.request && json.parse && Array.isArray(json.inputs)) return json; // bare recipe
  return null;
}

export { summarizeRecipe };
