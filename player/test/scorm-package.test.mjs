// The SCORM 1.2 package: the manifest XML (well-formed, every file listed,
// escaped), the launcher, and a build of hello.ronu unzipped back and checked
// file by file against the manifest it carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { buildImsManifest, buildLaunchHtml, buildPackageEntries, describeRonu, escapeXml, slugIdentifier, PLAYER_FILES, XSD_FILES } from '../tools/scorm-manifest.mjs';
import { packageRonu, parseArgs } from '../tools/scorm-package.mjs';
import { fflate, SAMPLES_DIR, PLAYER_DIR } from './helpers.mjs';

const HELLO = join(SAMPLES_DIR, 'hello-ronu', 'hello.ronu');

/** A small well-formedness check without an XML parser: balanced tags, one root, no bare ampersands. */
function assertWellFormed(xml) {
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<manifest /);
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(xml), 'no unescaped ampersand');
  assert.ok(!/<[^>]*<|>[^<]*>[^<]*>/.test(xml.replace(/>\s*</g, '><').replace(/<[^>]+>/g, (t) => (t.endsWith('/>') ? '' : t)).replace(/[^<>]+/g, '')), 'no stray angle brackets');
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[0].startsWith('<?')) continue;
    if (m[3] === '/') continue;
    if (m[1] === '/') assert.equal(stack.pop(), m[2], `closing ${m[2]} matches`);
    else stack.push(m[2]);
  }
  assert.deepEqual(stack, [], 'every tag closed');
}

test('buildImsManifest: SCORM 1.2 skeleton, one org, one sco item, every file listed once, escaped title', () => {
  const files = ['launch.html', 'module.ronu', 'player/app.js', 'player/index.html', 'launch.html'];
  const xml = buildImsManifest({ identifier: 'ronu-abc', title: 'Tom & Jerry <"quoted"> \'s', files });
  assertWellFormed(xml);
  assert.match(xml, /<manifest identifier="ronu-abc" version="1\.0"/);
  assert.match(xml, /xmlns="http:\/\/www\.imsproject\.org\/xsd\/imscp_rootv1p1p2"/);
  assert.match(xml, /xmlns:adlcp="http:\/\/www\.adlnet\.org\/xsd\/adlcp_rootv1p2"/);
  assert.match(xml, /xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/);
  assert.match(xml, /xsi:schemaLocation="[^"]*adlcp_rootv1p2\.xsd"/);
  assert.match(xml, /<metadata>\s*<schema>ADL SCORM<\/schema>\s*<schemaversion>1\.2<\/schemaversion>\s*<\/metadata>/);
  assert.match(xml, /<organizations default="ronu-abc-org">\s*<organization identifier="ronu-abc-org">/);
  assert.match(xml, /<item identifier="ronu-abc-item" identifierref="ronu-abc-res">/);
  assert.match(xml, /<resource identifier="ronu-abc-res" type="webcontent" adlcp:scormtype="sco" href="launch.html">/);
  assert.equal((xml.match(/<title>Tom &amp; Jerry &lt;&quot;quoted&quot;&gt; &apos;s<\/title>/g) ?? []).length, 2, 'organization and item titles, escaped');
  const hrefs = [...xml.matchAll(/<file href="([^"]+)"\/>/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ['launch.html', 'module.ronu', 'player/app.js', 'player/index.html'], 'sorted, deduplicated');
  assert.throws(() => buildImsManifest({ identifier: 'x', title: 't', files: ['module.ronu'] }), /launch file/);
  assert.throws(() => buildImsManifest({ identifier: '', title: 't', files: ['launch.html'] }), /identifier/);
});

test('escapeXml and slugIdentifier', () => {
  assert.equal(escapeXml('a<b>&"c"\'d'), 'a&lt;b&gt;&amp;&quot;c&quot;&apos;d');
  assert.equal(slugIdentifier('Hello, .ronu!'), 'Hello-.ronu');
  assert.equal(slugIdentifier('123abc'), 'ronu-123abc', 'an XML Name cannot start with a digit');
  assert.equal(slugIdentifier('   '), 'ronu-module');
  assert.equal(slugIdentifier('ronu-a0000000-0000-4000-8000-000000000001'), 'ronu-a0000000-0000-4000-8000-000000000001');
});

test('describeRonu: title and identifier from manifest.json, with the filename and slug fallbacks', () => {
  const manifest = JSON.stringify({ module: { title: 'Hello, .ronu', familyId: 'a0000000-0000-4000-8000-000000000001' } });
  assert.deepEqual(describeRonu(manifest, { fileName: 'hello.ronu' }), { title: 'Hello, .ronu', identifier: 'ronu-a0000000-0000-4000-8000-000000000001', familyId: 'a0000000-0000-4000-8000-000000000001' });
  assert.deepEqual(describeRonu(null, { fileName: 'my module.ronu' }), { title: 'my module', identifier: 'my-module', familyId: null });
  assert.deepEqual(describeRonu('not json', { fileName: 'x.ronu', title: 'Given', identifier: 'given id' }), { title: 'Given', identifier: 'given-id', familyId: null });
});

