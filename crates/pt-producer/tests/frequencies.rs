//! End-to-end `frequencies.txt` build round-trip: real GTFS feed dir → producer
//! `build_ptb` → PTB bytes → `pt_core::Reader` decode.
//!
//! This is the Phase-A integration oracle that closes the gap between:
//! - A2 unit tests (parser in isolation, via `parse_frequencies` + `run_pass1`)
//! - A3 unit tests (emit with hand-passed rows / hand-constructed bundles in
//!   `current_emit.rs`)
//! - A4/A5 TS decoder + cross-parity tests (over committed `.ptb` fixtures)
//!
//! These tests drive the FULL chain: `frequencies.txt` on disk → `build_ptb`
//! (which calls `parse_frequencies` and appends the current Frequencies region)
//! → the produced `.ptb` bytes → `pt_core::Reader` decode via
//! `has_frequencies()` / `frequencies_for_trip()`.
//!
//! A fixed `--anchor-date 20260501` keeps the golden stable (the bitmask anchor
//! controls only the service-window byte layout, not frequencies). The two-trip,
//! three-row feed is deterministic: T1/T2 sort alphabetically → trip_idx 0/1,
//! so the golden bytes are stable across re-runs.
//!
//! Golden convention (same as `sidecars.rs`): `REGEN_GOLDEN=1 cargo test
//! --features csv-mmap frequencies` to capture; re-run without the
//! env to pin.

use pt_producer::build::build_ptb;
use pt_producer::cli::DeriveInseat;
use pt_producer::download::record_for_local;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::FileOptions;

const ANCHOR_DATE: u32 = 20260501;

/// Write a minimal GTFS feed into `dir` (uncompressed CSV files) including
/// a `frequencies.txt` with the given content.
///
/// Two trips (T1, T2) on route R1, service WD. Both trips have stop_times
/// (required by Pass 1 to populate the trips interner before
/// `parse_frequencies` resolves `trip_id → trip_idx`). The stop_times are
/// frequency-based placeholders — they are present to satisfy the parser's
/// trip-intern requirement; the actual departure pattern comes from frequencies.
///
/// Stops sort lexically → S1 (idx 0), S2 (idx 1).
/// Trips sort lexically → T1 (idx 0), T2 (idx 1).
fn write_feed(dir: &Path) {
    std::fs::write(
        dir.join("stops.txt"),
        "stop_id,stop_name,stop_lat,stop_lon\n\
         S1,Stop One,54.69,25.28\n\
         S2,Stop Two,54.70,25.30\n",
    )
    .unwrap();
    std::fs::write(dir.join("routes.txt"), "route_id,route_type\nR1,3\n").unwrap();
    std::fs::write(
        dir.join("calendar.txt"),
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
         WD,1,1,1,1,1,0,0,20260501,20260801\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("trips.txt"),
        "route_id,service_id,trip_id\n\
         R1,WD,T1\n\
         R1,WD,T2\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stop_times.txt"),
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         T1,05:00:00,05:00:00,S1,1\n\
         T1,05:10:00,05:10:00,S2,2\n\
         T2,06:00:00,06:00:00,S1,1\n\
         T2,06:15:00,06:15:00,S2,2\n",
    )
    .unwrap();
    // frequencies.txt: mdb-1162 shape.
    //
    // T1: two windows —
    //   daytime  05:00:00–23:50:01 headway 600s  exact_times 0
    //   overnight 00:00:00–05:00:03 headway 900s exact_times 1
    // T2: one window —
    //   06:00:00–21:00:00 headway 1800s exact_times 0
    //
    // After sort-by-(trip_idx, start_secs):
    //   row 0: T1 idx 0  start=0       end=18003  headway=900  exact=1
    //   row 1: T1 idx 0  start=18000   end=85801  headway=600  exact=0
    //   row 2: T2 idx 1  start=21600   end=75600  headway=1800 exact=0
    std::fs::write(
        dir.join("frequencies.txt"),
        "trip_id,start_time,end_time,headway_secs,exact_times\n\
         T1,05:00:00,23:50:01,600,0\n\
         T1,00:00:00,05:00:03,900,1\n\
         T2,06:00:00,21:00:00,1800,0\n",
    )
    .unwrap();
}

