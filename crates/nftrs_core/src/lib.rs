//! Trace orchestration for nftrs.
//!
//! Ports `ref/src/node-file-trace.ts`: the `Job` that drives
//! `emit_file` / `emit_dependency` recursion, dedup, `esm_file_list`,
//! `depth`, and `base` handling. This early slice emits the entry files,
//! their nearest `package.json` boundary, and statically-resolvable
//! dependencies; assets, the reasons graph, ignore globs, and symlink
//! semantics land in follow-ups (#16/#17/#20/#21/#22).
//!
//! See <https://github.com/ubugeeei-prod/nftrs/issues/20>.

use compact_str::format_compact;
use rustc_hash::{FxHashMap, FxHashSet as HashSet};
use std::path::{Component, Path, PathBuf};

use nftrs_analyzer::{analyze, AnalyzeContext, Asset};
use nftrs_fs::{normalize, CachedFs};
use nftrs_resolver::{DepResolver, ResolveOpts};

/// The outcome of a user `resolve` hook for one specifier (ports the
/// `string | string[] | false` return of nft's `resolve` override).
pub enum ResolveOverride {
    /// Use these path(s)/strings as the resolution (emitted as dependencies).
    Resolved(Vec<String>),
    /// Explicitly ignore the specifier (resolve to nothing); nft's `false`.
    Ignored,
}

/// A user `resolve` override: `(specifier, parent, cjs) -> override`. Returning
/// `None` falls through to the built-in resolver (nft's `undefined`).
pub type ResolveHook<'a> = dyn Fn(&str, &Path, bool) -> Option<ResolveOverride> + 'a;

/// A user `ignore` predicate over a base-relative path: `true` drops the file
/// (ports nft's `ignore` callback, applied on top of the default base-escape
/// rule).
pub type IgnoreHook<'a> = dyn Fn(&str) -> bool + 'a;

/// Options for a trace run. Mirrors the subset of `NodeFileTraceOptions`
/// wired so far.
#[derive(Default)]
pub struct TraceOptions<'a> {
    /// Base path; emitted files are relative to this.
    pub base: PathBuf,
    /// Working directory for `process.cwd()` resolution. Defaults to `base`.
    pub process_cwd: PathBuf,
    /// Max dependency depth to follow (`None` = unlimited).
    pub depth: Option<usize>,
    /// Whether to treat `.ts`/`.tsx` as resolvable.
    pub ts: bool,
    /// Whether to compute asset/file references (`analysis`). Defaults to true.
    pub analysis: bool,
    /// Active resolution conditions (default `["node"]`).
    pub conditions: Vec<String>,
    /// Only resolve via `exports` (no legacy `main`/file fallback).
    pub exports_only: bool,
    /// Treat `module-sync` as auto-selectable for wildcard subpaths.
    pub module_sync_catchall: bool,
    /// `paths` option entries (`name`/`prefix/` → target).
    pub paths: Vec<(String, String)>,
    /// Optional user `resolve` override (see [`ResolveHook`]).
    pub resolve: Option<Box<ResolveHook<'a>>>,
    /// Optional user `ignore` predicate (see [`IgnoreHook`]).
    pub ignore: Option<Box<IgnoreHook<'a>>>,
}

/// File extensions excluded from directory asset globbing (native build
/// intermediates), matching nft's `excludeAssetExtensions`.
const EXCLUDE_ASSET_EXTENSIONS: &[&str] = &["h", "cmake", "c", "cpp"];
/// File names excluded from directory asset globbing.
const EXCLUDE_ASSET_FILES: &[&str] = &["CHANGELOG.md", "README.md", "readme.md", "changelog.md"];

/// The wildcard sentinel (`\x1a`) embedded by the analyzer in glob paths.
const WILDCARD: char = '\u{1a}';

/// Why a file was included (mirrors a nft `NodeFileTraceReasons` entry).
///
/// The reason `type`s (`initial`/`dependency`/`asset`/`resolve`/`sharedlib`)
/// and the set of parent files that referenced it.
#[derive(Default, Clone)]
pub struct Reason {
    pub types: Vec<String>,
    pub parents: Vec<String>,
}

/// Result of a trace run.
pub struct TraceResult {
    pub file_list: Vec<String>,
    pub esm_file_list: Vec<String>,
    pub warnings: Vec<String>,
    /// The reasons graph: emitted file (relative to `base`) → why it's included.
    pub reasons: Vec<(String, Reason)>,
}

