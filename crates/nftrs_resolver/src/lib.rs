//! Node.js module resolution for nftrs.
//!
//! A faithful port of `src/resolve-dependency.ts` from `@vercel/nft`: relative
//! and `node_modules` resolution, the `exports`/`imports` maps with condition
//! selection (`require`/`import`/`node`/`browser`/`module-sync`), `browser`
//! field remappings, the `paths` option, and nft's deliberate over-tracing
//! (it emits the legacy `main` alongside `exports` targets, and both branches
//! of `module-sync`). Resolution returns potentially multiple paths plus the
//! package.json files to emit and any browser remappings discovered.
//!
//! See <https://github.com/ubugeeei-prod/nftrs/issues/11> and #12.

use std::path::{Path, PathBuf};

use serde_json::Value;

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

/// Node >= 22 auto-selects the `module-sync` condition.
const NODE_SUPPORTS_MODULE_SYNC: bool = true;

/// Whether `specifier` refers to a Node builtin (with or without `node:`).
#[must_use]
pub fn is_builtin(specifier: &str) -> bool {
    if let Some(rest) = specifier.strip_prefix("node:") {
        return NODE_BUILTINS.contains(&rest) || rest == "test";
    }
    NODE_BUILTINS.contains(&specifier)
}

/// Options affecting resolution (mirrors the relevant `Job` fields).
pub struct ResolveOpts<'a> {
    pub base: &'a Path,
    pub ts: bool,
    /// Active conditions (default `["node"]`).
    pub conditions: &'a [String],
    pub exports_only: bool,
    pub module_sync_catchall: bool,
    /// `paths` option entries (`name` or `prefix/` → target).
    pub paths: &'a [(String, String)],
}

/// Outcome of resolving one specifier.
#[derive(Default)]
pub struct Resolution {
    /// Resolved target files (usually one; multiple for nft over-tracing).
    pub paths: Vec<PathBuf>,
    /// `package.json` files to emit as `resolve` reasons.
    pub emit_files: Vec<PathBuf>,
    /// `browser`-field remappings discovered (`from` → `to`).
    pub remappings: Vec<(PathBuf, PathBuf)>,
}

/// Resolver entry point. Stateless; options are passed per call.
#[derive(Default)]
pub struct DepResolver;

impl DepResolver {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Resolve `specifier` imported from `parent`. `cjs` selects the
    /// `require` vs `import` condition. Builtins yield an empty `paths`.
    pub fn resolve(
        &self,
        specifier: &str,
        parent: &Path,
        cjs: bool,
        opts: &ResolveOpts,
    ) -> Result<Resolution, String> {
        let mut ctx = Ctx { opts, res: Resolution::default() };
        let paths = if is_builtin(specifier) {
            Vec::new()
        } else if specifier.starts_with('/')
            || specifier == "."
            || specifier == ".."
            || specifier.starts_with("./")
            || specifier.starts_with("../")
        {
            let parent_dir = parent.parent().unwrap_or(parent);
            let target = nftrs_fs::normalize(&parent_dir.join(specifier));
            // A trailing slash forces directory (index) resolution, never the
            // sibling `<name>.js` file.
            let resolved = if specifier.ends_with('/') {
                ctx.resolve_dir(&target)
            } else {
                ctx.resolve_path(&target)
            };
            match resolved {
                Some(p) => vec![p],
                None => return Err(not_found(specifier, parent)),
            }
        } else if specifier.starts_with('#') {
            ctx.package_imports_resolve(specifier, parent, cjs)
                .ok_or_else(|| not_found(specifier, parent))?
        } else {
            ctx.resolve_package(specifier, parent, cjs)
                .ok_or_else(|| not_found(specifier, parent))?
        };
        ctx.res.paths = paths;
        Ok(ctx.res)
    }
}

fn not_found(specifier: &str, parent: &Path) -> String {
    format!("Cannot find module '{specifier}' loaded from {}", parent.display())
}

struct Ctx<'a> {
    opts: &'a ResolveOpts<'a>,
    res: Resolution,
}

