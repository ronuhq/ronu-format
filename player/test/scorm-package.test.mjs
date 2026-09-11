// The SCORM 1.2 package: the manifest XML (well-formed, every file listed,
// escaped), the launcher, and a build of hello.ronu unzipped back and checked
// file by file against the manifest it carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { buildImsManifest, buildLaunchHtml, buildPackageEntries, buildPackageConfig, describeRonu, escapeXml, slugIdentifier, PLAYER_FILES, XSD_FILES, PACKAGE_CONFIG_FILE } from '../tools/scorm-manifest.mjs';
import { packageRonu, parseArgs, connectedOptions, CONNECTED_HELP } from '../tools/scorm-package.mjs';
import { parsePackageConfig } from '../machine-session.js';
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
  assert.deepEqual(describeRonu(manifest, { fileName: 'hello.ronu' }), { title: 'Hello, .ronu', identifier: 'ronu-a0000000-0000-4000-8000-000000000001', familyId: 'a0000000-0000-4000-8000-000000000001', moduleId: null });
  assert.deepEqual(describeRonu(null, { fileName: 'my module.ronu' }), { title: 'my module', identifier: 'my-module', familyId: null, moduleId: null });
  assert.deepEqual(describeRonu('not json', { fileName: 'x.ronu', title: 'Given', identifier: 'given id' }), { title: 'Given', identifier: 'given-id', familyId: null, moduleId: null });
  // The module id a receiver keys by: module.id first, else the exporter's versionId; a local: id is none.
  assert.equal(describeRonu(JSON.stringify({ module: { id: 'm-1', versionId: 'v-1' } })).moduleId, 'm-1');
  assert.equal(describeRonu(JSON.stringify({ module: { versionId: 'v-1' } })).moduleId, 'v-1');
  assert.equal(describeRonu(JSON.stringify({ module: { id: 'local:x' } })).moduleId, null);
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

// ---- connected packages (contract section 7) --------------------------------

test('buildPackageConfig: ronu-package.json with the receiver origin, the key and the module id; refuses what a receiver could not use', () => {
  const text = buildPackageConfig({ receiver: 'https://ronunest.com/', key: ' cust-key ', moduleId: 'b0000000-0000-4000-8000-000000000001' });
  assert.deepEqual(JSON.parse(text), { version: 0, receiver: 'https://ronunest.com', key: 'cust-key', moduleId: 'b0000000-0000-4000-8000-000000000001', name: 'ronu player' });
  assert.deepEqual(parsePackageConfig(text), { version: 0, receiver: 'https://ronunest.com', key: 'cust-key', moduleId: 'b0000000-0000-4000-8000-000000000001', name: 'ronu player' }, 'the player reads back exactly what the packager wrote');
  assert.equal(JSON.parse(buildPackageConfig({ receiver: 'localhost:8787', key: 'k', moduleId: 'm' })).receiver, 'https://localhost:8787', 'a bare host is taken as https');
  assert.equal(JSON.parse(buildPackageConfig({ receiver: 'http://localhost:8787', key: 'mock-key', moduleId: 'm', name: 'Acme player' })).name, 'Acme player');
  assert.throws(() => buildPackageConfig({ receiver: 'https://r.test', key: '', moduleId: 'm' }), /needs a key/);
  assert.throws(() => buildPackageConfig({ receiver: 'http://r.test', key: 'k', moduleId: 'm' }), /https origin/);
  assert.throws(() => buildPackageConfig({ receiver: '', key: 'k', moduleId: 'm' }), /https origin/);
  assert.throws(() => buildPackageConfig({ receiver: 'https://r.test', key: 'k', moduleId: null }), /module id/);
});

test('buildLaunchHtml: a connected launcher adds machine=1; a self-contained one does not', () => {
  assert.match(buildLaunchHtml({ title: 'T', machine: true }), /<iframe src="player\/index\.html\?ronu=\.\.\/module\.ronu&amp;scorm=1&amp;machine=1"/);
  assert.ok(!buildLaunchHtml({ title: 'T' }).includes('machine=1'));
});

