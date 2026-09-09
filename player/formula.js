// Safe arithmetic for computed variables (spec section 4: a computed variable
// "derives from a formula over non-computed variable names").
//
// The spec does not give the grammar. This follows the repository's Rust
// reference (rust/src/formula.rs): numbers, identifiers, + - * /, unary minus,
// parentheses. No eval. Unknown identifiers and division by zero become 0, so a
// bad formula can never crash a learner session.

function tokenize(formula) {
  const tokens = [];
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < formula.length && /[0-9.]/.test(formula[j])) j += 1;
      const raw = formula.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Invalid number "${raw}"`);
      tokens.push({ type: 'number', value });
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < formula.length && /[A-Za-z0-9_]/.test(formula[j])) j += 1;
      tokens.push({ type: 'ident', value: formula.slice(i, j) });
      i = j;
    } else if ('+-*/'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
    } else if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
    } else if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
    } else {
      throw new Error(`Unexpected character "${ch}" in formula`);
    }
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() {
    return this.tokens[this.pos];
  }
  next() {
    return this.tokens[this.pos++];
  }
  expression() {
    let left = this.term();
    while (this.peek() && this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      const right = this.term();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }
  term() {
    let left = this.factor();
    while (this.peek() && this.peek().type === 'op' && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.next().value;
      const right = this.factor();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }
  factor() {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of formula');
    if (t.type === 'op' && t.value === '-') {
      this.next();
      return { kind: 'negate', inner: this.factor() };
    }
    if (t.type === 'number') {
      this.next();
      return { kind: 'number', value: t.value };
    }
    if (t.type === 'ident') {
      this.next();
      return { kind: 'ident', name: t.value };
    }
    if (t.type === 'lparen') {
      this.next();
      const inner = this.expression();
      const close = this.next();
      if (!close || close.type !== 'rparen') throw new Error('Missing closing parenthesis');
      return inner;
    }
    throw new Error('Unexpected token in formula');
  }
}

export function parseFormula(formula) {
  if (typeof formula !== 'string' || formula.trim() === '') throw new Error('Formula is empty');
  const parser = new Parser(tokenize(formula));
  const ast = parser.expression();
  if (parser.pos !== parser.tokens.length) throw new Error('Unexpected trailing input in formula');
  return ast;
}

/** Variable names a formula references. Throws on a syntax error. */
export function formulaIdentifiers(formula) {
  const names = new Set();
  const walk = (e) => {
    if (e.kind === 'ident') names.add(e.name);
    else if (e.kind === 'binary') {
      walk(e.left);
      walk(e.right);
    } else if (e.kind === 'negate') walk(e.inner);
  };
  walk(parseFormula(formula));
  return [...names].sort();
}

/**
 * Evaluate a formula against a name -> number map. Any error, unknown name,
 * division by zero or non-finite result degrades to 0.
 */
export function evaluateFormula(formula, values) {
  let ast;
  try {
    ast = parseFormula(formula);
  } catch {
    return 0;
  }
  const evalNode = (e) => {
    let result;
    switch (e.kind) {
      case 'number':
        result = e.value;
        break;
      case 'ident': {
        const v = Number(values[e.name]);
        result = Number.isFinite(v) ? v : 0;
        break;
      }
      case 'negate':
        result = -evalNode(e.inner);
        break;
      case 'binary': {
        const l = evalNode(e.left);
        const r = evalNode(e.right);
        if (e.op === '+') result = l + r;
        else if (e.op === '-') result = l - r;
        else if (e.op === '*') result = l * r;
        else result = r === 0 ? 0 : l / r;
        break;
      }
      default:
        result = 0;
    }
    return Number.isFinite(result) ? result : 0;
  };
  return evalNode(ast);
}
