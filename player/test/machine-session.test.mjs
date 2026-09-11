// The machine launch (docs/record-receiver.md section 7): the package file,
// discovery with coordinates, the request built from SCORM values, the
// response mapping for every error code, the anonymous fallback, the whole
// exchange against a scripted fetch, and the end-of-run order (LMS first,
// one automatic send).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePackageConfig, readPackageConfig, parseDiscovery, discoverReceiver, learnerFromScorm, buildSessionRequest, mapSessionResponse,
  exchangeSession, machineConnect, connectedAs, offlineNotice, createEndSequence, SESSION_ERROR_MESSAGES, PACKAGE_FILE, ANONYMOUS_PREFIX,
} from '../machine-session.js';
import { ReceiverError, ReceiverClient } from '../receiver.js';

const ORIGIN = 'https://receiver.test';
const DISCOVERY = {
  ronuReceiver: 0, name: 'RonuNest', connect: '/player-connect',
  supabaseUrl: 'https://db.test', anonKey: 'anon-key',
  records: 'https://db.test/functions/v1/record-completion',
  conversation: 'https://db.test/functions/v1/ai-conversation',
  session: 'https://db.test/functions/v1/creator-api',
};
const PACKAGE = { version: 0, receiver: ORIGIN, key: 'cust-key-1', moduleId: 'mod-1', name: 'ronu player' };
const SESSION_OK = {
  success: true, version: 0,
  session: { access_token: 'at-1', refresh_token: 'rt-1', expires_at: 1_900_000_000, token_type: 'bearer' },
  user: { id: 'u-1', email: '', name: 'Dami Okafor' },
  learner: { created: true },
};

/** A fetch that answers from a script of `{status, body}` (or a thrown Error) in order and records every call. */
function scriptedFetch(script) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const step = script.shift();
    if (!step) throw new Error(`unexpected fetch ${url}`);
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    if (step instanceof Error) throw step;
    const text = step.body === undefined ? '' : typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    return { ok: step.status >= 200 && step.status < 300, status: step.status, text: async () => text, json: async () => JSON.parse(text) };
  };
  fetch.calls = calls;
  return fetch;
}

// ---- the package file -------------------------------------------------------

test('parsePackageConfig: the connected shape, from an object or JSON text', () => {
  assert.deepEqual(parsePackageConfig(PACKAGE), PACKAGE);
  assert.deepEqual(parsePackageConfig(JSON.stringify(PACKAGE)), PACKAGE);
  assert.equal(parsePackageConfig({ ...PACKAGE, receiver: 'receiver.test/' }).receiver, ORIGIN, 'the receiver is normalised to an origin');
  assert.equal(parsePackageConfig({ ...PACKAGE, name: undefined }).name, 'ronu player', 'the default player name');
  assert.equal(parsePackageConfig({ ...PACKAGE, receiver: 'http://localhost:8787' }).receiver, 'http://localhost:8787', 'plain http on localhost, for the mock');
});

test('parsePackageConfig: no key means self-contained; a key without a receiver, a bad receiver, a bad version or bad JSON is an error', () => {
  assert.equal(parsePackageConfig({ version: 0, receiver: ORIGIN }).key, null);
  assert.equal(parsePackageConfig({ version: 0 }).receiver, null);
  assert.throws(() => parsePackageConfig({ version: 0, key: 'k' }), (e) => e instanceof ReceiverError && e.code === 'bad-package' && /no receiver/.test(e.message));
  assert.throws(() => parsePackageConfig({ version: 0, key: 'k', receiver: 'http://evil.example' }), (e) => e.code === 'bad-package' && /https/.test(e.message));
  assert.throws(() => parsePackageConfig({ version: 1, key: 'k', receiver: ORIGIN }), (e) => e.code === 'bad-package' && /version 1/.test(e.message));
  assert.throws(() => parsePackageConfig('{not json'), (e) => e.code === 'bad-package' && /not JSON/.test(e.message));
  assert.throws(() => parsePackageConfig([]), (e) => e.code === 'bad-package');
});

