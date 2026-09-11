// The SCORM 1.2 adapter against a fake LMS: discovery through a frame chain
// and an opener, the session lifecycle in order, the value formats, and the
// guarantee that a broken LMS never throws into the player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findApi, createScormSession, formatSessionTime, compactSuspendData, outcomeFor, statusFor, MAX_API_DEPTH } from '../scorm.js';
import { Engine } from '../engine.js';
import { loadSample, fakeClock } from './helpers.mjs';

/** A fake window: `parent` defaults to itself (a top window), like a browser's. */
function win(props = {}) {
  const w = { API: undefined, opener: null, ...props };
  if (!('parent' in props)) w.parent = w;
  if (!('top' in props)) w.top = w;
  return w;
}

/** A logging SCORM 1.2 API with a small data model. `opts.fail` lists elements whose set is refused. */
function fakeApi(opts = {}) {
  const cmi = {
    'cmi.core.student_name': 'Okafor, Dami', 'cmi.core.lesson_status': 'not attempted', 'cmi.suspend_data': '', 'cmi.core.lesson_location': '',
    'cmi.core.score.raw': '', 'cmi.core.score.min': '', 'cmi.core.score.max': '', 'cmi.core.session_time': '', 'cmi.core.exit': '', ...(opts.cmi ?? {}),
  };
  const log = [];
  let lastError = '0';
  let initialised = false;
  const api = {
    cmi, log,
    LMSInitialize(s) { log.push(['LMSInitialize', s]); if (initialised) { lastError = '101'; return 'false'; } initialised = true; lastError = '0'; return 'true'; },
    LMSFinish(s) { log.push(['LMSFinish', s]); initialised = false; lastError = '0'; return 'true'; },
    LMSGetValue(el) { log.push(['LMSGetValue', el]); if (!(el in cmi)) { lastError = '201'; return ''; } lastError = '0'; return cmi[el]; },
    LMSSetValue(el, v) { log.push(['LMSSetValue', el, v]); if ((opts.fail ?? []).includes(el)) { lastError = '405'; return 'false'; } cmi[el] = v; lastError = '0'; return 'true'; },
    LMSCommit(s) { log.push(['LMSCommit', s]); lastError = '0'; return 'true'; },
    LMSGetLastError() { return lastError; },
    LMSGetErrorString(c) { return { '0': 'No error', '101': 'General exception', '201': 'Invalid argument error', '405': 'Incorrect data type' }[c] ?? ''; },
    LMSGetDiagnostic() { return ''; },
  };
  return api;
}

// ---- discovery -------------------------------------------------------------

test('findApi: walks parent frames to the API and stops at the top', () => {
  const api = fakeApi();
  const top = win({ API: api });
  const lms = win({ parent: top, top });
  const launch = win({ parent: lms, top });
  const player = win({ parent: launch, top });
  assert.equal(findApi(player), api);
  assert.equal(findApi(win()), null, 'a lone top window with no API');
});

test('findApi: ignores an API-shaped object without LMSInitialize, and gives up past the depth limit', () => {
  const top = win({ API: { hello: 1 } });
  const child = win({ parent: top, top });
  assert.equal(findApi(child), null);
  // A chain deeper than MAX_API_DEPTH with the API at the far end is not found.
  let w = win({ API: fakeApi() });
  for (let i = 0; i < MAX_API_DEPTH + 2; i++) w = win({ parent: w });
  assert.equal(findApi(w), null);
});

test('findApi: falls back to the opener and its parents, and survives cross-origin throws', () => {
  const api = fakeApi();
  const openerTop = win({ API: api });
  const opener = win({ parent: openerTop, top: openerTop });
  const popup = win({ opener });
  assert.equal(findApi(popup), api);
  // The top window's opener counts too (a popup whose own opener is null but whose top has one).
  const top2 = win({ opener });
  const inner = win({ parent: top2, top: top2 });
  assert.equal(findApi(inner), api);
  // A cross-origin parent throws on every property read.
  const hostile = new Proxy({}, { get() { throw new Error('SecurityError'); } });
  const framed = win({ parent: hostile, top: hostile });
  assert.equal(findApi(framed), null);
  assert.equal(findApi(null), null);
});

// ---- formats ---------------------------------------------------------------

test('formatSessionTime is HHHH:MM:SS.SS', () => {
  assert.equal(formatSessionTime(0), '0000:00:00.00');
  assert.equal(formatSessionTime(1234), '0000:00:01.23');
  assert.equal(formatSessionTime(61_000 + 5_678), '0000:01:06.68');
  assert.equal(formatSessionTime(3_600_000 * 12 + 60_000 * 34 + 56_780), '0012:34:56.78');
  assert.equal(formatSessionTime(-5), '0000:00:00.00');
  assert.equal(formatSessionTime(NaN), '0000:00:00.00');
  assert.match(formatSessionTime(3_600_000 * 12345), /^12345:00:00\.00$/, 'hours grow past four digits rather than wrapping');
});

