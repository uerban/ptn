use pt_producer::pass1::{compute_trip_starts, run_pass1, Pass1Result};
use pt_producer::source::extract_zip;
use std::path::PathBuf;

fn fixture_zip() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip")
}

#[test]
fn trip_starts_prefix_sum_matches_fixture() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r: Pass1Result = run_pass1(tmp.path()).unwrap();

    let starts = compute_trip_starts(&r);

    // Length is num_trips + 1.
    assert_eq!(starts.len(), r.trips.len() + 1);
    // First entry is always zero.
    assert_eq!(starts[0], 0);
    // Monotonic non-decreasing.
    for w in starts.windows(2) {
        assert!(w[1] >= w[0], "trip_starts must be non-decreasing");
    }
    // Final entry equals total_stop_times.
    assert_eq!(*starts.last().unwrap(), r.total_stop_times);

    // Per-trip slice width equals that trip's known stop_times count.
    // The tiny fixture has 4 trips (T1..T4), each with 3 stop_times rows.
    for trip in ["T1", "T2", "T3", "T4"] {
        let i = r.trips.lookup(trip).unwrap() as usize;
        let width = starts[i + 1] - starts[i];
        assert_eq!(width, r.stop_times_per_trip[i], "slice width for {trip}");
        assert_eq!(width, 3, "fixture trip {trip} has 3 stop_times rows");
    }
}

#[test]
fn trip_starts_widths_equal_post_finalize_counts() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r: Pass1Result = run_pass1(tmp.path()).unwrap();

    let starts = compute_trip_starts(&r);
    // Reconstruct counts from the prefix sum and compare against the
    // sorted-indexed count vector element-for-element.
    let reconstructed: Vec<u32> = starts.windows(2).map(|w| w[1] - w[0]).collect();
    assert_eq!(reconstructed, r.stop_times_per_trip);
}
