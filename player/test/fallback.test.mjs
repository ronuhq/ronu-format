// Spec section 5 evolution rules and section 8 legacy forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, isNodeSupported, parseConditionConfig } from '../engine.js';
import { mod, msg } from './helpers.mjs';

test('5.1 must-ignore: unknown fields anywhere do not break play', () => {
  const module = mod({
    nodes: [
      { ...msg('a', 'b', { isStart: true, futureField: { deep: [1, 2, 3] } }), futureNodeField: true, position: { x: 1, y: 2, z: 3 } },
      { ...msg('b', null), config: { title: 'b', content: '<p>b</p>', triggers: [{ type: 'onSomethingNew', actions: [{ variableId: 'n', operator: 'set', value: 5 }] }] } },
    ],
    variables: [{ id: 'n', name: 'n', type: 'number', initialValue: 1, futureFlag: 'yes' }],
    settings: { completion: { mode: 'variable', variableId: 'n', operator: '>=', value: 1 }, theme: { font: 'Lato' } },
    extraTopLevel: 42,
  });
  const e = new Engine(module);
  e.start();
  let v = e.continue();
  assert.equal(v.node.id, 'b');
  assert.equal(e.variables()[0].value, 1, 'unknown trigger type never fires');
  v = e.continue();
  assert.equal(v.result.passed, true);
});

test('5.2 unknown node type: neutral fallback, follows connection', () => {
  const module = mod({ nodes: [msg('a', 'weird', { isStart: true }), { id: 'weird', type: 'hologram', title: 'A hologram', connection: 'c', config: { beams: 4 } }, msg('c', null)] });
  const e = new Engine(module);
  e.start();
  let v = e.continue();
  assert.equal(v.kind, 'node');
  assert.equal(v.supported, false);
  assert.equal(v.title, 'A hologram', 'the fallback can show the title');
  assert.equal(v.connection, 'c');
  assert.equal(v.canContinue, true);
  v = e.continue();
  assert.equal(v.node.id, 'c');
});

test('5.3 namespaced extension types get the same fallback', () => {
  const module = mod({ nodes: [{ id: 'x', type: 'x-mubs:chemistry-lab', title: 'Lab', connection: 'end', config: { isStart: true, reagents: ['HCl'] } }, msg('end', null)] });
  const e = new Engine(module);
  const v = e.start();
  assert.equal(v.supported, false);
  assert.equal(v.rawType, 'x-mubs:chemistry-lab');
  assert.equal(e.continue().node.id, 'end');
});

test('provisional types this player does not implement fall back (conversation, code, splat scene)', () => {
  const nodes = [
    { id: 'conv', type: 'conversation', title: 'Talk', connection: 'code', config: { isStart: true, persona: 'p', firstMessage: 'hi' } },
    { id: 'code', type: 'code', title: 'World', connection: 'splat', config: { source: 'while(true){}' } },
    { id: 'splat', type: 'scene', title: '3D', connection: null, config: { environment: { kind: 'splat', source: 'x' }, hotspots: [] } },
  ];
  const e = new Engine(mod({ nodes }));
  let v = e.start();
  assert.equal(v.supported, false);
  assert.equal(v.provisional, true);
  v = e.continue();
  assert.equal(v.supported, false, 'code source is never executed');
  v = e.continue();
  assert.equal(v.supported, false, 'splat scenes are provisional');
  assert.equal(v.provisional, true);
  assert.equal(e.continue().kind, 'end');
  assert.equal(isNodeSupported({ type: 'scene', config: { environment: { kind: 'photo2d' } } }), true);
  assert.equal(isNodeSupported({ type: 'scene', config: {} }), true);
});

test('note nodes are skipped entirely', () => {
  const module = mod({ nodes: [msg('a', 'n1', { isStart: true }), { id: 'n1', type: 'note', title: 'canvas note', connection: 'b', config: { text: 'todo' } }, msg('b', null)] });
  const e = new Engine(module);
  e.start();
  const v = e.continue();
  assert.equal(v.node.id, 'b');
  assert.deepEqual(e.trail, ['a', 'b']);
  assert.ok(!e.events.some((x) => x.type === 'entered' && x.nodeId === 'n1'));
});

