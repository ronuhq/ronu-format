import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareValue, evaluateCriteriaSet, evaluateConditionConfig, normalizeOperator, compareCompletion } from '../conditions.js';

const v = (value, texts) => ({ value, texts });

test('operators: existence and boolean checks work on missing values', () => {
  assert.equal(compareValue(v(undefined), 'exists', null), false);
  assert.equal(compareValue(v(undefined), 'not_exists', null), true);
  assert.equal(compareValue(v(''), 'not exists', null), true);
  assert.equal(compareValue(v([]), 'exists', null), false);
  assert.equal(compareValue(v('hello'), 'exists', null), true);
  assert.equal(compareValue(v(true), 'is_true', null), true);
  assert.equal(compareValue(v(false), 'is true', null), false);
  assert.equal(compareValue(v(undefined), 'is false', null), true);
  assert.equal(compareValue(v('true'), 'is_true', null), true);
});

test('operators: equality and text operators, both spellings', () => {
  assert.equal(compareValue(v('yes'), 'equals', 'yes'), true);
  assert.equal(compareValue(v(3), '==', '3'), true);
  assert.equal(compareValue(v('yes'), 'not_equals', 'no'), true);
  assert.equal(compareValue(v('hello world'), 'contains', 'world'), true);
  assert.equal(compareValue(v('hello world'), 'not contains', 'mars'), true);
  assert.equal(compareValue(v('hello world'), 'starts_with', 'hello'), true);
  assert.equal(compareValue(v('hello world'), 'ends with', 'world'), true);
  assert.equal(compareValue(v('abc'), 'length >', '2'), true);
  assert.equal(compareValue(v('abc'), 'length_<', '2'), false);
});

test('operators: numeric comparisons coerce strings', () => {
  assert.equal(compareValue(v(5), '>', '4'), true);
  assert.equal(compareValue(v('5'), '>=', 5), true);
  assert.equal(compareValue(v(5), '<', '4'), false);
  assert.equal(compareValue(v(5), '<=', '5'), true);
  assert.equal(compareValue(v(0), '>=', '1'), false);
});

test('operators: date comparisons', () => {
  assert.equal(compareValue(v('2026-01-01'), 'before', '2026-02-01'), true);
  assert.equal(compareValue(v('2026-03-01'), 'after', '2026-02-01'), true);
  assert.equal(compareValue(v('2026-01-15'), 'within_range', '2026-01-01, 2026-02-01'), true);
  assert.equal(compareValue(v('2026-05-15'), 'within range', '2026-01-01,2026-02-01'), false);
});

test('operators: choice answers match on id or label, comma lists are any-of', () => {
  const answer = v(['c1', 'c3'], ['Vin', 'Sazed']);
  assert.equal(compareValue(answer, 'equals', 'Vin'), true);
  assert.equal(compareValue(answer, 'equals', 'c3'), true);
  assert.equal(compareValue(answer, 'contains', 'Elend, Sazed'), true);
  assert.equal(compareValue(answer, 'not contains', 'Elend'), true);
  assert.equal(compareValue(answer, 'length >', 1), true);
});

test('operators: unknown operator is false, aliases normalise', () => {
  assert.equal(compareValue(v(1), 'frobnicate', 1), false);
  assert.equal(normalizeOperator('IS_TRUE'), 'is true');
  assert.equal(normalizeOperator('!='), 'not equals');
  assert.equal(normalizeOperator('gte'), '>=');
});

test('criteria set: implicit AND, explicit connectors, NOT and parentheses', () => {
  const resolve = (f) => ({ a: v(5), b: v('x'), c: v(true) })[f];
  const A = { field: 'a', operator: '>', value: 1 };
  const B = { field: 'b', operator: 'equals', value: 'y' };
  const C = { field: 'c', operator: 'is_true' };
  const op = (value) => ({ field: 'operator', value });
  assert.equal(evaluateCriteriaSet([A, C], resolve), true);
  assert.equal(evaluateCriteriaSet([A, B], resolve), false);
  assert.equal(evaluateCriteriaSet([A, op('OR'), B], resolve), true);
  assert.equal(evaluateCriteriaSet([op('NOT'), B], resolve), true);
  assert.equal(evaluateCriteriaSet([B, op('OR'), op('('), A, op('AND'), C, op(')')], resolve), true);
  assert.equal(evaluateCriteriaSet([{ ...A }, { ...B, join: 'OR' }], resolve), true);
  assert.equal(evaluateCriteriaSet([], resolve), false);
});

test('condition config: first matching set wins, then the default', () => {
  const cfg = {
    criteriaSets: [
      { conditions: [{ field: 'score', operator: '>=', value: '10' }], targetNodeId: 'high' },
      { conditions: [{ field: 'score', operator: '>=', value: '5' }], targetNodeId: 'mid' },
    ],
    defaultTargetNodeId: 'low',
  };
  assert.equal(evaluateConditionConfig(cfg, () => v(12)), 'high');
  assert.equal(evaluateConditionConfig(cfg, () => v(7)), 'mid');
  assert.equal(evaluateConditionConfig(cfg, () => v(1)), 'low');
  assert.equal(evaluateConditionConfig({ criteriaSets: [] }, () => v(1)), null);
  assert.equal(evaluateConditionConfig(null, () => v(1)), null);
});

test('completion comparison uses the same operator set', () => {
  assert.equal(compareCompletion(3, '>=', 1), true);
  assert.equal(compareCompletion(true, 'is_true', undefined), true);
  assert.equal(compareCompletion('abc', 'contains', 'b'), true);
});
