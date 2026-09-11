import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, matches, matchesSubsequence, TOLERANCE } from './compare.mjs';

test('numbers compare within the tolerance', () => {
  assert.equal(matches(2.5, 2.5), true);
  assert.equal(matches(2.5, 2.5 + TOLERANCE / 2), true);
  assert.equal(matches(2.5, 2.5001), false);
  assert.equal(matches(67, 66.6667), false, 'the reference rounds node scores; a raw fraction is not 67');
  assert.equal(matches(1, '1'), false, 'a numeric string is not a number');
  assert.match(diff(3, 4)[0], /expected 3, got 4/);
});

test('strings, booleans and null are exact', () => {
  assert.equal(matches('a', 'a'), true);
  assert.equal(matches('a', 'A'), false);
  assert.equal(matches(true, true), true);
  assert.equal(matches(false, 0), false);
  assert.equal(matches(null, null), true);
  assert.equal(matches(null, undefined), false);
});

test('arrays are ordered and exact in length', () => {
  assert.equal(matches(['a', 'b'], ['a', 'b']), true);
  assert.equal(matches(['a', 'b'], ['b', 'a']), false);
  assert.equal(matches(['a'], ['a', 'b']), false);
  assert.equal(matches([], []), true);
  assert.match(diff(['a', 'b'], ['a'])[0], /expected 2 item\(s\), got 1/);
  assert.match(diff(['a', 'b'], 'ab')[0], /expected an array/);
});

test('objects compare by the listed keys only; an empty object expects an empty object', () => {
  assert.equal(matches({ a: 1 }, { a: 1, b: 2 }), true, 'extra actual keys are ignored');
  assert.equal(matches({ a: 1, b: 2 }, { a: 1 }), false, 'a listed key must be present');
  assert.match(diff({ a: 1, b: 2 }, { a: 1 })[0], /\$\.b: .*absent/);
  assert.equal(matches({}, {}), true);
  assert.equal(matches({}, { a: 1 }), false, 'an empty expected object means nothing recorded');
  assert.equal(matches({ a: { b: [1, { c: 'x' }] } }, { a: { b: [1, { c: 'x', d: 'ignored' }] }, e: 0 }), true);
  assert.match(diff({ a: 1 }, null)[0], /expected an object/);
  assert.match(diff({ a: 1 }, [1])[0], /expected an object/);
});

test('difference paths name the offending leaf', () => {
  const d = diff({ variables: { score: 3 }, trail: ['a', 'b'] }, { variables: { score: 4 }, trail: ['a', 'c'] });
  assert.deepEqual(d.map((s) => s.split(':')[0]), ['$.variables.score', '$.trail[1]']);
});

test('events match as an ordered subsequence on listed keys', () => {
  const actual = [{ type: 'entered', nodeId: 'a' }, { type: 'variable', name: 'n', to: 1 }, { type: 'branch', nodeId: 'c', targetNodeId: 'x' }, { type: 'exited', nodeId: 'a' }];
  assert.deepEqual(matchesSubsequence([{ type: 'entered' }, { type: 'branch', targetNodeId: 'x' }], actual), []);
  assert.deepEqual(matchesSubsequence([{ type: 'branch' }, { type: 'entered' }], actual).length, 1, 'order matters');
  assert.match(matchesSubsequence([{ type: 'branch', targetNodeId: 'y' }], actual)[0], /no later item matches/);
  assert.deepEqual(matchesSubsequence([], actual), []);
  assert.equal(matchesSubsequence([{ type: 'entered' }, { type: 'entered' }], actual).length, 1, 'each expected item consumes its match');
});
