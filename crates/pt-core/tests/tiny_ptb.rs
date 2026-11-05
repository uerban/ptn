use pt_core::Reader;
use std::fs; // tests may use std (only the lib is no_std)

mod util; // tests/util.rs (shared bundle builder)

/// Regression guard: the projection must emit the RAW on-disk CSR offsets, NOT a
/// canonical 0-based prefix-sum reconstructed from per-row accessors.
///
/// Every committed fixture has canonical offsets (starting at 0), so a buggy
/// implementation that rebuilds offsets from `route_trips(r)` row lengths would
/// still match the goldens. This bundle is structurally VALID (passes
/// `validate_csr`) but NON-CANONICAL: `rtOffsets = [1,3,5]` does not start at 0,
/// yet it is monotonic, `last == num_trips(5)`, and every `rtValue < 5`. A
/// prefix-sum rebuild from the two per-route slices (lens 2 and 2) would emit
/// `[0,2,4]`; the raw-array view emits the on-disk `[1,3,5]`. The assertion below
/// pins the raw bytes, so reverting `project()` to reconstruction fails it.
#[test]
fn projection_emits_raw_non_canonical_csr_offsets() {
    // num_trips=5, num_routes=2, num_stops=0.
    // rtOffsets=[1,3,5] -> route 0 = trips[1..3], route 1 = trips[3..5]; rtValues
    // has 5 entries (last_u32=5) all < 5; srOffsets=[0]/srValues=[] for 0 stops.
    let mut csr = Vec::new();
    for &o in &[1u32, 3, 5] {
        csr.extend_from_slice(&o.to_le_bytes()); // rtOffsets[num_routes+1]
    }
    for &v in &[0u32, 1, 2, 3, 4] {
        csr.extend_from_slice(&v.to_le_bytes()); // rtValues (len == rtOffsets[last])
    }
    csr.extend_from_slice(&0u32.to_le_bytes()); // srOffsets[num_stops+1] = [0]
                                                // srValues: none (srOffsets[last] == 0).

    let trips = vec![0u8; 24 * 5]; // 5 zeroed trip records (all idx 0 -> "")
    let b = util::assemble_bundle(&util::Bundle {
        num_routes: 2,
        num_trips: 5,
        routes_soa: util::routes_soa(&[1, 2]), // "R1", "R2"
        trips,
        trip_starts: util::u32s(&[0; 6]), // (num_trips+1) u32
        csr,
        string_pool: util::string_pool(&["", "R1", "R2"]),
        ..util::Bundle::empty()
    });

    let r = Reader::from_bytes(b).expect("non-canonical-but-valid bundle decodes");
    // Sanity: the bundle really is non-canonical (offsets[0] != 0).
    assert_eq!(r.route_trips_offsets().unwrap(), &[1, 3, 5]);
    let json = pt_core::projection::project(&r);
    // The RAW on-disk offsets must appear verbatim. A reconstruct-from-per-row
    // implementation would have emitted the canonical "[0,2,4]" instead.
    assert!(
        json.contains("\"routeTripsOffsets\":[1,3,5]"),
        "projection must emit raw on-disk offsets [1,3,5], got: {json}"
    );
    assert!(
        !json.contains("\"routeTripsOffsets\":[0,2,4]"),
        "projection reconstructed canonical offsets instead of raw: {json}"
    );
}

fn load_tiny() -> Reader<Vec<u8>> {
    // CARGO_MANIFEST_DIR = crates/pt-core; the fixture is two levels up.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/ptb/__fixtures__/tiny.ptb"
    );
    Reader::from_bytes(fs::read(path).expect("read tiny.ptb")).expect("decode tiny.ptb")
}

fn load_canary() -> Reader<Vec<u8>> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/ptb/__fixtures__/canary.ptb"
    );
    Reader::from_bytes(fs::read(path).expect("read canary.ptb")).expect("decode canary.ptb")
}

