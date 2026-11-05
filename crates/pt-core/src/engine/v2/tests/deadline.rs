//! Deadline query versus full forward profiles and the independent raw oracle.
extern crate std;
use super::trip_profiles::{expected, legal_witnesses, tuples};
use super::*;
use crate::engine::temporal_probe::r3::{profile_m4, profile_r3, ProfileObjectives, R3Request};
use crate::engine::temporal_probe::trip_based::*;

mod bounded_warmup;
mod derived_prefix;
mod held_catalogue;
mod journey;
mod latest_scan;
mod owner_binding;
mod prefix_reuse;
mod prepared_walking;
mod selector_scan;
mod timetable_prefix;
mod transfer_profile;
mod trip_spans;
mod window_catalogue;
mod winner_ceiling;

fn assert_row_work(before: &LazyLookupDiagnostics, after: &LazyLookupDiagnostics) {
    let skipped = after.certified_source_rows_skipped;
    assert_eq!(before.pair_checks - after.pair_checks, skipped);
    assert!(after.instance_probes <= before.instance_probes);
    assert_eq!(
        after.event_probes + skipped,
        before.event_probes + after.row_bound_checks
    );
    assert_eq!(
        after.work + 2 * skipped + before.instance_probes - after.instance_probes,
        before.work + after.row_bound_checks
    );
    assert_eq!(
        before.plain_pair_checks - after.plain_pair_checks + before.fallback_pair_checks
            - after.fallback_pair_checks,
        skipped
    );
    let mut same = *after;
    same.work = before.work;
    same.event_probes = before.event_probes;
    same.pair_checks = before.pair_checks;
    same.plain_pair_checks = before.plain_pair_checks;
    same.fallback_pair_checks = before.fallback_pair_checks;
    same.instance_probes = before.instance_probes;
    same.row_bound_checks = before.row_bound_checks;
    same.certified_source_rows_skipped = before.certified_source_rows_skipped;
    assert_eq!(&same, before);
}

fn assert_ceiling_work(
    before: &LazyLookupDiagnostics,
    after: &LazyLookupDiagnostics,
    reference: DeadlinePortfolioDiagnostics,
    selected: DeadlinePortfolioDiagnostics,
) {
    assert!(after.row_bound_checks <= before.row_bound_checks);
    assert_eq!(
        after.event_probes + before.row_bound_checks,
        before.event_probes + after.row_bound_checks
    );
    assert_eq!(
        after.work + before.row_bound_checks,
        before.work + after.row_bound_checks
    );
    let mut same = *after;
    same.work = before.work;
    same.event_probes = before.event_probes;
    same.row_bound_checks = before.row_bound_checks;
    assert_eq!(&same, before);
    let mut same = selected;
    same.row_ceiling_builds = 0;
    same.row_ceiling_selectors = 0;
    same.row_ceiling_disabled = 0;
    assert_eq!(same, reference);
    assert!(selected.row_ceiling_disabled <= selected.row_ceiling_builds);
    assert!(selected.row_ceiling_selectors >= selected.row_ceiling_builds);
    assert!(selected.row_ceiling_selectors <= 4 * selected.row_ceiling_builds);
    if !after.stop_indexed {
        assert_eq!(selected.row_ceiling_builds, 0);
    }
}

fn assert_owned_winners(
    session: &DeadlineSession,
    points: &[crate::engine::temporal_probe::r3::R3Point],
) {
    let mode = DeadlineSuffixPruning::RowPrefix;
    let mut phases = Vec::new();
    let a = session
        .run_portfolio_with_phases(mode, |p| phases.push(p))
        .unwrap();
    assert_eq!(
        phases,
        [DeadlinePhase::Prepared, DeadlinePhase::SearchFinished]
    );
    let b = session
        .run_portfolio_checked_with_phases(mode, |_| {})
        .unwrap();
    let repeated = session.run_portfolio_with_phases(mode, |_| {}).unwrap();
    for r in [&b, &repeated] {
        assert_eq!(a.winners, r.winners);
        assert_eq!(a.diagnostics, r.diagnostics);
        assert_eq!(a.frontiers, r.frontiers);
        assert_eq!(a.selection, r.selection);
        assert_eq!(a.window, r.window);
        assert_eq!(a.arrival_deadline, r.arrival_deadline);
        assert!(a.complete && r.complete);
    }
    assert_eq!(a.winners, DeadlinePortfolioWinners::from_m4_points(points));
    for preference in DeadlinePreference::ALL {
        let a = session
            .run_preference_with_phases(preference, mode, |_| {})
            .unwrap();
        let b = session
            .run_preference_checked_with_phases(preference, mode, |_| {})
            .unwrap();
        assert_eq!(a.winner, preference.from_m4_points(points));
        assert_eq!(a.winner, b.winner);
        assert_eq!(a.diagnostics, b.diagnostics);
        assert_eq!(a.frontiers, b.frontiers);
        assert_eq!(a.selection, b.selection);
        assert_eq!(a.window, b.window);
        assert_eq!(a.arrival_deadline, b.arrival_deadline);
        assert_eq!(a.preference, preference);
        assert_eq!(b.preference, preference);
        assert!(a.complete && b.complete);
    }
}

fn assert_owned_error(session: &DeadlineSession, expected: DeadlineError) {
    let suffix = DeadlineSuffixPruning::RowPrefix;
    for preference in [None, Some(DeadlinePreference::LatestDeparture)] {
        assert_eq!(
            session
                .run_winner_incumbent_ceiling_with_phases(preference, suffix, |_| {})
                .unwrap_err(),
            DeadlineIncumbentCeilingError::Baseline(expected.clone())
        );
    }
    assert_eq!(
        session
            .run_portfolio_with_phases(suffix, |_| {})
            .unwrap_err(),
        expected
    );
    assert_eq!(
        session
            .run_portfolio_checked_with_phases(suffix, |_| {})
            .unwrap_err(),
        expected
    );
    for p in DeadlinePreference::ALL {
        assert_eq!(
            session
                .run_preference_with_phases(p, suffix, |_| {})
                .unwrap_err(),
            expected
        );
        assert_eq!(
            session
                .run_preference_checked_with_phases(p, suffix, |_| {})
                .unwrap_err(),
            expected
        );
    }
}

