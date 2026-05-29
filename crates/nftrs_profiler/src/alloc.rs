//! Counting global allocator.
//!
//! `CountingAllocator` wraps `std::alloc::System` and records every
//! allocation/deallocation through atomic counters. The counters are
//! process-global, so a scoped measurement uses a snapshot/delta pair rather
//! than try to reset shared state.
//!
//! The instrumentation can be globally disabled (e.g. while the profiler
//! itself is allocating its report) by calling [`CountingAllocator::enable`]
//! / [`CountingAllocator::disable`]. Disabled allocations still flow through
//! `System`; they just don't update the counters.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

const SIZE_CLASS_BUCKETS: usize = 32;

#[allow(unsafe_code)]
struct GlobalStats {
    enabled: AtomicBool,
    allocations: AtomicU64,
    deallocations: AtomicU64,
    bytes_allocated: AtomicU64,
    bytes_deallocated: AtomicU64,
    current_live_bytes: AtomicU64,
    peak_live_bytes: AtomicU64,
    largest_single_alloc: AtomicU64,
    size_class_buckets: [AtomicU64; SIZE_CLASS_BUCKETS],
}

impl GlobalStats {
    const fn new() -> Self {
        // Manually expand the array since `[AtomicU64::new(0); N]` requires
        // `Copy` which atomics intentionally don't implement.
        Self {
            enabled: AtomicBool::new(false),
            allocations: AtomicU64::new(0),
            deallocations: AtomicU64::new(0),
            bytes_allocated: AtomicU64::new(0),
            bytes_deallocated: AtomicU64::new(0),
            current_live_bytes: AtomicU64::new(0),
            peak_live_bytes: AtomicU64::new(0),
            largest_single_alloc: AtomicU64::new(0),
            size_class_buckets: [
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
            ],
        }
    }
}

static STATS: GlobalStats = GlobalStats::new();

/// Counting wrapper around the system allocator.
///
/// Install with `#[global_allocator]`; call [`CountingAllocator::enable`] from
/// `main` before the profiled workload starts. Counters use relaxed atomics
/// because we only need monotonic visibility, not ordering with other memory.
pub struct CountingAllocator;

impl CountingAllocator {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Begin recording allocation events. Idempotent.
    pub fn enable() {
        STATS.enabled.store(true, Ordering::Release);
    }

    /// Stop recording allocation events. Existing counters keep their value.
    pub fn disable() {
        STATS.enabled.store(false, Ordering::Release);
    }

    /// Returns whether the allocator is currently recording events.
    #[must_use]
    pub fn is_enabled() -> bool {
        STATS.enabled.load(Ordering::Acquire)
    }
}

impl Default for CountingAllocator {
    fn default() -> Self {
        Self::new()
    }
}

// SAFETY: We forward every allocation/deallocation to `System` without
// modifying the returned pointer or the requested layout. The atomic
// bookkeeping is independent of allocator correctness; even if every counter
// were poisoned, allocation behavior would still be sound. Layout invariants
// (alignment, size) are preserved because we delegate verbatim.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: `layout` is a caller-provided valid `Layout`; `System`
        // upholds the `GlobalAlloc` contract for it.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() && STATS.enabled.load(Ordering::Relaxed) {
            record_alloc(layout.size() as u64);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if STATS.enabled.load(Ordering::Relaxed) {
            record_dealloc(layout.size() as u64);
        }
        // SAFETY: caller guarantees `ptr` came from this allocator with the
        // matching `layout`. We pass both through unchanged.
        unsafe { System.dealloc(ptr, layout) };
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: same as `alloc` above; `System` handles the zeroing.
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() && STATS.enabled.load(Ordering::Relaxed) {
            record_alloc(layout.size() as u64);
        }
        ptr
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // We model realloc as a dealloc of the old layout + alloc of the new
        // size. This double-counts a single OS-level operation but keeps the
        // accounting symmetric with explicit alloc/dealloc patterns, which is
        // what users tend to reason about.
        // SAFETY: caller guarantees `ptr`/`layout` match and `new_size` is
        // valid for the inferred new layout; `System` handles the rest.
        let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
        if !new_ptr.is_null() && STATS.enabled.load(Ordering::Relaxed) {
            record_dealloc(layout.size() as u64);
            record_alloc(new_size as u64);
        }
        new_ptr
    }
}

