use pt_producer::source::{extract_all, extract_zip};
use std::path::PathBuf;

fn fixture_zip() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip")
}

#[test]
fn extract_zip_writes_seven_csvs_into_target_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let written = extract_zip(&fixture_zip(), tmp.path()).unwrap();
    assert_eq!(written.len(), 7);
    for name in [
        "agency.txt",
        "calendar.txt",
        "calendar_dates.txt",
        "routes.txt",
        "stops.txt",
        "stop_times.txt",
        "trips.txt",
    ] {
        assert!(tmp.path().join(name).exists(), "missing {name}");
    }
}

#[test]
fn extract_all_creates_one_subdir_per_zip() {
    let tmp = tempfile::tempdir().unwrap();
    let zips = vec![fixture_zip(), fixture_zip(), fixture_zip()];
    let feed_dirs = extract_all(&zips, tmp.path()).unwrap();
    assert_eq!(feed_dirs.len(), 3);
    for (i, dir) in feed_dirs.iter().enumerate() {
        assert_eq!(dir.file_name().unwrap(), format!("feed-{i}").as_str());
        assert!(dir.join("stop_times.txt").exists());
    }
}