fn check(
    net: &Net,
    q: &Query,
    window: core::ops::Range<i64>,
    deadline: i64,
) -> Vec<(i64, i64, u32, u64)> {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let walks = net.ptft_table();
    let cfg = TransferIndexConfig::for_query(q, window.start..deadline + 1);
    let mut m4 = Vec::new();
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let events = build_event_index(&reader, &index, walks.as_ref(), &cfg).unwrap();
        let graph = build_transfer_index(&reader, &index, walks.as_ref(), &cfg).unwrap();
        let mut session = DeadlineSession::new(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        for objective in [ProfileObjectives::R3, ProfileObjectives::M4] {
            let mut request = R3Request::new(q, window.clone());
            request.transfers = walks.as_ref();
            request.max_labels = 1_000_000;
            let reference = match objective {
                ProfileObjectives::R3 => profile_r3(&reader, &index, request),
                ProfileObjectives::M4 => profile_m4(&reader, &index, request),
            }
            .unwrap();
            let points: Vec<_> = reference
                .points
                .into_iter()
                .filter(|p| p.destination_arrival_secs <= deadline)
                .collect();
            // The raw oracle accepts one entry/exit pair. Combine its independent
            // runs, then take the global skyline; do not constrain the fixture.
            let mut all = Vec::new();
            for entry in &q.entry_stops {
                for exit in &q.exit_stops {
                    let mut single = q.clone();
                    single.entry_stops = vec![*entry];
                    single.exit_stops = vec![*exit];
                    all.extend(
                        expected(net, &single, &window, objective)
                            .into_iter()
                            .filter(|p| p.1 <= deadline),
                    );
                }
            }
            all.sort_unstable();
            all.dedup();
            let want: Vec<_> = all
                .iter()
                .copied()
                .filter(|p| {
                    !all.iter()
                        .any(|a| a != p && a.0 >= p.0 && a.1 <= p.1 && a.2 <= p.2 && a.3 <= p.3)
                })
                .collect();
            for (lookup, pruning, static_bound, walking_bound, forward_seeds) in [
                (DeadlineLookup::Graph(&graph), DeadlinePruning::None, false),
                (
                    DeadlineLookup::Lazy(LazyLookupMode::ScanAll),
                    DeadlinePruning::None,
                    false,
                ),
                (
                    DeadlineLookup::Lazy(LazyLookupMode::StopIndexed),
                    DeadlinePruning::None,
                    false,
                ),
                (
                    DeadlineLookup::Lazy(LazyLookupMode::PlainFast),
                    DeadlinePruning::None,
                    false,
                ),
                (
                    DeadlineLookup::Lazy(LazyLookupMode::PlainFast),
                    DeadlinePruning::EarliestPrefix,
                    false,
                ),
                (
                    DeadlineLookup::Graph(&graph),
                    DeadlinePruning::EarliestPrefixAndPoints,
                    false,
                ),
                (
                    DeadlineLookup::Lazy(LazyLookupMode::PlainFast),
                    DeadlinePruning::EarliestPrefixAndPoints,
                    false,
                ),
                (
                    DeadlineLookup::Lazy(LazyLookupMode::PlainCached),
                    DeadlinePruning::EarliestPrefixAndPoints,
                    false,
                ),
                (
                    DeadlineLookup::Lazy(LazyLookupMode::PlainCachedPacked),
                    DeadlinePruning::EarliestPrefixAndPoints,
                    false,
                ),
                (
                    DeadlineLookup::Graph(&graph),
                    DeadlinePruning::EarliestPrefixAndPoints,
                    true,
                ),
                (
                    DeadlineLookup::Lazy(LazyLookupMode::PlainFast),
                    DeadlinePruning::EarliestPrefixAndPoints,
                    true,
                ),
            ]
            .into_iter()
            .flat_map(|(lookup, pruning, static_bound)| {
                let mut variants = vec![(lookup, pruning, static_bound, false)];
                if pruning == DeadlinePruning::EarliestPrefixAndPoints {
                    variants.push((lookup, pruning, static_bound, true));
                }
                variants
            })
            .flat_map(|(l, p, s, w)| {
                let mut variants = vec![(l, p, s, w, false)];
                if p == DeadlinePruning::EarliestPrefixAndPoints && (s == w) {
                    variants.push((l, p, s, w, true));
                }
                variants
            }) {
                for traversal in [
                    DeadlineTraversal::Fifo,
                    DeadlineTraversal::ArrivalFirst,
                    DeadlineTraversal::Guided,
                    DeadlineTraversal::DepartureFirst,
                ] {
                    if traversal == DeadlineTraversal::Guided && !static_bound {
                        continue;
                    }
                    let mut request = DeadlineRequest::new(q, window.clone(), deadline);
                    request.objectives = objective;
                    request.lookup = lookup;
                    request.pruning = pruning;
                    request.traversal = traversal;
                    request.static_bound = static_bound;
                    request.walking_bound = walking_bound;
                    request.forward_seeds = forward_seeds;
                    request.transfers = walks.as_ref();
                    let result = query_deadline(&reader, &index, &events, request.clone()).unwrap();
                    if objective == ProfileObjectives::M4 && !forward_seeds {
                        for preference in DeadlinePreference::ALL {
                            let mut single_request = request.clone();
                            if preference == DeadlinePreference::LatestDeparture {
                                single_request.witness_comparison =
                                    DeadlineWitnessComparison::MaterializedDateMemo;
                            }
                            if preference == DeadlinePreference::FewestTransfers {
                                single_request.frontier_storage =
                                    DeadlineFrontierStorage::EventIndexed;
                                single_request.witness_comparison =
                                    DeadlineWitnessComparison::Streaming;
                            }
                            let single = query_deadline_preference(
                                &reader,
                                &index,
                                &events,
                                single_request.clone(),
                                preference,
                            )
                            .unwrap();
                            let pruned = query_deadline_preference_with_suffix_pruning(
                                &reader,
                                &index,
                                &events,
                                single_request.clone(),
                                preference,
                                DeadlineSuffixPruning::On,
                                |_| {},
                            )
                            .unwrap();
                            let mut row_reference = None;
                            for suffix_mode in [
                                DeadlineSuffixPruning::BeforePairs,
                                DeadlineSuffixPruning::RowPrefix,
                                DeadlineSuffixPruning::RowCeiling,
                            ] {
                                let earlier = query_deadline_preference_with_suffix_pruning(
                                    &reader,
                                    &index,
                                    &events,
                                    single_request.clone(),
                                    preference,
                                    suffix_mode,
                                    |_| {},
                                )
                                .unwrap();
                                assert_eq!(earlier.winner, pruned.winner);
                                assert_eq!(earlier.frontiers, pruned.frontiers);
                                assert_eq!(
                                    earlier.selection.bound_checks,
                                    pruned.selection.bound_checks
                                );
                                assert_eq!(
                                    earlier.selection.pruned_boardings,
                                    pruned.selection.pruned_boardings
                                );
                                let mut same_work = earlier.diagnostics;
                                same_work.lazy = pruned.diagnostics.lazy;
                                assert_eq!(same_work, pruned.diagnostics,
                                "predecessor certificate work invariant {preference:?} {mode:?} {pruning:?} {traversal:?}");
                                if matches!(
                                    suffix_mode,
                                    DeadlineSuffixPruning::RowPrefix
                                        | DeadlineSuffixPruning::RowCeiling
                                ) {
                                    assert_row_work(
                                        &pruned.diagnostics.lazy,
                                        &earlier.diagnostics.lazy,
                                    );
                                }
                                if suffix_mode == DeadlineSuffixPruning::RowPrefix {
                                    row_reference =
                                        Some((earlier.diagnostics.lazy, earlier.selection));
                                } else if suffix_mode == DeadlineSuffixPruning::RowCeiling {
                                    let (work, selection) = row_reference.unwrap();
                                    assert_ceiling_work(
                                        &work,
                                        &earlier.diagnostics.lazy,
                                        selection,
                                        earlier.selection,
                                    );
                                }
                            }
                            assert_eq!(pruned.winner, single.winner,
                                "suffix certificate {preference:?} {mode:?} {pruning:?} {traversal:?}");
                            assert!(
                                pruned.selection.pruned_suffixes
                                    <= pruned.selection.suffix_bound_checks
                            );
                            assert!(single.complete);
                            assert_eq!(single.preference, preference);
                            assert_eq!(single.window, window);
                            assert_eq!(single.arrival_deadline, deadline);
                            assert_eq!(single.winner, preference.from_m4_points(&points),
                                "single raw/forward canonical {preference:?} {mode:?} {pruning:?} {traversal:?}");
                            legal_witnesses(
                                net,
                                q,
                                &index,
                                &single.winner.into_iter().collect::<Vec<_>>(),
                            );
                            assert!(
                                single.selection.pruned_boardings <= single.selection.bound_checks
                            );
                            if !result.diagnostics.prefix.enabled
                                || pruning != DeadlinePruning::EarliestPrefixAndPoints
                            {
                                assert_eq!(single.diagnostics, result.diagnostics);
                                assert_eq!(
                                    single.selection,
                                    DeadlinePortfolioDiagnostics::default()
                                );
                            }
                        }
                        let selected =
                            query_deadline_portfolio(&reader, &index, &events, request.clone())
                                .unwrap();
                        assert!(selected.complete);
                        let mut winner_request = request.clone();
                        winner_request.witness_comparison =
                            DeadlineWitnessComparison::MaterializedDateMemo;
                        let pruned = query_deadline_portfolio_with_suffix_pruning(
                            &reader,
                            &index,
                            &events,
                            winner_request.clone(),
                            DeadlineSuffixPruning::On,
                            |_| {},
                        )
                        .unwrap();
                        let mut row_reference = None;
                        for suffix_mode in [
                            DeadlineSuffixPruning::BeforePairs,
                            DeadlineSuffixPruning::RowPrefix,
                            DeadlineSuffixPruning::RowCeiling,
                        ] {
                            let earlier = query_deadline_portfolio_with_suffix_pruning(
                                &reader,
                                &index,
                                &events,
                                winner_request.clone(),
                                suffix_mode,
                                |_| {},
                            )
                            .unwrap();
                            assert_eq!(earlier.winners, pruned.winners);
                            assert_eq!(earlier.frontiers, pruned.frontiers);
                            let mut same_work = earlier.diagnostics;
                            same_work.lazy = pruned.diagnostics.lazy;
                            assert_eq!(same_work, pruned.diagnostics);
                            assert_eq!(
                                earlier.selection.bound_checks,
                                pruned.selection.bound_checks
                            );
                            assert_eq!(
                                earlier.selection.pruned_boardings,
                                pruned.selection.pruned_boardings
                            );
                            if matches!(
                                suffix_mode,
                                DeadlineSuffixPruning::RowPrefix
                                    | DeadlineSuffixPruning::RowCeiling
                            ) {
                                assert_row_work(
                                    &pruned.diagnostics.lazy,
                                    &earlier.diagnostics.lazy,
                                );
                            }
                            if suffix_mode == DeadlineSuffixPruning::RowPrefix {
                                row_reference = Some((earlier.diagnostics.lazy, earlier.selection));
                            } else if suffix_mode == DeadlineSuffixPruning::RowCeiling {
                                let (work, selection) = row_reference.unwrap();
                                assert_ceiling_work(
                                    &work,
                                    &earlier.diagnostics.lazy,
                                    selection,
                                    earlier.selection,
                                );
                            }
                        }
                        assert_eq!(
                            pruned.winners, selected.winners,
                            "portfolio suffix certificate {mode:?} {pruning:?} {traversal:?}"
                        );
                        assert_eq!(selected.window, window);
                        assert_eq!(selected.arrival_deadline, deadline);
                        assert_eq!(
                            selected.winners,
                            DeadlinePortfolioWinners::from_m4_points(&points),
                            "portfolio raw/forward canonical {mode:?} {pruning:?} {traversal:?}"
                        );
                        let winners: Vec<_> = selected
                            .winners
                            .by_preference
                            .into_iter()
                            .flatten()
                            .collect();
                        legal_witnesses(net, q, &index, &winners);
                        assert!(
                            selected.selection.pruned_boardings <= selected.selection.bound_checks
                        );
                        if !result.diagnostics.prefix.enabled
                            || pruning != DeadlinePruning::EarliestPrefixAndPoints
                        {
                            assert_eq!(selected.diagnostics, result.diagnostics);
                            assert_eq!(selected.selection, DeadlinePortfolioDiagnostics::default());
                        }
                    }
                    for (storage, comparison) in [
                        (
                            DeadlineFrontierStorage::Tree,
                            DeadlineWitnessComparison::MaterializedDateMemo,
                        ),
                        (
                            DeadlineFrontierStorage::EventIndexed,
                            DeadlineWitnessComparison::MaterializedDateMemo,
                        ),
                        (
                            DeadlineFrontierStorage::Tree,
                            DeadlineWitnessComparison::Streaming,
                        ),
                        (
                            DeadlineFrontierStorage::EventIndexed,
                            DeadlineWitnessComparison::Materialized,
                        ),
                        (
                            DeadlineFrontierStorage::EventIndexed,
                            DeadlineWitnessComparison::Streaming,
                        ),
                    ] {
                        let mut alternative = request.clone();
                        alternative.frontier_storage = storage;
                        alternative.witness_comparison = comparison;
                        let changed =
                            query_deadline(&reader, &index, &events, alternative).unwrap();
                        assert!(changed.complete);
                        assert_eq!(
                            changed.points, result.points,
                            "frontier/comparator {mode:?} {objective:?}"
                        );
                        assert_eq!(changed.diagnostics, result.diagnostics);
                        assert_eq!(
                            (
                                changed.frontiers.records,
                                changed.frontiers.retained_ids,
                                changed.frontiers.id_capacity_bytes
                            ),
                            (
                                result.frontiers.records,
                                result.frontiers.retained_ids,
                                result.frontiers.id_capacity_bytes
                            )
                        );
                        assert_eq!(
                            changed.frontiers.directory_entries,
                            if storage == DeadlineFrontierStorage::EventIndexed {
                                events.events().len()
                            } else {
                                0
                            }
                        );
                    }
                    if pruning == DeadlinePruning::EarliestPrefixAndPoints
                        && !static_bound
                        && !walking_bound
                        && !forward_seeds
                        && traversal == DeadlineTraversal::ArrivalFirst
                    {
                        let mut r = DeadlineRequest::new(q, window.clone(), deadline);
                        r.objectives = objective;
                        r.lookup = lookup;
                        r.pruning = pruning;
                        r.traversal = traversal;
                        r.transfers = walks.as_ref();
                        let perfect =
                            query_deadline_incumbent_ceiling(&reader, &index, &events, r.clone())
                                .unwrap();
                        assert_eq!(
                            perfect.baseline.points, points,
                            "ceiling source {mode:?} {objective:?}"
                        );
                        assert_eq!(
                            perfect.ceiling.points, points,
                            "ceiling canonical {mode:?} {objective:?}"
                        );
                        assert!(perfect.baseline.complete && perfect.ceiling.complete);
                        assert_eq!(perfect.baseline.diagnostics, result.diagnostics);
                        assert_eq!(
                            perfect.ceiling.diagnostics.forward,
                            ForwardSeedDiagnostics::default()
                        );
                        if !result.diagnostics.prefix.enabled {
                            assert_eq!(perfect.baseline.diagnostics, perfect.ceiling.diagnostics);
                        }
                        r.raptor_seeds = true;
                        for ordered in [false, true] {
                            r.raptor_destination_ordering = ordered;
                            assert!(matches!(
                                query_deadline(&reader, &index, &events, r.clone()),
                                Err(DeadlineError::InvalidRequest(_))
                            ));
                        }
                    }
                    assert!(result.complete);
                    if pruning != DeadlinePruning::None {
                        // Derived block continuations are covered (H66 step
                        // 2); explicit linked rules still disable the bound.
                        let v2 = index.v2.as_deref().unwrap();
                        assert_eq!(
                            result.diagnostics.prefix.enabled,
                            v2.rules.linked.is_empty(),
                            "prefix eligibility {mode:?} {objective:?}"
                        );
                    }
                    assert_eq!(
                        tuples(&result.points, objective),
                        want,
                        "raw {mode:?} {objective:?}"
                    );
                    assert_eq!(result.points, points, "canonical {mode:?} {objective:?}");
                    assert_eq!(
                        result.diagnostics.forward.enabled,
                        forward_seeds && result.diagnostics.prefix.enabled
                    );
                    assert_eq!(
                        result.diagnostics.prefix.walking_enabled,
                        walking_bound
                            && objective == ProfileObjectives::M4
                            && result.diagnostics.prefix.enabled
                    );
                    legal_witnesses(net, q, &index, &result.points);
                    assert!(result
                        .diagnostics
                        .optimistic
                        .origin_duration_secs
                        .is_none_or(|bound| {
                            result.points.iter().all(|p| {
                                bound <= p.destination_arrival_secs - p.origin_departure_secs
                            })
                        }));
                    if let DeadlineLookup::Lazy(mode) = lookup {
                        let mut config = DeadlineSessionConfig::new(window.clone(), deadline);
                        config.objectives = objective;
                        config.lookup = mode;
                        config.pruning = pruning;
                        config.traversal = traversal;
                        config.static_bound = static_bound;
                        config.walking_bound = walking_bound;
                        config.forward_seeds = forward_seeds;
                        session.prepare(q.clone(), config.clone()).unwrap();
                        let prepared = session.run().unwrap();
                        assert!(prepared.complete);
                        assert_eq!(
                            prepared.points, result.points,
                            "session {mode:?} {objective:?}"
                        );
                        assert_eq!(prepared.diagnostics, result.diagnostics);
                        session.prepare_reusing(q.clone(), config.clone()).unwrap();
                        assert!(session.catalogue_reused());
                        let cached = session.run().unwrap();
                        assert_eq!(cached.points, result.points);
                        assert_eq!(cached.diagnostics, result.diagnostics);
                        for storage in [
                            DeadlineFrontierStorage::Tree,
                            DeadlineFrontierStorage::EventIndexed,
                        ] {
                            config.frontier_storage = storage;
                            config.witness_comparison = DeadlineWitnessComparison::Streaming;
                            session.prepare_reusing(q.clone(), config.clone()).unwrap();
                            assert!(session.catalogue_reused());
                            let streamed = session.run().unwrap();
                            assert_eq!(streamed.points, result.points);
                            assert_eq!(streamed.diagnostics, result.diagnostics);
                            assert_eq!(
                                streamed.frontiers.record_capacity_bytes.is_some(),
                                storage == DeadlineFrontierStorage::EventIndexed
                            );
                        }
                        assert_eq!(
                            session.run_checked_with_phases(|_| {}).unwrap().points,
                            result.points
                        );
                        if objective == ProfileObjectives::M4
                            && matches!(
                                mode,
                                LazyLookupMode::PlainCached | LazyLookupMode::PlainCachedPacked
                            )
                            && pruning == DeadlinePruning::EarliestPrefixAndPoints
                            && traversal == DeadlineTraversal::ArrivalFirst
                            && !static_bound
                            && !walking_bound
                            && !forward_seeds
                        {
                            for storage in [
                                DeadlineFrontierStorage::Tree,
                                DeadlineFrontierStorage::EventIndexed,
                            ] {
                                config.frontier_storage = storage;
                                config.witness_comparison =
                                    DeadlineWitnessComparison::MaterializedDateMemo;
                                session.prepare_reusing(q.clone(), config.clone()).unwrap();
                                assert_owned_winners(&session, &points);
                            }
                        }
                    }
                    if objective == ProfileObjectives::M4 {
                        m4 = tuples(&result.points, objective);
                    }
                }
            }
        }
    }
    m4
}

