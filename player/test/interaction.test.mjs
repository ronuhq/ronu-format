// Answering inside a scene (spec section 7.2): hotspot `interaction`
// sub-nodes, the "required means answered" rule, and the scene's `abortWhen`
// early exit. Plus a focused walk of the margarets-room sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, NESTABLE_TYPES } from '../engine.js';
import { buildStatements } from '../session.js';
import { loadSample, mod, msg } from './helpers.mjs';

const byName = (e) => Object.fromEntries(e.variables().map((v) => [v.name, v.value]));
const vars = [
  { id: 'fail', name: 'fail', type: 'boolean', initialValue: false },
  { id: 'count', name: 'count', type: 'number', initialValue: 0 },
  { id: 'label', name: 'label', type: 'text', initialValue: 'the tube' },
];
const inc = (id) => [{ variableId: id, operator: 'increment', value: 1 }];

function scene(config, extraNodes = []) {
  return mod({
    variables: vars,
    nodes: [
      { id: 's', type: 'scene', title: 'Room', connection: 'after', config: { isStart: true, environment: { kind: 'photo360', source: '' }, ...config } },
      msg('after', null),
      msg('stop', null),
      ...extraNodes,
    ],
  });
}

const mcq = (extra = {}) => ({
  type: 'multipleChoice',
  config: {
    question: 'Which one for {label}?',
    choices: [
      { id: 'right', text: 'The labelled {label}', actions: inc('count') },
      { id: 'wrong', text: 'Either', actions: [{ variableId: 'fail', operator: 'set_true' }] },
    ],
    ...extra,
  },
});

test('nested interaction: opens as a beat after the conversation and before the reveal, answers in the room, never routes', () => {
  const e = new Engine(scene({
    hotspots: [{
      id: 'h', label: 'Tubes', position: { yaw: 0, pitch: 0 },
      conversation: { persona: 'nurse', firstMessage: 'Hello' },
      interaction: mcq(),
      reveal: { kind: 'text', body: 'Well spotted.' },
      targetNodeId: 'after',
    }],
  }));
  e.start();
  e.activateHotspot('h');
  assert.equal(e.view().state.beat.kind, 'conversation');
  e.dismissBeat();
  let v = e.view();
  assert.equal(v.state.beat.kind, 'interaction');
  assert.equal(v.interaction.type, 'multipleChoice');
  assert.equal(v.interaction.nested, true);
  assert.equal(v.interaction.title, 'Tubes', 'the hotspot label heads the panel');
  assert.equal(v.interaction.question, 'Which one for the tube?', 'placeholders apply inside nested content');
  assert.equal(v.canContinue, false);
  v = e.answerMultiple(['right']);
  assert.equal(v.node.id, 's', 'still in the room after answering');
  assert.equal(v.interaction.state.answered, true);
  assert.equal(byName(e).count, 1, 'the choice actions fired');
  assert.deepEqual(e.responses['s/h'].response, ['right'], 'recorded against the hotspot');
  e.dismissBeat();
  assert.equal(e.view().state.beat.kind, 'reveal', 'the reveal follows the answer');
  e.dismissBeat();
  assert.equal(e.view().node.id, 'after', 'the route fires last, from targetNodeId, not from the interaction');
});

test('nested interaction: a required hotspot is satisfied only once answered; closing unanswered is not enough', () => {
  const e = new Engine(scene({
    completion: 'allRequired',
    hotspots: [
      { id: 'q', label: 'Question', required: true, position: { yaw: 0, pitch: 0 }, interaction: mcq(), reveal: { kind: 'text', body: 'Done.' } },
      { id: 'note', label: 'Note', required: true, position: { yaw: 1, pitch: 0 }, interaction: { type: 'message', config: { content: '<p>Read me</p>' } } },
      { id: 'plain', label: 'Plain', required: true, position: { yaw: 2, pitch: 0 } },
    ],
  }));
  e.start();
  e.activateHotspot('plain');
  assert.equal(e.hotspotSatisfied(e.currentNode, e.sceneHotspots(e.currentNode)[2]), true, 'no interaction: visiting is enough');
  e.activateHotspot('q');
  assert.equal(e.view().state.beat.kind, 'interaction');
  e.dismissBeat();
  assert.equal(e.view().state.beat, null, 'closed without answering: back in the room, no reveal');
  assert.equal(e.view().state.visited.includes('q'), true);
  assert.equal(e.hotspotSatisfied(e.currentNode, e.sceneHotspots(e.currentNode)[0]), false);
  assert.equal(e.view().canContinue, false);
  e.activateHotspot('q');
  e.answerMultiple(['right']);
  e.dismissBeat();
  assert.equal(e.view().state.beat.kind, 'reveal', 'reopened and answered: the later beats run');
  e.dismissBeat();
  assert.equal(e.view().canContinue, false, 'the message hotspot is still unread');
  e.activateHotspot('note');
  assert.equal(e.view().interaction.content, '<p>Read me</p>');
  e.dismissBeat();
  assert.equal(e.view().canContinue, true, 'a message interaction is answered by reading it');
  assert.equal(e.continue().node.id, 'after');
});

