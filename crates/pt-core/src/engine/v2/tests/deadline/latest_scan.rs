//! H58: the backward scan's latest departure equals the latest origin
//! departure of the exhaustive reference profile, of the raw oracle and of
//! the session's exact latest selector, and that selector on the one-second
//! window at the scan's departure returns the full window's winner.
use super::*;
use crate::engine::temporal_probe::r3::R3Point;
use core::ops::Range;
use std::{eprintln, format};

pub(super) const MODES: [PatternMode; 3] = [
    PatternMode::Off,
    PatternMode::Unbounded,
    PatternMode::CoveringMerge,
];

pub(super) fn selector_config(window: Range<i64>, deadline: i64) -> DeadlineSessionConfig {
    let mut c = DeadlineSessionConfig::new(window, deadline);
    c.lookup = LazyLookupMode::PlainCached;
    c.pruning = DeadlinePruning::EarliestPrefixAndTimetablePoints;
    c.traversal = DeadlineTraversal::ArrivalFirst;
    c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
    c.witness_comparison = DeadlineWitnessComparison::MaterializedDateMemo;
    c
}

/// The session's exact latest winner on `window`, or its error.
fn latest_winner(
    owner: &mut DeadlineSession,
    q: &Query,
    window: Range<i64>,
    deadline: i64,
) -> Result<Option<R3Point>, String> {
    owner
        .prepare_with_prefix_cache(q.clone(), selector_config(window, deadline))
        .map_err(|e| format!("{e:?}"))?;
    owner
        .run_preference_with_phases(
            DeadlinePreference::LatestDeparture,
            DeadlineSuffixPruning::RowPrefix,
            |_| {},
        )
        .map(|r| r.winner)
        .map_err(|e| format!("{e:?}"))
}

/// Checks one query on one owner; returns the scan's departure.
fn assert_scan_certifies(
    owner: &mut DeadlineSession,
    q: &Query,
    window: Range<i64>,
    deadline: i64,
    reference: Option<i64>,
) -> Option<i64> {
    let scan = owner
        .latest_departure(q, window.clone(), deadline)
        .unwrap_or_else(|e| panic!("scan: {e:?}"));
    assert_eq!(scan.departure, reference, "scan departure for {q:?}");
    let full = latest_winner(owner, q, window.clone(), deadline).expect("full window");
    assert_eq!(
        full.as_ref().map(|w| w.origin_departure_secs),
        scan.departure,
        "selector departure for {q:?}"
    );
    if let Some(d) = scan.departure {
        let narrow = latest_winner(owner, q, d..d + 1, deadline).expect("one second");
        assert_eq!(narrow, full, "one-second winner for {q:?}");
    }
    scan.departure
}

/// The latest departure among reference points arriving by `deadline`.
fn reference_latest<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    q: &Query,
    window: &Range<i64>,
    deadline: i64,
) -> Option<i64> {
    let mut request = R3Request::new(q, window.clone());
    request.transfers = transfers;
    request.max_labels = 1_000_000;
    profile_m4(reader, index, request)
        .unwrap()
        .points
        .iter()
        .filter(|p| p.destination_arrival_secs <= deadline)
        .map(|p| p.origin_departure_secs)
        .max()
}

/// `net` without explicit transfer rows or frequencies, the scan's scope.
pub(super) fn in_scope(mut net: Net) -> Net {
    net.transfers.clear();
    net.freqs.clear();
    net.quarantine.clear();
    net
}

