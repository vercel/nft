//! Node.js module resolution for nftrs.
//!
//! Ports `src/resolve-dependency.ts`, built on [`oxc_resolver`] which
//! implements exports/imports/conditions/extensions/paths. This early slice
//! wires relative + `node_modules` resolution with nft's default extension
//! and condition set; the nft-specific behavior (remappings, `paths` option,
//! `exportsOnly`, `moduleSyncCatchall`) is layered on in #11/#12.
//!
//! See <https://github.com/ubugeeei-prod/nftrs/issues/10> and #11.

use std::path::{Path, PathBuf};

use oxc_resolver::{ResolveOptions, Resolver};

/// Node.js builtin modules that should never be emitted as files.
const NODE_BUILTINS: &[&str] = &[
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
];

/// Whether `specifier` refers to a Node builtin (with or without the `node:`
/// prefix).
#[must_use]
pub fn is_builtin(specifier: &str) -> bool {
    if let Some(rest) = specifier.strip_prefix("node:") {
        return NODE_BUILTINS.contains(&rest) || rest == "test";
    }
    NODE_BUILTINS.contains(&specifier)
}

/// Dependency resolver wrapping [`oxc_resolver`].
pub struct DepResolver {
    resolver: Resolver,
}

impl Default for DepResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl DepResolver {
    #[must_use]
    pub fn new() -> Self {
        let options = ResolveOptions {
            extensions: vec![
                ".js".into(),
                ".json".into(),
                ".node".into(),
                ".ts".into(),
                ".tsx".into(),
                ".jsx".into(),
                ".mjs".into(),
                ".cjs".into(),
            ],
            condition_names: vec!["node".into(), "require".into(), "import".into()],
            ..ResolveOptions::default()
        };
        Self { resolver: Resolver::new(options) }
    }

    /// Resolve `specifier` as imported from the `parent` file.
    ///
    /// Returns `Ok(None)` for Node builtins (which are intentionally not
    /// emitted), `Ok(Some(path))` for a resolved file, and `Err` with a
    /// message when resolution fails (the caller turns this into a warning).
    pub fn resolve(&self, specifier: &str, parent: &Path) -> Result<Option<PathBuf>, String> {
        if is_builtin(specifier) {
            return Ok(None);
        }
        let dir = parent.parent().unwrap_or(parent);
        match self.resolver.resolve(dir, specifier) {
            Ok(resolution) => Ok(Some(resolution.full_path())),
            Err(err) => {
                Err(format!("Cannot resolve '{specifier}' from {}: {err}", parent.display()))
            }
        }
    }
}
