//! Node.js bindings for nftrs, published to npm as `@nftrs/core`.
//!
//! Aims to be a drop-in replacement for `@vercel/nft`'s `nodeFileTrace`:
//! same signature and return shape (`fileList` / `esmFileList` / `reasons` /
//! `warnings`). `reasons` and the JS callback overrides are still being wired
//! — see <https://github.com/ubugeeei-prod/nftrs/issues/22>.

use std::collections::HashMap;
use std::path::PathBuf;

use napi_derive::napi;
use nftrs_core::{node_file_trace as trace, TraceOptions};

/// Options for [`node_file_trace`]. Mirrors a subset of `@vercel/nft`'s
/// `NodeFileTraceOptions`; unrecognized fields are ignored.
#[napi(object)]
#[derive(Default)]
pub struct NodeFileTraceOptions {
    /// Base path for the returned file list. Defaults to `process.cwd()`.
    pub base: Option<String>,
    /// Working directory for `process.cwd()` resolution. Defaults to `base`.
    pub process_cwd: Option<String>,
    /// Max dependency depth to follow (`undefined` = unlimited).
    pub depth: Option<u32>,
    /// Whether to resolve `.ts`/`.tsx` files. Defaults to `true`.
    pub ts: Option<bool>,
    /// Whether to compute asset/file references. Defaults to `true`.
    pub analysis: Option<bool>,
    /// Active resolution conditions (default `["node"]`).
    pub conditions: Option<Vec<String>>,
    /// Only resolve via `exports` (no legacy `main` fallback).
    pub exports_only: Option<bool>,
    /// Treat `module-sync` as auto-selectable for wildcard subpaths.
    pub module_sync_catchall: Option<bool>,
    /// `paths` option: specifier (or `prefix/`) → target path.
    pub paths: Option<HashMap<String, String>>,
}

/// Result of [`node_file_trace`], matching `@vercel/nft`'s
/// `NodeFileTraceResult` shape (`reasons` is added with #22).
#[napi(object)]
pub struct NodeFileTraceResult {
    /// All files (relative to `base`) needed at runtime.
    pub file_list: Vec<String>,
    /// The subset of `file_list` that is ESM.
    pub esm_file_list: Vec<String>,
    /// Non-fatal warnings encountered during tracing.
    pub warnings: Vec<String>,
}

/// Trace the runtime file dependencies of the given entry `files`.
#[napi]
pub fn node_file_trace(
    files: Vec<String>,
    options: Option<NodeFileTraceOptions>,
) -> NodeFileTraceResult {
    let options = options.unwrap_or_default();
    let base = options
        .base
        .clone()
        .map_or_else(|| std::env::current_dir().unwrap_or_default(), PathBuf::from);
    let process_cwd = options.process_cwd.map_or_else(|| base.clone(), PathBuf::from);

    let opts = TraceOptions {
        base,
        process_cwd,
        depth: options.depth.map(|d| d as usize),
        ts: options.ts.unwrap_or(true),
        analysis: options.analysis.unwrap_or(true),
        conditions: options.conditions.unwrap_or_default(),
        exports_only: options.exports_only.unwrap_or(false),
        module_sync_catchall: options.module_sync_catchall.unwrap_or(false),
        paths: options.paths.map(|m| m.into_iter().collect()).unwrap_or_default(),
    };

    let entries: Vec<PathBuf> = files.into_iter().map(PathBuf::from).collect();
    let result = trace(&entries, &opts);

    NodeFileTraceResult {
        file_list: result.file_list,
        esm_file_list: result.esm_file_list,
        warnings: result.warnings,
    }
}

/// The `@nftrs/core` package version.
#[napi]
#[must_use]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