test('compactSuspendData stays under the ceiling and keeps the node id first', () => {
  const small = compactSuspendData({ nodeId: 'q1', trail: ['welcome', 'q1'], values: { v_score: 1, name: 'Dami', ok: true, obj: { nested: 1 } } });
  assert.deepEqual(JSON.parse(small), { n: 'q1', t: ['welcome', 'q1'], v: { v_score: 1, name: 'Dami', ok: true } }, 'objects are left out');
  const trail = Array.from({ length: 2000 }, (_, i) => `node-${i}`);
  const big = compactSuspendData({ nodeId: 'x', trail, values: { v: 1 } });
  assert.ok(new TextEncoder().encode(big).length <= 4096);
  const parsed = JSON.parse(big);
  assert.equal(parsed.n, 'x');
  assert.ok(parsed.t.length < 2000 && parsed.t.at(-1) === 'node-1999', 'the recent end of the trail survives');
  assert.deepEqual(parsed.v, { v: 1 });
  const huge = compactSuspendData({ nodeId: 'x', trail: [], values: { s: 'y'.repeat(5000) } });
  assert.ok(new TextEncoder().encode(huge).length <= 4096);
  assert.deepEqual(JSON.parse(huge), { n: 'x', t: [] }, 'values that cannot fit are dropped');
});

test('outcomeFor: node-score average, binary for a variable rule, nothing without a rule', () => {
  assert.deepEqual(outcomeFor({ result: { passed: true, score: 88.6 }, nodeScores: { a: 100, b: 77 } }), { passed: true, score: 89 });
  assert.deepEqual(outcomeFor({ result: { passed: false, score: 40 }, nodeScores: { a: 40 } }), { passed: false, score: 40 });
  assert.deepEqual(outcomeFor({ result: { passed: true, score: 1 }, nodeScores: {} }), { passed: true, score: 100 }, 'a raw variable is not a percentage');
  assert.deepEqual(outcomeFor({ result: { passed: false, score: 0 }, nodeScores: {} }), { passed: false, score: 0 });
  assert.deepEqual(outcomeFor({ result: { passed: null, score: null }, nodeScores: {} }), { passed: null, score: null });
  assert.deepEqual(outcomeFor({ result: { passed: null, score: 250 }, nodeScores: { a: 250 } }), { passed: null, score: 100 }, 'clamped');
  assert.deepEqual(outcomeFor(null), { passed: null, score: null });
  assert.equal(statusFor(true), 'passed');
  assert.equal(statusFor(false), 'failed');
  assert.equal(statusFor(null), 'completed');
});

test('outcomeFor on a real run: hello.ronu passes with 100, the detour fails with 0', () => {
  const { module } = loadSample('hello-ronu');
  const e = new Engine(module);
  e.start(); // welcome (a message)
  e.continue(); // q1
  e.choose('c_yes'); // done
  e.continue(); // the end
  assert.deepEqual(outcomeFor(e.view()), { passed: true, score: 100 });
  const f = new Engine(module);
  f.start();
  f.continue();
  f.choose('c_more'); // how
  f.continue(); // done
  f.continue();
  assert.deepEqual(outcomeFor(f.view()), { passed: false, score: 0 });
});

// ---- session ---------------------------------------------------------------

test('initialize: LMSInitialize, reads the learner and state, marks a fresh attempt incomplete once', () => {
  const api = fakeApi();
  const s = createScormSession(api, { clock: fakeClock() });
  const opened = s.initialize();
  assert.equal(opened.ok, true);
  assert.equal(opened.studentName, 'Okafor, Dami');
  assert.equal(opened.status, 'incomplete');
  assert.equal(api.cmi['cmi.core.lesson_status'], 'incomplete');
  assert.deepEqual(api.log[0], ['LMSInitialize', '']);
  assert.deepEqual(api.log.filter((l) => l[0] === 'LMSSetValue'), [['LMSSetValue', 'cmi.core.lesson_status', 'incomplete']]);
  assert.deepEqual(api.log.at(-1), ['LMSCommit', '']);
  const calls = api.log.length;
  assert.deepEqual(s.initialize(), opened, 'a second initialize is a no-op');
  assert.equal(api.log.length, calls);
  assert.equal(s.errors.length, 0);
});

