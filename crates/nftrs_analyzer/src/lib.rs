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
use oxc_ast::ast::{Argument, BindingPattern, Expression, FormalParameters, FunctionBody, Statement};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;

use static_eval::{
    contains_trigger, eval_flow, is_absolute_path, normalize_posix, path_resolve, unwrap_expr,
    Binding, EvalCtx, Flow, Value,
};

/// A referenced asset, as an absolute path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Asset {
    /// A single file (e.g. `fs.readFileSync(__dirname + '/x')`). The path may
    /// embed [`static_eval::WILDCARD`] markers, in which case the consumer
    /// globs it (`emitAssetDirectory`).
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
    /// Absolute wildcard require patterns (containing [`static_eval::WILDCARD`]);
    /// the consumer globs each and follows the matches as dependencies.
    pub require_globs: Vec<String>,
    /// Absolute dependency paths from special-case handlers (`emitDependency`);
    /// the consumer follows each as a dependency.
    pub extra_deps: Vec<String>,
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

    // Pass 1: collect module bindings (path/fs/process aliases, createRequire).
    let mut bindings = BindingCollector::new(&ctx.dirname);
    bindings.visit_program(&ret.program);

    // Pass 1b: collect statically-known local variables (`const x = './a'`),
    // so later expressions can resolve identifiers to their values.
    let vars = collect_vars(&ret.program, ctx, &bindings.eval_bindings);

    // Pass 2: collect deps/imports/assets.
    let eval_ctx = EvalCtx {
        dirname: ctx.dirname.clone(),
        filename: ctx.filename.clone(),
        cwd: ctx.cwd.clone(),
        bindings: &bindings.eval_bindings,
        vars: &vars,
    };
    let mut collector = DepCollector {
        compute_file_references: ctx.compute_file_references,
        eval_ctx: &eval_ctx,
        fs_objects: &bindings.fs_objects,
        fs_fns: &bindings.fs_fns,
        require_fns: &bindings.require_fns,
        module_ns: &bindings.module_ns,
        pino_names: &bindings.pino_names,
        fastify_names: &bindings.fastify_names,
        default_interop_fs: &bindings.default_interop_fs,
        deps: Vec::new(),
        imports: Vec::new(),
        assets: Vec::new(),
        require_globs: Vec::new(),
        is_esm: false,
        _marker: std::marker::PhantomData,
    };
    collector.visit_program(&ret.program);

    result.deps = collector.deps;
    result.imports = collector.imports;
    result.assets = collector.assets;
    result.require_globs = collector.require_globs;
    result.is_esm = collector.is_esm;

    // Pass 3: general asset scan — emit maximal static absolute-path
    // expressions that trace back to a path trigger (e.g.
    // `path.join(__dirname, 'x')` anywhere, not just in an `fs.*` call).
    if ctx.compute_file_references {
        let mut scanner = AssetScanner { eval_ctx: &eval_ctx, assets: Vec::new() };
        scanner.visit_program(&ret.program);
        result.assets.extend(scanner.assets);
    }

    // Pass 4: per-package special cases keyed on the module's file id.
    if ctx.compute_file_references {
        let sc = special_cases::special_case(&ctx.filename, &ctx.dirname);
        result.assets.extend(sc.assets);
        result.extra_deps.extend(sc.deps);
    }

    result
}

/// Pass 1b: gather statically-known local variables in source order, so an
/// identifier later resolves to its constant (or conditional) value. This is a
/// simplification of nft's scope-aware `knownBindings` (good enough for the
/// flat top-level declarations the fixtures use). `require`/`__dirname` etc.
/// are intrinsics and never overridden here.
fn collect_vars(
    program: &oxc_ast::ast::Program,
    ctx: &AnalyzeContext,
    bindings: &HashMap<String, Binding>,
) -> HashMap<String, Flow> {
    let mut vc = VarCollector {
        dirname: &ctx.dirname,
        filename: &ctx.filename,
        cwd: &ctx.cwd,
        bindings,
        vars: HashMap::new(),
    };
    vc.visit_program(program);
    vc.vars
}

/// Evaluates `name = <init>` declarators in source order, growing `vars` so a
/// later initializer can reference an earlier constant.
struct VarCollector<'b> {
    dirname: &'b str,
    filename: &'b str,
    cwd: &'b str,
    bindings: &'b HashMap<String, Binding>,
    vars: HashMap<String, Flow>,
}

