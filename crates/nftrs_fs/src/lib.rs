//! Cached filesystem layer for nftrs.
//!
//! Ports `src/fs.ts` from `@vercel/nft`: caching wrappers around
//! `readFile` / `stat` / `readlink`, plus `realpath` with symlink-loop
//! detection and in-base symlink emission.
//!
//! Currently a skeleton — see <https://github.com/ubugeeei-prod/nftrs/issues/10>.

/// Placeholder so the crate compiles while the FS layer is being ported.
#[must_use]
pub fn placeholder() -> bool {
    true
}