struct Job<'a> {
    base: PathBuf,
    cwd: PathBuf,
    depth: Option<usize>,
    analysis: bool,
    ts: bool,
    conditions: Vec<String>,
    exports_only: bool,
    module_sync_catchall: bool,
    paths: Vec<(String, String)>,
    /// User `resolve` override; consulted before the built-in resolver.
    resolve_hook: Option<&'a ResolveHook<'a>>,
    /// User `ignore` predicate; drops files on top of the base-escape rule.
    ignore_hook: Option<&'a IgnoreHook<'a>>,
    fs: CachedFs,
    resolver: DepResolver,
    file_list: Vec<String>,
    file_set: HashSet<String>,
    esm_set: HashSet<String>,
    processed: HashSet<PathBuf>,
    remappings: FxHashMap<PathBuf, Vec<PathBuf>>,
    warnings: Vec<String>,
    /// Reasons graph: rel path → why included. Insertion order preserved.
    reasons: FxHashMap<String, Reason>,
    reason_order: Vec<String>,
}

impl<'a> Job<'a> {
    fn new(opts: &'a TraceOptions<'a>) -> Self {
        let conditions = if opts.conditions.is_empty() {
            vec!["node".to_string()]
        } else {
            opts.conditions.clone()
        };
        Self {
            base: normalize_abs(&opts.base),
            cwd: normalize_abs(&opts.process_cwd),
            depth: opts.depth,
            analysis: opts.analysis,
            ts: opts.ts,
            conditions,
            exports_only: opts.exports_only,
            module_sync_catchall: opts.module_sync_catchall,
            paths: opts.paths.clone(),
            resolve_hook: opts.resolve.as_deref(),
            ignore_hook: opts.ignore.as_deref(),
            fs: CachedFs::new(),
            resolver: DepResolver::new(),
            file_list: Vec::new(),
            file_set: HashSet::default(),
            esm_set: HashSet::default(),
            processed: HashSet::default(),
            remappings: FxHashMap::default(),
            warnings: Vec::new(),
            reasons: FxHashMap::default(),
            reason_order: Vec::new(),
        }
    }

