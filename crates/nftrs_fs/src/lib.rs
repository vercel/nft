//! Cached filesystem layer for nftrs.
//!
//! Ports the caching/realpath responsibilities of `src/fs.ts` and the
//! `getPjsonBoundary` helper from `src/node-file-trace.ts`. Symlink-aware
//! `realpath` is still a lexical normalization for now (no symlink resolution)
//! — see <https://github.com/ubugeeei-prod/nftrs/issues/10>.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

/// Caching wrapper over the real filesystem. Single-threaded for now
/// (`RefCell`), matching the synchronous napi entry point.
#[derive(Default)]
pub struct CachedFs {
    files: RefCell<HashMap<PathBuf, Option<String>>>,
    is_file: RefCell<HashMap<PathBuf, bool>>,
}

impl CachedFs {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Read a file to a string, caching the result (including misses).
    pub fn read_to_string(&self, path: &Path) -> Option<String> {
        if let Some(v) = self.files.borrow().get(path) {
            return v.clone();
        }
        let v = std::fs::read_to_string(path).ok();
        self.files.borrow_mut().insert(path.to_path_buf(), v.clone());
        v
    }

    /// Whether `path` is a regular file, cached.
    pub fn is_file(&self, path: &Path) -> bool {
        if let Some(v) = self.is_file.borrow().get(path) {
            return *v;
        }
        let v = path.is_file();
        self.is_file.borrow_mut().insert(path.to_path_buf(), v);
        v
    }

    /// Walk up from `path`'s directory to (but not including) the filesystem
    /// root, returning the nearest ancestor directory that contains a
    /// `package.json`. Ports `Job.getPjsonBoundary`.
    pub fn pjson_boundary(&self, path: &Path) -> Option<PathBuf> {
        let mut dir = path.parent()?;
        loop {
            if self.is_file(&dir.join("package.json")) {
                return Some(dir.to_path_buf());
            }
            match dir.parent() {
                Some(parent) if parent != dir => dir = parent,
                _ => return None,
            }
        }
    }
}

/// Lexically normalize a path: make components canonical (resolve `.` and
/// `..`) without touching the filesystem or resolving symlinks.
#[must_use]
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve the real path of `path`. Currently a lexical normalization; symlink
/// resolution and in-base symlink emission land with #10.
#[must_use]
pub fn realpath(path: &Path) -> PathBuf {
    normalize(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use compact_str::format_compact;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    fn tmpdir() -> PathBuf {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir()
            .join(format_compact!("nftrs_fs_{}_{n}", std::process::id()).as_str());
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn normalize_collapses_segments() {
        assert_eq!(normalize(Path::new("/a/b/../c")), PathBuf::from("/a/c"));
        assert_eq!(normalize(Path::new("/a/./b")), PathBuf::from("/a/b"));
        assert_eq!(normalize(Path::new("/a/b/../../d")), PathBuf::from("/d"));
    }

    #[test]
    fn read_to_string_caches_and_reads() {
        let d = tmpdir();
        let p = d.join("f.txt");
        std::fs::write(&p, "hello").unwrap();
        let fs = CachedFs::new();
        assert_eq!(fs.read_to_string(&p).as_deref(), Some("hello"));
        // second read hits the cache and still returns the same content
        assert_eq!(fs.read_to_string(&p).as_deref(), Some("hello"));
        assert_eq!(fs.read_to_string(&d.join("missing")), None);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn is_file_detects_files_and_dirs() {
        let d = tmpdir();
        let p = d.join("a.js");
        std::fs::write(&p, "").unwrap();
        let fs = CachedFs::new();
        assert!(fs.is_file(&p));
        assert!(!fs.is_file(&d));
        assert!(!fs.is_file(&d.join("nope")));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn pjson_boundary_finds_nearest() {
        let d = tmpdir();
        std::fs::create_dir_all(d.join("a/b")).unwrap();
        std::fs::write(d.join("a/package.json"), "{}").unwrap();
        let fs = CachedFs::new();
        let boundary = fs.pjson_boundary(&d.join("a/b/c.js"));
        assert_eq!(boundary, Some(d.join("a")));
        std::fs::remove_dir_all(&d).ok();
    }
}