test('nested interaction: every nestable type answers through the same engine calls, scores against the hotspot', () => {
  const hotspots = [
    { id: 'text', position: { yaw: 0, pitch: 0 }, interaction: { type: 'textInput', config: { question: 'Name?' } } },
    { id: 'rank', position: { yaw: 0.5, pitch: 0 }, interaction: { type: 'ranking', config: { rankingItems: ['a', 'b'] } } },
    { id: 'match', position: { yaw: 1, pitch: 0 }, interaction: { type: 'matching', config: { matchingLeftItems: [{ id: 'l1', text: 'L', correctRightId: 'r1', actions: inc('count') }], matchingRightItems: [{ id: 'r1', text: 'R' }] } } },
    { id: 'rate', position: { yaw: 1.5, pitch: 0 }, interaction: { type: 'rating', config: { ratingMin: 1, ratingMax: 5, ratingVariableId: 'count' } } },
    { id: 'proc', position: { yaw: 2, pitch: 0 }, interaction: { type: 'procedure', config: { procedureSteps: [{ text: 'one' }, { text: 'two' }] } } },
    { id: 'drag', position: { yaw: 2.5, pitch: 0 }, interaction: { type: 'dragToTarget', config: { dragTargets: [{ id: 't' }], dragItems: [{ id: 'i', targetId: 't' }, { id: 'x' }] } } },
  ];
  assert.equal(NESTABLE_TYPES.size, 8);
  const e = new Engine(scene({ hotspots }));
  e.start();
  e.activateHotspot('text');
  e.answerText('Ade');
  e.dismissBeat();
  e.activateHotspot('rank');
  e.answerRanking(['b', 'a']);
  e.dismissBeat();
  e.activateHotspot('match');
  e.answerMatching({ l1: 'r1' });
  e.dismissBeat();
  e.activateHotspot('rate');
  e.answerRating(4);
  e.dismissBeat();
  e.activateHotspot('proc');
  e.performStep(1);
  e.performStep(0);
  assert.equal(e.view().interaction.state.answered, true);
  e.dismissBeat();
  e.activateHotspot('drag');
  e.placeItem('i', 't');
  e.submitPlacements();
  e.dismissBeat();
  assert.equal(e.currentNodeId, 's', 'nothing routed');
  assert.equal(e.responses['s/text'].response, 'Ade');
  assert.deepEqual(e.responses['s/rank'].response, ['b', 'a']);
  assert.equal(e.nodeScores['s/match'], 100);
  assert.equal(e.responses['s/rate'].response, 4);
  assert.equal(byName(e).count, 4, 'matching actions fired, then the rating set the variable');
  assert.equal(e.nodeScores['s/proc'], 50);
  assert.equal(e.nodeScores['s/drag'], 100);
  assert.equal(e.hotspotSatisfied(e.currentNode, hotspots[4]), true);
  // Session record: nested answers are statements about the hotspot sub-activity.
  const st = buildStatements(e.events, { activityIri: 'https://x/m' }, { module: e.module });
  const answered = st.filter((s) => s.verb.id.endsWith('/answered'));
  assert.equal(answered.length, 6);
  assert.equal(answered[0].object.id, 'https://x/m/nodes/s/hotspots/text');
  assert.equal(answered[0].object.definition.type, 'https://ronunest.com/xapi/ext/node/textInput');
});

test('nested interaction: a non-nestable type (choice) is ignored, so the hotspot behaves as if it had none', () => {
  const e = new Engine(scene({
    completion: 'allRequired',
    hotspots: [{ id: 'h', required: true, position: { yaw: 0, pitch: 0 }, interaction: { type: 'choice', config: { choices: [{ id: 'a', text: 'A', connection: 'stop' }] } }, reveal: { kind: 'text', body: 'x' } }],
  }));
  e.start();
  e.activateHotspot('h');
  assert.equal(e.view().state.beat.kind, 'reveal');
  assert.equal(e.view().interaction, null);
  e.dismissBeat();
  assert.equal(e.view().canContinue, true);
});

