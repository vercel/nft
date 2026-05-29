//! Dependency-free profiling primitives for nftrs.
//!
//! Will provide a `#[global_allocator]`-compatible counting allocator,
//! thread-local hierarchical timing spans, and machine-readable reports —
//! ported from `ox_content_profiler`. This is the measurement backbone for
//! the AI-automated optimization loop.
//!
//! Currently a skeleton — see <https://github.com/ubugeeei-prod/nftrs/issues/6>.

/// Placeholder so the crate compiles while the profiler is being ported.
#[must_use]
pub fn placeholder() -> bool {
    true
}