test('readPackageConfig: read relative to the package root; 404 is a self-contained package, anything else broken is an error', async () => {
  const fetch = scriptedFetch([{ status: 200, body: PACKAGE }, { status: 404 }, { status: 500, body: 'boom' }, new Error('offline')]);
  assert.deepEqual(await readPackageConfig('https://lms.test/courses/42/', { fetch }), PACKAGE);
  assert.equal(fetch.calls[0].url, `https://lms.test/courses/42/${PACKAGE_FILE}`);
  assert.equal(await readPackageConfig('https://lms.test/courses/42', { fetch }), null, 'a root without a trailing slash still means the directory');
  assert.equal(fetch.calls[1].url, `https://lms.test/courses/42/${PACKAGE_FILE}`);
  await assert.rejects(readPackageConfig('https://lms.test/x/', { fetch }), (e) => e.code === 'bad-package' && /HTTP 500/.test(e.message));
  await assert.rejects(readPackageConfig('https://lms.test/x/', { fetch }), (e) => e.code === 'network');
});

// ---- discovery ----------------------------------------------------------------

test('parseDiscovery: the section 7 document, relative URLs resolved against the origin', () => {
  const d = parseDiscovery(DISCOVERY, ORIGIN);
  assert.deepEqual(d, { origin: ORIGIN, name: 'RonuNest', connect: `${ORIGIN}/player-connect`, ...Object.fromEntries(['supabaseUrl', 'records', 'conversation', 'session'].map((k) => [k, DISCOVERY[k]])), anonKey: 'anon-key' });
  const rel = parseDiscovery({ ...DISCOVERY, supabaseUrl: '/', session: '/functions/v1/creator-api' }, 'http://localhost:8787');
  assert.equal(rel.supabaseUrl, 'http://localhost:8787');
  assert.equal(rel.session, 'http://localhost:8787/functions/v1/creator-api');
});

test('parseDiscovery: a receiver without the coordinates cannot do a machine launch', () => {
  for (const key of ['supabaseUrl', 'anonKey', 'records', 'conversation', 'session']) {
    const doc = { ...DISCOVERY };
    delete doc[key];
    assert.throws(() => parseDiscovery(doc, ORIGIN), (e) => e instanceof ReceiverError && e.code === 'no-machine-launch' && e.message.includes(`"${key}"`), key);
  }
  assert.throws(() => parseDiscovery(null, ORIGIN), (e) => e.code === 'no-machine-launch');
  assert.throws(() => parseDiscovery({ ...DISCOVERY, session: 'https://' }, ORIGIN), (e) => e.code === 'no-machine-launch', 'a URL that cannot resolve');
});

test('discoverReceiver: GET /.well-known/ronu-receiver.json; missing, broken or unreachable is an error', async () => {
  const fetch = scriptedFetch([{ status: 200, body: DISCOVERY }, { status: 404 }, { status: 200, body: '<html>' }, new Error('dns')]);
  const d = await discoverReceiver(ORIGIN, { fetch });
  assert.equal(d.session, DISCOVERY.session);
  assert.equal(fetch.calls[0].url, `${ORIGIN}/.well-known/ronu-receiver.json`);
  await assert.rejects(discoverReceiver(ORIGIN, { fetch }), (e) => e.code === 'no-machine-launch' && /HTTP 404/.test(e.message));
  await assert.rejects(discoverReceiver(ORIGIN, { fetch }), (e) => e.code === 'no-machine-launch' && /broken/.test(e.message));
  await assert.rejects(discoverReceiver(ORIGIN, { fetch }), (e) => e.code === 'network');
});

// ---- the learner --------------------------------------------------------------

