// A fake record receiver (docs/record-receiver.md) for trying the player's
// connect, send and conversation flows without a RonuNest account. Node
// only, no dependencies. It runs two servers:
//
//   static   serves this repository, so the player is at /player/ and the
//            samples at /samples/; /mock/<sample>.ronu is a sample zipped
//            on the fly with its manifest, so it carries a module id and
//            can be "recorded"
//   receiver /.well-known/ronu-receiver.json (with the receiver's
//            coordinates, contract section 7), /player-connect (a page that
//            posts the connect message to its opener at once, to its parent
//            when framed, or else shows a connection code), the three
//            functions (record-completion, ai-conversation, and creator-api
//            for the `player_session` action a connected package's key
//            buys), and the GoTrue refresh and logout paths
//
//   node player/tools/mock-receiver.mjs [--static 8000] [--receiver 8787]
//   node player/tools/mock-receiver.mjs --static 0 --receiver 8787     (the receiver only)
//
// The machine launch: a package whose ronu-package.json names this origin
// and the key `mock-key` gets a session for its LMS learner; any other key
// is 401 `unauthorized`. MOCK_SESSION_ERROR=tier_required|invalid_learner|
// module_not_found|module_not_owned forces that errorCode instead.
//
// Then open http://localhost:8000/player/, choose "Connect to RonuNest",
// "change" the receiver to http://localhost:8787, and go. Sessions expire
// 45 seconds after they are issued so the refresh path runs on the first
// call. Environment knobs, all optional: MOCK_RECORD_STATUS=403|404|413|500
// makes record-completion fail that way; MOCK_MAX_BODY=<bytes> sets the 413
// ceiling (default 200000); a learner line containing "degrade" gets the
// degraded reply, one containing "fail" a 500.

import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const require = createRequire(import.meta.url);
const fflate = require(join(HERE, '..', 'vendor', 'fflate.js'));

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const STATIC_PORT = arg('--static', 8000);
const RECEIVER_PORT = arg('--receiver', 8787);
const RECEIVER_ORIGIN = `http://localhost:${RECEIVER_PORT}`;
const ANON_KEY = 'mock-anon-key';
export const MOCK_CUSTOMER_KEY = 'mock-key';
const FORCED_SESSION_ERROR = process.env.MOCK_SESSION_ERROR || '';
const SESSION_SECONDS = 45;
const MAX_BODY = Number(process.env.MOCK_MAX_BODY) || 200_000;
const FORCED_RECORD_STATUS = Number(process.env.MOCK_RECORD_STATUS) || 0;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ronu': 'application/zip', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt',
};

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-api-key, x-client-info, x-application-name', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

