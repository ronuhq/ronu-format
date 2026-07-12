// Safe arithmetic formula evaluation for computed variables.
// Supports: numbers, identifiers (variable names), + - * / and parentheses.
// No eval(), no Function() — a small recursive-descent parser.

export class FormulaError extends Error {}

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; name: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/" }
  | { kind: "paren"; paren: "(" | ")" };

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < formula.length && /[0-9.]/.test(formula[j])) j++;
      const raw = formula.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new FormulaError(`Invalid number "${raw}"`);
      tokens.push({ kind: "number", value });
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < formula.length && /[A-Za-z0-9_]/.test(formula[j])) j++;
      tokens.push({ kind: "identifier", name: formula.slice(i, j) });
      i = j;
    } else if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", op: ch });
      i++;
    } else if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", paren: ch });
      i++;
    } else {
      throw new FormulaError(`Unexpected character "${ch}" in formula`);
    }
  }
  return tokens;
}

type Expr =
  | { kind: "number"; value: number }
  | { kind: "identifier"; name: string }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: Expr; right: Expr }
  | { kind: "negate"; operand: Expr };

function parse(tokens: Token[]): Expr {
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpression(): Expr {
    let left = parseTerm();
    while (peek()?.kind === "op" && ((peek() as any).op === "+" || (peek() as any).op === "-")) {
      const op = (next() as any).op;
      const right = parseTerm();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  function parseTerm(): Expr {
    let left = parseFactor();
    while (peek()?.kind === "op" && ((peek() as any).op === "*" || (peek() as any).op === "/")) {
      const op = (next() as any).op;
      const right = parseFactor();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  function parseFactor(): Expr {
    const token = peek();
    if (!token) throw new FormulaError("Unexpected end of formula");
    if (token.kind === "op" && token.op === "-") {
      next();
      return { kind: "negate", operand: parseFactor() };
    }
    if (token.kind === "number") {
      next();
      return { kind: "number", value: token.value };
    }
    if (token.kind === "identifier") {
      next();
      return { kind: "identifier", name: token.name };
    }
    if (token.kind === "paren" && token.paren === "(") {
      next();
      const inner = parseExpression();
      const closing = next();
      if (!closing || closing.kind !== "paren" || closing.paren !== ")") {
        throw new FormulaError("Missing closing parenthesis");
      }
      return inner;
    }
    throw new FormulaError("Unexpected token in formula");
  }

  const expr = parseExpression();
  if (pos !== tokens.length) throw new FormulaError("Unexpected trailing input in formula");
  return expr;
}

function parseFormulaToAst(formula: string): Expr {
  if (!formula || !formula.trim()) throw new FormulaError("Formula is empty");
  return parse(tokenize(formula));
}

const astCache = new Map<string, Expr>();
function cachedAst(formula: string): Expr {
  let ast = astCache.get(formula);
  if (!ast) {
    ast = parseFormulaToAst(formula);
    astCache.set(formula, ast);
  }
  return ast;
}

/**
 * Parse a formula and return the variable names it references.
 * Throws FormulaError on invalid syntax (used by the validator).
 */
export function parseFormula(formula: string): { identifiers: string[] } {
  const identifiers = new Set<string>();
  const walk = (e: Expr) => {
    if (e.kind === "identifier") identifiers.add(e.name);
    else if (e.kind === "binary") {
      walk(e.left);
      walk(e.right);
    } else if (e.kind === "negate") walk(e.operand);
  };
  walk(parseFormulaToAst(formula));
  return { identifiers: [...identifiers] };
}

/**
 * Evaluate a formula against name-keyed values. Unknown identifiers and
 * non-numeric values evaluate as 0; division by zero yields 0 — a computed
 * variable should degrade, never crash a learner session.
 */
export function evaluateFormula(
  formula: string,
  values: Record<string, unknown>
): number {
  let ast: Expr;
  try {
    ast = cachedAst(formula);
  } catch {
    return 0;
  }
  const evalExpr = (e: Expr): number => {
    switch (e.kind) {
      case "number":
        return e.value;
      case "identifier": {
        const v = Number(values[e.name]);
        return Number.isFinite(v) ? v : 0;
      }
      case "negate":
        return -evalExpr(e.operand);
      case "binary": {
        const l = evalExpr(e.left);
        const r = evalExpr(e.right);
        switch (e.op) {
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/": return r === 0 ? 0 : l / r;
        }
      }
    }
  };
  const result = evalExpr(ast);
  return Number.isFinite(result) ? result : 0;
}
