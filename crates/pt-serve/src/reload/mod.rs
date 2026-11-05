//! Reload runner — the dedicated thread that observes SIGHUP/SIGTERM, validates a candidate
//! generation off the disk, and swaps it under `ArcSwap<Generation>`.
//!
//! - [`signals`]  — typed signal iterator (rev 3 — replaces the `low_level::pipe`
//!   approach so SIGHUP and SIGTERM are distinguishable).
//! - [`runner`]   — the reload state machine + pending-reload latch.
//! - [`test_barrier`] (feature-gated) — `std::sync::Barrier` between
//!   validation and swap for the deterministic coalescing test.
//! - [`park_test`] (feature-gated) — `/test/park` endpoint for the parked-handler
//!   tests (Stage 2).
//!
//! Stage 1 lands `signals` + `runner` and wires them into `main.rs`. Stage 2
//! adds `test_barrier` and `park_test` behind feature flags.

pub mod poll;
pub mod runner;
pub mod signals;
pub mod test_barrier;

pub use runner::{ReloadOutcome, ReloadRunner};
pub use test_barrier::ReloadBarrier;
