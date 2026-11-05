//! Stage-C C2c: pt-serve mmaps the `departures-idx.bin` (DPIX) sidecar into the
//! `Generation`, recomputes the bundle's Trips/Stops interner SHAs at load, and
//! enforces a NON-OPTIONAL namespace-SHA cross-check on a present DPIX.
//!
//! These tests drive the production `build_generation` path (manifest present)
//! and assert:
//!   1. Positive — a gen dir with a VALID DPIX (built against the bundle's own
//!      interning) loads: `departures_idx_mmap.is_some()`, and the recomputed
//!      `dpix_trips_sha`/`dpix_stops_sha` equal the DPIX header's SHAs.
//!   2. Negative — a DPIX with a deliberately-wrong `tripsInternSha256` is a
//!      HARD load error (`ProducerError::DeparturesIdxInvalid`).
//!   3. Absent — a gen dir with NO DPIX loads OK, `departures_idx_mmap.is_none()`
//!      (degraded, never an error).
//!
//! The committed `tiny.ptb` has `feedStartDate=20260501`; the publisher
//! writes no `cityTzIana`, so the resolved IANA — and hence `city_tz` — comes
//! from the `--city-tz-iana-default` we pass below ("Europe/Vilnius").

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

#[path = "common/mod.rs"]
mod common;

use common::publisher::{self, SidecarArtifacts};
use pt_serve::bundle::{build_generation, BuildInputs};
use pt_serve::{Generation, Metrics};
use pt_shared::clock::{Clock, MockClock};
use pt_shared::manifest::GenerationManifest;
use pt_shared::validate::errors::{ProducerError, ValidationError};

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

// A clock anchored well after the fixture's feed_start_date so the metadata
// validator's createdAt skew tolerance accepts the manifest timestamp.
const ANCHOR_UNIX: u64 = 1779494400;

fn anchored_clock() -> Arc<MockClock> {
    Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR_UNIX),
    ))
}

fn build_from_published(
    data_root: &std::path::Path,
    city: &str,
    id: &str,
    clock: &dyn Clock,
) -> Result<Generation, ValidationError> {
    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(data_root, id)).unwrap();
    let manifest: GenerationManifest = serde_json::from_str(&manifest_text).unwrap();
    build_generation(BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(data_root, id),
        transfers_path: None,
        expected_city: city,
        clock,
        is_startup: true,
        epoch: 0,
        metrics: Some(Metrics::new()),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
}

#[test]
fn loads_valid_departures_idx_and_recomputed_shas_match_header() {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    let dpix = publisher::encode_test_departures_idx(&tiny_ptb_path());
    let artifacts = SidecarArtifacts {
        departures_idx: Some(dpix.clone()),
        ..Default::default()
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );

    let gen = build_from_published(data_root.path(), "vilnius", &id, clock.as_ref())
        .expect("generation with a valid DPIX loads");

    assert!(
        gen.departures_idx_mmap.is_some(),
        "valid departures-idx.bin must be mmapped onto the Generation"
    );

    // The DPIX header SHAs (what the producer committed) must equal the SHAs
    // pt-serve recomputed from the bundle interner at load.
    let header =
        pt_shared::sidecar::parse_sidecar_header(&dpix, pt_shared::sidecar::DEPARTURES_IDX_MAGIC)
            .expect("DPIX header parses");
    assert_eq!(
        gen.dpix_trips_sha, header.trips_intern_sha256,
        "recomputed trips SHA must equal the DPIX header trips SHA"
    );
    assert_eq!(
        gen.dpix_stops_sha, header.stops_intern_sha256,
        "recomputed stops SHA must equal the DPIX header stops SHA"
    );

    // The city tz resolved from the --city-tz-iana-default.
    assert_eq!(gen.city_tz_iana, "Europe/Vilnius");
    assert!(
        gen.city_tz.is_some(),
        "the bundle should resolve a Jiff TimeZone for the loopback handler"
    );
}

