// The record receiver bridge (docs/record-receiver.md): the session record
// body, the session refresh, the connect message rules, the once-only send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../engine.js';
import {
  ReceiverClient, ReceiverError, buildRecordBody, slimRecordBody, recordModuleId, validateConnectEvent, parseConnection,
  encodeConnectionCode, decodeConnectionCode, discoverConnectUrl, buildConnectUrl, normalizeOrigin, certificateUrl, createRecordSender,
  describeRecordFailure, REFRESH_WINDOW_SECONDS,
} from '../receiver.js';
import { loadSample, fakeClock } from './helpers.mjs';

const NOW = 1_800_000_000_000;

function connection(overrides = {}) {
  return {
    receiver: { name: 'Mock', origin: 'https://receiver.test', supabaseUrl: 'https://db.test', anonKey: 'anon-key', records: 'https://db.test/functions/v1/record-completion', conversation: 'https://db.test/functions/v1/ai-conversation' },
    session: { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: Math.floor(NOW / 1000) + 3600, token_type: 'bearer' },
    user: { id: 'u1', email: 'learner@example.com', name: 'Learner' },
    ...overrides,
  };
}

/** A fetch that answers from a script of `{status, body}` in order and records every call. */
function scriptedFetch(script) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const step = script.shift();
    if (!step) throw new Error(`unexpected fetch ${url}`);
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    if (step instanceof Error) throw step;
    return { ok: step.status >= 200 && step.status < 300, status: step.status, text: async () => (step.body === undefined ? '' : JSON.stringify(step.body)), json: async () => step.body };
  };
  fetch.calls = calls;
  return fetch;
}

/** A full play of barrier-cream-round with the conversation assessed. */
function playBarrierCream(now) {
  const { module, manifest } = loadSample('barrier-cream-round');
  const e = new Engine(module, { now, services: { conversation: true } });
  let v = e.start();
  now.advance(1000);
  v = e.continue();
  for (const it of v.config.dragItems) if (it.targetId) e.placeItem(it.id, it.targetId);
  e.submitPlacements();
  now.advance(1000);
  v = e.continue();
  for (let i = 0; i < 7; i++) e.performStep(i);
  now.advance(1000);
  v = e.continue();
  assert.equal(v.type, 'conversation');
  assert.equal(v.supported, true, 'a conversation is live while a receiver is connected');
  assert.equal(v.canContinue, false, 'a live conversation must be ended first');
  e.answerConversation({ messages: [{ role: 'character', content: 'Hi' }, { role: 'learner', content: 'Barrier cream, for her heels.' }], assessment: { score: 72, summary: 'Clear and honest.' } });
  now.advance(1000);
  v = e.continue();
  v = e.continue();
  assert.equal(v.kind, 'end');
  return { e, manifest };
}

test('the record body is the section 3 shape, built from a real engine run', () => {
  const now = fakeClock(NOW);
  const { e, manifest } = playBarrierCream(now);
  const body = buildRecordBody(e, manifest);
  assert.deepEqual(body, {
    moduleId: 'c4d1a2e6-8b3f-4f7a-9d21-5e6f7a8b9c0d',
    responses: {
      prep: { answer: { 'i-gloves': 't-trolley', 'i-cream': 't-trolley', 'i-mar': 't-trolley', 'i-old-gloves': 't-clinical', 'i-keys': 't-station' }, score: 100 },
      apply: { answer: { order: [0, 1, 2, 3, 4, 5, 6], missteps: [], halted: false }, score: 100 },
      explain: { answer: { messages: [{ role: 'character', content: 'Hi' }, { role: 'learner', content: 'Barrier cream, for her heels.' }], assessment: { score: 72, summary: 'Clear and honest.' } }, score: 72 },
    },
    path: [
      { nodeId: 'intro', enteredAt: '2027-01-15T08:00:00.000Z' },
      { nodeId: 'prep', enteredAt: '2027-01-15T08:00:01.000Z' },
      { nodeId: 'apply', enteredAt: '2027-01-15T08:00:02.000Z' },
      { nodeId: 'check', enteredAt: '2027-01-15T08:00:03.000Z' },
      { nodeId: 'explain', enteredAt: '2027-01-15T08:00:03.000Z' },
      { nodeId: 'done', enteredAt: '2027-01-15T08:00:04.000Z' },
    ],
    variableState: { missteps: 0, critical_failure: false, explain_score: 72 },
  });
  assert.deepEqual(Object.keys(body), ['moduleId', 'responses', 'path', 'variableState'], 'nothing else rides along: no verdict, no statements');
  assert.doesNotThrow(() => JSON.stringify(body));
  // The conversation's score reached the score variable through a set action.
  assert.ok(e.events.some((x) => x.type === 'variable' && x.variableId === 'explain_score' && x.to === 72 && x.source === 'conversation'));
});