    fn resolve_opts(&self) -> ResolveOpts<'_> {
        ResolveOpts {
            base: &self.base,
            ts: self.ts,
            conditions: &self.conditions,
            exports_only: self.exports_only,
            module_sync_catchall: self.module_sync_catchall,
            paths: &self.paths,
        }
    }

    /// Resolve `specifier` and emit all resulting targets, package.json files,
    /// and record any browser remappings.
    fn resolve_and_emit(
        &mut self,
        specifier: &str,
        parent: &Path,
        cjs: bool,
        depth: Option<usize>,
    ) {
        // A user `resolve` override (nft's `resolve`) replaces the built-in
        // resolver for this specifier. `&ResolveHook` is `Copy`, so lift it out
        // before the `&mut self` emit calls.
        if let Some(hook) = self.resolve_hook {
            match hook(specifier, parent, cjs) {
                Some(ResolveOverride::Ignored) => return,
                Some(ResolveOverride::Resolved(targets)) => {
                    for t in targets {
                        let target = if Path::new(&t).is_absolute() {
                            PathBuf::from(&t)
                        } else {
                            self.base.join(&t)
                        };
                        // The override may name a virtual path that doesn't
                        // exist on disk; emit it directly as a terminal
                        // dependency without realpath/analysis.
                        self.emit_file(&target, Some(parent), "dependency");
                    }
                    return;
                }
                None => {} // fall through to the built-in resolver
            }
        }
        let opts = self.resolve_opts();
        match self.resolver.resolve(specifier, parent, cjs, &opts) {
            Ok(resolution) => {
                for pkg_json in resolution.emit_files {
                    let real = self.realpath(&pkg_json);
                    self.emit_file(&real, Some(parent), "resolve");
                }
                for (from, to) in resolution.remappings {
                    let key = self.realpath(&from);
                    self.remappings.entry(key).or_default().push(to);
                }
                for target in resolution.paths {
                    self.emit_dependency(&target, Some(parent), "dependency", depth);
                }
            }
            Err(msg) => self.warnings.push(msg),
        }
    }

    /// Resolve symlinks in `path`, emitting any in-base symlink files along the
    /// way (ports `Job.realpath`). Returns the fully resolved real path.
    fn realpath(&mut self, path: &Path) -> PathBuf {
        let mut seen = HashSet::default();
        self.realpath_inner(path, &mut seen)
    }

    fn realpath_inner(&mut self, path: &Path, seen: &mut HashSet<PathBuf>) -> PathBuf {
        if !seen.insert(path.to_path_buf()) {
            return path.to_path_buf(); // cyclic symlink — stop
        }
        if let Ok(target) = std::fs::read_link(path) {
            let parent = path.parent().unwrap_or(path);
            let resolved = normalize(&parent.join(&target));
            let real_parent = self.realpath_inner(parent, seen);
            // Emit the symlink itself when it lives inside the resolved parent.
            if in_path(path, &real_parent) {
                self.emit_file(path, None, "resolve");
            }
            return self.realpath_inner(&resolved, seen);
        }
        if !in_path(path, &self.base) {
            return path.to_path_buf();
        }
        match (path.parent(), path.file_name()) {
            (Some(parent), Some(name)) => self.realpath_inner(parent, seen).join(name),
            _ => path.to_path_buf(),
        }
    }

    /// Add a file (relative to `base`) to the output and record why it was
    /// included. Returns `false` if it escapes the base (the nft default
    /// `ignoreFn`). `parent` is the file that referenced it (`None` for an
    /// entry); `reason` is the inclusion type.
    fn emit_file(&mut self, real: &Path, parent: Option<&Path>, reason: &str) -> bool {
        let rel = relative(&self.base, real);
        if rel.starts_with("..") {
            return false;
        }
        // User `ignore` predicate, applied on top of the default base-escape
        // rule. `&IgnoreHook` is `Copy`, so it doesn't conflict with `&mut self`.
        if let Some(ignore) = self.ignore_hook {
            if ignore(&rel) {
                return false;
            }
        }
        let parent_rel = parent.map(|p| relative(&self.base, p));
        self.record_reason(&rel, parent_rel.as_deref(), reason);
        if self.file_set.insert(rel.clone()) {
            self.file_list.push(rel);
        }
        true
    }

    /// Record (or extend) the reason entry for `rel`.
    fn record_reason(&mut self, rel: &str, parent_rel: Option<&str>, reason: &str) {
        let entry = self.reasons.entry(rel.to_string()).or_insert_with(|| {
            self.reason_order.push(rel.to_string());
            Reason::default()
        });
        if !entry.types.iter().any(|t| t == reason) {
            entry.types.push(reason.to_string());
        }
        if let Some(p) = parent_rel {
            if !p.starts_with("..") && !entry.parents.iter().any(|x| x == p) {
                entry.parents.push(p.to_string());
            }
        }
    }

    fn emit_dependency(
        &mut self,
        path: &Path,
        parent: Option<&Path>,
        reason: &str,
        depth: Option<usize>,
    ) {
        let real = self.realpath(path);

        if self.processed.contains(&real) {
            self.emit_file(&real, parent, reason);
            return;
        }
        self.processed.insert(real.clone());

        // Browser-field remappings discovered during resolution: when this file
        // is emitted, also emit the files it remaps to.
        if let Some(extra) = self.remappings.get(&real).cloned() {
            for dep in extra {
                self.emit_dependency(&dep, Some(&real), "dependency", depth);
            }
        }

        if !self.emit_file(&real, parent, reason) {
            return;
        }

        let real_str = real.to_string_lossy();
        if real_str.ends_with(".json") {
            return;
        }
        if real_str.ends_with(".node") {
            // A native addon: also emit the package's sibling shared libraries
            // (`sharedLibEmit`), which it may `dlopen` at runtime.
            self.shared_lib_emit(&real);
            return;
        }

        // .js/.ts behavior depends on the nearest package.json `type`, so emit
        // that boundary file too.
        if real_str.ends_with(".js") || real_str.ends_with(".ts") {
            if let Some(boundary) = self.fs.pjson_boundary(&real) {
                self.emit_file(&boundary.join("package.json"), Some(&real), "resolve");
            }
        }

        if depth == Some(0) {
            return;
        }

        let Some(source) = self.fs.read_to_string(&real) else {
            self.warnings
                .push(format_compact!("File {} does not exist.", real.display()).into_string());
            return;
        };

        let dirname = real.parent().map_or_else(String::new, |p| p.to_string_lossy().into_owned());
        let ctx = AnalyzeContext {
            dirname,
            filename: real.to_string_lossy().into_owned(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            // `pathToFileURL` resolves against the real process cwd, which the
            // trace `base` mirrors.
            real_cwd: self.base.to_string_lossy().into_owned(),
            compute_file_references: self.analysis,
        };
        let analysis = analyze(&real, &source, &ctx);
        if analysis.is_esm {
            let rel = relative(&self.base, &real);
            self.esm_set.insert(rel);
        }

        let next_depth = depth.map(|d| d.saturating_sub(1));
        // CJS `require` deps resolve with the `require` condition unless this
        // module is ESM; static/dynamic `import` deps always use `import`.
        let cjs = !analysis.is_esm;
        let deps: Vec<String> = analysis.deps.clone();
        let imports: Vec<String> = analysis.imports.clone();
        for specifier in deps {
            self.resolve_and_emit(&specifier, &real, cjs, next_depth);
        }
        for specifier in imports {
            self.resolve_and_emit(&specifier, &real, false, next_depth);
        }

        let module_dir =
            real.parent().map_or_else(String::new, |p| p.to_string_lossy().into_owned());
        let module_path = real.to_string_lossy().into_owned();
        for asset in analysis.assets {
            self.emit_asset(asset, &module_dir, &module_path, next_depth);
        }

        // Wildcard `require`/`import` patterns: glob and follow each match as a
        // dependency (`emitWildcardRequire`).
        for pattern in analysis.require_globs {
            for file in glob_require(&pattern, self.ts) {
                self.emit_dependency(&file, Some(&real), "dependency", next_depth);
            }
        }

        // Special-case dependencies (absolute paths): follow each directly.
        for dep in analysis.extra_deps {
            self.emit_dependency(Path::new(&dep), Some(&real), "dependency", next_depth);
        }
    }

    /// Emit a referenced asset. Files are followed as dependencies when they
    /// look like modules (`.js`/`.mjs`/`.node`/extensionless, or in-base
    /// `.ts`/`.tsx`), otherwise emitted as plain files. Directories are
    /// globbed recursively (skipping `node_modules` and excluded names).
    fn emit_asset(
        &mut self,
        asset: Asset,
        module_dir: &str,
        module_path: &str,
        depth: Option<usize>,
    ) {
        match asset {
            Asset::File(p) if p.contains(WILDCARD) => {
                // `emitAssetDirectory`: glob the wildcard path and emit matches,
                // but only for valid wildcard directories (`validWildcard`):
                // never the cwd / __dirname / node_modules / a parent of dir.
                let cwd = self.cwd.to_string_lossy();
                if !valid_wildcard(&p, module_dir, &cwd, module_path) {
                    return;
                }
                let parent = PathBuf::from(module_path);
                for f in glob_asset(&p) {
                    self.emit_asset_path(&f, &parent, depth);
                }
            }
            Asset::File(p) => {
                self.emit_asset_path(&PathBuf::from(p), &PathBuf::from(module_path), depth);
            }
            Asset::Dir(dir) => {
                let parent = PathBuf::from(module_path);
                let mut files = Vec::new();
                collect_dir_files(Path::new(&dir), &mut files);
                for f in files {
                    self.emit_asset_path(&f, &parent, depth);
                }
            }
        }
    }

    /// `sharedLibEmit`: when a `.node` addon is emitted, also emit the sibling
    /// shared libraries (`.dylib`/`.so`/`.dll`) within its package, which it may
    /// load at runtime.
    fn shared_lib_emit(&mut self, node_path: &Path) {
        let s = node_path.to_string_lossy();
        let Some(base) = get_package_base(&s) else { return };
        let base = base.to_string();
        let mut libs = Vec::new();
        collect_shared_libs(Path::new(&base), &mut libs);
        for f in libs {
            self.emit_file(&f, Some(node_path), "sharedlib");
        }
    }

    fn emit_asset_path(&mut self, path: &Path, parent: &Path, depth: Option<usize>) {
        // nft only emits assets that exist on disk (`emitAssetPath` stats first),
        // so a computed-but-absent path (e.g. a platform-specific binary that is
        // not present) is skipped rather than emitted.
        if !path.exists() {
            return;
        }
        // Directories are only emitted via explicit `readdirSync` (Asset::Dir);
        // a bare `__dirname` surfaced by the general scanner is skipped here.
        if path.is_dir() {
            return;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let is_module_like = matches!(ext, "js" | "mjs" | "cjs" | "node" | "")
            || (matches!(ext, "ts" | "tsx") && {
                let real = self.realpath(path);
                !relative(&self.base, &real).starts_with("..")
                    && !real.to_string_lossy().contains("/node_modules/")
            });
        if is_module_like {
            self.emit_dependency(path, Some(parent), "asset", depth);
        } else {
            let r = self.realpath(path);
            self.emit_file(&r, Some(parent), "asset");
        }
    }

    fn finish(mut self) -> TraceResult {
        self.file_list.sort();
        let mut esm_file_list: Vec<String> = self.esm_set.into_iter().collect();
        esm_file_list.sort();
        let reasons = self
            .reason_order
            .into_iter()
            .filter_map(|k| self.reasons.remove(&k).map(|r| (k, r)))
            .collect();
        TraceResult { file_list: self.file_list, esm_file_list, warnings: self.warnings, reasons }
    }
}

/// Trace the runtime file dependencies of the given entry `files`.
#[must_use]
pub fn node_file_trace(files: &[PathBuf], opts: &TraceOptions) -> TraceResult {
    let mut job = Job::new(opts);
    for file in files {
        let abs = absolutize(file);
        job.emit_dependency(&abs, None, "initial", job.depth);
    }
    job.finish()
}

/// Whether `path` is strictly inside directory `parent`.
fn in_path(path: &Path, parent: &Path) -> bool {
    path != parent && path.starts_with(parent)
}

/// The package base directory of `id` (up to and including `node_modules/<pkg>`,
/// scoped or not). Ports nft's `getPackageBase`.
fn get_package_base(id: &str) -> Option<&str> {
    let idx = id.rfind("node_modules")?;
    let before_ok = idx == 0 || id.as_bytes().get(idx - 1) == Some(&b'/');
    if !before_ok || id.as_bytes().get(idx + 12) != Some(&b'/') {
        return None;
    }
    let start = idx + 13;
    let rest = &id[start..];
    let mut parts = rest.split('/');
    let first = parts.next()?;
    let pkg_len =
        if first.starts_with('@') { first.len() + 1 + parts.next()?.len() } else { first.len() };
    if pkg_len == 0 {
        None
    } else {
        Some(&id[..start + pkg_len])
    }
}

/// Whether `name` is a platform shared library (for the host platform, which is
/// also the runtime for the napi binding).
#[allow(clippy::case_sensitive_file_extension_comparisons)] // lib exts are lowercase
fn is_shared_lib(name: &str) -> bool {
    if cfg!(target_os = "windows") {
        name.ends_with(".dll")
    } else if cfg!(target_os = "macos") {
        name.ends_with(".dylib") || name.ends_with(".so") || name.contains(".so.")
    } else {
        name.ends_with(".so") || name.contains(".so.")
    }
}

/// Recursively collect shared-library files under `dir` (skipping nested
/// `node_modules`).
fn collect_shared_libs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if entry.file_name() == "node_modules" {
                continue;
            }
            collect_shared_libs(&path, out);
        } else if is_shared_lib(&entry.file_name().to_string_lossy()) {
            out.push(path);
        }
    }
}