/// Pack the feed dir into a zip and return the path to the zip file.
fn write_gtfs_zip(feed_dir: &Path, zip_path: &Path) {
    let f = std::fs::File::create(zip_path).unwrap();
    let mut zw = zip::ZipWriter::new(f);
    let opts: FileOptions<'_, '_, ()> = FileOptions::default();
    for entry in std::fs::read_dir(feed_dir).unwrap() {
        let e = entry.unwrap();
        let name = e.file_name().into_string().unwrap();
        zw.start_file(&name, opts).unwrap();
        zw.write_all(&std::fs::read(e.path()).unwrap()).unwrap();
    }
    zw.finish().unwrap();
}

/// Parse the tagged-region table starting at byte 32 (entry size 24 B each):
/// `regionId u16 @+0 | entryFlags u16 @+2 | reserved u32 @+4 | offset u64 @+8
/// | length u64 @+16`. Returns `(region_id, offset, length)` for each non-zero
/// entry. Terminates on the first `regionId == 0`.
fn parse_region_table(buf: &[u8]) -> Vec<(u16, usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    loop {
        let e = 32 + i * 24;
        let region_id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
        if region_id == 0 {
            break;
        }
        let offset = u64::from_le_bytes(buf[e + 8..e + 16].try_into().unwrap()) as usize;
        let length = u64::from_le_bytes(buf[e + 16..e + 24].try_into().unwrap()) as usize;
        out.push((region_id, offset, length));
        i += 1;
    }
    out
}

