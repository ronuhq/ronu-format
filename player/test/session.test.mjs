// Session record: xAPI-like statements keyed by the manifest's activity IRI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../engine.js';
import { buildStatements, sessionRecord, activityIriFor, PLACEHOLDER_ACTOR } from '../session.js';
import { loadSample, fakeClock } from './helpers.mjs';

test('statements use the activity IRI, node sub-IRIs and the placeholder actor', () => {
  const { module, manifest } = loadSample('hello-ronu');
  const now = fakeClock(1_700_000_000_000);
  const e = new Engine(module, { now });
  e.start();
  e.continue();
  e.choose('c_yes');
  e.continue();
  const st = buildStatements(e.events, manifest, { module });
  const verbs = st.map((s) => s.verb.id.split('/').pop());
  assert.deepEqual(verbs, ['launched', 'experienced', 'experienced', 'answered', 'interacted', 'experienced', 'completed', 'passed']);
  assert.equal(st[0].object.id, 'https://ronunest.com/xapi/modules/a0000000-0000-4000-8000-000000000001');
  assert.equal(st[1].object.id, 'https://ronunest.com/xapi/modules/a0000000-0000-4000-8000-000000000001/nodes/welcome');
  assert.deepEqual(st[0].actor, PLACEHOLDER_ACTOR);
  assert.equal(st[3].result.response, 'c_yes');
  assert.deepEqual(st[3].result.extensions['https://ronunest.com/xapi/ext/answer-labels'], ['Yes — let\'s go']);
  const change = st[4].result.extensions['https://ronunest.com/xapi/ext/variable-changed'];
  assert.deepEqual({ name: change.name, from: change.from, to: change.to }, { name: 'score', from: 0, to: 1 });
  assert.equal(st[6].result.success, true);
  assert.equal(st[6].timestamp, new Date(1_700_000_000_000).toISOString());
  assert.ok(new Set(st.map((s) => s.id)).size === st.length, 'ids are unique');
});

test('branch, timer and hotspot events carry the simulation extensions', () => {
  const { module, manifest } = loadSample('under-the-sink');
  const e = new Engine(module);
  e.start();
  e.continue();
  e.tapScene({ yaw: 1.25, pitch: 0 });
  e.dismissBeat();
  e.continue();
  e.choose('opt-reseat');
  e.continue();
  const st = buildStatements(e.events, manifest, { module });
  const branch = st.find((s) => s.result?.extensions?.['https://ronunest.com/xapi/ext/branch-taken']);
  assert.deepEqual(branch.result.extensions['https://ronunest.com/xapi/ext/branch-taken'], { fromNodeId: 'passcheck', targetId: 'retry' });
  const hot = st.find((s) => s.result?.extensions?.['https://ronunest.com/xapi/ext/scene-hotspot']);
  assert.equal(hot.object.id, `${manifest.activityIri}/nodes/sink/hotspots/cl-trap`);
});

test('the downloadable record wraps statements with the final state', () => {
  const { module, manifest } = loadSample('hello-ronu');
  const e = new Engine(module);
  e.start();
  e.continue();
  e.choose('c_yes');
  e.continue();
  const rec = sessionRecord(e, manifest);
  assert.equal(rec.format, 'ronu-session');
  assert.equal(rec.activityIri, manifest.activityIri);
  assert.equal(rec.result.passed, true);
  assert.equal(rec.variables[0].value, 1);
  assert.deepEqual(rec.trail, ['welcome', 'q1', 'done']);
  assert.ok(Array.isArray(rec.statements) && rec.statements.length > 0);
  assert.doesNotThrow(() => JSON.stringify(rec));
});

test('activity IRI falls back to the family id, then to an urn', () => {
  assert.equal(activityIriFor({ module: { familyId: 'abc' } }), 'https://ronunest.com/xapi/modules/abc');
  assert.equal(activityIriFor({}), 'urn:ronu:unknown');
});
