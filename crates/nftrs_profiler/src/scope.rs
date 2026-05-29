//! Thread-local hierarchical timing spans.
//!
//! The span machinery is driven exclusively through [`ScopeGuard::enter`]:
//! call it to push a frame, drop the guard to pop. Each frame remembers its
//! parent's accumulated child-time so that on close we can split inclusive
//! time (wall clock between enter and drop) from self time (inclusive minus
//! the sum of child inclusive times).
//!
//! All state lives in a `thread_local!` cell so spans never need a lock on
//! the hot path. Pull the per-iteration tree out with [`take_thread_spans`]
//! between iterations; flush with [`reset_thread_spans`] before starting one.
//!
//! The runtime gate ([`enable`] / [`disable`]) is a single relaxed `AtomicBool`
//! lookup per `enter`/`drop`, which is cheap enough to leave on the hot path
//! even at default-disabled. When disabled, [`ScopeGuard`] becomes a
//! zero-state marker.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::alloc::{AllocCounter, AllocDelta};

static ENABLED: AtomicBool = AtomicBool::new(false);

/// Globally enable span recording. Spans entered while disabled are no-ops.
pub fn enable() {
    ENABLED.store(true, Ordering::Release);
}

/// Globally disable span recording. Already-open guards keep working but
/// record nothing on drop.
pub fn disable() {
    ENABLED.store(false, Ordering::Release);
}

/// Whether the span subsystem is currently recording.
#[must_use]
pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Acquire)
}

thread_local! {
    static STATE: RefCell<SpanState> = const { RefCell::new(SpanState::new()) };
}

/// Per-thread span state. Open frames live on `stack`; closed frames are
/// merged into `records` keyed by the span name.
struct SpanState {
    stack: Vec<Frame>,
    records: Vec<ScopeRecord>,
}

impl SpanState {
    const fn new() -> Self {
        Self { stack: Vec::new(), records: Vec::new() }
    }
}

struct Frame {
    name: &'static str,
    start: Instant,
    child_time: Duration,
    alloc_baseline: AllocCounter,
}

/// RAII guard for a timing span. Construct via [`ScopeGuard::enter`].
pub struct ScopeGuard {
    /// `true` if we pushed a frame; `false` when the subsystem was disabled
    /// at `enter` time and we should be a no-op on drop.
    active: bool,
}

impl ScopeGuard {
    /// Push a new frame onto the thread-local stack.
    ///
    /// The label MUST be `'static` so the registry can use it as a key
    /// without copying.
    #[inline]
    pub fn enter(name: &'static str) -> Self {
        if !is_enabled() {
            return Self { active: false };
        }
        STATE.with(|cell| {
            // Borrow may already be held if a Drop impl re-enters us; in that
            // case we silently degrade rather than panic.
            let Ok(mut state) = cell.try_borrow_mut() else {
                return;
            };
            state.stack.push(Frame {
                name,
                start: Instant::now(),
                child_time: Duration::ZERO,
                alloc_baseline: AllocCounter::start(),
            });
        });
        Self { active: true }
    }

    /// Whether this guard is recording. False if the subsystem was disabled
    /// when this guard was created (the common no-op case).
    #[must_use]
    pub fn is_active(&self) -> bool {
        self.active
    }
}

impl Drop for ScopeGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        STATE.with(|cell| {
            let Ok(mut state) = cell.try_borrow_mut() else {
                return;
            };
            let Some(frame) = state.stack.pop() else {
                return;
            };
            let inclusive = frame.start.elapsed();
            let self_time = inclusive.saturating_sub(frame.child_time);
            let alloc_delta = frame.alloc_baseline.delta();

            // Bubble inclusive time up to the parent's child accumulator so
            // when the parent closes, its self_time excludes this child.
            if let Some(parent) = state.stack.last_mut() {
                parent.child_time += inclusive;
            }

            merge_record(&mut state.records, frame.name, inclusive, self_time, &alloc_delta);
        });
    }
}