test('learnerFromScorm: student_id and student_name; no id means anonymous-<random>, flagged', () => {
  assert.deepEqual(learnerFromScorm({ studentId: 'learner-001', studentName: 'Dami Okafor' }), { externalId: 'learner-001', name: 'Dami Okafor', anonymous: false });
  assert.deepEqual(learnerFromScorm({ studentId: ' learner-001 ', studentName: '' }), { externalId: 'learner-001', name: null, anonymous: false });
  assert.deepEqual(learnerFromScorm({ studentId: '', studentName: 'Nameless' }, { random: () => 'abc123' }), { externalId: `${ANONYMOUS_PREFIX}abc123`, name: 'Nameless', anonymous: true });
  assert.deepEqual(learnerFromScorm(null, { random: () => 'x' }), { externalId: `${ANONYMOUS_PREFIX}x`, name: null, anonymous: true });
  const a = learnerFromScorm(null);
  const b = learnerFromScorm(null);
  assert.match(a.externalId, /^anonymous-[0-9a-f]{16}$/);
  assert.notEqual(a.externalId, b.externalId, 'each launch is a new anonymous learner');
});

// ---- the request --------------------------------------------------------------

test('buildSessionRequest: the section 7 body from SCORM values, the key in x-api-key', () => {
  const learner = learnerFromScorm({ studentId: 'learner-001', studentName: 'Dami Okafor' });
  const req = buildSessionRequest({ key: 'cust-key-1', learner, moduleId: 'mod-1', playerName: 'ronu player', playerOrigin: 'https://lms.test' });
  assert.deepEqual(req.headers, { 'x-api-key': 'cust-key-1', 'Content-Type': 'application/json' });
  assert.deepEqual(req.body, {
    action: 'player_session', version: 0,
    learner: { externalId: 'learner-001', name: 'Dami Okafor' },
    moduleId: 'mod-1',
    player: { name: 'ronu player', origin: 'https://lms.test' },
  });
  const anon = buildSessionRequest({ key: 'k', learner: { externalId: 'anonymous-1' }, moduleId: 'm', playerOrigin: 'https://lms.test' });
  assert.deepEqual(anon.body.learner, { externalId: 'anonymous-1' }, 'no name, no name field; no email, no email field');
  assert.equal(anon.body.player.name, 'ronu player');
  const mailed = buildSessionRequest({ key: 'k', learner: { externalId: 'e1', email: 'l@example.com' }, moduleId: 'm', playerOrigin: 'x' });
  assert.equal(mailed.body.learner.email, 'l@example.com');
  assert.throws(() => buildSessionRequest({ key: '', learner, moduleId: 'm', playerOrigin: 'x' }), (e) => e.code === 'bad-package');
  assert.throws(() => buildSessionRequest({ key: 'k', learner: { externalId: '' }, moduleId: 'm', playerOrigin: 'x' }), (e) => e.code === 'invalid_learner');
  assert.throws(() => buildSessionRequest({ key: 'k', learner, moduleId: null, playerOrigin: 'x' }), (e) => e.code === 'bad-package' && /module id/.test(e.message));
});

// ---- the response -------------------------------------------------------------

test('mapSessionResponse: a 200 with success becomes the connection the popup handshake would deliver', () => {
  const discovery = parseDiscovery(DISCOVERY, ORIGIN);
  const c = mapSessionResponse(200, SESSION_OK, discovery);
  assert.deepEqual(c.receiver, { name: 'RonuNest', origin: ORIGIN, supabaseUrl: 'https://db.test', anonKey: 'anon-key', records: DISCOVERY.records, conversation: DISCOVERY.conversation });
  assert.deepEqual(c.session, SESSION_OK.session);
  assert.deepEqual(c.user, { id: 'u-1', email: '', name: 'Dami Okafor' });
  assert.deepEqual(c.learner, { created: true });
  assert.equal(mapSessionResponse(200, { ...SESSION_OK, learner: {} }, discovery).learner.created, false);
  // It is a real connection: the client refreshes and calls through it exactly as after a popup.
  const client = new ReceiverClient(c, { fetch: async () => ({ ok: true, status: 200, text: async () => '{"passed":true,"score":100}' }), now: () => 1_800_000_000_000 });
  assert.equal(client.receiver.records, DISCOVERY.records);
  assert.equal(client.session.access_token, 'at-1');
});