test('abortWhen: the operator defaults to is_true; fires on a nested choice action and leaves at once for targetNodeId', () => {
  const e = new Engine(scene({
    abortWhen: { variableId: 'fail', targetNodeId: 'stop' },
    hotspots: [{ id: 'h', position: { yaw: 0, pitch: 0 }, interaction: mcq(), reveal: { kind: 'text', body: 'never shown' } }],
  }));
  e.start();
  e.activateHotspot('h');
  const v = e.answerMultiple(['wrong']);
  assert.equal(v.node.id, 'stop');
  assert.equal(e.trail.at(-1), 'stop');
  assert.ok(e.events.some((x) => x.type === 'scene-abort' && x.nodeId === 's' && x.targetNodeId === 'stop'));
  assert.ok(e.events.some((x) => x.type === 'exited' && x.nodeId === 's' && x.targetNodeId === 'stop'));
  assert.equal(e.responses['s/h'].response[0], 'wrong', 'the answer was still recorded');
});

test('abortWhen: does not fire while the comparison is false, and is not evaluated on entry', () => {
  const e = new Engine(scene({
    abortWhen: { variableId: 'count', operator: '>=', value: 2, targetNodeId: 'stop' },
    missActions: inc('count'),
    hotspots: [{ id: 'h', hidden: true, position: { yaw: 0, pitch: 0 }, variableActions: inc('count') }],
  }));
  e.start();
  assert.equal(e.currentNodeId, 's');
  e.tapScene({ yaw: 3, pitch: 0 });
  assert.equal(byName(e).count, 1);
  assert.equal(e.currentNodeId, 's', 'one miss: below the line');
  e.tapScene({ yaw: 0, pitch: 0 });
  assert.equal(byName(e).count, 2);
  assert.equal(e.currentNodeId, 'stop', 'a hotspot variableAction crossed the line');

  // Already over the line before the scene starts: not checked on entry (the
  // room still opens), but the first in-scene event notices it (G43).
  const e2 = new Engine(scene({
    abortWhen: { variableId: 'fail', targetNodeId: 'stop' },
    hotspots: [{ id: 'h', position: { yaw: 0, pitch: 0 } }],
  }));
  e2.start();
  e2.applyActions([{ variableId: 'fail', operator: 'set_true' }], 'test');
  assert.equal(e2.currentNodeId, 's');
  assert.equal(e2.view().canContinue, true);
  e2.activateHotspot('h');
  assert.equal(e2.currentNodeId, 'stop');
});

test('abortWhen: fires mid-scene from a nested procedure misstep, and a rule with no target never fires', () => {
  const steps = [{ text: 'consent' }, { text: 'cream', critical: true, earlyActions: [{ variableId: 'fail', operator: 'set_true' }] }, { text: 'record' }];
  const e = new Engine(scene({
    abortWhen: { variableId: 'fail', operator: 'is_true', targetNodeId: 'stop' },
    hotspots: [{ id: 'p', position: { yaw: 0, pitch: 0 }, interaction: { type: 'procedure', config: { procedureSteps: steps } } }],
  }));
  e.start();
  e.activateHotspot('p');
  e.performStep(0);
  assert.equal(e.currentNodeId, 's');
  const v = e.performStep(2);
  assert.equal(v.node.id, 's', 'a non-critical misstep sets nothing');
  const e2 = new Engine(scene({
    abortWhen: { variableId: 'fail', targetNodeId: 'stop' },
    hotspots: [{ id: 'p', position: { yaw: 0, pitch: 0 }, interaction: { type: 'procedure', config: { procedureSteps: steps } } }],
  }));
  e2.start();
  e2.activateHotspot('p');
  assert.equal(e2.performStep(1).node.id, 'stop', 'the critical step out of turn ends the visit with the procedure unfinished');
  assert.equal(e2.responses['s/p'], undefined);

  const e3 = new Engine(scene({
    abortWhen: { variableId: 'fail' },
    hotspots: [{ id: 'h', position: { yaw: 0, pitch: 0 }, interaction: mcq() }],
  }));
  e3.start();
  e3.activateHotspot('h');
  e3.answerMultiple(['wrong']);
  assert.equal(e3.currentNodeId, 's');
});