/// Build the feed → PTB pipeline and return the PTB bytes.
///
/// Uses `anchor_date=20260501` for a deterministic PTB v1 bundle.
fn build_frequencies_ptb() -> Vec<u8> {
    let tmp = tempfile::tempdir().unwrap();
    let feed_dir = tmp.path().join("feed");
    std::fs::create_dir_all(&feed_dir).unwrap();
    write_feed(&feed_dir);

    let zip_path = tmp.path().join("feed.zip");
    write_gtfs_zip(&feed_dir, &zip_path);

    let feed_record = record_for_local(&zip_path).unwrap();

    let extract_root = tmp.path().join("extract");
    let bundle_dest = tmp.path().join("bundle.ptb");

    build_ptb(
        vec![feed_record],
        &extract_root,
        &bundle_dest,
        Some(ANCHOR_DATE),
        None, // city_tz_offset_seconds
        Some("UTC"),
        DeriveInseat::Auto,
    )
    .expect("build_ptb must succeed for a valid frequencies feed");

    std::fs::read(&bundle_dest).expect("bundle.ptb must exist after build_ptb")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Full chain: `frequencies.txt` → `build_ptb` → `pt_core::Reader` decode.
///
/// Asserts:
///   1. `has_frequencies()` is `true`.
///   2. T1 (trip_idx 0) returns 2 rows in `(trip_idx, start_secs)` order.
///   3. T2 (trip_idx 1) returns 1 row with the correct field values.
///   4. An unknown trip_idx returns an empty iterator.
///   5. The rows are sorted by `(tripIdx, startSecs)` as documented.
#[test]
fn frequencies_end_to_end_round_trip() {
    let bytes = build_frequencies_ptb();

    let reader = pt_core::Reader::from_bytes(bytes).expect("pt_core::Reader::from_bytes");

    // (1) Region presence.
    assert!(
        reader.has_frequencies(),
        "has_frequencies() must be true for a feed with frequencies.txt"
    );

    // (2) T1 rows (trip_idx 0, sorted by start_secs).
    // After sort-by-(trip_idx, start_secs): overnight window (start=0) sorts
    // before the daytime window (start=18000).
    let t1_rows: Vec<_> = reader.frequencies_for_trip(0).collect();
    assert_eq!(t1_rows.len(), 2, "T1 must have 2 frequency rows");

    // Row 0: overnight 00:00:00–05:00:03, headway 900s, exact_times 1
    assert_eq!(t1_rows[0].trip_idx, 0, "t1_rows[0].trip_idx");
    assert_eq!(t1_rows[0].start_secs, 0, "00:00:00 → 0 s");
    assert_eq!(
        t1_rows[0].end_secs, 18003,
        "05:00:03 → 18003 s (verbatim, NOT adjusted)"
    );
    assert_eq!(t1_rows[0].headway_secs, 900);
    assert_eq!(t1_rows[0].exact_times, 1);

    // Row 1: daytime 05:00:00–23:50:01, headway 600s, exact_times 0
    assert_eq!(t1_rows[1].trip_idx, 0, "t1_rows[1].trip_idx");
    assert_eq!(t1_rows[1].start_secs, 18000, "05:00:00 → 18000 s");
    assert_eq!(
        t1_rows[1].end_secs, 85801,
        "23:50:01 → 85801 s (verbatim, half-open)"
    );
    assert_eq!(t1_rows[1].headway_secs, 600);
    assert_eq!(t1_rows[1].exact_times, 0);

    // (3) T2 row (trip_idx 1).
    let t2_rows: Vec<_> = reader.frequencies_for_trip(1).collect();
    assert_eq!(t2_rows.len(), 1, "T2 must have 1 frequency row");
    assert_eq!(t2_rows[0].trip_idx, 1);
    assert_eq!(t2_rows[0].start_secs, 21600, "06:00:00 → 21600 s");
    assert_eq!(t2_rows[0].end_secs, 75600, "21:00:00 → 75600 s");
    assert_eq!(t2_rows[0].headway_secs, 1800);
    assert_eq!(t2_rows[0].exact_times, 0);

    // (4) Unknown trip returns empty.
    let empty: Vec<_> = reader.frequencies_for_trip(99).collect();
    assert!(empty.is_empty(), "frequencies_for_trip(99) must be empty");

    // (5) Rows sorted: t1_rows[0].start_secs(0) < t1_rows[1].start_secs(18000)
    //     and t1_rows.last().trip_idx(0) <= t2_rows[0].trip_idx(1) — already
    //     validated above by the index assertions.
}

/// Verify `0x17` is present in the tagged-table for the frequencies feed.
#[test]
fn frequencies_region_present_in_table() {
    let bytes = build_frequencies_ptb();
    let table = parse_region_table(&bytes);
    let ids: Vec<u16> = table.iter().map(|(id, _, _)| *id).collect();
    assert!(
        ids.contains(&0x17),
        "0x17 Frequencies region must be in the tagged table; found: {ids:?}"
    );
}

/// Layout-lock golden: the raw `0x17` region bytes (count u32 + 3×16 B rows)
/// are pinned so a field-reorder or endianness change fails immediately.
///
/// The region body for the two-trip feed is:
/// ```text
/// count=3 (u32 LE): 03 00 00 00
/// row 0 (T1 overnight): 00 00 00 00 | 00 00 00 00 | 53 46 00 00 | 84 03 | 01 | 00
///   trip_idx=0  start=0          end=18003        headway=900   exact=1  pad=0
/// row 1 (T1 daytime):  00 00 00 00 | 50 46 00 00 | 29 4F 01 00 | 58 02 | 00 | 00
///   trip_idx=0  start=18000       end=85801        headway=600   exact=0  pad=0
/// row 2 (T2):          01 00 00 00 | 60 54 00 00 | 50 27 01 00 | 08 07 | 00 | 00
///   trip_idx=1  start=21600       end=75600        headway=1800  exact=0  pad=0
/// ```
/// Total: 4 + 3×16 = 52 bytes.
///
/// Regenerate with `REGEN_GOLDEN=1 cargo test --features csv-mmap
/// frequencies_region_golden_bytes_unchanged`, then commit the updated file.
#[test]
fn frequencies_region_golden_bytes_unchanged() {
    let bytes = build_frequencies_ptb();
    let table = parse_region_table(&bytes);
    let &(_, offset, length) = table
        .iter()
        .find(|(id, _, _)| *id == 0x17)
        .expect("0x17 region must be present");

    let region_bytes = &bytes[offset..offset + length];

    // Sanity: count=3, length=52.
    assert_eq!(
        length,
        4 + 3 * 16,
        "0x17 region length must be 4 + 3*16 = 52"
    );
    let count = u32::from_le_bytes(region_bytes[0..4].try_into().unwrap());
    assert_eq!(count, 3, "region count prefix must be 3");

    let golden_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/frequencies-region-golden.bin");

    if std::env::var_os("REGEN_GOLDEN").is_some() {
        std::fs::write(&golden_path, region_bytes).unwrap();
        eprintln!(
            "[regen] wrote {} bytes to {}",
            region_bytes.len(),
            golden_path.display()
        );
    }

    let expected = std::fs::read(&golden_path)
        .expect("commit tests/fixtures/frequencies-region-golden.bin (run REGEN_GOLDEN=1 first)");
    assert_eq!(
        region_bytes, expected.as_slice(),
        "0x17 Frequencies region byte layout drifted; if intentional run REGEN_GOLDEN=1 and recommit"
    );
}