test('mapSessionResponse: a success without a usable session is rejected', () => {
  const discovery = parseDiscovery(DISCOVERY, ORIGIN);
  assert.throws(() => mapSessionResponse(200, { ...SESSION_OK, session: { access_token: 'x' } }, discovery), (e) => e.code === 'invalid-connection' && /refresh token/.test(e.message));
  assert.throws(() => mapSessionResponse(200, { ...SESSION_OK, session: undefined }, discovery), (e) => e.code === 'invalid-connection');
  assert.throws(() => mapSessionResponse(200, { ...SESSION_OK, version: 7 }, discovery), (e) => e.code === 'rejected' && /version 7/.test(e.message));
});

test('mapSessionResponse: every errorCode, whether it comes as 401/403/404 or as a 200 with success false', () => {
  const discovery = parseDiscovery(DISCOVERY, ORIGIN);
  const cases = [
    ['unauthorized', 401], ['tier_required', 403], ['invalid_learner', 400], ['module_not_found', 404], ['module_not_owned', 403],
    ['unauthorized', 200], ['tier_required', 200], ['invalid_learner', 200], ['module_not_found', 200], ['module_not_owned', 200],
  ];
  for (const [code, status] of cases) {
    assert.throws(() => mapSessionResponse(status, { success: false, error: 'server words', errorCode: code }, discovery), (e) => e instanceof ReceiverError && e.code === code && e.status === status && e.message === SESSION_ERROR_MESSAGES[code], `${code} at ${status}`);
  }
  assert.equal(Object.keys(SESSION_ERROR_MESSAGES).length, 5, 'the five codes the contract names');
});

test('mapSessionResponse: answers without an errorCode fall back on the status', () => {
  const discovery = parseDiscovery(DISCOVERY, ORIGIN);
  assert.throws(() => mapSessionResponse(401, { error: 'Invalid API key' }, discovery), (e) => e.code === 'unauthorized' && e.message === 'Invalid API key');
  assert.throws(() => mapSessionResponse(403, null, discovery), (e) => e.code === 'unauthorized' && e.message === SESSION_ERROR_MESSAGES.unauthorized);
  assert.throws(() => mapSessionResponse(404, {}, discovery), (e) => e.code === 'module_not_found');
  assert.throws(() => mapSessionResponse(500, { error: 'db down' }, discovery), (e) => e.code === 'server' && e.message === 'db down');
  assert.throws(() => mapSessionResponse(502, null, discovery), (e) => e.code === 'server' && /502/.test(e.message));
  assert.throws(() => mapSessionResponse(200, { success: false }, discovery), (e) => e.code === 'rejected' && /200 without a session/.test(e.message));
  assert.throws(() => mapSessionResponse(400, { errorCode: 'something_new', error: 'new words' }, discovery), (e) => e.code === 'rejected' && e.message === 'new words', 'an unknown code keeps the server\'s words');
});

// ---- the exchange -------------------------------------------------------------