impl<'a> Visit<'a> for VarCollector<'_> {
    fn visit_variable_declarator(&mut self, decl: &oxc_ast::ast::VariableDeclarator<'a>) {
        if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&decl.id, &decl.init) {
            let name = id.name.as_str();
            if !matches!(name, "__dirname" | "__filename" | "require") {
                let ctx = EvalCtx {
                    dirname: self.dirname.to_string(),
                    filename: self.filename.to_string(),
                    cwd: self.cwd.to_string(),
                    bindings: self.bindings,
                    vars: &self.vars,
                };
                let flow = eval_flow(init, &ctx);
                drop(ctx);
                if let Some(f) = flow {
                    self.vars.insert(name.to_string(), f);
                }
            }
        }
        walk::walk_variable_declarator(self, decl);
    }
}

/// The base a require-like function resolves relative to.
#[derive(Clone)]
enum ReqBase {
    /// Resolve relative to the current module file (the default `require`).
    CurrentFile,
    /// Resolve relative to an absolute directory (`createRequire(new URL(...))`).
    Dir(String),
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
/// modules or their destructured members, plus `createRequire` results.
struct BindingCollector {
    dirname: String,
    eval_bindings: HashMap<String, Binding>,
    fs_objects: HashSet<String>,
    fs_fns: HashMap<String, FsKind>,
    /// Local names that ARE `createRequire` (from `module`).
    create_require_names: HashSet<String>,
    /// Local names bound to the `module` namespace (`import * as m from 'module'`).
    module_ns: HashSet<String>,
    /// require-like functions (the global `require` plus `createRequire` results).
    require_fns: HashMap<String, ReqBase>,
    /// Local names bound to `pino` (require/import).
    pino_names: HashSet<String>,
    /// Local names bound to `fastify`.
    fastify_names: HashSet<String>,
    /// Names whose `.default` is an fs module (babel/tsc default interop, e.g.
    /// `var _fs = _interopRequireDefault(require("fs"))`).
    default_interop_fs: HashSet<String>,
}

impl BindingCollector {
    fn new(dirname: &str) -> Self {
        let mut require_fns = HashMap::new();
        require_fns.insert("require".to_string(), ReqBase::CurrentFile);
        Self {
            dirname: dirname.to_string(),
            eval_bindings: HashMap::new(),
            fs_objects: HashSet::new(),
            fs_fns: HashMap::new(),
            create_require_names: HashSet::new(),
            module_ns: HashSet::new(),
            require_fns,
            pino_names: HashSet::new(),
            fastify_names: HashSet::new(),
            default_interop_fs: HashSet::new(),
        }
    }

    /// If `init` is `<interopFn>(require("M"))`, return `(is_default, "M")`.
    /// `is_default` distinguishes `_interopRequireDefault`/`__importDefault`
    /// (the module is at `.default`) from the wildcard interops (the var is the
    /// module).
    fn interop_module(init: &Expression) -> Option<(bool, String)> {
        let Expression::CallExpression(call) = unwrap_expr(init) else { return None };
        let Expression::Identifier(callee) = unwrap_expr(&call.callee) else { return None };
        let is_default = match callee.name.as_str() {
            "_interopRequireDefault" | "__importDefault" => true,
            "_interopRequireWildcard" | "__importStar" => false,
            _ => return None,
        };
        let arg = call.arguments.first().and_then(Argument::as_expression)?;
        let Expression::CallExpression(req) = unwrap_expr(arg) else { return None };
        let Expression::Identifier(rc) = &req.callee else { return None };
        if rc.name != "require" {
            return None;
        }
        match req.arguments.first() {
            Some(Argument::StringLiteral(s)) => Some((is_default, s.value.to_string())),
            _ => None,
        }
    }