#[inline]
fn record_alloc(size: u64) {
    STATS.allocations.fetch_add(1, Ordering::Relaxed);
    STATS.bytes_allocated.fetch_add(size, Ordering::Relaxed);
    let live = STATS.current_live_bytes.fetch_add(size, Ordering::Relaxed) + size;

    // Peak tracking via CAS loop. Under contention we may miss the absolute
    // peak by a few bytes between concurrent threads, which is acceptable for
    // a profiler — we are not trying to compete with jemalloc's accuracy.
    let mut peak = STATS.peak_live_bytes.load(Ordering::Relaxed);
    while live > peak {
        match STATS.peak_live_bytes.compare_exchange_weak(
            peak,
            live,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(observed) => peak = observed,
        }
    }

    let mut largest = STATS.largest_single_alloc.load(Ordering::Relaxed);
    while size > largest {
        match STATS.largest_single_alloc.compare_exchange_weak(
            largest,
            size,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(observed) => largest = observed,
        }
    }

    let bucket = size_class_bucket(size);
    STATS.size_class_buckets[bucket].fetch_add(1, Ordering::Relaxed);
}

#[inline]
fn record_dealloc(size: u64) {
    STATS.deallocations.fetch_add(1, Ordering::Relaxed);
    STATS.bytes_deallocated.fetch_add(size, Ordering::Relaxed);
    // Live bytes can wrap if events are observed out of order between
    // threads; saturating subtract keeps the gauge non-negative.
    let mut cur = STATS.current_live_bytes.load(Ordering::Relaxed);
    loop {
        let next = cur.saturating_sub(size);
        match STATS.current_live_bytes.compare_exchange_weak(
            cur,
            next,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(observed) => cur = observed,
        }
    }
}

#[inline]
fn size_class_bucket(size: u64) -> usize {
    // Bucket by floor(log2(size)). Bucket 0 catches size 0 (rare but legal),
    // bucket 1 catches sizes 1..=1, bucket k catches sizes [2^(k-1), 2^k).
    if size == 0 {
        return 0;
    }
    let log2 = (u64::BITS - 1 - size.leading_zeros()) as usize;
    log2.min(SIZE_CLASS_BUCKETS - 1) + usize::from(size > 1)
}

/// Instantaneous snapshot of allocator counters.
#[derive(Debug, Clone)]
pub struct AllocSnapshot {
    pub allocations: u64,
    pub deallocations: u64,
    pub bytes_allocated: u64,
    pub bytes_deallocated: u64,
    pub current_live_bytes: u64,
    pub peak_live_bytes: u64,
    pub largest_single_alloc: u64,
    pub size_class_buckets: [u64; SIZE_CLASS_BUCKETS],
}

impl AllocSnapshot {
    #[must_use]
    pub fn capture() -> Self {
        let mut buckets = [0u64; SIZE_CLASS_BUCKETS];
        for (i, slot) in STATS.size_class_buckets.iter().enumerate() {
            buckets[i] = slot.load(Ordering::Relaxed);
        }
        Self {
            allocations: STATS.allocations.load(Ordering::Relaxed),
            deallocations: STATS.deallocations.load(Ordering::Relaxed),
            bytes_allocated: STATS.bytes_allocated.load(Ordering::Relaxed),
            bytes_deallocated: STATS.bytes_deallocated.load(Ordering::Relaxed),
            current_live_bytes: STATS.current_live_bytes.load(Ordering::Relaxed),
            peak_live_bytes: STATS.peak_live_bytes.load(Ordering::Relaxed),
            largest_single_alloc: STATS.largest_single_alloc.load(Ordering::Relaxed),
            size_class_buckets: buckets,
        }
    }

