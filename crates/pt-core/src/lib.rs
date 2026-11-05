#![no_std]
//! `pt-core` — `.ptb` reader + RAPTOR engine (P2). `no_std` + alloc.
//!
//! Reads the routing bundle from any `&[u8]` (an mmap in `pt-serve`, a wasm
//! linear-memory buffer in `pt-wasm`). Mirrors the canonical TS reader
//! `packages/shared/src/ptb/loader.ts` — that file's offsets/validation are
//! the spec. No `std`, no platform deps.

extern crate alloc;

pub mod coord_quant;
pub mod engine;
pub mod error;
pub mod header;
pub mod pattern_emit;
pub mod projection;
pub mod reader;
pub mod records;
pub mod region_ids;
pub mod soa_emit;
pub mod stop_index;
pub mod stop_time_cursor;
pub mod strip_regions;
pub mod strpool;
pub mod transfers;
pub mod v2;
pub mod validate;
pub mod window;

pub use error::{PtbError, Result};
pub use reader::{FrequencyRecord, Reader};
// `strip_regions` carry-teardown util (B1.5): re-exported at the crate root so the
// producer calls `pt_core::strip_regions(buf, &[ids])` directly. The module
// (type namespace) and the function (value namespace) coexist under this name.
pub use strip_regions::{rewrite_regions, strip_regions, RegionEdit};

// P2 RAPTOR engine — the P3/P5 handoff surface. Re-exported from the
// crate root so hosts link `pt_core::plan` / `pt_core::project` etc. without
// reaching into modules.
pub use engine::{
    plan, plan_with_abort, project, EngineError, Index, IndexRoute, Itinerary, Leg, LegKind,
    Mobility, PatternMode, ProjectedItinerary, ProjectedLeg, ProjectedTransitLeg, ProjectedWalkLeg,
    Query, RouteTrip, ScanState, StopWalk,
};
pub use transfers::{Transfers, TransfersError};

/// Hard upper bound on a derived `windowDays` (see `window::derive_window_days`).
/// Caps the per-service bitmask stride at `ceil(400/8) = 50` bytes.
pub const WINDOW_HARD_CEILING: u16 = 400;
/// Safety margin (days) added to a feed's service horizon before clamping, so a
/// service that runs right up to the last horizon day still has a covered tail.
pub const WINDOW_MARGIN_DAYS: i64 = 14;
/// Lower bound on a derived `windowDays` — a short or stale feed never shrinks
/// the window below the historical 90-day baseline.
pub const WINDOW_MIN_FLOOR: u16 = 90;
/// The `windowDays` assumed when the `0x01 WindowMeta` region is absent
/// (matches the historical fixed 90-day service window).
pub const WINDOW_DEFAULT_DAYS: u16 = 90;

/// Bytes per service bitmask for a given window length = `ceil(window_days / 8)`.
#[inline]
pub const fn bytes_per_service(window_days: u16) -> usize {
    (window_days as usize).div_ceil(8)
}
pub const PTB_HEADER_BYTES: usize = 4096;
pub const PTB_MAGIC: [u8; 4] = [0x50, 0x54, 0x42, 0x00]; // "PTB\0"
/// The PTB format version the producer publishes and pt-serve advertises
/// (the sentinel's exact capability). Readers accept it and
/// [`PTB_VERSION_V1`]; every other version fails closed. Kept as a bare
/// literal: CI workflows read it with a `pub const PTB_VERSION: u16 = <n>` grep.
pub const PTB_VERSION: u16 = 2;
/// PTB version 1: frozen legacy transfer, frequency and wall-clock semantics.
/// Still read, and used for the v1 compatibility lane and committed fixtures.
pub const PTB_VERSION_V1: u16 = 1;
/// PTB version 2: GTFS noon-minus-12 service-day origins (`0x18`), the block
/// derivation commitment (`0x19`), the v1 compatibility-artifact commitment
/// (`0x1A`), absent-stop linked-trip transfer rows and the full six-tier
/// transfer resolver. Design:
pub const PTB_VERSION_V2: u16 = 2;

/// Header `featureFlags` bit0: the feed carries GTFS-Flex data.
pub const FEATURE_HAS_FLEX: u16 = 1 << 0;
/// Header `featureFlags` bit1: the feed carries GTFS-Fares data.
pub const FEATURE_HAS_FARES: u16 = 1 << 1;
/// Header `featureFlags` bit2 (PTB v2 only): `DERIVE_BLOCK_INSEAT`. The sole
/// activation authority for date-gated `block_id` in-seat derivation in every
/// `Index::build`; derivation uses the frozen 120-second maximum layover.
pub const FEATURE_DERIVE_BLOCK_INSEAT: u16 = 1 << 2;
/// Every global feature bit a v2 reader understands. A v2 bundle setting any
/// other bit fails closed; v1 keeps its historical (unchecked) interpretation.
pub const FEATURE_FLAGS_KNOWN_V2: u16 =
    FEATURE_HAS_FLEX | FEATURE_HAS_FARES | FEATURE_DERIVE_BLOCK_INSEAT;
