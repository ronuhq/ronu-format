// Bootstrap: open a file (drop, picker, sample, ?ronu= URL, last-opened from
// IndexedDB), build the engine + UI, register the service worker.

import { openBundle, openModuleJson, createResolver, checkManifest, bundleTitle } from './bundle.js';
import { Engine } from './engine.js';
import { PlayerUI, h } from './ui.js';
import { sessionRecord } from './session.js';

const DB_NAME = 'ronu-player';
const STORE = 'files';
const SAMPLE_URL = '../samples/hello-ronu/hello.ronu';
const SAMPLE_JSON_URL = '../samples/under-the-sink/module.json';

const app = document.getElementById('app');
let current = null; // { ui, engine, resolver, bundle }

// ---- IndexedDB: remember the last opened file ------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(key, value) {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) {
    console.warn('Could not remember file', e);
  }
}
async function dbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((res, rej) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => rej(req.error);
    });
  } catch {
    return null;
  }
}

// ---- opening ---------------------------------------------------------------

function bundleFromBytes(bytes, name) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const looksZip = u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4b;
  if (looksZip || /\.(ronu|zip)$/i.test(name)) return openBundle(u8, { unzip: window.fflate.unzipSync, name });
  return openModuleJson(new TextDecoder().decode(u8), { name });
}

async function openBytes(bytes, name, { remember = true } = {}) {
  let bundle;
  try {
    bundle = bundleFromBytes(bytes, name);
  } catch (e) {
    showOpener(`Could not open ${name}: ${e.message}`);
    return;
  }
  const problems = checkManifest(bundle.manifest);
  if (problems.length) console.warn('manifest.json problems (continuing):', problems);
  if (remember) await dbPut('last', { name, title: bundleTitle(bundle), bytes: bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes, at: Date.now() });
  play(bundle);
}

function play(bundle) {
  closeCurrent();
  const resolver = createResolver(bundle, {
    makeUrl: (bytes, mime) => URL.createObjectURL(new Blob([bytes], { type: mime })),
    revokeUrl: (url) => URL.revokeObjectURL(url),
  });
  let engine;
  try {
    engine = new Engine(bundle.module);
  } catch (e) {
    resolver.revoke();
    showOpener(`Could not read module.json: ${e.message}`);
    return;
  }
  const ui = new PlayerUI({
    root: app, engine, resolver, manifest: bundle.manifest,
    onClose: () => showOpener(),
    onDownload: () => downloadSession(engine, bundle),
  });
  current = { ui, engine, resolver, bundle };
  document.title = `${bundleTitle(bundle)} · ronu player`;
  ui.mount();
}

function closeCurrent() {
  if (!current) return;
  current.ui.destroy();
  current.resolver.revoke();
  current = null;
  document.title = 'ronu player';
}

function downloadSession(engine, bundle) {
  const record = sessionRecord(engine, bundle.manifest);
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${(bundleTitle(bundle) || 'session').replace(/[^\w.-]+/g, '_')}-session.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function openUrl(url, { remember = true } = {}) {
  showOpener(null, `Loading ${url}`);
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'module.ronu');
    await openBytes(bytes, name, { remember });
  } catch (e) {
    showOpener(`Could not load ${url}: ${e.message}`);
  }
}

async function openFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openBytes(bytes, file.name);
}

// ---- opener screen ---------------------------------------------------------

async function showOpener(error = null, status = null) {
  closeCurrent();
  const last = await dbGet('last');
  const input = h('input', { type: 'file', accept: '.ronu,.zip,.json,application/zip,application/json', hidden: true, onchange: (e) => e.target.files[0] && openFile(e.target.files[0]) });
  const urlInput = h('input.input', { type: 'text', inputmode: 'url', autocapitalize: 'off', spellcheck: false, placeholder: 'https://example.com/module.ronu', 'aria-label': 'URL of a .ronu file' });
  const drop = h('section.opener',
    h('h1', 'ronu player'),
    h('p.lede', 'Open a ', h('code', '.ronu'), ' file. It plays here, offline, with no account.'),
    error ? h('p.error', error) : null,
    status ? h('p.muted', status) : null,
    h('div.dropzone', { tabindex: 0, role: 'button', 'aria-label': 'Choose a .ronu file', onclick: () => input.click(), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && input.click() },
      h('strong', 'Tap to choose a file'), h('span.muted', ' or drop one here'), h('div.small.muted', '.ronu, .zip, or a bare module.json')),
    input,
    h('div.actions.actions-wrap',
      h('button.btn.btn-primary', { onclick: () => openUrl(SAMPLE_URL) }, 'Try a sample'),
      h('button.btn', { onclick: () => openUrl(SAMPLE_JSON_URL) }, 'Try "Under the sink"'),
      last ? h('button.btn', { onclick: () => openBytes(new Uint8Array(last.bytes), last.name, { remember: false }), title: last.name }, `Reopen "${last.title || last.name}"`) : null,
    ),
    h('form.url-form', { onsubmit: (e) => { e.preventDefault(); if (urlInput.value) openUrl(urlInput.value); } }, urlInput, h('button.btn', { type: 'submit' }, 'Load URL')),
    h('p.small.muted', 'Files are untrusted content: rich text is sanitised and code steps are never executed. Nothing leaves your device.'),
    h('p.small.muted', h('a', { href: 'README.md' }, 'About this player'), ' · ', h('a', { href: '../spec/ronu-spec.md' }, 'The format')),
  );
  app.replaceChildren(drop);
}

// ---- drag and drop ---------------------------------------------------------

for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    document.body.classList.add('is-dragging');
  });
}
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('is-dragging');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('is-dragging');
  const file = e.dataTransfer?.files?.[0];
  if (file) openFile(file);
});

// ---- boot ------------------------------------------------------------------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker not registered', e));
}

const params = new URLSearchParams(location.search);
const remote = params.get('ronu');
if (remote) openUrl(remote);
else showOpener();

// Expose a little for debugging and browser-level checks.
window.ronuPlayer = { get current() { return current; }, openUrl, openBytes };