/// Recursively collect files under `dir`, skipping `node_modules` and names/
/// extensions excluded from asset globbing. Mirrors nft's `emitAssetDirectory`
/// glob (`/**/*`, `nodir`, exclude lists).
fn collect_dir_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            if name == "node_modules" {
                continue;
            }
            collect_dir_files(&path, out);
        } else {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if EXCLUDE_ASSET_EXTENSIONS.contains(&ext)
                || EXCLUDE_ASSET_FILES.contains(&name.as_ref())
            {
                continue;
            }
            out.push(path);
        }
    }
}

/// Split a wildcard path (`/dir/.../foo\x1a.txt`) into its non-wildcard
/// directory prefix and the trailing pattern, with each `\x1a` turned into a
/// glob: `**/*` when it stands for a whole path segment (preceded by `/`),
/// else `*`. Mirrors `emitAssetDirectory`/`emitWildcardRequire`.
fn wildcard_split(wildcard_path: &str) -> (String, String) {
    let bytes = wildcard_path.as_bytes();
    // WILDCARD ('\x1a') and '/' are single-byte; SIMD byte scans beat str::find.
    let widx = memchr::memchr(0x1a, bytes);
    let dir_index = match widx {
        None => wildcard_path.len(),
        // lastIndexOf('/', wildcardIndex)
        Some(i) => memchr::memrchr(b'/', &bytes[..i]).unwrap_or(0),
    };
    let dir = wildcard_path[..dir_index].to_string();
    let pattern_path = &wildcard_path[dir_index..];
    let chars: Vec<char> = pattern_path.chars().collect();
    let mut pattern = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if c == WILDCARD {
            if i > 0 && chars[i - 1] == '/' {
                pattern.push_str("**/*");
            } else {
                pattern.push('*');
            }
        } else {
            pattern.push(c);
        }
    }
    if pattern.is_empty() {
        pattern.push_str("/**/*");
    }
    (dir, pattern)
}