test('buildPackageEntries: a connected package carries ronu-package.json, listed in the manifest, and the machine launcher', () => {
  const ronuBytes = new Uint8Array(readFileSync(HELLO));
  const manifestJson = readFileSync(join(SAMPLES_DIR, 'hello-ronu', 'manifest.json'), 'utf8');
  const connected = buildPackageEntries({ ronuBytes, manifestJson, fileName: 'hello.ronu', readPlayerFile: () => new Uint8Array([1]), connected: { receiver: 'https://ronunest.com', key: 'cust-key' } });
  assert.equal(connected.connected, true);
  assert.equal(connected.moduleId, 'b0000000-0000-4000-8000-000000000001', 'the exporter\'s versionId');
  const config = JSON.parse(new TextDecoder().decode(connected.entries[PACKAGE_CONFIG_FILE]));
  assert.deepEqual(config, { version: 0, receiver: 'https://ronunest.com', key: 'cust-key', moduleId: 'b0000000-0000-4000-8000-000000000001', name: 'ronu player' });
  const xml = new TextDecoder().decode(connected.entries['imsmanifest.xml']);
  assert.ok(xml.includes(`<file href="${PACKAGE_CONFIG_FILE}"/>`), 'the LMS must import it with the rest');
  assert.match(new TextDecoder().decode(connected.entries['launch.html']), /scorm=1&amp;machine=1/);
  assert.ok(connected.entries['player/machine-session.js'], 'the exchange code ships in the package');
  // Self-contained: no file, no flag.
  const plain = buildPackageEntries({ ronuBytes, manifestJson, fileName: 'hello.ronu', readPlayerFile: () => new Uint8Array([1]) });
  assert.equal(plain.connected, false);
  assert.equal(plain.entries[PACKAGE_CONFIG_FILE], undefined);
  assert.ok(!new TextDecoder().decode(plain.entries['imsmanifest.xml']).includes(PACKAGE_CONFIG_FILE));
  assert.ok(!new TextDecoder().decode(plain.entries['launch.html']).includes('machine=1'));
  // A file with no platform module id cannot be a connected package.
  assert.throws(() => buildPackageEntries({ ronuBytes, manifestJson: JSON.stringify({ module: { title: 'Loose' } }), readPlayerFile: () => new Uint8Array([1]), connected: { receiver: 'https://ronunest.com', key: 'k' } }), /module id/);
});

test('connectedOptions: --receiver and --key together; --connected alone, or one without the other, says what is missing', () => {
  assert.equal(connectedOptions(parseArgs(['a.ronu'])), null);
  assert.deepEqual(connectedOptions(parseArgs(['a.ronu', '--receiver', 'https://r.test', '--key', 'k'])), { receiver: 'https://r.test', key: 'k', name: undefined });
  assert.deepEqual(connectedOptions(parseArgs(['a.ronu', '--connected', '--receiver', 'https://r.test', '--key', 'k', '--player-name', 'P'])), { receiver: 'https://r.test', key: 'k', name: 'P' });
  assert.throws(() => connectedOptions(parseArgs(['a.ronu', '--connected'])), (e) => e.message.startsWith(CONNECTED_HELP) && /--receiver and --key are missing/.test(e.message));
  assert.throws(() => connectedOptions(parseArgs(['a.ronu', '--receiver', 'https://r.test'])), /--key is missing/);
  assert.throws(() => connectedOptions(parseArgs(['a.ronu', '--key', 'k'])), /--receiver is missing/);
  assert.match(CONNECTED_HELP, /one per LMS customer/);
});

test('round trip, connected: package hello.ronu with --receiver --key, unzip, ronu-package.json is inside and listed, the launcher asks for the machine launch', () => {
  const { zip, files, connected, moduleId } = packageRonu(HELLO, { connected: { receiver: 'http://localhost:8787', key: 'mock-key' } });
  assert.equal(connected, true);
  assert.equal(moduleId, 'b0000000-0000-4000-8000-000000000001');
  const entries = fflate.unzipSync(zip);
  const names = Object.keys(entries);
  assert.ok(names.includes(PACKAGE_CONFIG_FILE));
  assert.ok(names.includes('player/machine-session.js'));
  assert.deepEqual(names.sort(), files.sort());
  const xml = new TextDecoder().decode(entries['imsmanifest.xml']);
  assertWellFormed(xml);
  const hrefs = [...xml.matchAll(/<file href="([^"]+)"\/>/g)].map((m) => m[1]);
  assert.ok(hrefs.includes(PACKAGE_CONFIG_FILE));
  for (const name of names) if (name !== 'imsmanifest.xml') assert.ok(hrefs.includes(name), `${name} in the zip is listed`);
  assert.deepEqual(parsePackageConfig(new TextDecoder().decode(entries[PACKAGE_CONFIG_FILE])), { version: 0, receiver: 'http://localhost:8787', key: 'mock-key', moduleId: 'b0000000-0000-4000-8000-000000000001', name: 'ronu player' });
  assert.match(new TextDecoder().decode(entries['launch.html']), /scorm=1&amp;machine=1/);
  // The self-contained build of the same file has neither.
  const plain = fflate.unzipSync(packageRonu(HELLO).zip);
  assert.equal(plain[PACKAGE_CONFIG_FILE], undefined);
  assert.ok(!new TextDecoder().decode(plain['launch.html']).includes('machine=1'));
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['a.ronu', '--title', 'T', '--out', 'o.zip', '--identifier', 'id']), { file: 'a.ronu', title: 'T', out: 'o.zip', identifier: 'id', receiver: null, key: null, connected: false, playerName: null });
  assert.deepEqual(parseArgs(['a.ronu', '--receiver', 'https://r.test', '--key', 'k', '--player-name', 'Acme LMS player']), { file: 'a.ronu', title: null, out: null, identifier: null, receiver: 'https://r.test', key: 'k', connected: false, playerName: 'Acme LMS player' });
  assert.equal(parseArgs(['a.ronu', '--connected']).connected, true);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['a', 'b']), /unexpected/);
  assert.throws(() => packageRonu(join(SAMPLES_DIR, 'hello-ronu', 'module.json')), /not a zip/);
});
