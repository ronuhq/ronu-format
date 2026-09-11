#!/usr/bin/env node
// A fake LMS for proving a package: serves a SCORM 1.2 package (a zip, or an
// unzipped directory) and a page that implements a logging `window.API`,
// loads the package's launch.html in an iframe, and shows the cmi data model
// and every call live. Node 20+, no npm. Nothing here is an LMS; it is the
// smallest thing that behaves like one for a local check.
//
//   node player/tools/scorm-harness.mjs <package.zip | dir> [--port 8791]

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fflate = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'fflate.js'));

const args = process.argv.slice(2);
let target = null;
let port = 8791;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (!target) target = args[i];
}
if (!target || !existsSync(target)) {
  console.error('usage: scorm-harness.mjs <package.zip | unzipped dir> [--port N]');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.xsd': 'application/xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ronu': 'application/zip', '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

// The package: an in-memory map of path -> bytes (zip), or a directory read on demand.
let readEntry;
let listing;
if (statSync(target).isDirectory()) {
  const root = resolve(target);
  readEntry = (p) => {
    const full = normalize(join(root, p));
    if (!full.startsWith(root)) return null;
    try {
      return statSync(full).isFile() ? readFileSync(full) : null;
    } catch {
      return null;
    }
  };
  listing = () => (existsSync(join(root, 'imsmanifest.xml')) ? ['imsmanifest.xml', 'launch.html'] : []);
} else {
  const entries = fflate.unzipSync(new Uint8Array(readFileSync(target)));
  readEntry = (p) => entries[p] ?? null;
  listing = () => Object.keys(entries);
}
if (!readEntry('imsmanifest.xml')) {
  console.error(`${target} has no imsmanifest.xml at its root`);
  process.exit(2);
}
const manifestXml = new TextDecoder().decode(readEntry('imsmanifest.xml'));
const launch = (manifestXml.match(/<resource\b[^>]*\bhref="([^"]+)"/) ?? [])[1] ?? 'launch.html';
const courseTitle = ((manifestXml.match(/<organization\b[^>]*>[\s\S]*?<title>([^<]*)<\/title>/) ?? [])[1] ?? 'SCORM package').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fake LMS: ${esc(courseTitle)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: #f2f4f7; color: #1f2733; display: grid; grid-template-columns: 1fr 380px; grid-template-rows: 44px 1fr; height: 100vh; }
  header { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 0 14px; background: #1f2733; color: #fff; }
  header strong { font-size: 15px; }
  header .pill { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: #3a4656; }
  iframe { border: 0; width: 100%; height: 100%; background: #fff; }
  aside { border-left: 1px solid #d8dde5; display: grid; grid-template-rows: auto 1fr; min-height: 0; background: #fff; }
  aside h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; margin: 12px 12px 6px; color: #5b6673; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  td { padding: 3px 12px; border-bottom: 1px solid #eef1f4; vertical-align: top; word-break: break-all; }
  td:first-child { color: #5b6673; white-space: nowrap; width: 46%; }
  #log { overflow: auto; min-height: 0; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0 12px 12px; margin: 0; list-style: none; }
  #log li { padding: 2px 0; border-bottom: 1px dotted #e6e9ee; }
  #log li.set { color: #0b5d3b; } #log li.life { color: #7a3e00; font-weight: 600; } #log li.err { color: #b00020; }
  .cmi { max-height: 44vh; overflow: auto; }
</style>
</head>
<body>
<header><strong>Fake LMS</strong><span class="pill" id="course">${esc(courseTitle)}</span><span class="pill" id="state">API ready, not initialised</span></header>
<iframe id="sco" src="/pkg/${esc(launch)}" title="SCO"></iframe>
<aside>
  <div class="cmi"><h2>cmi data model</h2><table id="cmi"></table></div>
  <div style="display:grid;grid-template-rows:auto 1fr;min-height:0"><h2>API calls</h2><ol id="log"></ol></div>
</aside>
<script>
(function () {
  var cmi = {
    'cmi.core.student_id': 'learner-001',
    'cmi.core.student_name': 'Dami Okafor',
    'cmi.core.lesson_location': '',
    'cmi.core.credit': 'credit',
    'cmi.core.lesson_status': 'not attempted',
    'cmi.core.entry': 'ab-initio',
    'cmi.core.score.raw': '',
    'cmi.core.score.min': '',
    'cmi.core.score.max': '',
    'cmi.core.total_time': '0000:00:00.00',
    'cmi.core.lesson_mode': 'normal',
    'cmi.core.exit': '',
    'cmi.core.session_time': '',
    'cmi.suspend_data': '',
    'cmi.launch_data': '',
    'cmi.comments': '',
    'cmi.comments_from_lms': '',
  };
  var READ_ONLY = { 'cmi.core.student_id': 1, 'cmi.core.student_name': 1, 'cmi.core.credit': 1, 'cmi.core.entry': 1, 'cmi.core.total_time': 1, 'cmi.core.lesson_mode': 1, 'cmi.launch_data': 1, 'cmi.comments_from_lms': 1 };
  var WRITE_ONLY = { 'cmi.core.exit': 1, 'cmi.core.session_time': 1 };
  var ERRORS = { '0': 'No error', '101': 'General exception', '201': 'Invalid argument error', '301': 'Not initialized', '401': 'Not implemented error', '403': 'Element is read only', '404': 'Element is write only', '405': 'Incorrect data type' };
  var STATUSES = ['passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted'];
  var initialised = false, finished = false, lastError = '0', commits = 0;
  var logEl = document.getElementById('log'), cmiEl = document.getElementById('cmi'), stateEl = document.getElementById('state');
  window.__scormLog = [];

  function log(kind, text) {
    window.__scormLog.push(text);
    var li = document.createElement('li'); li.className = kind; li.textContent = (window.__scormLog.length) + '. ' + text; logEl.appendChild(li); logEl.scrollTop = logEl.scrollHeight;
  }
  function render() {
    cmiEl.innerHTML = '';
    Object.keys(cmi).forEach(function (k) {
      var tr = document.createElement('tr'); var a = document.createElement('td'); var b = document.createElement('td');
      a.textContent = k.replace('cmi.core.', 'core.').replace('cmi.', ''); b.textContent = cmi[k]; b.setAttribute('data-el', k); tr.appendChild(a); tr.appendChild(b); cmiEl.appendChild(tr);
    });
    stateEl.textContent = finished ? 'LMSFinish received (' + commits + ' commits)' : initialised ? 'initialised (' + commits + ' commits)' : 'API ready, not initialised';
  }
  function fail(code, what) { lastError = code; log('err', what + ' -> error ' + code + ' ' + ERRORS[code]); return 'false'; }

  window.API = {
    LMSInitialize: function (s) {
      if (initialised) return fail('101', 'LMSInitialize("' + s + '") twice');
      initialised = true; lastError = '0'; log('life', 'LMSInitialize("' + s + '") -> true'); render(); return 'true';
    },
    LMSFinish: function (s) {
      if (!initialised) return fail('301', 'LMSFinish before initialise');
      finished = true; initialised = false; lastError = '0'; log('life', 'LMSFinish("' + s + '") -> true'); render(); return 'true';
    },
    LMSGetValue: function (el) {
      if (!initialised) { fail('301', 'LMSGetValue(' + el + ')'); return ''; }
      if (WRITE_ONLY[el]) { fail('404', 'LMSGetValue(' + el + ')'); return ''; }
      if (!(el in cmi)) { fail('201', 'LMSGetValue(' + el + ')'); return ''; }
      lastError = '0'; log('get', 'LMSGetValue(' + el + ') -> "' + cmi[el] + '"'); return cmi[el];
    },
    LMSSetValue: function (el, v) {
      if (!initialised) return fail('301', 'LMSSetValue(' + el + ')');
      if (READ_ONLY[el]) return fail('403', 'LMSSetValue(' + el + ')');
      if (!(el in cmi)) return fail('201', 'LMSSetValue(' + el + ')');
      v = String(v);
      if (el === 'cmi.core.lesson_status' && STATUSES.indexOf(v) < 0) return fail('405', 'LMSSetValue(' + el + ', "' + v + '")');
      if (/^cmi\\.core\\.score\\./.test(el) && v !== '' && !(/^-?\\d+(\\.\\d+)?$/.test(v) && Number(v) >= 0 && Number(v) <= 100)) return fail('405', 'LMSSetValue(' + el + ', "' + v + '")');
      if (el === 'cmi.core.session_time' && !/^\\d{2,4}:\\d{2}:\\d{2}(\\.\\d{1,2})?$/.test(v)) return fail('405', 'LMSSetValue(' + el + ', "' + v + '")');
      if (el === 'cmi.core.exit' && ['', 'time-out', 'suspend', 'logout'].indexOf(v) < 0) return fail('405', 'LMSSetValue(' + el + ', "' + v + '")');
      if (el === 'cmi.suspend_data' && v.length > 4096) return fail('405', 'LMSSetValue(' + el + ') over 4096');
      if (el === 'cmi.core.lesson_location' && v.length > 255) return fail('405', 'LMSSetValue(' + el + ') over 255');
      cmi[el] = v; lastError = '0'; log('set', 'LMSSetValue(' + el + ', "' + (v.length > 80 ? v.slice(0, 77) + '...' : v) + '") -> true'); render(); return 'true';
    },
    LMSCommit: function (s) {
      if (!initialised) return fail('301', 'LMSCommit');
      commits++; lastError = '0'; log('life', 'LMSCommit("' + s + '") -> true'); render(); return 'true';
    },
    LMSGetLastError: function () { return lastError; },
    LMSGetErrorString: function (code) { return ERRORS[String(code)] || ''; },
    LMSGetDiagnostic: function (code) { return 'fake LMS: ' + (ERRORS[String(code)] || 'no detail'); },
  };
  window.__cmi = cmi;
  render();
})();
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(PAGE);
  }
  if (path.startsWith('/pkg/')) {
    const rel = path.slice(5);
    const bytes = readEntry(rel);
    if (!bytes) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(`not in package: ${rel}`);
    }
    res.writeHead(200, { 'content-type': MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
    return res.end(Buffer.from(bytes));
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Fake LMS on http://127.0.0.1:${port}/  (package: ${target}, launch: ${launch}, ${listing().length} entries)`);
});
