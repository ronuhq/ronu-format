import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFormula, formulaIdentifiers } from '../formula.js';

test('formula: precedence, parentheses, unary minus', () => {
  assert.equal(evaluateFormula('1 + 2 * 3', {}), 7);
  assert.equal(evaluateFormula('(1 + 2) * 3', {}), 9);
  assert.equal(evaluateFormula('-a + 4', { a: 1 }), 3);
  assert.equal(evaluateFormula('correct / total * 100', { correct: 3, total: 4 }), 75);
});

test('formula: unknown names and division by zero degrade to 0', () => {
  assert.equal(evaluateFormula('x / 0', { x: 5 }), 0);
  assert.equal(evaluateFormula('missing * 2', {}), 0);
  assert.equal(evaluateFormula('1 +', {}), 0);
  assert.equal(evaluateFormula('', {}), 0);
});

test('formula: identifiers are extracted and bad syntax throws', () => {
  assert.deepEqual(formulaIdentifiers('correct / total * 100'), ['correct', 'total']);
  assert.throws(() => formulaIdentifiers('(a + b'));
  assert.throws(() => formulaIdentifiers('a ^ b'));
});

// Spec 9.2: results round to six decimals with Math.round semantics, matching
// the reference validator (rust/src/formula.rs), so a pass rule that reads a
// computed variable sees the same number in every implementation.
test('rounds to six decimals like the validator', () => {
  assert.equal(evaluateFormula('n / 3', { n: 1 }), 0.333333);
  assert.equal(evaluateFormula('n / 3', { n: 2 }), 0.666667);
  assert.equal(evaluateFormula('92 * 0.6 + 88 * 0.4', {}), 90.4);
  assert.equal(evaluateFormula('-2.5 * 1000000 / 1000000', {}), -2.5);
});
