//! Safe arithmetic for computed variables: numbers, identifiers (variable
//! names), `+ - * /`, and parentheses. A small recursive-descent parser — no
//! `eval`. Ported from the reference TS `formulaEval`; the validator uses
//! [`identifiers`] to check that a formula references only real variables.

use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq)]
pub struct FormulaError(pub String);

impl std::fmt::Display for FormulaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    Ident(String),
    Op(char),
    LParen,
    RParen,
}

fn tokenize(formula: &str) -> Result<Vec<Token>, FormulaError> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = formula.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
        } else if ch.is_ascii_digit() || ch == '.' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let raw: String = chars[start..i].iter().collect();
            let value: f64 = raw
                .parse()
                .map_err(|_| FormulaError(format!("Invalid number \"{raw}\"")))?;
            tokens.push(Token::Number(value));
        } else if ch.is_ascii_alphabetic() || ch == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            tokens.push(Token::Ident(chars[start..i].iter().collect()));
        } else if matches!(ch, '+' | '-' | '*' | '/') {
            tokens.push(Token::Op(ch));
            i += 1;
        } else if ch == '(' {
            tokens.push(Token::LParen);
            i += 1;
        } else if ch == ')' {
            tokens.push(Token::RParen);
            i += 1;
        } else {
            return Err(FormulaError(format!("Unexpected character \"{ch}\" in formula")));
        }
    }
    Ok(tokens)
}

#[derive(Debug, Clone)]
enum Expr {
    Number(f64),
    Ident(String),
    Binary(char, Box<Expr>, Box<Expr>),
    Negate(Box<Expr>),
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }
    fn next(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        self.pos += 1;
        t
    }

    fn parse_expression(&mut self) -> Result<Expr, FormulaError> {
        let mut left = self.parse_term()?;
        while let Some(Token::Op(op @ ('+' | '-'))) = self.peek().cloned() {
            self.next();
            let right = self.parse_term()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_term(&mut self) -> Result<Expr, FormulaError> {
        let mut left = self.parse_factor()?;
        while let Some(Token::Op(op @ ('*' | '/'))) = self.peek().cloned() {
            self.next();
            let right = self.parse_factor()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_factor(&mut self) -> Result<Expr, FormulaError> {
        match self.peek().cloned() {
            None => Err(FormulaError("Unexpected end of formula".into())),
            Some(Token::Op('-')) => {
                self.next();
                Ok(Expr::Negate(Box::new(self.parse_factor()?)))
            }
            Some(Token::Number(v)) => {
                self.next();
                Ok(Expr::Number(v))
            }
            Some(Token::Ident(name)) => {
                self.next();
                Ok(Expr::Ident(name))
            }
            Some(Token::LParen) => {
                self.next();
                let inner = self.parse_expression()?;
                match self.next() {
                    Some(Token::RParen) => Ok(inner),
                    _ => Err(FormulaError("Missing closing parenthesis".into())),
                }
            }
            Some(_) => Err(FormulaError("Unexpected token in formula".into())),
        }
    }
}

fn parse_to_ast(formula: &str) -> Result<Expr, FormulaError> {
    if formula.trim().is_empty() {
        return Err(FormulaError("Formula is empty".into()));
    }
    let mut parser = Parser {
        tokens: tokenize(formula)?,
        pos: 0,
    };
    let expr = parser.parse_expression()?;
    if parser.pos != parser.tokens.len() {
        return Err(FormulaError("Unexpected trailing input in formula".into()));
    }
    Ok(expr)
}

/// The variable names a formula references. Errors on invalid syntax (the
/// validator turns that into `variable/formula-invalid`).
pub fn identifiers(formula: &str) -> Result<Vec<String>, FormulaError> {
    let ast = parse_to_ast(formula)?;
    let mut set = BTreeSet::new();
    fn walk(e: &Expr, set: &mut BTreeSet<String>) {
        match e {
            Expr::Ident(name) => {
                set.insert(name.clone());
            }
            Expr::Binary(_, l, r) => {
                walk(l, set);
                walk(r, set);
            }
            Expr::Negate(inner) => walk(inner, set),
            Expr::Number(_) => {}
        }
    }
    walk(&ast, &mut set);
    Ok(set.into_iter().collect())
}

/// Evaluate a formula against name→number values. Unknown identifiers and
/// division by zero degrade to 0 — a computed variable should never crash a
/// learner session.
pub fn evaluate(formula: &str, values: &std::collections::HashMap<String, f64>) -> f64 {
    let ast = match parse_to_ast(formula) {
        Ok(a) => a,
        Err(_) => return 0.0,
    };
    fn eval(e: &Expr, values: &std::collections::HashMap<String, f64>) -> f64 {
        let result = match e {
            Expr::Number(v) => *v,
            Expr::Ident(name) => values.get(name).copied().unwrap_or(0.0),
            Expr::Negate(inner) => -eval(inner, values),
            Expr::Binary(op, l, r) => {
                let l = eval(l, values);
                let r = eval(r, values);
                match op {
                    '+' => l + r,
                    '-' => l - r,
                    '*' => l * r,
                    '/' => {
                        if r == 0.0 {
                            0.0
                        } else {
                            l / r
                        }
                    }
                    _ => 0.0,
                }
            }
        };
        if result.is_finite() {
            result
        } else {
            0.0
        }
    }
    eval(&ast, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_identifiers() {
        let mut ids = identifiers("correct / total * 100").unwrap();
        ids.sort();
        assert_eq!(ids, vec!["correct".to_string(), "total".to_string()]);
    }

    #[test]
    fn rejects_bad_syntax() {
        assert!(identifiers("1 +").is_err());
        assert!(identifiers("(a + b").is_err());
        assert!(identifiers("").is_err());
    }

    #[test]
    fn evaluates_with_precedence_and_safe_division() {
        let mut v = std::collections::HashMap::new();
        v.insert("correct".to_string(), 3.0);
        v.insert("total".to_string(), 4.0);
        assert_eq!(evaluate("correct / total * 100", &v), 75.0);
        assert_eq!(evaluate("1 + 2 * 3", &v), 7.0);
        assert_eq!(evaluate("x / 0", &v), 0.0); // unknown → 0, div by zero → 0
    }
}