#[test]
fn portfolio_discovers_its_own_winner_and_prunes_a_nonwinning_earlier_arrival() {
    let mut net = Net::new(2, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 800), (1, 950)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(20261004, 800..1001),
        )
        .unwrap();
        let q = query(0, 1, 800, 1);
        for storage in [
            DeadlineFrontierStorage::Tree,
            DeadlineFrontierStorage::EventIndexed,
        ] {
            let mut r = DeadlineRequest::new(&q, 800..901, 1000);
            r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
            r.frontier_storage = storage;
            let full = query_deadline(&reader, &index, &events, r.clone()).unwrap();
            assert_eq!(full.points.len(), 2);
            let mut phases = Vec::new();
            let got =
                query_deadline_portfolio_with_phases(&reader, &index, &events, r.clone(), |p| {
                    phases.push(p)
                })
                .unwrap();
            assert_eq!(
                phases,
                [DeadlinePhase::Prepared, DeadlinePhase::SearchFinished]
            );
            assert_eq!(
                got.winners,
                DeadlinePortfolioWinners::from_m4_points(&full.points)
            );
            assert!(got.selection.pruned_boardings > 0);
            assert!(got.complete);
            for p in got.winners.by_preference.iter().flatten() {
                assert_eq!(p.origin_departure_secs, 900);
            }
            for preference in DeadlinePreference::ALL {
                let mut phases = Vec::new();
                let single = query_deadline_preference_with_phases(
                    &reader,
                    &index,
                    &events,
                    r.clone(),
                    preference,
                    |p| phases.push(p),
                )
                .unwrap();
                assert_eq!(
                    phases,
                    [DeadlinePhase::Prepared, DeadlinePhase::SearchFinished]
                );
                assert!(single.complete);
                assert_eq!(single.winner, preference.from_m4_points(&full.points));
                assert!(single.selection.pruned_boardings > 0);
            }
            r.max_segments = 1;
            assert!(matches!(
                query_deadline_portfolio(&reader, &index, &events, r),
                Err(DeadlineError::SegmentsExhausted {
                    limit: 1,
                    attempted: 2
                })
            ));
        }
    }
}

#[test]
fn departure_first_discovers_the_latest_origin_before_an_earlier_arrival() {
    let mut net = Net::new(2, 2);
    net.trip(0, &[(0, 800), (1, 950)]);
    net.trip(1, &[(0, 900), (1, 1000)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let q = query(0, 1, 800, 1);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(q.date, 800..1001),
        )
        .unwrap();
        for storage in [
            DeadlineFrontierStorage::Tree,
            DeadlineFrontierStorage::EventIndexed,
        ] {
            let mut r = DeadlineRequest::new(&q, 800..901, 1000);
            r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
            r.frontier_storage = storage;
            r.traversal = DeadlineTraversal::ArrivalFirst;
            let full = query_deadline(&reader, &index, &events, r.clone()).unwrap();
            let old = query_deadline_preference(
                &reader,
                &index,
                &events,
                r.clone(),
                DeadlinePreference::LatestDeparture,
            )
            .unwrap();
            r.traversal = DeadlineTraversal::DepartureFirst;
            let new = query_deadline_preference(
                &reader,
                &index,
                &events,
                r.clone(),
                DeadlinePreference::LatestDeparture,
            )
            .unwrap();
            assert!(new.complete);
            assert_eq!(new.winner, old.winner);
            assert_eq!(
                new.winner,
                DeadlinePreference::LatestDeparture.from_m4_points(&full.points)
            );
            assert!(new.selection.pruned_boardings > old.selection.pruned_boardings);
            assert_eq!(
                new.diagnostics.prefix.event_scans,
                old.diagnostics.prefix.event_scans
            );
            let changed_full = query_deadline(&reader, &index, &events, r).unwrap();
            assert_eq!(changed_full.points, full.points);
        }
    }
}

#[test]
fn compiled_row_ceiling_avoids_all_false_searches_without_changing_pair_or_state_work() {
    let mut net = Net::new(4, 3);
    net.trip(0, &[(0, 1100), (2, 1200)]);
    net.trip(1, &[(1, 1000), (2, 1300)]);
    for i in 0..32 {
        net.trip(2, &[(3, 400 + i), (1, 600 + i)]);
    }
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let mut q = query(0, 2, 0, 2);
    q.entry_stops = vec![
        StopWalk {
            stop: 0,
            walk_secs: 10,
        },
        StopWalk {
            stop: 3,
            walk_secs: 0,
        },
    ];
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(q.date, 0..1301),
        )
        .unwrap();
        for storage in [
            DeadlineFrontierStorage::Tree,
            DeadlineFrontierStorage::EventIndexed,
        ] {
            for lookup in [
                LazyLookupMode::PlainCached,
                LazyLookupMode::PlainFast,
                LazyLookupMode::StopIndexed,
            ] {
                let mut r = DeadlineRequest::new(&q, 0..1101, 1300);
                r.lookup = DeadlineLookup::Lazy(lookup);
                r.frontier_storage = storage;
                r.traversal = DeadlineTraversal::ArrivalFirst;
                let base = query_deadline_portfolio_with_suffix_pruning(
                    &reader,
                    &index,
                    &events,
                    r.clone(),
                    DeadlineSuffixPruning::RowPrefix,
                    |_| {},
                )
                .unwrap();
                let candidate = query_deadline_portfolio_with_suffix_pruning(
                    &reader,
                    &index,
                    &events,
                    r.clone(),
                    DeadlineSuffixPruning::RowCeiling,
                    |_| {},
                )
                .unwrap();
                assert_eq!(candidate.winners, base.winners);
                assert_eq!(candidate.frontiers, base.frontiers);
                assert_ceiling_work(
                    &base.diagnostics.lazy,
                    &candidate.diagnostics.lazy,
                    base.selection,
                    candidate.selection,
                );
                let mut same_work = candidate.diagnostics;
                same_work.lazy = base.diagnostics.lazy;
                assert_eq!(same_work, base.diagnostics);
                assert!(candidate.selection.row_ceiling_disabled > 0);
                assert!(
                    candidate.diagnostics.lazy.row_bound_checks
                        < base.diagnostics.lazy.row_bound_checks
                );
                r.max_lookup_work = base.diagnostics.lazy.work - 1;
                assert!(matches!(
                    query_deadline_portfolio_with_suffix_pruning(
                        &reader,
                        &index,
                        &events,
                        r.clone(),
                        DeadlineSuffixPruning::RowPrefix,
                        |_| {}
                    ),
                    Err(DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. }))
                ));
                assert_eq!(
                    query_deadline_portfolio_with_suffix_pruning(
                        &reader,
                        &index,
                        &events,
                        r,
                        DeadlineSuffixPruning::RowCeiling,
                        |_| {}
                    )
                    .unwrap()
                    .winners,
                    base.winners
                );
            }
        }
    }
}

#[test]
fn row_prefix_skips_a_whole_interval_without_changing_states_or_original_caps() {
    let mut net = Net::new(3, 3);
    net.trip(0, &[(0, 1100), (2, 1200)]);
    net.trip(1, &[(1, 1000), (2, 1300)]);
    for i in 0..32 {
        net.trip(2, &[(0, 400 + i), (1, 600 + i)]);
    }
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let q = query(0, 2, 0, 2);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(q.date, 0..1301),
        )
        .unwrap();
        let graph = build_transfer_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(q.date, 0..1301),
        )
        .unwrap();
        for storage in [
            DeadlineFrontierStorage::Tree,
            DeadlineFrontierStorage::EventIndexed,
        ] {
            for lookup in [
                DeadlineLookup::Graph(&graph),
                DeadlineLookup::Lazy(LazyLookupMode::ScanAll),
                DeadlineLookup::Lazy(LazyLookupMode::StopIndexed),
                DeadlineLookup::Lazy(LazyLookupMode::PlainFast),
                DeadlineLookup::Lazy(LazyLookupMode::PlainCached),
            ] {
                let mut r = DeadlineRequest::new(&q, 0..1101, 1300);
                r.traversal = DeadlineTraversal::ArrivalFirst;
                r.frontier_storage = storage;
                r.lookup = lookup;
                r.max_segments = 2;
                let baseline = query_deadline_portfolio_with_suffix_pruning(
                    &reader,
                    &index,
                    &events,
                    r.clone(),
                    DeadlineSuffixPruning::On,
                    |_| {},
                )
                .unwrap();
                let candidate = query_deadline_portfolio_with_suffix_pruning(
                    &reader,
                    &index,
                    &events,
                    r.clone(),
                    DeadlineSuffixPruning::RowPrefix,
                    |_| {},
                )
                .unwrap();
                assert_eq!(candidate.winners, baseline.winners);
                assert_eq!(candidate.frontiers, baseline.frontiers);
                let mut same_work = candidate.diagnostics;
                same_work.lazy = baseline.diagnostics.lazy;
                assert_eq!(same_work, baseline.diagnostics);
                assert_row_work(&baseline.diagnostics.lazy, &candidate.diagnostics.lazy);
                match lookup {
                    DeadlineLookup::Lazy(m) if m != LazyLookupMode::ScanAll => {
                        let d = candidate.diagnostics.lazy;
                        assert_eq!(d.certified_source_rows_skipped, 32);
                        assert!(d.row_bound_checks < 10);
                        assert_eq!(candidate.selection.predecessor_bound_checks, 0);
                        assert_eq!(candidate.selection.suffix_bound_checks, 2);
                        r.max_lookup_work = baseline.diagnostics.lazy.work - 1;
                        assert!(matches!(
                            query_deadline_portfolio_with_suffix_pruning(
                                &reader,
                                &index,
                                &events,
                                r.clone(),
                                DeadlineSuffixPruning::On,
                                |_| {}
                            ),
                            Err(DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. }))
                        ));
                        assert_eq!(
                            query_deadline_portfolio_with_suffix_pruning(
                                &reader,
                                &index,
                                &events,
                                r,
                                DeadlineSuffixPruning::RowPrefix,
                                |_| {}
                            )
                            .unwrap()
                            .winners,
                            baseline.winners
                        );
                    }
                    _ => assert_eq!(candidate.diagnostics, baseline.diagnostics),
                }
            }
        }
    }
}