test('initialize: a resumed attempt keeps its status and hands back the suspend data', () => {
  const api = fakeApi({ cmi: { 'cmi.core.lesson_status': 'incomplete', 'cmi.suspend_data': '{"n":"q1"}', 'cmi.core.lesson_location': 'q1', 'cmi.core.student_name': '  ' } });
  const s = createScormSession(api, { clock: fakeClock() });
  const opened = s.initialize();
  assert.equal(opened.status, 'incomplete');
  assert.equal(opened.suspendData, '{"n":"q1"}');
  assert.equal(opened.location, 'q1');
  assert.equal(opened.studentName, null, 'a blank name is no name');
  assert.equal(api.log.filter((l) => l[0] === 'LMSSetValue').length, 0, 'nothing written');
  assert.equal(api.log.filter((l) => l[0] === 'LMSCommit').length, 0);
});

test('progress: sets location and suspend data, commits at most every few seconds', () => {
  const api = fakeApi();
  const clock = fakeClock();
  const s = createScormSession(api, { clock, commitInterval: 3000 });
  s.initialize();
  const commitsAfterInit = api.log.filter((l) => l[0] === 'LMSCommit').length;
  assert.equal(s.progress({ nodeId: 'welcome', suspendData: '{"n":"welcome"}' }), true);
  assert.equal(api.cmi['cmi.core.lesson_location'], 'welcome');
  assert.equal(api.cmi['cmi.suspend_data'], '{"n":"welcome"}');
  assert.equal(api.log.filter((l) => l[0] === 'LMSCommit').length, commitsAfterInit, 'just committed by initialize: throttled');
  clock.advance(1000);
  s.progress({ nodeId: 'q1', suspendData: '{"n":"q1"}' });
  assert.equal(api.log.filter((l) => l[0] === 'LMSCommit').length, commitsAfterInit, 'still inside the window');
  clock.advance(2500);
  s.progress({ nodeId: 'done', suspendData: '{"n":"done"}' });
  assert.equal(api.log.filter((l) => l[0] === 'LMSCommit').length, commitsAfterInit + 1, 'the window passed: one commit');
  assert.equal(api.cmi['cmi.core.lesson_location'], 'done');
  // Overlong values are cut to what the data model allows.
  clock.advance(5000);
  s.progress({ nodeId: 'n'.repeat(300), suspendData: 'x'.repeat(5000) });
  assert.equal(api.cmi['cmi.core.lesson_location'].length, 255);
  assert.equal(api.cmi['cmi.suspend_data'].length, 4096);
  assert.equal(createScormSession(fakeApi()).progress({ nodeId: 'x' }), false, 'before initialize: nothing');
});

test('finish: score, status, session time and exit in order, then LMSCommit then LMSFinish', () => {
  const api = fakeApi();
  const clock = fakeClock();
  const s = createScormSession(api, { clock });
  s.initialize();
  clock.advance(83_450);
  const from = api.log.length;
  assert.deepEqual(s.finish({ passed: true, score: 88.6 }), { status: 'passed', score: 89 });
  assert.deepEqual(api.log.slice(from), [
    ['LMSSetValue', 'cmi.core.score.min', '0'],
    ['LMSSetValue', 'cmi.core.score.max', '100'],
    ['LMSSetValue', 'cmi.core.score.raw', '89'],
    ['LMSSetValue', 'cmi.core.lesson_status', 'passed'],
    ['LMSSetValue', 'cmi.core.session_time', '0000:01:23.45'],
    ['LMSSetValue', 'cmi.core.exit', ''],
    ['LMSCommit', ''],
    ['LMSFinish', ''],
  ]);
  assert.equal(s.finished, true);
  assert.equal(s.finish({ passed: true, score: 100 }), null, 'a second finish is refused');
  assert.equal(s.progress({ nodeId: 'x' }), false, 'nothing after finish');
  assert.equal(s.abandon(), false);
  assert.equal(api.log.length, from + 8);
});

test('finish: failed when not passed, completed with no score when there is no pass rule', () => {
  const failed = fakeApi();
  const s1 = createScormSession(failed, { clock: fakeClock() });
  s1.initialize();
  assert.deepEqual(s1.finish({ passed: false, score: 0 }), { status: 'failed', score: 0 });
  assert.equal(failed.cmi['cmi.core.lesson_status'], 'failed');
  assert.equal(failed.cmi['cmi.core.score.raw'], '0');

  const noRule = fakeApi();
  const s2 = createScormSession(noRule, { clock: fakeClock() });
  s2.initialize();
  assert.deepEqual(s2.finish({ passed: null, score: null }), { status: 'completed', score: null });
  assert.equal(noRule.cmi['cmi.core.lesson_status'], 'completed');
  assert.equal(noRule.cmi['cmi.core.score.raw'], '', 'no score written');
  assert.equal(noRule.log.filter((l) => l[0] === 'LMSSetValue' && l[1].startsWith('cmi.core.score')).length, 0);
});