fn merge_record(
    records: &mut Vec<ScopeRecord>,
    name: &'static str,
    inclusive: Duration,
    self_time: Duration,
    alloc: &AllocDelta,
) {
    if let Some(slot) = records.iter_mut().find(|r| r.name == name) {
        slot.hits += 1;
        slot.total_inclusive += inclusive;
        slot.total_self += self_time;
        slot.total_allocs += alloc.allocations;
        slot.total_bytes += alloc.bytes_allocated;
        if alloc.peak_above_baseline > slot.max_peak_above_baseline {
            slot.max_peak_above_baseline = alloc.peak_above_baseline;
        }
        return;
    }
    records.push(ScopeRecord {
        name,
        hits: 1,
        total_inclusive: inclusive,
        total_self: self_time,
        total_allocs: alloc.allocations,
        total_bytes: alloc.bytes_allocated,
        max_peak_above_baseline: alloc.peak_above_baseline,
    });
}

/// Aggregated record for all hits of a named span within one iteration.
#[derive(Debug, Clone)]
pub struct ScopeRecord {
    pub name: &'static str,
    pub hits: u64,
    pub total_inclusive: Duration,
    pub total_self: Duration,
    pub total_allocs: u64,
    pub total_bytes: u64,
    pub max_peak_above_baseline: u64,
}

/// Drain the current thread's recorded spans, returning them.
#[must_use]
pub fn take_thread_spans() -> Vec<ScopeRecord> {
    STATE.with(|cell| {
        let Ok(mut state) = cell.try_borrow_mut() else {
            return Vec::new();
        };
        std::mem::take(&mut state.records)
    })
}

/// Clear the current thread's records without returning them.
pub fn reset_thread_spans() {
    STATE.with(|cell| {
        if let Ok(mut state) = cell.try_borrow_mut() {
            state.records.clear();
            // Leave any open frames alone; the caller is responsible for not
            // having an open span when starting a new iteration.
        }
    });
}

/// Open a span using a static label and an arbitrary block.
///
/// This is the function-style equivalent of [`crate::profile_span!`] for
/// callers that find the macro inconvenient (e.g. when returning from inside
/// the span). Returns whatever `f` returns.
pub fn span<R>(name: &'static str, f: impl FnOnce() -> R) -> R {
    let _guard = ScopeGuard::enter(name);
    f()
}

/// Registry view used by the report. Owns no state itself; constructed on
/// demand from a list of per-iteration [`ScopeRecord`]s.
#[derive(Debug, Default)]
pub struct SpanRegistry {
    pub records: Vec<ScopeRecord>,
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// `enable()` / `disable()` write to a process-wide `AtomicBool`, but
    /// `cargo test` runs unit tests in parallel by default. Without this
    /// lock the three tests below would race: e.g. `disabled_spans_are_noops`
    /// could flip the gate off while `span_records_self_and_inclusive_time`
    /// was mid-`span("outer", ...)`, producing an empty records list and
    /// a flaky "outer recorded" panic. Serialize them through one mutex so
    /// they observe the gate state they set themselves.
    static GATE: Mutex<()> = Mutex::new(());

    #[test]
    fn span_records_self_and_inclusive_time() {
        let _guard = GATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        enable();
        reset_thread_spans();

        span("outer", || {
            std::thread::sleep(Duration::from_millis(2));
            span("inner", || {
                std::thread::sleep(Duration::from_millis(5));
            });
        });

        let records = take_thread_spans();
        let outer = records.iter().find(|r| r.name == "outer").expect("outer recorded");
        let inner = records.iter().find(|r| r.name == "inner").expect("inner recorded");

        // Outer inclusive >= inner inclusive; outer self ≈ outer inclusive
        // minus inner inclusive. We use generous bounds because timing is
        // jittery in CI.
        assert!(outer.total_inclusive >= inner.total_inclusive);
        assert!(outer.total_self < outer.total_inclusive);
        assert_eq!(outer.hits, 1);
        assert_eq!(inner.hits, 1);

        disable();
    }

    #[test]
    fn disabled_spans_are_noops() {
        let _guard = GATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        disable();
        reset_thread_spans();

        let guard = ScopeGuard::enter("ghost");
        assert!(!guard.is_active());
        drop(guard);

        assert!(take_thread_spans().is_empty());
    }

    #[test]
    fn repeated_hits_accumulate() {
        let _guard = GATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        enable();
        reset_thread_spans();

        for _ in 0..3 {
            span("loop_body", || {
                std::thread::sleep(Duration::from_millis(1));
            });
        }

        let records = take_thread_spans();
        let loop_body = records.iter().find(|r| r.name == "loop_body").unwrap();
        assert_eq!(loop_body.hits, 3);

        disable();
    }
}