impl Ctx<'_> {
    fn resolve_file(&self, path: &Path) -> Option<PathBuf> {
        let s = path.to_string_lossy();
        if s.ends_with('/') {
            return None;
        }
        if path.is_file() {
            return Some(path.to_path_buf());
        }
        // `.ts` resolution applies to in-base, non-`node_modules` files. The
        // in-base check is lexical, but the `node_modules` check follows the
        // realpath of the parent dir so a workspace symlink under
        // `node_modules` (pointing at real package sources) still qualifies.
        let under_base = path.strip_prefix(self.opts.base).is_ok();
        let real_dir = path.parent().and_then(|p| std::fs::canonicalize(p).ok());
        let not_in_node_modules = match &real_dir {
            Some(rd) => !rd.to_string_lossy().contains("/node_modules/"),
            None => path
                .strip_prefix(self.opts.base)
                .is_ok_and(|rest| !format!("/{}", rest.to_string_lossy()).contains("/node_modules/")),
        };
        let under_base_non_nm = under_base && not_in_node_modules;
        if self.opts.ts && under_base_non_nm {
            for ext in [".ts", ".tsx"] {
                let cand = PathBuf::from(format!("{s}{ext}"));
                if cand.is_file() {
                    return Some(cand);
                }
            }
            // TS allows importing the emitted `.js`/`.mjs`/`.cjs`/`.jsx` name;
            // map it back to the matching TS source.
            for (js, ts_exts) in [
                (".js", &[".ts", ".tsx"][..]),
                (".jsx", &[".tsx"][..]),
                (".mjs", &[".mts"][..]),
                (".cjs", &[".cts"][..]),
            ] {
                if let Some(stem) = s.strip_suffix(js) {
                    for ext in ts_exts {
                        let cand = PathBuf::from(format!("{stem}{ext}"));
                        if cand.is_file() {
                            return Some(cand);
                        }
                    }
                }
            }
        }
        for ext in [".js", ".json", ".node"] {
            let cand = PathBuf::from(format!("{s}{ext}"));
            if cand.is_file() {
                return Some(cand);
            }
        }
        None
    }

    fn resolve_dir(&mut self, path: &Path) -> Option<PathBuf> {
        let path = PathBuf::from(path.to_string_lossy().trim_end_matches('/'));
        if !path.is_dir() {
            return None;
        }
        if let Some(cfg) = get_pkg_cfg(&path) {
            if let Some(main) = cfg.get("main").and_then(Value::as_str) {
                let resolved = self
                    .resolve_file(&path.join(main))
                    .or_else(|| self.resolve_file(&path.join(main).join("index")));
                if let Some(resolved) = resolved {
                    self.res.emit_files.push(path.join("package.json"));
                    return Some(resolved);
                }
            }
        }
        self.resolve_file(&path.join("index"))
    }

    fn resolve_path(&mut self, target: &Path) -> Option<PathBuf> {
        self.resolve_file(target).or_else(|| self.resolve_dir(target))
    }

    fn resolve_exports_imports(
        &mut self,
        pkg_path: &Path,
        obj: &Value,
        subpath: &str,
        is_imports: bool,
        cjs: bool,
    ) -> Option<Vec<PathBuf>> {
        // Build the subpath match object.
        let wrapped;
        let match_obj: &serde_json::Map<String, Value> = if is_imports {
            obj.as_object()?
        } else {
            let needs_wrap = match obj {
                Value::Object(m) => m.keys().next().is_none_or(|k| !k.starts_with('.')),
                _ => true,
            };
            if needs_wrap {
                wrapped = {
                    let mut m = serde_json::Map::new();
                    m.insert(".".to_string(), obj.clone());
                    m
                };
                &wrapped
            } else {
                obj.as_object()?
            }
        };

        // Exact subpath match.
        if let Some(entry) = match_obj.get(subpath) {
            if let Some(target) =
                get_exports_target(entry, self.opts.conditions, cjs, NODE_SUPPORTS_MODULE_SYNC)
            {
                if target.starts_with("./") {
                    let mut paths = vec![join_target(pkg_path, &target, None)];
                    self.add_module_sync(&mut paths, pkg_path, entry, cjs, None);
                    return self.validate_and_resolve_paths(&paths, cjs);
                }
                // A bare specifier in an `imports` map (e.g. `"#pkg": "pkg"`)
                // resolves as an external package.
                if is_imports && !target.starts_with('#') {
                    return self.resolve_package(&target, &pkg_path.join("package.json"), cjs);
                }
            }
        }

        // Wildcard / trailing-slash matches, longest key first.
        let mut keys: Vec<&String> = match_obj.keys().collect();
        keys.sort_by_key(|k| std::cmp::Reverse(k.len()));
        for key in keys {
            let entry = &match_obj[key];
            if key.ends_with('*') && subpath.starts_with(&key[..key.len() - 1]) {
                if let Some(target) =
                    get_exports_target(entry, self.opts.conditions, cjs, NODE_SUPPORTS_MODULE_SYNC)
                {
                    if target.starts_with("./") {
                        let replacement = &subpath[key.len() - 1..];
                        let mut paths = vec![join_target(pkg_path, &target, Some(replacement))];
                        if self.opts.module_sync_catchall {
                            self.add_module_sync(
                                &mut paths,
                                pkg_path,
                                entry,
                                cjs,
                                Some(replacement),
                            );
                        }
                        return self.validate_and_resolve_paths(&paths, cjs);
                    }
                }
            }
            if !key.ends_with('/') {
                continue;
            }
            if subpath.starts_with(key.as_str()) {
                if let Some(target) =
                    get_exports_target(entry, self.opts.conditions, cjs, NODE_SUPPORTS_MODULE_SYNC)
                {
                    if target.ends_with('/') && target.starts_with("./") {
                        let resolved = format!(
                            "{}{}{}",
                            pkg_path.to_string_lossy(),
                            &target[1..],
                            &subpath[key.len()..]
                        );
                        return self.validate_and_resolve_paths(&[PathBuf::from(resolved)], cjs);
                    }
                }
            }
        }
        None
    }

    /// Append the `module-sync` target and its fallback (nft over-traces both).
    fn add_module_sync(
        &self,
        paths: &mut Vec<PathBuf>,
        pkg_path: &Path,
        entry: &Value,
        cjs: bool,
        replacement: Option<&str>,
    ) {
        let Value::Object(map) = entry else { return };
        if !map.contains_key("module-sync") {
            return;
        }
        if !(NODE_SUPPORTS_MODULE_SYNC || self.opts.module_sync_catchall) {
            return;
        }
        if let Some(t) = get_exports_target(&map["module-sync"], self.opts.conditions, cjs, true) {
            push_unique(paths, join_target(pkg_path, &t, replacement));
        }
        let fallback = if cjs && map.contains_key("require") {
            "require"
        } else if !cjs && map.contains_key("import") {
            "import"
        } else {
            "default"
        };
        if let Some(v) = map.get(fallback) {
            if let Some(t) = get_exports_target(v, self.opts.conditions, cjs, false) {
                push_unique(paths, join_target(pkg_path, &t, replacement));
            }
        }
    }

    fn validate_and_resolve_paths(&mut self, paths: &[PathBuf], cjs: bool) -> Option<Vec<PathBuf>> {
        let mut out = Vec::new();
        for path in paths {
            if cjs {
                let resolved = self.resolve_file(path).or_else(|| self.resolve_dir(path))?;
                out.push(resolved);
            } else {
                if !path.is_file() {
                    return None;
                }
                out.push(path.clone());
            }
        }
        Some(out)
    }

    fn package_imports_resolve(
        &mut self,
        name: &str,
        parent: &Path,
        cjs: bool,
    ) -> Option<Vec<PathBuf>> {
        if name == "#" || name.starts_with("#/") {
            return None;
        }
        let boundary = pjson_boundary(parent)?;
        let cfg = get_pkg_cfg(&boundary)?;
        let imports = cfg.get("imports")?;
        if imports.is_null() {
            return None;
        }
        let resolved = self.resolve_exports_imports(&boundary, imports, name, true, cjs)?;
        self.res.emit_files.push(boundary.join("package.json"));
        Some(resolved)
    }

    fn resolve_package(&mut self, name: &str, parent: &Path, cjs: bool) -> Option<Vec<PathBuf>> {
        let pkg_name = get_pkg_name(name)?;
        let subpath = format!(".{}", &name[pkg_name.len()..]);

        // Package self-reference resolution.
        let mut self_resolved: Option<Vec<PathBuf>> = None;
        if let Some(boundary) = pjson_boundary(parent) {
            if let Some(cfg) = get_pkg_cfg(&boundary) {
                let name_matches = cfg.get("name").and_then(Value::as_str) == Some(pkg_name);
                if let (true, Some(exports)) =
                    (name_matches, cfg.get("exports").filter(|e| !e.is_null()))
                {
                    self_resolved =
                        self.resolve_exports_imports(&boundary, exports, &subpath, false, cjs);
                    if self_resolved.is_some() {
                        self.res.emit_files.push(boundary.join("package.json"));
                    }
                }
            }
        }

        // Walk up node_modules directories.
        let mut dir = parent.parent();
        while let Some(d) = dir {
            let node_modules = d.join("node_modules");
            if node_modules.is_dir() {
                let pkg_dir = node_modules.join(pkg_name);
                if let Some(cfg) = get_pkg_cfg(&pkg_dir) {
                    self.resolve_remappings(&pkg_dir, &cfg);
                    let exports = cfg.get("exports").filter(|e| !e.is_null());
                    if let (Some(exports), None) = (exports, &self_resolved) {
                        let legacy = if self.opts.exports_only {
                            None
                        } else {
                            let direct = node_modules.join(name);
                            self.resolve_file(&direct).or_else(|| self.resolve_dir(&direct))
                        };
                        if let Some(resolved) =
                            self.resolve_exports_imports(&pkg_dir, exports, &subpath, false, cjs)
                        {
                            self.res.emit_files.push(pkg_dir.join("package.json"));
                            if let Some(legacy) = legacy {
                                if !resolved.contains(&legacy) {
                                    let mut out = resolved;
                                    out.push(legacy);
                                    return Some(out);
                                }
                            }
                            return Some(resolved);
                        }
                        if let Some(legacy) = legacy {
                            return Some(vec![legacy]);
                        }
                    } else {
                        let direct = node_modules.join(name);
                        if let Some(resolved) =
                            self.resolve_file(&direct).or_else(|| self.resolve_dir(&direct))
                        {
                            return Some(combine_self(resolved, self_resolved));
                        }
                    }
                } else {
                    let direct = node_modules.join(name);
                    if let Some(resolved) =
                        self.resolve_file(&direct).or_else(|| self.resolve_dir(&direct))
                    {
                        return Some(combine_self(resolved, self_resolved));
                    }
                }
            }
            dir = d.parent();
        }

        if let Some(sr) = self_resolved {
            return Some(sr);
        }

        // `paths` option.
        for (key, target) in self.opts.paths {
            if key == name {
                return Some(vec![PathBuf::from(target)]);
            }
            if key.ends_with('/') && name.starts_with(key.as_str()) {
                let path_target = format!("{target}{}", &name[key.len()..]);
                let p = PathBuf::from(&path_target);
                if let Some(resolved) = self.resolve_file(&p).or_else(|| self.resolve_dir(&p)) {
                    return Some(vec![resolved]);
                }
            }
        }
        None
    }

    fn resolve_remappings(&mut self, pkg_dir: &Path, cfg: &Value) {
        if !self.opts.conditions.iter().any(|c| c == "browser") {
            return;
        }
        let Some(Value::Object(browser)) = cfg.get("browser") else { return };
        for (key, value) in browser {
            let Some(value) = value.as_str() else { continue };
            if !key.starts_with("./") || !value.starts_with("./") {
                continue;
            }
            let key_resolved = self.resolve_file(&join_target(pkg_dir, key, None));
            let value_resolved = self.resolve_file(&join_target(pkg_dir, value, None));
            if let (Some(k), Some(v)) = (key_resolved, value_resolved) {
                self.res.remappings.push((k, v));
            }
        }
    }
}

