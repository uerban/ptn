use pt_producer::csr::route_trips::build_route_trips_csr;
use pt_producer::csr::stop_routes::build_stop_routes_csr;
use pt_producer::pass1::TripAttrs;

#[test]
fn route_trips_csr_groups_trips_by_route() {
    // trips: 0→R0, 1→R0, 2→R1, 3→R1
    let trips = vec![
        TripAttrs {
            route_idx: 0,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
        TripAttrs {
            route_idx: 0,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
        TripAttrs {
            route_idx: 1,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
        TripAttrs {
            route_idx: 1,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
    ];
    let (offsets, neighbors) = build_route_trips_csr(&trips, 2).unwrap();
    assert_eq!(offsets, vec![0, 2, 4]);
    assert_eq!(neighbors.len(), 4);
    // R0 → [0, 1]
    let r0: Vec<u32> = neighbors[offsets[0] as usize..offsets[1] as usize].to_vec();
    let mut r0_sorted = r0.clone();
    r0_sorted.sort();
    assert_eq!(r0_sorted, vec![0, 1]);
    // R1 → [2, 3]
    let r1: Vec<u32> = neighbors[offsets[1] as usize..offsets[2] as usize].to_vec();
    let mut r1_sorted = r1.clone();
    r1_sorted.sort();
    assert_eq!(r1_sorted, vec![2, 3]);
}

#[test]
fn route_trips_csr_handles_empty_routes() {
    // R0 has 1 trip, R1 has 0 trips, R2 has 2 trips. Empty route's
    // offsets[2] - offsets[1] must be 0 — silent skip would shift everything.
    let trips = vec![
        TripAttrs {
            route_idx: 0,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
        TripAttrs {
            route_idx: 2,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
        TripAttrs {
            route_idx: 2,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
    ];
    let (offsets, neighbors) = build_route_trips_csr(&trips, 3).unwrap();
    assert_eq!(offsets.len(), 4);
    assert_eq!(offsets[0], 0);
    assert_eq!(offsets[1], 1);
    // R1 empty range
    assert_eq!(offsets[2], 1);
    assert_eq!(offsets[3], 3);
    assert_eq!(neighbors.len(), 3);
}

#[test]
fn route_trips_csr_rejects_out_of_bounds_route_idx() {
    let trips = vec![TripAttrs {
        route_idx: 5,
        service_idx: 0,
        headsign: String::new(),
        wheelchair_accessible: 0,
        ..Default::default()
    }];
    let err = build_route_trips_csr(&trips, 2).unwrap_err();
    let msg = format!("{err}");
    assert!(
        msg.contains("route_idx") || msg.contains("bounds"),
        "expected bounds-check error, got: {msg}"
    );
}

#[test]
fn stop_routes_csr_groups_routes_by_stop_with_dedup() {
    // 3 stops, 2 routes. Each stop visited by both routes (once via 2 trips per route),
    // so dedup must collapse to 1 entry per route per stop.
    let trips = vec![
        TripAttrs {
            route_idx: 0,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
        TripAttrs {
            route_idx: 0,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
        TripAttrs {
            route_idx: 1,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
        TripAttrs {
            route_idx: 1,
            service_idx: 0,
            headsign: String::new(),
            wheelchair_accessible: 0,
            ..Default::default()
        },
    ];
    let triples: Vec<(u32, u32, u16)> = vec![
        (0, 0, 1),
        (0, 1, 2),
        (0, 2, 3),
        (1, 0, 1),
        (1, 1, 2),
        (1, 2, 3),
        (2, 0, 1),
        (2, 1, 2),
        (2, 2, 3),
        (3, 0, 1),
        (3, 1, 2),
        (3, 2, 3),
    ];
    let (offsets, neighbors) = build_stop_routes_csr(&triples, &trips, 3).unwrap();
    assert_eq!(offsets.len(), 4);
    // Every stop has 2 unique routes.
    assert_eq!(offsets[0], 0);
    assert_eq!(offsets[1], 2);
    assert_eq!(offsets[2], 4);
    assert_eq!(offsets[3], 6);
    for s in 0..3 {
        let lo = offsets[s] as usize;
        let hi = offsets[s + 1] as usize;
        let mut routes: Vec<u32> = neighbors[lo..hi].to_vec();
        routes.sort();
        assert_eq!(routes, vec![0, 1], "stop {s} routes");
    }
}

#[test]
fn stop_routes_csr_handles_orphan_stop_with_empty_range() {
    // S0 visited by trip 0 (route 0). S1 (orphan) is never visited.
    let trips = vec![TripAttrs {
        route_idx: 0,
        service_idx: 0,
        headsign: String::new(),
        wheelchair_accessible: 0,
        ..Default::default()
    }];
    let triples: Vec<(u32, u32, u16)> = vec![(0, 0, 1)];
    let (offsets, neighbors) = build_stop_routes_csr(&triples, &trips, 2).unwrap();
    assert_eq!(offsets, vec![0, 1, 1]);
    assert_eq!(neighbors, vec![0]);
}

#[test]
fn stop_routes_csr_rejects_out_of_bounds_stop_idx() {
    let trips = vec![TripAttrs {
        route_idx: 0,
        service_idx: 0,
        headsign: String::new(),
        wheelchair_accessible: 0,
        ..Default::default()
    }];
    let triples = vec![(0u32, 9u32, 1u16)];
    let err = build_stop_routes_csr(&triples, &trips, 2).unwrap_err();
    let msg = format!("{err}");
    assert!(
        msg.contains("stop_idx") || msg.contains("bounds"),
        "expected bounds-check error, got: {msg}"
    );
}

#[test]
fn write_u32_slice_returns_err_on_overflow() {
    use pt_producer::regions::write_u32_slice;
    let mut buf = [0u8; 4]; // capacity for exactly 1 u32
    let err = write_u32_slice(&mut buf, &[1u32, 2u32]).unwrap_err();
    let msg = format!("{err}");
    assert!(
        msg.contains("overflow") || msg.contains("region"),
        "expected overflow error, got: {msg}"
    );
}

#[test]
fn write_u32_slice_writes_little_endian() {
    use pt_producer::regions::write_u32_slice;
    let mut buf = [0u8; 8];
    write_u32_slice(&mut buf, &[1u32, 0x0102_0304u32]).unwrap();
    assert_eq!(buf, [1, 0, 0, 0, 4, 3, 2, 1]);
}

#[test]
fn flush_mid_pass_regions_writes_csr_and_bitmasks_into_buffer() {
    use pt_producer::layout::{Layout, Region};
    use pt_producer::pass1::run_pass1;
    use pt_producer::regions::flush_mid_pass_regions;
    use pt_producer::source::extract_zip;
    use pt_producer::writer::WriteRegion;
    use std::path::PathBuf;

    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip");
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture, tmp.path()).unwrap();
    let p1 = run_pass1(tmp.path()).unwrap();

    let layout = Layout::compute(
        p1.stops.len() as u64,
        p1.routes.len() as u64,
        p1.trips.len() as u64,
        p1.total_stop_times as u64,
        90,
        p1.services.len() as u64,
        0,
        0,
    );
    let out = tmp.path().join("p1.bin");
    let mut w = pt_producer::writer::open_writer(&out, layout.total_bytes()).unwrap();
    flush_mid_pass_regions(&mut w, &layout, &p1, 90).unwrap();

    // Sanity: at least one byte in the bitmask region is non-zero (WD service
    // is active most days in the 90-day window starting at feed_start_date).
    let bm = w.region_slice(&layout, Region::ServiceBitmasks);
    assert!(bm.iter().any(|&b| b != 0), "bitmask region all-zero");
    // CSR region first 4 bytes are the first route's trip-list offset (0).
    let csr = w.region_slice(&layout, Region::Csr);
    assert_eq!(&csr[..4], &[0u8, 0, 0, 0]);
}
