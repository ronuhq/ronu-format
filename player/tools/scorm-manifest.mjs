// The SCORM 1.2 package, minus the file system: the manifest XML, the
// launcher page, the list of player files a package carries, and the
// assembly of a package's entries from a `.ronu` and a file reader. No DOM,
// no zip: `scorm-package.mjs` adds the reading and the zipping, and the tests
// call these directly.

/** The player runtime a package carries: the page, the modules, the styles, the vendored unzip and the icons. Never tests, tools, the service worker or the PWA manifest. */
export const PLAYER_FILES = [
  'index.html', 'app.css', 'app.js', 'ui.js', 'engine.js', 'conditions.js', 'formula.js', 'bundle.js', 'session.js',
  'receiver.js', 'receiver-ui.js', 'conversation.js', 'store.js', 'scorm.js', 'pano.js', 'sanitize.js',
  'vendor/fflate.js', 'vendor/LICENSE-fflate', 'icons/icon-192.png', 'icons/icon-512.png',
];

/** The SCORM 1.2 schema control files that go at the package root beside imsmanifest.xml. */
export const XSD_FILES = ['ims_xml.xsd', 'imscp_rootv1p1p2.xsd', 'imsmd_rootv1p2p1.xsd', 'adlcp_rootv1p2.xsd'];

export const LAUNCH_FILE = 'launch.html';
export const MODULE_FILE = 'module.ronu';

export function escapeXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

/** An XML Name-safe identifier: letters, digits, dots, dashes, underscores; never starting with a digit, dot or dash. */
export function slugIdentifier(s, fallback = 'ronu-module') {
  let out = String(s ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!out) out = fallback;
  if (/^[0-9.-]/.test(out)) out = `ronu-${out}`;
  return out;
}

/**
 * The imsmanifest.xml: one organization, one item, one SCO resource that
 * lists every file in the package. `files` are package-relative paths with
 * forward slashes; the manifest itself is never listed.
 */
export function buildImsManifest({ identifier, title, files, launch = LAUNCH_FILE, version = '1.0' }) {
  if (!identifier) throw new Error('identifier is required');
  if (!files || !files.length) throw new Error('files must list the package members');
  if (!files.includes(launch)) throw new Error(`the launch file ${launch} must be among the files`);
  const id = slugIdentifier(identifier);
  const orgId = `${id}-org`;
  const itemId = `${id}-item`;
  const resId = `${id}-res`;
  const fileLines = [...new Set(files)].filter((f) => f !== 'imsmanifest.xml').sort().map((f) => `      <file href="${escapeXml(f)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${escapeXml(id)}" version="${escapeXml(version)}"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${escapeXml(orgId)}">
    <organization identifier="${escapeXml(orgId)}">
      <title>${escapeXml(title)}</title>
      <item identifier="${escapeXml(itemId)}" identifierref="${escapeXml(resId)}">
        <title>${escapeXml(title)}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="${escapeXml(resId)}" type="webcontent" adlcp:scormtype="sco" href="${escapeXml(launch)}">
${fileLines}
    </resource>
  </resources>
</manifest>
`;
}

/**
 * The launcher: the page the LMS opens, at the package root. It holds the
 * player in a full-window iframe rather than redirecting to it, so the SCO
 * frame keeps the URL the manifest named (some LMSs key their tracking frame,
 * exit handling and reloads on that href), while the player, one same-origin
 * frame down, still reaches the LMS API by walking `parent`.
 */
export function buildLaunchHtml({ title, playerPath = 'player/index.html', modulePath = MODULE_FILE }) {
  // From player/, the module sits one directory up.
  const src = `${playerPath}?ronu=../${modulePath}&scorm=1`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #1f2733; }
    iframe { display: block; border: 0; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <iframe src="${escapeHtml(src)}" title="${escapeHtml(title)}" allow="fullscreen; autoplay"></iframe>
  <noscript><p style="color:#fff;padding:16px">This course needs JavaScript.</p></noscript>
</body>
</html>
`;
}

/** Title and identifier from a .ronu's manifest.json, with the fallbacks the CLI promises. */
export function describeRonu(manifestJson, { fileName = 'module.ronu', title = null, identifier = null } = {}) {
  let doc = null;
  try {
    doc = manifestJson ? JSON.parse(manifestJson) : null;
  } catch {
    doc = null;
  }
  const mod = doc && typeof doc === 'object' && doc.module && typeof doc.module === 'object' ? doc.module : {};
  const base = fileName.replace(/\.(ronu|zip)$/i, '');
  const outTitle = title || (typeof mod.title === 'string' && mod.title.trim() ? mod.title.trim() : base);
  const outId = slugIdentifier(identifier || (typeof mod.familyId === 'string' && mod.familyId ? `ronu-${mod.familyId}` : base));
  return { title: outTitle, identifier: outId, familyId: typeof mod.familyId === 'string' ? mod.familyId : null };
}

/**
 * Every entry of the package, as `{ path: Uint8Array }`.
 * @param {object} o
 * @param {Uint8Array} o.ronuBytes         the .ronu file
 * @param {string} o.manifestJson          the .ronu's manifest.json text (or null)
 * @param {(relPath: string) => Uint8Array} o.readPlayerFile   reads a file under player/
 * @param {(name: string) => Uint8Array} [o.readXsd]           reads a schema file; omit to skip the XSDs
 */
export function buildPackageEntries({ ronuBytes, manifestJson, fileName = 'module.ronu', title = null, identifier = null, readPlayerFile, readXsd = null }) {
  const info = describeRonu(manifestJson, { fileName, title, identifier });
  const entries = {};
  const enc = (s) => new TextEncoder().encode(s);
  for (const rel of PLAYER_FILES) entries[`player/${rel}`] = readPlayerFile(rel);
  entries[MODULE_FILE] = ronuBytes;
  entries[LAUNCH_FILE] = enc(buildLaunchHtml({ title: info.title }));
  if (readXsd) for (const x of XSD_FILES) entries[x] = readXsd(x);
  const files = Object.keys(entries);
  entries['imsmanifest.xml'] = enc(buildImsManifest({ identifier: info.identifier, title: info.title, files }));
  return { entries, ...info };
}
