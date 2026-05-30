//! Trace orchestration for nftrs.
//!
//! Ports `src/node-file-trace.ts`: the `Job` that drives
//! `emit_file` / `emit_dependency` recursion, dedup, `esm_file_list`,
//! `depth`, and `base` handling. This early slice emits the entry files,
//! their nearest `package.json` boundary, and statically-resolvable
//! dependencies; assets, the reasons graph, ignore globs, and symlink
//! semantics land in follow-ups (#16/#17/#20/#21/#22).
//!
//! See <https://github.com/ubugeeei-prod/nftrs/issues/20>.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use nftrs_analyzer::{analyze, AnalyzeContext, Asset};
use nftrs_fs::{normalize, CachedFs};
use nftrs_resolver::{DepResolver, ResolveOpts};

/// Options for a trace run. Mirrors the subset of `NodeFileTraceOptions`
/// wired so far.
pub struct TraceOptions {
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
}

/// File extensions excluded from directory asset globbing (native build
/// intermediates), matching nft's `excludeAssetExtensions`.
const EXCLUDE_ASSET_EXTENSIONS: &[&str] = &["h", "cmake", "c", "cpp"];
/// File names excluded from directory asset globbing.
const EXCLUDE_ASSET_FILES: &[&str] = &["CHANGELOG.md", "README.md", "readme.md", "changelog.md"];

/// The wildcard sentinel (`\x1a`) embedded by the analyzer in glob paths.
const WILDCARD: char = '\u{1a}';

/// Result of a trace run.
pub struct TraceResult {
    pub file_list: Vec<String>,
    pub esm_file_list: Vec<String>,
    pub warnings: Vec<String>,
}

struct Job {
    base: PathBuf,
    cwd: PathBuf,
    depth: Option<usize>,
    analysis: bool,
    ts: bool,
    conditions: Vec<String>,
    exports_only: bool,
    module_sync_catchall: bool,
    paths: Vec<(String, String)>,
    fs: CachedFs,
    resolver: DepResolver,
    file_list: Vec<String>,
    file_set: HashSet<String>,
    esm_set: HashSet<String>,
    processed: HashSet<PathBuf>,
    remappings: std::collections::HashMap<PathBuf, Vec<PathBuf>>,
    warnings: Vec<String>,
}

impl Job {
    fn new(opts: &TraceOptions) -> Self {
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
            fs: CachedFs::new(),
            resolver: DepResolver::new(),
            file_list: Vec::new(),
            file_set: HashSet::new(),
            esm_set: HashSet::new(),
            processed: HashSet::new(),
            remappings: std::collections::HashMap::new(),
            warnings: Vec::new(),
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
        let opts = self.resolve_opts();
        match self.resolver.resolve(specifier, parent, cjs, &opts) {
            Ok(resolution) => {
                for pkg_json in resolution.emit_files {
                    let real = self.realpath(&pkg_json);
                    self.emit_file(&real);
                }
                for (from, to) in resolution.remappings {
                    let key = self.realpath(&from);
                    self.remappings.entry(key).or_default().push(to);
                }
                for target in resolution.paths {
                    self.emit_dependency(&target, depth);
                }
            }
            Err(msg) => self.warnings.push(msg),
        }
    }