/// Recursively walk `root`, returning files whose full path matches `glob`
/// (separator-aware), skipping `node_modules` subtrees.
fn glob_walk(root: &str, glob: &str) -> Vec<PathBuf> {
    let Ok(matcher) = globset::GlobBuilder::new(glob)
        .literal_separator(true)
        .build()
        .map(|g| g.compile_matcher())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    walk_match(Path::new(root), &matcher, &mut out);
    out
}

fn walk_match(dir: &Path, matcher: &globset::GlobMatcher, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if entry.file_name() == "node_modules" {
                continue;
            }
            walk_match(&path, matcher, out);
        } else if matcher.is_match(&path) {
            out.push(path);
        }
    }
}

/// Whether a globbed asset/require name is excluded (native build
/// intermediates, changelog/readme).
fn excluded_glob_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    EXCLUDE_ASSET_EXTENSIONS.contains(&ext) || EXCLUDE_ASSET_FILES.contains(&name.as_str())
}

/// Port of nft's `validWildcard`: reject wildcard directory assets that would
/// over-emit — the cwd, the module's own dir (`__dirname`), `node_modules`,
/// directories above the module dir, and (inside `node_modules`) anything
/// above the package's `node_modules` base.
fn valid_wildcard(asset_path: &str, module_dir: &str, cwd: &str, module_path: &str) -> bool {
    let suffix = if asset_path.ends_with('/') {
        "/"
    } else if asset_path.ends_with("/\u{1a}") {
        "/\u{1a}"
    } else if asset_path.ends_with('\u{1a}') {
        "\u{1a}"
    } else {
        ""
    };
    let stripped = &asset_path[..asset_path.len() - suffix.len()];
    // do not emit __dirname or cwd
    if asset_path == format_compact!("{module_dir}{suffix}")
        || asset_path == format_compact!("{cwd}{suffix}")
    {
        return false;
    }
    // do not emit node_modules
    if asset_path.ends_with(format_compact!("/node_modules{suffix}").as_str()) {
        return false;
    }
    // do not emit directories above __dirname
    if module_dir.starts_with(format_compact!("{stripped}/").as_str()) {
        return false;
    }
    // inside node_modules: do not emit above the package's node_modules base
    if let Some(idx) = module_path.find("/node_modules") {
        let nm_base = format_compact!("{}/node_modules/", &module_path[..idx]);
        if !asset_path.starts_with(nm_base.as_str()) {
            return false;
        }
    }
    true
}