test('abandon: session time, exit suspend, commit, finish; the status is left as it was', () => {
  const api = fakeApi();
  const clock = fakeClock();
  const s = createScormSession(api, { clock });
  s.initialize();
  s.progress({ nodeId: 'q1', suspendData: '{"n":"q1"}' });
  clock.advance(12_340);
  const from = api.log.length;
  assert.equal(s.abandon(), true);
  assert.deepEqual(api.log.slice(from), [
    ['LMSSetValue', 'cmi.core.session_time', '0000:00:12.34'],
    ['LMSSetValue', 'cmi.core.exit', 'suspend'],
    ['LMSCommit', ''],
    ['LMSFinish', ''],
  ]);
  assert.equal(api.cmi['cmi.core.lesson_status'], 'incomplete');
  assert.equal(api.cmi['cmi.core.lesson_location'], 'q1');
  assert.equal(s.finished, true);
  assert.equal(s.abandon(), false, 'once');
});

test('errors never throw into the player: refused sets are recorded, a throwing or missing API is survived', () => {
  const refusing = fakeApi({ fail: ['cmi.core.score.raw', 'cmi.core.lesson_status'] });
  const s = createScormSession(refusing, { clock: fakeClock() });
  assert.equal(s.initialize().ok, true);
  assert.equal(s.errors.length, 1, 'the incomplete write was refused and noted');
  assert.equal(s.errors[0].code, '405');
  assert.match(s.errors[0].text, /Incorrect data type/);
  assert.deepEqual(s.finish({ passed: true, score: 50 }), { status: 'passed', score: 50 }, 'finish still completes');
  assert.equal(refusing.log.at(-1)[0], 'LMSFinish');
  assert.equal(s.errors.length, 3);

  const thrower = { LMSInitialize() { throw new Error('boom'); }, LMSGetLastError() { throw new Error('boom'); } };
  const warned = [];
  const t = createScormSession(thrower, { warn: (m) => warned.push(m) });
  assert.equal(t.initialize().ok, false);
  assert.equal(t.progress({ nodeId: 'x' }), false);
  assert.equal(t.finish({ passed: true, score: 1 }), null);
  assert.equal(t.abandon(), false);
  assert.ok(warned.some((m) => /threw/.test(m)));

  const refused = { LMSInitialize: () => 'false', LMSGetLastError: () => '101', LMSGetErrorString: () => 'General exception' };
  const r = createScormSession(refused);
  assert.equal(r.initialize().ok, false);
  assert.equal(r.errors[0].code, '101');

  const partial = { LMSInitialize: () => 'true', LMSGetLastError: () => '0' }; // no GetValue, SetValue, Commit, Finish
  const p = createScormSession(partial, { clock: fakeClock() });
  assert.equal(p.initialize().ok, true);
  assert.equal(p.initialize().studentName, null);
  assert.deepEqual(p.finish({ passed: false, score: 0 }), { status: 'failed', score: 0 }, 'reported as attempted, every call guarded');
  assert.ok(p.errors.some((e) => /missing/.test(e.context)));
});

test('a whole run through the adapter: hello.ronu from LMSInitialize to LMSFinish', () => {
  const api = fakeApi();
  const clock = fakeClock();
  const s = createScormSession(api, { clock });
  s.initialize();
  const { module } = loadSample('hello-ronu');
  const e = new Engine(module, { now: clock });
  const step = () => {
    const v = e.view();
    if (v.kind === 'node') s.progress({ nodeId: v.node.id, suspendData: compactSuspendData({ nodeId: v.node.id, trail: e.trail, values: e.values }) });
    else s.finish(outcomeFor(v));
  };
  e.start(); step(); // welcome
  clock.advance(4000);
  e.continue(); step(); // q1
  clock.advance(2000);
  e.choose('c_yes'); step(); // done
  clock.advance(2000);
  e.continue(); step(); // the end
  assert.equal(api.cmi['cmi.core.lesson_status'], 'passed');
  assert.equal(api.cmi['cmi.core.score.raw'], '100');
  assert.equal(api.cmi['cmi.core.lesson_location'], 'done');
  assert.deepEqual(JSON.parse(api.cmi['cmi.suspend_data']), { n: 'done', t: ['welcome', 'q1', 'done'], v: { v_score: 1 } });
  assert.equal(api.cmi['cmi.core.session_time'], '0000:00:08.00');
  const names = api.log.map((l) => l[0]);
  assert.equal(names[0], 'LMSInitialize');
  assert.equal(names.at(-1), 'LMSFinish');
  assert.equal(names.at(-2), 'LMSCommit');
  assert.equal(s.errors.length, 0);
});
