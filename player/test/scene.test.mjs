// Scene node: visible and hidden hotspots, discovery radius, ordered
// sequence, allRequired completion, hotspot routing, photo2d coordinates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../engine.js';
import { mod, msg } from './helpers.mjs';

const vars = [{ id: 'found', name: 'found', type: 'number', initialValue: 0 }, { id: 'miss', name: 'miss', type: 'number', initialValue: 0 }];
const inc = (id) => [{ variableId: id, operator: 'increment', value: 1 }];
const val = (e, id) => e.variables().find((v) => v.id === id).value;

function scene(config, extraNodes = []) {
  return mod({ variables: vars, nodes: [{ id: 's', type: 'scene', title: 'Scene', connection: 'after', config: { isStart: true, environment: { kind: 'photo360', source: '' }, ...config } }, msg('after', null), ...extraNodes] });
}

test('visible hotspots: tap marker, actions fire once, allRequired gates Continue', () => {
  const e = new Engine(scene({
    completion: 'allRequired',
    hotspots: [
      { id: 'h1', label: 'One', required: true, position: { yaw: 0, pitch: 0 }, variableActions: inc('found') },
      { id: 'h2', label: 'Two', required: true, position: { yaw: 1, pitch: 0 }, variableActions: inc('found') },
      { id: 'h3', label: 'Optional', position: { yaw: 2, pitch: 0 } },
    ],
  }));
  e.start();
  assert.equal(e.view().canContinue, false);
  e.activateHotspot('h1');
  e.activateHotspot('h1');
  assert.equal(val(e, 'found'), 1);
  assert.equal(e.view().canContinue, false);
  e.activateHotspot('h2');
  assert.equal(e.view().canContinue, true);
  assert.equal(e.continue().node.id, 'after');
});

test('hidden hotspots: discovery within radius, misses fire missActions, nearest wins', () => {
  const e = new Engine(scene({
    discoveryRadius: 0.3,
    missActions: inc('miss'),
    hotspots: [
      { id: 'a', hidden: true, position: { yaw: 0, pitch: 0 }, variableActions: inc('found') },
      { id: 'b', hidden: true, position: { yaw: 0.4, pitch: 0 }, variableActions: inc('found') },
    ],
  }));
  e.start();
  assert.equal(e.tapScene({ yaw: 2, pitch: 0 }), null);
  assert.equal(val(e, 'miss'), 1);
  assert.equal(e.tapScene({ yaw: 0.25, pitch: 0 }).id, 'b', 'nearest hotspot within radius');
  assert.equal(e.tapScene({ yaw: 0.05, pitch: 0.1 }).id, 'a');
  assert.equal(val(e, 'found'), 2);
  assert.equal(e.view().state.found.length, 2);
});

test('ordered sequence locks later hotspots', () => {
  const e = new Engine(scene({
    hotspotSequence: 'ordered',
    hotspots: [{ id: 'first', position: { yaw: 0, pitch: 0 }, variableActions: inc('found') }, { id: 'second', position: { yaw: 1, pitch: 0 }, variableActions: inc('found') }],
  }));
  e.start();
  e.activateHotspot('second');
  assert.equal(val(e, 'found'), 0);
  assert.equal(e.view().state.lastTap.kind, 'locked');
  e.activateHotspot('first');
  e.activateHotspot('second');
  assert.equal(val(e, 'found'), 2);
});

test('hotspot beats: conversation fallback, then reveal, then route', () => {
  const e = new Engine(scene({
    hotspots: [{ id: 'door', label: 'Door', position: { yaw: 0, pitch: 0 }, conversation: { persona: 'guard', firstMessage: 'Halt' }, reveal: { kind: 'text', body: 'A door.' }, targetNodeId: 'elsewhere' }],
  }, [msg('elsewhere', null)]));
  e.start();
  e.activateHotspot('door');
  assert.equal(e.view().state.beat.kind, 'conversation');
  e.dismissBeat();
  assert.equal(e.view().state.beat.kind, 'reveal');
  e.dismissBeat();
  assert.equal(e.view().node.id, 'elsewhere');
});

test('photo2d uses fractional x/y and a 0.08 default radius', () => {
  const e = new Engine(scene({
    environment: { kind: 'photo2d', source: 'assets/x.jpg' },
    missActions: inc('miss'),
    hotspots: [{ id: 'spot', hidden: true, position: { x: 0.5, y: 0.5 }, variableActions: inc('found') }],
  }));
  e.start();
  assert.equal(e.tapScene({ x: 0.7, y: 0.5 }), null);
  assert.equal(e.tapScene({ x: 0.54, y: 0.53 }).id, 'spot');
  assert.equal(val(e, 'miss'), 1);
  assert.equal(val(e, 'found'), 1);
});

test('hotspot and miss events reach the session log', () => {
  const e = new Engine(scene({ hotspots: [{ id: 'h', label: 'H', hidden: true, position: { yaw: 0, pitch: 0 } }] }));
  e.start();
  e.tapScene({ yaw: 3, pitch: 0 });
  e.tapScene({ yaw: 0, pitch: 0 });
  assert.ok(e.events.some((x) => x.type === 'scene-miss'));
  assert.ok(e.events.some((x) => x.type === 'hotspot' && x.hotspotId === 'h'));
});