fn combine_self(resolved: PathBuf, self_resolved: Option<Vec<PathBuf>>) -> Vec<PathBuf> {
    if let Some(sr) = self_resolved {
        if !sr.contains(&resolved) {
            let mut out = vec![resolved];
            out.extend(sr);
            return out;
        }
        return sr;
    }
    vec![resolved]
}

/// `pkgPath + target.slice(1)`, with `*` replaced by `replacement`.
fn join_target(pkg_path: &Path, target: &str, replacement: Option<&str>) -> PathBuf {
    let tail = &target[1..]; // drop leading '.'
    let tail = match replacement {
        Some(r) => tail.replace('*', r),
        None => tail.to_string(),
    };
    PathBuf::from(format!("{}{tail}", pkg_path.to_string_lossy()))
}

fn push_unique(paths: &mut Vec<PathBuf>, p: PathBuf) {
    if !paths.contains(&p) {
        paths.push(p);
    }
}

/// Select an exports/imports target string by condition (port of
/// `getExportsTarget`). Object key order is significant (first match wins).
fn get_exports_target(
    value: &Value,
    conditions: &[String],
    cjs: bool,
    module_sync: bool,
) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        Value::Array(arr) => {
            for item in arr {
                if let Some(t) = get_exports_target(item, conditions, cjs, module_sync) {
                    if t.starts_with("./") {
                        return Some(t);
                    }
                }
            }
            None
        }
        Value::Object(map) => {
            for (condition, val) in map {
                if condition == "default"
                    || (condition == "require" && cjs)
                    || (condition == "import" && !cjs)
                    || (condition == "module-sync" && module_sync)
                    || conditions.iter().any(|c| c == condition)
                {
                    if let Some(t) = get_exports_target(val, conditions, cjs, module_sync) {
                        return Some(t);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn get_pkg_name(name: &str) -> Option<&str> {
    if name.is_empty() {
        return None;
    }
    if name.starts_with('@') {
        let mut it = name.match_indices('/');
        it.next();
        if let Some((idx, _)) = it.next() {
            Some(&name[..idx])
        } else {
            Some(name)
        }
    } else {
        Some(name.split('/').next().unwrap_or(name))
    }
}

fn get_pkg_cfg(dir: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Nearest ancestor directory of `path` containing a `package.json`.
fn pjson_boundary(path: &Path) -> Option<PathBuf> {
    let mut dir = path.parent()?;
    loop {
        if dir.join("package.json").is_file() {
            return Some(dir.to_path_buf());
        }
        match dir.parent() {
            Some(p) if p != dir => dir = p,
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A throwaway directory tree for resolution tests.
    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir().join(format!("nftrs_res_{}_{n}", std::process::id()));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn file(&self, rel: &str, contents: &str) -> &Self {
            let p = self.root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, contents).unwrap();
            self
        }

        fn resolve(&self, specifier: &str, parent_rel: &str, cjs: bool) -> Option<Vec<PathBuf>> {
            let conditions = vec!["node".to_string()];
            let opts = ResolveOpts {
                base: &self.root,
                ts: true,
                conditions: &conditions,
                exports_only: false,
                module_sync_catchall: false,
                paths: &[],
            };
            DepResolver::new()
                .resolve(specifier, &self.root.join(parent_rel), cjs, &opts)
                .ok()
                .map(|r| r.paths)
        }

        /// The single resolved path, relative to the fixture root (posix).
        fn resolve1(&self, specifier: &str, parent_rel: &str) -> Option<String> {
            let paths = self.resolve(specifier, parent_rel, true)?;
            let p = paths.first()?;
            Some(p.strip_prefix(&self.root).unwrap().to_string_lossy().replace('\\', "/"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn resolves_relative_file_with_extension() {
        let f = Fixture::new();
        f.file("a.js", "").file("main.js", "");
        assert_eq!(f.resolve1("./a", "main.js").as_deref(), Some("a.js"));
        assert_eq!(f.resolve1("./a.js", "main.js").as_deref(), Some("a.js"));
    }

    #[test]
    fn resolves_directory_index() {
        let f = Fixture::new();
        f.file("dir/index.js", "").file("main.js", "");
        assert_eq!(f.resolve1("./dir", "main.js").as_deref(), Some("dir/index.js"));
    }

    #[test]
    fn trailing_slash_prefers_directory_index() {
        let f = Fixture::new();
        // both `d.js` and `d/index.js` exist; trailing slash must pick the dir.
        f.file("d.js", "").file("d/index.js", "").file("main.js", "");
        assert_eq!(f.resolve1("./d", "main.js").as_deref(), Some("d.js"));
        assert_eq!(f.resolve1("./d/", "main.js").as_deref(), Some("d/index.js"));
    }

    #[test]
    fn js_specifier_maps_to_ts_source() {
        let f = Fixture::new();
        f.file("dep1.ts", "").file("main.js", "");
        assert_eq!(f.resolve1("./dep1.js", "main.js").as_deref(), Some("dep1.ts"));
    }

    #[test]
    fn extension_precedence_js_over_json() {
        let f = Fixture::new();
        f.file("a.js", "").file("a.json", "").file("main.js", "");
        // .ts/.tsx checked first under ts, then .js — here only .js/.json exist.
        assert_eq!(f.resolve1("./a", "main.js").as_deref(), Some("a.js"));
    }

    #[test]
    fn resolves_package_main() {
        let f = Fixture::new();
        f.file("node_modules/pkg/package.json", r#"{"name":"pkg","main":"lib/m.js"}"#)
            .file("node_modules/pkg/lib/m.js", "")
            .file("main.js", "");
        assert_eq!(f.resolve1("pkg", "main.js").as_deref(), Some("node_modules/pkg/lib/m.js"));
    }

    #[test]
    fn resolves_package_index_without_main() {
        let f = Fixture::new();
        f.file("node_modules/pkg/package.json", r#"{"name":"pkg"}"#)
            .file("node_modules/pkg/index.js", "")
            .file("main.js", "");
        assert_eq!(f.resolve1("pkg", "main.js").as_deref(), Some("node_modules/pkg/index.js"));
    }

    #[test]
    #[cfg(unix)]
    fn workspace_symlink_resolves_ts_main() {
        let f = Fixture::new();
        // packages/x has a `.ts` main; node_modules/x symlinks to it.
        f.file("packages/x/package.json", r#"{"main":"./main"}"#)
            .file("packages/x/main.ts", "")
            .file("main.js", "");
        std::fs::create_dir_all(f.root.join("node_modules")).unwrap();
        std::os::unix::fs::symlink(f.root.join("packages/x"), f.root.join("node_modules/x"))
            .unwrap();
        // The `.ts` main resolves through the symlink (core normalizes the `./`).
        let resolved = f.resolve1("x", "main.js").unwrap();
        assert!(resolved.starts_with("node_modules/x/") && resolved.ends_with("main.ts"));
    }

    #[test]
    fn builtin_resolves_to_empty() {
        let f = Fixture::new();
        f.file("main.js", "");
        assert_eq!(f.resolve("fs", "main.js", true), Some(vec![]));
        assert_eq!(f.resolve("node:path", "main.js", true), Some(vec![]));
    }

    #[test]
    fn missing_module_errors() {
        let f = Fixture::new();
        f.file("main.js", "");
        assert_eq!(f.resolve("./nope", "main.js", true), None);
    }

    #[test]
    fn is_builtin_recognizes_node_prefix() {
        assert!(is_builtin("fs"));
        assert!(is_builtin("node:fs"));
        assert!(is_builtin("node:test"));
        assert!(!is_builtin("express"));
        assert!(!is_builtin("./local"));
    }
}