    /// Resolve symlinks in `path`, emitting any in-base symlink files along the
    /// way (ports `Job.realpath`). Returns the fully resolved real path.
    fn realpath(&mut self, path: &Path) -> PathBuf {
        let mut seen = HashSet::new();
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
                self.emit_file(path);
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

    /// Add a file (relative to `base`) to the output. Returns `false` if it
    /// escapes the base (the nft default `ignoreFn`).
    fn emit_file(&mut self, real: &Path) -> bool {
        let rel = relative(&self.base, real);
        if rel.starts_with("..") {
            return false;
        }
        if self.file_set.insert(rel.clone()) {
            self.file_list.push(rel);
        }
        true
    }

    fn emit_dependency(&mut self, path: &Path, depth: Option<usize>) {
        let real = self.realpath(path);

        if self.processed.contains(&real) {
            self.emit_file(&real);
            return;
        }
        self.processed.insert(real.clone());

        // Browser-field remappings discovered during resolution: when this file
        // is emitted, also emit the files it remaps to.
        if let Some(extra) = self.remappings.get(&real).cloned() {
            for dep in extra {
                self.emit_dependency(&dep, depth);
            }
        }

        if !self.emit_file(&real) {
            return;
        }

        let real_str = real.to_string_lossy();
        if real_str.ends_with(".json") || real_str.ends_with(".node") {
            return;
        }

        // .js/.ts behavior depends on the nearest package.json `type`, so emit
        // that boundary file too.
        if real_str.ends_with(".js") || real_str.ends_with(".ts") {
            if let Some(boundary) = self.fs.pjson_boundary(&real) {
                self.emit_file(&boundary.join("package.json"));
            }
        }

        if depth == Some(0) {
            return;
        }

        let Some(source) = self.fs.read_to_string(&real) else {
            self.warnings.push(format!("File {} does not exist.", real.display()));
            return;
        };

        let dirname = real.parent().map_or_else(String::new, |p| p.to_string_lossy().into_owned());
        let ctx = AnalyzeContext {
            dirname,
            filename: real.to_string_lossy().into_owned(),
            cwd: self.cwd.to_string_lossy().into_owned(),
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
                self.emit_dependency(&file, next_depth);
            }
        }

        // Special-case dependencies (absolute paths): follow each directly.
        for dep in analysis.extra_deps {
            self.emit_dependency(Path::new(&dep), next_depth);
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
                for f in glob_asset(&p) {
                    self.emit_asset_path(&f, depth);
                }
            }
            Asset::File(p) => self.emit_asset_path(&PathBuf::from(p), depth),
            Asset::Dir(dir) => {
                let mut files = Vec::new();
                collect_dir_files(Path::new(&dir), &mut files);
                for f in files {
                    self.emit_asset_path(&f, depth);
                }
            }
        }
    }

    fn emit_asset_path(&mut self, path: &Path, depth: Option<usize>) {
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
            self.emit_dependency(path, depth);
        } else {
            let r = self.realpath(path);
            self.emit_file(&r);
        }
    }

    fn finish(mut self) -> TraceResult {
        self.file_list.sort();
        let mut esm_file_list: Vec<String> = self.esm_set.into_iter().collect();
        esm_file_list.sort();
        TraceResult { file_list: self.file_list, esm_file_list, warnings: self.warnings }
    }
}

/// Trace the runtime file dependencies of the given entry `files`.
#[must_use]
pub fn node_file_trace(files: &[PathBuf], opts: &TraceOptions) -> TraceResult {
    let mut job = Job::new(opts);
    for file in files {
        let abs = absolutize(file);
        job.emit_dependency(&abs, job.depth);
    }
    job.finish()
}

/// Whether `path` is strictly inside directory `parent`.
fn in_path(path: &Path, parent: &Path) -> bool {
    path != parent && path.starts_with(parent)
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
    let widx = wildcard_path.find(WILDCARD);
    let dir_index = match widx {
        None => wildcard_path.len(),
        // lastIndexOf('/', wildcardIndex)
        Some(i) => wildcard_path[..i].rfind('/').map_or(0, |x| x),
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
    if asset_path == format!("{module_dir}{suffix}") || asset_path == format!("{cwd}{suffix}") {
        return false;
    }
    // do not emit node_modules
    if asset_path.ends_with(&format!("/node_modules{suffix}")) {
        return false;
    }
    // do not emit directories above __dirname
    if module_dir.starts_with(&format!("{stripped}/")) {
        return false;
    }
    // inside node_modules: do not emit above the package's node_modules base
    if let Some(idx) = module_path.find("/node_modules") {
        let nm_base = format!("{}/node_modules/", &module_path[..idx]);
        if !asset_path.starts_with(&nm_base) {
            return false;
        }
    }
    true
}

/// `emitAssetDirectory`: glob the files matching a wildcard asset path.
fn glob_asset(wildcard_path: &str) -> Vec<PathBuf> {
    let (dir, pattern) = wildcard_split(wildcard_path);
    glob_walk(&dir, &format!("{dir}{pattern}"))
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
        patterns.push(format!("{dir}{pattern}"));
    } else {
        let mut exts: Vec<&str> = vec!["", ".js", ".json", ".node"];
        if ts {
            exts.push(".ts");
            exts.push(".tsx");
        }
        for ext in exts {
            patterns.push(format!("{dir}{pattern}{ext}"));
        }
    }
    let mut seen = HashSet::new();
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
