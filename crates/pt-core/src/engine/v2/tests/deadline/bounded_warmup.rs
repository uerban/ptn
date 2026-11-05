//! Scheduling only; independent oracle, migration and aggregate-cap checks.
use super::*;

fn check(net: &Net, q: &Query, window: core::ops::Range<i64>, deadline: i64) -> bool {
    check_policies(
        net,
        q,
        window,
        deadline,
        &[
            (
                DeadlineTraversal::DepartureWarmup64,
                DeadlinePruning::EarliestPrefixAndPoints,
            ),
            (
                DeadlineTraversal::OriginPrefixWarmup,
                DeadlinePruning::EarliestPrefixAndPoints,
            ),
        ],
    )
}

pub(super) fn check_policies(
    net: &Net,
    q: &Query,
    window: core::ops::Range<i64>,
    deadline: i64,
    policies: &[(DeadlineTraversal, DeadlinePruning)],
) -> bool {
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
        assert_eq!(tuples(&points, ProfileObjectives::M4), raw, "raw {mode:?}");
        nonempty |= !points.is_empty();
        let expected = DeadlinePortfolioWinners::from_m4_points(&points);
        let mut owner = DeadlineSession::new(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        for date in [
            DeadlineWitnessComparison::Materialized,
            DeadlineWitnessComparison::MaterializedDateMemo,
        ] {
            for &(traversal, pruning) in policies {
                let mut c = DeadlineSessionConfig::new(window.clone(), deadline);
                c.lookup = LazyLookupMode::PlainCached;
                c.pruning = pruning;
                c.traversal = traversal;
                c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
                c.witness_comparison = date;
                owner.prepare(q.clone(), c).unwrap();
                if pruning == DeadlinePruning::EarliestPrefixAndTimetablePoints {
                    let profile = owner.run().unwrap();
                    assert!(profile.complete);
                    assert_eq!(
                        profile.points, points,
                        "timetable full canonical {mode:?}/{date:?}"
                    );
                    assert_eq!(
                        profile.diagnostics.prefix.enabled,
                        profile.diagnostics.prefix.timetable.enabled
                    );
                }
                let key = owner.catalogue_key();
                let mut phases = Vec::new();
                let all = owner
                    .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |p| phases.push(p))
                    .unwrap();
                assert_eq!(
                    phases,
                    [DeadlinePhase::Prepared, DeadlinePhase::SearchFinished]
                );
                assert!(all.complete);
                assert_eq!(all.winners, expected, "canonical {mode:?}/{date:?}");
                let legal: Vec<_> = all
                    .winners
                    .by_preference
                    .iter()
                    .flatten()
                    .cloned()
                    .collect();
                legal_witnesses(net, q, &index, &legal);
                let d = all.diagnostics;
                if traversal == DeadlineTraversal::DepartureWarmup64 {
                    assert_eq!(d.warmup.preferred_scans, d.segments_scanned.min(64));
                    assert_eq!(d.warmup.restored, d.segments_scanned >= 64);
                    assert_eq!(d.origin_hint, OriginHintDiagnostics::default());
                } else if d.origin_hint.enabled {
                    assert!(d.origin_hint.index_bytes <= d.seed_event_checks);
                    assert!(d.warmup.preferred_scans <= d.segments_scanned.min(64));
                    assert!(
                        !d.warmup.restored
                            || d.warmup.preferred_scans == 64
                            || d.warmup.points_at_restore > 0
                    );
                } else {
                    assert_eq!(d.warmup, DeadlineWarmupDiagnostics::default());
                }
                assert!(d.warmup.live_requeued <= d.warmup.pending_at_restore);
                assert_eq!(d.forward, ForwardSeedDiagnostics::default());
                for pref in DeadlinePreference::ALL {
                    let r = owner
                        .run_preference_with_phases(pref, DeadlineSuffixPruning::RowPrefix, |_| {})
                        .unwrap();
                    assert!(r.complete);
                    assert_eq!(
                        r.winner,
                        pref.from_m4_points(&points),
                        "single {mode:?}/{date:?}/{pref:?}"
                    );
                    if traversal == DeadlineTraversal::DepartureWarmup64 {
                        assert_eq!(
                            r.diagnostics.warmup.preferred_scans,
                            r.diagnostics.segments_scanned.min(64)
                        );
                    }
                }
                assert_eq!(owner.catalogue_key(), key);
            }
        }
    }
    nonempty
}

