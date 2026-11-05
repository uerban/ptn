//! CLI shape + local-feed-record handoff for `periodic-refresh --gtfs <path>
//! [--gtfs <path>] ...`. The actual `pass1::run_pass1_union` correctness over
//! multi-feed input is exercised separately (deferred to the city-shaped
//! differential fixtures follow-up — see
//! the staging cities p4 review followups notes).

use pt_producer::download::record_for_local;
use std::path::PathBuf;
use tempfile::tempdir;

fn write_minimal_gtfs_zip(dir: &std::path::Path, name: &str) -> PathBuf {
    use std::io::Write;
    use zip::write::FileOptions;
    let path = dir.join(name);
    let f = std::fs::File::create(&path).unwrap();
    let mut zw = zip::ZipWriter::new(f);
    let opts: FileOptions<'_, '_, ()> = FileOptions::default();
    // `record_for_local` opens the zip and computes its sha256; it does not
    // parse GTFS contents. agency.txt + stops.txt is enough to produce a
    // valid zip with distinct bytes per feed (via the per-zip `name`).
    zw.start_file("agency.txt", opts).unwrap();
    zw.write_all(b"agency_id,agency_name,agency_url,agency_timezone\nA,A,http://a,Europe/Warsaw\n")
        .unwrap();
    zw.start_file("stops.txt", opts).unwrap();
    let stops = format!("stop_id,stop_name,stop_lat,stop_lon\n{name}_S,{name}_stop,52.0,21.0\n");
    zw.write_all(stops.as_bytes()).unwrap();
    zw.finish().unwrap();
    path
}

#[test]
fn three_feed_record_for_local_preserves_order_and_paths() {
    let tmp = tempdir().unwrap();
    let z1 = write_minimal_gtfs_zip(tmp.path(), "feed1.zip");
    let z2 = write_minimal_gtfs_zip(tmp.path(), "feed2.zip");
    let z3 = write_minimal_gtfs_zip(tmp.path(), "feed3.zip");

    let feed_records: Vec<_> = [z1, z2, z3]
        .iter()
        .map(|p| record_for_local(p).expect("record_for_local"))
        .collect();
    assert_eq!(feed_records.len(), 3);

    // Sanity: distinct paths preserved in order.
    assert!(feed_records[0].zip_path.ends_with("feed1.zip"));
    assert!(feed_records[1].zip_path.ends_with("feed2.zip"));
    assert!(feed_records[2].zip_path.ends_with("feed3.zip"));
}

#[test]
fn periodic_refresh_cli_accepts_multiple_gtfs() {
    use clap::Parser;
    use pt_producer::cli::{Args, Command};

    let args = Args::try_parse_from([
        "pt-producer",
        "periodic-refresh",
        "--data-root",
        "/tmp/dr",
        "--city",
        "krakow",
        "--gtfs",
        "/opt/gtfs/krakow-0.zip",
        "--gtfs",
        "/opt/gtfs/krakow-1.zip",
        "--gtfs",
        "/opt/gtfs/krakow-2.zip",
    ])
    .expect("parse should succeed");

    match args.command {
        Some(Command::PeriodicRefresh { gtfs, .. }) => {
            assert_eq!(gtfs.len(), 3, "expected 3 --gtfs paths, got {}", gtfs.len());
            assert!(gtfs[0].ends_with("krakow-0.zip"));
            assert!(gtfs[1].ends_with("krakow-1.zip"));
            assert!(gtfs[2].ends_with("krakow-2.zip"));
        }
        other => panic!("expected PeriodicRefresh, got {other:?}"),
    }
}
