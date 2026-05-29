//! Source analysis for nftrs.
//!
//! Ports `src/analyze.ts` from `@vercel/nft`: parse a module with OXC, walk
//! the AST, and extract `{ deps, imports, assets, is_esm }`. Handles
//! statically-resolvable `require`/`import`/`export … from`, dynamic
//! `import()`, `require.resolve`, and `fs.*`/`path.*`-driven asset references
//! (e.g. `fs.readFileSync(__dirname + '/asset.txt')`). The heavier sub-systems
//! land in follow-ups:
//!
//! - [`static_eval`] — static expression evaluation (#16)
//! - [`wrappers`] — unwrap bundler output (#19)
//! - [`special_cases`] — per-package hacks (#20)
//!
//! See <https://github.com/ubugeeei-prod/nftrs/issues/13>, #14, #17.

pub mod special_cases;
pub mod static_eval;
pub mod wrappers;

use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{Argument, BindingPattern, Expression};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;

use static_eval::{contains_trigger, eval, is_absolute_path, unwrap_expr, Binding, EvalCtx, Value};

/// A referenced asset, as an absolute path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Asset {
    /// A single file (e.g. `fs.readFileSync(__dirname + '/x')`).
    File(String),
    /// A directory to emit recursively (e.g. `fs.readdirSync(__dirname)`).
    Dir(String),
}

/// Context for analysis: the module's intrinsic values and analysis toggles.
pub struct AnalyzeContext {
    pub dirname: String,
    pub filename: String,
    pub cwd: String,
    /// Whether to compute `fs.*` file references (`analysis.computeFileReferences`).
    pub compute_file_references: bool,
}

/// Result of analyzing one module.
#[derive(Debug, Default)]
pub struct AnalyzeResult {
    /// CommonJS-style deps (`require(...)`, dynamic `import(...)`, `require.resolve`).
    pub deps: Vec<String>,
    /// ESM static dependencies (`import`/`export ... from`).
    pub imports: Vec<String>,
    /// Referenced assets (absolute paths).
    pub assets: Vec<Asset>,
    /// Whether the module is ESM.
    pub is_esm: bool,
    /// Whether parsing produced (recoverable) errors.
    pub parse_error: bool,
}

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
pub fn analyze(path: &Path, source: &str, ctx: &AnalyzeContext) -> AnalyzeResult {
    let allocator = Allocator::default();
    let source_type = source_type_for(path);
    let ret = Parser::new(&allocator, source, source_type).parse();

    let mut result = AnalyzeResult { parse_error: !ret.errors.is_empty(), ..Default::default() };
    if ret.panicked {
        return result;
    }

    // Pass 1: collect module bindings (path/fs/process aliases).
    let mut bindings = BindingCollector::default();
    bindings.visit_program(&ret.program);

    // Pass 2: collect deps/imports/assets.
    let eval_ctx = EvalCtx {
        dirname: ctx.dirname.clone(),
        filename: ctx.filename.clone(),
        cwd: ctx.cwd.clone(),
        bindings: &bindings.eval_bindings,
    };
    let mut collector = DepCollector {
        compute_file_references: ctx.compute_file_references,
        eval_ctx: &eval_ctx,
        fs_objects: &bindings.fs_objects,
        fs_fns: &bindings.fs_fns,
        deps: Vec::new(),
        imports: Vec::new(),
        assets: Vec::new(),
        is_esm: false,
        _marker: std::marker::PhantomData,
    };
    collector.visit_program(&ret.program);

    result.deps = collector.deps;
    result.imports = collector.imports;
    result.assets = collector.assets;
    result.is_esm = collector.is_esm;

    // Pass 3: general asset scan — emit maximal static absolute-path
    // expressions that trace back to a path trigger (e.g.
    // `path.join(__dirname, 'x')` anywhere, not just in an `fs.*` call).
    if ctx.compute_file_references {
        let mut scanner = AssetScanner { eval_ctx: &eval_ctx, assets: Vec::new() };
        scanner.visit_program(&ret.program);
        result.assets.extend(scanner.assets);
    }

    result
}

/// fs method classification (matching `fsSymbols`/`fsExtraSymbols`).
#[derive(Clone, Copy)]
enum FsKind {
    File,
    Dir,
}

fn fs_method_kind(name: &str) -> Option<FsKind> {
    match name {
        "readdir" | "readdirSync" => Some(FsKind::Dir),
        "access" | "accessSync" | "createReadStream" | "exists" | "existsSync" | "fstat"
        | "fstatSync" | "lstat" | "lstatSync" | "open" | "readFile" | "readFileSync" | "stat"
        | "statSync" | "pathExists" | "pathExistsSync" | "readJson" | "readJSON"
        | "readJsonSync" | "readJSONSync" => Some(FsKind::File),
        _ => None,
    }
}

