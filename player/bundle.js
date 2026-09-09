// Container handling (spec section 2): unzip a .ronu, read manifest.json and
// module.json, and resolve media references (spec section 8) to URLs.
//
// No DOM. The unzip function and the URL factory are injected so the same
// code runs in the browser (fflate global + Blob URLs) and in Node tests.

const utf8 = new TextDecoder('utf-8');

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  vtt: 'text/vtt', srt: 'text/plain', pdf: 'application/pdf', json: 'application/json', txt: 'text/plain',
};

export function mimeFor(path, manifest) {
  const listed = manifest?.assets?.find?.((a) => a && a.path === path);
  if (listed?.mimeType) return listed.mimeType;
  const ext = String(path).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function parseJson(bytes, name) {
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new Error(`${name} is not UTF-8`);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new Error(`${name} is not valid JSON: ${e.message}`);
  }
}

/**
 * Open a .ronu (zip bytes). `unzip` is fflate's `unzipSync`.
 * Returns `{ manifest, module, assets: Map<path, Uint8Array>, name }`.
 */
export function openBundle(bytes, { unzip, name = 'module.ronu' } = {}) {
  if (typeof unzip !== 'function') throw new Error('openBundle needs an unzip function');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let entries;
  try {
    entries = unzip(data);
  } catch (e) {
    throw new Error(`Not a .ronu zip: ${e.message ?? e}`);
  }
  // Tolerate a zip made from a folder (everything under one directory) and macOS junk.
  const paths = Object.keys(entries).filter((p) => !p.startsWith('__MACOSX/') && !p.endsWith('/') && !p.split('/').pop().startsWith('.'));
  let prefix = '';
  if (!paths.includes('manifest.json') || !paths.includes('module.json')) {
    const candidate = paths.find((p) => p.endsWith('/module.json'));
    if (candidate) prefix = candidate.slice(0, -'module.json'.length);
  }
  const get = (p) => entries[prefix + p];
  const moduleBytes = get('module.json');
  if (!moduleBytes) throw new Error('The zip has no module.json (spec section 2)');
  const manifestBytes = get('manifest.json');
  const module = parseJson(moduleBytes, 'module.json');
  const manifest = manifestBytes ? parseJson(manifestBytes, 'manifest.json') : synthesizeManifest(module, name);
  const assets = new Map();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (rel === 'module.json' || rel === 'manifest.json') continue;
    assets.set(rel, entries[p]);
  }
  return { manifest, module, assets, name };
}

/** The JSON-only interchange form (spec section 2): a bare module.json. */
export function openModuleJson(text, { name = 'module.json' } = {}) {
  const module = typeof text === 'string' ? parseJson(new TextEncoder().encode(text), name) : text;
  if (!module || typeof module !== 'object' || !Array.isArray(module.nodes)) throw new Error('module.json must contain a nodes array');
  return { manifest: synthesizeManifest(module, name), module, assets: new Map(), name };
}

function synthesizeManifest(module, name) {
  const start = module.nodes?.find?.((n) => n?.config?.isStart) ?? module.nodes?.[0];
  return {
    format: 'ronu',
    formatVersion: '0.9',
    module: { familyId: `local:${name}`, title: start?.config?.title ?? start?.title ?? name },
    activityIri: `urn:ronu:local:${encodeURIComponent(name)}`,
    assets: [],
    synthesized: true,
  };
}

/** Basic envelope checks (spec section 3). Returns a list of problems; empty means fine. */
export function checkManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest.json is missing'];
  if (manifest.format !== 'ronu') problems.push(`manifest.format is "${manifest.format}", expected "ronu"`);
  const major = String(manifest.formatVersion ?? '').split('.')[0];
  if (major !== '0' && major !== '1') problems.push(`formatVersion ${manifest.formatVersion} is a major version this player does not know`);
  if (!manifest.module?.familyId) problems.push('manifest.module.familyId is required');
  if (!manifest.module?.title) problems.push('manifest.module.title is required');
  return problems;
}

export function bundleTitle(bundle) {
  return bundle?.manifest?.module?.title || bundle?.name || 'Untitled';
}

/**
 * Media reference resolver (spec section 8). Bundle paths (`assets/...`)
 * become URLs made by `makeUrl(bytes, mime, path)`; absolute http(s), data:
 * and blob: references pass through unchanged (playable online only);
 * anything else (platform storage refs) resolves to null.
 */
export function createResolver(bundle, { makeUrl, revokeUrl } = {}) {
  const cache = new Map();
  const make = makeUrl ?? ((bytes, mime, path) => `asset:${path}`);
  function resolve(ref) {
    if (typeof ref !== 'string') return null;
    const s = ref.trim();
    if (s === '') return null;
    if (/^(data:|blob:)/i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return `https:${s}`;
    let rel = s.replace(/^\.?\//, '');
    const candidates = [rel];
    try {
      candidates.push(decodeURIComponent(rel));
    } catch {
      /* keep raw */
    }
    for (const c of candidates) {
      if (bundle.assets.has(c)) {
        if (!cache.has(c)) cache.set(c, make(bundle.assets.get(c), mimeFor(c, bundle.manifest), c));
        return cache.get(c);
      }
    }
    return null;
  }
  function revoke() {
    if (revokeUrl) for (const url of cache.values()) revokeUrl(url);
    cache.clear();
  }
  return { resolve, revoke, isBundled: (ref) => typeof ref === 'string' && bundle.assets.has(ref.replace(/^\.?\//, '')) };
}