test('exchangeSession: POSTs the request to the discovered session endpoint and maps the answer', async () => {
  const discovery = parseDiscovery(DISCOVERY, ORIGIN);
  const fetch = scriptedFetch([{ status: 200, body: SESSION_OK }, { status: 401, body: { success: false, error: 'nope', errorCode: 'unauthorized' } }, new Error('offline')]);
  const learner = learnerFromScorm({ studentId: 'learner-001', studentName: 'Dami Okafor' });
  const c = await exchangeSession({ discovery, key: 'cust-key-1', learner, moduleId: 'mod-1', playerName: 'ronu player', playerOrigin: 'https://lms.test', fetch });
  assert.equal(c.user.name, 'Dami Okafor');
  assert.equal(fetch.calls[0].url, DISCOVERY.session);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].headers['x-api-key'], 'cust-key-1');
  assert.equal(fetch.calls[0].body.action, 'player_session');
  assert.equal(fetch.calls[0].body.learner.externalId, 'learner-001');
  await assert.rejects(exchangeSession({ discovery, key: 'bad', learner, moduleId: 'mod-1', playerOrigin: 'x', fetch }), (e) => e.code === 'unauthorized');
  await assert.rejects(exchangeSession({ discovery, key: 'k', learner, moduleId: 'mod-1', playerOrigin: 'x', fetch }), (e) => e.code === 'network' && /could not reach RonuNest/.test(e.message));
});

test('machineConnect: package file, discovery, exchange, in that order, with what each needs', async () => {
  const fetch = scriptedFetch([{ status: 200, body: PACKAGE }, { status: 200, body: DISCOVERY }, { status: 200, body: SESSION_OK }]);
  const learner = learnerFromScorm({ studentId: 'learner-001', studentName: 'Dami Okafor' });
  const out = await machineConnect({ packageRoot: 'https://lms.test/pkg/', learner, playerOrigin: 'https://lms.test', fetch });
  assert.deepEqual(fetch.calls.map((c) => [c.method, c.url]), [
    ['GET', `https://lms.test/pkg/${PACKAGE_FILE}`],
    ['GET', `${ORIGIN}/.well-known/ronu-receiver.json`],
    ['POST', DISCOVERY.session],
  ]);
  assert.equal(fetch.calls[2].headers['x-api-key'], 'cust-key-1');
  assert.deepEqual(fetch.calls[2].body, { action: 'player_session', version: 0, learner: { externalId: 'learner-001', name: 'Dami Okafor' }, moduleId: 'mod-1', player: { name: 'ronu player', origin: 'https://lms.test' } });
  assert.equal(out.connection.session.access_token, 'at-1');
  assert.equal(out.connection.receiver.origin, ORIGIN);
  assert.deepEqual(out.config, PACKAGE);
  assert.equal(out.discovery.name, 'RonuNest');
  assert.equal(out.learner, learner);
  assert.equal(connectedAs(out.connection, learner), 'Dami Okafor');
});

test('machineConnect: no package file, or one without a key, is a self-contained launch (null), nothing else fetched', async () => {
  const none = scriptedFetch([{ status: 404 }]);
  assert.equal(await machineConnect({ packageRoot: 'https://lms.test/pkg/', learner: learnerFromScorm(null), playerOrigin: 'x', fetch: none }), null);
  assert.equal(none.calls.length, 1);
  const keyless = scriptedFetch([{ status: 200, body: { version: 0, receiver: ORIGIN } }]);
  assert.equal(await machineConnect({ packageRoot: 'https://lms.test/pkg/', learner: learnerFromScorm(null), playerOrigin: 'x', fetch: keyless }), null);
  assert.equal(keyless.calls.length, 1);
});

test('machineConnect: the package file may leave the module id to the bundled manifest; a config can be passed in', async () => {
  const fetch = scriptedFetch([{ status: 200, body: DISCOVERY }, { status: 200, body: SESSION_OK }]);
  const out = await machineConnect({ packageRoot: 'x/', learner: learnerFromScorm(null, { random: () => 'r' }), playerOrigin: 'x', moduleId: 'from-manifest', fetch, config: { ...PACKAGE, moduleId: null } });
  assert.equal(fetch.calls[1].body.moduleId, 'from-manifest');
  assert.equal(fetch.calls[1].body.learner.externalId, 'anonymous-r');
  assert.equal(out.learner.anonymous, true);
});