test('answered nodes without a grade carry no score; unanswered nodes are absent', () => {
  const { module, manifest } = loadSample('hello-ronu');
  const e = new Engine(module);
  e.start();
  e.continue();
  e.choose('c_yes');
  const body = buildRecordBody(e, { ...manifest, module: { ...manifest.module, versionId: 'v-1' } });
  assert.deepEqual(body.responses, { q1: { answer: 'c_yes' } });
  assert.equal(body.moduleId, 'v-1');
});

test('module id: manifest.module.id, else versionId; a synthesised manifest cannot be recorded', () => {
  assert.equal(recordModuleId({ module: { id: 'm-1', versionId: 'v-1' } }), 'm-1');
  assert.equal(recordModuleId({ module: { versionId: 'v-1', familyId: 'f-1' } }), 'v-1');
  assert.equal(recordModuleId({ module: { familyId: 'local:module.json' } }), null);
  assert.equal(recordModuleId({ module: { familyId: 'f-1' } }), null, 'the family id is not a module row');
  const e = new Engine(loadSample('hello-ronu').module);
  e.start();
  assert.throws(() => buildRecordBody(e, { module: { familyId: 'local:x' }, synthesized: true }), (err) => err instanceof ReceiverError && err.code === 'no-module-id');
});

test('413: bulky answers are dropped, scores kept, and the send retried once', async () => {
  const now = fakeClock(NOW);
  const { e, manifest } = playBarrierCream(now);
  const body = buildRecordBody(e, manifest);
  const big = { ...body, responses: { ...body.responses, explain: { answer: { messages: Array.from({ length: 40 }, (_, i) => ({ role: 'learner', content: `line ${i} `.repeat(20) })) }, score: 72 } } };
  const slim = slimRecordBody(big);
  assert.notEqual(slim, big);
  assert.deepEqual(slim.responses.explain, { score: 72 });
  assert.deepEqual(slim.responses.prep, big.responses.prep, 'small answers survive');
  assert.equal(slimRecordBody(body), body, 'nothing to drop: the same object, so the retry is skipped');

  const fetch = scriptedFetch([{ status: 413, body: { error: 'Payload too large' } }, { status: 200, body: { success: true, passed: true, score: 91, certificate: null } }]);
  const client = new ReceiverClient(connection(), { fetch, now });
  const r = await client.sendRecord(big);
  assert.equal(r.slimmed, true);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[1].body.responses.explain, { score: 72 });
  assert.equal(r.result.passed, true);
});

test('an expired session is refreshed before the call, then the call is made with the new token', async () => {
  const now = fakeClock(NOW);
  const conn = connection({ session: { access_token: 'old', refresh_token: 'refresh-old', expires_at: Math.floor(NOW / 1000) + REFRESH_WINDOW_SECONDS - 5, token_type: 'bearer' } });
  const fetch = scriptedFetch([
    { status: 200, body: { access_token: 'new', refresh_token: 'refresh-new', expires_in: 3600, token_type: 'bearer', user: { id: 'u1' } } },
    { status: 200, body: { success: true, passed: false, score: 40, certificate: null } },
  ]);
  const saved = [];
  const client = new ReceiverClient(conn, { fetch, now, onSession: (c) => saved.push(c.session) });
  const r = await client.sendRecord({ moduleId: 'm', responses: {}, path: [], variableState: {} });
  assert.equal(r.result.passed, false);
  assert.equal(fetch.calls[0].url, 'https://db.test/auth/v1/token?grant_type=refresh_token');
  assert.equal(fetch.calls[0].headers.apikey, 'anon-key');
  assert.deepEqual(fetch.calls[0].body, { refresh_token: 'refresh-old' });
  assert.equal(fetch.calls[1].url, conn.receiver.records);
  assert.equal(fetch.calls[1].headers.Authorization, 'Bearer new');
  assert.equal(fetch.calls[1].headers.apikey, 'anon-key');
  assert.equal(fetch.calls[1].headers['Content-Type'], 'application/json');
  assert.equal(saved.length, 1, 'the new session was handed back to be stored');
  assert.equal(saved[0].refresh_token, 'refresh-new');
  assert.equal(saved[0].expires_at, Math.floor(NOW / 1000) + 3600, 'expires_at derived from expires_in');
  assert.equal(client.sessionExpiresSoon(), false);
});

