use pt_producer::pass1::{run_pass1, run_pass1_union, Pass1Result};
use pt_producer::source::{extract_all, extract_zip};
use std::path::PathBuf;

fn fixture_zip() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip")
}

#[test]
fn pass1_intern_and_counts_match_fixture() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r: Pass1Result = run_pass1(tmp.path()).unwrap();
    assert_eq!(r.stops.len(), 3);
    assert_eq!(r.routes.len(), 2);
    assert_eq!(r.trips.len(), 4);
    assert_eq!(r.total_stop_times, 12);
    let t1 = r.trips.lookup("T1").unwrap() as usize;
    assert_eq!(r.stop_times_per_trip[t1], 3);
    let t4 = r.trips.lookup("T4").unwrap() as usize;
    assert_eq!(r.stop_times_per_trip[t4], 3);
}

#[test]
fn pass1_union_sums_counts_across_feeds_and_dedupes_interned_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let zips = vec![fixture_zip(), fixture_zip(), fixture_zip()];
    let feed_dirs = extract_all(&zips, tmp.path()).unwrap();
    let r = run_pass1_union(&feed_dirs).unwrap();

    // Same key set in each feed → interner stays at the deduped size.
    assert_eq!(r.stops.len(), 3);
    assert_eq!(r.routes.len(), 2);
    assert_eq!(r.trips.len(), 4);
    // Each fixture contributes 12 stop_times rows, so the union is 3 × 12 = 36.
    assert_eq!(r.total_stop_times, 36);
    let t1 = r.trips.lookup("T1").unwrap() as usize;
    assert_eq!(r.stop_times_per_trip[t1], 9);
}

#[test]
fn pass1_union_empty_returns_config_error() {
    let r = run_pass1_union(&[]);
    assert!(r.is_err());
}

#[test]
fn pass1_union_single_feed_matches_run_pass1() {
    let tmp = tempfile::tempdir().unwrap();
    let zips = vec![fixture_zip()];
    let feed_dirs = extract_all(&zips, tmp.path()).unwrap();
    let r = run_pass1_union(&feed_dirs).unwrap();
    assert_eq!(r.total_stop_times, 12);
}
