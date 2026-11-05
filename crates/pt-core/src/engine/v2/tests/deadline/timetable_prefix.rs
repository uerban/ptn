//! Timetable certificate versus independent raw/full-M4 and canonical witnesses.
use super::*;

fn check(net: &Net, q: &Query, window: core::ops::Range<i64>, deadline: i64) -> bool {
    bounded_warmup::check_policies(
        net,
        q,
        window,
        deadline,
        &[(
            DeadlineTraversal::ArrivalFirst,
            DeadlinePruning::EarliestPrefixAndTimetablePoints,
        )],
    )
}

#[test]
fn timetable_prefix_matches_raw_and_all_canonical_filters_on_200_networks() {
    let mut rng = Rng(0x5449_4d45_5052_4546);
    let mut nonempty = 0;
    for _ in 0..200 {
        let mut net = random_net(&mut rng);
        net.strip = rng.chance(50);
        let mut q = query(
            rng.below(5) as u32,
            rng.below(5) as u32,
            68000,
            1 + rng.below(3) as u32,
        );
        q.entry_stops[0].walk_secs = rng.below(60) as u32;
        q.exit_stops[0].walk_secs = rng.below(60) as u32;
        if rng.chance(30) {
            q.mobility = Mobility::Wheelchair;
        }
        nonempty += usize::from(check(&net, &q, 68000..72000, 76000));
    }
    assert!(nonempty > 35, "sparse timetable corpus: {nonempty}");
}

#[test]
fn timetable_prefix_rejects_incompatible_hops_and_preserves_equal_time_occurrences() {
    let mut net = Net::new(4, 3);
    net.trip(0, &[(0, 1000), (1, 1100)]);
    net.trip(0, &[(0, 2000), (1, 2010)]); // Faster, but misses B -> C.
    net.trip(1, &[(1, 1250), (2, 1350)]);
    net.trip(2, &[(2, 1500), (3, 1600)]);
    let q = query(0, 3, 900, 3);
    assert!(check(&net, &q, 900..2100, 2500));
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(q.date, 900..2501),
    )
    .unwrap();
    let mut r = DeadlineRequest::new(&q, 900..2100, 2500);
    let probes = [(0, 0, 1000), (1, 1, 1250), (2, 2, 1500), (1, 2, 1500)];
    r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
    let (old, d) = origin_uppers_for_test(&reader, &index, &events, &r, &probes);
    assert_eq!(d.timetable, TimetablePrefixDiagnostics::default());
    r.pruning = DeadlinePruning::EarliestPrefixAndTimetablePoints;
    let (new, d) = origin_uppers_for_test(&reader, &index, &events, &r, &probes);
    assert!(d.timetable.enabled && d.timetable.work() > 0 && d.timetable.index_bytes > 0);
    assert_eq!(new, [Some(1000), Some(1000), Some(1000), None]);
    assert!(old[1] > new[1] && old[2] > new[2]);

    // Repeated stops with a dwell/zero-time hop still need an earlier boarding.
    let mut net = Net::new(3, 1);
    net.trip(0, &[(0, 1000), (1, 1100), (1, 1100), (2, 1200)]);
    assert!(check(&net, &query(1, 2, 1000, 2), 1000..1150, 1200));
}

