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

use nftrs_analyzer::analyze;
use nftrs_fs::{realpath, CachedFs};
use nftrs_resolver::DepResolver;

/// Options for a trace run. Mirrors the subset of `NodeFileTraceOptions`
/// wired so far.
pub struct TraceOptions {
    /// Base path; emitted files are relative to this.
    pub base: PathBuf,
    /// Max dependency depth to follow (`None` = unlimited).
    pub depth: Option<usize>,
    /// Whether to treat `.ts`/`.tsx` as resolvable (currently always on).
    pub ts: bool,
}

/// Result of a trace run.
pub struct TraceResult {
    pub file_list: Vec<String>,
    pub esm_file_list: Vec<String>,
    pub warnings: Vec<String>,
}

struct Job {
    base: PathBuf,
    depth: Option<usize>,
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
            depth: opts.depth,
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

        let analysis = analyze(&real, &source);
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