#[test]
fn wrong_namespace_sha_is_a_hard_load_error() {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    // A structurally-valid DPIX whose tripsInternSha256 does NOT match the
    // bundle. The publisher records the SHA of THESE bytes, so the (future)
    // full-file SHA check would pass — isolating the failure to the namespace
    // cross-check inside DeparturesIdx::parse.
    let dpix = publisher::encode_test_departures_idx_wrong_trips_sha(&tiny_ptb_path());
    let artifacts = SidecarArtifacts {
        departures_idx: Some(dpix),
        ..Default::default()
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );

    // `Generation` is not `Debug`, so match the Result manually.
    match build_from_published(data_root.path(), "vilnius", &id, clock.as_ref()) {
        Ok(_) => panic!("a present-but-inconsistent DPIX must REJECT the generation at load"),
        Err(ValidationError::Producer(ProducerError::DeparturesIdxInvalid { reason })) => {
            assert!(
                reason.contains("namespace SHA mismatch") && reason.contains("trips"),
                "error should name the namespace-SHA mismatch on trips, got: {reason}"
            );
        }
        Err(other) => panic!("expected ProducerError::DeparturesIdxInvalid, got {other:?}"),
    }
}

#[test]
fn wrong_full_file_sha_is_a_hard_load_error() {
    // Publish a VALID DPIX (namespace SHAs correct), then tamper the
    // manifest's recorded `departuresIdxSha256` to a value that cannot
    // match any real file. This forces the full-file SHA gate (added in
    // Fix C) to fire BEFORE DeparturesIdx::parse, proving the load-reject
    // path is wired end-to-end.
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    // Publish with the genuinely-correct DPIX so the file is on-disk.
    let dpix = publisher::encode_test_departures_idx(&tiny_ptb_path());
    let artifacts = SidecarArtifacts {
        departures_idx: Some(dpix),
        ..Default::default()
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );

    // Now overwrite the manifest's `departuresIdxSha256` with a known-wrong
    // value (64 zeroes). The file bytes on disk are unchanged (valid), so
    // the ONLY thing that can fail is the full-file SHA check.
    let manifest_path = publisher::manifest_path_for(data_root.path(), &id);
    let manifest_text = std::fs::read_to_string(&manifest_path).unwrap();
    let mut manifest_json: serde_json::Value = serde_json::from_str(&manifest_text).unwrap();
    manifest_json["departuresIdxSha256"] = serde_json::Value::String("0".repeat(64));
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest_json).unwrap(),
    )
    .unwrap();

    match build_from_published(data_root.path(), "vilnius", &id, clock.as_ref()) {
        Ok(_) => panic!(
            "a DPIX whose manifest SHA doesn't match the file must REJECT the generation at load"
        ),
        Err(ValidationError::Producer(ProducerError::DeparturesIdxInvalid { reason })) => {
            assert!(
                reason.contains("full-file SHA mismatch"),
                "error should describe the full-file SHA mismatch, got: {reason}"
            );
        }
        Err(other) => panic!("expected ProducerError::DeparturesIdxInvalid, got {other:?}"),
    }
}

#[test]
fn absent_departures_idx_loads_degraded() {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    // publish_generation writes NO sidecars (and no departuresIdxSha256).
    let id =
        publisher::publish_generation(data_root.path(), "vilnius", &tiny_ptb_path(), &created_at);

    let gen = build_from_published(data_root.path(), "vilnius", &id, clock.as_ref())
        .expect("generation with no DPIX still loads (degraded)");

    assert!(
        gen.departures_idx_mmap.is_none(),
        "absent departures-idx.bin => None (degraded), must not be a load error"
    );
    // The recomputed SHAs are still populated even with no DPIX present.
    assert_ne!(
        gen.dpix_trips_sha, [0u8; 32],
        "recomputed trips SHA is populated regardless of DPIX presence"
    );
}