function send(res, status, body, headers = {}) {
  const isJson = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body ?? '';
  res.writeHead(status, { ...CORS, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

// ---- static server ---------------------------------------------------------

function zipSample(name) {
  const dir = join(REPO, 'samples', name);
  if (!/^[\w-]+$/.test(name) || !existsSync(join(dir, 'module.json'))) return null;
  const entries = {};
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (!f.startsWith('.') && !f.endsWith('.ronu')) entries[relative(dir, p).split(/[\\/]/).join('/')] = [readFileSync(p), { level: f.endsWith('.json') ? 6 : 0 }];
    }
  };
  walk(dir);
  if (!entries['manifest.json']) return null;
  return Buffer.from(fflate.zipSync(entries));
}

const staticServer = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${STATIC_PORT}`);
  if (req.method === 'OPTIONS') return send(res, 204, null);
  const mock = url.pathname.match(/^\/mock\/([\w-]+)\.ronu$/);
  if (mock) {
    const zip = zipSample(mock[1]);
    if (!zip) return send(res, 404, 'no such sample');
    log('static', `zipped samples/${mock[1]} as a .ronu`);
    return send(res, 200, zip, { 'Content-Type': 'application/zip' });
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(REPO, path);
  if (!file.startsWith(REPO)) return send(res, 403, 'forbidden');
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'not found');
  send(res, 200, readFileSync(file), { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
});

// ---- the fake receiver -----------------------------------------------------

const sessions = new Map(); // access token -> { refresh, expiresAt, user }
const refreshTokens = new Map(); // refresh token -> access token
let counter = 0;
let attempts = 0;
const USER = { id: '00000000-0000-4000-8000-00000000mock', email: 'learner@example.com', name: 'Mock Learner' };

function mintSession(user = USER) {
  counter += 1;
  const access = `mock-access-${counter}`;
  const refresh = `mock-refresh-${counter}`;
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  sessions.set(access, { refresh, expiresAt, user });
  refreshTokens.set(refresh, access);
  return { access_token: access, refresh_token: refresh, expires_at: expiresAt, expires_in: SESSION_SECONDS, token_type: 'bearer' };
}

// Tenant learners a package key created, by externalId (section 7: created once, found after).
const tenantLearners = new Map();

/** The section 7 exchange: the key, then the learner, then the module; a session for that learner. */
function playerSession(req, body) {
  const key = req.headers['x-api-key'];
  if (key !== MOCK_CUSTOMER_KEY) return { status: 401, body: { success: false, error: 'Invalid API key', errorCode: 'unauthorized' } };
  if (FORCED_SESSION_ERROR) {
    const statuses = { tier_required: 403, invalid_learner: 400, module_not_found: 404, module_not_owned: 403 };
    return { status: statuses[FORCED_SESSION_ERROR] ?? 400, body: { success: false, error: `Forced by MOCK_SESSION_ERROR=${FORCED_SESSION_ERROR}`, errorCode: FORCED_SESSION_ERROR } };
  }
  const learner = body?.learner && typeof body.learner === 'object' ? body.learner : null;
  const externalId = typeof learner?.externalId === 'string' ? learner.externalId.trim() : '';
  if (!externalId) return { status: 400, body: { success: false, error: 'learner.externalId is required', errorCode: 'invalid_learner' } };
  const moduleId = typeof body?.moduleId === 'string' ? body.moduleId.trim() : '';
  if (!moduleId) return { status: 404, body: { success: false, error: 'Module not found', errorCode: 'module_not_found' } };
  const created = !tenantLearners.has(externalId);
  if (created) tenantLearners.set(externalId, { id: `00000000-0000-4000-8000-${String(tenantLearners.size + 1).padStart(12, '0')}`, email: typeof learner.email === 'string' ? learner.email : '', name: typeof learner.name === 'string' && learner.name.trim() ? learner.name.trim() : externalId });
  const user = tenantLearners.get(externalId);
  const s = mintSession(user);
  return { status: 200, body: { success: true, version: 0, session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, token_type: 'bearer' }, user, learner: { created } } };
}

function connectMessage() {
  const s = mintSession();
  return {
    type: 'ronu-receiver-connect',
    version: 0,
    receiver: { name: 'Mock RonuNest', origin: RECEIVER_ORIGIN, supabaseUrl: RECEIVER_ORIGIN, anonKey: ANON_KEY, records: `${RECEIVER_ORIGIN}/functions/v1/record-completion`, conversation: `${RECEIVER_ORIGIN}/functions/v1/ai-conversation` },
    session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, token_type: 'bearer' },
    user: USER,
  };
}

/** The player must send both headers; the bearer must be a live session. Returns the session or writes the 401. */
function authenticate(req, res) {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (req.headers.apikey !== ANON_KEY) {
    send(res, 401, { error: 'Invalid API key' });
    return null;
  }
  const s = token ? sessions.get(token) : null;
  if (!s || s.expiresAt * 1000 < Date.now()) {
    send(res, 401, { error: 'Not authenticated' });
    return null;
  }
  return s;
}

function isAllowedPlayerOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.origin === origin && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function connectPage(playerOrigin, playerName) {
  const allowed = isAllowedPlayerOrigin(playerOrigin);
  const message = allowed ? connectMessage() : null;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock RonuNest: connect a player</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5}textarea{width:100%;height:120px;font-family:monospace;font-size:12px}button{font:inherit;padding:8px 16px;border-radius:999px}</style></head><body>
<h1>Mock RonuNest</h1>
${allowed ? `<p><strong>${esc(playerName || 'a .ronu player')}</strong> at <code>${esc(playerOrigin)}</code> asks to act for <strong>${esc(USER.email)}</strong>. This mock consents at once.</p>
<p id="status">Connecting…</p>
<div id="code" hidden><p>No opener window, so here is the connection code. Copy it into the player.</p><textarea readonly id="codebox"></textarea><p><button type="button" id="copy">Copy</button></p></div>
<script>
  const message = ${JSON.stringify(message)};
  const target = ${JSON.stringify(playerOrigin)};
  const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  // The opener (the popup case), or the parent when this page is framed: a
  // harness that cannot open popups can still exercise the player's listener.
  const to = window.opener || (window.parent !== window ? window.parent : null);
  if (to && typeof to.postMessage === 'function') {
    to.postMessage(message, target);
    document.getElementById('status').textContent = 'Connected. This window will close.';
    setTimeout(() => window.close(), 600);
  } else {
    document.getElementById('status').textContent = 'Approved.';
    document.getElementById('code').hidden = false;
    document.getElementById('codebox').value = b64url(JSON.stringify(message));
    document.getElementById('copy').onclick = () => navigator.clipboard?.writeText(document.getElementById('codebox').value);
  }
</script>` : `<p>This mock only connects players on <code>http://localhost</code> or <code>http://127.0.0.1</code>; <code>${esc(playerOrigin || '(no origin)')}</code> is refused.</p>`}
</body></html>`;
}

const CANNED_REPLIES = [
  'Right. And is that going to be expensive?',
  'Hmm. So it was not the tap itself, then?',
  'That makes sense, I suppose. What would you have charged if it had been the whole unit?',
  'Fair enough. I appreciate you not talking me into anything.',
  'Thanks for explaining it properly.',
];

function validateRecord(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (typeof body.moduleId !== 'string' || !body.moduleId) return 'moduleId is required';
  if (!body.responses || typeof body.responses !== 'object' || Array.isArray(body.responses)) return 'responses must be an object';
  for (const [id, r] of Object.entries(body.responses)) {
    if (!r || typeof r !== 'object') return `responses.${id} must be an object`;
    if (r.score !== undefined && (typeof r.score !== 'number' || r.score < 0 || r.score > 100)) return `responses.${id}.score must be 0 to 100`;
  }
  if (!Array.isArray(body.path)) return 'path must be an array';
  for (const p of body.path) if (!p || typeof p.nodeId !== 'string' || typeof p.enteredAt !== 'string' || Number.isNaN(Date.parse(p.enteredAt))) return 'path entries need nodeId and an ISO enteredAt';
  if (!body.variableState || typeof body.variableState !== 'object' || Array.isArray(body.variableState)) return 'variableState must be an object';
  return null;
}

const receiverServer = createServer(async (req, res) => {
  const url = new URL(req.url, RECEIVER_ORIGIN);
  const path = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, null);

  if (path === '/.well-known/ronu-receiver.json') {
    // Section 1 plus the section 7 coordinates: a player given only this origin needs nothing else.
    return send(res, 200, {
      ronuReceiver: 0, name: 'Mock RonuNest', connect: '/player-connect',
      supabaseUrl: RECEIVER_ORIGIN, anonKey: ANON_KEY,
      records: `${RECEIVER_ORIGIN}/functions/v1/record-completion`,
      conversation: `${RECEIVER_ORIGIN}/functions/v1/ai-conversation`,
      session: `${RECEIVER_ORIGIN}/functions/v1/creator-api`,
    });
  }
  if (path === '/functions/v1/creator-api' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { success: false, error: 'Body is not JSON', errorCode: 'bad_request' });
    }
    if (body?.action !== 'player_session') return send(res, 400, { success: false, error: `Unknown action "${body?.action}"`, errorCode: 'bad_request' });
    const out = playerSession(req, body);
    log(`creator-api player_session for ${body?.learner?.externalId ?? '(no learner)'} from ${body?.player?.origin ?? '?'} -> ${out.status}${out.body.errorCode ? ` ${out.body.errorCode}` : ` ${out.body.user.name}${out.body.learner.created ? ' (created)' : ''}`}`);
    return send(res, out.status, out.body);
  }
  if (path === '/player-connect') {
    log('connect page opened for', url.searchParams.get('origin'));
    return send(res, 200, connectPage(url.searchParams.get('origin') ?? '', url.searchParams.get('name') ?? ''), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  if (path === '/auth/v1/token' && req.method === 'POST') {
    if (req.headers.apikey !== ANON_KEY) return send(res, 401, { error: 'Invalid API key' });
    if (url.searchParams.get('grant_type') !== 'refresh_token') return send(res, 400, { error: 'unsupported_grant_type' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'invalid_request' });
    }
    const access = refreshTokens.get(body?.refresh_token);
    if (!access) {
      log('refresh REFUSED (unknown refresh token)');
      return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
    }
    refreshTokens.delete(body.refresh_token);
    sessions.delete(access);
    const s = mintSession();
    log('session refreshed ->', s.access_token);
    return send(res, 200, { ...s, user: USER });
  }
  if (path === '/auth/v1/logout' && req.method === 'POST') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const s = sessions.get(token);
    if (s) {
      sessions.delete(token);
      refreshTokens.delete(s.refresh);
    }
    log('logout', token, s ? '(session dropped)' : '(unknown token)');
    return send(res, 204, null);
  }
  if (path === '/functions/v1/record-completion' && req.method === 'POST') {
    const session = authenticate(req, res);
    if (!session) return log('record-completion 401');
    const raw = await readBody(req);
    if (FORCED_RECORD_STATUS === 413 || raw.length > MAX_BODY) {
      log(`record-completion 413 (${raw.length} bytes)`);
      return send(res, 413, { error: 'Payload too large' });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'Body is not JSON' });
    }
    const problem = validateRecord(body);
    if (problem) {
      log('record-completion 400:', problem);
      return send(res, 400, { error: problem });
    }
    if (FORCED_RECORD_STATUS === 403) return send(res, 403, { error: "You don't have access to this module." });
    if (FORCED_RECORD_STATUS === 404) return send(res, 404, { error: 'Module not found' });
    if (FORCED_RECORD_STATUS === 500) return send(res, 500, { error: 'Could not record the completion.' });
    attempts += 1;
    log(`record-completion OK: module ${body.moduleId}, ${Object.keys(body.responses).length} responses, ${body.path.length} path entries, ${Object.keys(body.variableState).length} variables, attempt ${attempts}`);
    return send(res, 200, {
      success: true, applicable: true, passed: true, score: 100, attemptNumber: attempts, skillLevels: {},
      certificate: { verification_code: 'MOCK-1234', issued_at: new Date().toISOString(), expires_at: null },
      engagement: null,
    });
  }
  if (path === '/functions/v1/ai-conversation' && req.method === 'POST') {
    const session = authenticate(req, res);
    if (!session) return log('ai-conversation 401');
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Body is not JSON' });
    }
    if (body.version !== undefined && body.version !== 0) log('ai-conversation: unexpected version', body.version);
    const persona = String(body.persona ?? '').trim();
    if (!persona) return send(res, 400, { error: 'This conversation has no character set up.' });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const learnerTurns = messages.filter((m) => m?.role === 'learner').length;
    const usage = { used: learnerTurns, limit: 100 };
    const mood = Array.isArray(body.moodStates) && body.moodStates[0]?.label ? body.moodStates[0].label : 'neutral';
    if (body.finalize) {
      const criteria = Array.isArray(body.criteria) ? body.criteria.map((c, i) => ({ id: c.id, score: 70 + ((i * 10) % 30), comment: `Mock judgement on "${c.label}".` })) : undefined;
      const score = criteria?.length ? Math.round(criteria.reduce((n, c) => n + c.score, 0) / criteria.length) : 85;
      log(`ai-conversation finalize: ${messages.length} messages, ${criteria?.length ?? 0} criteria -> score ${score}`);
      return send(res, 200, { assessment: { score, summary: `Mock assessment of ${learnerTurns} learner turn${learnerTurns === 1 ? '' : 's'}: clear enough, and honest.`, ...(criteria?.length ? { criteria } : {}), model: 'mock', promptVersion: '0', gradedAt: new Date().toISOString() }, degraded: false, overBudget: false, byo: false, usage });
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'learner') return send(res, 400, { error: 'Nothing to reply to.' });
    const line = String(last.content ?? '');
    if (/\bfail\b/i.test(line)) return send(res, 500, { error: 'The conversation hit a problem. Please try again.' });
    if (/\bdegrade\b/i.test(line)) {
      log('ai-conversation: degraded reply');
      return send(res, 200, { reply: 'Sorry, I need to wrap up here. Let\'s end the conversation and review how it went.', mood, degraded: true, capped: false, usage });
    }
    const reply = CANNED_REPLIES[(learnerTurns - 1) % CANNED_REPLIES.length];
    log(`ai-conversation turn ${learnerTurns}: "${line.slice(0, 40)}" -> "${reply.slice(0, 40)}"`);
    return send(res, 200, { reply, mood, degraded: false, overBudget: false, byo: false, usage });
  }
  send(res, 404, { error: `No route for ${req.method} ${path}` });
});

function listenReceiver() {
  receiverServer.listen(RECEIVER_PORT, () => {
    console.log(`mock receiver
${STATIC_PORT ? `  player:    http://localhost:${STATIC_PORT}/player/
  samples:   http://localhost:${STATIC_PORT}/mock/under-the-sink.ronu (zipped with its manifest, so it can be recorded)
` : ''}  receiver:  ${RECEIVER_ORIGIN}  (enter this under "change" in the player's connect dialog, or as --receiver when packaging)
  package key: ${MOCK_CUSTOMER_KEY}  (scorm-package.mjs --receiver ${RECEIVER_ORIGIN} --key ${MOCK_CUSTOMER_KEY} builds a connected package for this mock)
  sessions expire after ${SESSION_SECONDS}s so the refresh path runs; Ctrl+C stops${STATIC_PORT ? ' both servers' : ''}`);
  });
}

// --static 0: the receiver alone (the SCORM harness serves the package itself).
if (STATIC_PORT) staticServer.listen(STATIC_PORT, listenReceiver);
else listenReceiver();
