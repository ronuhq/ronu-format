// Bootstrap: open a file (drop, picker, sample, ?ronu= URL, last-opened from
// IndexedDB), build the engine + UI, keep the receiver connection, register
// the service worker.

import { openBundle, openModuleJson, createResolver, checkManifest, bundleTitle } from './bundle.js';
import { Engine } from './engine.js';
import { PlayerUI, h } from './ui.js';
import { sessionRecord } from './session.js';
import { dbGet, dbPut } from './store.js';
import { ReceiverController, receiverControl } from './receiver-ui.js';

const SAMPLE_URL = '../samples/hello-ronu/hello.ronu';
const SHOWCASE_URL = '../samples/showcase/showcase.ronu';
const SAMPLE_JSON_URL = '../samples/under-the-sink/module.json';

const app = document.getElementById('app');
let current = null; // { ui, engine, resolver, bundle }
let openerShowing = false;

// The one receiver connection (docs/record-receiver.md). Loaded before the
// first screen so the opener and the top bar can show it.
const receiver = new ReceiverController();
receiver.subscribe(() => {
  if (current) {
    current.engine.setServices({ conversation: receiver.connected });
    current.ui.render(true);
  } else if (openerShowing) showOpener();
});

// ---- opening ---------------------------------------------------------------

function looksLikeZip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4b;
}

function bundleFromBytes(bytes, name, { manifest = null } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (looksLikeZip(u8) || /\.(ronu|zip)$/i.test(name)) return openBundle(u8, { unzip: window.fflate.unzipSync, name });
  return openModuleJson(new TextDecoder().decode(u8), { name, manifest });
}

async function openBytes(bytes, name, { remember = true, manifest = null } = {}) {
  let bundle;
  try {
    bundle = bundleFromBytes(bytes, name, { manifest });
  } catch (e) {
    showOpener(`Could not open ${name}: ${e.message}`);
    return;
  }
  const problems = checkManifest(bundle.manifest);
  if (problems.length) console.warn('manifest.json problems (continuing):', problems);
  const buffer = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  let last = await dbGet('last');
  if (remember) {
    // The "sent to the receiver" flag stays with the file when the same file is opened again.
    const same = last && last.name === name && last.bytes?.byteLength === buffer.byteLength;
    last = { name, title: bundleTitle(bundle), bytes: buffer, manifest: bundle.manifest.synthesized ? null : bundle.manifest, at: Date.now(), sent: same ? last.sent ?? null : null };
    await dbPut('last', last);
  }
  const priorSent = last && last.name === name && last.bytes?.byteLength === buffer.byteLength ? last.sent ?? null : null;
  play(bundle, { priorSent });
}

