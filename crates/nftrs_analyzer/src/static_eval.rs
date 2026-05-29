//! Static expression evaluation.
//!
//! Ports the parts of `src/utils/static-eval.ts` and the `path`/`process`
//! static modules from `src/analyze.ts` needed to resolve asset paths like
//! `fs.readFileSync(__dirname + '/asset.txt')`, `` `${__dirname}/x` ``, and
//! `path.join(__dirname, 'x')`.
//!
//! Conditional/wildcard branch values (used by glob requires) are not modeled
//! yet — see <https://github.com/ubugeeei-prod/nftrs/issues/16>.

use std::collections::HashMap;

use oxc_ast::ast::{Expression, TemplateLiteral};

/// What a tracked identifier refers to.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Binding {
    /// The `path` module object.
    PathModule,
    /// The `process` object.
    ProcessModule,
    /// A destructured `path.join`.
    PathJoin,
    /// A destructured `path.resolve`.
    PathResolve,
    /// A destructured `path.dirname`.
    PathDirname,
}

/// Evaluation context: the intrinsic `__dirname`/`__filename`/`process.cwd()`
/// values and the set of tracked bindings.
pub struct EvalCtx<'b> {
    pub dirname: String,
    pub filename: String,
    pub cwd: String,
    pub bindings: &'b HashMap<String, Binding>,
}

/// A statically-evaluated value. Only the variants nft's asset analysis needs.
#[derive(Clone)]
pub enum Value {
    Str(String),
    Num(f64),
}

impl Value {
    fn as_concat_str(&self) -> String {
        match self {
            Value::Str(s) => s.clone(),
            Value::Num(n) => format_num(*n),
        }
    }
}

fn format_num(n: f64) -> String {
    if n.fract() == 0.0 && n.is_finite() {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Evaluate `expr` to a constant value, if statically knowable.
pub fn eval(expr: &Expression, ctx: &EvalCtx) -> Option<Value> {
    match expr {
        Expression::StringLiteral(s) => Some(Value::Str(s.value.to_string())),
        Expression::NumericLiteral(n) => Some(Value::Num(n.value)),
        Expression::TemplateLiteral(t) => eval_template(t, ctx),
        Expression::Identifier(id) => match id.name.as_str() {
            "__dirname" => Some(Value::Str(ctx.dirname.clone())),
            "__filename" => Some(Value::Str(ctx.filename.clone())),
            _ => None,
        },
        Expression::BinaryExpression(bin) => {
            use oxc_ast::ast::BinaryOperator;
            if bin.operator != BinaryOperator::Addition {
                return None;
            }
            let l = eval(&bin.left, ctx)?;
            let r = eval(&bin.right, ctx)?;
            match (&l, &r) {
                (Value::Num(a), Value::Num(b)) => Some(Value::Num(a + b)),
                _ => Some(Value::Str(format!("{}{}", l.as_concat_str(), r.as_concat_str()))),
            }
        }
        Expression::CallExpression(call) => eval_call(call, ctx),
        Expression::ParenthesizedExpression(p) => eval(&p.expression, ctx),
        _ => None,
    }
}

fn eval_template(t: &TemplateLiteral, ctx: &EvalCtx) -> Option<Value> {
    let mut out = String::new();
    for (i, quasi) in t.quasis.iter().enumerate() {
        let cooked = quasi.value.cooked.as_ref()?;
        out.push_str(cooked.as_str());
        if let Some(expr) = t.expressions.get(i) {
            out.push_str(&eval(expr, ctx)?.as_concat_str());
        }
    }
    Some(Value::Str(out))
}

fn eval_call(call: &oxc_ast::ast::CallExpression, ctx: &EvalCtx) -> Option<Value> {
    match &call.callee {
        // join(...), resolve(...), dirname(...) via destructured bindings
        Expression::Identifier(id) => match ctx.bindings.get(id.name.as_str()) {
            Some(Binding::PathJoin) => Some(Value::Str(path_join(&str_args(call, ctx)?))),
            Some(Binding::PathResolve) => {
                Some(Value::Str(path_resolve(&ctx.cwd, &str_args(call, ctx)?)))
            }
            Some(Binding::PathDirname) => {
                let args = str_args(call, ctx)?;
                args.first().map(|a| Value::Str(dirname(a)))
            }
            _ => None,
        },
        // path.join(...), process.cwd(), etc.
        Expression::StaticMemberExpression(member) => {
            let prop = member.property.name.as_str();
            if let Expression::Identifier(obj) = &member.object {
                match ctx.bindings.get(obj.name.as_str()) {
                    Some(Binding::PathModule) => match prop {
                        "join" => Some(Value::Str(path_join(&str_args(call, ctx)?))),
                        "resolve" => {
                            Some(Value::Str(path_resolve(&ctx.cwd, &str_args(call, ctx)?)))
                        }
                        "dirname" => {
                            let args = str_args(call, ctx)?;
                            args.first().map(|a| Value::Str(dirname(a)))
                        }
                        _ => None,
                    },
                    Some(Binding::ProcessModule) if prop == "cwd" => {
                        Some(Value::Str(ctx.cwd.clone()))
                    }
                    _ => {
                        // intrinsic `process.cwd()`
                        if obj.name == "process" && prop == "cwd" {
                            Some(Value::Str(ctx.cwd.clone()))
                        } else {
                            None
                        }
                    }
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Evaluate all call arguments to strings, bailing if any is non-static or a
/// spread.
fn str_args(call: &oxc_ast::ast::CallExpression, ctx: &EvalCtx) -> Option<Vec<String>> {
    let mut out = Vec::with_capacity(call.arguments.len());
    for arg in &call.arguments {
        let expr = arg.as_expression()?;
        out.push(eval(expr, ctx)?.as_concat_str());
    }
    Some(out)
}

// ---- posix path helpers (the inputs/fixtures are posix) --------------------

/// `path.join`: concatenate parts with `/` and normalize.
#[must_use]
pub fn path_join(parts: &[String]) -> String {
    let joined = parts.iter().filter(|p| !p.is_empty()).cloned().collect::<Vec<_>>().join("/");
    if joined.is_empty() {
        ".".to_string()
    } else {
        normalize_posix(&joined)
    }
}

/// `path.resolve` from `cwd`: later absolute args reset the accumulator.
#[must_use]
pub fn path_resolve(cwd: &str, parts: &[String]) -> String {
    let mut cur = cwd.to_string();
    for part in parts {
        if part.starts_with('/') {
            cur.clone_from(part);
        } else if !part.is_empty() {
            cur = format!("{cur}/{part}");
        }
    }
    normalize_posix(&cur)
}

fn dirname(p: &str) -> String {
    let norm = normalize_posix(p);
    match norm.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => norm[..i].to_string(),
        None => ".".to_string(),
    }
}

/// Collapse `.`/`..` and duplicate slashes in a posix path, preserving a
/// leading `/`.
#[must_use]
pub fn normalize_posix(p: &str) -> String {
    let absolute = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if matches!(out.last(), Some(&s) if s != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    let body = out.join("/");
    if absolute {
        format!("/{body}")
    } else if body.is_empty() {
        ".".to_string()
    } else {
        body
    }
}

/// Whether `s` is an absolute path (posix `/...`).
#[must_use]
pub fn is_absolute_path(s: &str) -> bool {
    s.starts_with('/')
}
