// procedure and dragToTarget (provisional, implemented from the spec text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../engine.js';
import { mod, msg } from './helpers.mjs';

const vars = [{ id: 'early', name: 'early', type: 'number', initialValue: 0 }];
const val = (e, id) => e.variables().find((v) => v.id === id).value;

function procedure(config) {
  return mod({ variables: vars, nodes: [{ id: 'p', type: 'procedure', title: 'Cream', connection: 'after', config: { isStart: true, question: 'Apply the cream', ...config } }, msg('after', null)] });
}
const steps = [
  { text: 'Gain consent' },
  { text: 'Wash hands', critical: true, ifEarly: 'Consent first.', earlyActions: [{ variableId: 'early', operator: 'increment', value: 1 }] },
  { text: 'Apply cream' },
];

test('procedure: steps in order score 100 and are marked provisional', () => {
  const e = new Engine(procedure({ procedureSteps: steps }));
  const v = e.start();
  assert.equal(v.provisional, true);
  assert.equal(v.supported, true);
  assert.equal(v.state.order.length, 3, 'displayed order is a permutation');
  assert.deepEqual([...v.state.order].sort(), [0, 1, 2]);
  e.performStep(0);
  assert.equal(e.view().canContinue, false);
  e.performStep(1);
  e.performStep(2);
  assert.equal(e.nodeScores.p, 100);
  assert.equal(e.view().canContinue, true);
  assert.equal(e.continue().node.id, 'after');
});

test('procedure: a step out of turn is reported as it happens, with its actions', () => {
  const e = new Engine(procedure({ procedureSteps: steps }));
  e.start();
  e.performStep(1);
  assert.equal(e.view().state.note, 'Consent first.');
  assert.equal(val(e, 'early'), 1);
  assert.equal(e.view().state.halted, false);
  e.performStep(0);
  e.performStep(2);
  assert.equal(e.nodeScores.p, 67);
  assert.deepEqual(e.responses.p.response.missteps, [1]);
  assert.ok(e.events.some((x) => x.type === 'procedure-misstep' && x.step === 1 && x.expected === 0));
});

test('procedure: procedureHaltOnCritical stops at a critical misstep', () => {
  const e = new Engine(procedure({ procedureSteps: steps, procedureHaltOnCritical: true }));
  e.start();
  e.performStep(1);
  assert.equal(e.view().state.halted, true);
  assert.equal(e.view().state.answered, true);
  assert.equal(e.nodeScores.p, 0);
  assert.equal(e.responses.p.response.halted, true);
  e.performStep(0);
  assert.equal(e.view().state.performed.length, 1, 'no more steps after a halt');
});

function drag(config) {
  return mod({ nodes: [{ id: 'd', type: 'dragToTarget', title: 'Sort', connection: 'after', config: { isStart: true, ...config } }, msg('after', null)] });
}
const targets = [{ id: 'bin', label: 'Sharps bin' }, { id: 'sink', label: 'Sink' }];
const items = [{ id: 'needle', label: 'Needle', targetId: 'bin' }, { id: 'soap', label: 'Soap', targetId: 'sink' }, { id: 'toy', label: 'Toy' }];

test('dragToTarget: tap-to-place, distractor left unused counts as right', () => {
  const e = new Engine(drag({ dragTargets: targets, dragItems: items }));
  const v = e.start();
  assert.equal(v.provisional, true);
  e.placeItem('needle', 'bin');
  e.placeItem('soap', 'sink');
  assert.equal(e.view().canContinue, false);
  e.submitPlacements();
  assert.equal(e.nodeScores.d, 100);
  assert.equal(e.view().canContinue, true);
});

test('dragToTarget: using a distractor is the mistake; placements can be undone before checking', () => {
  const e = new Engine(drag({ dragTargets: targets, dragItems: items }));
  e.start();
  e.placeItem('needle', 'sink');
  e.placeItem('needle', 'bin');
  e.placeItem('toy', 'sink');
  e.placeItem('soap', 'sink');
  e.placeItem('soap', null);
  assert.throws(() => e.placeItem('ghost', 'bin'));
  assert.throws(() => e.placeItem('soap', 'nowhere'));
  e.submitPlacements();
  assert.deepEqual(e.view().state.feedback.perItem, { needle: true, soap: false, toy: false });
  assert.equal(e.nodeScores.d, 33);
  e.placeItem('soap', 'sink');
  assert.equal(e.view().state.placements.soap, undefined, 'placements are frozen after checking');
});