test('buildLaunchHtml: a full-window iframe at the package root pointing into player/ with scorm=1', () => {
  const html = buildLaunchHtml({ title: 'A & B' });
  assert.match(html, /<title>A &amp; B<\/title>/);
  assert.match(html, /<iframe src="player\/index\.html\?ronu=\.\.\/module\.ronu&amp;scorm=1"/);
  assert.match(html, /allow="fullscreen; autoplay"/);
  assert.ok(!html.includes('location.replace'), 'it frames the player; it does not redirect');
});

test('buildPackageEntries: player files, the .ronu, launch.html, the XSDs and a manifest that lists them all', () => {
  const ronuBytes = new Uint8Array(readFileSync(HELLO));
  const manifestJson = readFileSync(join(SAMPLES_DIR, 'hello-ronu', 'manifest.json'), 'utf8');
  const read = new Set();
  const built = buildPackageEntries({
    ronuBytes, manifestJson, fileName: 'hello.ronu',
    readPlayerFile: (rel) => { read.add(rel); return new Uint8Array([1]); },
    readXsd: (name) => new Uint8Array([2]),
  });
  assert.equal(built.title, 'Hello, .ronu');
  assert.equal(built.identifier, 'ronu-a0000000-0000-4000-8000-000000000001');
  assert.deepEqual([...read].sort(), [...PLAYER_FILES].sort());
  for (const rel of PLAYER_FILES) assert.ok(built.entries[`player/${rel}`], rel);
  for (const x of XSD_FILES) assert.ok(built.entries[x], x);
  assert.equal(built.entries['module.ronu'], ronuBytes);
  const xml = new TextDecoder().decode(built.entries['imsmanifest.xml']);
  const hrefs = [...xml.matchAll(/<file href="([^"]+)"\/>/g)].map((m) => m[1]);
  const expected = Object.keys(built.entries).filter((f) => f !== 'imsmanifest.xml').sort();
  assert.deepEqual(hrefs, expected, 'every packaged file, and only those, is a <file href>');
  assert.ok(!['sw.js', 'manifest.webmanifest'].some((f) => hrefs.includes(`player/${f}`)), 'no service worker, no PWA manifest');
  assert.ok(!hrefs.some((f) => f.startsWith('player/test/') || f.startsWith('player/tools/')));
  // Without an XSD reader the schemas are simply absent.
  const bare = buildPackageEntries({ ronuBytes, manifestJson, readPlayerFile: () => new Uint8Array([1]) });
  for (const x of XSD_FILES) assert.equal(bare.entries[x], undefined);
});

test('round trip: package hello.ronu, unzip with fflate, every listed file exists and the player is inside', () => {
  const { zip, files, title, xsd } = packageRonu(HELLO);
  assert.equal(title, 'Hello, .ronu');
  assert.equal(xsd, true, 'the vendored XSDs are present');
  const entries = fflate.unzipSync(zip);
  const names = Object.keys(entries);
  for (const must of ['imsmanifest.xml', 'launch.html', 'module.ronu', 'player/index.html', 'player/app.js', 'player/scorm.js', 'player/vendor/fflate.js', ...XSD_FILES]) assert.ok(names.includes(must), must);
  assert.deepEqual(names.sort(), files.sort());
  const xml = new TextDecoder().decode(entries['imsmanifest.xml']);
  assertWellFormed(xml);
  const hrefs = [...xml.matchAll(/<file href="([^"]+)"\/>/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 20);
  for (const href of hrefs) assert.ok(names.includes(href), `${href} listed in the manifest is in the zip`);
  for (const name of names) if (name !== 'imsmanifest.xml') assert.ok(hrefs.includes(name), `${name} in the zip is listed`);
  // The bundled .ronu is byte-identical, and the player files are the repository's.
  assert.deepEqual(Buffer.from(entries['module.ronu']), readFileSync(HELLO));
  assert.equal(new TextDecoder().decode(entries['player/app.js']), readFileSync(join(PLAYER_DIR, 'app.js'), 'utf8'));
  // The .ronu inside is itself a zip that opens.
  const inner = fflate.unzipSync(entries['module.ronu']);
  assert.ok(inner['module.json'] && inner['manifest.json']);
  assert.match(new TextDecoder().decode(entries['launch.html']), /scorm=1/);
  assert.ok(existsSync(join(PLAYER_DIR, 'tools', 'scorm-xsd', 'adlcp_rootv1p2.xsd')));
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['a.ronu', '--title', 'T', '--out', 'o.zip', '--identifier', 'id']), { file: 'a.ronu', title: 'T', out: 'o.zip', identifier: 'id' });
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['a', 'b']), /unexpected/);
  assert.throws(() => packageRonu(join(SAMPLES_DIR, 'hello-ronu', 'module.json')), /not a zip/);
});
