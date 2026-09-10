// Open real zips through the same unzip + resolve path the UI uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBundle, openModuleJson, createResolver, checkManifest, mimeFor, bundleTitle } from '../bundle.js';
import { Engine } from '../engine.js';
import { fflate, SAMPLES_DIR, PLAYER_DIR } from './helpers.mjs';

const unzip = fflate.unzipSync;
const makeUrl = (bytes, mime, path) => `blob:test/${path}#${mime}#${bytes.length}`;

test('hello.ronu opens: manifest, module, bundled asset resolves to a URL', () => {
  const bytes = readFileSync(join(SAMPLES_DIR, 'hello-ronu', 'hello.ronu'));
  const bundle = openBundle(bytes, { unzip, name: 'hello.ronu' });
  assert.equal(bundle.manifest.format, 'ronu');
  assert.equal(bundle.manifest.module.familyId, 'a0000000-0000-4000-8000-000000000001');
  assert.deepEqual(checkManifest(bundle.manifest), []);
  assert.equal(bundleTitle(bundle), 'Hello, .ronu');
  assert.equal(bundle.module.nodes.length, 4);
  assert.ok(bundle.assets.has('assets/01-cover.png'));
  assert.equal(bundle.assets.get('assets/01-cover.png').length, 3354);

  const r = createResolver(bundle, { makeUrl });
  const url = r.resolve('assets/01-cover.png');
  assert.equal(url, 'blob:test/assets/01-cover.png#image/png#3354');
  assert.equal(r.resolve('./assets/01-cover.png'), url, 'cached and prefix-tolerant');
  assert.equal(r.resolve('assets/missing.png'), null);
  assert.equal(r.resolve('module-content/abc/x.jpg'), null, 'platform storage refs are not playable offline');
  assert.equal(r.resolve('https://example.com/v.mp4'), 'https://example.com/v.mp4');
  assert.equal(r.resolve('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(r.resolve(''), null);

  // The message node's content references the bundled image; the file plays end to end.
  const e = new Engine(bundle.module);
  const v = e.start();
  assert.match(v.content, /assets\/01-cover\.png/);
  assert.equal(r.resolve(v.config.files[0].path), url);
});

test('a .ronu built from an interchange sample opens and plays', () => {
  const bytes = readFileSync(join(PLAYER_DIR, 'test', 'fixtures', 'under-the-sink.ronu'));
  const bundle = openBundle(bytes, { unzip, name: 'under-the-sink.ronu' });
  assert.equal(bundle.manifest.module.title, 'Under the Sink: Trace the Leak & Fix It Right');
  assert.equal(bundle.assets.size, 0);
  const e = new Engine(bundle.module);
  e.start();
  assert.equal(e.continue().type, 'scene');
});

test('a zip with everything under one folder still opens; a zip without module.json fails cleanly', () => {
  const inner = readFileSync(join(SAMPLES_DIR, 'hello-ronu', 'module.json'));
  const manifest = readFileSync(join(SAMPLES_DIR, 'hello-ronu', 'manifest.json'));
  const nested = fflate.zipSync({ 'hello/module.json': inner, 'hello/manifest.json': manifest, 'hello/assets/a.png': new Uint8Array([1, 2, 3]), '__MACOSX/hello/._module.json': new Uint8Array([0]) });
  const bundle = openBundle(nested, { unzip });
  assert.equal(bundle.module.nodes.length, 4);
  assert.ok(bundle.assets.has('assets/a.png'));
  assert.throws(() => openBundle(fflate.zipSync({ 'readme.txt': new Uint8Array([65]) }), { unzip }), /module\.json/);
  assert.throws(() => openBundle(new Uint8Array([1, 2, 3, 4]), { unzip }), /zip/);
});

test('JSON-only interchange form gets a synthesised manifest', () => {
  const text = readFileSync(join(SAMPLES_DIR, 'fantasy-series-quiz', 'module.json'), 'utf8');
  const bundle = openModuleJson(text, { name: 'module.json' });
  assert.equal(bundle.manifest.synthesized, true);
  assert.equal(bundle.manifest.module.title, 'New Message');
  assert.ok(checkManifest(bundle.manifest).length === 0);
  assert.throws(() => openModuleJson('{"nodes": "no"}'), /nodes/);
});

// A bare module.json opened by URL keeps the manifest found beside it, so the
// platform module id survives and the play-through can be sent to a receiver.
test('JSON-only form with a sibling manifest keeps it (and its module id); a bad one is ignored', () => {
  const dir = join(SAMPLES_DIR, 'under-the-sink');
  const text = readFileSync(join(dir, 'module.json'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const bundle = openModuleJson(text, { name: 'module.json', manifest });
  assert.equal(bundle.manifest.synthesized, undefined);
  assert.equal(bundle.manifest.module.versionId, '132a2097-db9e-400c-a580-827dfec9c3d5');
  assert.equal(bundle.manifest.module.title, 'Under the Sink: Trace the Leak & Fix It Right');
  assert.equal(openModuleJson(text, { name: 'module.json', manifest: { format: 'ronu' } }).manifest.synthesized, true);
  assert.equal(openModuleJson(text, { name: 'module.json', manifest: 'nope' }).manifest.synthesized, true);
});

test('mime types come from the manifest first, then the extension', () => {
  assert.equal(mimeFor('assets/x.bin', { assets: [{ path: 'assets/x.bin', mimeType: 'video/mp4' }] }), 'video/mp4');
  assert.equal(mimeFor('assets/x.webp', {}), 'image/webp');
  assert.equal(mimeFor('assets/x.unknown', {}), 'application/octet-stream');
  assert.deepEqual(checkManifest({ format: 'docx', formatVersion: '3.0', module: {} }).length, 4);
});
