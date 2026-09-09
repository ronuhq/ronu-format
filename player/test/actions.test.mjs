// Every VariableAction operator (spec section 7 shared sub-schemas), plus
// coercion, computed variables and placeholders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../engine.js';
import { mod, msg } from './helpers.mjs';

const variables = [
  { id: 'n', name: 'n', type: 'number', initialValue: 10 },
  { id: 'b', name: 'b', type: 'boolean', initialValue: false },
  { id: 't', name: 't', type: 'text', initialValue: 'hi' },
  { id: 'c', name: 'c', type: 'number', computed: true, formula: 'n * 2' },
];

function engineWith(actions) {
  const e = new Engine(mod({ variables, nodes: [{ ...msg('a', null), config: { title: 'a', isStart: true, triggers: [{ type: 'onNodeEnter', actions }] } }] }));
  e.start();
  return e;
}
const val = (e, id) => e.variables().find((v) => v.id === id).value;

test('set coerces to the variable type', () => {
  let e = engineWith([{ variableId: 'n', operator: 'set', value: '42' }]);
  assert.equal(val(e, 'n'), 42);
  e = engineWith([{ variableId: 'b', operator: 'set', value: 'true' }]);
  assert.equal(val(e, 'b'), true);
  e = engineWith([{ variableId: 't', operator: 'set', value: 7 }]);
  assert.equal(val(e, 't'), '7');
  e = engineWith([{ variableId: 'n', operator: 'set', value: 'not a number' }]);
  assert.equal(val(e, 'n'), 0);
});

test('increment, decrement, multiply, divide', () => {
  assert.equal(val(engineWith([{ variableId: 'n', operator: 'increment', value: 5 }]), 'n'), 15);
  assert.equal(val(engineWith([{ variableId: 'n', operator: 'increment' }]), 'n'), 11);
  assert.equal(val(engineWith([{ variableId: 'n', operator: 'decrement', value: '3' }]), 'n'), 7);
  assert.equal(val(engineWith([{ variableId: 'n', operator: 'multiply', value: 3 }]), 'n'), 30);
  assert.equal(val(engineWith([{ variableId: 'n', operator: 'divide', value: 4 }]), 'n'), 2.5);
  assert.equal(val(engineWith([{ variableId: 'n', operator: 'divide', value: 0 }]), 'n'), 10, 'divide by zero leaves the value alone');
});

test('set_true, set_false, toggle', () => {
  assert.equal(val(engineWith([{ variableId: 'b', operator: 'set_true' }]), 'b'), true);
  assert.equal(val(engineWith([{ variableId: 'b', operator: 'set_true' }, { variableId: 'b', operator: 'set_false' }]), 'b'), false);
  assert.equal(val(engineWith([{ variableId: 'b', operator: 'toggle' }]), 'b'), true);
  assert.equal(val(engineWith([{ variableId: 'b', operator: 'toggle' }, { variableId: 'b', operator: 'toggle' }]), 'b'), false);
});

test('unknown operator, unknown variable and computed targets are ignored', () => {
  const e = engineWith([
    { variableId: 'n', operator: 'exponentiate', value: 2 },
    { variableId: 'nope', operator: 'set', value: 1 },
    { variableId: 'c', operator: 'set', value: 999 },
    { variableId: 'n', operator: 'increment', value: 1 },
  ]);
  assert.equal(val(e, 'n'), 11);
  assert.equal(val(e, 'c'), 22, 'computed follows its formula');
});

test('actions by variable name are tolerated', () => {
  const e = engineWith([{ variableId: 'n', operator: 'set', value: 1 }]);
  e.applyActions([{ variableId: 'n', operator: 'increment', value: 1 }]);
  assert.equal(val(e, 'n'), 2);
});

test('variable changes are recorded as events', () => {
  const e = engineWith([{ variableId: 'n', operator: 'increment', value: 5 }]);
  const ev = e.events.find((x) => x.type === 'variable');
  assert.deepEqual({ from: ev.from, to: ev.to, name: ev.name }, { from: 10, to: 15, name: 'n' });
});

test('placeholders substitute by variable name, including computed', () => {
  const e = engineWith([]);
  assert.equal(e.substitute('n={n} c={c} b={b} t={t} missing={zzz}'), 'n=10 c=20 b=false t=hi missing={zzz}');
});

test('initial values default per type and are coerced', () => {
  const e = new Engine(mod({ variables: [{ id: 'x', name: 'x', type: 'number' }, { id: 'y', name: 'y', type: 'boolean', initialValue: 'true' }, { id: 'z', name: 'z', type: 'text' }], nodes: [msg('a', null, { isStart: true })] }));
  e.start();
  assert.equal(val(e, 'x'), 0);
  assert.equal(val(e, 'y'), true);
  assert.equal(val(e, 'z'), '');
});