/// `emitAssetDirectory`: glob the files matching a wildcard asset path.
fn glob_asset(wildcard_path: &str) -> Vec<PathBuf> {
    let (dir, pattern) = wildcard_split(wildcard_path);
    glob_walk(&dir, &format_compact!("{dir}{pattern}"))
        .into_iter()
        .filter(|p| !excluded_glob_file(p))
        .collect()
}

/// `emitWildcardRequire`: glob the module files matching a wildcard require
/// pattern. When the pattern does not end in `*`, nft appends an optional
/// extension group (`?(.ts|.tsx|.js|.json|.node)`); we model that by unioning
/// the bare pattern with each extension candidate.
fn glob_require(wildcard_path: &str, ts: bool) -> Vec<PathBuf> {
    let (dir, pattern) = wildcard_split(wildcard_path);
    let mut patterns = Vec::new();
    if pattern.ends_with('*') {
        patterns.push(format_compact!("{dir}{pattern}").into_string());
    } else {
        let mut exts: Vec<&str> = vec!["", ".js", ".json", ".node"];
        if ts {
            exts.push(".ts");
            exts.push(".tsx");
        }
        for ext in exts {
            patterns.push(format_compact!("{dir}{pattern}{ext}").into_string());
        }
    }
    let mut seen = HashSet::default();
    let mut out = Vec::new();
    for pat in patterns {
        for p in glob_walk(&dir, &pat) {
            if !excluded_glob_file(&p) && seen.insert(p.clone()) {
                out.push(p);
            }
        }
    }
    out
}

/// Make `path` absolute (resolving against the current working directory when
/// relative) and normalize it lexically. Mirrors `path.resolve(file)`.
fn absolutize(path: &Path) -> PathBuf {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    nftrs_fs::normalize(&abs)
}

/// Normalize a base path lexically, absolutizing if needed.
fn normalize_abs(path: &Path) -> PathBuf {
    absolutize(path)
}

