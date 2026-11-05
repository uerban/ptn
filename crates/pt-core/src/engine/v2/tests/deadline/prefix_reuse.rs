//! Exact prepared-slot reuse; no key/superset inference or free budget reset.
use super::*;

fn config(
    window: core::ops::Range<i64>,
    deadline: i64,
    pruning: DeadlinePruning,
) -> DeadlineSessionConfig {
    let mut c = DeadlineSessionConfig::new(window, deadline);
    c.lookup = LazyLookupMode::PlainCached;
    c.pruning = pruning;
    c.traversal = DeadlineTraversal::ArrivalFirst;
    c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
    c
}

fn check(net: &Net, q: &Query, window: core::ops::Range<i64>, deadline: i64) -> bool {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let walks = net.ptft_table();
    let raw: Vec<_> = expected(net, q, &window, ProfileObjectives::M4)
        .into_iter()
        .filter(|p| p.1 <= deadline)
        .collect();
    let mut nonempty = false;
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let mut forward = R3Request::new(q, window.clone());
        forward.transfers = walks.as_ref();
        forward.max_labels = 1_000_000;
        let points: Vec<_> = profile_m4(&reader, &index, forward)
            .unwrap()
            .points
            .into_iter()
            .filter(|p| p.destination_arrival_secs <= deadline)
            .collect();
        assert_eq!(tuples(&points, ProfileObjectives::M4), raw);
        nonempty |= !points.is_empty();
        let mut owner = DeadlineSession::new(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        let mut retained = DeadlineSession::new_with_immutable_binding(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        for pruning in [
            DeadlinePruning::EarliestPrefixAndPoints,
            DeadlinePruning::EarliestPrefixAndTimetablePoints,
        ] {
            for date in [
                DeadlineWitnessComparison::Materialized,
                DeadlineWitnessComparison::MaterializedDateMemo,
            ] {
                let mut c = config(window.clone(), deadline, pruning);
                c.witness_comparison = date;
                owner
                    .prepare_with_prefix_cache(q.clone(), c.clone())
                    .unwrap();
                retained.prepare_with_prefix_cache(q.clone(), c).unwrap();
                assert_eq!(retained.catalogue_binding(), owner.catalogue_binding());
                assert!(!owner.catalogue_reused());
                let built = owner
                    .prefix_cache_diagnostics_for_test()
                    .expect("successful prefix preparation");
                assert_eq!(owner.run().unwrap().points, points);
                assert_owned_winners(&owner, &points);
                assert_owned_winners(&retained, &points);
                let a = owner.run().unwrap();
                let b = retained.run().unwrap();
                assert_eq!(a.points, b.points);
                assert_eq!(a.diagnostics, b.diagnostics);
                let legal: Vec<_> = owner
                    .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
                    .unwrap()
                    .winners
                    .by_preference
                    .into_iter()
                    .flatten()
                    .collect();
                legal_witnesses(net, q, &index, &legal);
                assert_eq!(
                    owner.prefix_cache_diagnostics_for_test(),
                    Some(built),
                    "runs must not mutate retained setup"
                );
            }
        }
    }
    nonempty
}

#[test]
fn prepared_prefix_reuse_matches_raw_full_m4_and_every_canonical_filter_on_200_networks() {
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
    assert!(nonempty > 35, "sparse reuse corpus: {nonempty}");
}

#[test]
fn prepared_prefix_reuse_invalidates_every_changed_or_failed_prepare_and_clear() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<DeadlineSession>();
    let net = lattice(4, 0, false);
    let original = query(0, 2, 900, 2);
    let base = config(
        900..1200,
        1314,
        DeadlinePruning::EarliestPrefixAndTimetablePoints,
    );
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let mut cached =
            DeadlineSession::new(Reader::from_bytes(net.bytes()).unwrap(), mode, None).unwrap();
        let mut fresh =
            DeadlineSession::new(Reader::from_bytes(net.bytes()).unwrap(), mode, None).unwrap();
        for case in 0..14 {
            let mut q = original.clone();
            let mut c = base.clone();
            match case {
                1 => q.entry_stops[0].walk_secs = 10,
                2 => q.exit_stops[0].walk_secs = 20,
                3 => {
                    q.entry_stops[0].stop = 2;
                    q.exit_stops[0].stop = 0;
                }
                4 => q.date += 1,
                5 => q.mobility = Mobility::Wheelchair,
                6 => q.excluded_modes = vec![3],
                7 => q.max_rounds = Some(0),
                8 => q.max_rounds = Some(3),
                9 => c.window.start += 10,
                10 => c.window.end = 1100,
                11 => c.arrival_deadline += 10,
                12 => c.witness_comparison = DeadlineWitnessComparison::MaterializedDateMemo,
                13 => q.entry_stops.push(q.entry_stops[0]),
                _ => {}
            }
            cached
                .prepare_with_prefix_cache(q.clone(), c.clone())
                .unwrap();
            fresh.prepare(q.clone(), c.clone()).unwrap();
            q.entry_stops[0].stop = u32::MAX;
            c.max_stop_scans = 1; // caller-owned clones cannot mutate the slot
            let a = cached.run().unwrap();
            let b = fresh.run().unwrap();
            assert_eq!(a.points, b.points);
            assert_eq!(a.diagnostics, b.diagnostics);
            assert_owned_winners(&cached, &b.points);
        }
        for unsupported in 0..7 {
            cached
                .prepare_with_prefix_cache(original.clone(), base.clone())
                .unwrap();
            assert!(cached.prefix_cache_diagnostics_for_test().is_some());
            let mut c = base.clone();
            match unsupported {
                0 => c.static_bound = true,
                1 => {
                    c.walking_bound = true;
                    c.pruning = DeadlinePruning::EarliestPrefix;
                }
                2 => c.forward_seeds = true,
                3 => c.raptor_seeds = true,
                4 => c.raptor_destination_ordering = true,
                5 => c.objectives = ProfileObjectives::R3,
                _ => c.pruning = DeadlinePruning::None,
            }
            assert!(cached
                .prepare_with_prefix_cache(original.clone(), c)
                .is_err());
            assert!(cached.prefix_cache_diagnostics_for_test().is_none());
            assert!(cached.run().is_err());
        }
        let mut invalid = original.clone();
        invalid.entry_stops[0].stop = u32::MAX;
        cached
            .prepare_with_prefix_cache(original.clone(), base.clone())
            .unwrap();
        assert!(cached
            .prepare_with_prefix_cache(invalid, base.clone())
            .is_err());
        assert!(cached.run().is_err());
        assert!(cached.prefix_cache_diagnostics_for_test().is_none());
        for reusing in [false, true] {
            cached
                .prepare_with_prefix_cache(original.clone(), base.clone())
                .unwrap();
            if reusing {
                cached
                    .prepare_reusing(original.clone(), base.clone())
                    .unwrap();
            } else {
                cached.prepare(original.clone(), base.clone()).unwrap();
            }
            assert!(cached.prefix_cache_diagnostics_for_test().is_none());
            cached
                .prepare_with_prefix_cache(original.clone(), base.clone())
                .unwrap();
            cached.invalidate_request();
            assert!(cached.run().is_err());
            assert!(cached.prefix_cache_diagnostics_for_test().is_none());
            cached
                .prepare_with_prefix_cache(original.clone(), base.clone())
                .unwrap();
            cached.clear();
            assert!(cached.run().is_err());
            assert_eq!(cached.catalogue_key(), None);
            assert!(cached.prefix_cache_diagnostics_for_test().is_none());
        }
    }
}

