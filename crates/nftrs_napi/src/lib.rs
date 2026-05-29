//! Node.js bindings for nftrs, published to npm as `@nftrs/core`.
//!
//! The goal is a drop-in replacement for `@vercel/nft`'s `nodeFileTrace`:
//! same signature and the same return shape (`fileList` / `esmFileList` /
//! `reasons` / `warnings`). This is currently a skeleton that wires the
//! binding end-to-end (loadable and callable from Node); the real trace
//! engine lands with the M1 work — see
//! <https://github.com/ubugeeei-prod/nftrs/issues/23>.

use napi_derive::napi;

/// Options for [`node_file_trace`].
///
/// Mirrors a subset of `@vercel/nft`'s `NodeFileTraceOptions`; fields are
/// filled in as the trace engine is ported.
#[napi(object)]
#[derive(Default)]
pub struct NodeFileTraceOptions {
    /// Base path for the returned file list. Defaults to `process.cwd()`.
    pub base: Option<String>,
}

/// Result of [`node_file_trace`], matching `@vercel/nft`'s
/// `NodeFileTraceResult` shape (`reasons` is added with the M1 work).
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
///
/// Skeleton: currently echoes the inputs back as the file list so the binding
/// can be exercised from Node. Real tracing lands in M1.
#[napi]
pub fn node_file_trace(
    files: Vec<String>,
    _options: Option<NodeFileTraceOptions>,
) -> NodeFileTraceResult {
    NodeFileTraceResult {
        file_list: files,
        esm_file_list: Vec::new(),
        warnings: Vec::new(),
    }
}

/// The `@nftrs/core` package version.
#[napi]
#[must_use]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
