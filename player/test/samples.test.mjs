// Walk every sample under samples/*/module.json from its start node with
// scripted answers and assert on the variables and end state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, isNodeSupported, normalizeType } from '../engine.js';
import { loadSample, sampleNames } from './helpers.mjs';

const byName = (e) => Object.fromEntries(e.variables().map((v) => [v.name, v.value]));

test('every sample loads, starts, and can be walked to an end', () => {
  const names = sampleNames();
  assert.ok(names.length >= 4, `expected at least four samples, found ${names.join(', ')}`);
  for (const name of names) {
    const { module } = loadSample(name);
    const e = new Engine(module);
    let v = e.start();
    assert.equal(v.kind, 'node', `${name}: starts on a node`);
    let steps = 0;
    while (v.kind === 'node' && steps++ < 50) v = autoAnswer(e, v);
    assert.equal(v.kind, 'end', `${name}: reaches the end screen`);
    assert.ok(e.events.some((x) => x.type === 'completed'), `${name}: records completion`);
  }
});

/** Generic scripted answering: first choice, first option, defaults. */
function autoAnswer(e, v) {
  if (!v.supported) return e.continue();
  switch (v.type) {
    case 'choice':
      return e.choose(v.config.choices[0].id);
    case 'textInput':
      e.answerText('auto');
      return e.continue();
    case 'multipleChoice':
      e.answerMultiple([v.config.choices[0].id]);
      return e.continue();
    case 'ranking':
      e.answerRanking([]);
      return e.continue();
    case 'matching':
      e.answerMatching({});
      return e.continue();
    case 'rating':
      e.answerRating(v.config.ratingMin ?? 1);
      return e.continue();
    case 'procedure': {
      // Perform every step in the authored order: a clean run.
      const n = e.procedureSteps(v.node).length;
      for (let i = 0; i < n; i++) e.performStep(i);
      return e.continue();
    }
    case 'dragToTarget': {
      // Put each item where it belongs and leave the distractors alone.
      for (const it of v.config.dragItems ?? []) if (it && it.id && it.targetId) e.placeItem(it.id, it.targetId);
      e.submitPlacements();
      return e.continue();
    }
    case 'scene':
      for (const hs of e.sceneHotspots(v.node)) {
        if (e.ended || e.currentNodeId !== v.node.id) break;
        e.activateHotspot(hs.id);
        while (e.view().kind === 'node' && e.view().state?.beat) e.dismissBeat();
      }
      return e.ended || e.currentNodeId !== v.node.id ? e.view() : e.continue();
    default:
      return e.continue();
  }
}

test('hello-ronu: the yes branch passes, the detour does not', () => {
  const { module } = loadSample('hello-ronu');
  let e = new Engine(module);
  e.start();
  e.continue();
  let v = e.choose('c_yes');
  assert.equal(v.title, 'The end');
  v = e.continue();
  assert.equal(v.kind, 'end');
  assert.equal(v.result.passed, true);
  assert.equal(byName(e).score, 1);
  assert.deepEqual(e.trail, ['welcome', 'q1', 'done']);

  e = new Engine(module);
  e.start();
  e.continue();
  v = e.choose('c_more');
  assert.equal(v.title, 'How it works');
  v = e.continue();
  v = e.continue();
  assert.equal(v.result.passed, false);
  assert.equal(byName(e).score, 0);
  assert.deepEqual(e.trail, ['welcome', 'q1', 'how', 'done']);
});