#[test]
fn suffix_certificate_rejects_before_arena_limit_without_a_prefix_prepass() {
    let mut net = Net::new(3, 3);
    net.trip(0, &[(0, 900), (2, 1000)]);
    net.trip(1, &[(1, 800), (2, 1100)]);
    net.trip(2, &[(0, 600), (1, 650)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let q = query(0, 2, 600, 2);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(q.date, 600..1101),
        )
        .unwrap();
        for storage in [
            DeadlineFrontierStorage::Tree,
            DeadlineFrontierStorage::EventIndexed,
        ] {
            let mut r = DeadlineRequest::new(&q, 600..901, 1100);
            r.traversal = DeadlineTraversal::ArrivalFirst;
            r.frontier_storage = storage;
            let full = query_deadline(&reader, &index, &events, r.clone()).unwrap();
            assert!(!full.diagnostics.prefix.enabled);
            assert_eq!(full.diagnostics.segments_enqueued, 3);
            r.max_segments = 2;
            assert!(matches!(
                query_deadline_portfolio(&reader, &index, &events, r.clone()),
                Err(DeadlineError::SegmentsExhausted {
                    limit: 2,
                    attempted: 3
                })
            ));
            let mut phases = Vec::new();
            let got = query_deadline_portfolio_with_suffix_pruning(
                &reader,
                &index,
                &events,
                r.clone(),
                DeadlineSuffixPruning::On,
                |p| phases.push(p),
            )
            .unwrap();
            assert_eq!(
                phases,
                [DeadlinePhase::Prepared, DeadlinePhase::SearchFinished]
            );
            assert_eq!(
                got.winners,
                DeadlinePortfolioWinners::from_m4_points(&full.points)
            );
            assert_eq!(got.diagnostics.segments_enqueued, 2);
            assert_eq!(got.selection.pruned_suffixes, 1);
            assert_eq!(got.selection.suffix_bound_checks, 3);
            assert_eq!(got.selection.bound_checks, 0);
            let mut limited = r.clone();
            limited.max_lookup_work = got.diagnostics.lazy.work - 1;
            assert!(matches!(
                query_deadline_portfolio_with_suffix_pruning(
                    &reader,
                    &index,
                    &events,
                    limited.clone(),
                    DeadlineSuffixPruning::On,
                    |_| {},
                ),
                Err(DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. }))
            ));
            let early = query_deadline_portfolio_with_suffix_pruning(
                &reader,
                &index,
                &events,
                limited,
                DeadlineSuffixPruning::BeforePairs,
                |_| {},
            )
            .unwrap();
            assert_eq!(early.winners, got.winners);
            assert_eq!(
                early.diagnostics.segments_enqueued,
                got.diagnostics.segments_enqueued
            );
            assert_eq!(
                early.diagnostics.stop_events_scanned,
                got.diagnostics.stop_events_scanned
            );
            assert_eq!(early.selection.pruned_predecessor_pairs, 1);
            assert_eq!(
                early.diagnostics.lazy.pair_checks + 1,
                got.diagnostics.lazy.pair_checks
            );
            assert_eq!(
                early.diagnostics.lazy.event_probes,
                got.diagnostics.lazy.event_probes
            );
            for preference in DeadlinePreference::ALL {
                let single = query_deadline_preference_with_suffix_pruning(
                    &reader,
                    &index,
                    &events,
                    r.clone(),
                    preference,
                    DeadlineSuffixPruning::On,
                    |_| {},
                )
                .unwrap();
                assert_eq!(single.winner, preference.from_m4_points(&full.points));
                assert_eq!(single.selection.pruned_suffixes, 1);
            }
        }
    }
}

#[test]
fn portfolio_rejects_sampling_r3_binding_and_incomplete_coverage_without_partial_results() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(20261004, 900..1001),
    )
    .unwrap();
    let q = query(0, 1, 900, 1);
    let request = DeadlineRequest::new(&q, 900..901, 1000);
    for preference in DeadlinePreference::ALL {
        for option in 0..7 {
            let mut r = request.clone();
            match option {
                0 => r.objectives = ProfileObjectives::R3,
                1 => r.forward_seeds = true,
                2 => r.raptor_seeds = true,
                3 => r.raptor_destination_ordering = true,
                4 => r.window.start = 899,
                5 => r.max_lookup_work = 0,
                _ => r.arrival_deadline += 1,
            }
            let expected =
                query_deadline_portfolio(&reader, &index, &events, r.clone()).unwrap_err();
            assert_eq!(
                query_deadline_portfolio_with_suffix_pruning(
                    &reader,
                    &index,
                    &events,
                    r.clone(),
                    DeadlineSuffixPruning::On,
                    |_| {},
                )
                .unwrap_err(),
                expected
            );
            for suffix_mode in [
                DeadlineSuffixPruning::BeforePairs,
                DeadlineSuffixPruning::RowPrefix,
                DeadlineSuffixPruning::RowCeiling,
            ] {
                assert_eq!(
                    query_deadline_preference_with_suffix_pruning(
                        &reader,
                        &index,
                        &events,
                        r.clone(),
                        preference,
                        DeadlineSuffixPruning::On,
                        |_| {},
                    )
                    .unwrap_err(),
                    expected
                );
                assert_eq!(
                    query_deadline_preference_with_suffix_pruning(
                        &reader,
                        &index,
                        &events,
                        r.clone(),
                        preference,
                        suffix_mode,
                        |_| {},
                    )
                    .unwrap_err(),
                    expected
                );
                assert_eq!(
                    query_deadline_portfolio_with_suffix_pruning(
                        &reader,
                        &index,
                        &events,
                        r.clone(),
                        suffix_mode,
                        |_| {},
                    )
                    .unwrap_err(),
                    expected
                );
            }
            assert_eq!(
                query_deadline_preference(&reader, &index, &events, r, preference).unwrap_err(),
                expected
            );
        }
    }
    for option in 0..4 {
        let mut r = request.clone();
        match option {
            0 => r.objectives = ProfileObjectives::R3,
            1 => r.forward_seeds = true,
            2 => r.raptor_seeds = true,
            _ => r.raptor_destination_ordering = true,
        }
        assert!(matches!(
            query_deadline_portfolio(&reader, &index, &events, r),
            Err(DeadlineError::InvalidRequest(_))
        ));
    }
    let mut r = request.clone();
    r.window.start = 899;
    assert!(matches!(
        query_deadline_portfolio(&reader, &index, &events, r),
        Err(DeadlineError::IncompleteCoverage { .. })
    ));
    let mut r = request.clone();
    r.max_lookup_work = 0;
    assert!(matches!(
        query_deadline_portfolio(&reader, &index, &events, r),
        Err(DeadlineError::InvalidRequest(_))
    ));
    let mut other = Net::new(2, 1);
    other.trip(0, &[(0, 900), (1, 999)]);
    let other_reader = Reader::from_bytes(other.bytes()).unwrap();
    for preference in DeadlinePreference::ALL {
        assert!(matches!(
            query_deadline_preference(&other_reader, &index, &events, request.clone(), preference),
            Err(DeadlineError::BindingMismatch)
        ));
    }
    assert!(matches!(
        query_deadline_portfolio(&other_reader, &index, &events, request.clone()),
        Err(DeadlineError::BindingMismatch)
    ));
    let no_bounds = query_deadline_portfolio(&reader, &index, &events, request).unwrap();
    assert_eq!(no_bounds.selection, DeadlinePortfolioDiagnostics::default());
}

#[allow(clippy::too_many_arguments)] // Explicit original caps are the subject of these tests.
fn seeded(
    net: &Net,
    q: &Query,
    window: core::ops::Range<i64>,
    deadline: i64,
    on: bool,
    max_states: usize,
    max_stops: usize,
    max_lookup: usize,
) -> Result<DeadlineResult, DeadlineError> {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let walks = net.ptft_table();
    let cfg = TransferIndexConfig::new(q.date, window.start..deadline + 1);
    let events = build_event_index(&reader, &index, walks.as_ref(), &cfg).unwrap();
    let mut r = DeadlineRequest::new(q, window, deadline);
    r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
    r.forward_seeds = on;
    r.transfers = walks.as_ref();
    r.max_segments = max_states;
    r.max_stop_scans = max_stops;
    r.max_lookup_work = max_lookup;
    query_deadline(&reader, &index, &events, r)
}

#[test]
fn few_shot_incumbents_prune_but_remain_part_of_the_original_work_budget() {
    let mut net = Net::new(3, 3);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1200), (2, 1300)]);
    net.trip(2, &[(0, 900), (2, 1100)]);
    let q = query(0, 2, 900, 2);
    let plain = seeded(&net, &q, 900..901, 1400, false, 250000, 10000000, 10000000).unwrap();
    let sampled = seeded(&net, &q, 900..901, 1400, true, 250000, 10000000, 10000000).unwrap();
    assert_eq!(sampled.points, plain.points);
    assert!(sampled.diagnostics.forward.incumbents > 0);
    assert!(sampled.diagnostics.forward.certified_prunes > 0);
    assert!(sampled.diagnostics.lazy.pair_checks < plain.diagnostics.lazy.pair_checks);
    assert!(sampled.diagnostics.lazy.work >= sampled.diagnostics.forward.lookup_work);
    assert!(sampled.diagnostics.forward.stop_work() > 0);
    check(&net, &q, 900..901, 1400);
}

#[test]
fn incumbent_ceiling_injects_legal_points_without_claiming_free_source_work() {
    let mut net = Net::new(3, 3);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1200), (2, 1300)]);
    net.trip(2, &[(0, 900), (2, 1100)]);
    let q = query(0, 2, 900, 2);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let index = Index::build(&reader, mode).unwrap();
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(QDATE, 900..1401),
        )
        .unwrap();
        for objective in [ProfileObjectives::R3, ProfileObjectives::M4] {
            let mut r = DeadlineRequest::new(&q, 900..901, 1400);
            r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
            r.objectives = objective;
            let perfect = query_deadline_incumbent_ceiling(&reader, &index, &events, r).unwrap();
            assert_eq!(perfect.baseline.points, perfect.ceiling.points);
            assert!(!perfect.baseline.points.is_empty());
            assert!(
                perfect.baseline.diagnostics.lazy.pair_checks
                    > perfect.ceiling.diagnostics.lazy.pair_checks
            );
            assert!(perfect.baseline.diagnostics.lazy.work > 0);
            assert!(perfect.ceiling.diagnostics.seed_event_checks > 0);
            assert!(perfect.ceiling.diagnostics.stop_events_scanned > 0);
            assert_eq!(
                perfect.ceiling.diagnostics.forward,
                ForwardSeedDiagnostics::default()
            );
            legal_witnesses(&net, &q, &index, &perfect.ceiling.points);
        }
    }
}

#[test]
fn incumbent_ceiling_keeps_equal_witness_work_and_empty_answers() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..1001),
    )
    .unwrap();
    for (entry, exit, count) in [(0, 1, 1), (1, 0, 0)] {
        let q = query(entry, exit, 900, 1);
        let mut r = DeadlineRequest::new(&q, 900..901, 1000);
        r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
        let perfect = query_deadline_incumbent_ceiling(&reader, &index, &events, r).unwrap();
        assert_eq!(perfect.baseline.points, perfect.ceiling.points);
        assert_eq!(perfect.ceiling.points.len(), count);
        assert_eq!(perfect.baseline.diagnostics, perfect.ceiling.diagnostics);
        if count > 0 {
            assert_eq!(perfect.ceiling.points[0].witness[0].trip_idx, 0);
        }
    }
}

#[test]
fn incumbent_ceiling_preserves_original_limits_binding_and_unavailability() {
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1200), (2, 1300)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..1401),
    )
    .unwrap();
    let q = query(0, 2, 900, 2);
    for cap in 0..3 {
        let mut r = DeadlineRequest::new(&q, 900..901, 1400);
        r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
        match cap {
            0 => r.max_lookup_work = 1,
            1 => r.max_stop_scans = 1,
            _ => r.max_segments = 1,
        }
        let expected = query_deadline(&reader, &index, &events, r.clone()).unwrap_err();
        assert_eq!(
            query_deadline_incumbent_ceiling(&reader, &index, &events, r).unwrap_err(),
            DeadlineIncumbentCeilingError::Baseline(expected)
        );
    }
    let mut other = Net::new(3, 2);
    other.trip(0, &[(0, 901), (1, 1000)]);
    let other_reader = Reader::from_bytes(other.bytes()).unwrap();
    let mut r = DeadlineRequest::new(&q, 900..901, 1400);
    r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
    assert_eq!(
        query_deadline_incumbent_ceiling(&other_reader, &index, &events, r).unwrap_err(),
        DeadlineIncumbentCeilingError::Baseline(DeadlineError::BindingMismatch)
    );
}

#[test]
fn incumbent_ceiling_rejects_incompatible_options() {
    let net = Net::new(2, 1);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..1001),
    )
    .unwrap();
    let q = query(0, 1, 900, 1);
    for (p, seeds) in [
        (DeadlinePruning::None, false),
        (DeadlinePruning::EarliestPrefix, false),
        (DeadlinePruning::EarliestPrefixAndPoints, true),
    ] {
        let mut r = DeadlineRequest::new(&q, 900..901, 1000);
        r.pruning = p;
        r.forward_seeds = seeds;
        assert!(matches!(
            query_deadline_incumbent_ceiling(&reader, &index, &events, r),
            Err(DeadlineIncumbentCeilingError::Baseline(
                DeadlineError::InvalidRequest(_)
            ))
        ));
    }
}

