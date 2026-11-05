//! H79: transfer profiles against full canonical forward/raw references.
use super::*;
fn check_transfer_profile(
    net: &Net,
    q: &Query,
    window: core::ops::Range<i64>,
    deadline: i64,
) -> bool {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let walks = net.ptft_table();
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
        let raw: Vec<_> = expected(net, q, &window, ProfileObjectives::M4)
            .into_iter()
            .filter(|p| p.1 <= deadline)
            .collect();
        assert_eq!(tuples(&points, ProfileObjectives::M4), raw);
        nonempty |= !points.is_empty();
        let mut cached = DeadlineSession::new_with_immutable_binding(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        let mut rebuilt = DeadlineSession::new_with_immutable_binding(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        for pruning in [
            DeadlinePruning::EarliestPrefixAndPoints,
            DeadlinePruning::EarliestPrefixAndTimetablePoints,
        ] {
            let mut c = DeadlineSessionConfig::new(window.clone(), deadline);
            c.lookup = LazyLookupMode::PlainCached;
            c.pruning = pruning;
            c.walking_bound = true;
            c.transfer_bound = true;
            c.traversal = DeadlineTraversal::ArrivalFirst;
            c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
            cached
                .prepare_with_prefix_cache(q.clone(), c.clone())
                .unwrap();
            rebuilt.prepare(q.clone(), c.clone()).unwrap();
            let built = cached.prefix_cache_diagnostics_for_test().unwrap();
            assert_eq!(built.walking_enabled, built.enabled);
            assert_eq!(cached.run().unwrap().points, points);
            for _ in 0..2 {
                let a = cached
                    .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
                    .unwrap();
                let b = rebuilt
                    .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
                    .unwrap();
                assert_eq!(a.winners, DeadlinePortfolioWinners::from_m4_points(&points));
                assert_eq!(a.winners, b.winners);
                assert_eq!(a.diagnostics, b.diagnostics);
                assert_eq!(cached.prefix_cache_diagnostics_for_test(), Some(built));
                assert_owned_winners(&cached, &points);
            }
            let work =
                (built.event_scans + built.walking_relaxations + built.timetable.work()).max(2);
            for cap in [1, work - 1, work] {
                c.max_stop_scans = cap;
                cached
                    .prepare_with_prefix_cache(q.clone(), c.clone())
                    .unwrap();
                rebuilt.prepare(q.clone(), c.clone()).unwrap();
                assert_eq!(
                    cached.run().map(|r| (r.points, r.diagnostics)),
                    rebuilt.run().map(|r| (r.points, r.diagnostics))
                );
            }
            cached.clear();
            assert!(cached.prefix_cache_diagnostics_for_test().is_none());
            assert!(cached.run().is_err());
        }
    }
    nonempty
}

fn chain(net: &mut Net, rng: &mut Rng) {
    let nt = net.trips.len();
    let a = rng.below(nt as u64) as usize;
    let b = (a + 1 + rng.below(nt as u64 - 1) as usize) % nt;
    if net
        .freqs
        .iter()
        .any(|f| f.0 as usize == a || f.0 as usize == b)
    {
        return;
    }
    let (last_stop, last_t) = net.trips[a].rows.last().map(|r| (r.0, r.1)).unwrap();
    let off = last_t as i64 + rng.below(151) as i64 - net.trips[b].rows[0].1 as i64;
    net.trips[b].rows[0].0 = last_stop;
    for r in net.trips[b].rows.iter_mut() {
        r.1 = (r.1 as i64 + off) as u32;
    }
    let mut used = vec![last_stop];
    for i in 1..net.trips[b].rows.len() {
        let mut s = net.trips[b].rows[i].0;
        while used.contains(&s) {
            s = (s + 1) % 5;
        }
        used.push(s);
        net.trips[b].rows[i].0 = s;
    }
    net.n_routes += 1;
    net.trips[b].route = net.n_routes - 1;
    net.trips[b].service = net.trips[a].service;
    let block = ["P", "Q", "R"][rng.below(3) as usize];
    net.trips[a].block = Some(block);
    net.trips[b].block = Some(block);
}

#[test]
fn transfer_profile_matches_raw_canonical_winners_caps_and_prepared_runs() {
    let mut rng = Rng(0x4837_3954_5241_4e53);
    let mut nonempty = 0;
    let mut derived = 0;
    for _ in 0..100 {
        let mut net = random_net(&mut rng);
        for _ in 0..1 + rng.below(3) {
            chain(&mut net, &mut rng);
        }
        net.derive = true;
        net.transfers.retain(|r| r.7 < 4);
        net.strip = rng.chance(50);
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        if !Index::build(&reader, PatternMode::Off)
            .unwrap()
            .v2
            .as_ref()
            .unwrap()
            .derived
            .is_empty()
        {
            derived += 1;
        }
        let mut q = query(
            rng.below(5) as u32,
            rng.below(5) as u32,
            68000,
            1 + rng.below(4) as u32,
        );
        q.entry_stops[0].walk_secs = rng.below(120) as u32;
        q.exit_stops[0].walk_secs = rng.below(120) as u32;
        vary_walk_settings(&mut rng, &mut q);
        if check_transfer_profile(&net, &q, 68000..72000, 78000) {
            nonempty += 1;
        }
    }
    assert!(derived > 40, "sparse derived corpus {derived}");
    assert!(nonempty > 10, "sparse nonempty corpus {nonempty}");
}

#[test]
fn transfer_profile_restores_ordinary_credit_without_charging_inseat_as_transfer() {
    for real_inseat in [false, true] {
        let mut net = Net::new(5, 4);
        let a = net.trip(0, &[(0, 900), (1, 1000)]);
        let b = net.trip(1, &[(1, 1120), (2, 1300)]);
        let remote_a = net.trip(2, &[(3, 900), (4, 1000)]);
        let remote_b = net.trip(3, &[(4, 1000), (3, 1100)]);
        net.trips[remote_a as usize].block = Some("remote");
        net.trips[remote_b as usize].block = Some("remote");
        if real_inseat {
            net.trips[a as usize].block = Some("real");
            net.trips[b as usize].block = Some("real");
        }
        net.derive = true;
        let q = query(0, 2, 900, 3);
        assert!(check_transfer_profile(&net, &q, 900..901, 1300));
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        for mode in [
            PatternMode::Off,
            PatternMode::Unbounded,
            PatternMode::CoveringMerge,
        ] {
            let index = Index::build(&reader, mode).unwrap();
            assert!(!index.v2.as_ref().unwrap().derived.is_empty());
            assert_eq!(
                index
                    .v2
                    .as_ref()
                    .unwrap()
                    .derived
                    .iter()
                    .any(|(&(trip, _), targets)| trip == a && targets.contains(&b)),
                real_inseat
            );
            let events = build_event_index(
                &reader,
                &index,
                None,
                &TransferIndexConfig::for_query(&q, 900..1301),
            )
            .unwrap();
            let mut r = DeadlineRequest::new(&q, 900..901, 1300);
            r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
            assert_eq!(
                transfer_lowers_for_test(&reader, &index, &events, &r, &[(1, 1, 1120)]),
                [Some(0)]
            );
            r.transfer_bound = true;
            assert_eq!(
                transfer_lowers_for_test(&reader, &index, &events, &r, &[(1, 1, 1120)]),
                [Some(if real_inseat { 0 } else { 1 })]
            );
        }
    }
}

#[test]
fn transfer_profile_caps_and_disabled_path_keep_work_accounting() {
    for derived in [false, true] {
        let mut net = Net::new(5, 4);
        net.trip(0, &[(0, 900), (1, 1000)]);
        net.trip(1, &[(1, 1120), (2, 1300)]);
        let a = net.trip(2, &[(3, 900), (4, 1000)]);
        let b = net.trip(3, &[(4, 1000), (3, 1100)]);
        if derived {
            net.trips[a as usize].block = Some("remote");
            net.trips[b as usize].block = Some("remote");
            net.derive = true;
        }
        let q = query(0, 2, 900, 3);
        let make = || {
            DeadlineSession::new_with_immutable_binding(
                Reader::from_bytes(net.bytes()).unwrap(),
                PatternMode::CoveringMerge,
                None,
            )
            .unwrap()
        };
        let mut c = DeadlineSessionConfig::new(900..901, 1300);
        c.pruning = DeadlinePruning::EarliestPrefixAndTimetablePoints;
        c.walking_bound = true;
        c.transfer_bound = true;
        c.lookup = LazyLookupMode::PlainCached;
        c.traversal = DeadlineTraversal::ArrivalFirst;
        let (mut cached, mut fresh) = (make(), make());
        cached
            .prepare_with_prefix_cache(q.clone(), c.clone())
            .unwrap();
        let full = cached
            .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
            .unwrap();
        let built = cached.prefix_cache_diagnostics_for_test().unwrap();
        assert_eq!(built.transfer_bound_enabled, derived);
        assert_eq!(
            built.transfer_bound_bytes,
            if derived {
                3 * (core::mem::size_of::<Vec<u32>>() + 5 * 4)
            } else {
                0
            }
        );
        {
            let mut off = c.clone();
            off.transfer_bound = false;
            fresh.prepare_with_prefix_cache(q.clone(), off).unwrap();
            let old = fresh
                .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
                .unwrap();
            assert_eq!(full.search.winners, old.search.winners);
            assert_eq!(
                full.search.diagnostics.prefix.event_scans,
                old.search.diagnostics.prefix.event_scans
            );
            assert_eq!(
                full.search.diagnostics.prefix.walking_relaxations,
                old.search.diagnostics.prefix.walking_relaxations
            );
            assert_eq!(
                full.search.diagnostics.prefix.timetable,
                old.search.diagnostics.prefix.timetable
            );
            if !derived {
                assert_eq!(full.search.diagnostics, old.search.diagnostics);
                assert_eq!(full.projection, old.projection);
            }
            let reader = Reader::from_bytes(net.bytes()).unwrap();
            let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
            let events = build_event_index(
                &reader,
                &index,
                None,
                &TransferIndexConfig::for_query(&q, 900..1301),
            )
            .unwrap();
            assert_eq!(
                full.search.diagnostics.prefix.event_scans,
                2 * events.events().len()
            );
        }
        let used = full.projection.aggregate_stop_work;
        for cap in 1..=used {
            c.max_stop_scans = cap;
            cached
                .prepare_with_prefix_cache(q.clone(), c.clone())
                .unwrap();
            fresh.prepare(q.clone(), c.clone()).unwrap();
            let a = cached
                .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
                .map(|r| (r.search.winners, r.search.diagnostics, r.projection));
            let b = fresh
                .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
                .map(|r| (r.search.winners, r.search.diagnostics, r.projection));
            assert_eq!(a, b, "derived{derived}/cap{cap}");
            if cap == used {
                assert_eq!(a.unwrap().0, full.search.winners);
            } else {
                assert!(a.is_err());
            }
        }
        c.max_stop_scans = 10_000_000;
        c.pruning = DeadlinePruning::None;
        assert!(cached.prepare_with_prefix_cache(q, c).is_err());
        assert!(cached.run().is_err());
    }
}

#[test]
fn transfer_profile_counts_multiple_ordinary_connections() {
    let mut net = Net::new(6, 5);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1120), (2, 1200)]);
    net.trip(2, &[(2, 1320), (3, 1400)]);
    let a = net.trip(3, &[(4, 900), (5, 1000)]);
    let b = net.trip(4, &[(5, 1000), (4, 1100)]);
    net.trips[a as usize].block = Some("remote");
    net.trips[b as usize].block = Some("remote");
    net.derive = true;
    let q = query(0, 3, 900, 4);
    assert!(check_transfer_profile(&net, &q, 900..901, 1400));
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::for_query(&q, 900..1401),
    )
    .unwrap();
    let mut r = DeadlineRequest::new(&q, 900..901, 1400);
    r.pruning = DeadlinePruning::EarliestPrefixAndTimetablePoints;
    r.transfer_bound = true;
    assert_eq!(
        transfer_lowers_for_test(&reader, &index, &events, &r, &[(2, 2, 1320)]),
        [Some(2)]
    );
}