#[test]
fn prepared_prefix_reuse_replays_each_cap_and_failed_build_without_partial_setup() {
    let net = lattice(2, 1, false);
    let q = query(0, 2, 900, 2);
    for pruning in [
        DeadlinePruning::EarliestPrefixAndPoints,
        DeadlinePruning::EarliestPrefixAndTimetablePoints,
    ] {
        let base = config(900..1200, 1314, pruning);
        let mut owner = DeadlineSession::new(
            Reader::from_bytes(net.bytes()).unwrap(),
            PatternMode::Off,
            None,
        )
        .unwrap();
        owner.prepare(q.clone(), base.clone()).unwrap();
        let full = owner
            .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
            .unwrap();
        let d = full.diagnostics;
        let stop = d.seed_event_checks
            + d.stop_events_scanned
            + d.prefix.event_scans
            + d.prefix.walking_relaxations
            + d.prefix.timetable.work();
        for (kind, bound) in [
            (0, d.lazy.work),
            (1, stop),
            (2, d.segments_enqueued),
            (3, d.max_frontier_width),
        ] {
            for cap in 1..=bound + 1 {
                let mut c = base.clone();
                match kind {
                    0 => c.max_lookup_work = cap,
                    1 => c.max_stop_scans = cap,
                    2 => c.max_segments = cap,
                    _ => c.max_frontier_width = cap,
                }
                owner.prepare_with_prefix_cache(q.clone(), c).unwrap();
                for _ in 0..2 {
                    let mut phases = Vec::new();
                    let a = owner
                        .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |p| {
                            phases.push(p)
                        });
                    let mut reference_phases = Vec::new();
                    let b = owner
                        .run_portfolio_checked_with_phases(DeadlineSuffixPruning::RowPrefix, |p| {
                            reference_phases.push(p)
                        });
                    assert_eq!(phases, reference_phases);
                    match (a, b) {
                        (Ok(a), Ok(b)) => {
                            assert!(cap >= bound);
                            assert_eq!(a.winners, b.winners);
                            assert_eq!(a.diagnostics, d);
                            assert_eq!(a.diagnostics, b.diagnostics);
                        }
                        (Err(a), Err(b)) => {
                            assert!(cap < bound);
                            assert_eq!(a, b);
                            if kind == 1
                                && cap
                                    < d.prefix.event_scans
                                        + d.prefix.walking_relaxations
                                        + d.prefix.timetable.work()
                            {
                                assert!(owner.prefix_cache_diagnostics_for_test().is_none());
                                assert!(phases.is_empty());
                            }
                        }
                        other => panic!("cached cap drift: {other:?}"),
                    }
                    for pref in DeadlinePreference::ALL {
                        let a = owner.run_preference_with_phases(
                            pref,
                            DeadlineSuffixPruning::RowPrefix,
                            |_| {},
                        );
                        let b = owner.run_preference_checked_with_phases(
                            pref,
                            DeadlineSuffixPruning::RowPrefix,
                            |_| {},
                        );
                        match (a, b) {
                            (Ok(a), Ok(b)) => {
                                assert_eq!(a.winner, b.winner);
                                assert_eq!(a.diagnostics, b.diagnostics);
                            }
                            (Err(a), Err(b)) => assert_eq!(a, b),
                            other => panic!("single cap drift: {other:?}"),
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn prepared_prefix_reuse_preserves_rules_loops_frequency_dst_and_directed_walking() {
    let mut net = Net::new(3, 3);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 900), (1, 1000)]);
    let b = net.trip(2, &[(1, 1200), (2, 1300)]);
    net.transfers.push((1, 1, ABSENT, ABSENT, a, b, ABSENT, 3));
    net.transfers.push((0, 1, ABSENT, ABSENT, a, b, 0, 2));
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
fn setup_observer_preserves_markers_bindings_winners_work_and_deferred_failures() {
    use DeadlineSetupPhase::*;
    let expected = [
        Started,
        RequestInvalidated,
        RequestShapeValidated,
        CatalogueKeyComputed,
        EventCoverageValidated,
        PtbHashed,
        TransfersHashed,
        LayoutHashed,
        BindingComputed,
        EventsEnumerated,
        EventsSorted,
        ArrivalsIndexed,
        CatalogueCompacted,
        CatalogueValidated,
        RequestStored,
    ];
    let net = lattice(3, 1, false);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let make = || {
            DeadlineSession::new(
                Reader::from_bytes(net.bytes()).unwrap(),
                mode,
                net.ptft_table(),
            )
            .unwrap()
        };
        let (mut plain, mut observed) = (make(), make());
        for pruning in [
            DeadlinePruning::EarliestPrefixAndPoints,
            DeadlinePruning::EarliestPrefixAndTimetablePoints,
        ] {
            for cached in [false, true] {
                for cap in [1, 10_000_000] {
                    let q = query(0, 2, 900, 2);
                    let mut c = config(900..1200, 1314, pruning);
                    c.max_stop_scans = cap;
                    let mut phases = Vec::new();
                    let a = if cached {
                        plain.prepare_with_prefix_cache(q.clone(), c.clone())
                    } else {
                        plain.prepare(q.clone(), c.clone())
                    };
                    let b = if cached {
                        observed.prepare_with_prefix_cache_and_phases(q, c, |p| phases.push(p))
                    } else {
                        observed.prepare_with_phases(q, c, |p| phases.push(p))
                    };
                    assert_eq!(a, b);
                    let mut wanted = expected.to_vec();
                    if cached {
                        wanted.push(PrefixBuilt);
                    }
                    wanted.push(Completed);
                    assert_eq!(phases, wanted);
                    assert_eq!(plain.catalogue_key(), observed.catalogue_key());
                    for preference in DeadlinePreference::ALL {
                        let a = plain.run_preference_with_phases(
                            preference,
                            DeadlineSuffixPruning::RowPrefix,
                            |_| {},
                        );
                        let b = observed.run_preference_with_phases(
                            preference,
                            DeadlineSuffixPruning::RowPrefix,
                            |_| {},
                        );
                        match (a, b) {
                            (Ok(a), Ok(b)) => {
                                assert_eq!(a.winner, b.winner);
                                assert_eq!(a.diagnostics, b.diagnostics);
                                assert_eq!(a.frontiers, b.frontiers);
                                assert_eq!(a.selection, b.selection);
                            }
                            (Err(a), Err(b)) => assert_eq!(a, b),
                            other => panic!("observer drift: {other:?}"),
                        }
                    }
                    assert_eq!(
                        plain.run().map(|r| (r.points, r.diagnostics)),
                        observed.run().map(|r| (r.points, r.diagnostics))
                    );
                }
            }
        }
    }
}

#[test]
fn setup_observer_failed_preparation_never_completes_or_leaves_old_request_runnable() {
    use DeadlineSetupPhase::*;
    let net = lattice(2, 0, false);
    let mut owner = DeadlineSession::new(
        Reader::from_bytes(net.bytes()).unwrap(),
        PatternMode::Off,
        None,
    )
    .unwrap();
    let base = config(
        900..1200,
        1314,
        DeadlinePruning::EarliestPrefixAndTimetablePoints,
    );
    for cached in [false, true] {
        for failure in 0..3 {
            let original = query(0, 2, 900, 2);
            owner.prepare(original.clone(), base.clone()).unwrap();
            let (mut q, mut c) = (original, base.clone());
            match failure {
                0 => q.entry_stops[0].stop = u32::MAX,
                1 => q.date = 19000101,
                _ => c.arrival_deadline = 9_000_000,
            }
            let mut phases = Vec::new();
            let result = if cached {
                owner.prepare_with_prefix_cache_and_phases(q.clone(), c.clone(), |p| phases.push(p))
            } else {
                owner.prepare_with_phases(q.clone(), c.clone(), |p| phases.push(p))
            };
            assert!(result.is_err());
            assert_eq!(phases.first(), Some(&Started));
            assert!(!phases.contains(&Completed));
            assert!(owner.run().is_err());
            let reference = if cached {
                owner.prepare_with_prefix_cache(q, c)
            } else {
                owner.prepare(q, c)
            };
            assert_eq!(result, reference);
        }
    }
    owner.prepare(query(0, 2, 900, 2), base.clone()).unwrap();
    let mut unsupported = base;
    unsupported.static_bound = true;
    let mut phases = Vec::new();
    assert!(owner
        .prepare_with_prefix_cache_and_phases(query(0, 2, 900, 2), unsupported, |p| phases.push(p))
        .is_err());
    assert_eq!(phases, [Started]);
    assert!(owner.run().is_err());
}