fn strip_node_prefix(s: &str) -> &str {
    s.strip_prefix("node:").unwrap_or(s)
}

fn is_fs_module(name: &str) -> bool {
    matches!(strip_node_prefix(name), "fs" | "fs/promises" | "fs-extra" | "graceful-fs")
}

fn is_path_module(name: &str) -> bool {
    strip_node_prefix(name) == "path"
}

fn is_process_module(name: &str) -> bool {
    strip_node_prefix(name) == "process"
}

fn path_member_binding(name: &str) -> Option<Binding> {
    match name {
        "join" => Some(Binding::PathJoin),
        "resolve" => Some(Binding::PathResolve),
        "dirname" => Some(Binding::PathDirname),
        "sep" => Some(Binding::PathSep),
        _ => None,
    }
}

/// Pass 1 collector: which local identifiers refer to `path`/`fs`/`process`
/// modules or their destructured members.
#[derive(Default)]
struct BindingCollector {
    eval_bindings: HashMap<String, Binding>,
    fs_objects: HashSet<String>,
    fs_fns: HashMap<String, FsKind>,
}

impl BindingCollector {
    /// Bind a whole-module alias, e.g. `const fs = require('fs')`.
    fn bind_object(&mut self, local: &str, module: &str) {
        if is_path_module(module) {
            self.eval_bindings.insert(local.to_string(), Binding::PathModule);
        } else if is_process_module(module) {
            self.eval_bindings.insert(local.to_string(), Binding::ProcessModule);
        } else if is_fs_module(module) {
            self.fs_objects.insert(local.to_string());
        }
    }

    /// Bind a destructured member, e.g. `const { join } = require('path')`.
    fn bind_member(&mut self, local: &str, imported: &str, module: &str) {
        if is_path_module(module) {
            if let Some(b) = path_member_binding(imported) {
                self.eval_bindings.insert(local.to_string(), b);
            }
        } else if is_fs_module(module) {
            if let Some(kind) = fs_method_kind(imported) {
                self.fs_fns.insert(local.to_string(), kind);
            }
        }
    }

    fn bind_require_pattern(&mut self, pattern: &BindingPattern, module: &str) {
        match pattern {
            BindingPattern::BindingIdentifier(id) => self.bind_object(id.name.as_str(), module),
            BindingPattern::ObjectPattern(obj) => {
                for prop in &obj.properties {
                    let BindingPattern::BindingIdentifier(local) = &prop.value else {
                        continue;
                    };
                    if let Some(imported) = prop.key.name() {
                        self.bind_member(local.name.as_str(), &imported, module);
                    }
                }
            }
            _ => {}
        }
    }
}

impl<'a> Visit<'a> for BindingCollector {
    fn visit_variable_declarator(&mut self, decl: &oxc_ast::ast::VariableDeclarator<'a>) {
        if let Some(Expression::CallExpression(call)) = &decl.init {
            if let Expression::Identifier(id) = &call.callee {
                if id.name == "require" {
                    if let Some(Argument::StringLiteral(s)) = call.arguments.first() {
                        self.bind_require_pattern(&decl.id, s.value.as_str());
                    }
                }
            }
        }
        walk::walk_variable_declarator(self, decl);
    }

    fn visit_import_declaration(&mut self, decl: &oxc_ast::ast::ImportDeclaration<'a>) {
        let module = decl.source.value.as_str();
        let Some(specifiers) = &decl.specifiers else { return };
        for spec in specifiers {
            use oxc_ast::ast::ImportDeclarationSpecifier as S;
            match spec {
                S::ImportDefaultSpecifier(d) => self.bind_object(d.local.name.as_str(), module),
                S::ImportNamespaceSpecifier(d) => self.bind_object(d.local.name.as_str(), module),
                S::ImportSpecifier(d) => {
                    self.bind_member(d.local.name.as_str(), d.imported.name().as_str(), module);
                }
            }
        }
    }
}