#[test]
fn bounded_warmup_matches_raw_and_forward_oracles_on_200_networks() {
    let mut rng = Rng(0x5741_524d_5550_3634);
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
    assert!(nonempty > 35, "sparse bounded warmup corpus: {nonempty}");
}

#[test]
fn bounded_warmup_crosses_boundary_keeps_all_filters_and_never_resets_caps() {
    let mut net = Net::new(2, 1);
    for i in 0..128 {
        net.trip(0, &[(0, 1000 + i * 2), (1, 2000 + i)]);
    }
    assert!(check(&net, &query(0, 1, 1000, 1), 1000..1300, 2200));
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let q = query(0, 1, 1000, 1);
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(q.date, 1000..2201),
    )
    .unwrap();
    let mut r = DeadlineRequest::new(&q, 1000..1300, 2200);
    r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
    r.traversal = DeadlineTraversal::DepartureWarmup64;
    r.frontier_storage = DeadlineFrontierStorage::EventIndexed;
    let full = query_deadline_portfolio_with_suffix_pruning(
        &reader,
        &index,
        &events,
        r.clone(),
        DeadlineSuffixPruning::RowPrefix,
        |_| {},
    )
    .unwrap();
    let d = full.diagnostics;
    assert_eq!(d.segments_scanned, 128);
    assert_eq!(d.warmup.preferred_scans, 64);
    assert!(d.warmup.restored);
    assert_eq!(d.warmup.pending_at_restore, 64);
    assert_eq!(d.warmup.live_requeued, 64);
    assert!(d.warmup.points_at_restore > 0);
    assert!(d.warmup.additional_queue_capacity_bytes >= 64 * core::mem::size_of::<usize>());
    let stop_work = d.seed_event_checks
        + d.stop_events_scanned
        + d.prefix.event_scans
        + d.prefix.walking_relaxations
        + d.optimistic.work()
        + d.forward.stop_work();
    // This limit is reached AFTER the switch, not during setup or seeding.
    let mut capped = r.clone();
    capped.max_stop_scans = stop_work - 1;
    let mut phases = Vec::new();
    assert_eq!(
        query_deadline_portfolio_with_suffix_pruning(
            &reader,
            &index,
            &events,
            capped,
            DeadlineSuffixPruning::RowPrefix,
            |p| phases.push(p)
        )
        .unwrap_err(),
        DeadlineError::StopScansExhausted {
            limit: stop_work - 1,
            attempted: stop_work
        }
    );
    assert_eq!(phases, [DeadlinePhase::Prepared]);
    r.max_stop_scans = stop_work;
    let at_cap = query_deadline_portfolio_with_suffix_pruning(
        &reader,
        &index,
        &events,
        r,
        DeadlineSuffixPruning::RowPrefix,
        |_| {},
    )
    .unwrap();
    assert_eq!(at_cap.winners, full.winners);
    assert_eq!(at_cap.diagnostics, d);

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
    r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
    for traversal in [
        DeadlineTraversal::DepartureWarmup64,
        DeadlineTraversal::OriginPrefixWarmup,
    ] {
        r.traversal = traversal;
        let full = query_deadline_portfolio(&reader, &index, &events, r.clone()).unwrap();
        let d = full.diagnostics;
        let stop = d.seed_event_checks
            + d.stop_events_scanned
            + d.prefix.event_scans
            + d.prefix.walking_relaxations
            + d.optimistic.work();
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
                            matches!((kind, e), (0, DeadlineError::Lookup(LazyLookupError::WorkExhausted { limit, attempted })) | (1, DeadlineError::StopScansExhausted { limit, attempted }) | (2, DeadlineError::SegmentsExhausted { limit, attempted }) | (3, DeadlineError::FrontierExhausted { limit, attempted }) if limit == cap && attempted > cap)
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn bounded_warmup_origin_hint_finds_connected_vehicle_and_charges_no_hit_setup() {
    for reachable in [true, false] {
        let mut net = Net::new(3, 2);
        for i in 0..128 {
            net.trip(0, &[(2, 1000 + i), (1, 2000 + i)]);
        }
        if reachable {
            net.trip(1, &[(0, 1000), (1, 2200)]);
        }
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let q = query(0, 1, 900, 1);
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(q.date, 900..2301),
        )
        .unwrap();
        let mut r = DeadlineRequest::new(&q, 900..1500, 2300);
        r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
        r.traversal = DeadlineTraversal::OriginPrefixWarmup;
        let candidate = query_deadline_portfolio(&reader, &index, &events, r.clone()).unwrap();
        let d = candidate.diagnostics;
        assert!(d.origin_hint.enabled);
        assert_eq!(d.origin_hint.index_bytes, events.events().len());
        assert_eq!(d.origin_hint.checks, 128 + usize::from(reachable));
        assert_eq!(
            d.seed_event_checks,
            events.events().len() + d.origin_hint.checks
        );
        assert_eq!(d.warmup.preferred_scans, if reachable { 1 } else { 64 });
        assert!(d.warmup.restored);
        assert_eq!(d.warmup.points_at_restore, usize::from(reachable));
        let stop = d.seed_event_checks
            + d.stop_events_scanned
            + d.prefix.event_scans
            + d.prefix.walking_relaxations;
        let mut capped = r.clone();
        capped.max_stop_scans = stop - 1;
        assert_eq!(
            query_deadline_portfolio(&reader, &index, &events, capped).unwrap_err(),
            DeadlineError::StopScansExhausted {
                limit: stop - 1,
                attempted: stop
            }
        );
        r.traversal = DeadlineTraversal::ArrivalFirst;
        let base = query_deadline_portfolio(&reader, &index, &events, r).unwrap();
        assert_eq!(candidate.winners, base.winners);
        assert_eq!(
            base.diagnostics.origin_hint,
            OriginHintDiagnostics::default()
        );
    }
}