#[test]
fn latest_scan_matches_the_reference_oracle_and_selector_on_generated_networks() {
    let mut rng = Rng(0x4835_385f_7363_616e);
    let (mut cases, mut found) = (0, 0);
    for _ in 0..1_000 {
        let mut net = in_scope(random_net(&mut rng));
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
            68_000,
            1 + rng.below(4) as u32,
        );
        q.entry_stops[0].walk_secs = rng.below(60) as u32;
        q.exit_stops[0].walk_secs = rng.below(60) as u32;
        if rng.chance(30) {
            q.mobility = Mobility::Wheelchair;
        }
        vary_walk_settings(&mut rng, &mut q);
        let window = 68_000..(70_000 + rng.below(4_000) as i64);
        // The selector needs the window to end by the deadline.
        let deadline = window.end - 1 + rng.below(6_000) as i64;
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let walks = net.ptft_table();
        // The raw oracle takes one entry/exit pair.
        let raw = expected(&net, &q, &window, ProfileObjectives::M4)
            .into_iter()
            .filter(|p| p.1 <= deadline)
            .map(|p| p.0)
            .max();
        let mut multi = q.clone();
        multi.entry_stops.push(StopWalk {
            stop: rng.below(5) as u32,
            walk_secs: rng.below(90) as u32,
        });
        multi.exit_stops.push(StopWalk {
            stop: rng.below(5) as u32,
            walk_secs: rng.below(90) as u32,
        });
        for mode in MODES {
            let index = Index::build(&reader, mode).unwrap();
            let reference =
                reference_latest(&reader, &index, walks.as_ref(), &q, &window, deadline);
            assert_eq!(reference, raw, "reference against the raw oracle");
            let multi_reference =
                reference_latest(&reader, &index, walks.as_ref(), &multi, &window, deadline);
            let mut owner = DeadlineSession::new_with_immutable_binding(
                Reader::from_bytes(net.bytes()).unwrap(),
                mode,
                net.ptft_table(),
            )
            .unwrap();
            found += usize::from(
                assert_scan_certifies(&mut owner, &q, window.clone(), deadline, reference)
                    .is_some(),
            );
            assert_scan_certifies(
                &mut owner,
                &multi,
                window.clone(),
                deadline,
                multi_reference,
            );
            cases += 2;
        }
    }
    eprintln!("cases={cases} with a departure={found}");
    assert!(found > 500, "sparse corpus: {found} of {cases}");
}

/// A ride 0 -> 1 departing 1000 and arriving 1100, then `then` to stop 2.
pub(super) fn after_first_ride(then: impl Fn(&mut Net)) -> Net {
    let mut net = Net::new(4, 3);
    net.trip(0, &[(0, 1000), (1, 1100)]);
    then(&mut net);
    net
}

#[test]
fn latest_scan_follows_derived_continuations_walks_and_the_transfer_minimum() {
    let derived = |chained: bool| {
        after_first_ride(move |net| {
            net.derive = chained;
            net.trip(1, &[(1, 1160), (2, 1300)]);
            net.trips[0].block = Some("A");
            net.trips[1].block = Some("A");
        })
    };
    let change = |dep: u32| {
        after_first_ride(move |net| {
            net.trip(1, &[(1, dep), (2, dep + 100)]);
        })
    };
    let walk = |secs: u32, dep: u32| {
        after_first_ride(move |net| {
            net.ptft.push((1, 3, secs));
            net.trip(1, &[(3, dep), (2, dep + 100)]);
        })
    };
    let egress = after_first_ride(|net| net.ptft.push((1, 2, 100)));
    // (network, rounds, deadline, latest departure)
    let cases = [
        (derived(true), 2, 1300, Some(1000)),
        (derived(true), 1, 2000, None),
        (derived(true), 2, 1299, None),
        (derived(false), 3, 2000, None),
        (change(1220), 2, 2000, Some(1000)),
        (change(1219), 3, 2000, None),
        (walk(60, 1220), 2, 2000, Some(1000)),
        (walk(60, 1219), 2, 2000, None),
        (walk(300, 1400), 2, 2000, Some(1000)),
        (walk(300, 1399), 2, 2000, None),
        (egress.clone(), 1, 1200, Some(1000)),
        (egress, 1, 1199, None),
    ];
    for (i, (net, rounds, deadline, latest)) in cases.into_iter().enumerate() {
        let q = query(0, 2, 900, rounds);
        let window = 900..1_101;
        for mode in MODES {
            let reader = Reader::from_bytes(net.bytes()).unwrap();
            let index = Index::build(&reader, mode).unwrap();
            let walks = net.ptft_table();
            let reference =
                reference_latest(&reader, &index, walks.as_ref(), &q, &window, deadline);
            assert_eq!(reference, latest, "case {i}: reference");
            let mut owner =
                DeadlineSession::new_with_immutable_binding(reader, mode, net.ptft_table())
                    .unwrap();
            assert_scan_certifies(&mut owner, &q, window.clone(), deadline, reference);
        }
    }
}

