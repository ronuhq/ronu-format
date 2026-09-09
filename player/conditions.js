// Condition evaluation (spec section 7, `condition` node; section 8 legacy
// form) and completion-rule comparison (spec section 4, `settings.completion`).
//
// The spec names the shape (`criteriaSets[]{conditions[]{field, operator,
// value}, targetNodeId}`, `defaultTargetNodeId`) but not the operator
// vocabulary, how conditions combine, or what a `field` is compared against.
// See player/SPEC-GAPS.md, entries G1 to G5, for how each was resolved.

/**
 * Normalise an operator spelling. Two dialects exist in the wild
 * ("is_true" and "is true"); symbolic aliases are accepted too.
 */
export function normalizeOperator(op) {
  const s = String(op ?? '').trim().toLowerCase().replace(/_/g, ' ');
  switch (s) {
    case '==':
    case '=':
    case 'eq':
    case 'is':
      return 'equals';
    case '!=':
    case '<>':
    case 'neq':
    case 'is not':
    case 'does not equal':
      return 'not equals';
    case 'gt':
      return '>';
    case 'lt':
      return '<';
    case 'gte':
      return '>=';
    case 'lte':
      return '<=';
    case 'does not contain':
      return 'not contains';
    default:
      return s;
  }
}

const isBlank = (v) => v === undefined || v === null || v === '';

/**
 * Compare one resolved value against an operator + expected value.
 * `resolved` is `{ value, texts? }`: `value` is the raw variable value or the
 * recorded response; `texts` (optional) is the list of choice labels a
 * choice-style response maps to, used so an author can write the visible
 * label rather than the generated id.
 */
export function compareValue(resolved, operator, expected) {
  const op = normalizeOperator(operator);
  const value = resolved?.value;
  const texts = resolved?.texts ?? null;

  // Existence and boolean checks are meaningful for a missing value.
  if (op === 'exists') return !isBlank(value) && !(Array.isArray(value) && value.length === 0);
  if (op === 'not exists') return isBlank(value) || (Array.isArray(value) && value.length === 0);
  if (op === 'is true') return toBool(value) === true;
  if (op === 'is false') return toBool(value) === false;
  if (isBlank(value)) return false;

  // The strings a choice-style answer can be matched against: ids and labels.
  const candidates = Array.isArray(value)
    ? [...value.map(String), ...(texts ?? []).map(String)]
    : [String(value), ...(texts ?? []).map(String)];
  const expectedStr = String(expected ?? '');
  const expectedList = expectedStr.includes(',')
    ? expectedStr.split(',').map((s) => s.trim()).filter(Boolean)
    : [expectedStr];

  switch (op) {
    case 'equals':
      return candidates.includes(expectedStr) || (typeof value === 'number' && Number(expectedStr) === value);
    case 'not equals':
      return !(candidates.includes(expectedStr) || (typeof value === 'number' && Number(expectedStr) === value));
    case 'contains':
      return expectedList.some((e) => candidates.some((c) => c.includes(e)));
    case 'not contains':
      return !expectedList.some((e) => candidates.some((c) => c.includes(e)));
    case 'starts with':
      return candidates.some((c) => c.startsWith(expectedStr));
    case 'ends with':
      return candidates.some((c) => c.endsWith(expectedStr));
    case '>':
      return Number(value) > Number(expected);
    case '<':
      return Number(value) < Number(expected);
    case '>=':
      return Number(value) >= Number(expected);
    case '<=':
      return Number(value) <= Number(expected);
    case 'length >':
      return (Array.isArray(value) ? value.length : String(value).length) > Number(expected);
    case 'length <':
      return (Array.isArray(value) ? value.length : String(value).length) < Number(expected);
    case 'before':
      return new Date(value) < new Date(expected);
    case 'after':
      return new Date(value) > new Date(expected);
    case 'within range': {
      const [a, b] = expectedStr.split(',').map((s) => new Date(s.trim()));
      const d = new Date(value);
      return d >= a && d <= b;
    }
    default:
      return false;
  }
}

function toBool(v) {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0' || s === '') return false;
  }
  return Boolean(v);
}

/**
 * Turn a criteria set's condition list into tokens. A condition whose `field`
 * is the literal "operator" is a connector: its `value` is AND, OR, NOT, "("
 * or ")". A condition may also carry `join: "AND"|"OR"` as a property.
 */
function tokenize(conditions) {
  const tokens = [];
  for (const c of conditions ?? []) {
    if (!c || typeof c !== 'object') continue;
    if (c.field === 'operator') {
      const v = String(c.value ?? '').trim().toUpperCase();
      if (v === '(' || v === ')') tokens.push({ type: 'paren', value: v });
      else if (v === 'AND' || v === 'OR' || v === 'NOT') tokens.push({ type: 'op', value: v });
      continue;
    }
    if (c.join && tokens.length > 0) tokens.push({ type: 'op', value: String(c.join).toUpperCase() });
    tokens.push({ type: 'cond', value: c });
  }
  return tokens;
}

/**
 * Evaluate one criteria set: every condition in it, combined with the
 * connectors present. Two conditions with no connector between them are
 * combined with AND. Precedence: NOT, then AND, then OR; parentheses group.
 */
export function evaluateCriteriaSet(conditions, resolveField) {
  const tokens = tokenize(conditions);
  if (tokens.length === 0) return false;
  let pos = 0;
  const peek = () => tokens[pos];
  const startsOperand = (t) => t && (t.type === 'cond' || (t.type === 'paren' && t.value === '(') || (t.type === 'op' && t.value === 'NOT'));

  function orExpr() {
    let left = andExpr();
    while (peek() && peek().type === 'op' && peek().value === 'OR') {
      pos += 1;
      const right = andExpr();
      left = left || right;
    }
    return left;
  }
  function andExpr() {
    let left = notExpr();
    for (;;) {
      const t = peek();
      if (t && t.type === 'op' && t.value === 'AND') {
        pos += 1;
        left = notExpr() && left;
      } else if (startsOperand(t)) {
        // implicit AND
        left = notExpr() && left;
      } else break;
    }
    return left;
  }
  function notExpr() {
    const t = peek();
    if (t && t.type === 'op' && t.value === 'NOT') {
      pos += 1;
      return !notExpr();
    }
    return primary();
  }
  function primary() {
    const t = peek();
    if (!t) return false;
    if (t.type === 'paren' && t.value === '(') {
      pos += 1;
      const inner = orExpr();
      if (peek() && peek().type === 'paren' && peek().value === ')') pos += 1;
      return inner;
    }
    if (t.type === 'cond') {
      pos += 1;
      const c = t.value;
      return compareValue(resolveField(c.field), c.operator, c.value);
    }
    // stray token: skip it
    pos += 1;
    return primary();
  }
  const result = orExpr();
  return Boolean(result);
}

/**
 * Route a condition node. Returns the target node id, or null when nothing
 * matched and there is no default.
 */
export function evaluateConditionConfig(config, resolveField) {
  if (!config || typeof config !== 'object') return null;
  const sets = Array.isArray(config.criteriaSets) ? config.criteriaSets : [];
  for (const set of sets) {
    if (!set || !Array.isArray(set.conditions)) continue;
    if (evaluateCriteriaSet(set.conditions, resolveField) && set.targetNodeId) return set.targetNodeId;
  }
  return config.defaultTargetNodeId || null;
}

/** The completion rule's comparison (mode `variable` and `nodeScore`). */
export function compareCompletion(value, operator, expected) {
  return compareValue({ value }, operator, expected);
}
