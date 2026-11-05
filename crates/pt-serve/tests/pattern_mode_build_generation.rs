//! Production seam guard: `build_generation` threads `pattern_mode` to
//! `Index::build`.
//!
//! ## What this test guards
//!
//! `handle.rs:212` is the line that matters:
//!
//! ```text
//! let index = Index::build(&reader, inputs.pattern_mode)
//! ```
//!
//! Reverting that to `Index::build(&reader, PatternMode::Off)` silently
//! breaks the production routing: `/ready` would still say "unbounded" (the
//! field is set at handle.rs:386), but every planning query would run in
//! Off mode.  The tests in `pattern_mode_routing.rs` do NOT catch this
//! because they go through `Generation::from_paths`, which is test-only and
//! NOT the path that runs in production.  This test goes through the REAL
//! production builder (`build_generation`) and asserts that a query to the
//! branch stop returns 0 itineraries under Off and 1 under Unbounded.
//!
//! ## Why we patch `city_tz_offset_seconds`
//!
//! `build_two_trip_ptb` writes `city_tz_offset_seconds = 0` (UTC).
//! `build_generation` runs a v5 city-tz cross-check that compares that
//! field against `pt_shared::tz::offset_at_anchor(iana, feed_start_date)`.
//! For `Europe/Vilnius` at `20260501` (EEST) the expected offset is
//! `10800 s`.  Patching bytes [28..32] to `10800` makes the fixture honest
//! for a Vilnius city; it does NOT weaken validation.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_core::engine::testkit::build_two_trip_ptb;
use pt_core::{plan, Mobility, PatternMode, Query, ScanState, StopWalk};
use pt_serve::bundle::{build_generation, BuildInputs};
use pt_shared::clock::MockClock;
use pt_shared::manifest::GenerationManifest;
use std::io::Write as _;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// Build the branch-topology PTB bytes, patching `city_tz_offset_seconds` to
/// 10800 so `build_generation`'s v5 tz cross-check passes under
/// `Europe/Vilnius` (EEST = UTC+3 at `feedStartDate = 20260501`).
fn branch_ptb_bytes_vilnius() -> Vec<u8> {
    let mut bytes = build_two_trip_ptb(
        5,
        &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)], // LOCAL
        &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)], // BRANCH via s3
    );
    // Patch cityTzOffsetSeconds @[28..32] from 0 (UTC, the testkit default) to
    // 10800 (EEST, Europe/Vilnius at feedStartDate=20260501).  The structural
    // validator ignores this field; only the tz cross-check in build_generation
    // reads it, so this patch is safe and makes the fixture coherent.
    bytes[28..32].copy_from_slice(&10800i32.to_le_bytes());
    bytes
}

/// The query: s3 (branch stop) → s4, dep 28700, date 20260505.
fn branch_query() -> Query {
    Query {
        excluded_routes: Default::default(),
        entry_stops: vec![StopWalk {
            stop: 3,
            walk_secs: 0,
        }],
        exit_stops: vec![StopWalk {
            stop: 4,
            walk_secs: 0,
        }],
        departure_secs: 28700,
        date: 20260505,
        max_rounds: None,
        mobility: Mobility::Default,
        excluded_modes: vec![],
        walk_speed_mm_s: None,
        min_transfer_secs: None,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Publish the given bytes into a fresh `TempDir` using the same publisher
/// layout `seed_data_root` uses, and return `(TempDir, path-to-bundle.ptb,
/// GenerationManifest)`.  The `TempDir` must be kept alive by the caller.
fn publish_bytes(
    bytes: &[u8],
    city: &str,
    created_at: &str,
) -> (TempDir, std::path::PathBuf, GenerationManifest) {
    let dir = TempDir::new().expect("tempdir");
    // Write bytes to a named temp file so publish_generation can read it.
    let mut src = tempfile::Builder::new()
        .suffix(".ptb")
        .tempfile_in(dir.path())
        .expect("source temp ptb");
    src.write_all(bytes).expect("write source ptb");
    src.flush().expect("flush source ptb");
    let src_path = src.path().to_path_buf();

    let id = publisher::publish_generation(dir.path(), city, &src_path, created_at);
    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(dir.path(), &id)).unwrap();
    let manifest: GenerationManifest = serde_json::from_str(&manifest_text).unwrap();
    let bundle_path = publisher::bundle_path_for(dir.path(), &id);
    (dir, bundle_path, manifest)
}

// ---------------------------------------------------------------------------
// Core helper: route to the branch stop via build_generation
// ---------------------------------------------------------------------------

/// Call `build_generation` with the given `pattern_mode` over the Vilnius
/// branch fixture, then issue the branch-stop query and return the itinerary
/// count.
///
/// This is the production seam: it goes through `build_generation` →
/// `Index::build(&reader, inputs.pattern_mode)` (handle.rs:212).  Reverting
/// that line to a hard-coded `PatternMode::Off` makes this function return 0
/// for BOTH modes, failing the Unbounded assertion below.
fn itineraries_to_branch_via_build_generation(mode: PatternMode) -> usize {
    // Use a clock anchored well in the past so the createdAt skew check
    // passes (startup tolerance is 300 s; we set both clock and created_at
    // to the same epoch second so skew = 0).
    let now_secs: u64 = 1_779_494_400; // 2026-05-07T00:00:00Z (arbitrary)
    let created_at = publisher::rfc3339_format(now_secs);
    let clock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(now_secs),
    ));

    let bytes = branch_ptb_bytes_vilnius();
    let (_dir, bundle_path, manifest) = publish_bytes(&bytes, "vilnius", &created_at);

    let metrics = pt_serve::Metrics::new();
    let gen = build_generation(BuildInputs {
        manifest: &manifest,
        bundle_path: &bundle_path,
        transfers_path: None,
        expected_city: "vilnius",
        clock: clock.as_ref(),
        is_startup: true,
        city_tz_iana_default: Some("Europe/Vilnius"),
        epoch: 0,
        metrics: Some(Arc::clone(&metrics)),
        pattern_mode: mode,
    })
    .unwrap_or_else(|e| {
        panic!(
            "build_generation failed with mode={mode:?}: {e:?}\n\
             (BLOCKED: if this is a tz/validate_metadata rejection, \
             see task Fallback instructions)"
        )
    });

    let mut st = ScanState::default();
    let query = branch_query();
    plan(&gen.reader, &gen.index, None, &mut st, &query)
        .unwrap()
        .len()
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

/// MUST 2b — Production build_generation seam guard.
///
/// Asserts that `build_generation` (handle.rs) threads `pattern_mode` through
/// to `Index::build` (handle.rs:212): Off → branch stop s3 is unreachable;
/// Unbounded → s3 is routable.
///
/// RED check: temporarily revert handle.rs:212 to
/// `Index::build(&reader, PatternMode::Off)` → this test must FAIL (the
/// Unbounded branch returns 0 instead of 1).
#[test]
fn off_unroutable_unbounded_routable_via_build_generation() {
    assert_eq!(
        itineraries_to_branch_via_build_generation(PatternMode::Off),
        0,
        "Off: s3 (branch stop) must be unroutable through the production build_generation seam"
    );
    assert_eq!(
        itineraries_to_branch_via_build_generation(PatternMode::Unbounded),
        1,
        "Unbounded: s3 must be reachable via the branch pattern through the production \
         build_generation seam (FAIL here = handle.rs:212 reverted to Off)"
    );
}