    /// If `init` is a `createRequire(...)` / `module.createRequire(...)` call,
    /// return the base its resulting require resolves against.
    fn create_require_base(&self, init: &Expression) -> Option<ReqBase> {
        let Expression::CallExpression(call) = init else { return None };
        let is_create_require = match unwrap_expr(&call.callee) {
            Expression::Identifier(id) => self.create_require_names.contains(id.name.as_str()),
            Expression::StaticMemberExpression(m) => {
                m.property.name == "createRequire"
                    && matches!(&m.object, Expression::Identifier(o) if self.module_ns.contains(o.name.as_str()))
            }
            _ => false,
        };
        if !is_create_require {
            return None;
        }
        // Base from the argument: `import.meta.url` -> current file dir;
        // `new URL(rel, import.meta.url)` -> that directory.
        match call.arguments.first().and_then(Argument::as_expression) {
            Some(Expression::NewExpression(new_expr)) => {
                if let Some(Argument::StringLiteral(rel)) = new_expr.arguments.first() {
                    let dir =
                        static_eval::normalize_posix(&format!("{}/{}", self.dirname, rel.value));
                    return Some(ReqBase::Dir(dir));
                }
                Some(ReqBase::CurrentFile)
            }
            _ => Some(ReqBase::CurrentFile),
        }
    }
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
        } else if strip_node_prefix(module) == "module" {
            self.module_ns.insert(local.to_string());
        } else if module == "pino" {
            self.pino_names.insert(local.to_string());
        } else if module == "fastify" {
            self.fastify_names.insert(local.to_string());
        } else if module == "resolve-from" {
            self.eval_bindings.insert(local.to_string(), Binding::ResolveFrom);
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
        } else if strip_node_prefix(module) == "url" && imported == "fileURLToPath" {
            self.eval_bindings.insert(local.to_string(), Binding::FileUrlToPath);
        } else if strip_node_prefix(module) == "module" && imported == "createRequire" {
            self.create_require_names.insert(local.to_string());
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

/// Find the value of a (non-computed) string/identifier-keyed property in an
/// object literal.
fn find_object_prop<'a, 'b>(
    obj: &'b oxc_ast::ast::ObjectExpression<'a>,
    key: &str,
) -> Option<&'b Expression<'a>> {
    use oxc_ast::ast::{ObjectPropertyKind, PropertyKey};
    for p in &obj.properties {
        let ObjectPropertyKind::ObjectProperty(op) = p else { continue };
        let name = match &op.key {
            PropertyKey::StaticIdentifier(i) => Some(i.name.as_str()),
            PropertyKey::StringLiteral(s) => Some(s.value.as_str()),
            _ => None,
        };
        if name == Some(key) {
            return Some(&op.value);
        }
    }
    None
}

/// Detect a require-wrapper function body: `var y = require(<firstParam>); …;
/// return y;` (ports nft's "Support require wrappers" branch). Such a function,
/// when called with a literal, forwards it to `require`.
fn is_require_wrapper(params: &FormalParameters, body: &FunctionBody) -> bool {
    let Some(first) = params.items.first() else { return false };
    let BindingPattern::BindingIdentifier(param) = &first.pattern else { return false };
    let param_name = param.name.as_str();

    let mut require_decl: Option<&str> = None;
    for stmt in &body.statements {
        if require_decl.is_none() {
            if let Statement::VariableDeclaration(var) = stmt {
                for d in &var.declarations {
                    let (
                        BindingPattern::BindingIdentifier(id),
                        Some(Expression::CallExpression(call)),
                    ) = (&d.id, &d.init)
                    else {
                        continue;
                    };
                    if let Expression::Identifier(callee) = &call.callee {
                        if callee.name == "require" {
                            if let Some(Argument::Identifier(arg)) = call.arguments.first() {
                                if arg.name == param_name {
                                    require_decl = Some(id.name.as_str());
                                }
                            }
                        }
                    }
                }
            }
        }
        if let (Some(name), Statement::ReturnStatement(ret)) = (require_decl, stmt) {
            if let Some(Expression::Identifier(arg)) = &ret.argument {
                if arg.name == name {
                    return true;
                }
            }
        }
    }
    false
}

impl<'a> Visit<'a> for BindingCollector {
    fn visit_function(
        &mut self,
        func: &oxc_ast::ast::Function<'a>,
        flags: oxc_syntax::scope::ScopeFlags,
    ) {
        if let (Some(id), Some(body)) = (&func.id, &func.body) {
            if is_require_wrapper(&func.params, body) {
                self.require_fns.insert(id.name.to_string(), ReqBase::CurrentFile);
            }
        }
        walk::walk_function(self, func, flags);
    }

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
        // `const { readdir } = fs.promises` — bind destructured members of a
        // known fs object's `.promises` (or `.default`) as fs functions.
        if let (BindingPattern::ObjectPattern(obj), Some(Expression::StaticMemberExpression(m))) =
            (&decl.id, &decl.init)
        {
            if matches!(m.property.name.as_str(), "promises" | "default") {
                if let Expression::Identifier(o) = &m.object {
                    if self.fs_objects.contains(o.name.as_str()) {
                        for prop in &obj.properties {
                            if let (BindingPattern::BindingIdentifier(local), Some(imported)) =
                                (&prop.value, prop.key.name())
                            {
                                if let Some(k) = fs_method_kind(&imported) {
                                    self.fs_fns.insert(local.name.to_string(), k);
                                }
                            }
                        }
                    }
                }
            }
        }
        // `const join = path.join` — alias a path-module member to its binding.
        if let (BindingPattern::BindingIdentifier(id), Some(Expression::StaticMemberExpression(m))) =
            (&decl.id, &decl.init)
        {
            if let Expression::Identifier(o) = &m.object {
                if matches!(self.eval_bindings.get(o.name.as_str()), Some(Binding::PathModule)) {
                    if let Some(b) = path_member_binding(m.property.name.as_str()) {
                        self.eval_bindings.insert(id.name.to_string(), b);
                    }
                }
            }
        }
        // Babel/tsc interop: `var path = _interopRequireWildcard(require("path"))`
        // (the var is the module) / `var _fs = _interopRequireDefault(require("fs"))`
        // (the module is at `.default`).
        if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&decl.id, &decl.init) {
            if let Some((is_default, module)) = Self::interop_module(init) {
                if is_default {
                    if is_fs_module(&module) {
                        self.default_interop_fs.insert(id.name.to_string());
                    }
                } else {
                    self.bind_object(id.name.as_str(), &module);
                }
            }
        }
        // `const reaction = name => { const r = require(name); …; return r }` —
        // an arrow/function-expression require wrapper assigned to a var.
        if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&decl.id, &decl.init) {
            let wrapper = match init {
                Expression::ArrowFunctionExpression(a) => {
                    is_require_wrapper(&a.params, &a.body)
                }
                Expression::FunctionExpression(f) => {
                    f.body.as_ref().is_some_and(|b| is_require_wrapper(&f.params, b))
                }
                _ => false,
            };
            if wrapper {
                self.require_fns.insert(id.name.to_string(), ReqBase::CurrentFile);
            }
        }
        // `const req = createRequire(...)` — req becomes a require-like fn.
        if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&decl.id, &decl.init) {
            if let Some(base) = self.create_require_base(init) {
                self.require_fns.insert(id.name.to_string(), base);
            } else if id.name == "require" {
                // `require` rebound to something that is NOT createRequire — it
                // shadows the global require and must be ignored (#ignore-other).
                self.require_fns.remove("require");
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
    require_fns: &'b HashMap<String, ReqBase>,
    module_ns: &'b HashSet<String>,
    pino_names: &'b HashSet<String>,
    fastify_names: &'b HashSet<String>,
    default_interop_fs: &'b HashSet<String>,
    deps: Vec<String>,
    imports: Vec<String>,
    assets: Vec<Asset>,
    require_globs: Vec<String>,
    is_esm: bool,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a> DepCollector<'a, '_> {
    /// Process the first argument of a require-like call. `base` rebases
    /// relative specifiers for `createRequire`.
    fn push_dep_arg(&mut self, call: &oxc_ast::ast::CallExpression<'a>, base: &ReqBase) {
        if let Some(arg0) = call.arguments.first().and_then(Argument::as_expression) {
            self.process_require_arg(arg0, false, base);
        }
    }

    /// `processPinoTransportObject`: extract `target` strings from a pino
    /// transport config (`{ target }`, `{ targets: [...] }`, `{ pipeline: [...] }`).
    fn process_pino_transport_object(&mut self, obj: &oxc_ast::ast::ObjectExpression<'a>) {
        if let Some(Expression::StringLiteral(s)) = find_object_prop(obj, "target") {
            self.deps.push(s.value.to_string());
        }
        for key in ["targets", "pipeline"] {
            if let Some(Expression::ArrayExpression(arr)) = find_object_prop(obj, key) {
                for el in &arr.elements {
                    if let oxc_ast::ast::ArrayExpressionElement::ObjectExpression(inner) = el {
                        if let Some(Expression::StringLiteral(s)) = find_object_prop(inner, "target")
                        {
                            self.deps.push(s.value.to_string());
                        }
                    }
                }
            }
        }
    }

    /// `pino({ transport: {...} })` — process the nested transport config.
    fn handle_pino_config(&mut self, call: &oxc_ast::ast::CallExpression<'a>, key: &str) {
        if let Some(Expression::ObjectExpression(cfg)) =
            call.arguments.first().and_then(Argument::as_expression)
        {
            if let Some(Expression::ObjectExpression(t)) = find_object_prop(cfg, key) {
                self.process_pino_transport_object(t);
            }
        }
    }

    /// `fastify({ logger: { transport: {...} } })`.
    fn handle_fastify_config(&mut self, call: &oxc_ast::ast::CallExpression<'a>) {
        if let Some(Expression::ObjectExpression(cfg)) =
            call.arguments.first().and_then(Argument::as_expression)
        {
            if let Some(Expression::ObjectExpression(logger)) = find_object_prop(cfg, "logger") {
                if let Some(Expression::ObjectExpression(t)) = find_object_prop(logger, "transport")
                {
                    self.process_pino_transport_object(t);
                }
            }
        }
    }

    /// Mirror nft's `processRequireArg`: recurse through `?:`/`||`/`&&` so each
    /// branch is emitted, add plain specifiers, expand conditional values to
    /// both branches, and route wildcard specifiers to glob requires.
    fn process_require_arg(&mut self, expr: &Expression<'a>, is_import: bool, base: &ReqBase) {
        match unwrap_expr(expr) {
            Expression::ConditionalExpression(c) => {
                self.process_require_arg(&c.consequent, is_import, base);
                self.process_require_arg(&c.alternate, is_import, base);
                return;
            }
            Expression::LogicalExpression(l) => {
                self.process_require_arg(&l.left, is_import, base);
                self.process_require_arg(&l.right, is_import, base);
                return;
            }
            _ => {}
        }
        match eval_flow(expr, self.eval_ctx) {
            Some(Flow::Value { value: Value::Str(s), wildcards }) => {
                if wildcards == 0 {
                    self.add_specifier(s, is_import, base);
                } else {
                    self.emit_wildcard_require(&s);
                }
            }
            Some(Flow::Cond { if_true, els }) => {
                if let Value::Str(s) = if_true {
                    self.add_specifier(s, is_import, base);
                }
                if let Value::Str(s) = els {
                    self.add_specifier(s, is_import, base);
                }
            }
            _ => {}
        }
    }

    fn add_specifier(&mut self, s: String, is_import: bool, base: &ReqBase) {
        let target = if is_import {
            &mut self.imports
        } else {
            &mut self.deps
        };
        match base {
            ReqBase::CurrentFile => target.push(s),
            ReqBase::Dir(dir) if s.starts_with('.') => {
                target.push(normalize_posix(&format!("{dir}/{s}")));
            }
            ReqBase::Dir(_) => target.push(s),
        }
    }

    /// `emitWildcardRequire`: resolve a `./`-relative wildcard specifier
    /// against the module dir and record the absolute pattern for globbing.
    fn emit_wildcard_require(&mut self, spec: &str) {
        if !spec.starts_with("./") && !spec.starts_with("../") {
            return;
        }
        let abs = path_resolve(&self.eval_ctx.dirname, &[spec.to_string()]);
        self.require_globs.push(abs);
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
                for s in eval_asset_strs(arg0, self.eval_ctx) {
                    if let Some(p) = asset_path_str(&s) {
                        self.assets.push(Asset::Dir(p));
                    }
                }
            }
            FsKind::File => {
                for s in eval_asset_strs(arg0, self.eval_ctx) {
                    if let Some(p) = asset_path_str(&s) {
                        self.assets.push(Asset::File(p));
                    }
                }
            }
        }
    }
}

