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
use nftrs_fs::{realpath, CachedFs};
use nftrs_resolver::DepResolver;

/// Options for a trace run. Mirrors the subset of `NodeFileTraceOptions`
/// wired so far.
pub struct TraceOptions {
    /// Base path; emitted files are relative to this.
    pub base: PathBuf,
    /// Working directory for `process.cwd()` resolution. Defaults to `base`.
    pub process_cwd: PathBuf,
    /// Max dependency depth to follow (`None` = unlimited).
    pub depth: Option<usize>,
    /// Whether to treat `.ts`/`.tsx` as resolvable (currently always on).
    pub ts: bool,
    /// Whether to compute asset/file references (`analysis`). Defaults to true.
    pub analysis: bool,
}

/// File extensions excluded from directory asset globbing (native build
/// intermediates), matching nft's `excludeAssetExtensions`.
const EXCLUDE_ASSET_EXTENSIONS: &[&str] = &["h", "cmake", "c", "cpp"];
/// File names excluded from directory asset globbing.
const EXCLUDE_ASSET_FILES: &[&str] = &["CHANGELOG.md", "README.md", "readme.md", "changelog.md"];

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
    fs: CachedFs,
    resolver: DepResolver,
    file_list: Vec<String>,
    file_set: HashSet<String>,
    esm_set: HashSet<String>,
    processed: HashSet<PathBuf>,
    warnings: Vec<String>,
}

impl Job {
    fn new(opts: &TraceOptions) -> Self {
        Self {
            base: normalize_abs(&opts.base),
            cwd: normalize_abs(&opts.process_cwd),
            depth: opts.depth,
            analysis: opts.analysis,
            fs: CachedFs::new(),
            resolver: DepResolver::new(),
            file_list: Vec::new(),
            file_set: HashSet::new(),
            esm_set: HashSet::new(),
            processed: HashSet::new(),
            warnings: Vec::new(),
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
        let real = realpath(path);

        if self.processed.contains(&real) {
            self.emit_file(&real);
            return;
        }
        self.processed.insert(real.clone());

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
        let specifiers = analysis.deps.iter().chain(analysis.imports.iter());
        for specifier in specifiers {
            match self.resolver.resolve(specifier, &real) {
                Ok(Some(resolved)) => self.emit_dependency(&resolved, next_depth),
                Ok(None) => {} // builtin — intentionally not emitted
                Err(msg) => self.warnings.push(msg),
            }
        }

        for asset in analysis.assets {
            self.emit_asset(asset, next_depth);
        }
    }

    /// Emit a referenced asset. Files are followed as dependencies when they
    /// look like modules (`.js`/`.mjs`/`.node`/extensionless, or in-base
    /// `.ts`/`.tsx`), otherwise emitted as plain files. Directories are
    /// globbed recursively (skipping `node_modules` and excluded names).
    fn emit_asset(&mut self, asset: Asset, depth: Option<usize>) {
        match asset {
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
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let is_module_like = matches!(ext, "js" | "mjs" | "cjs" | "node" | "")
            || (matches!(ext, "ts" | "tsx") && {
                let real = realpath(path);
                !relative(&self.base, &real).starts_with("..")
                    && !real.to_string_lossy().contains("/node_modules/")
            });
        if is_module_like {
            self.emit_dependency(path, depth);
        } else {
            self.emit_file(&realpath(path));
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
