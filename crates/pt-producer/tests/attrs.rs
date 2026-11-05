use pt_producer::pass1::run_pass1;
use pt_producer::source::extract_zip;
use std::path::PathBuf;

fn fixture_zip() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip")
}

#[test]
fn pass1_captures_stop_attrs_with_name_and_coords() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r = run_pass1(tmp.path()).unwrap();

    assert_eq!(r.stops_attrs.len(), 3);
    let s1 = r.stops.lookup("S1").unwrap() as usize;
    assert_eq!(r.stops_attrs[s1].name, "Stop One");
    assert!(
        (r.stops_attrs[s1].lat - 54.69).abs() < 1e-6,
        "lat={}",
        r.stops_attrs[s1].lat
    );
    assert!(
        (r.stops_attrs[s1].lon - 25.28).abs() < 1e-6,
        "lon={}",
        r.stops_attrs[s1].lon
    );
}

#[test]
fn pass1_captures_route_attrs() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r = run_pass1(tmp.path()).unwrap();

    assert_eq!(r.routes_attrs.len(), 2);
    let r1 = r.routes.lookup("R1").unwrap() as usize;
    assert_eq!(r.routes_attrs[r1].agency_id, "P1");
    assert_eq!(r.routes_attrs[r1].short_name, "1");
    assert_eq!(r.routes_attrs[r1].long_name, "Route One");
    assert_eq!(r.routes_attrs[r1].route_type, 3);
}

#[test]
fn pass1_captures_trip_attrs_with_post_finalize_cross_refs() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r = run_pass1(tmp.path()).unwrap();

    assert_eq!(r.trips_attrs.len(), 4);
    let t1 = r.trips.lookup("T1").unwrap() as usize;
    let t4 = r.trips.lookup("T4").unwrap() as usize;
    let r1 = r.routes.lookup("R1").unwrap();
    let r2 = r.routes.lookup("R2").unwrap();
    let wd = r.services.lookup("WD").unwrap();
    let sa = r.services.lookup("SA").unwrap();
    // T1 → R1, WD
    assert_eq!(r.trips_attrs[t1].route_idx, r1);
    assert_eq!(r.trips_attrs[t1].service_idx, wd);
    // T4 → R2, SA
    assert_eq!(r.trips_attrs[t4].route_idx, r2);
    assert_eq!(r.trips_attrs[t4].service_idx, sa);
}

#[test]
fn pass1_collects_trip_stop_triples_with_stop_sequence() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r = run_pass1(tmp.path()).unwrap();

    assert_eq!(r.trip_stop_triples.len(), 12);
    let t1 = r.trips.lookup("T1").unwrap();
    let s1 = r.stops.lookup("S1").unwrap();
    let s2 = r.stops.lookup("S2").unwrap();
    let s3 = r.stops.lookup("S3").unwrap();
    assert!(r.trip_stop_triples.contains(&(t1, s1, 1)));
    assert!(r.trip_stop_triples.contains(&(t1, s2, 2)));
    assert!(r.trip_stop_triples.contains(&(t1, s3, 3)));
    // T3 runs in reverse — stop_sequence 1 should map to S3, 3 to S1.
    let t3 = r.trips.lookup("T3").unwrap();
    assert!(r.trip_stop_triples.contains(&(t3, s3, 1)));
    assert!(r.trip_stop_triples.contains(&(t3, s1, 3)));
}

#[test]
fn pass1_clamps_stop_sequence_above_u16_range() {
    // GTFS allows arbitrarily large `stop_sequence`. Pass 2 clamps to u16::MAX
    // rather than abort the bench (see `pass2/stop_times_csv.rs` and
    // `pass2/stop_times_raw.rs`). Pass 1's triple collection must follow the
    // same policy so a single oversized but otherwise valid row doesn't kill
    // the whole ingestion.
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(
        dir.join("agency.txt"),
        "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stops.txt"),
        "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\nS2,B,0,0\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("routes.txt"),
        "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("calendar.txt"),
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
         WD,1,1,1,1,1,0,0,20260501,20260801\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("trips.txt"),
        "route_id,service_id,trip_id\nR1,WD,T1\n",
    )
    .unwrap();
    // 70000 and 70001 both exceed u16::MAX (65535) — both must clamp without error.
    std::fs::write(
        dir.join("stop_times.txt"),
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         T1,07:00:00,07:00:00,S1,1\n\
         T1,07:05:00,07:05:00,S2,70000\n",
    )
    .unwrap();
    let r = run_pass1(dir).unwrap();
    let t1 = r.trips.lookup("T1").unwrap();
    let s2 = r.stops.lookup("S2").unwrap();
    assert!(
        r.trip_stop_triples.contains(&(t1, s2, u16::MAX)),
        "oversized stop_sequence must clamp to u16::MAX, got {:?}",
        r.trip_stop_triples
    );
}

