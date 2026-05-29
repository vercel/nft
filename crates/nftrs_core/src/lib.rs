//! Trace orchestration for nftrs.
//!
//! Ports `src/node-file-trace.ts` from `@vercel/nft`: the `Job` that drives
//! `emit_file` / `emit_dependency` recursion, dedup, the `reasons` graph,
//! `esm_file_list`, `depth`, and `base`/`cwd` handling.
//!
//! Currently a skeleton — see <https://github.com/ubugeeei-prod/nftrs/issues/21>.

/// Placeholder so the crate compiles while the trace engine is being ported.
#[must_use]
pub fn placeholder() -> bool {
    true
}