#[test]
fn few_shot_equal_objectives_do_not_hide_the_canonical_witness() {
    let mut net = Net::new(4, 4);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1150), (3, 1300)]);
    net.trip(2, &[(0, 900), (2, 950)]);
    net.trip(3, &[(2, 1100), (3, 1300)]);
    let q = query(0, 3, 900, 2);
    let result = seeded(&net, &q, 900..901, 1300, true, 250000, 10000000, 10000000).unwrap();
    assert_eq!(
        tuples(&result.points, ProfileObjectives::M4),
        [(900, 1300, 1, 0)]
    );
    assert_eq!(result.points[0].witness[0].trip_idx, 0);
    assert!(result.diagnostics.forward.incumbents > 0);
    check(&net, &q, 900..901, 1300);
}

#[test]
fn few_shot_truncation_and_lookahead_never_turn_into_query_coverage() {
    let mut net = Net::new(2, 1);
    for _ in 0..20 {
        net.trip(0, &[(0, 900), (1, 1000)]);
    }
    let q = query(0, 1, 900, 1);
    let result = seeded(&net, &q, 900..901, 1000, true, 250000, 10000000, 10000000).unwrap();
    assert!(result.complete);
    assert_eq!(result.diagnostics.forward.shots, 1);
    assert_eq!(result.diagnostics.forward.truncated_shots, 1);
    assert_eq!(result.points[0].witness[0].trip_idx, 0);
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 900), (1, 1300)]);
    net.trip(1, &[(1, 6600), (2, 6800)]);
    let q = query(0, 2, 900, 2);
    let result = seeded(&net, &q, 900..901, 6800, true, 250000, 10000000, 10000000).unwrap();
    assert_eq!(result.diagnostics.forward.incumbents, 0);
    assert_eq!(
        tuples(&result.points, ProfileObjectives::M4),
        [(900, 6800, 1, 0)]
    );
    check(&net, &q, 900..901, 6800);
}

#[test]
fn few_shots_filter_caller_egress_deadline_without_clipping_its_controlled_horizon() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let mut q = query(0, 1, 900, 1);
    q.exit_stops[0].walk_secs = 300;
    let result = seeded(&net, &q, 900..901, 1200, true, 250000, 10000000, 10000000).unwrap();
    assert!(result.points.is_empty());
    assert_eq!(result.diagnostics.forward.incumbents, 0);
    q.exit_stops[0].walk_secs = 7000;
    let result = seeded(&net, &q, 900..901, 8200, true, 250000, 10000000, 10000000).unwrap();
    assert_eq!(result.diagnostics.forward.incumbents, 1);
    assert_eq!(
        tuples(&result.points, ProfileObjectives::M4),
        [(900, 8000, 0, 7000)]
    );
    check(&net, &q, 900..901, 8200);
}

#[test]
fn few_shot_hard_limits_keep_the_original_limit_and_no_partial_result() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 900), (1, 950)]);
    net.trip(0, &[(0, 1000), (1, 1050)]);
    let q = query(0, 1, 900, 1);
    assert!(matches!(
        seeded(&net, &q, 900..1001, 1050, true, 1, 10000000, 10000000),
        Err(DeadlineError::SegmentsExhausted {
            limit: 1,
            attempted: 2
        })
    ));
    assert!(matches!(
        seeded(&net, &q, 900..1001, 1050, true, 250000, 6, 10000000),
        Err(DeadlineError::StopScansExhausted {
            limit: 6,
            attempted: 7
        })
    ));
    assert!(matches!(
        seeded(&net, &q, 900..1001, 1050, true, 250000, 10000000, 1),
        Err(DeadlineError::Lookup(LazyLookupError::WorkExhausted {
            limit: 1,
            attempted: 2
        }))
    ));
}

#[test]
fn few_shot_local_state_cutoff_does_not_hide_the_exact_route() {
    let mut net = Net::new(4098, 1);
    let rows: Vec<_> = (0u32..4098).map(|s| (s, 900 + s)).collect();
    net.trip(0, &rows);
    let q = query(0, 4097, 900, 1);
    let result = seeded(&net, &q, 900..901, 4997, true, 250000, 10000000, 10000000).unwrap();
    assert!(result.complete);
    assert_eq!(result.diagnostics.forward.truncated_shots, 1);
    assert_eq!(result.diagnostics.forward.accepted_states, 4096);
    assert_eq!(result.diagnostics.forward.incumbents, 0);
    assert_eq!(
        tuples(&result.points, ProfileObjectives::M4),
        [(900, 4997, 0, 0)]
    );
}

#[test]
fn few_shots_require_explicit_point_bounds_before_setup() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..1001),
    )
    .unwrap();
    let q = query(0, 1, 900, 1);
    for pruning in [DeadlinePruning::None, DeadlinePruning::EarliestPrefix] {
        let mut r = DeadlineRequest::new(&q, 900..901, 1000);
        r.forward_seeds = true;
        r.pruning = pruning;
        assert!(matches!(
            query_deadline(&reader, &index, &events, r),
            Err(DeadlineError::InvalidRequest(_))
        ));
    }
}

#[test]
fn round_walking_bound_beats_unlimited_line_changes_without_an_extra_graph() {
    let mut net = Net::new(6, 5);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1100), (2, 1150)]);
    net.trip(2, &[(2, 1200), (3, 1250)]);
    net.trip(3, &[(3, 1500), (4, 1700)]);
    net.trip(4, &[(0, 900), (5, 1200)]);
    net.ptft.extend([(1, 3, 200), (5, 4, 100)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let walks = net.ptft_table().unwrap();
    let events = build_event_index(
        &reader,
        &index,
        Some(&walks),
        &TransferIndexConfig::new(QDATE, 883..1701),
    )
    .unwrap();
    let mut q = query(0, 4, 883, 2);
    q.entry_stops[0].walk_secs = 17;
    let run = |walking_bound, static_bound, objective| {
        let mut r = DeadlineRequest::new(&q, 883..884, 1700);
        r.transfers = Some(&walks);
        r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
        r.traversal = DeadlineTraversal::ArrivalFirst;
        r.walking_bound = walking_bound;
        r.static_bound = static_bound;
        r.objectives = objective;
        query_deadline(&reader, &index, &events, r).unwrap()
    };
    let plain = run(false, false, ProfileObjectives::M4);
    let unlimited = run(false, true, ProfileObjectives::M4);
    let bounded = run(true, false, ProfileObjectives::M4);
    let combined = run(true, true, ProfileObjectives::M4);
    assert_eq!(
        tuples(&plain.points, ProfileObjectives::M4),
        [(883, 1300, 0, 117)]
    );
    for result in [&unlimited, &bounded, &combined] {
        assert_eq!(result.points, plain.points);
    }
    assert_eq!(unlimited.diagnostics.optimistic.walking_pruned_boardings, 0);
    assert!(bounded.diagnostics.prefix.walking_pruned_boardings > 0);
    assert!(combined.diagnostics.prefix.walking_pruned_boardings > 0);
    assert!(bounded.diagnostics.lazy.work < plain.diagnostics.lazy.work);
    assert_eq!(
        bounded.diagnostics.prefix.event_scans,
        plain.diagnostics.prefix.event_scans
    );
    assert_eq!(
        bounded.diagnostics.prefix.walking_relaxations,
        plain.diagnostics.prefix.walking_relaxations
    );
    assert_eq!(bounded.diagnostics.optimistic.work(), 0);
    assert_eq!(
        bounded.diagnostics.prefix.walking_bytes,
        2 * (6 * 8 + core::mem::size_of::<Vec<i64>>())
    );
    assert_eq!(
        run(true, false, ProfileObjectives::R3).diagnostics,
        run(false, false, ProfileObjectives::R3).diagnostics
    );
    check(&net, &q, 883..884, 1700);
}

#[test]
fn walking_bounds_combine_by_max_not_sum_and_count_access_once() {
    let mut net = Net::new(4, 3);
    net.trip(0, &[(2, 922), (1, 1000)]);
    net.trip(1, &[(0, 920), (1, 1100)]);
    // The static graph can get to 0 via this extra ride for walking cost 5.
    // The actual suffix already spends the sole allowed ride: W[0][0] = 20.
    net.trip(2, &[(3, 900), (0, 910)]);
    let mut q = query(0, 1, 900, 1);
    q.entry_stops = vec![
        StopWalk {
            stop: 0,
            walk_secs: 20,
        },
        StopWalk {
            stop: 2,
            walk_secs: 22,
        },
        StopWalk {
            stop: 3,
            walk_secs: 5,
        },
    ];
    assert_eq!(
        check(&net, &q, 900..901, 1100),
        [(900, 1000, 0, 22), (900, 1100, 0, 20)]
    );
}

#[test]
fn round_walking_uses_directed_walk_not_transfer_floor_or_stop_edge_count() {
    let mut net = Net::new(6, 3);
    net.trip(0, &[(0, 900), (5, 950), (1, 1000)]);
    net.trip(1, &[(2, 1400), (3, 1600)]);
    net.trip(2, &[(0, 900), (4, 1100)]);
    // Default transfer floor is 120, not walking. A scoped explicit rule
    // would add a zero-cost synthetic relaxation and weaken this mutation trap.
    net.ptft.extend([(1, 2, 100), (2, 1, 10), (4, 3, 110)]);
    assert_eq!(
        check(&net, &query(0, 3, 900, 2), 900..901, 1600),
        [(900, 1210, 0, 110), (900, 1600, 1, 100)]
    );
}

#[test]
fn walking_bound_requires_point_pruning_before_setup() {
    let net = lattice(4, 0, false);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..2000),
    )
    .unwrap();
    let q = query(0, 2, 900, 2);
    for pruning in [DeadlinePruning::None, DeadlinePruning::EarliestPrefix] {
        let mut r = DeadlineRequest::new(&q, 900..1200, 1314);
        r.walking_bound = true;
        r.pruning = pruning;
        assert!(matches!(
            query_deadline(&reader, &index, &events, r),
            Err(DeadlineError::InvalidRequest(_))
        ));
    }
}

#[test]
fn deadline_queries_match_raw_and_forward_profiles_on_generated_networks() {
    let mut rng = Rng(0x4445_4144_4c49_4e45);
    let mut nonempty = 0;
    for _ in 0..200 {
        let mut net = random_net(&mut rng);
        net.strip = rng.chance(50);
        if rng.chance(40) {
            net.boarding = net
                .trips
                .iter()
                .flat_map(|t| t.rows.iter())
                .map(|_| match rng.below(7) {
                    0 => 0x51,
                    1 => 0x54,
                    2 => 0x55,
                    _ => 0x50,
                })
                .collect();
        }
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
        vary_walk_settings(&mut rng, &mut q);
        if !check(&net, &q, 68000..72000, 76000).is_empty() {
            nonempty += 1;
        }
    }
    assert!(nonempty > 35, "sparse deadline corpus: {nonempty}");
}