    /// Compute the change between `before` and `self` (`self` is the later
    /// observation).
    #[must_use]
    pub fn delta_from(&self, before: &Self) -> AllocDelta {
        let mut buckets = [0u64; SIZE_CLASS_BUCKETS];
        for (i, slot) in buckets.iter_mut().enumerate() {
            *slot = self.size_class_buckets[i].saturating_sub(before.size_class_buckets[i]);
        }
        AllocDelta {
            allocations: self.allocations.saturating_sub(before.allocations),
            deallocations: self.deallocations.saturating_sub(before.deallocations),
            bytes_allocated: self.bytes_allocated.saturating_sub(before.bytes_allocated),
            bytes_deallocated: self.bytes_deallocated.saturating_sub(before.bytes_deallocated),
            // Peak above baseline: how much higher did the peak go vs. the
            // peak at snapshot time? This is the closest single-counter
            // approximation to "max additional live bytes during the scope"
            // without resetting shared state.
            peak_above_baseline: self.peak_live_bytes.saturating_sub(before.peak_live_bytes),
            ending_live_bytes: self.current_live_bytes,
            starting_live_bytes: before.current_live_bytes,
            largest_single_alloc: self.largest_single_alloc.max(before.largest_single_alloc),
            size_class_buckets: SizeHistogram { buckets },
        }
    }
}

/// Difference between two [`AllocSnapshot`]s.
#[derive(Debug, Clone)]
pub struct AllocDelta {
    pub allocations: u64,
    pub deallocations: u64,
    pub bytes_allocated: u64,
    pub bytes_deallocated: u64,
    /// Max additional live bytes observed during the window.
    pub peak_above_baseline: u64,
    pub starting_live_bytes: u64,
    pub ending_live_bytes: u64,
    pub largest_single_alloc: u64,
    pub size_class_buckets: SizeHistogram,
}

impl AllocDelta {
    /// Net change in live bytes (ending - starting). Can be negative-looking
    /// when more was freed than allocated; returns saturating signed-ish u64
    /// for simplicity. Use [`AllocDelta::net_growth`] for clarity.
    #[must_use]
    pub fn net_growth(&self) -> i128 {
        i128::from(self.ending_live_bytes) - i128::from(self.starting_live_bytes)
    }
}

/// Histogram of allocations bucketed by power-of-two size class.
#[derive(Debug, Clone)]
pub struct SizeHistogram {
    pub buckets: [u64; SIZE_CLASS_BUCKETS],
}

impl SizeHistogram {
    /// Returns the human-readable label for bucket `i`, e.g. `"32..64"`.
    #[must_use]
    pub fn bucket_label(i: usize) -> String {
        if i == 0 {
            return "0".into();
        }
        if i == 1 {
            return "1".into();
        }
        let lo = 1u64 << (i - 1);
        let hi = 1u64 << i.min(63);
        format!("{lo}..{hi}")
    }

    /// Iterates `(label, count)` pairs, skipping empty buckets.
    pub fn iter_nonempty(&self) -> impl Iterator<Item = (String, u64)> + '_ {
        self.buckets
            .iter()
            .enumerate()
            .filter(|(_, c)| **c > 0)
            .map(|(i, c)| (Self::bucket_label(i), *c))
    }
}

/// Convenience guard: takes a baseline snapshot on construction, exposes the
/// running delta until dropped. Useful for ad-hoc scope measurements outside
/// of [`crate::Recorder`].
pub struct AllocCounter {
    baseline: AllocSnapshot,
}

impl AllocCounter {
    #[must_use]
    pub fn start() -> Self {
        Self { baseline: AllocSnapshot::capture() }
    }

    #[must_use]
    pub fn delta(&self) -> AllocDelta {
        AllocSnapshot::capture().delta_from(&self.baseline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // We can't safely install ourselves as the global allocator in these
    // tests (the cfg is per-binary), but we can still exercise the snapshot
    // arithmetic and the bucket layout.

    #[test]
    fn bucket_layout_covers_typical_sizes() {
        let mut hist = SizeHistogram { buckets: [0; SIZE_CLASS_BUCKETS] };
        for &size in &[0u64, 1, 2, 7, 16, 17, 64, 1024, 4096, 65_536] {
            let b = size_class_bucket(size);
            hist.buckets[b] += 1;
        }
        let count = hist.iter_nonempty().count();
        assert!(count > 0);
    }

    #[test]
    fn delta_handles_no_change() {
        let snap = AllocSnapshot::capture();
        let delta = snap.delta_from(&snap);
        assert_eq!(delta.allocations, 0);
        assert_eq!(delta.bytes_allocated, 0);
        assert_eq!(delta.net_growth(), 0);
    }
}