test('5.4 / section 8: legacy stringified condition and canonical criteria both route', () => {
  const criteria = { criteriaSets: [{ conditions: [{ field: 'n', operator: '>', value: '0' }], targetNodeId: 'yes' }], defaultTargetNodeId: 'no' };
  const legacy = { id: 'c', type: 'decisionPath', title: 'c', config: { choices: JSON.stringify(criteria) } };
  const canonical = { id: 'c', type: 'condition', title: 'c', config: { criteria } };
  for (const cond of [legacy, canonical]) {
    const module = mod({ variables: [{ id: 'n', name: 'n', type: 'number', initialValue: 1 }], nodes: [msg('a', 'c', { isStart: true }), cond, msg('yes', null), msg('no', null)] });
    const e = new Engine(module);
    e.start();
    assert.equal(e.continue().node.id, 'yes');
  }
  assert.deepEqual(parseConditionConfig(legacy.config), criteria);
  assert.equal(parseConditionConfig({ choices: '{not json' }), null);
  assert.equal(parseConditionConfig({ choices: [{ id: 'x' }] }), null, 'a structured choices list is not a condition config');
});

test('condition with no matching set and no default follows connection, then ends', () => {
  const cond = { id: 'c', type: 'condition', title: 'c', connection: 'fallback', config: { criteria: { criteriaSets: [{ conditions: [{ field: 'n', operator: '>', value: '5' }], targetNodeId: 'yes' }] } } };
  const module = mod({ variables: [{ id: 'n', name: 'n', type: 'number', initialValue: 1 }], nodes: [msg('a', 'c', { isStart: true }), cond, msg('yes', null), msg('fallback', null)] });
  const e = new Engine(module);
  e.start();
  assert.equal(e.continue().node.id, 'fallback');
  const dead = new Engine(mod({ variables: module.variables, nodes: [msg('a', 'c', { isStart: true }), { ...cond, connection: null }, msg('yes', null)] }));
  dead.start();
  assert.equal(dead.continue().kind, 'end');
});

test('a condition can read another node\'s recorded answer', () => {
  const module = mod({
    nodes: [
      { id: 'q', type: 'textInput', title: 'q', connection: 'c', config: { isStart: true, question: 'Word?' } },
      { id: 'c', type: 'condition', title: 'c', config: { criteria: { criteriaSets: [{ conditions: [{ field: 'q', operator: 'contains', value: 'olive' }], targetNodeId: 'yes' }], defaultTargetNodeId: 'no' } } },
      msg('yes', null), msg('no', null),
    ],
  });
  const e = new Engine(module);
  e.start();
  e.answerText('a new olive and PTFE');
  assert.equal(e.continue().node.id, 'yes');
});

test('dangling connection ends the module with an error instead of crashing', () => {
  const e = new Engine(mod({ nodes: [msg('a', 'ghost', { isStart: true })] }));
  e.start();
  const v = e.continue();
  assert.equal(v.kind, 'end');
  assert.match(v.error, /ghost/);
});

test('missing isStart falls back to the first node; empty module ends immediately', () => {
  const e = new Engine(mod({ nodes: [msg('first', null), msg('second', null)] }));
  assert.equal(e.start().node.id, 'first');
  const empty = new Engine(mod({ nodes: [] }));
  assert.equal(empty.start().kind, 'end');
  assert.throws(() => new Engine({}), /nodes/);
});

test('a pass-through cycle is cut off rather than hanging', () => {
  const module = mod({ nodes: [msg('a', 'n1', { isStart: true }), { id: 'n1', type: 'note', connection: 'n2' }, { id: 'n2', type: 'note', connection: 'n1' }] });
  const e = new Engine(module);
  e.start();
  const v = e.continue();
  assert.equal(v.kind, 'end');
  assert.match(v.error, /loops/);
});
