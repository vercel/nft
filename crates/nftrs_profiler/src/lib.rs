//! Profiling primitives for nftrs.
//!
//! This crate is intentionally small and dependency-free. It provides three
//! independent layers that can be combined or used in isolation:
//!
//! 1. [`CountingAllocator`] — a `#[global_allocator]`-compatible wrapper around
//!    `std::alloc::System` that atomically records allocation count,
//!    deallocation count, bytes in/out, peak live bytes, and a power-of-two
//!    size-class histogram. Scope a measurement with [`AllocCounter`].
//! 2. [`scope::span`] / [`scope::ScopeGuard`] — thread-local hierarchical
//!    timing spans with self/inclusive time aggregation and per-span allocation
//!    delta capture. Driven through the [`profile_span!`] macro so that hot
//!    paths can opt in without paying for a function-call/closure when the
//!    profile feature is disabled at the call site.
//! 3. [`Report`] — formatting helpers for both human-readable tables and
//!    machine-readable output, suitable for plumbing through CI or the
//!    interactive CLI in `nftrs_profile_cli`.
//!
//! The three layers compose: when you wrap a workload in a [`Recorder`] you
//! get a [`Report`] that fuses span timings with the allocator deltas observed
//! across the same window.
//!
//! # Example
//!
//! ```no_run
//! use nftrs_profiler::{CountingAllocator, Recorder};
//!
//! #[global_allocator]
//! static GLOBAL: CountingAllocator = CountingAllocator::new();
//!
//! fn main() {
//!     let mut recorder = Recorder::new("parse-only");
//!     recorder.record(|| {
//!         nftrs_profiler::profile_span!("setup");
//!         // ...workload...
//!     });
//!     let report = recorder.finish();
//!     println!("{}", report.render_table());
//! }
//! ```

#![deny(unsafe_op_in_unsafe_fn)]
#![allow(clippy::module_name_repetitions)]
// The profiler is intentionally lossy with floating-point math (percentiles,
// MB/s, histogram bar widths) and uses `as` casts between u64 / u128 / f64.
// The values being cast represent observed counters and timings — none of
// them need bit-exact preservation, so the precision and truncation lints
// would just push us toward verbose conversions that obscure intent.
#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation, clippy::cast_sign_loss)]

pub mod alloc;
pub mod report;
pub mod scope;

pub use alloc::{AllocCounter, AllocDelta, AllocSnapshot, CountingAllocator, SizeHistogram};
pub use report::{IterationRecord, Report, ReportConfig, SpanAggregate};
pub use scope::{ScopeGuard, ScopeRecord, SpanRegistry};

/// Drive a workload through the profiler.
///
/// Wraps a single measurement window. Construct once per logical workload
/// (e.g. "parse + render"), feed it iterations through [`Recorder::record`],
/// then call [`Recorder::finish`] to produce a [`Report`].
pub struct Recorder {
    label: String,
    iterations: Vec<IterationRecord>,
    config: ReportConfig,
}

impl Recorder {
    #[must_use]
    pub fn new(label: impl Into<String>) -> Self {
        Self { label: label.into(), iterations: Vec::new(), config: ReportConfig::default() }
    }

    #[must_use]
    pub fn with_config(mut self, config: ReportConfig) -> Self {
        self.config = config;
        self
    }

    /// Run a single iteration of the workload, capturing alloc + span deltas.
    ///
    /// Returns whatever the closure returned, so callers can inspect or
    /// black-box the result. Spans collected during the closure are merged
    /// into the iteration record.
    pub fn record<R>(&mut self, mut f: impl FnMut() -> R) -> R {
        let before = AllocSnapshot::capture();
        scope::reset_thread_spans();
        let start = std::time::Instant::now();
        let output = f();
        let elapsed = start.elapsed();
        let after = AllocSnapshot::capture();
        let spans = scope::take_thread_spans();
        self.iterations.push(IterationRecord { elapsed, allocs: after.delta_from(&before), spans });
        output
    }

    /// Consume the recorder and produce a [`Report`].
    #[must_use]
    pub fn finish(self) -> Report {
        Report::from_iterations(self.label, self.iterations, self.config)
    }
}

/// Open a scoped timing span tied to a `'static` label.
///
/// Expands to a guard binding so the span is closed at the end of the
/// enclosing block. When the profile feature is not in use, the macro still
/// compiles to a no-cost RAII guard that records nothing — see
/// [`scope::ScopeGuard::is_active`] for the runtime gate.
#[macro_export]
macro_rules! profile_span {
    ($name:literal) => {
        let __nftrs_profile_guard = $crate::ScopeGuard::enter($name);
    };
    ($name:literal, $($rest:tt)*) => {
        let __nftrs_profile_guard = $crate::ScopeGuard::enter($name);
        $($rest)*
    };
}