/// `tiny.ptb` is the producer's own output for
/// `crates/pt-producer/tests/fixtures/tiny-gtfs.zip` (anchor 20260501,
/// Europe/Vilnius): a carry-less current PTB v1 bundle.
#[test]
fn decodes_tiny_ptb_v1() {
    let r = load_tiny();
    assert_eq!(r.header().version, 1);
    assert!(r.is_carry_less_band());
    // Europe/Vilnius EEST at the 20260501 anchor = +10800.
    assert_eq!(r.header().city_tz_offset_seconds, 10800);
    // parent_station: S2 (idx 1) and S3 (idx 2) both parent to S1 (idx 0).
    assert_eq!(r.stop_parent(1), Some(0));
    assert_eq!(r.stop_parent(2), Some(0));
    assert_eq!(r.stop_parent(0), None);
    assert_eq!(r.feed_start_date(), 20260501);
    assert_eq!(r.num_services(), 2);
    assert_eq!(r.num_stops(), 3);
    assert_eq!(r.num_routes(), 2);
    assert_eq!(r.num_trips(), 4);
    assert_eq!(r.num_stop_times(), 12);
    // The feed has no transfers.txt.
    assert_eq!(r.num_transfers(), 0);
    assert!(r.transfer(0).is_err());
    // S2 wheelchair_boarding = 1; S1 = 0.
    assert_eq!(r.stop(1).unwrap().wheelchair_boarding, 1);
    assert_eq!(r.stop(0).unwrap().wheelchair_boarding, 0);
    assert_eq!(r.stop(0).unwrap().stop_id, "S1");
    assert_eq!(r.route(0).unwrap().long_name, "Route One");
    assert_eq!(r.route(0).unwrap().route_color, "FF0000");
    assert_eq!(r.route(0).unwrap().route_text_color, "FFFFFF");
    // T1: wheelchair_accessible 2, direction 0, shape shp_A.
    assert_eq!(r.trip(0).unwrap().wheelchair_accessible, 2);
    assert_eq!(r.trip(0).unwrap().direction_id, 0);
    assert_eq!(r.trip(0).unwrap().shape_id, "shp_A");
    assert_eq!(r.stop_index("S2"), Some(1));
    assert_eq!(r.stop_index("nope"), None);
    // Synthesized from the band: 4 trips x 3 positions.
    assert_eq!(r.trip_starts().unwrap(), &[0, 3, 6, 9, 12]);
    assert_eq!(r.route_trips(0).unwrap(), &[0, 1]); // R1 -> T1,T2
    assert_eq!(r.route_trips(1).unwrap(), &[2, 3]); // R2 -> T3,T4
                                                    // Row 0 is T1 @ S1 07:00:00. A carry-less bundle has no GTFS
                                                    // stop_sequence, so stop_seq is the pattern position.
    let st0 = r.stop_time(0).unwrap();
    assert_eq!(st0.dep_secs, 25200);
    assert_eq!(st0.arr_diff, 0);
    assert_eq!(st0.stop_idx, 0);
    assert_eq!(st0.stop_seq, 0);
    assert_eq!(r.stop_time(10).unwrap().dep_secs, 91800); // T4 25:30:00
                                                          // calendar.txt: SA (0) runs Saturdays, WD (1) weekdays; calendar_dates.txt
                                                          // removes WD on 20260520. 20260501 is a Friday.
    assert!(!r.service_active_on(0, 20260501));
    assert!(r.service_active_on(1, 20260501));
    assert!(r.service_active_on(0, 20260502));
    assert!(!r.service_active_on(1, 20260502));
    assert!(r.service_active_on(1, 20260519));
    assert!(!r.service_active_on(1, 20260520));
    // Out-of-window underflow -> false, no panic.
    assert!(!r.service_active_on(0, 20260401));
}

#[test]
fn projection_matches_golden() {
    let r = load_tiny();
    let golden = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/tiny.projection.json"
    ))
    .expect("read golden");
    assert_eq!(pt_core::projection::project(&r), golden.trim_end());
}

#[test]
fn canary_projection_matches_golden() {
    // `canary.ptb` is the producer's output for
    // `crates/pt-producer/tests/fixtures/canary-gtfs.zip`: multi-byte UTF-8
    // ids/names (Žz, Šiaurė) and a negative dwell (-3) — coverage the ASCII
    // tiny feed misses.
    let r = load_canary();
    let golden = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/canary.projection.json"
    ))
    .expect("read canary golden");
    assert_eq!(pt_core::projection::project(&r), golden.trim_end());
    assert_eq!(r.header().version, 1);
    assert_eq!(r.stop_time(0).unwrap().arr_diff, -3);
    assert_eq!(r.stop(1).unwrap().stop_id, "Žz");
    assert_eq!(r.stop(1).unwrap().stop_name, "Žalgiris");
    assert_eq!(r.route(0).unwrap().long_name, "Šiaurė");
    assert_eq!(r.trip(0).unwrap().trip_id, "tŠ-1");
}
