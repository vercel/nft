//! Node.js module resolution for nftrs.
//!
//! Ports `src/resolve-dependency.ts` from `@vercel/nft`, built on top of
//! [`oxc_resolver`] which already implements exports/imports/conditions/
//! extensions/paths. nft-specific behavior (remappings, package.json
//! boundaries, `type: module` detection) is layered on top.
//!
//! Currently a skeleton — see <https://github.com/ubugeeei-prod/nftrs/issues/11>.

/// Placeholder so the crate compiles while the resolver is being ported.
#[must_use]
pub fn placeholder() -> bool {
    true
}