/// Compute `path` relative to `base`, using forward slashes. Falls back to
/// `..` segments when `path` is not under `base`.
fn relative(base: &Path, path: &Path) -> String {
    let base_comps: Vec<Component> = base.components().collect();
    let path_comps: Vec<Component> = path.components().collect();

    let mut i = 0;
    while i < base_comps.len() && i < path_comps.len() && base_comps[i] == path_comps[i] {
        i += 1;
    }

    let mut parts: Vec<String> = Vec::new();
    for _ in i..base_comps.len() {
        parts.push("..".to_string());
    }
    for comp in &path_comps[i..] {
        parts.push(comp.as_os_str().to_string_lossy().to_string());
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths() {
        assert_eq!(relative(Path::new("/a/b"), Path::new("/a/b/c/d.js")), "c/d.js");
        assert_eq!(relative(Path::new("/a/b"), Path::new("/a/b")), "");
        assert_eq!(relative(Path::new("/a/b/c"), Path::new("/a/b/x.js")), "../x.js");
        assert_eq!(relative(Path::new("/a/b"), Path::new("/x/y.js")), "../../x/y.js");
    }

    #[test]
    fn wildcard_split_trailing_wildcard() {
        let (dir, pat) = wildcard_split("/a/assets/x\u{1a}.txt");
        assert_eq!(dir, "/a/assets");
        assert_eq!(pat, "/x*.txt");
    }

    #[test]
    fn wildcard_split_segment_wildcard() {
        // a `\x1a` preceded by `/` matches a whole path segment -> `**/*`.
        let (dir, pat) = wildcard_split("/a/\u{1a}/b.txt");
        assert_eq!(dir, "/a");
        assert_eq!(pat, "/**/*/b.txt");
    }

    #[test]
    fn wildcard_split_bare() {
        let (dir, pat) = wildcard_split("/a/mods/mod\u{1a}");
        assert_eq!(dir, "/a/mods");
        assert_eq!(pat, "/mod*");
    }

    #[test]
    fn valid_wildcard_rejects_cwd_and_dirname() {
        // never glob the cwd or the module dir
        assert!(!valid_wildcard("/proj/\u{1a}", "/proj/src", "/proj", "/proj/src/i.js"));
        assert!(!valid_wildcard("/proj/src/\u{1a}", "/proj/src", "/proj", "/proj/src/i.js"));
    }

    #[test]
    fn valid_wildcard_rejects_node_modules_and_parents() {
        assert!(!valid_wildcard(
            "/proj/node_modules/\u{1a}",
            "/proj/src",
            "/proj",
            "/proj/src/i.js"
        ));
        // directory above the module dir
        assert!(!valid_wildcard("/proj/\u{1a}", "/proj/src/deep", "/other", "/proj/src/deep/i.js"));
    }

    #[test]
    fn valid_wildcard_accepts_subdir() {
        assert!(valid_wildcard(
            "/proj/src/assets/\u{1a}.txt",
            "/proj/src",
            "/proj",
            "/proj/src/i.js"
        ));
    }

    #[test]
    fn valid_wildcard_respects_package_node_modules_base() {
        // inside node_modules: asset must stay within the package's nm base
        assert!(!valid_wildcard(
            "/proj/other/\u{1a}",
            "/proj/node_modules/p/lib",
            "/proj",
            "/proj/node_modules/p/lib/i.js"
        ));
        assert!(valid_wildcard(
            "/proj/node_modules/p/data/\u{1a}",
            "/proj/node_modules/p/lib",
            "/proj",
            "/proj/node_modules/p/lib/i.js"
        ));
    }

    #[test]
    fn excluded_glob_files() {
        assert!(excluded_glob_file(Path::new("/a/foo.h")));
        assert!(excluded_glob_file(Path::new("/a/README.md")));
        assert!(!excluded_glob_file(Path::new("/a/index.js")));
    }

    #[test]
    fn package_base() {
        assert_eq!(
            get_package_base("/p/node_modules/sharp/build/Release/sharp.node"),
            Some("/p/node_modules/sharp")
        );
        assert_eq!(
            get_package_base("/p/node_modules/@img/sharp-darwin/lib/x.node"),
            Some("/p/node_modules/@img/sharp-darwin")
        );
        assert_eq!(get_package_base("/p/src/a.node"), None);
    }

    #[test]
    fn shared_lib_detection() {
        if cfg!(target_os = "windows") {
            assert!(is_shared_lib("foo.dll"));
        } else {
            assert!(is_shared_lib("libfoo.so"));
            assert!(is_shared_lib("libfoo.so.1"));
            assert!(!is_shared_lib("foo.js"));
            assert!(!is_shared_lib("foo.node"));
        }
    }
}

#[cfg(test)]
mod trace_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Fx {
        root: PathBuf,
    }
    impl Fx {
        fn new() -> Self {
            let n = N.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir()
                .join(format_compact!("nftrs_trace_{}_{n}", std::process::id()).as_str());
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn file(&self, rel: &str, body: &str) -> &Self {
            let p = self.root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
            self
        }
        fn trace(&self, entry: &str) -> Vec<String> {
            let opts = TraceOptions {
                base: self.root.clone(),
                process_cwd: self.root.clone(),
                depth: None,
                ts: true,
                analysis: true,
                conditions: vec!["node".to_string()],
                exports_only: false,
                module_sync_catchall: false,
                paths: vec![],
                resolve: None,
                ignore: None,
            };
            let mut list = node_file_trace(&[self.root.join(entry)], &opts).file_list;
            list.sort();
            list
        }
        fn trace_result(&self, entry: &str) -> TraceResult {
            let opts = TraceOptions {
                base: self.root.clone(),
                process_cwd: self.root.clone(),
                depth: None,
                ts: true,
                analysis: true,
                conditions: vec!["node".to_string()],
                exports_only: false,
                module_sync_catchall: false,
                paths: vec![],
                resolve: None,
                ignore: None,
            };
            node_file_trace(&[self.root.join(entry)], &opts)
        }
    }
    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn reasons_graph_records_parents_and_types() {
        let f = Fx::new();
        f.file(
            "input.js",
            "const fs=require('fs'); require('./a'); fs.readFileSync(__dirname + '/d.txt');",
        )
        .file("a.js", "module.exports = 1;")
        .file("d.txt", "x");
        let r = f.trace_result("input.js");
        let by: std::collections::HashMap<_, _> = r.reasons.into_iter().collect();
        // entry
        assert_eq!(by["input.js"].types, vec!["initial".to_string()]);
        assert!(by["input.js"].parents.is_empty());
        // dependency, with input.js as parent
        assert_eq!(by["a.js"].types, vec!["dependency".to_string()]);
        assert_eq!(by["a.js"].parents, vec!["input.js".to_string()]);
        // asset, with input.js as parent
        assert_eq!(by["d.txt"].types, vec!["asset".to_string()]);
        assert_eq!(by["d.txt"].parents, vec!["input.js".to_string()]);
    }

    #[test]
    fn traces_require_chain() {
        let f = Fx::new();
        f.file("input.js", "require('./a');")
            .file("a.js", "require('./b');")
            .file("b.js", "module.exports = 1;");
        let list = f.trace("input.js");
        assert!(list.contains(&"input.js".to_string()));
        assert!(list.contains(&"a.js".to_string()));
        assert!(list.contains(&"b.js".to_string()));
    }

    #[test]
    fn traces_fs_asset() {
        let f = Fx::new();
        f.file("input.js", "const fs=require('fs'); fs.readFileSync(__dirname + '/data.txt');")
            .file("data.txt", "x");
        let list = f.trace("input.js");
        assert!(list.contains(&"data.txt".to_string()));
    }

    #[test]
    fn traces_wildcard_require_glob() {
        let f = Fx::new();
        f.file("input.js", "const n=unknown; require(`./mods/mod${n}`);")
            .file("mods/mod1.js", "")
            .file("mods/mod2.js", "");
        let list = f.trace("input.js");
        assert!(list.contains(&"mods/mod1.js".to_string()));
        assert!(list.contains(&"mods/mod2.js".to_string()));
    }

    #[test]
    fn does_not_emit_files_outside_base() {
        let f = Fx::new();
        // an asset that escapes the base must not be emitted.
        f.file(
            "input.js",
            "const fs=require('fs'); fs.readFileSync(__dirname + '/../../etc/passwd');",
        );
        let list = f.trace("input.js");
        assert!(list.iter().all(|p| !p.contains("passwd")));
    }

    #[test]
    fn depth_zero_stops_recursion() {
        let f = Fx::new();
        f.file("input.js", "require('./a');").file("a.js", "require('./b');").file("b.js", "");
        let opts = TraceOptions {
            base: f.root.clone(),
            process_cwd: f.root.clone(),
            depth: Some(0),
            ts: true,
            analysis: true,
            conditions: vec!["node".to_string()],
            exports_only: false,
            module_sync_catchall: false,
            paths: vec![],
            resolve: None,
            ignore: None,
        };
        let list = node_file_trace(&[f.root.join("input.js")], &opts).file_list;
        assert!(list.contains(&"input.js".to_string()));
        assert!(!list.contains(&"b.js".to_string()));
    }

    /// Build default `TraceOptions` rooted at `root`, for hook tests.
    fn opts_for<'a>(root: &Path) -> TraceOptions<'a> {
        TraceOptions {
            base: root.to_path_buf(),
            process_cwd: root.to_path_buf(),
            depth: None,
            ts: true,
            analysis: true,
            conditions: vec!["node".to_string()],
            exports_only: false,
            module_sync_catchall: false,
            paths: vec![],
            resolve: None,
            ignore: None,
        }
    }

    #[test]
    fn resolve_hook_overrides_resolution() {
        let f = Fx::new();
        f.file("input.js", "require('./local-dep');\nrequire('external-dep');");
        let mut opts = opts_for(&f.root);
        // Mirror nft's `resolve-hook` fixture: map every specifier to a virtual
        // path that need not exist on disk.
        opts.resolve = Some(Box::new(|id: &str, _p: &Path, _cjs: bool| {
            Some(ResolveOverride::Resolved(vec![["custom-resolution-", id].concat()]))
        }));
        let mut list = node_file_trace(&[f.root.join("input.js")], &opts).file_list;
        list.sort();
        assert!(list.contains(&"custom-resolution-./local-dep".to_string()), "{list:?}");
        assert!(list.contains(&"custom-resolution-external-dep".to_string()), "{list:?}");
        assert!(list.contains(&"input.js".to_string()));
    }

    #[test]
    fn resolve_hook_false_ignores_specifier() {
        let f = Fx::new();
        f.file("input.js", "require('./a');").file("a.js", "");
        let mut opts = opts_for(&f.root);
        opts.resolve = Some(Box::new(|_id: &str, _p: &Path, _cjs: bool| Some(ResolveOverride::Ignored)));
        let list = node_file_trace(&[f.root.join("input.js")], &opts).file_list;
        assert!(list.contains(&"input.js".to_string()));
        assert!(!list.contains(&"a.js".to_string()), "ignored specifier must not be emitted: {list:?}");
    }

    #[test]
    fn ignore_hook_drops_matching_files() {
        let f = Fx::new();
        f.file("input.js", "require('./a');").file("a.js", "require('./b');").file("b.js", "");
        let mut opts = opts_for(&f.root);
        opts.ignore = Some(Box::new(|rel: &str| rel.ends_with("a.js")));
        let list = node_file_trace(&[f.root.join("input.js")], &opts).file_list;
        assert!(list.contains(&"input.js".to_string()));
        // a.js is ignored, so neither it nor its transitive dep b.js is emitted.
        assert!(!list.contains(&"a.js".to_string()), "{list:?}");
        assert!(!list.contains(&"b.js".to_string()), "ignored file's deps must not be followed: {list:?}");
    }
}