#[test]
fn cross_feed_scan_routes_preserves_attrs_after_trips_orphan_extension() {
    // Regression: when feed-0's trips.txt references a route_id missing from
    // feed-0's routes.txt, scan_trips' `routes.intern(route_id)` extends the
    // routes interner without pushing to pre_routes_attrs. Feed-1's
    // scan_routes then sees `pre_id > attrs.len()` for a NEW route, and the
    // naive `pre_id == attrs.len()` push would silently drop the row.
    // `pad_defaults` would later install default attrs in its slot, so the
    // finalized routes_attrs[post_id] for that route would be all-defaults
    // — silent data corruption.
    use pt_producer::pass1::run_pass1_union;
    let tmp = tempfile::tempdir().unwrap();
    let f0 = tmp.path().join("feed-0");
    let f1 = tmp.path().join("feed-1");
    for d in [&f0, &f1] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(
            d.join("agency.txt"),
            "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
        )
        .unwrap();
        std::fs::write(
            d.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\n",
        )
        .unwrap();
        std::fs::write(
            d.join("calendar.txt"),
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
             WD,1,1,1,1,1,0,0,20260501,20260801\n",
        )
        .unwrap();
        std::fs::write(
            d.join("stop_times.txt"),
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n",
        )
        .unwrap();
    }
    // Feed-0: routes.txt has only R_A; trips.txt orphan-references R_ORPHAN.
    std::fs::write(
        f0.join("routes.txt"),
        "route_id,agency_id,route_short_name,route_long_name,route_type\n\
         R_A,A,A,RouteA,3\n",
    )
    .unwrap();
    std::fs::write(
        f0.join("trips.txt"),
        "route_id,service_id,trip_id\nR_ORPHAN,WD,T1\n",
    )
    .unwrap();
    // Feed-1: routes.txt has R_C (a NEW route, never seen as an orphan), with
    // distinguishable attributes; trips.txt references R_C legitimately.
    std::fs::write(
        f1.join("routes.txt"),
        "route_id,agency_id,route_short_name,route_long_name,route_type\n\
         R_C,A,C,RouteC,4\n",
    )
    .unwrap();
    std::fs::write(
        f1.join("trips.txt"),
        "route_id,service_id,trip_id\nR_C,WD,T2\n",
    )
    .unwrap();

    let r = run_pass1_union(&[f0.clone(), f1.clone()]).unwrap();
    let r_c = r.routes.lookup("R_C").unwrap() as usize;
    // The bug would leave R_C's attrs all-default (route_type=0, empty names).
    assert_eq!(r.routes_attrs[r_c].route_type, 4, "R_C route_type lost");
    assert_eq!(r.routes_attrs[r_c].short_name, "C", "R_C short_name lost");
    assert_eq!(
        r.routes_attrs[r_c].long_name, "RouteC",
        "R_C long_name lost"
    );
}

#[test]
fn finalize_remap_preserves_attribute_alignment() {
    // Canary for the entire remap mechanic: after finalize, every attribute
    // vector is indexed by the interner's POST-finalize ids. If the remap
    // step was forgotten or wired through the wrong interner, the keys at
    // each post id will not match the attrs at that id, and the cross-refs
    // in trip_attrs will dangle into the pre-finalize index space.
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r = run_pass1(tmp.path()).unwrap();

    // Stops: the key at post-id `i` must match the stop_id field of the
    // ORIGINAL fixture row whose attributes are now at `stops_attrs[i]`.
    // The fixture's stop_ids S1/S2/S3 sort alphabetically the same as
    // insertion order, but the bug we want to catch (missing remap) would
    // surface even here if the IdentityInterner returned different ids.
    for (i, key) in r.stops.keys().iter().enumerate() {
        let lookup = r.stops.lookup(key.as_str()).unwrap() as usize;
        assert_eq!(
            lookup, i,
            "stops key at post-id {i} does not round-trip through lookup"
        );
        // sanity: stops_attrs[i] is at the right post-id slot
        assert!(!r.stops_attrs[i].name.is_empty(), "stops_attrs[{i}] empty");
    }

    // Routes: same invariant.
    for (i, key) in r.routes.keys().iter().enumerate() {
        let lookup = r.routes.lookup(key.as_str()).unwrap() as usize;
        assert_eq!(lookup, i);
        assert_ne!(r.routes_attrs[i].route_type, 0, "routes_attrs[{i}] empty");
    }

    // Services: ensure service_attrs is also remapped.
    for (i, key) in r.services.keys().iter().enumerate() {
        let lookup = r.services.lookup(key.as_str()).unwrap() as usize;
        assert_eq!(lookup, i);
        assert!(
            r.service_attrs[i].weekdays != 0 || !r.service_attrs[i].removals.is_empty(),
            "service_attrs[{i}] empty"
        );
    }

    // Trip cross-refs: trips_attrs[post_trip_id].route_idx must be a valid
    // POST-finalize route id (i.e. routes.keys()[route_idx] is reachable).
    for (i, key) in r.trips.keys().iter().enumerate() {
        let lookup = r.trips.lookup(key.as_str()).unwrap() as usize;
        assert_eq!(lookup, i);
        let route_idx = r.trips_attrs[i].route_idx as usize;
        let service_idx = r.trips_attrs[i].service_idx as usize;
        assert!(
            route_idx < r.routes.keys().len(),
            "trip_attrs[{i}].route_idx out of bounds"
        );
        assert!(
            service_idx < r.services.keys().len(),
            "trip_attrs[{i}].service_idx out of bounds"
        );
        // Sanity-check using the known fixture mapping (trip_id starts with
        // 'T'; reverse-engineer the route from the fixture):
        // T1,T2 → R1,WD; T3 → R2,WD; T4 → R2,SA.
        let trip_id = key.as_str();
        let route_key = &r.routes.keys()[route_idx];
        let service_key = &r.services.keys()[service_idx];
        match trip_id {
            "T1" | "T2" => {
                assert_eq!(route_key, "R1");
                assert_eq!(service_key, "WD");
            }
            "T3" => {
                assert_eq!(route_key, "R2");
                assert_eq!(service_key, "WD");
            }
            "T4" => {
                assert_eq!(route_key, "R2");
                assert_eq!(service_key, "SA");
            }
            other => panic!("unexpected trip_id {other}"),
        }
    }
}