test('a failed refresh disconnects with a clear message and the call is not made', async () => {
  const now = fakeClock(NOW);
  const conn = connection({ session: { access_token: 'old', refresh_token: 'stale', expires_at: Math.floor(NOW / 1000) + 10, token_type: 'bearer' } });
  const fetch = scriptedFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid Refresh Token' } }]);
  const gone = [];
  const client = new ReceiverClient(conn, { fetch, now, onDisconnect: (m) => gone.push(m) });
  await assert.rejects(() => client.sendRecord({ moduleId: 'm', responses: {}, path: [], variableState: {} }), (err) => err instanceof ReceiverError && err.code === 'disconnected');
  assert.equal(fetch.calls.length, 1, 'only the refresh was attempted');
  assert.equal(gone.length, 1);
  assert.match(gone[0], /Invalid Refresh Token/);
  assert.equal(client.dead, true);
  await assert.rejects(() => client.sendRecord({ moduleId: 'm' }), /Connect again/);
});

test('a 401 from the endpoint refreshes and retries once; a second 401 disconnects', async () => {
  const now = fakeClock(NOW);
  let fetch = scriptedFetch([
    { status: 401, body: { error: 'Not authenticated' } },
    { status: 200, body: { access_token: 'fresh', refresh_token: 'refresh-2', expires_at: Math.floor(NOW / 1000) + 3600 } },
    { status: 200, body: { success: true, passed: true, score: 100, certificate: { verification_code: 'ABC-123', issued_at: '2027-01-15T08:00:05.000Z', expires_at: null } } },
  ]);
  let client = new ReceiverClient(connection(), { fetch, now });
  const r = await client.sendRecord({ moduleId: 'm', responses: {}, path: [], variableState: {} });
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[2].headers.Authorization, 'Bearer fresh');
  assert.deepEqual(r.result.certificate, { verification_code: 'ABC-123', issued_at: '2027-01-15T08:00:05.000Z', expires_at: null });
  assert.equal(certificateUrl(client.connection, 'ABC-123'), 'https://receiver.test/certificates/ABC-123');

  fetch = scriptedFetch([
    { status: 401, body: { error: 'Not authenticated' } },
    { status: 200, body: { access_token: 'fresh', refresh_token: 'refresh-2', expires_at: Math.floor(NOW / 1000) + 3600 } },
    { status: 401, body: { error: 'Not authenticated' } },
  ]);
  const gone = [];
  client = new ReceiverClient(connection(), { fetch, now, onDisconnect: (m) => gone.push(m) });
  await assert.rejects(() => client.sendRecord({ moduleId: 'm' }), (err) => err.code === 'disconnected');
  assert.equal(gone.length, 1);
});

test('403, 404, 5xx and a network failure map to the section 3 behaviours', async () => {
  const now = fakeClock(NOW);
  const cases = [
    [{ status: 403, body: { error: "You don't have access to this module." } }, 'forbidden', false],
    [{ status: 404, body: { error: 'Module not found' } }, 'not-found', false],
    [{ status: 500, body: { error: 'Could not record the completion.' } }, 'server', true],
    [new TypeError('Failed to fetch'), 'network', true],
  ];
  for (const [step, code, retryable] of cases) {
    const client = new ReceiverClient(connection(), { fetch: scriptedFetch([step]), now });
    await assert.rejects(() => client.sendRecord({ moduleId: 'm' }), (err) => err instanceof ReceiverError && err.code === code);
    if (!(step instanceof Error)) assert.equal(describeRecordFailure(step.status, step.body).retryable, retryable);
  }
  assert.match(describeRecordFailure(404, null).message, /does not have this module/);
  assert.match(describeRecordFailure(403, { error: 'No access' }).message, /No access/);
});

test('the connect message is accepted only from the receiver origin, only while waiting, only when well formed', () => {
  const data = { type: 'ronu-receiver-connect', version: 0, ...connection() };
  assert.equal(validateConnectEvent({ origin: 'https://evil.test', data }, 'https://receiver.test'), null, 'wrong origin ignored');
  assert.equal(validateConnectEvent({ origin: 'https://receiver.test', data }, 'https://receiver.test', { waiting: false }), null, 'not waiting: ignored');
  assert.equal(validateConnectEvent({ origin: 'https://receiver.test', data: { type: 'other' } }, 'https://receiver.test'), null, 'other message types ignored');
  assert.equal(validateConnectEvent({ origin: 'https://receiver.test', data: { ...data, version: 1 } }, 'https://receiver.test'), null, 'a future contract version is not accepted');
  assert.equal(validateConnectEvent({ origin: 'https://receiver.test', data: { ...data, session: { access_token: 'x' } } }, 'https://receiver.test'), null, 'missing refresh token');
  const ok = validateConnectEvent({ origin: 'https://receiver.test', data }, 'https://receiver.test');
  assert.deepEqual(ok, connection());
  assert.throws(() => parseConnection({ ...data, receiver: { ...data.receiver, records: 'not a url' } }), /receiver\.records/);
  // Trailing slashes are trimmed so URLs compose cleanly; a null expires_at is kept as unknown.
  const trimmed = parseConnection({ ...data, receiver: { ...data.receiver, supabaseUrl: 'https://db.test/' }, session: { ...data.session, expires_at: null } });
  assert.equal(trimmed.receiver.supabaseUrl, 'https://db.test');
  assert.equal(trimmed.session.expires_at, null);
  assert.equal(new ReceiverClient(trimmed, { now: () => NOW }).sessionExpiresSoon(), false, 'unknown expiry is left to the 401 path');
});

