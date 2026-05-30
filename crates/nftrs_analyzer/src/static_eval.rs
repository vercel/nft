//! Static expression evaluation.
//!
//! Ports the parts of `src/utils/static-eval.ts` and the `path`/`process`
//! static modules from `src/analyze.ts` needed to resolve asset paths and
//! dynamic `require`/`import` specifiers. Supports:
//!
//! - constant folding of string/number/boolean values,
//! - template literals and `path.join`/`resolve`/`dirname`,
//! - **wildcards**: an unknown sub-expression in a `+`/template/call-arg
//!   context becomes the [`WILDCARD`] sentinel so the parent computes a glob
//!   (e.g. `` `./modules/module${n}` `` → `./modules/module\x1a`), and
//! - **conditional values**: `cond ? a : b` (and tracked variables holding
//!   them) yield a [`Flow::Cond`] so a `require` emits both branches.
//!
//! See <https://github.com/ubugeeei-prod/nftrs/issues/16>, #48.

use std::collections::HashMap;

use oxc_ast::ast::{Expression, TemplateLiteral};

/// The wildcard sentinel char (`\x1a`), matching nft's `WILDCARD`.
pub const WILDCARD: char = '\u{1a}';

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
    /// A destructured `path.sep`.
    PathSep,
}

/// Unwrap parentheses and `(0, expr)` sequence wrappers (TS/Babel interop)
/// down to the effective expression.
#[must_use]
pub fn unwrap_expr<'a, 'b>(expr: &'b Expression<'a>) -> &'b Expression<'a> {
    match expr {
        Expression::ParenthesizedExpression(p) => unwrap_expr(&p.expression),
        Expression::SequenceExpression(s) => s.expressions.last().map_or(expr, |e| unwrap_expr(e)),
        _ => expr,
    }
}

/// Evaluation context: the intrinsic `__dirname`/`__filename`/`process.cwd()`
/// values, tracked bindings, and statically-known local variables.
pub struct EvalCtx<'b> {
    pub dirname: String,
    pub filename: String,
    pub cwd: String,
    pub bindings: &'b HashMap<String, Binding>,
    /// Locals bound to a statically-known value, e.g. `const x = './a'`.
    pub vars: &'b HashMap<String, Flow>,
}

/// A statically-evaluated value. Only the variants nft's analysis needs.
#[derive(Clone)]
pub enum Value {
    Str(String),
    Num(f64),
    Bool(bool),
}

impl Value {
    fn as_concat_str(&self) -> String {
        match self {
            Value::Str(s) => s.clone(),
            Value::Num(n) => format_num(*n),
            Value::Bool(b) => b.to_string(),
        }
    }

    fn truthy(&self) -> bool {
        match self {
            Value::Str(s) => !s.is_empty(),
            Value::Num(n) => *n != 0.0 && !n.is_nan(),
            Value::Bool(b) => *b,
        }
    }
}

/// The result of evaluating an expression: either a single known value
/// (carrying a wildcard count) or a two-branch conditional.
#[derive(Clone)]
pub enum Flow {
    /// A single known value. `wildcards` counts embedded [`WILDCARD`] markers.
    Value { value: Value, wildcards: u32 },
    /// `test ? if_true : els` where `test` is not statically known.
    Cond { if_true: Value, els: Value },
}

impl Flow {
    fn known(value: Value) -> Flow {
        Flow::Value { value, wildcards: 0 }
    }
}

