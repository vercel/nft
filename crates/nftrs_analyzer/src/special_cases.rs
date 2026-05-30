//! Per-package special cases (ports `ref/src/utils/special-cases.ts`).
//!
//! File-`id`-keyed handlers that emit extra assets/dependencies for packages
//! whose runtime files can't be discovered by static analysis alone (native
//! binaries, asset directories, …).

use crate::static_eval::normalize_posix;
use crate::Asset;

/// Extra emissions for a module: asset paths/dirs and dependency paths
/// (absolute), discovered purely from the module's file `id`.
#[derive(Default)]
pub struct SpecialCase {
    pub assets: Vec<Asset>,
    /// Absolute dependency paths to follow (`emitDependency`).
    pub deps: Vec<String>,
}

/// The package name owning `id` (the segment after the last `node_modules/`,
/// including an `@scope/` prefix). Ports `getPackageName`.
#[must_use]
pub fn package_name(id: &str) -> Option<String> {
    let idx = id.rfind("node_modules")?;
    let before_ok = idx == 0 || id.as_bytes().get(idx - 1) == Some(&b'/');
    if !before_ok || id.as_bytes().get(idx + 12) != Some(&b'/') {
        return None;
    }
    let rest = &id[idx + 13..];
    let mut parts = rest.split('/');
    let first = parts.next()?;
    let name = if first.starts_with('@') {
        [first, "/", parts.next()?].concat()
    } else {
        first.to_string()
    };
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn resolve(dir: &str, rel: &str) -> String {
    normalize_posix(&[dir, "/", rel].concat())
}

/// Compute the special-case emissions for the module at `id` (its dir is
/// `dir`). Mirrors the package-keyed handlers in nft's `special-cases.ts`.
#[must_use]
pub fn special_case(id: &str, dir: &str) -> SpecialCase {
    let mut out = SpecialCase::default();
    let pkg = package_name(id);
    match pkg.as_deref() {
        Some("@generated/photon") if id.ends_with("@generated/photon/index.js") => {
            out.assets.push(Asset::Dir(resolve(dir, "runtime")));
        }
        Some("@serialport/bindings-cpp")
            if id.ends_with("@serialport/bindings-cpp/dist/index.js") =>
        {
            out.assets.push(Asset::Dir(resolve(dir, "../build/Release")));
            out.assets.push(Asset::Dir(resolve(dir, "../prebuilds")));
        }
        Some("argon2") if id.ends_with("argon2/argon2.js") => {
            out.assets.push(Asset::Dir(resolve(dir, "build/Release")));
            out.assets.push(Asset::Dir(resolve(dir, "prebuilds")));
            out.assets.push(Asset::Dir(resolve(dir, "lib/binding")));
        }
        Some("phantomjs-prebuilt") if id.ends_with("phantomjs-prebuilt/lib/phantomjs.js") => {
            out.assets.push(Asset::Dir(resolve(dir, "../bin")));
        }
        Some("pixelmatch") if id.ends_with("pixelmatch/index.js") => {
            out.deps.push(resolve(dir, "bin/pixelmatch"));
        }
        Some("shiki") if id.ends_with("/dist/index.js") => {
            out.assets.push(Asset::Dir(resolve(dir, "../languages")));
            out.assets.push(Asset::Dir(resolve(dir, "../themes")));
        }
        Some("typescript") if id.ends_with("typescript/lib/tsc.js") => {
            out.assets.push(Asset::Dir(resolve(dir, ".")));
        }
        Some("playwright-core") if id.ends_with("playwright-core/index.js") => {
            out.assets.push(Asset::File(resolve(dir, "browsers.json")));
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_name_basic() {
        assert_eq!(package_name("/x/node_modules/lodash/index.js").as_deref(), Some("lodash"));
    }

    #[test]
    fn package_name_scoped() {
        assert_eq!(
            package_name("/x/node_modules/@generated/photon/index.js").as_deref(),
            Some("@generated/photon")
        );
    }

    #[test]
    fn package_name_nested_node_modules() {
        assert_eq!(package_name("/a/node_modules/x/node_modules/y/lib.js").as_deref(), Some("y"));
    }

    #[test]
    fn package_name_none_outside_node_modules() {
        assert_eq!(package_name("/a/b/c.js"), None);
    }

    #[test]
    fn shiki_emits_language_and_theme_dirs() {
        let id = "/p/node_modules/shiki/dist/index.js";
        let sc = special_case(id, "/p/node_modules/shiki/dist");
        let dirs: Vec<_> = sc
            .assets
            .iter()
            .map(|a| match a {
                Asset::Dir(d) => d.clone(),
                Asset::File(f) => f.clone(),
            })
            .collect();
        assert!(dirs.contains(&"/p/node_modules/shiki/languages".to_string()));
        assert!(dirs.contains(&"/p/node_modules/shiki/themes".to_string()));
    }

    #[test]
    fn photon_emits_runtime_dir() {
        let id = "/p/node_modules/@generated/photon/index.js";
        let sc = special_case(id, "/p/node_modules/@generated/photon");
        assert!(matches!(
            sc.assets.first(),
            Some(Asset::Dir(d)) if d == "/p/node_modules/@generated/photon/runtime"
        ));
    }

    #[test]
    fn pixelmatch_emits_bin_dependency() {
        let id = "/p/node_modules/pixelmatch/index.js";
        let sc = special_case(id, "/p/node_modules/pixelmatch");
        assert_eq!(sc.deps, vec!["/p/node_modules/pixelmatch/bin/pixelmatch".to_string()]);
    }

    #[test]
    fn no_special_case_for_unknown_package() {
        let sc = special_case("/p/node_modules/lodash/index.js", "/p/node_modules/lodash");
        assert!(sc.assets.is_empty() && sc.deps.is_empty());
    }
}