#[test]
fn latest_scan_applies_the_window_at_the_origin_only() {
    // Trip 0 departs at 1000 and 1200; only the window decides which counts.
    let mut net = Net::new(3, 1);
    net.trip(0, &[(0, 1000), (1, 1100), (2, 1200)]);
    net.trip(0, &[(0, 1200), (1, 1300), (2, 1400)]);
    let q = query(0, 2, 900, 2);
    for (window, deadline, latest) in [
        (900..1_201, 1_400, Some(1_200)),
        (900..1_200, 1_400, Some(1_000)),
        (1_001..1_200, 1_400, None),
        (900..1_201, 1_399, Some(1_000)),
        (1_000..1_001, 1_200, Some(1_000)),
    ] {
        for mode in MODES {
            let mut owner = DeadlineSession::new_with_immutable_binding(
                Reader::from_bytes(net.bytes()).unwrap(),
                mode,
                None,
            )
            .unwrap();
            assert_scan_certifies(&mut owner, &q, window.clone(), deadline, latest);
        }
    }
}

#[test]
fn latest_scan_is_unsupported_outside_its_scope() {
    let mut net = Net::new(3, 1);
    net.trip(0, &[(0, 1000), (1, 1100), (2, 1200)]);
    let q = query(0, 2, 900, 2);
    let scan = |net: &Net, window: Range<i64>, deadline: i64| {
        let mut owner = DeadlineSession::new(
            Reader::from_bytes(net.bytes()).unwrap(),
            PatternMode::CoveringMerge,
            None,
        )
        .unwrap();
        let first = owner.latest_departure(&q, window.clone(), deadline);
        assert!(owner.latest_scan_bytes() > 0);
        let second = owner.latest_departure(&q, window, deadline);
        if let (Ok(a), Ok(b)) = (&first, &second) {
            assert!(a.diagnostics.index_built && !b.diagnostics.index_built);
            assert_eq!(a.departure, b.departure);
        } else {
            assert_eq!(first, second);
        }
        first.map(|r| r.departure)
    };
    assert_eq!(scan(&net, 900..1_001, 1_200), Ok(Some(1_000)));
    assert_eq!(
        scan(&net, 900..900, 1_200),
        Err(LatestScanError::Unsupported("empty window"))
    );
    assert_eq!(
        scan(&net, 900..1_001, 900 + 172_801),
        Err(LatestScanError::Unsupported("deadline beyond the horizon"))
    );
    let mut ruled = Net::new(3, 1);
    ruled.trip(0, &[(0, 1000), (1, 1100), (2, 1200)]);
    ruled
        .transfers
        .push((1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3));
    assert_eq!(
        scan(&ruled, 900..1_001, 1_200),
        Err(LatestScanError::Unsupported("explicit transfer rules"))
    );
    let mut frequent = Net::new(3, 1);
    frequent.trip(0, &[(0, 1000), (1, 1100), (2, 1200)]);
    frequent.freqs.push((0, 1000, 1600, 300, 1));
    assert_eq!(
        scan(&frequent, 900..1_001, 1_200),
        Err(LatestScanError::Unsupported("frequencies"))
    );
}

#[derive(Default, Debug)]
struct Tally {
    compared: usize,
    found: usize,
    /// The full-window request failed; it is not compared.
    full_failed: usize,
    /// Of those, the scan found a departure and the one-second request
    /// completed: reported apart, never counted as a comparison.
    narrow_completed: usize,
    out_of_scope: usize,
}

fn tally(owner: &mut DeadlineSession, q: &Query, window: Range<i64>, deadline: i64, t: &mut Tally) {
    match latest_winner(owner, q, window.clone(), deadline) {
        Ok(w) => {
            t.compared += 1;
            let full = w.map(|w| w.origin_departure_secs);
            t.found +=
                usize::from(assert_scan_certifies(owner, q, window, deadline, full).is_some());
        }
        Err(_) => {
            t.full_failed += 1;
            match owner.latest_departure(q, window, deadline) {
                Ok(r) => {
                    if let Some(d) = r.departure {
                        t.narrow_completed +=
                            usize::from(latest_winner(owner, q, d..d + 1, deadline).is_ok());
                    }
                }
                Err(LatestScanError::Unsupported(_)) => t.out_of_scope += 1,
                Err(_) => {}
            }
        }
    }
}

/// The eight frozen scopes: window start, end and deadline.
const SCOPES: [(i64, i64, i64); 8] = [
    (28_800, 36_001, 36_000),
    (21_600, 36_001, 36_000),
    (108_000, 115_201, 115_200),
    (100_800, 115_201, 115_200),
    (194_400, 201_601, 201_600),
    (187_200, 201_601, 201_600),
    (0, 36_001, 36_000),
    (28_800, 36_001, 115_200),
];

