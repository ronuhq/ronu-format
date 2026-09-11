// The comparison rules every conformance runner uses. Kept apart from the
// runners so a runner for another player can reuse them (or port them: they
// fit on one page).
//
//   numbers   equal within a tolerance of 1e-6 (so 2/3 * 100 rounded and a
//             float division both compare cleanly)
//   strings, booleans, null   exact
//   arrays    ordered and exact in length; each element compared recursively
//   objects   by the keys the EXPECTED object lists; extra keys on the actual
//             side are ignored, a listed key missing on the actual side fails
//   undefined on the expected side never appears (JSON has none)
//
// `events` in a case uses the subsequence rule: every expected event must
// appear in the actual list, in the same relative order, each matched by the
// keys it lists. See matchesSubsequence.

export const TOLERANCE = 1e-6;

/**
 * Compare `actual` against `expected` under the rules above. Returns a list
 * of difference strings (empty when they match). `path` names the root.
 */
export function diff(expected, actual, path = '$') {
  const out = [];
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !(Math.abs(expected - actual) <= TOLERANCE)) out.push(`${path}: expected ${expected}, got ${show(actual)}`);
    return out;
  }
  if (expected === null || typeof expected !== 'object') {
    if (expected !== actual) out.push(`${path}: expected ${show(expected)}, got ${show(actual)}`);
    return out;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push(`${path}: expected an array, got ${show(actual)}`);
      return out;
    }
    if (expected.length !== actual.length) out.push(`${path}: expected ${expected.length} item(s), got ${actual.length} (${show(actual)})`);
    const n = Math.min(expected.length, actual.length);
    for (let i = 0; i < n; i++) out.push(...diff(expected[i], actual[i], `${path}[${i}]`));
    return out;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    out.push(`${path}: expected an object, got ${show(actual)}`);
    return out;
  }
  const keys = Object.keys(expected);
  if (keys.length === 0) {
    // An empty expected object is the one way to say "nothing recorded".
    const extra = Object.keys(actual);
    if (extra.length) out.push(`${path}: expected an empty object, got keys ${show(extra)}`);
    return out;
  }
  for (const key of keys) {
    if (!(key in actual)) {
      out.push(`${path}.${key}: expected ${show(expected[key])}, but the key is absent`);
      continue;
    }
    out.push(...diff(expected[key], actual[key], `${path}.${key}`));
  }
  return out;
}

/** True when `expected` and `actual` match under `diff`. */
export function matches(expected, actual) {
  return diff(expected, actual).length === 0;
}

/**
 * Ordered subsequence match: each expected item must match (under `diff`)
 * some actual item, and the matched actual items must appear in the same
 * order. Returns difference strings (empty when every expected item is found).
 */
export function matchesSubsequence(expected, actual, path = '$') {
  const out = [];
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    out.push(`${path}: both sides must be arrays`);
    return out;
  }
  let cursor = 0;
  for (let i = 0; i < expected.length; i++) {
    let found = -1;
    for (let j = cursor; j < actual.length; j++) {
      if (matches(expected[i], actual[j])) {
        found = j;
        break;
      }
    }
    if (found < 0) {
      out.push(`${path}[${i}]: no later item matches ${show(expected[i])}`);
      return out;
    }
    cursor = found + 1;
  }
  return out;
}

export function show(v) {
  if (v === undefined) return 'undefined';
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 157) + '...' : s;
  } catch {
    return String(v);
  }
}