test('margarets-room: basin procedure in order, the required interactions answered, the gate passes (with the conversation graded)', () => {
  const { module } = loadSample('margarets-room');
  const e = new Engine(module);
  let v = e.start();
  assert.equal(v.node.id, 'brief');
  v = e.continue();
  assert.equal(v.type, 'scene');
  assert.equal(v.canContinue, false);

  // The basin: a nested procedure, done in the authored order.
  e.activateHotspot('h-basin');
  v = e.view();
  assert.equal(v.state.beat.kind, 'interaction');
  assert.equal(v.interaction.type, 'procedure');
  assert.equal(v.interaction.title, 'Hand-wash basin');
  for (let i = 0; i < 5; i++) e.performStep(i);
  assert.equal(e.view().interaction.state.answered, true);
  assert.equal(e.nodeScores['room/h-basin'], 100);
  assert.deepEqual(e.responses['room/h-basin'].response.missteps, []);
  e.dismissBeat();
  assert.equal(e.view().state.beat, null);
  assert.equal(e.view().canContinue, false, 'two required hotspots left');

  // Margaret: a conversation. No AI grader here, so the fallback card leaves consent_score at 0.
  e.activateHotspot('h-margaret');
  assert.equal(e.view().state.beat.kind, 'conversation');
  e.dismissBeat();
  assert.equal(byName(e).consent_score, 0);

  // The tubes: a nested multipleChoice whose choice action sets right_cream.
  e.activateHotspot('h-cream');
  assert.equal(e.view().interaction.type, 'multipleChoice');
  e.answerMultiple(['c-labelled']);
  assert.equal(byName(e).right_cream, true);
  e.dismissBeat();
  assert.equal(e.view().canContinue, true, 'all three required hotspots satisfied');

  // Optional extras: the care plan reveal, the bins, the window note, and the hidden call bell.
  e.activateHotspot('h-careplan');
  e.dismissBeat();
  e.activateHotspot('h-bins');
  e.placeItem('i-gloves', 't-clinical');
  e.placeItem('i-towel', 't-general');
  e.placeItem('i-box', 't-general');
  e.submitPlacements();
  assert.equal(e.nodeScores['room/h-bins'], 100, 'the glasses left alone count as right');
  e.dismissBeat();
  e.activateHotspot('h-window');
  assert.equal(e.view().interaction.type, 'message');
  e.dismissBeat();
  assert.equal(e.tapScene({ yaw: 0.55, pitch: -0.6 }).id, 'h-callbell');
  e.dismissBeat();
  assert.equal(byName(e).checks, 2);
  assert.equal(byName(e).missteps, 0);

  // Offline as-is, the gate needs consent_score >= 60 and sends the learner back in.
  v = e.continue();
  assert.equal(v.node.id, 'debrief-retry');
  assert.match(v.content, /scored 0 out of 100/);

  // Second visit, with the conversation graded as a live player would: the gate passes.
  v = e.continue();
  assert.equal(v.node.id, 'room');
  e.activateHotspot('h-basin');
  for (let i = 0; i < 5; i++) e.performStep(i);
  e.dismissBeat();
  e.activateHotspot('h-margaret');
  e.dismissBeat();
  e.applyActions([{ variableId: 'consent_score', operator: 'set', value: 80 }], 'test:grader');
  e.activateHotspot('h-cream');
  e.answerMultiple(['c-labelled']);
  e.dismissBeat();
  v = e.continue();
  assert.equal(v.node.id, 'debrief-pass');
  assert.match(v.content, /checked 2 thing\(s\)/);
  v = e.continue();
  assert.equal(v.kind, 'end');
  assert.equal(v.result.passed, true);
  assert.equal(v.result.reason, 'end');
});

test('margarets-room: a critical misstep in the basin costs a misstep but does not abort; "either tube" trips abortWhen to stop', () => {
  const { module } = loadSample('margarets-room');
  const e = new Engine(module);
  e.start();
  e.continue();
  e.activateHotspot('h-basin');
  e.performStep(2); // rinsing before the 20 second rub: the critical step is skipped
  assert.equal(e.currentNodeId, 'room', 'procedureHaltOnCritical is false and the step sets no failure flag');
  assert.equal(byName(e).missteps, 0, 'rinsing early is not the step that carries earlyActions');
  e.performStep(1);
  assert.equal(byName(e).missteps, 1, 'the rub done late fires its earlyActions');
  e.performStep(0);
  e.performStep(3);
  e.performStep(4);
  assert.equal(e.view().interaction.state.answered, true);
  assert.equal(e.nodeScores['room/h-basin'], 60, 'two of five steps out of turn');
  assert.deepEqual(e.responses['room/h-basin'].response.missteps, [2, 1]);
  e.dismissBeat();

  // The critical failure the room is built around: reaching for either tube.
  e.activateHotspot('h-cream');
  const v = e.answerMultiple(['c-either']);
  assert.equal(byName(e).critical_failure, true);
  assert.equal(v.node.id, 'stop');
  assert.deepEqual(e.trail, ['brief', 'room', 'stop']);
  assert.equal(e.continue().kind, 'end');
  assert.equal(e.result.passed, false, 'debrief-pass was never reached');
  assert.ok(e.events.some((x) => x.type === 'scene-abort' && x.targetNodeId === 'stop'));
});