impl<'a> Visit<'a> for DepCollector<'a, '_> {
    fn visit_call_expression(&mut self, call: &oxc_ast::ast::CallExpression<'a>) {
        match unwrap_expr(&call.callee) {
            // require(...) / createRequire-result(...) — require-like calls
            Expression::Identifier(id) if self.require_fns.contains_key(id.name.as_str()) => {
                let base = self.require_fns[id.name.as_str()].clone();
                self.push_dep_arg(call, &base);
            }
            // destructured fs fn, e.g. readFileSync(...)
            Expression::Identifier(id) => {
                if let Some(kind) = self.fs_fns.get(id.name.as_str()).copied() {
                    self.handle_fs_call(kind, call);
                } else if self.pino_names.contains(id.name.as_str()) {
                    // pino({ transport: { target: '...' } })
                    self.handle_pino_config(call, "transport");
                } else if self.fastify_names.contains(id.name.as_str()) {
                    // fastify({ logger: { transport: { target: '...' } } })
                    self.handle_fastify_config(call);
                }
            }
            Expression::StaticMemberExpression(member) => {
                let prop = member.property.name.as_str();
                if let Expression::Identifier(obj) = &member.object {
                    if self.pino_names.contains(obj.name.as_str()) && prop == "transport" {
                        // pino.transport({ target | targets | pipeline })
                        if let Some(Expression::ObjectExpression(o)) =
                            call.arguments.first().and_then(Argument::as_expression)
                        {
                            self.process_pino_transport_object(o);
                        }
                    } else if let Some(base) = self.require_fns.get(obj.name.as_str()) {
                        // <require-like>.resolve(...)
                        if prop == "resolve" {
                            let base = base.clone();
                            self.push_dep_arg(call, &base);
                        }
                    } else if obj.name == "module" && prop == "require" {
                        // module.require(...)
                        self.push_dep_arg(call, &ReqBase::CurrentFile);
                    } else if self.module_ns.contains(obj.name.as_str()) && prop == "register" {
                        // module.register('./hook', ...) — ESM loader hook dep
                        self.push_dep_arg(call, &ReqBase::CurrentFile);
                    } else if self.fs_objects.contains(obj.name.as_str()) {
                        if let Some(kind) = fs_method_kind(prop) {
                            self.handle_fs_call(kind, call);
                        }
                    }
                } else if let Expression::StaticMemberExpression(inner) = &member.object {
                    // `fs.promises.readdir(...)` / `fs.default.readFileSync(...)`,
                    // or default-interop `fs_1.default.readFileSync(...)`.
                    if let Expression::Identifier(o) = &inner.object {
                        let is_fs = (matches!(inner.property.name.as_str(), "promises" | "default")
                            && self.fs_objects.contains(o.name.as_str()))
                            || (inner.property.name == "default"
                                && self.default_interop_fs.contains(o.name.as_str()));
                        if is_fs {
                            if let Some(kind) = fs_method_kind(prop) {
                                self.handle_fs_call(kind, call);
                            }
                        }
                    }
                } else if let Expression::ComputedMemberExpression(inner) = &member.object {
                    // default-interop with bracket access: `_fs["default"].readFileSync(...)`
                    if let (Expression::Identifier(o), Expression::StringLiteral(k)) =
                        (&inner.object, &inner.expression)
                    {
                        if k.value == "default" && self.default_interop_fs.contains(o.name.as_str())
                        {
                            if let Some(kind) = fs_method_kind(prop) {
                                self.handle_fs_call(kind, call);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_import_expression(&mut self, expr: &oxc_ast::ast::ImportExpression<'a>) {
        // Dynamic `import()` resolves with the ESM (`import`) condition.
        self.process_require_arg(&expr.source, true, &ReqBase::CurrentFile);
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
        // A conditional (`a ? x : y`) emits both branches as assets.
        if let Some(flow) = eval_flow(expr, self.eval_ctx) {
            let paths: Vec<String> =
                flow_asset_strs(&flow).iter().filter_map(|s| asset_path_str(s)).collect();
            if !paths.is_empty()
                && paths.len() == flow_asset_strs(&flow).len()
                && contains_trigger(expr, self.eval_ctx)
            {
                for p in paths {
                    self.assets.push(Asset::File(p));
                }
                return; // maximal expression — don't descend into children
            }
        }
        walk::walk_expression(self, expr);
    }
}

/// Convert an evaluated asset string into an emittable absolute path: strip a
/// `file://` scheme and normalize. Returns `None` if not absolute.
fn asset_path_str(s: &str) -> Option<String> {
    let p = static_eval::file_url_to_path(s);
    if is_absolute_path(&p) {
        Some(normalize_posix(&p))
    } else {
        None
    }
}

/// Extract the asset path string(s) from a [`Flow`], expanding a conditional
/// into both of its branches. Only string values are returned.
fn flow_asset_strs(flow: &Flow) -> Vec<String> {
    match flow {
        Flow::Value { value: Value::Str(s), .. } => vec![s.clone()],
        Flow::Cond { if_true, els } => [if_true, els]
            .into_iter()
            .filter_map(|v| match v {
                Value::Str(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        Flow::Value { .. } => Vec::new(),
    }
}

/// Evaluate `expr` to its asset path string(s) (conditionals expand to both
/// branches), for an `fs.*` argument.
fn eval_asset_strs(expr: &Expression, ctx: &EvalCtx) -> Vec<String> {
    eval_flow(expr, ctx).map(|f| flow_asset_strs(&f)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analyze_src(src: &str) -> AnalyzeResult {
        let ctx = AnalyzeContext {
            dirname: "/proj/src".to_string(),
            filename: "/proj/src/index.js".to_string(),
            cwd: "/proj".to_string(),
            compute_file_references: true,
        };
        analyze(Path::new("/proj/src/index.js"), src, &ctx)
    }

    fn files(r: &AnalyzeResult) -> Vec<String> {
        r.assets
            .iter()
            .filter_map(|a| match a {
                Asset::File(s) => Some(s.clone()),
                Asset::Dir(_) => None,
            })
            .collect()
    }

    fn dirs(r: &AnalyzeResult) -> Vec<String> {
        r.assets
            .iter()
            .filter_map(|a| match a {
                Asset::Dir(s) => Some(s.clone()),
                Asset::File(_) => None,
            })
            .collect()
    }

    #[test]
    fn require_and_require_resolve() {
        let r = analyze_src("const a = require('./a'); require.resolve('./b');");
        assert!(r.deps.contains(&"./a".to_string()));
        assert!(r.deps.contains(&"./b".to_string()));
        assert!(!r.is_esm);
    }

    #[test]
    fn static_import_export_is_esm() {
        let r = analyze_src("import x from './a'; export { y } from './b'; export * from './c';");
        assert!(r.is_esm);
        assert!(r.imports.contains(&"./a".to_string()));
        assert!(r.imports.contains(&"./b".to_string()));
        assert!(r.imports.contains(&"./c".to_string()));
    }

    #[test]
    fn dynamic_import() {
        let r = analyze_src("import('./lazy.js');");
        assert!(r.imports.contains(&"./lazy.js".to_string()));
    }

    #[test]
    fn require_wrapper_function() {
        let r = analyze_src("function load(name) { const m = require(name); return m; } load('./dep');");
        assert!(r.deps.contains(&"./dep".to_string()));
    }

    #[test]
    fn require_wrapper_arrow() {
        let r = analyze_src("const load = (name) => { const m = require(name); return m; }; load('./dep');");
        assert!(r.deps.contains(&"./dep".to_string()));
    }

    #[test]
    fn conditional_require_emits_both_branches() {
        let r = analyze_src("var p = cond ? './a' : './b'; require(p + '/x');");
        assert!(r.deps.contains(&"./a/x".to_string()));
        assert!(r.deps.contains(&"./b/x".to_string()));
    }

    #[test]
    fn logical_fallback_require() {
        let r = analyze_src("require(dynamic || './fallback.js');");
        assert!(r.deps.contains(&"./fallback.js".to_string()));
    }

    #[test]
    fn wildcard_require_glob() {
        let r = analyze_src("const n = unknown; require(`./mods/mod${n}`);");
        assert_eq!(r.require_globs.len(), 1);
        assert!(r.require_globs[0].contains('\u{1a}'));
        assert!(r.require_globs[0].starts_with("/proj/src/mods/mod"));
    }

    #[test]
    fn fs_read_file_asset() {
        let r = analyze_src("const fs = require('fs'); fs.readFileSync(__dirname + '/asset.txt');");
        assert!(files(&r).contains(&"/proj/src/asset.txt".to_string()));
    }

    #[test]
    fn fs_readdir_dir_asset() {
        let r = analyze_src("const fs = require('fs'); fs.readdirSync(__dirname);");
        assert!(dirs(&r).contains(&"/proj/src".to_string()));
    }

    #[test]
    fn fs_promises_destructured_readdir() {
        let r = analyze_src(
            "const fs = require('fs'); const { readdir } = fs.promises; const { resolve } = require('path'); const d = resolve(__dirname, 'posts'); readdir(d);",
        );
        assert!(dirs(&r).contains(&"/proj/src/posts".to_string()));
    }

    #[test]
    fn path_join_wildcard_asset() {
        let r = analyze_src(
            "const path = require('path'); const fs = require('fs'); fs.readFileSync(path.join(__dirname, 'a', x) + '.txt');",
        );
        assert!(files(&r).iter().any(|f| f == "/proj/src/a/\u{1a}.txt"));
    }

    #[test]
    fn dirname_concat_dotdot_normalized() {
        let r = analyze_src("const fs = require('fs'); fs.readFileSync(__dirname + '/../pkg.json');");
        assert!(files(&r).contains(&"/proj/pkg.json".to_string()));
    }

    #[test]
    fn import_meta_url_asset() {
        let r = analyze_src("import fs from 'fs'; fs.readFileSync(new URL('./asset.txt', import.meta.url));");
        assert!(files(&r).contains(&"/proj/src/asset.txt".to_string()));
    }

    #[test]
    fn file_url_to_path_asset() {
        let r = analyze_src(
            "import { readFileSync } from 'fs'; import { fileURLToPath } from 'url'; readFileSync(fileURLToPath(`${import.meta.url}/../a.txt`));",
        );
        assert!(files(&r).contains(&"/proj/src/a.txt".to_string()));
    }

    #[test]
    fn conditional_fs_asset_both_branches() {
        let r = analyze_src("const fs = require('fs'); fs.readFileSync(`${__dirname}/asset${u ? '1' : '2'}.txt`);");
        let fs = files(&r);
        assert!(fs.contains(&"/proj/src/asset1.txt".to_string()));
        assert!(fs.contains(&"/proj/src/asset2.txt".to_string()));
    }

    #[test]
    fn pino_transport_target() {
        let r = analyze_src("const p = require('pino'); p.transport({ target: 'my-transport' });");
        assert!(r.deps.contains(&"my-transport".to_string()));
    }

    #[test]
    fn pino_transport_targets_array() {
        let r = analyze_src("const pino = require('pino'); pino.transport({ targets: [{ target: 'a' }, { target: 'b' }] });");
        assert!(r.deps.contains(&"a".to_string()));
        assert!(r.deps.contains(&"b".to_string()));
    }

    #[test]
    fn pino_constructor_and_fastify() {
        let r1 = analyze_src("import pino from 'pino'; pino({ transport: { target: 't1' } });");
        assert!(r1.deps.contains(&"t1".to_string()));
        let r2 = analyze_src("import fastify from 'fastify'; fastify({ logger: { transport: { target: 't2' } } });");
        assert!(r2.deps.contains(&"t2".to_string()));
    }

    #[test]
    fn babel_interop_default_fs() {
        let r = analyze_src(
            "var _fs = _interopRequireDefault(require('fs')); var path = _interopRequireWildcard(require('path')); _fs[\"default\"].readFileSync(path.join(__dirname, 'a.txt'));",
        );
        assert!(files(&r).contains(&"/proj/src/a.txt".to_string()));
    }

    #[test]
    fn tsc_interop_default_fs() {
        let r = analyze_src(
            "const fs_1 = __importDefault(require('fs')); const path = __importStar(require('path')); fs_1.default.readFileSync(path.join(__dirname, 'a.txt'));",
        );
        assert!(files(&r).contains(&"/proj/src/a.txt".to_string()));
    }

    #[test]
    fn special_case_shiki_dirs() {
        let ctx = AnalyzeContext {
            dirname: "/proj/node_modules/shiki/dist".to_string(),
            filename: "/proj/node_modules/shiki/dist/index.js".to_string(),
            cwd: "/proj".to_string(),
            compute_file_references: true,
        };
        let r = analyze(Path::new(&ctx.filename), "module.exports = {};", &ctx);
        let d = dirs(&r);
        assert!(d.contains(&"/proj/node_modules/shiki/languages".to_string()));
        assert!(d.contains(&"/proj/node_modules/shiki/themes".to_string()));
    }

    #[test]
    fn parse_error_flag_set() {
        let r = analyze_src("const = = = ;");
        assert!(r.parse_error);
    }

    #[test]
    fn ts_source_module() {
        let ctx = AnalyzeContext {
            dirname: "/proj/src".to_string(),
            filename: "/proj/src/x.ts".to_string(),
            cwd: "/proj".to_string(),
            compute_file_references: true,
        };
        let r = analyze(Path::new("/proj/src/x.ts"), "import x from './a'; const y: number = 1;", &ctx);
        assert!(r.is_esm);
        assert!(r.imports.contains(&"./a".to_string()));
    }
}