function play(bundle, { priorSent = null } = {}) {
  closeCurrent();
  const resolver = createResolver(bundle, {
    makeUrl: (bytes, mime) => URL.createObjectURL(new Blob([bytes], { type: mime })),
    revokeUrl: (url) => URL.revokeObjectURL(url),
  });
  let engine;
  try {
    engine = new Engine(bundle.module, { services: { conversation: receiver.connected } });
  } catch (e) {
    resolver.revoke();
    showOpener(`Could not read module.json: ${e.message}`);
    return;
  }
  const ui = new PlayerUI({
    root: app, engine, resolver, manifest: bundle.manifest,
    onClose: () => showOpener(),
    onDownload: () => downloadSession(engine, bundle),
    receiver,
    receiverControl,
    priorSent,
    onSent: async (sent) => {
      const last = await dbGet('last');
      if (last && last.name === bundle.name) await dbPut('last', { ...last, sent });
    },
  });
  current = { ui, engine, resolver, bundle };
  openerShowing = false;
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

/**
 * A bare module.json fetched by URL may have its manifest.json beside it (the
 * sample folders do). Reading it keeps the platform module id, so the file can
 * be recorded on a receiver. Missing or broken: null, and one is synthesised.
 */
async function siblingManifest(url) {
  try {
    const res = await fetch(new URL('manifest.json', new URL(url, location.href)).href, { cache: 'no-cache' });
    if (!res.ok) return null;
    const doc = await res.json();
    return doc && typeof doc === 'object' && doc.module ? doc : null;
  } catch {
    return null;
  }
}

async function openUrl(url, { remember = true } = {}) {
  showOpener(null, `Loading ${url}`);
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'module.ronu');
    const bare = !looksLikeZip(bytes) && /\.json$/i.test(name) && !/manifest\.json$/i.test(name);
    const manifest = bare ? await siblingManifest(url) : null;
    await openBytes(bytes, name, { remember, manifest });
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
  openerShowing = true;
  const last = await dbGet('last');
  const input = h('input', { type: 'file', accept: '.ronu,.zip,.json,application/zip,application/json', hidden: true, onchange: (e) => e.target.files[0] && openFile(e.target.files[0]) });
  const urlInput = h('input.input', { type: 'text', inputmode: 'url', autocapitalize: 'off', spellcheck: false, placeholder: 'https://example.com/module.ronu', 'aria-label': 'URL of a .ronu file' });
  const notice = receiver.takeNotice();
  const drop = h('section.opener',
    h('h1', 'ronu player'),
    h('p.lede', 'Open a ', h('code', '.ronu'), ' file. It plays here, offline, with no account.'),
    error ? h('p.error', error) : null,
    status ? h('p.muted', status) : null,
    h('div.dropzone', { tabindex: 0, role: 'button', 'aria-label': 'Choose a .ronu file', onclick: () => input.click(), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && input.click() },
      h('strong', 'Tap to choose a file'), h('span.muted', ' or drop one here'), h('div.small.muted', '.ronu, .zip, or a bare module.json')),
    input,
    h('div.actions.actions-wrap',
      h('button.btn.btn-primary', { onclick: () => openUrl(SHOWCASE_URL), title: 'A real room with its panorama bundled (4.8 MB)' }, 'Try the showcase'),
      h('button.btn', { onclick: () => openUrl(SAMPLE_URL), title: 'The smallest complete file' }, 'Try a sample'),
      last ? h('button.btn', { onclick: () => openBytes(new Uint8Array(last.bytes), last.name, { remember: false, manifest: last.manifest ?? null }), title: last.name }, `Reopen "${last.title || last.name}"`) : null,
    ),
    last?.sent ? h('p.small.muted', `"${last.title || last.name}" was sent to ${last.sent.receiverName ?? 'the receiver'} on ${new Date(last.sent.at).toLocaleString()}${typeof last.sent.score === 'number' ? ` (score ${last.sent.score})` : ''}.`) : null,
    h('form.url-form', { onsubmit: (e) => { e.preventDefault(); if (urlInput.value) openUrl(urlInput.value); } }, urlInput, h('button.btn', { type: 'submit' }, 'Load URL')),
    h('p.small.muted', 'More samples: ', h('button.btn-link', { onclick: () => openUrl(SAMPLE_JSON_URL) }, 'Under the sink'), ' (a scene, a choice and an AI conversation), or paste any ', h('code', 'samples/*/module.json'), ' address above.'),
    h('div.receiver-row',
      h('strong', `${receiver.connected ? receiver.name : 'RonuNest'}: `),
      receiver.connected ? h('span', 'connected as ', h('span.receiver-user', receiver.connection.user.email || receiver.connection.user.name || 'a learner'), '. Play-throughs can be sent there and AI characters talk back.') : h('span.muted', 'not connected. Connect to record play-throughs on RonuNest and to talk to AI characters.'),
      ' ',
      receiverControl(receiver, { bare: true, onChange: () => showOpener() }),
      receiver.connected ? null : h('span.small.muted', ` Receiver: ${receiver.origin}`),
      notice ? h('p.error.small', notice) : null,
    ),
    h('p.small.muted', 'Files are untrusted content: rich text is sanitised and code steps are never executed. Nothing leaves your device unless you connect to a receiver and send a play-through.'),
    h('p.small.muted', h('a', { href: 'README.md' }, 'About this player'), ' · ', h('a', { href: '../spec/ronu-spec.md' }, 'The format'), ' · ', h('a', { href: '../docs/record-receiver.md' }, 'Receivers')),
  );
  if (!openerShowing) return; // a file opened while the store was read
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

(async () => {
  await receiver.load();
  const params = new URLSearchParams(location.search);
  const remote = params.get('ronu');
  if (remote) openUrl(remote);
  else showOpener();
})();

// Expose a little for debugging and browser-level checks.
window.ronuPlayer = { get current() { return current; }, openUrl, openBytes, receiver };