#[test]
fn transfer_profile_rules_loops_frequency_dst_and_directed_walking() {
    let mut net = Net::new(3, 3);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 900), (1, 1000)]);
    let b = net.trip(2, &[(1, 1200), (2, 1300)]);
    net.transfers.push((1, 1, ABSENT, ABSENT, a, b, ABSENT, 3));
    net.transfers.push((0, 1, ABSENT, ABSENT, a, b, 0, 2));
    assert!(check_transfer_profile(
        &net,
        &query(0, 2, 900, 2),
        900..901,
        1300
    ));
    let mut net = Net::new(3, 2);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    let b = net.trip(1, &[(1, 1050), (2, 1200)]);
    net.boarding = vec![0x50, 0x54, 0x51, 0x50];
    net.transfers.push((1, 1, ABSENT, ABSENT, a, b, ABSENT, 4));
    assert!(check_transfer_profile(
        &net,
        &query(0, 2, 900, 2),
        900..901,
        1200
    ));
    for exact in [0, 1] {
        let mut net = Net::new(6, 4);
        net.trip(0, &[(0, 86000), (1, 87000)]);
        let t = net.trip(1, &[(1, 87200), (2, 87300), (1, 87400), (3, 87500)]);
        net.freqs.push((t, 87200, 87701, 100, exact));
        let remote_a = net.trip(2, &[(4, 85000), (5, 85100)]);
        let remote_b = net.trip(3, &[(5, 85100), (4, 85200)]);
        net.trips[remote_a as usize].block = Some("remote-frequency");
        net.trips[remote_b as usize].block = Some("remote-frequency");
        net.derive = true;
        let mut origins = utc_origins(START, DAYS as usize, 0);
        for origin in origins.iter_mut().skip(4) {
            *origin -= 3600;
        }
        net.origins = Some(origins);
        assert!(check_transfer_profile(
            &net,
            &query(0, 3, 85000, 2),
            85000..87001,
            88500
        ));
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
        assert!(check_transfer_profile(
            &net,
            &query(1, 0, 950, 2),
            950..1101,
            1300
        ));
    }
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (4, 1400), (3, 1500), (4, 1800)]);
    net.ptft.extend([(1, 2, 90), (1, 3, 30)]);
    assert!(check_transfer_profile(
        &net,
        &query(0, 4, 900, 2),
        900..901,
        1800
    ));
    assert!(!check_transfer_profile(
        &net,
        &query(4, 0, 900, 2),
        900..901,
        1800
    ));
}

#[test]
fn transfer_profile_rider_filters_and_walking_settings_match_canonical_references() {
    let mut net = Net::new(6, 5);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1120), (2, 1200)]);
    net.trip(2, &[(2, 1320), (3, 1400)]);
    let a = net.trip(3, &[(4, 900), (5, 1000)]);
    let b = net.trip(4, &[(5, 1000), (4, 1100)]);
    net.trips[a as usize].block = Some("remote-rider");
    net.trips[b as usize].block = Some("remote-rider");
    net.derive = true;
    net.ptft.extend([(1, 2, 70), (2, 1, 150)]);
    for mobility in [Mobility::Default, Mobility::Wheelchair, Mobility::Bicycle] {
        for floor in [0, 120, 300] {
            let mut q = query(0, 3, 883, 4);
            q.entry_stops[0].walk_secs = 17;
            q.exit_stops[0].walk_secs = 23;
            q.mobility = mobility;
            q.walk_speed_mm_s = core::num::NonZeroU32::new(800);
            q.min_transfer_secs = Some(floor);
            check_transfer_profile(&net, &q, 883..884, 1423);
            q.excluded_modes = vec![3];
            check_transfer_profile(&net, &q, 883..884, 1423);
        }
    }
}