#[test]
fn bounded_warmup_preserves_scoped_rules_inseat_frequencies_lassos_and_empty_ties() {
    let mut net = Net::new(3, 3);
    let banned = net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 900), (1, 1000)]);
    let onward = net.trip(2, &[(1, 1200), (2, 1300)]);
    net.transfers
        .push((1, 1, ABSENT, ABSENT, banned, onward, ABSENT, 3));
    assert!(check(&net, &query(0, 2, 900, 2), 900..901, 1300));
    let mut net = Net::new(3, 2);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    let b = net.trip(1, &[(1, 1050), (2, 1200)]);
    net.boarding = vec![0x50, 0x54, 0x51, 0x50];
    net.transfers.push((1, 1, ABSENT, ABSENT, a, b, ABSENT, 4));
    assert!(check(&net, &query(0, 2, 900, 2), 900..901, 1200));
    assert!(!check(&net, &query(0, 2, 900, 1), 900..901, 1200));
    for exact in [0, 1] {
        let mut net = Net::new(4, 2);
        net.trip(0, &[(0, 86000), (1, 87000)]);
        let target = net.trip(1, &[(1, 87050), (2, 87200), (1, 87300), (3, 87400)]);
        net.freqs.push((target, 87050, 87551, 100, exact));
        let mut origins = utc_origins(START, DAYS as usize, 0);
        for origin in origins.iter_mut().skip(4) {
            *origin -= 3600;
        }
        net.origins = Some(origins);
        assert!(check(&net, &query(0, 3, 85000, 2), 85000..87001, 88000));
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
    let mut net = Net::new(2, 1);
    for _ in 0..128 {
        net.trip(0, &[(0, 900), (1, 1000)]);
    }
    assert!(check(&net, &query(0, 1, 900, 1), 900..901, 1000));
    assert!(!check(&net, &query(1, 0, 900, 1), 900..901, 1000));
}