test('machineConnect: failures surface as one ReceiverError the caller shows, and a hung receiver times out', async () => {
  const learner = learnerFromScorm(null, { random: () => 'r' });
  const refused = scriptedFetch([{ status: 200, body: PACKAGE }, { status: 200, body: DISCOVERY }, { status: 403, body: { success: false, errorCode: 'tier_required' } }]);
  await assert.rejects(machineConnect({ packageRoot: 'https://lms.test/pkg/', learner, playerOrigin: 'x', fetch: refused }), (e) => e.code === 'tier_required');
  const popupOnly = scriptedFetch([{ status: 200, body: PACKAGE }, { status: 200, body: { ronuReceiver: 0, name: 'Old', connect: '/player-connect' } }]);
  await assert.rejects(machineConnect({ packageRoot: 'https://lms.test/pkg/', learner, playerOrigin: 'x', fetch: popupOnly }), (e) => e.code === 'no-machine-launch');
  await assert.rejects(readPackageConfig('not-a-root/', { fetch: scriptedFetch([]) }), (e) => e.code === 'bad-package' && /package root/.test(e.message));
  const hung = async () => new Promise(() => {});
  await assert.rejects(machineConnect({ packageRoot: 'x/', learner, playerOrigin: 'x', fetch: hung, timeoutMs: 20, config: PACKAGE }), (e) => e.code === 'network' && /longer than/.test(e.message));
  assert.equal(offlineNotice(new ReceiverError('the package\'s key was not accepted (it may have been revoked).', { code: 'unauthorized' })), 'Could not connect to RonuNest: the package\'s key was not accepted (it may have been revoked). Playing offline.');
  assert.equal(offlineNotice(new Error('boom'), 'Mock'), 'Could not connect to Mock: boom. Playing offline.');
});

test('connectedAs: the receiver\'s name, else the email, else what the LMS said, else the id', () => {
  assert.equal(connectedAs({ user: { name: 'Dami', email: 'd@x' } }, { name: 'L' }), 'Dami');
  assert.equal(connectedAs({ user: { name: '', email: 'd@x' } }, { name: 'L' }), 'd@x');
  assert.equal(connectedAs({ user: {} }, { name: 'L', externalId: 'e' }), 'L');
  assert.equal(connectedAs({ user: {} }, { externalId: 'anonymous-1' }), 'anonymous-1');
  assert.equal(connectedAs(null, null), 'a learner');
});

// ---- the end of a run ---------------------------------------------------------

test('createEndSequence: the LMS report first, then exactly one automatic send, never again in the same launch', async () => {
  const order = [];
  const seq = createEndSequence({
    report: (view) => order.push(`lms:${view.id}`),
    canSend: () => true,
    send: async () => { order.push('send'); return { score: 100 }; },
  });
  const p = seq.onEnd({ id: 1 });
  assert.deepEqual(order, ['lms:1'], 'the report has run before the send is even scheduled');
  assert.deepEqual(await p, { score: 100 });
  assert.deepEqual(order, ['lms:1', 'send']);
  assert.equal(seq.started, true);
  // Play again reaches the end again: the LMS hook runs (it marks a practice run), the send does not.
  assert.equal(await seq.onEnd({ id: 2 }), null);
  assert.deepEqual(order, ['lms:1', 'send', 'lms:2']);
  assert.deepEqual(seq.result, { score: 100 });
});

test('createEndSequence: not connected means the report alone; a refused send or a throwing report never breaks the other', async () => {
  const order = [];
  const offline = createEndSequence({ report: () => order.push('lms'), canSend: () => false, send: async () => order.push('send') });
  assert.equal(await offline.onEnd({}), null);
  assert.deepEqual(order, ['lms']);
  assert.equal(offline.started, false, 'a launch that connects later could still send');
  const failing = createEndSequence({ report: () => { throw new Error('LMS threw'); }, canSend: () => true, send: async () => { throw new Error('receiver refused'); } });
  assert.equal(await failing.onEnd({}), null);
  assert.equal(failing.started, true, 'one attempt, even a failed one; the end screen keeps the manual button');
  assert.equal(await failing.onEnd({}), null);
});