#[test]
fn optimistic_walking_certificate_prunes_only_with_a_real_incumbent() {
    let mut net = Net::new(5, 3);
    net.trip(0, &[(0, 900), (1, 1100)]);
    net.trip(1, &[(2, 1500), (3, 1700)]);
    net.trip(2, &[(0, 900), (4, 1200)]);
    net.ptft.extend([(1, 3, 100), (4, 2, 200)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let walks = net.ptft_table().unwrap();
    let events = build_event_index(
        &reader,
        &index,
        Some(&walks),
        &TransferIndexConfig::new(QDATE, 900..1701),
    )
    .unwrap();
    let q = query(0, 3, 900, 2);
    let run = |static_bound, traversal| {
        let mut r = DeadlineRequest::new(&q, 900..901, 1700);
        r.transfers = Some(&walks);
        r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
        r.traversal = traversal;
        r.static_bound = static_bound;
        query_deadline(&reader, &index, &events, r).unwrap()
    };
    let old = run(false, DeadlineTraversal::ArrivalFirst);
    let bounded = run(true, DeadlineTraversal::ArrivalFirst);
    let guided = run(true, DeadlineTraversal::Guided);
    assert_eq!(old.points, bounded.points);
    assert_eq!(old.points, guided.points);
    assert_eq!(
        tuples(&old.points, ProfileObjectives::M4),
        [(900, 1200, 0, 100)]
    );
    assert!(bounded.diagnostics.optimistic.walking_pruned_boardings > 0);
    assert!(bounded.diagnostics.lazy.work < old.diagnostics.lazy.work);
    assert_eq!(
        bounded.diagnostics.optimistic.destination_pruned_segments,
        0
    );
}

#[test]
fn optimistic_minimum_is_not_a_real_route_or_an_earliest_lookback_cutoff() {
    let mut net = Net::new(3, 1);
    // The two fastest segments belong to incompatible timetable journeys.
    net.trip(0, &[(0, 1000), (1, 1010), (2, 1310)]);
    net.trip(0, &[(0, 900), (1, 1200), (2, 1210)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..1311),
    )
    .unwrap();
    let q = query(0, 2, 900, 1);
    let mut r = DeadlineRequest::new(&q, 900..1001, 1310);
    r.static_bound = true;
    r.traversal = DeadlineTraversal::Guided;
    let result = query_deadline(&reader, &index, &events, r).unwrap();
    assert_eq!(result.diagnostics.optimistic.origin_duration_secs, Some(20));
    assert!(result
        .points
        .iter()
        .all(|p| p.destination_arrival_secs - p.origin_departure_secs == 310));
    assert_eq!(result.points.len(), 2);
    // Starting at deadline - 20 would exclude BOTH real journeys.
    assert!(result.points.iter().all(|p| p.origin_departure_secs < 1290));
}

#[test]
fn optimistic_setup_spends_the_original_cap_and_guided_cannot_silently_default() {
    let net = lattice(8, 0, false);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..2000),
    )
    .unwrap();
    let q = query(0, 2, 900, 2);
    let mut r = DeadlineRequest::new(&q, 900..1200, 1314);
    r.static_bound = true;
    r.max_stop_scans = 1;
    assert!(matches!(
        query_deadline(&reader, &index, &events, r),
        Err(DeadlineError::StopScansExhausted {
            limit: 1,
            attempted: 2
        })
    ));
    let mut r = DeadlineRequest::new(&q, 900..1200, 1314);
    r.traversal = DeadlineTraversal::Guided;
    assert!(matches!(
        query_deadline(&reader, &index, &events, r),
        Err(DeadlineError::InvalidRequest(_))
    ));
}

#[test]
fn deadline_query_keeps_shorter_walk_loop_and_inclusive_deadline() {
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (4, 1400), (3, 1500), (4, 1800)]);
    net.ptft.extend([(1, 2, 90), (1, 3, 30)]);
    assert_eq!(
        check(&net, &query(0, 4, 900, 2), 900..901, 1800),
        [(900, 1400, 1, 90), (900, 1800, 1, 30)]
    );
    assert_eq!(
        check(&net, &query(0, 4, 900, 2), 900..901, 1799),
        [(900, 1400, 1, 90)]
    );
}

#[test]
fn deadline_query_keeps_scoped_rules_and_inseat_without_pickup_or_dropoff() {
    let mut net = Net::new(3, 3);
    let banned = net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 900), (1, 1000)]);
    let onward = net.trip(2, &[(1, 1200), (2, 1300)]);
    net.transfers
        .push((1, 1, ABSENT, ABSENT, banned, onward, ABSENT, 3));
    assert_eq!(
        check(&net, &query(0, 2, 900, 2), 900..901, 1300),
        [(900, 1300, 1, 0)]
    );
    let mut net = Net::new(3, 2);
    let first = net.trip(0, &[(0, 900), (1, 1000)]);
    let next = net.trip(1, &[(1, 1050), (2, 1200)]);
    net.boarding = vec![0x50, 0x54, 0x51, 0x50];
    net.transfers
        .push((1, 1, ABSENT, ABSENT, first, next, ABSENT, 4));
    assert_eq!(
        check(&net, &query(0, 2, 900, 2), 900..901, 1200),
        [(900, 1200, 0, 0)]
    );
    assert!(check(&net, &query(0, 2, 900, 1), 900..901, 1200).is_empty());
}

#[test]
fn reverse_horizon_uses_controlled_suffix_times_not_the_requested_deadline() {
    let mut net = Net::new(3, 2);
    net.services = vec![0b0000_1000];
    net.trip(0, &[(0, 0), (1, 120)]);
    net.trip(1, &[(1, 240), (2, 172800)]);
    net.trip(1, &[(1, 241), (2, 172801)]);
    assert_eq!(
        check(&net, &query(0, 2, 0, 2), 0..1, 172801),
        [(0, 172800, 1, 0)]
    );
    let mut direct = Net::new(2, 1);
    direct.services = vec![0b0000_1000];
    direct.trip(0, &[(0, 0), (1, 172800)]);
    let mut q = query(0, 1, 0, 1);
    q.exit_stops[0].walk_secs = 15;
    assert_eq!(check(&direct, &q, 0..1, 172815), [(0, 172815, 0, 15)]);
    direct.ptft.push((1, 0, 1));
    q.exit_stops[0].stop = 0;
    assert!(check(&direct, &q, 0..1, 172816).is_empty()); // Physical walk exceeds horizon.
}

#[test]
fn reverse_access_preserves_window_boundaries_and_directed_walks() {
    let mut net = Net::new(4, 2);
    net.trip(0, &[(0, 1000), (1, 1200)]);
    net.trip(1, &[(2, 1400), (3, 1600)]);
    net.ptft.push((1, 2, 90));
    let mut q = query(0, 3, 900, 2);
    q.entry_stops.push(StopWalk {
        stop: 0,
        walk_secs: 50,
    });
    assert_eq!(check(&net, &q, 950..951, 1600), [(950, 1600, 1, 140)]);
    assert!(check(&net, &query(3, 0, 900, 2), 900..1001, 1800).is_empty());
}

fn lattice(n: u32, distractors: u32, unrelated_rule: bool) -> Net {
    let mut net = Net::new(6, 3);
    net.services = vec![0b0000_1000];
    for i in 0..n {
        net.trip(0, &[(0, 1000 + 2 * i), (1, 1100 + 2 * i)]);
        net.trip(1, &[(1, 1220 + 2 * i), (2, 1300 + 2 * i)]);
    }
    for i in 0..distractors {
        net.trip(2, &[(4, 1000 + i), (5, 1100 + i)]);
    }
    if unrelated_rule {
        net.transfers
            .push((4, 4, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3));
    }
    net
}

#[test]
fn frontier_storage_preserves_each_typed_limit_without_partial_results() {
    let mut net = Net::new(4, 3);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1120), (2, 1200)]);
    net.trip(2, &[(1, 1120), (3, 1400)]);
    let mut q = query(0, 3, 900, 2);
    q.exit_stops.push(StopWalk {
        stop: 2,
        walk_secs: 100,
    });
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(QDATE, 900..1501),
        )
        .unwrap();
        for comparison in [
            DeadlineWitnessComparison::Materialized,
            DeadlineWitnessComparison::MaterializedDateMemo,
            DeadlineWitnessComparison::Streaming,
        ] {
            for traversal in [
                DeadlineTraversal::ArrivalFirst,
                DeadlineTraversal::DepartureFirst,
            ] {
                for cap in 0..4 {
                    let mut r = DeadlineRequest::new(&q, 900..901, 1500);
                    r.traversal = traversal;
                    r.witness_comparison = comparison;
                    r.lookup = DeadlineLookup::Lazy(LazyLookupMode::PlainCached);
                    match cap {
                        0 => r.max_lookup_work = 1,
                        1 => r.max_stop_scans = 1,
                        2 => r.max_segments = 1,
                        _ => r.max_frontier_width = 1,
                    }
                    let expected = query_deadline(&reader, &index, &events, r.clone()).unwrap_err();
                    assert_eq!(
                        query_deadline_portfolio_with_suffix_pruning(
                            &reader,
                            &index,
                            &events,
                            r.clone(),
                            DeadlineSuffixPruning::On,
                            |_| {},
                        )
                        .unwrap_err(),
                        expected
                    );
                    assert_eq!(
                        query_deadline_portfolio(&reader, &index, &events, r.clone()).unwrap_err(),
                        expected
                    );
                    for preference in DeadlinePreference::ALL {
                        for storage in [
                            DeadlineFrontierStorage::Tree,
                            DeadlineFrontierStorage::EventIndexed,
                        ] {
                            let mut pruned = r.clone();
                            pruned.frontier_storage = storage;
                            let result = query_deadline_preference_with_suffix_pruning(
                                &reader,
                                &index,
                                &events,
                                pruned.clone(),
                                preference,
                                DeadlineSuffixPruning::On,
                                |_| {},
                            );
                            match result {
                                Err(error) => assert_eq!(error, expected),
                                Ok(got) => {
                                    // A proved pre-allocation rejection may
                                    // legitimately avoid the old width failure.
                                    assert_eq!(cap, 3);
                                    pruned.max_frontier_width = 64;
                                    let full =
                                        query_deadline(&reader, &index, &events, pruned.clone())
                                            .unwrap();
                                    assert_eq!(got.winner, preference.from_m4_points(&full.points));
                                }
                            }
                            // With no discovered incumbent the certificate
                            // cannot bypass even the width limit.
                            let mut unavailable = q.clone();
                            unavailable.entry_stops.clear();
                            pruned.query = &unavailable;
                            pruned.max_frontier_width = r.max_frontier_width;
                            for suffix_mode in [
                                DeadlineSuffixPruning::BeforePairs,
                                DeadlineSuffixPruning::RowPrefix,
                                DeadlineSuffixPruning::RowCeiling,
                            ] {
                                assert_eq!(
                                    query_deadline_preference_with_suffix_pruning(
                                        &reader,
                                        &index,
                                        &events,
                                        pruned.clone(),
                                        preference,
                                        suffix_mode,
                                        |_| {},
                                    )
                                    .unwrap_err(),
                                    expected
                                );
                                assert_eq!(
                                    query_deadline_portfolio_with_suffix_pruning(
                                        &reader,
                                        &index,
                                        &events,
                                        pruned.clone(),
                                        suffix_mode,
                                        |_| {},
                                    )
                                    .unwrap_err(),
                                    expected
                                );
                                let mut owned = DeadlineSession::new(
                                    Reader::from_bytes(net.bytes()).unwrap(),
                                    mode,
                                    None,
                                )
                                .unwrap();
                                let mut config = DeadlineSessionConfig::new(
                                    pruned.window.clone(),
                                    pruned.arrival_deadline,
                                );
                                config.lookup = LazyLookupMode::PlainCached;
                                config.pruning = pruned.pruning;
                                config.traversal = pruned.traversal;
                                config.frontier_storage = pruned.frontier_storage;
                                config.witness_comparison = pruned.witness_comparison;
                                config.max_segments = pruned.max_segments;
                                config.max_frontier_width = pruned.max_frontier_width;
                                config.max_stop_scans = pruned.max_stop_scans;
                                config.max_lookup_work = pruned.max_lookup_work;
                                owned.prepare(unavailable.clone(), config).unwrap();
                                for checked in [false, true] {
                                    let single = if checked {
                                        owned.run_preference_checked_with_phases(
                                            preference,
                                            suffix_mode,
                                            |_| {},
                                        )
                                    } else {
                                        owned.run_preference_with_phases(
                                            preference,
                                            suffix_mode,
                                            |_| {},
                                        )
                                    };
                                    assert_eq!(single.unwrap_err(), expected);
                                    let all = if checked {
                                        owned.run_portfolio_checked_with_phases(suffix_mode, |_| {})
                                    } else {
                                        owned.run_portfolio_with_phases(suffix_mode, |_| {})
                                    };
                                    assert_eq!(all.unwrap_err(), expected);
                                }
                            }
                            assert_eq!(
                                query_deadline_preference_with_suffix_pruning(
                                    &reader,
                                    &index,
                                    &events,
                                    pruned,
                                    preference,
                                    DeadlineSuffixPruning::On,
                                    |_| {},
                                )
                                .unwrap_err(),
                                expected
                            );
                        }
                        assert_eq!(
                            query_deadline_preference(
                                &reader,
                                &index,
                                &events,
                                r.clone(),
                                preference
                            )
                            .unwrap_err(),
                            expected
                        );
                        let mut indexed = r.clone();
                        indexed.frontier_storage = DeadlineFrontierStorage::EventIndexed;
                        assert_eq!(
                            query_deadline_preference(
                                &reader, &index, &events, indexed, preference
                            )
                            .unwrap_err(),
                            expected
                        );
                    }
                    if cap == 3 {
                        assert_eq!(
                            expected,
                            DeadlineError::FrontierExhausted {
                                limit: 1,
                                attempted: 2
                            }
                        );
                    }
                    r.frontier_storage = DeadlineFrontierStorage::EventIndexed;
                    assert_eq!(
                        query_deadline_portfolio(&reader, &index, &events, r.clone()).unwrap_err(),
                        expected
                    );
                    assert_eq!(
                        query_deadline(&reader, &index, &events, r).unwrap_err(),
                        expected
                    );
                }
            }
        }
    }
}

