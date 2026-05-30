//! Criterion benchmark for `node_file_trace` over a representative subset of
//! the `test/unit` fixtures that `nftrs` matches against `@vercel/nft`.
//!
//! The fixtures are chosen to exercise diverse code paths: `import.meta.url`
//! asset references, glob wildcards, webpack-wrapped modules, `fs` asset
//! detection (including `fs-extra` / `graceful-fs`), multi-entry tracing,
//! bundled browserify output, and `package.json` assets.
//!
//! Option wiring mirrors `compat/run.mjs` so the benchmark measures the same
//! work the compat harness verifies.

use std::path::{Path, PathBuf};

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use nftrs_core::{node_file_trace, TraceOptions};

/// Fixtures benchmarked. Each tuple is `(name, entry file names)`.
const FIXTURES: &[(&str, &[&str])] = &[
    ("import-meta-url", &["input.js"]),
    ("wildcard", &["input.js"]),
    ("webpack-wrapper", &["input.js"]),
    ("asset-fs-extra", &["input.js"]),
    ("asset-fs-inlining", &["input.js"]),
    ("multi-input", &["input.js", "input-2.js", "input-3.js", "input-4.js"]),
    ("browserify", &["input.js"]),
    ("asset-graceful-fs", &["input.js"]),
    ("asset-package-json", &["input.js"]),
    ("class-static", &["input.js"]),
];

/// Locate the repository root (the workspace dir that contains `test/unit`).
fn repo_root() -> PathBuf {
    // `CARGO_MANIFEST_DIR` is `<root>/crates/nftrs_core`.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.ancestors().nth(2).expect("workspace root").to_path_buf()
}

/// Build `TraceOptions` matching the compat harness wiring.
fn opts(root: &Path, unit_dir: &Path, name: &str) -> TraceOptions<'static> {
    let mut base = root.to_path_buf().into_os_string();
    base.push("/");
    TraceOptions {
        base: PathBuf::from(base),
        process_cwd: unit_dir.join(name),
        depth: None,
        ts: true,
        analysis: true,
        conditions: vec!["node".to_string()],
        exports_only: false,
        module_sync_catchall: false,
        paths: vec![
            (
                "dep".to_string(),
                unit_dir.join("esm-paths/esm-dep.js").to_string_lossy().into_owned(),
            ),
            (
                "dep/".to_string(),
                unit_dir.join("esm-paths-trailer/").to_string_lossy().into_owned(),
            ),
        ],
        resolve: None,
        ignore: None,
    }
}

fn bench_trace(c: &mut Criterion) {
    let root = repo_root();
    let unit_dir = root.join("test").join("unit");

    let mut group = c.benchmark_group("node_file_trace");
    for (name, entries) in FIXTURES {
        let fixture_dir = unit_dir.join(name);
        assert!(fixture_dir.is_dir(), "fixture {name} missing at {}", fixture_dir.display());
        let files: Vec<PathBuf> = entries.iter().map(|e| fixture_dir.join(e)).collect();
        let options = opts(&root, &unit_dir, name);

        // Sanity: ensure the trace produces output (a real workload).
        let result = node_file_trace(&files, &options);
        assert!(!result.file_list.is_empty(), "fixture {name} produced no files");

        group.bench_with_input(BenchmarkId::from_parameter(name), name, |b, _| {
            b.iter(|| {
                let r =
                    node_file_trace(std::hint::black_box(&files), std::hint::black_box(&options));
                std::hint::black_box(r);
            });
        });
    }
    group.finish();
}

criterion_group!(benches, bench_trace);
criterion_main!(benches);