fn format_num(n: f64) -> String {
    if n.fract() == 0.0 && n.is_finite() {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn count_wildcards(s: &str) -> u32 {
    u32::try_from(s.matches(WILDCARD).count()).unwrap_or(u32::MAX)
}

/// Evaluate `expr` to a single value, if statically knowable.
///
/// Returns the string/number/bool; the string may embed [`WILDCARD`] markers.
/// Returns `None` for conditional or unknown values.
pub fn eval(expr: &Expression, ctx: &EvalCtx) -> Option<Value> {
    match eval_flow(expr, ctx)? {
        Flow::Value { value, .. } => Some(value),
        Flow::Cond { .. } => None,
    }
}

/// Evaluate `expr` to a [`Flow`] (value-or-conditional), if statically
/// knowable. This is the full nft `evaluate` with `computeBranches = true`.
pub fn eval_flow(expr: &Expression, ctx: &EvalCtx) -> Option<Flow> {
    match expr {
        Expression::StringLiteral(s) => Some(Flow::known(Value::Str(s.value.to_string()))),
        Expression::NumericLiteral(n) => Some(Flow::known(Value::Num(n.value))),
        Expression::BooleanLiteral(b) => Some(Flow::known(Value::Bool(b.value))),
        Expression::TemplateLiteral(t) => eval_template(t, ctx),
        Expression::Identifier(id) => match id.name.as_str() {
            "__dirname" => Some(Flow::known(Value::Str(ctx.dirname.clone()))),
            "__filename" => Some(Flow::known(Value::Str(ctx.filename.clone()))),
            name => match ctx.bindings.get(name) {
                Some(Binding::PathSep) => Some(Flow::known(Value::Str("/".to_string()))),
                _ => ctx.vars.get(name).cloned(),
            },
        },
        Expression::StaticMemberExpression(member) => {
            // `path.sep`
            if member.property.name == "sep" {
                if let Expression::Identifier(obj) = &member.object {
                    if matches!(ctx.bindings.get(obj.name.as_str()), Some(Binding::PathModule)) {
                        return Some(Flow::known(Value::Str("/".to_string())));
                    }
                }
            }
            None
        }
        Expression::BinaryExpression(bin) => eval_binary(bin, ctx),
        Expression::LogicalExpression(log) => eval_logical(log, ctx),
        Expression::ConditionalExpression(cond) => eval_conditional(cond, ctx),
        Expression::CallExpression(call) => eval_call(call, ctx),
        Expression::ParenthesizedExpression(p) => eval_flow(&p.expression, ctx),
        Expression::SequenceExpression(_) => eval_flow(unwrap_expr(expr), ctx),
        _ => None,
    }
}

fn eval_binary(bin: &oxc_ast::ast::BinaryExpression, ctx: &EvalCtx) -> Option<Flow> {
    use oxc_ast::ast::BinaryOperator;
    let op = bin.operator;
    let l = eval_flow(&bin.left, ctx);
    let r = eval_flow(&bin.right, ctx);

    // Wildcard fallback for `+` when exactly one side is unknown.
    if op == BinaryOperator::Addition {
        match (&l, &r) {
            (None, Some(Flow::Value { value: Value::Str(rs), wildcards })) => {
                return Some(Flow::Value {
                    value: Value::Str(format!("{WILDCARD}{rs}")),
                    wildcards: wildcards + 1,
                });
            }
            (Some(Flow::Value { value: Value::Str(ls), wildcards }), None) => {
                return Some(Flow::Value {
                    value: Value::Str(format!("{ls}{WILDCARD}")),
                    wildcards: wildcards + 1,
                });
            }
            _ => {}
        }
    }

    let l = l?;
    let r = r?;
    // Conditional propagation: one side conditional, the other a plain value.
    match (&l, &r) {
        (Flow::Cond { if_true, els }, Flow::Value { value, .. }) => {
            return apply_binop(op, if_true, value)
                .and_then(|t| apply_binop(op, els, value).map(|e| Flow::Cond { if_true: t, els: e }));
        }
        (Flow::Value { value, .. }, Flow::Cond { if_true, els }) => {
            return apply_binop(op, value, if_true)
                .and_then(|t| apply_binop(op, value, els).map(|e| Flow::Cond { if_true: t, els: e }));
        }
        (Flow::Value { value: lv, wildcards: lw }, Flow::Value { value: rv, wildcards: rw }) => {
            let res = apply_binop(op, lv, rv)?;
            let wildcards = if op == BinaryOperator::Addition { lw + rw } else { 0 };
            return Some(Flow::Value { value: res, wildcards });
        }
        _ => {}
    }
    None
}

fn apply_binop(op: oxc_ast::ast::BinaryOperator, l: &Value, r: &Value) -> Option<Value> {
    use oxc_ast::ast::BinaryOperator as B;
    match op {
        B::Addition => Some(match (l, r) {
            (Value::Num(a), Value::Num(b)) => Value::Num(a + b),
            _ => Value::Str(format!("{}{}", l.as_concat_str(), r.as_concat_str())),
        }),
        B::Equality | B::StrictEquality => Some(Value::Bool(values_eq(l, r))),
        B::Inequality | B::StrictInequality => Some(Value::Bool(!values_eq(l, r))),
        _ => None,
    }
}

fn values_eq(l: &Value, r: &Value) -> bool {
    match (l, r) {
        (Value::Str(a), Value::Str(b)) => a == b,
        (Value::Num(a), Value::Num(b)) => a == b,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        _ => false,
    }
}

fn eval_logical(log: &oxc_ast::ast::LogicalExpression, ctx: &EvalCtx) -> Option<Flow> {
    use oxc_ast::ast::LogicalOperator;
    let l = eval_flow(&log.left, ctx);
    match log.operator {
        LogicalOperator::Or => match l {
            // A || B -> A if A is truthy and known
            Some(Flow::Value { value, wildcards }) if value.truthy() => {
                Some(Flow::Value { value, wildcards })
            }
            Some(Flow::Value { .. }) => eval_flow(&log.right, ctx),
            _ => None,
        },
        LogicalOperator::And => match l {
            Some(Flow::Value { value, .. }) if !value.truthy() => Some(Flow::known(value)),
            Some(Flow::Value { .. }) => eval_flow(&log.right, ctx),
            _ => None,
        },
        LogicalOperator::Coalesce => match l {
            Some(Flow::Value { value, wildcards }) => Some(Flow::Value { value, wildcards }),
            _ => eval_flow(&log.right, ctx),
        },
    }
}

fn eval_conditional(cond: &oxc_ast::ast::ConditionalExpression, ctx: &EvalCtx) -> Option<Flow> {
    // Known test -> pick the branch.
    if let Some(Flow::Value { value, .. }) = eval_flow(&cond.test, ctx) {
        return if value.truthy() {
            eval_flow(&cond.consequent, ctx)
        } else {
            eval_flow(&cond.alternate, ctx)
        };
    }
    // Unknown test -> two-branch conditional, but only if both branches are
    // plain wildcard-free values.
    let Flow::Value { value: then_v, wildcards: 0 } = eval_flow(&cond.consequent, ctx)? else {
        return None;
    };
    let Flow::Value { value: else_v, wildcards: 0 } = eval_flow(&cond.alternate, ctx)? else {
        return None;
    };
    Some(Flow::Cond { if_true: then_v, els: else_v })
}

fn eval_template(t: &TemplateLiteral, ctx: &EvalCtx) -> Option<Flow> {
    // Accumulate either a single value (with wildcard count) or, once a single
    // conditional interpolation is seen, two branches. nft supports at most one
    // conditional branch per template.
    enum Acc {
        Value { out: String, wildcards: u32 },
        Cond { if_true: String, els: String },
    }
    let mut acc = Acc::Value { out: String::new(), wildcards: 0 };
    for (i, quasi) in t.quasis.iter().enumerate() {
        let cooked = quasi.value.cooked.as_ref()?.as_str();
        match &mut acc {
            Acc::Value { out, .. } => out.push_str(cooked),
            Acc::Cond { if_true, els } => {
                if_true.push_str(cooked);
                els.push_str(cooked);
            }
        }
        let Some(expr) = t.expressions.get(i) else { continue };
        match eval_flow(expr, ctx) {
            Some(Flow::Value { value, wildcards: w }) => {
                let s = value.as_concat_str();
                match &mut acc {
                    Acc::Value { out, wildcards } => {
                        out.push_str(&s);
                        *wildcards += w;
                    }
                    Acc::Cond { if_true, els } => {
                        // wildcards inside a branch are unsupported
                        if w > 0 {
                            return None;
                        }
                        if_true.push_str(&s);
                        els.push_str(&s);
                    }
                }
            }
            // Unknown interpolation -> wildcard (computeBranches).
            None => match &mut acc {
                Acc::Value { out, wildcards } => {
                    out.push(WILDCARD);
                    *wildcards += 1;
                }
                Acc::Cond { .. } => return None,
            },
            Some(Flow::Cond { if_true: ct, els: ce }) => match acc {
                // promote to a conditional template (only one allowed)
                Acc::Value { out, wildcards: 0 } => {
                    acc = Acc::Cond {
                        if_true: format!("{out}{}", ct.as_concat_str()),
                        els: format!("{out}{}", ce.as_concat_str()),
                    };
                }
                _ => return None,
            },
        }
    }
    Some(match acc {
        Acc::Value { out, wildcards } => Flow::Value { value: Value::Str(out), wildcards },
        Acc::Cond { if_true, els } => {
            Flow::Cond { if_true: Value::Str(if_true), els: Value::Str(els) }
        }
    })
}

fn eval_call(call: &oxc_ast::ast::CallExpression, ctx: &EvalCtx) -> Option<Flow> {
    let kind = call_kind(call, ctx)?;
    // Evaluate args, substituting WILDCARD for unknown ones (computeBranches).
    // `concat` never trips the all-unknown bail (matches nft's `allWildcards`
    // gate: `args.length > 0 && property !== 'concat'`). One conditional arg is
    // allowed, producing a conditional result (`args` + `args_else`).
    let is_concat = matches!(kind, CallKind::Concat(_));
    let mut args: Vec<String> = Vec::with_capacity(call.arguments.len());
    let mut args_else: Option<Vec<String>> = None;
    let mut wildcards = 0u32;
    let mut all_wildcards = !call.arguments.is_empty() && !is_concat;
    for arg in &call.arguments {
        match arg.as_expression().and_then(|e| eval_flow(e, ctx)) {
            Some(Flow::Value { value, .. }) => {
                all_wildcards = false;
                let s = value.as_concat_str();
                wildcards += count_wildcards(&s);
                if let Some(e) = &mut args_else {
                    e.push(s.clone());
                }
                args.push(s);
            }
            Some(Flow::Cond { if_true, els }) => {
                // a single conditional arg, no wildcards alongside it
                if wildcards > 0 || args_else.is_some() {
                    return None;
                }
                all_wildcards = false;
                args_else = Some(args.clone());
                if let Some(e) = &mut args_else {
                    e.push(els.as_concat_str());
                }
                args.push(if_true.as_concat_str());
            }
            // Spread / non-expression / unknown args become a WILDCARD.
            None => {
                if let Some(e) = &mut args_else {
                    e.push(WILDCARD.to_string());
                }
                args.push(WILDCARD.to_string());
                wildcards += 1;
            }
        }
    }
    if all_wildcards {
        return None;
    }
    let apply = |args: &[String]| -> Option<String> {
        Some(match &kind {
            CallKind::PathJoin => path_join(args),
            CallKind::PathResolve => path_resolve(&ctx.cwd, args),
            CallKind::PathDirname => dirname(args.first()?),
            CallKind::ProcessCwd => ctx.cwd.clone(),
            CallKind::Concat(base) => format!("{base}{}", args.concat()),
        })
    };
    let result = apply(&args)?;
    if let Some(args_else) = args_else {
        let result_else = apply(&args_else)?;
        return Some(Flow::Cond {
            if_true: Value::Str(result),
            els: Value::Str(result_else),
        });
    }
    // nft validates the wildcard count is preserved by the static fn.
    if wildcards > 0 && count_wildcards(&result) != wildcards {
        return None;
    }
    Some(Flow::Value { value: Value::Str(result), wildcards })
}

/// What kind of statically-evaluable call this is, if any.
enum CallKind {
    PathJoin,
    PathResolve,
    PathDirname,
    ProcessCwd,
    /// `'base'.concat(...)` — carries the base string.
    Concat(String),
}

fn call_kind(call: &oxc_ast::ast::CallExpression, ctx: &EvalCtx) -> Option<CallKind> {
    match unwrap_expr(&call.callee) {
        Expression::Identifier(id) => match ctx.bindings.get(id.name.as_str()) {
            Some(Binding::PathJoin) => Some(CallKind::PathJoin),
            Some(Binding::PathResolve) => Some(CallKind::PathResolve),
            Some(Binding::PathDirname) => Some(CallKind::PathDirname),
            _ => None,
        },
        Expression::StaticMemberExpression(member) => {
            let prop = member.property.name.as_str();
            if let Expression::Identifier(obj) = &member.object {
                match ctx.bindings.get(obj.name.as_str()) {
                    Some(Binding::PathModule) => match prop {
                        "join" => Some(CallKind::PathJoin),
                        "resolve" => Some(CallKind::PathResolve),
                        "dirname" => Some(CallKind::PathDirname),
                        _ => None,
                    },
                    Some(Binding::ProcessModule) if prop == "cwd" => Some(CallKind::ProcessCwd),
                    _ if obj.name == "process" && prop == "cwd" => Some(CallKind::ProcessCwd),
                    _ => None,
                }
            } else if prop == "concat" {
                // `'str'.concat(a, b, ...)` on a statically-known string.
                match eval(&member.object, ctx)? {
                    Value::Str(base) => Some(CallKind::Concat(base)),
                    _ => None,
                }
            } else {
                None
            }
        }
        _ => None,
    }
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
/// leading `/`. Wildcard markers are treated as ordinary path segments.
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

/// Whether evaluating `expr` depends on a path "trigger".
///
/// Triggers are `__dirname`, `__filename`, `process.cwd()`, or
/// `path.resolve(...)`. nft only emits a computed absolute path as an asset
/// when it traces back to such a trigger (so bare string literals like
/// `'/etc/passwd'` are not emitted).
#[must_use]
pub fn contains_trigger(expr: &Expression, ctx: &EvalCtx) -> bool {
    match expr {
        Expression::Identifier(id) => matches!(id.name.as_str(), "__dirname" | "__filename"),
        Expression::TemplateLiteral(t) => t.expressions.iter().any(|e| contains_trigger(e, ctx)),
        Expression::BinaryExpression(b) => {
            contains_trigger(&b.left, ctx) || contains_trigger(&b.right, ctx)
        }
        Expression::ParenthesizedExpression(p) => contains_trigger(&p.expression, ctx),
        Expression::CallExpression(call) => {
            if is_cwd_or_resolve(call, ctx) {
                return true;
            }
            call.arguments
                .iter()
                .filter_map(oxc_ast::ast::Argument::as_expression)
                .any(|e| contains_trigger(e, ctx))
        }
        _ => false,
    }
}

fn is_cwd_or_resolve(call: &oxc_ast::ast::CallExpression, ctx: &EvalCtx) -> bool {
    match &call.callee {
        Expression::Identifier(id) => {
            matches!(ctx.bindings.get(id.name.as_str()), Some(Binding::PathResolve))
        }
        Expression::StaticMemberExpression(member) => {
            let prop = member.property.name.as_str();
            if let Expression::Identifier(obj) = &member.object {
                (obj.name == "process" && prop == "cwd")
                    || (matches!(ctx.bindings.get(obj.name.as_str()), Some(Binding::PathModule))
                        && prop == "resolve")
                    || (matches!(ctx.bindings.get(obj.name.as_str()), Some(Binding::ProcessModule))
                        && prop == "cwd")
            } else {
                false
            }
        }
        _ => false,
    }
}