/// Pass 2 collector: deps, imports, assets.
struct DepCollector<'a, 'b> {
    compute_file_references: bool,
    eval_ctx: &'b EvalCtx<'b>,
    fs_objects: &'b HashSet<String>,
    fs_fns: &'b HashMap<String, FsKind>,
    deps: Vec<String>,
    imports: Vec<String>,
    assets: Vec<Asset>,
    is_esm: bool,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a> DepCollector<'a, '_> {
    /// Push the first argument of a `require(...)` / `require.resolve(...)`
    /// call as a dependency, statically evaluating it (string literal,
    /// `__dirname + '/x'`, template, `path.join(...)`, …).
    fn push_dep_arg(&mut self, call: &oxc_ast::ast::CallExpression<'a>) {
        if let Some(arg0) = call.arguments.first().and_then(Argument::as_expression) {
            if let Some(Value::Str(s)) = eval(arg0, self.eval_ctx) {
                self.deps.push(s);
            }
        }
    }

    /// Handle a recognized `fs.*`/destructured-fs call: emit the computed
    /// first argument as a file or directory asset.
    fn handle_fs_call(&mut self, kind: FsKind, call: &oxc_ast::ast::CallExpression<'a>) {
        if !self.compute_file_references {
            return;
        }
        let Some(arg0) = call.arguments.first().and_then(Argument::as_expression) else {
            return;
        };
        match kind {
            FsKind::Dir => {
                if let Expression::Identifier(id) = arg0 {
                    if id.name == "__dirname" {
                        self.assets.push(Asset::Dir(self.eval_ctx.dirname.clone()));
                        return;
                    }
                }
                if let Some(Value::Str(s)) = eval(arg0, self.eval_ctx) {
                    if is_absolute_path(&s) {
                        self.assets.push(Asset::Dir(s));
                    }
                }
            }
            FsKind::File => {
                if let Some(Value::Str(s)) = eval(arg0, self.eval_ctx) {
                    if is_absolute_path(&s) {
                        self.assets.push(Asset::File(s));
                    }
                }
            }
        }
    }
}

impl<'a> Visit<'a> for DepCollector<'a, '_> {
    fn visit_call_expression(&mut self, call: &oxc_ast::ast::CallExpression<'a>) {
        match unwrap_expr(&call.callee) {
            // require(<statically-evaluable>)
            Expression::Identifier(id) if id.name == "require" => {
                self.push_dep_arg(call);
            }
            // destructured fs fn, e.g. readFileSync(...)
            Expression::Identifier(id) => {
                if let Some(kind) = self.fs_fns.get(id.name.as_str()).copied() {
                    self.handle_fs_call(kind, call);
                }
            }
            Expression::StaticMemberExpression(member) => {
                if let Expression::Identifier(obj) = &member.object {
                    let prop = member.property.name.as_str();
                    // require.resolve(<statically-evaluable>)
                    if obj.name == "require" && prop == "resolve" {
                        self.push_dep_arg(call);
                    } else if self.fs_objects.contains(obj.name.as_str()) {
                        if let Some(kind) = fs_method_kind(prop) {
                            self.handle_fs_call(kind, call);
                        }
                    }
                }
            }
            _ => {}
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_import_expression(&mut self, expr: &oxc_ast::ast::ImportExpression<'a>) {
        if let Some(Value::Str(s)) = eval(&expr.source, self.eval_ctx) {
            self.deps.push(s);
        }
        walk::walk_import_expression(self, expr);
    }

    fn visit_import_declaration(&mut self, decl: &oxc_ast::ast::ImportDeclaration<'a>) {
        self.is_esm = true;
        self.imports.push(decl.source.value.to_string());
        walk::walk_import_declaration(self, decl);
    }

    fn visit_export_named_declaration(&mut self, decl: &oxc_ast::ast::ExportNamedDeclaration<'a>) {
        self.is_esm = true;
        if let Some(src) = &decl.source {
            self.imports.push(src.value.to_string());
        }
        walk::walk_export_named_declaration(self, decl);
    }

    fn visit_export_all_declaration(&mut self, decl: &oxc_ast::ast::ExportAllDeclaration<'a>) {
        self.is_esm = true;
        self.imports.push(decl.source.value.to_string());
        walk::walk_export_all_declaration(self, decl);
    }

    fn visit_export_default_declaration(
        &mut self,
        decl: &oxc_ast::ast::ExportDefaultDeclaration<'a>,
    ) {
        self.is_esm = true;
        walk::walk_export_default_declaration(self, decl);
    }
}

/// Pass 3: emits the maximal static absolute-path expression at each position
/// (skipping its children once emitted), provided it traces back to a path
/// trigger. Mirrors nft's leaf-trigger + backtrack asset emission.
struct AssetScanner<'b> {
    eval_ctx: &'b EvalCtx<'b>,
    assets: Vec<Asset>,
}

impl<'a> Visit<'a> for AssetScanner<'_> {
    fn visit_expression(&mut self, expr: &Expression<'a>) {
        if let Some(Value::Str(s)) = eval(expr, self.eval_ctx) {
            if is_absolute_path(&s) && contains_trigger(expr, self.eval_ctx) {
                self.assets.push(Asset::File(s));
                return; // maximal expression — don't descend into children
            }
        }
        walk::walk_expression(self, expr);
    }
}