fn run_lattice(net: &Net, deadline: i64, mode: LazyLookupMode) -> DeadlineResult {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..2000),
    )
    .unwrap();
    let q = query(0, 2, 900, 2);
    let mut request = DeadlineRequest::new(&q, 900..1200, deadline);
    request.lookup = DeadlineLookup::Lazy(mode);
    query_deadline(&reader, &index, &events, request).unwrap()
}

#[test]
fn deadline_prunes_lattice_but_does_not_make_lazy_pair_work_linear() {
    for n in [8u32, 16, 32, 64] {
        let net = lattice(n, 0, false);
        for k in [1, n / 2, n] {
            let result = run_lattice(&net, 1300 + 2 * (k - 1) as i64, LazyLookupMode::PlainFast);
            assert_eq!(result.points.len(), k as usize);
            assert_eq!(result.diagnostics.seed_event_checks, 4 * n as usize);
            assert_eq!(
                result.diagnostics.lazy.pair_checks,
                (k * (k + 1) / 2) as usize
            );
            assert_eq!(result.diagnostics.lazy.fallback_pair_checks, 0);
            assert!(result.diagnostics.lazy.stop_indexed);
        }
    }
}

#[test]
fn ordinary_rule_index_skips_disconnected_pairs_and_preserves_exact_fallback() {
    let base = run_lattice(&lattice(16, 0, false), 1330, LazyLookupMode::PlainFast);
    let mut previous_probes = 0;
    let mut rule_probes = None;
    for distractors in [0, 32, 128] {
        let net = lattice(16, distractors, false);
        let fast = run_lattice(&net, 1330, LazyLookupMode::PlainFast);
        let indexed = run_lattice(&net, 1330, LazyLookupMode::StopIndexed);
        let scan = run_lattice(&net, 1330, LazyLookupMode::ScanAll);
        assert_eq!(fast.points, base.points);
        assert_eq!(indexed.points, base.points);
        assert_eq!(scan.points, base.points);
        assert_eq!(fast.diagnostics.lazy.pair_checks, 136);
        assert!(scan.diagnostics.lazy.event_probes > previous_probes);
        previous_probes = scan.diagnostics.lazy.event_probes;
        assert_eq!(
            fast.diagnostics.seed_event_checks,
            (64 + 2 * distractors) as usize
        );
        assert!(fast.diagnostics.incoming_index_bytes > 0); // Vec headers, no PTFT here.
        let ruled = run_lattice(
            &lattice(16, distractors, true),
            1330,
            LazyLookupMode::PlainFast,
        );
        assert_eq!(ruled.points, base.points);
        assert_eq!(ruled.diagnostics.lazy.fallback_pair_checks, 256);
        let probes = ruled.diagnostics.lazy.event_probes;
        assert_eq!(*rule_probes.get_or_insert(probes), probes);
    }
    let with_rule = lattice(16, 128, true);
    let fallback = run_lattice(&with_rule, 1330, LazyLookupMode::PlainFast);
    let scan = run_lattice(&with_rule, 1330, LazyLookupMode::ScanAll);
    assert_eq!(fallback.points, base.points);
    assert_eq!(fallback.points, scan.points);
    assert!(fallback.diagnostics.lazy.stop_indexed);
    assert!(fallback.diagnostics.lazy.event_probes < scan.diagnostics.lazy.event_probes);
    assert_eq!(fallback.diagnostics.lazy.plain_pair_checks, 0);
    assert_eq!(fallback.diagnostics.lazy.fallback_pair_checks, 256);
}

#[test]
fn deadline_queries_keep_frequency_dst_and_both_lasso_representations() {
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
        assert!(!check(&net, &query(0, 3, 85000, 2), 85000..87001, 88000).is_empty());
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
        assert_eq!(
            check(&net, &query(1, 0, 950, 2), 950..1101, 1300),
            [(1000, 1300, 0, 0)]
        );
    }
}

#[test]
fn deadline_caps_coverage_and_binding_fail_without_partial_results() {
    let net = lattice(8, 0, false);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..2000),
    )
    .unwrap();
    let q = query(0, 2, 900, 2);
    let request = || DeadlineRequest::new(&q, 900..1200, 1314);
    for traversal in [DeadlineTraversal::Fifo, DeadlineTraversal::ArrivalFirst] {
        let mut limited = request();
        limited.traversal = traversal;
        limited.max_segments = 1;
        assert!(matches!(
            query_deadline(&reader, &index, &events, limited),
            Err(DeadlineError::SegmentsExhausted { .. })
        ));
        let mut limited = request();
        limited.traversal = traversal;
        limited.max_stop_scans = 1;
        assert!(matches!(
            query_deadline(&reader, &index, &events, limited),
            Err(DeadlineError::StopScansExhausted { .. })
        ));
        let mut limited = request();
        limited.traversal = traversal;
        limited.max_lookup_work = 1;
        assert!(matches!(
            query_deadline(&reader, &index, &events, limited),
            Err(DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. }))
        ));
    }
    let mut changed = q.clone();
    changed.mobility = Mobility::Wheelchair;
    assert!(matches!(
        query_deadline(
            &reader,
            &index,
            &events,
            DeadlineRequest::new(&changed, 900..1200, 1314)
        ),
        Err(DeadlineError::BindingMismatch)
    ));
    assert!(matches!(
        query_deadline(
            &reader,
            &index,
            &events,
            DeadlineRequest::new(&q, 900..1200, 2000)
        ),
        Err(DeadlineError::IncompleteCoverage { .. })
    ));
    let mut phases = Vec::new();
    assert!(
        query_deadline_with_phases(&reader, &index, &events, request(), |phase| phases
            .push(phase))
        .unwrap()
        .complete
    );
    assert_eq!(
        phases,
        [DeadlinePhase::Prepared, DeadlinePhase::SearchFinished]
    );
    changed = q.clone();
    changed.max_rounds = Some(0);
    assert!(query_deadline(
        &reader,
        &index,
        &events,
        DeadlineRequest::new(&changed, 900..1200, 1314)
    )
    .unwrap()
    .points
    .is_empty());
    changed = q.clone();
    changed.entry_stops[0].stop = u32::MAX;
    assert!(matches!(
        query_deadline(
            &reader,
            &index,
            &events,
            DeadlineRequest::new(&changed, 900..1200, 1314)
        ),
        Err(DeadlineError::InvalidRequest(_))
    ));
}

#[test]
fn optimistic_prefix_bound_skips_impossible_suffixes_without_changing_witnesses() {
    let mut net = Net::new(5, 4);
    net.services = vec![0b0000_1000];
    net.trip(0, &[(0, 1000), (1, 1100)]);
    net.trip(1, &[(1, 1300), (2, 1600)]);
    for i in 0..64 {
        net.trip(2, &[(3, 1000 + i), (4, 1100 + i)]);
        net.trip(3, &[(4, 1400 + i), (2, 1700 + i)]);
    }
    let q = query(0, 2, 900, 2);
    let run = |net: &Net, pruning| {
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(QDATE, 900..1801),
        )
        .unwrap();
        let mut request = DeadlineRequest::new(&q, 900..1200, 1800);
        request.pruning = pruning;
        query_deadline(&reader, &index, &events, request).unwrap()
    };
    let base = run(&net, DeadlinePruning::None);
    let pruned = run(&net, DeadlinePruning::EarliestPrefix);
    assert_eq!(base.points, pruned.points);
    assert_eq!(pruned.points.len(), 1);
    assert!(pruned.diagnostics.prefix.enabled);
    assert!(pruned.diagnostics.prefix.pruned_boardings >= 64);
    assert_eq!(pruned.diagnostics.lazy.pair_checks, 1);
    assert!(base.diagnostics.lazy.pair_checks > 4000);
    assert_eq!(pruned.diagnostics.prefix.event_scans, 260);
    assert!(pruned.diagnostics.prefix.walking_relaxations > 0);
    net.transfers
        .push((3, 3, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3));
    let fallback = run(&net, DeadlinePruning::EarliestPrefix);
    assert_eq!(fallback.points, base.points);
    assert!(fallback.diagnostics.prefix.enabled); // Ignoring a ban only adds possibilities.
}

#[test]
fn incumbent_bound_prunes_strictly_dominated_completions_but_not_equal_witnesses() {
    let mut net = Net::new(3, 3);
    net.services = vec![0b0000_1000];
    net.trip(2, &[(0, 1200), (2, 1250)]); // Seed the dominating legal point first.
    for i in 0..64 {
        net.trip(0, &[(0, 1000 + 2 * i), (1, 1100 + 2 * i)]);
        net.trip(1, &[(1, 1220 + 2 * i), (2, 1300 + 2 * i)]);
    }
    let run = |net: &Net, pruning| {
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
        let events = build_event_index(
            &reader,
            &index,
            None,
            &TransferIndexConfig::new(QDATE, 900..2000),
        )
        .unwrap();
        let q = query(0, 2, 900, 2);
        let mut request = DeadlineRequest::new(&q, 900..1300, 1900);
        request.pruning = pruning;
        query_deadline(&reader, &index, &events, request).unwrap()
    };
    let base = run(&net, DeadlinePruning::EarliestPrefix);
    let pruned = run(&net, DeadlinePruning::EarliestPrefixAndPoints);
    assert_eq!(base.points, pruned.points);
    assert_eq!(pruned.points.len(), 1);
    assert_eq!(pruned.diagnostics.lazy.pair_checks, 0);
    assert!(base.diagnostics.lazy.pair_checks > 2000);
    assert!(pruned.diagnostics.prefix.point_pruned_boardings >= 64);
    let mut equal = Net::new(3, 2);
    equal.trip(0, &[(0, 1200), (2, 1250)]);
    equal.trip(1, &[(0, 1200), (2, 1250)]);
    let base = run(&equal, DeadlinePruning::EarliestPrefix);
    let pruned = run(&equal, DeadlinePruning::EarliestPrefixAndPoints);
    assert_eq!(base.points, pruned.points);
    assert_eq!(pruned.diagnostics.prefix.point_pruned_boardings, 0);
    assert_eq!(pruned.points[0].witness[0].trip_idx, 0);
}

#[test]
fn ordinary_rule_candidates_scale_locally_and_linked_rules_keep_the_global_guard() {
    for n in [8u32, 16, 32, 64] {
        let plain = lattice(n, 0, false);
        let ruled = lattice(n, 128, true);
        let deadline = 1300 + 2 * (n - 1) as i64;
        let base = run_lattice(&plain, deadline, LazyLookupMode::PlainFast);
        let indexed = run_lattice(&ruled, deadline, LazyLookupMode::PlainFast);
        let scan = run_lattice(&ruled, deadline, LazyLookupMode::ScanAll);
        assert_eq!(base.points, indexed.points);
        assert_eq!(indexed.points, scan.points);
        assert!(indexed.diagnostics.lazy.stop_indexed);
        // The rule-bearing index uses a zero-floor candidate cutoff. At larger
        // n, some late arrivals follow the earliest departures and must not be
        // checked, even though the original smaller lattice had n*n candidates.
        let candidates = (0..n)
            .flat_map(|a| (0..n).map(move |b| (a, b)))
            .filter(|&(a, b)| 1100 + 2 * a <= 1220 + 2 * b)
            .count();
        assert_eq!(indexed.diagnostics.lazy.pair_checks, candidates);
        assert!(indexed.diagnostics.lazy.event_probes < scan.diagnostics.lazy.event_probes);
        std::println!("ordinary-rule-candidates: n={n}, indexed_probes={}, global_probes={}, indexed_pairs={}, global_pairs={}",
            indexed.diagnostics.lazy.event_probes,scan.diagnostics.lazy.event_probes,
            indexed.diagnostics.lazy.pair_checks,scan.diagnostics.lazy.pair_checks);
    }
    let mut linked = lattice(8, 0, false);
    linked
        .transfers
        .push((1, 1, ABSENT, ABSENT, 0, 1, ABSENT, 4));
    let fallback = run_lattice(&linked, 1314, LazyLookupMode::PlainFast);
    let scan = run_lattice(&linked, 1314, LazyLookupMode::ScanAll);
    assert_eq!(fallback.points, scan.points);
    assert!(!fallback.diagnostics.lazy.stop_indexed);
}

