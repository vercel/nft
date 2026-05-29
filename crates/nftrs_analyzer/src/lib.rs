//! Source analysis for nftrs.
//!
//! Ports `src/analyze.ts` from `@vercel/nft`: parse a module with OXC, walk
//! the AST, and extract `{ deps, imports, assets, is_esm }`. This is an early
//! slice that handles only statically-resolvable `require('literal')`,
//! `import('literal')`, and static `import`/`export ... from` specifiers; the
//! heavier sub-systems land in follow-ups:
//!
//! - [`static_eval`] — static expression evaluation (#16)
//! - [`wrappers`] — unwrap bundler output (#19)
//! - [`special_cases`] — per-package hacks (#20)
//!
//! See <https://github.com/ubugeeei-prod/nftrs/issues/13> and #14.

pub mod special_cases;
pub mod static_eval;
pub mod wrappers;

use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{Argument, Expression};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;

/// Result of analyzing one module.
#[derive(Debug, Default)]
pub struct AnalyzeResult {
    /// CommonJS-style dependencies (`require(...)`, dynamic `import(...)`).
    pub deps: Vec<String>,
    /// ESM static dependencies (`import`/`export ... from`).
    pub imports: Vec<String>,
    /// Whether the module is ESM (has any `import`/`export`).
    pub is_esm: bool,
    /// Whether parsing produced (recoverable) errors.
    pub parse_error: bool,
}

/// Pick an OXC [`SourceType`] from a file extension. Defaults to ESM so that
/// both `require()` calls and `import` statements are captured.
fn source_type_for(path: &Path) -> SourceType {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let base = SourceType::default().with_module(true);
    match ext {
        "ts" | "cts" | "mts" => base.with_typescript(true),
        "tsx" => base.with_typescript(true).with_jsx(true),
        "jsx" => base.with_jsx(true),
        _ => base,
    }
}

/// Analyze `source` for the module at `path`.
#[must_use]
pub fn analyze(path: &Path, source: &str) -> AnalyzeResult {
    let allocator = Allocator::default();
    let source_type = source_type_for(path);
    let ret = Parser::new(&allocator, source, source_type).parse();

    let mut result = AnalyzeResult { parse_error: !ret.errors.is_empty(), ..Default::default() };

    // A hard parse failure (panicked) yields no usable AST; treat as a
    // dependency-free module and let the caller surface a warning.
    if ret.panicked {
        return result;
    }

    let mut collector = DepCollector::default();
    collector.visit_program(&ret.program);
    result.deps = collector.deps;
    result.imports = collector.imports;
    result.is_esm = collector.is_esm || source_type.is_module() && collector.has_esm_syntax;
    result
}

#[derive(Default)]
struct DepCollector {
    deps: Vec<String>,
    imports: Vec<String>,
    is_esm: bool,
    has_esm_syntax: bool,
}

impl<'a> Visit<'a> for DepCollector {
    fn visit_call_expression(&mut self, call: &oxc_ast::ast::CallExpression<'a>) {
        if let Expression::Identifier(id) = &call.callee {
            if id.name == "require" {
                if let Some(Argument::StringLiteral(s)) = call.arguments.first() {
                    self.deps.push(s.value.to_string());
                }
            }
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_import_expression(&mut self, expr: &oxc_ast::ast::ImportExpression<'a>) {
        if let Expression::StringLiteral(s) = &expr.source {
            self.deps.push(s.value.to_string());
        }
        walk::walk_import_expression(self, expr);
    }

    fn visit_import_declaration(&mut self, decl: &oxc_ast::ast::ImportDeclaration<'a>) {
        self.has_esm_syntax = true;
        self.is_esm = true;
        self.imports.push(decl.source.value.to_string());
        walk::walk_import_declaration(self, decl);
    }

    fn visit_export_named_declaration(&mut self, decl: &oxc_ast::ast::ExportNamedDeclaration<'a>) {
        self.has_esm_syntax = true;
        self.is_esm = true;
        if let Some(src) = &decl.source {
            self.imports.push(src.value.to_string());
        }
        walk::walk_export_named_declaration(self, decl);
    }

    fn visit_export_all_declaration(&mut self, decl: &oxc_ast::ast::ExportAllDeclaration<'a>) {
        self.has_esm_syntax = true;
        self.is_esm = true;
        self.imports.push(decl.source.value.to_string());
        walk::walk_export_all_declaration(self, decl);
    }

    fn visit_export_default_declaration(
        &mut self,
        decl: &oxc_ast::ast::ExportDefaultDeclaration<'a>,
    ) {
        self.has_esm_syntax = true;
        self.is_esm = true;
        walk::walk_export_default_declaration(self, decl);
    }
}