/// H58 on a real bundle: `PTN_H58_BUNDLE`, `PTN_H58_PTFT` (absolute paths),
/// `PTN_H58_TUPLES` (`entry:exit:yyyymmdd` stop IDs, comma-separated) and
/// `PTN_H58_RANDOM` (seeded random queries), then `cargo test --release -p
/// pt-core --features temporal-experiment --lib latest_scan_certifies_bundle
/// -- --ignored --nocapture`.
#[test]
#[ignore]
fn latest_scan_certifies_bundle_queries() {
    let var = |k: &str| std::env::var(k).ok();
    let reader =
        Reader::from_bytes(std::fs::read(var("PTN_H58_BUNDLE").expect("PTN_H58_BUNDLE")).unwrap())
            .unwrap();
    let transfers =
        var("PTN_H58_PTFT").map(|p| Transfers::from_bytes(std::fs::read(p).unwrap()).unwrap());
    let mut owner =
        DeadlineSession::new_with_immutable_binding(reader, PatternMode::CoveringMerge, transfers)
            .unwrap();
    let stop = |owner: &DeadlineSession, id: &str| owner.reader().stop_index(id).expect(id);
    let mut frozen = Tally::default();
    for t in var("PTN_H58_TUPLES")
        .unwrap_or_default()
        .split(',')
        .filter(|t| !t.is_empty())
    {
        let parts: Vec<&str> = t.split(':').collect();
        let mut q = query(stop(&owner, parts[0]), stop(&owner, parts[1]), 0, 4);
        q.date = parts[2].parse().unwrap();
        for (start, end, deadline) in SCOPES {
            q.departure_secs = start;
            tally(&mut owner, &q, start..end, deadline, &mut frozen);
        }
    }
    eprintln!("frozen {frozen:?}");
    let count: usize = var("PTN_H58_RANDOM").map_or(0, |n| n.parse().unwrap());
    let mut rng = Rng(0x4835_385f_6275_6e64);
    let served: Vec<u32> = (0..owner.reader().num_stops() as u32)
        .filter(|s| owner_routes_at(&owner, *s))
        .collect();
    let days = owner.reader().num_service_day_origins().saturating_sub(3) as u64;
    let mut random = Tally::default();
    for _ in 0..count {
        let from = served[rng.below(served.len() as u64) as usize];
        let to = served[rng.below(served.len() as u64) as usize];
        let start = rng.below(86_400) as i64;
        let end = start + [1, 900, 3_600, 7_200, 14_400][rng.below(5) as usize];
        let deadline = end - 1 + [0, 1_800, 7_200][rng.below(3) as usize];
        let mut q = query(from, to, start, [2, 3, 4, 4][rng.below(4) as usize]);
        q.date = crate::reader::days_add(owner.reader().feed_start_date(), rng.below(days) as i64);
        if rng.chance(20) {
            q.mobility = Mobility::Wheelchair;
        }
        tally(&mut owner, &q, start..end, deadline, &mut random);
    }
    eprintln!("random {random:?}");
    assert_eq!(frozen.out_of_scope + random.out_of_scope, 0);
}

fn owner_routes_at(owner: &DeadlineSession, stop: u32) -> bool {
    owner.index_for_test().routes_at_stop.contains_key(&stop)
}

#[test]
fn latest_scan_declines_the_committed_fixture_for_its_transfer_rules() {
    // tiny-v2 carries explicit transfers.txt rows, outside the scan's scope.
    let bytes =
        include_bytes!("../../../../../../../packages/shared/src/ptb/__fixtures__/tiny-v2.ptb");
    let reader = Reader::from_bytes(bytes.to_vec()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let rules = &index.v2.as_deref().unwrap().rules;
    assert!(!rules.ordinary.is_empty() || !rules.linked.is_empty());
    let mut owner =
        DeadlineSession::new_with_immutable_binding(reader, PatternMode::CoveringMerge, None)
            .unwrap();
    let mut q = query(0, 1, 21_600, 4);
    q.date = crate::reader::days_add(owner.reader().feed_start_date(), 1);
    assert_eq!(
        owner.latest_departure(&q, 21_600..36_001, 36_000),
        Err(LatestScanError::Unsupported("explicit transfer rules"))
    );
}
