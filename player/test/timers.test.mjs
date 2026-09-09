// TimerConfig and NodeTrigger behaviour with a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../engine.js';
import { mod, msg, fakeClock } from './helpers.mjs';

const vars = [{ id: 'n', name: 'n', type: 'number', initialValue: 0 }, { id: 'secs', name: 'secs', type: 'number', initialValue: 0 }];
const val = (e, id) => e.variables().find((v) => v.id === id).value;

test('onNodeEnter and onNodeExit triggers fire once each', () => {
  const module = mod({
    variables: vars,
    nodes: [
      msg('a', 'b', { isStart: true, triggers: [{ type: 'onNodeEnter', actions: [{ variableId: 'n', operator: 'increment', value: 1 }] }, { type: 'onNodeExit', actions: [{ variableId: 'n', operator: 'increment', value: 10 }] }] }),
      msg('b', null),
    ],
  });
  const e = new Engine(module);
  e.start();
  assert.equal(val(e, 'n'), 1);
  e.continue();
  assert.equal(val(e, 'n'), 11);
});

test('onTimerElapsed fires after config.duration seconds on the node', () => {
  const now = fakeClock();
  const module = mod({ variables: vars, nodes: [msg('a', null, { isStart: true, triggers: [{ type: 'onTimerElapsed', config: { duration: 5 }, actions: [{ variableId: 'n', operator: 'set', value: 7 }] }] })] });
  const e = new Engine(module, { now });
  e.start();
  now.advance(4000);
  assert.equal(e.tick(), false);
  assert.equal(val(e, 'n'), 0);
  now.advance(1500);
  assert.equal(e.tick(), true);
  assert.equal(val(e, 'n'), 7);
  now.advance(10000);
  e.tick();
  assert.equal(val(e, 'n'), 7, 'fires once');
});

test('node countdown: advance, route, end, none; recordVariableId stores elapsed seconds', () => {
  const build = (onExpire) => mod({
    variables: vars,
    nodes: [msg('a', 'next', { isStart: true, timer: { mode: 'countdown', seconds: 3, visible: true, recordVariableId: 'secs', onExpire } }), msg('next', null), msg('routed', null)],
  });
  let now = fakeClock();
  let e = new Engine(build({ behavior: 'advance', actions: [{ variableId: 'n', operator: 'increment', value: 1 }] }), { now });
  e.start();
  assert.equal(e.view().timers.node.display, 3);
  now.advance(3100);
  e.tick();
  assert.equal(e.view().node.id, 'next');
  assert.equal(val(e, 'n'), 1, 'expiry actions applied');
  assert.equal(val(e, 'secs'), 3, 'elapsed seconds recorded on exit');

  now = fakeClock();
  e = new Engine(build({ behavior: 'route', targetNodeId: 'routed' }), { now });
  e.start();
  now.advance(3000);
  e.tick();
  assert.equal(e.view().node.id, 'routed');

  now = fakeClock();
  e = new Engine(build({ behavior: 'end' }), { now });
  e.start();
  now.advance(3000);
  e.tick();
  assert.equal(e.view().kind, 'end');
  assert.equal(e.view().result.reason, 'timer');

  now = fakeClock();
  e = new Engine(build({ behavior: 'none' }), { now });
  e.start();
  now.advance(5000);
  e.tick();
  assert.equal(e.view().node.id, 'a');
  assert.equal(e.view().timers.node.expired, true);
  assert.equal(e.view().timers.node.display, 0);
});

test('countup timers never expire but still record elapsed time', () => {
  const now = fakeClock();
  const module = mod({ variables: vars, nodes: [msg('a', 'b', { isStart: true, timer: { mode: 'countup', recordVariableId: 'secs', onExpire: { behavior: 'end' } } }), msg('b', null)] });
  const e = new Engine(module, { now });
  e.start();
  now.advance(12_000);
  e.tick();
  assert.equal(e.view().node.id, 'a');
  assert.equal(e.view().timers.node.display, 12);
  e.continue();
  assert.equal(val(e, 'secs'), 12);
});

test('module timer: route and end, elapsed recorded at the finish', () => {
  const now = fakeClock();
  const module = mod({
    variables: vars,
    settings: { timer: { mode: 'countdown', seconds: 10, label: 'Shift', recordVariableId: 'secs', onExpire: { behavior: 'route', targetNodeId: 'timeout' } } },
    nodes: [msg('a', 'b', { isStart: true }), msg('b', null), msg('timeout', null)],
  });
  const e = new Engine(module, { now });
  e.start();
  assert.equal(e.view().timers.module.label, 'Shift');
  now.advance(9000);
  e.tick();
  assert.equal(e.view().node.id, 'a');
  now.advance(1000);
  e.tick();
  assert.equal(e.view().node.id, 'timeout');
  e.continue();
  assert.equal(e.view().kind, 'end');
  assert.equal(val(e, 'secs'), 10);

  const end = new Engine(mod({ settings: { timer: { mode: 'countdown', seconds: 1, onExpire: { behavior: 'end' } } }, nodes: [msg('a', null, { isStart: true })] }), { now });
  end.start();
  now.advance(1000);
  end.tick();
  assert.equal(end.view().kind, 'end');
});

test('warning window follows warnAtSeconds', () => {
  const now = fakeClock();
  const e = new Engine(mod({ nodes: [msg('a', null, { isStart: true, timer: { mode: 'countdown', seconds: 30, warnAtSeconds: 5 } })] }), { now });
  e.start();
  now.advance(20_000);
  e.tick();
  assert.equal(e.view().timers.node.warning, false);
  now.advance(6000);
  e.tick();
  assert.equal(e.view().timers.node.warning, true);
});