test('a pasted connection code round-trips (base64url of the message JSON)', () => {
  const message = { type: 'ronu-receiver-connect', version: 0, ...connection() };
  const code = encodeConnectionCode(message);
  assert.match(code, /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
  assert.deepEqual(decodeConnectionCode(`  ${code}\n`), connection());
  assert.throws(() => decodeConnectionCode('not base64!!'), /not a connection code/);
  assert.throws(() => decodeConnectionCode(''), /Paste/);
});

test('discovery reads .well-known, resolves a relative connect page, and falls back to /player-connect', async () => {
  const found = await discoverConnectUrl('https://receiver.test', { fetch: scriptedFetch([{ status: 200, body: { ronuReceiver: 0, name: 'RonuNest', connect: '/player-connect' } }]) });
  assert.deepEqual(found, { connect: 'https://receiver.test/player-connect', name: 'RonuNest', discovered: true });
  const absolute = await discoverConnectUrl('https://receiver.test', { fetch: scriptedFetch([{ status: 200, body: { connect: 'https://app.receiver.test/connect' } }]) });
  assert.equal(absolute.connect, 'https://app.receiver.test/connect');
  const missing = await discoverConnectUrl('https://receiver.test', { fetch: scriptedFetch([{ status: 404 }]) });
  assert.deepEqual(missing, { connect: 'https://receiver.test/player-connect', name: null, discovered: false });
  const down = await discoverConnectUrl('https://receiver.test', { fetch: scriptedFetch([new TypeError('Failed to fetch')]) });
  assert.equal(down.discovered, false);
  const url = new URL(buildConnectUrl('https://receiver.test/player-connect', { playerOrigin: 'http://localhost:8000' }));
  assert.equal(url.searchParams.get('origin'), 'http://localhost:8000');
  assert.equal(url.searchParams.get('name'), 'ronu reference player');
});

test('receiver origins: scheme optional, path dropped, plain http only on localhost', () => {
  assert.equal(normalizeOrigin('ronunest.com'), 'https://ronunest.com');
  assert.equal(normalizeOrigin('https://ronunest.com/some/page'), 'https://ronunest.com');
  assert.equal(normalizeOrigin('http://localhost:8787/'), 'http://localhost:8787');
  assert.throws(() => normalizeOrigin('http://receiver.test'), /https/);
  assert.throws(() => normalizeOrigin(''), /Enter/);
});

test('a session is never sent twice', async () => {
  const now = fakeClock(NOW);
  const fetch = scriptedFetch([{ status: 200, body: { success: true, passed: true, score: 100, certificate: { verification_code: 'MOCK-1', issued_at: 'x', expires_at: null } } }]);
  const sender = createRecordSender(new ReceiverClient(connection(), { fetch, now }));
  const body = { moduleId: 'm', responses: {}, path: [], variableState: {} };
  const first = await sender.send(body);
  assert.equal(first.certificate.verification_code, 'MOCK-1');
  assert.equal(first.at, NOW);
  await assert.rejects(() => sender.send(body), (err) => err instanceof ReceiverError && err.code === 'already-sent');
  assert.equal(fetch.calls.length, 1, 'the second send never reached the network');
  assert.equal(sender.sent, first);
  sender.reset();
  assert.equal(sender.sent, null, 'a new session may be sent');
});

test('a failed send leaves the record unsent so it can be retried', async () => {
  const now = fakeClock(NOW);
  const fetch = scriptedFetch([new TypeError('Failed to fetch'), { status: 200, body: { passed: null, score: null, certificate: null } }]);
  const sender = createRecordSender(new ReceiverClient(connection(), { fetch, now }));
  await assert.rejects(() => sender.send({ moduleId: 'm' }), (err) => err.code === 'network');
  assert.equal(sender.sent, null);
  const r = await sender.send({ moduleId: 'm' });
  assert.equal(r.passed, null);
  assert.equal(fetch.calls.length, 2);
});

test('logout posts to GoTrue with both headers and never throws', async () => {
  const fetch = scriptedFetch([{ status: 204 }]);
  const client = new ReceiverClient(connection(), { fetch, now: () => NOW });
  await client.logout();
  assert.equal(fetch.calls[0].url, 'https://db.test/auth/v1/logout');
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer access-1');
  assert.equal(fetch.calls[0].headers.apikey, 'anon-key');
  const broken = new ReceiverClient(connection(), { fetch: scriptedFetch([new TypeError('offline')]), now: () => NOW });
  await broken.logout();
  assert.equal(broken.dead, true);
});
