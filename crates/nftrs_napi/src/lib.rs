//! Node.js bindings for nftrs, published to npm as `@nftrs/core`.
//!
//! Aims to be a drop-in replacement for `@vercel/nft`'s `nodeFileTrace`:
//! same signature and return shape (`fileList` / `esmFileList` / `reasons` /
//! `warnings`), including the `resolve` and `ignore` JS callback overrides
//! (invoked synchronously during tracing).

// `#[napi]` expands to code that uses `std::format!` for type-conversion error
// messages, which we can't rewrite; the workspace bans `format!` elsewhere.
#![allow(clippy::disallowed_macros)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::{Either3, FnArgs, Function, Object};
use napi::Result;
use napi_derive::napi;
use nftrs_core::{node_file_trace as trace, ResolveOverride, TraceOptions};

/// Why a file is included: its reason `type`s and parent files. Mirrors a
/// `@vercel/nft` `NodeFileTraceReasons` entry.
#[napi(object)]
pub struct NodeFileTraceReason {
    /// Reason types: `initial` / `dependency` / `asset` / `resolve` / `sharedlib`.
    #[napi(js_name = "type")]
    pub type_: Vec<String>,
    /// The files (relative to `base`) that referenced this one.
    pub parents: Vec<String>,
}

/// Result of [`node_file_trace`], matching `@vercel/nft`'s
/// `NodeFileTraceResult` shape (`fileList` / `esmFileList` / `reasons` /
/// `warnings`).
#[napi(object)]
pub struct NodeFileTraceResult {
    /// All files (relative to `base`) needed at runtime.
    pub file_list: Vec<String>,
    /// The subset of `file_list` that is ESM.
    pub esm_file_list: Vec<String>,
    /// Non-fatal warnings encountered during tracing.
    pub warnings: Vec<String>,
    /// The reasons graph: file (relative to `base`) → why it's included.
    pub reasons: HashMap<String, NodeFileTraceReason>,
}

/// The JS `resolve` override: `(specifier, parent, cjs) -> string | string[] |
/// false | undefined`. Called synchronously on the JS thread during tracing.
type ResolveFn<'a> =
    Function<'a, FnArgs<(String, String, bool)>, Option<Either3<bool, String, Vec<String>>>>;
/// The JS `ignore` predicate: `(path) -> boolean` over a base-relative path.
type IgnoreFn<'a> = Function<'a, FnArgs<(String,)>, bool>;

/// Read an optional scalar option field by its JS key.
fn opt<V: napi::bindgen_prelude::FromNapiValue>(options: Option<&Object>, key: &str) -> Option<V> {
    options.and_then(|o| o.get::<V>(key).ok().flatten())
}

/// Trace the runtime file dependencies of the given entry `files`.
///
/// Takes the options as a raw object so the `resolve` / `ignore` callbacks
/// (JS functions, which can't live in a `#[napi(object)]` struct) can be
/// pulled out and invoked synchronously during the trace.
#[napi(ts_args_type = "files: Array<string>, options?: {
  base?: string
  processCwd?: string
  depth?: number
  ts?: boolean
  analysis?: boolean
  conditions?: Array<string>
  exportsOnly?: boolean
  moduleSyncCatchall?: boolean
  paths?: Record<string, string>
  resolve?: (specifier: string, parent: string, cjs: boolean) => string | Array<string> | false | undefined
  ignore?: (path: string) => boolean
}")]
pub fn node_file_trace(files: Vec<String>, options: Option<Object>) -> Result<NodeFileTraceResult> {
    let o = options.as_ref();
    let base = opt::<String>(o, "base")
        .map_or_else(|| std::env::current_dir().unwrap_or_default(), PathBuf::from);
    let process_cwd = opt::<String>(o, "processCwd").map_or_else(|| base.clone(), PathBuf::from);
    let paths: Vec<(String, String)> = opt::<HashMap<String, String>>(o, "paths")
        .map(|m| m.into_iter().collect())
        .unwrap_or_default();

    // The `resolve` / `ignore` JS callbacks, wrapped as Rust closures that call
    // back into JS synchronously (we're on the JS thread for this whole call).
    let resolve_fn = o.and_then(|o| o.get::<ResolveFn>("resolve").ok().flatten());
    let ignore_fn = o.and_then(|o| o.get::<IgnoreFn>("ignore").ok().flatten());

    let resolve = resolve_fn.map(|f| {
        Box::new(move |spec: &str, parent: &Path, cjs: bool| {
            let parent = parent.to_string_lossy().into_owned();
            match f.call(FnArgs::from((spec.to_string(), parent, cjs))) {
                Ok(Some(Either3::A(false))) => Some(ResolveOverride::Ignored),
                Ok(Some(Either3::B(s))) => Some(ResolveOverride::Resolved(vec![s])),
                Ok(Some(Either3::C(v))) => Some(ResolveOverride::Resolved(v)),
                // truthy non-string / undefined / a thrown error: fall through
                // to the built-in resolver.
                _ => None,
            }
        }) as Box<nftrs_core::ResolveHook>
    });
    let ignore = ignore_fn.map(|f| {
        Box::new(move |rel: &str| f.call(FnArgs::from((rel.to_string(),))).unwrap_or(false))
            as Box<nftrs_core::IgnoreHook>
    });

    let opts = TraceOptions {
        base,
        process_cwd,
        depth: opt::<u32>(o, "depth").map(|d| d as usize),
        ts: opt::<bool>(o, "ts").unwrap_or(true),
        analysis: opt::<bool>(o, "analysis").unwrap_or(true),
        conditions: opt::<Vec<String>>(o, "conditions").unwrap_or_default(),
        exports_only: opt::<bool>(o, "exportsOnly").unwrap_or(false),
        module_sync_catchall: opt::<bool>(o, "moduleSyncCatchall").unwrap_or(false),
        paths,
        resolve,
        ignore,
    };

    let entries: Vec<PathBuf> = files.into_iter().map(PathBuf::from).collect();
    let result = trace(&entries, &opts);

    let reasons = result
        .reasons
        .into_iter()
        .map(|(path, r)| (path, NodeFileTraceReason { type_: r.types, parents: r.parents }))
        .collect();

    Ok(NodeFileTraceResult {
        file_list: result.file_list,
        esm_file_list: result.esm_file_list,
        warnings: result.warnings,
        reasons,
    })
}

/// The `@nftrs/core` package version.
#[napi]
#[must_use]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
