//! Routing differential: Off vs Unbounded PatternMode.
//!
//! Verifies that the configured PatternMode reaches Index::build and changes
//! routing: Off → the off-canonical branch stop s3 is unreachable; Unbounded
//! → the branch pattern serves it. transfers = None so footpath relaxation
//! can't mask the difference (that relaxation IS the regret bug this flip
//! fixes). Topology + query lifted from the proven pt-core test at
//! crates/pt-core/src/engine/project.rs:484.
//!
//! ## MUST 2 routing test strategy
//!
//! The test tries `Generation::from_paths` (the pt-serve seam) first.
//! `from_paths` is test-only but does call `Index::build` with the given
//! `pattern_mode` — it is a thinner seam than the production
//! `build_generation`, which additionally runs metadata validation,
//! tz-cross-check, DPIX load, etc. The production seam (main.rs →
//! build_generation → Index::build) is guarded by the server-level
//! `ready_reports_unbounded_when_configured` test in tests/server.rs, which
//! boots the real pt-serve binary. This test adds a library-level routing
//! differential via the `from_paths` seam so a revert of the Index::build
//! mode threading would fail in BOTH tests.

use pt_core::engine::testkit::build_two_trip_ptb;
use pt_core::{plan, Index, Mobility, PatternMode, Query, Reader, ScanState, StopWalk};

// ---- helpers shared by both test strategies ----

/// Build the branch-topology PTB bytes.
///
/// 5 stops; trip0 LOCAL [s0,s1,s2,s4]; trip1 BRANCH [s0,s1,s3,s4] (via s3).
fn branch_ptb_bytes() -> Vec<u8> {
    build_two_trip_ptb(
        5,
        &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)], // LOCAL
        &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)], // BRANCH via s3
    )
}

/// The query: s3 (branch stop) → s4, dep 28700, date 20260505.
fn branch_query() -> Query {
    Query {
        excluded_routes: Default::default(),
        entry_stops: vec![StopWalk {
            stop: 3,
            walk_secs: 0,
        }], // s3 (branch stop)
        exit_stops: vec![StopWalk {
            stop: 4,
            walk_secs: 0,
        }], // s4
        departure_secs: 28700,
        date: 20260505,
        max_rounds: None,
        mobility: Mobility::Default,
        excluded_modes: vec![],
        walk_speed_mm_s: None,
        min_transfer_secs: None,
    }
}

// ---- MUST 2: route via Generation::from_paths (pt-serve seam) ----

/// Write `bytes` to a named tempfile and return the tempfile handle (keeps the
/// file alive on disk).
fn write_temp_ptb(bytes: &[u8]) -> tempfile::NamedTempFile {
    use std::io::Write as _;
    let mut f = tempfile::Builder::new()
        .suffix(".ptb")
        .tempfile()
        .expect("create temp ptb");
    f.write_all(bytes).expect("write temp ptb");
    f.flush().expect("flush temp ptb");
    f
}

/// Route to the branch stop through `pt_serve::Generation::from_paths`, which
/// calls `Index::build(&reader, pattern_mode)` internally. This is a
/// library-level guard of the pt-serve wiring: reverting the mode threading
/// inside `from_paths` (or inside `Index::build`) would flip Off result to 0
/// under both modes and fail this test.
///
/// NOTE: The production seam (`main.rs` → `build_generation` →
/// `Index::build` at handle.rs:212) is separately guarded by the
/// `ready_reports_unbounded_when_configured` test in tests/server.rs, which
/// boots the real binary. Both guards together ensure the mode is threaded
/// all the way from the CLI flag to the engine.
fn itineraries_to_branch_via_from_paths(mode: PatternMode) -> usize {
    let bytes = branch_ptb_bytes();
    let tmp = write_temp_ptb(&bytes);

    let gen = pt_serve::Generation::from_paths(tmp.path(), None, "test".to_string(), mode)
        .expect("Generation::from_paths must succeed on build_two_trip_ptb fixture");

    let mut st = ScanState::default();
    let query = branch_query();
    plan(&gen.reader, &gen.index, None, &mut st, &query)
        .unwrap()
        .len()
}

#[test]
fn off_cannot_route_to_branch_stop_but_unbounded_can_via_from_paths() {
    assert_eq!(
        itineraries_to_branch_via_from_paths(PatternMode::Off),
        0,
        "Off: s3 (branch stop) is unroutable under the canonical-only index (from_paths seam)"
    );
    assert_eq!(
        itineraries_to_branch_via_from_paths(PatternMode::Unbounded),
        1,
        "Unbounded: s3 reachable via the branch pattern (from_paths seam)"
    );
}

// ---- Original direct pt_core::Index::build differential (kept for defence
// in depth; from_paths is the primary pt-serve seam guard above) ----

fn itineraries_to_branch_direct(mode: PatternMode) -> usize {
    let bytes = branch_ptb_bytes();
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, mode).unwrap();
    let mut st = ScanState::default();
    let query = branch_query();
    plan(&reader, &index, None, &mut st, &query).unwrap().len()
}

#[test]
fn off_cannot_route_to_branch_stop_but_unbounded_can() {
    assert_eq!(
        itineraries_to_branch_direct(PatternMode::Off),
        0,
        "Off: s3 (branch stop) is unroutable under the canonical-only index"
    );
    assert_eq!(
        itineraries_to_branch_direct(PatternMode::Unbounded),
        1,
        "Unbounded: s3 reachable via the branch pattern"
    );
}
