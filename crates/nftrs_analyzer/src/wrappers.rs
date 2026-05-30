//! Bundler-wrapper unwrapping (ports the module-table parts of
//! `src/utils/wrappers.ts`).
//!
//! Rather than rewrite the AST like nft, we extract the bundle's **module
//! table** — the array/object of module factory functions webpack/browserify
//! emit. Entries that are pure `module.exports = require("X")` re-exports map a
//! module id (array index or object key) to an external specifier `X`. The
//! analyzer then (a) emits each external as a dependency and (b) binds locals
//! like `const fs = __webpack_require__(0)` to that module, so the ordinary
//! `fs`/`path`/asset detection works inside bundled code.

use rustc_hash::FxHashMap as HashMap;

use oxc_ast::ast::{Expression, PropertyKey, Statement};
use oxc_ast_visit::{walk, Visit};

/// Map from a module id (array index or object key, as a string) to the
/// external specifier its factory re-exports.
pub type Externals = HashMap<String, String>;

/// Scan `program` for bundler module tables and return the id → external map.
#[must_use]
pub fn extract_externals(program: &oxc_ast::ast::Program) -> Externals {
    let mut c = ExternalCollector { externals: HashMap::default() };
    c.visit_program(program);
    c.externals
}

struct ExternalCollector {
    externals: Externals,
}

/// If `expr` is a module factory whose body re-exports an external
/// (`module.exports = require("X")` / `e.exports = require("X")`), return `X`.
fn factory_external(expr: &Expression) -> Option<String> {
    let body = match crate::static_eval::unwrap_expr(expr) {
        Expression::FunctionExpression(f) => &f.body.as_ref()?.statements,
        Expression::ArrowFunctionExpression(a) => &a.body.statements,
        _ => return None,
    };
    for stmt in body {
        if let Some(x) = stmt_reexport(stmt) {
            return Some(x);
        }
    }
    None
}

/// `<obj>.exports = require("X")` -> `X`.
fn stmt_reexport(stmt: &Statement) -> Option<String> {
    let Statement::ExpressionStatement(es) = stmt else { return None };
    let Expression::AssignmentExpression(assign) = &es.expression else { return None };
    // left side must be a `*.exports` member
    let is_exports = match &assign.left {
        oxc_ast::ast::AssignmentTarget::StaticMemberExpression(m) => m.property.name == "exports",
        _ => false,
    };
    if !is_exports {
        return None;
    }
    let Expression::CallExpression(call) = &assign.right else { return None };
    let Expression::Identifier(callee) = &call.callee else { return None };
    if callee.name != "require" {
        return None;
    }
    match call.arguments.first() {
        Some(oxc_ast::ast::Argument::StringLiteral(s)) => Some(s.value.to_string()),
        _ => None,
    }
}

fn key_string(key: &PropertyKey) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(i) => Some(i.name.to_string()),
        PropertyKey::StringLiteral(s) => Some(s.value.to_string()),
        PropertyKey::NumericLiteral(n) => Some(format_index(n.value)),
        _ => None,
    }
}

fn format_index(n: f64) -> String {
    if n.fract() == 0.0 {
        (n as i64).to_string()
    } else {
        n.to_string()
    }
}

/// Browserify marks externals as `undefined`/`void 0` values in a module's
/// dependency map (`[factory, { "acorn": void 0 }]`). Record those names.
fn browserify_externals(arr: &oxc_ast::ast::ArrayExpression, out: &mut Externals) {
    if arr.elements.len() != 2 {
        return;
    }
    let (Some(Expression::FunctionExpression(_)), Some(Expression::ObjectExpression(dep_map))) =
        (arr.elements[0].as_expression(), arr.elements[1].as_expression())
    else {
        return;
    };
    for prop in &dep_map.properties {
        if let oxc_ast::ast::ObjectPropertyKind::ObjectProperty(p) = prop {
            if is_undefined(&p.value) {
                if let Some(name) = key_string(&p.key) {
                    out.insert(name.clone(), name);
                }
            }
        }
    }
}

fn is_undefined(expr: &Expression) -> bool {
    match expr {
        Expression::Identifier(id) => id.name == "undefined",
        Expression::UnaryExpression(u) => u.operator == oxc_syntax::operator::UnaryOperator::Void,
        _ => false,
    }
}

impl<'a> Visit<'a> for ExternalCollector {
    fn visit_array_expression(&mut self, arr: &oxc_ast::ast::ArrayExpression<'a>) {
        // A webpack module array: factories indexed by position.
        for (i, el) in arr.elements.iter().enumerate() {
            if let Some(expr) = el.as_expression() {
                if let Some(x) = factory_external(expr) {
                    self.externals.insert(i.to_string(), x);
                }
            }
        }
        // A browserify `[factory, depMap]` pair: externals are undefined values.
        browserify_externals(arr, &mut self.externals);
        walk::walk_array_expression(self, arr);
    }

    fn visit_object_expression(&mut self, obj: &oxc_ast::ast::ObjectExpression<'a>) {
        // A webpack module map: factories keyed by id.
        for prop in &obj.properties {
            if let oxc_ast::ast::ObjectPropertyKind::ObjectProperty(p) = prop {
                if let Some(key) = key_string(&p.key) {
                    if let Some(x) = factory_external(&p.value) {
                        self.externals.insert(key, x);
                    }
                }
            }
        }
        walk::walk_object_expression(self, obj);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_parser::Parser;
    use oxc_span::SourceType;

    fn externals(src: &str) -> Externals {
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, src, SourceType::default()).parse();
        extract_externals(&ret.program)
    }

    #[test]
    fn webpack_array_module_table() {
        let ext = externals(
            "!function(e){}([\
               function(e,t){e.exports=require(\"fs\")},\
               function(e,t){e.exports=require(\"path\")},\
               function(e,t,r){r(0).readFileSync(r(1).resolve(__dirname,'a'))}\
             ]);",
        );
        assert_eq!(ext.get("0").map(String::as_str), Some("fs"));
        assert_eq!(ext.get("1").map(String::as_str), Some("path"));
        assert_eq!(ext.get("2"), None);
    }

    #[test]
    fn webpack_object_module_table_string_keys() {
        let ext = externals(
            "({\"oyvS\":(function(module,exports){module.exports=require(\"path\")}),\
               \"mw/K\":(function(module,exports){module.exports=require(\"fs\")})});",
        );
        assert_eq!(ext.get("oyvS").map(String::as_str), Some("path"));
        assert_eq!(ext.get("mw/K").map(String::as_str), Some("fs"));
    }

    #[test]
    fn factory_with_use_strict_directive() {
        let ext = externals("({747:(function(m,e){\"use strict\";m.exports=require(\"fs\")})});");
        assert_eq!(ext.get("747").map(String::as_str), Some("fs"));
    }

    #[test]
    fn browserify_external_dep_map() {
        let ext = externals(
            "(function(){})({1:[function(s,e,t){var a=s(\"acorn\")},{acorn:void 0}]},{},[1])(1);",
        );
        assert_eq!(ext.get("acorn").map(String::as_str), Some("acorn"));
    }

    #[test]
    fn non_bundle_yields_no_externals() {
        let ext = externals("const a = [function(){}, () => 1]; const o = { x: function(){} };");
        assert!(ext.is_empty());
    }
}