test('under-the-sink: scene discovery, choice actions, conversation fallback, legacy condition routing', () => {
  const { module } = loadSample('under-the-sink');
  const e = new Engine(module);
  let v = e.start();
  v = e.continue();
  assert.equal(v.type, 'scene');
  assert.equal(v.config.environment.kind, 'photo360');
  // Hidden hotspots: a tap far from both is a miss and fires missActions.
  assert.equal(e.tapScene({ yaw: 0, pitch: 0 }), null);
  assert.equal(byName(e).wrong_guesses, 1);
  // Within 0.35 rad of the fitting: found, variableActions fire, reveal beat shows.
  const hit = e.tapScene({ yaw: -1.1, pitch: 0.1 });
  assert.equal(hit.id, 'cl-fitting');
  assert.equal(byName(e).clues_found, 1);
  assert.equal(e.view().state.beat.kind, 'reveal');
  assert.equal(e.view().canContinue, false, 'reveal must be dismissed first');
  e.dismissBeat();
  assert.equal(e.tapScene({ yaw: 1.25, pitch: 0 }).id, 'cl-trap');
  e.dismissBeat();
  assert.equal(byName(e).clues_found, 2);
  assert.equal(e.tapScene({ yaw: 1.25, pitch: 0 }), null, 'already found hotspots do not re-fire');
  assert.equal(byName(e).clues_found, 2);
  v = e.continue();
  assert.equal(v.type, 'choice');
  v = e.choose('opt-reseat');
  assert.equal(byName(e).correct_fix, true);
  assert.equal(v.type, 'conversation');
  assert.equal(v.supported, false, 'conversation falls back in a minimal player');
  // Continue past the fallback: the legacy stringified condition routes on customer_score (0 -> retry).
  v = e.continue();
  assert.equal(v.node.id, 'retry');
  assert.ok(e.events.some((x) => x.type === 'branch' && x.nodeId === 'passcheck' && x.targetNodeId === 'retry'));
  v = e.continue();
  assert.equal(v.kind, 'end');
  assert.equal(v.result.passed, true, 'completion rule is_true on correct_fix');

  // Same module, score the conversation variable up: the condition takes the pass path.
  const e2 = new Engine(module);
  e2.start();
  e2.continue();
  e2.continue();
  e2.choose('opt-tape');
  e2.applyActions([{ variableId: 'customer_score', operator: 'set', value: 3 }]);
  const v2 = e2.continue();
  assert.equal(v2.node.id, 'pass');
  assert.equal(e2.continue().result.passed, false);
});

test('fantasy-series-quiz: assessment types, placeholders, matching grade, computed variable', () => {
  const { module } = loadSample('fantasy-series-quiz');
  const e = new Engine(module);
  let v = e.start();
  assert.equal(v.type, 'message');
  v = e.continue();
  assert.equal(v.type, 'video');
  v = e.continue();
  assert.equal(v.type, 'textInput');
  e.answerText('Mistborn');
  v = e.continue();
  assert.equal(v.type, 'multipleChoice');
  e.answerMultiple(['choice-1780831646857', 'choice-1780831647639']);
  assert.equal(byName(e).score, 10);
  v = e.continue();
  assert.equal(v.type, 'ranking');
  assert.equal(v.title, 'Ranking — score: 10');
  assert.match(v.question, /Score so far: 10/);
  e.answerRanking(['Door', 'Breath']);
  assert.deepEqual(e.responses[v.node.id].response.slice(0, 2), ['Door', 'Breath']);
  assert.equal(e.responses[v.node.id].response.length, 7);
  v = e.continue();
  assert.equal(v.type, 'matching');
  e.answerMatching({ 'l-1780800985230': 'r-1780800993974', 'l-1780800989935': 'r-1780800993974', 'l-1780801056805': 'r-1780831879697' });
  assert.equal(e.nodeScores[v.node.id], 25, '2 of 8 correct');
  v = e.continue();
  assert.equal(v.type, 'rating');
  assert.throws(() => e.answerRating(9), /range/);
  e.answerRating(6);
  v = e.continue();
  assert.equal(v.kind, 'end');
  const vars = byName(e);
  assert.equal(vars.score, 10);
  assert.equal(vars.quality, 20, 'computed: score * 2');
  assert.equal(v.result.passed, null, 'no completion rule: completed, not passed or failed');
  assert.equal(e.responses['node-1780800771419'].response, 'Mistborn');
});

test('legacy-branching-sample: router and decisionPath types play as choice and condition', () => {
  const { module } = loadSample('legacy-branching-sample');
  assert.ok(module.nodes.some((n) => n.type === 'router'));
  assert.ok(module.nodes.some((n) => n.type === 'decisionPath'));
  const e = new Engine(module);
  let v = e.start();
  v = e.continue();
  e.answerText('great');
  v = e.continue();
  assert.equal(v.rawType, 'router');
  assert.equal(v.type, 'choice');
  assert.equal(v.supported, true);
  v = e.choose('choice-1764599003178-0.5598983586206759');
  assert.equal(v.node.id, 'node-1764599039494');
  e.answerText('food');
  v = e.continue();
  assert.equal(v.kind, 'end');
  // The unreachable decisionPath node still parses as a condition.
  const dp = module.nodes.find((n) => n.type === 'decisionPath');
  assert.equal(normalizeType(dp.type), 'condition');
  assert.equal(isNodeSupported(dp), true);
});