#[test]
fn indexed_rules_keep_zero_floor_synthetics_station_children_and_walking_precedence() {
    // Two distinct platforms of each station, with a scoped minimum-time rule.
    let mut net = Net::new(8, 2);
    net.parents[1] = Some(6);
    net.parents[2] = Some(6);
    net.parents[3] = Some(7);
    net.parents[4] = Some(7);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let target = net.trip(1, &[(3, 1030), (5, 1100)]);
    net.trip(1, &[(4, 1030), (5, 1100)]);
    net.transfers
        .push((6, 7, ABSENT, ABSENT, ABSENT, target, 30, 2));
    assert_eq!(
        check(&net, &query(0, 5, 900, 2), 900..901, 1100),
        [(900, 1100, 1, 30)]
    );
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let events = build_event_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 900..1101),
    )
    .unwrap();
    let q = query(0, 5, 900, 2);
    let mut limited = DeadlineRequest::new(&q, 900..901, 1100);
    limited.max_lookup_work = 1;
    assert!(matches!(
        query_deadline(&reader, &index, &events, limited),
        Err(DeadlineError::Lookup(LazyLookupError::WorkExhausted {
            limit: 1,
            attempted: 2
        }))
    ));
    // A physical edge takes precedence: the rule floor is combined with its
    // actual walk, not replaced by the synthetic minimum.
    net.ptft.push((1, 3, 40));
    assert!(check(&net, &query(0, 5, 900, 2), 900..901, 1100).is_empty());
    let mut timed = Net::new(3, 2);
    timed.trip(0, &[(0, 900), (1, 1000)]);
    timed.trip(1, &[(1, 1000), (2, 1100)]);
    timed
        .transfers
        .push((1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 1));
    assert_eq!(
        check(&timed, &query(0, 2, 900, 2), 900..901, 1100),
        [(900, 1100, 1, 0)]
    );
}

#[test]
fn deadline_session_owns_settings_invalidates_failures_and_preserves_work_caps() {
    let net = lattice(2, 0, false);
    let mut session = DeadlineSession::new(
        Reader::from_bytes(net.bytes()).unwrap(),
        PatternMode::CoveringMerge,
        None,
    )
    .unwrap();
    assert!(matches!(
        session.run(),
        Err(DeadlineError::InvalidRequest(
            "deadline request is not prepared"
        ))
    ));
    let mut q = query(0, 2, 900, 2);
    let mut config = DeadlineSessionConfig::new(900..1200, 1314);
    config.pruning = DeadlinePruning::EarliestPrefixAndPoints;
    session.prepare(q.clone(), config.clone()).unwrap();
    let expected = session.run().unwrap();
    assert!(!expected.points.is_empty());
    let checked = session.run_checked_with_phases(|_| {}).unwrap();
    assert_eq!(expected.points, checked.points);
    assert_eq!(expected.diagnostics, checked.diagnostics);
    q.entry_stops[0].stop = u32::MAX;
    config.arrival_deadline = 0;
    assert_eq!(session.run().unwrap().points, expected.points);
    assert!(session.prepare(q, config).is_err());
    assert!(matches!(
        session.run(),
        Err(DeadlineError::InvalidRequest(
            "deadline request is not prepared"
        ))
    ));
    let q = query(0, 2, 900, 2);
    let mut config = DeadlineSessionConfig::new(900..1200, 1314);
    config.max_lookup_work = 1;
    session.prepare(q.clone(), config.clone()).unwrap();
    assert!(matches!(
        session.run(),
        Err(DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. }))
    ));
    assert!(matches!(
        session.run_checked_with_phases(|_| {}),
        Err(DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. }))
    ));
    config.max_stop_scans = 1;
    session.prepare(q.clone(), config.clone()).unwrap();
    assert!(matches!(
        session.run(),
        Err(DeadlineError::StopScansExhausted { .. })
    ));
    config.max_stop_scans = 10_000_000;
    config.max_lookup_work = 0;
    assert!(session.prepare(q.clone(), config.clone()).is_err());
    assert!(session.run().is_err());
    config.max_lookup_work = 10_000_000;
    config.arrival_deadline = i64::MAX;
    assert!(matches!(
        session.prepare(q.clone(), config.clone()),
        Err(DeadlineSessionPrepareError::Request(DeadlineError::Engine(
            EngineError::TimeOverflow
        )))
    ));
    assert!(session.run().is_err());
    config.arrival_deadline = 1314;
    session.prepare(q, config).unwrap();
    assert_eq!(session.run().unwrap().points, expected.points);
    session.clear();
    assert!(session.run().is_err());
}

#[test]
fn winner_sessions_reject_stale_requests_and_invalid_goals_without_public_bypass() {
    let net = lattice(2, 0, false);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let mut session =
            DeadlineSession::new(Reader::from_bytes(net.bytes()).unwrap(), mode, None).unwrap();
        let not_ready = DeadlineError::InvalidRequest("deadline request is not prepared");
        assert_owned_error(&session, not_ready.clone());
        let q = query(0, 2, 900, 2);
        let mut config = DeadlineSessionConfig::new(900..1200, 1314);
        config.lookup = LazyLookupMode::PlainCached;
        config.pruning = DeadlinePruning::EarliestPrefixAndPoints;
        config.traversal = DeadlineTraversal::ArrivalFirst;
        config.frontier_storage = DeadlineFrontierStorage::EventIndexed;
        session.prepare(q.clone(), config.clone()).unwrap();
        let full = session.run().unwrap();
        assert_owned_winners(&session, &full.points);
        let mut caller_copy = q.clone();
        caller_copy.entry_stops.clear();
        assert_owned_winners(&session, &full.points); // Mutating a caller clone changes nothing.
        session
            .prepare_reusing(caller_copy, config.clone())
            .unwrap();
        assert!(session.catalogue_reused());
        assert_owned_winners(&session, &[]); // No old winner/incumbent was retained.
        let mut invalid = q.clone();
        invalid.entry_stops[0].stop = u32::MAX;
        assert!(session.prepare_reusing(invalid, config.clone()).is_err());
        assert_owned_error(&session, not_ready.clone());
        session.prepare_reusing(q.clone(), config.clone()).unwrap();
        assert!(session.catalogue_reused());
        assert_owned_winners(&session, &full.points);
        session.invalidate_request();
        assert_owned_error(&session, not_ready.clone());
        for invalid_goal in 0..4 {
            let mut invalid = config.clone();
            match invalid_goal {
                0 => invalid.objectives = ProfileObjectives::R3,
                1 => invalid.forward_seeds = true,
                2 => invalid.raptor_seeds = true,
                _ => {
                    invalid.raptor_seeds = true;
                    invalid.raptor_destination_ordering = true;
                }
            }
            if invalid_goal >= 2 {
                assert!(matches!(
                    session.prepare(q.clone(), invalid),
                    Err(DeadlineSessionPrepareError::Request(
                        DeadlineError::InvalidRequest(_)
                    ))
                ));
                assert_owned_error(&session, not_ready.clone());
                continue;
            }
            session.prepare(q.clone(), invalid).unwrap();
            assert_owned_error(
                &session,
                DeadlineError::InvalidRequest("portfolio requires M4 and sampling off"),
            );
        }
        config.max_lookup_work = 0;
        assert!(session.prepare_reusing(q, config).is_err());
        assert_owned_error(&session, not_ready.clone());
        session.clear();
        assert_owned_error(&session, not_ready);
    }
}

#[test]
fn catalogue_reuse_keys_every_dependency_and_never_reuses_a_query() {
    let net = lattice(4, 0, false);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let mut cached =
            DeadlineSession::new(Reader::from_bytes(net.bytes()).unwrap(), mode, None).unwrap();
        let mut fresh =
            DeadlineSession::new(Reader::from_bytes(net.bytes()).unwrap(), mode, None).unwrap();
        let original = query(0, 2, 900, 2);
        let base = DeadlineSessionConfig::new(900..1200, 1314);
        {
            let mut compare = |q: Query, c: DeadlineSessionConfig, hit| {
                cached.prepare_reusing(q.clone(), c.clone()).unwrap();
                assert_eq!(cached.catalogue_reused(), hit);
                fresh.prepare(q, c.clone()).unwrap();
                let a = cached.run().unwrap();
                let b = fresh.run().unwrap();
                assert_eq!(a.points, b.points);
                assert_eq!(a.diagnostics, b.diagnostics);
                if c.objectives == ProfileObjectives::M4 && !c.forward_seeds && !c.raptor_seeds {
                    assert_owned_winners(&cached, &a.points);
                    assert_owned_winners(&fresh, &b.points);
                }
            };
            compare(original.clone(), base.clone(), false);
            let mut q = query(2, 0, 950, 0); // Changed endpoints, departure and round cap.
            q.entry_stops[0].walk_secs = 10;
            q.exit_stops[0].walk_secs = 20;
            let mut c = base.clone();
            c.window.end = 1100;
            c.objectives = ProfileObjectives::R3;
            c.pruning = DeadlinePruning::EarliestPrefixAndPoints;
            c.traversal = DeadlineTraversal::ArrivalFirst;
            c.static_bound = true;
            c.walking_bound = true;
            c.forward_seeds = true;
            c.lookup = LazyLookupMode::ScanAll;
            compare(q, c, true);
            compare(original.clone(), base.clone(), true);
            // Each canonical key field must miss, even if this fixture's routes
            // happen not to produce a different result under that setting.
            let mut q = original.clone();
            q.date += 1;
            compare(q, base.clone(), false);
            compare(original.clone(), base.clone(), false);
            for mobility in [Mobility::Wheelchair, Mobility::Bicycle, Mobility::Default] {
                let mut q = original.clone();
                q.mobility = mobility;
                compare(q, base.clone(), false);
            }
            let mut c = base.clone();
            c.window.start += 1;
            compare(original.clone(), c, false);
            compare(original.clone(), base.clone(), false);
            let mut c = base.clone();
            c.arrival_deadline += 1;
            compare(original.clone(), c, false);
            compare(original.clone(), base.clone(), false);
            let mut q = original.clone();
            q.excluded_modes = vec![3];
            compare(q, base.clone(), false);
            let mut q = original.clone();
            q.excluded_modes = vec![700, 3, 700];
            compare(q, base.clone(), true); // Same normalized bus family.
            let mut q = original.clone();
            q.excluded_modes = vec![3, 0];
            compare(q, base.clone(), false);
            compare(original.clone(), base.clone(), false);
        }
        let mut invalid = original.clone();
        invalid.entry_stops[0].stop = u32::MAX;
        assert!(cached.prepare_reusing(invalid, base.clone()).is_err());
        assert!(cached.run().is_err());
        cached
            .prepare_reusing(original.clone(), base.clone())
            .unwrap();
        assert!(cached.catalogue_reused()); // Retained valid entry, not stale request.
        cached.invalidate_request();
        assert!(cached.run().is_err());
        cached
            .prepare_reusing(original.clone(), base.clone())
            .unwrap();
        assert!(cached.catalogue_reused());
        cached.clear();
        assert!(cached.run().is_err());
        cached
            .prepare_reusing(original.clone(), base.clone())
            .unwrap();
        assert!(!cached.catalogue_reused());
        let mut c = base.clone();
        c.max_lookup_work = 1;
        cached.prepare_reusing(original.clone(), c).unwrap();
        assert!(cached.catalogue_reused());
        assert!(matches!(
            cached.run(),
            Err(DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. }))
        ));
        let mut invalid = base.clone();
        invalid.arrival_deadline = i64::MAX;
        assert!(cached.prepare_reusing(original.clone(), invalid).is_err());
        assert!(cached.run().is_err());
        cached.prepare(original.clone(), base.clone()).unwrap();
        assert!(!cached.catalogue_reused()); // Fresh remains the default ablation.
    }
}

#[test]
fn deadline_route_exclusions_match_the_raw_oracle() {
    let mut net = Net::new(2, 2);
    net.trip(0, &[(0, 1000), (1, 1100)]);
    net.trip(1, &[(0, 900), (1, 1200)]);
    let mut q = query(0, 1, 850, 1);
    q.excluded_routes = vec![0];
    assert_eq!(check(&net, &q, 900..901, 1300), [(900, 1200, 0, 0)]);
    q.excluded_routes = vec![0, 1];
    assert!(check(&net, &q, 900..901, 1300).is_empty());
}
