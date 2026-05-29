//! Source analysis for nftrs.
//!
//! Ports `src/analyze.ts` from `@vercel/nft`: parse a module with OXC, walk
//! the AST, and extract `{ deps, imports, assets, is_esm }`. Heavy
//! sub-systems live in dedicated modules:
//!
//! - [`static_eval`] — static expression evaluation (`src/utils/static-eval.ts`)
//! - [`wrappers`] — unwrap bundler output (`src/utils/wrappers.ts`)
//! - [`special_cases`] — per-package hacks (`src/utils/special-cases.ts`)
//!
//! Currently a skeleton — see <https://github.com/ubugeeei-prod/nftrs/issues/13>.

pub mod special_cases;
pub mod static_eval;
pub mod wrappers;

/// Placeholder so the crate compiles while the analyzer is being ported.
#[must_use]
pub fn placeholder() -> bool {
    true
}