#[test]
fn timetable_prefix_preserves_rules_frequencies_lassos_and_directed_walks() {
    let mut net = Net::new(3, 3);
    let banned = net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 900), (1, 1000)]);
    let onward = net.trip(2, &[(1, 1200), (2, 1300)]);
    net.transfers
        .push((1, 1, ABSENT, ABSENT, banned, onward, ABSENT, 3));
    assert!(check(&net, &query(0, 2, 900, 2), 900..901, 1300));
    // Zero-duration scoped synthetic transfer: a relaxed candidate is not permission.
    net.transfers
        .push((0, 1, ABSENT, ABSENT, banned, onward, 0, 2));
    assert!(check(&net, &query(0, 2, 900, 2), 900..901, 1300));
    let mut net = Net::new(3, 2);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    let b = net.trip(1, &[(1, 1050), (2, 1200)]);
    net.boarding = vec![0x50, 0x54, 0x51, 0x50];
    net.transfers.push((1, 1, ABSENT, ABSENT, a, b, ABSENT, 4));
    assert!(check(&net, &query(0, 2, 900, 2), 900..901, 1200));
    for exact in [0, 1] {
        let mut net = Net::new(4, 2);
        net.trip(0, &[(0, 86000), (1, 87000)]);
        let t = net.trip(1, &[(1, 87200), (2, 87300), (1, 87400), (3, 87500)]);
        net.freqs.push((t, 87200, 87701, 100, exact));
        let mut origins = utc_origins(START, DAYS as usize, 0);
        for origin in origins.iter_mut().skip(4) {
            *origin -= 3600;
        }
        net.origins = Some(origins);
        assert!(check(&net, &query(0, 3, 85000, 2), 85000..87001, 88500));
    }
    for split in [false, true] {
        let mut net = Net::new(3, 2);
        net.services = vec![0b0000_1000];
        if split {
            net.trip(0, &[(0, 900), (1, 1000), (2, 1100)]);
            net.trip(1, &[(2, 1100), (1, 1200), (0, 1300)]);
            net.trips[0].block = Some("lasso");
            net.trips[1].block = Some("lasso");
            net.derive = true;
        } else {
            net.trip(0, &[(0, 900), (1, 1000), (2, 1100), (1, 1200), (0, 1300)]);
        }
        assert!(check(&net, &query(1, 0, 950, 2), 950..1101, 1300));
    }
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (4, 1400), (3, 1500), (4, 1800)]);
    net.ptft.extend([(1, 2, 90), (1, 3, 30)]);
    assert!(check(&net, &query(0, 4, 900, 2), 900..901, 1800));
    assert!(!check(&net, &query(4, 0, 900, 2), 900..901, 1800));
}

#[test]
fn timetable_prefix_charges_setup_and_preserves_every_original_cap() {
    let net = lattice(2, 1, false);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let q = query(0, 2, 900, 2);
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(q.date, 900..1315),
    )
    .unwrap();
    let mut r = DeadlineRequest::new(&q, 900..1200, 1314);
    r.pruning = DeadlinePruning::EarliestPrefixAndTimetablePoints;
    r.traversal = DeadlineTraversal::ArrivalFirst;
    let full = query_deadline_portfolio(&reader, &index, &events, r.clone()).unwrap();
    let d = full.diagnostics;
    assert!(d.prefix.timetable.enabled && d.prefix.timetable.work() > 0);
    let stop = d.seed_event_checks
        + d.stop_events_scanned
        + d.prefix.event_scans
        + d.prefix.walking_relaxations
        + d.prefix.timetable.work()
        + d.optimistic.work()
        + d.forward.stop_work();
    for (kind, bound) in [
        (0, d.lazy.work),
        (1, stop),
        (2, d.segments_enqueued),
        (3, d.max_frontier_width),
    ] {
        for cap in 1..=bound + 1 {
            let mut c = r.clone();
            match kind {
                0 => c.max_lookup_work = cap,
                1 => c.max_stop_scans = cap,
                2 => c.max_segments = cap,
                _ => c.max_frontier_width = cap,
            }
            match query_deadline_portfolio(&reader, &index, &events, c) {
                Ok(got) => {
                    assert!(cap >= bound);
                    assert_eq!(got.winners, full.winners);
                }
                Err(e) => {
                    assert!(cap < bound);
                    assert!(
                        matches!((kind, e), (0, DeadlineError::Lookup(LazyLookupError::WorkExhausted { limit, attempted }))
                        | (1, DeadlineError::StopScansExhausted { limit, attempted }) | (2, DeadlineError::SegmentsExhausted { limit, attempted })
                        | (3, DeadlineError::FrontierExhausted { limit, attempted }) if limit == cap && attempted > cap)
                    );
                }
            }
        }
    }
}
