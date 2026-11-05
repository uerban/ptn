//! H81: the scans for fewest transfers and least walking return the
//! selector's optimal first key and the latest departure achieving it, equal
//! to the raw oracle, the exhaustive reference profile and the session's
//! exact selector; that selector on the one-second window at the scan's
//! departure returns the full window's winner.
use super::latest_scan::{after_first_ride, in_scope, selector_config, MODES};
use super::*;
use crate::engine::temporal_probe::r3::R3Point;
use core::ops::Range;
use std::{eprintln, format};

const SELECTORS: [DeadlinePreference; 2] = [
    DeadlinePreference::FewestTransfers,
    DeadlinePreference::LeastWalking,
];

/// `(optimum, departure)`: the smallest first key, then the latest departure.
type Optimum = Option<(u64, i64)>;

/// The selector's first key of a `(departure, arrival, transfers, walk)`
/// tuple.
fn key(preference: DeadlinePreference, t: u32, w: u64) -> u64 {
    match preference {
        DeadlinePreference::FewestTransfers => u64::from(t),
        DeadlinePreference::LeastWalking => w,
        _ => unreachable!(),
    }
}

fn optimum(preference: DeadlinePreference, tuples: impl Iterator<Item = Tuple4>) -> Optimum {
    tuples
        .map(|(d, _, t, w)| (key(preference, t, w), d))
        .min_by_key(|&(k, d)| (k, -d))
}

type Tuple4 = (i64, i64, u32, u64);

fn winner(
    owner: &mut DeadlineSession,
    preference: DeadlinePreference,
    q: &Query,
    window: Range<i64>,
    deadline: i64,
) -> Result<Option<R3Point>, String> {
    owner
        .prepare_with_prefix_cache(q.clone(), selector_config(window, deadline))
        .map_err(|e| format!("{e:?}"))?;
    owner
        .run_preference_with_phases(preference, DeadlineSuffixPruning::RowPrefix, |_| {})
        .map(|r| r.winner)
        .map_err(|e| format!("{e:?}"))
}

fn reference<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    preference: DeadlinePreference,
    q: &Query,
    window: &Range<i64>,
    deadline: i64,
) -> Optimum {
    let mut request = R3Request::new(q, window.clone());
    request.transfers = transfers;
    request.max_labels = 1_000_000;
    let points = profile_m4(reader, index, request).unwrap().points;
    optimum(
        preference,
        points
            .iter()
            .filter(|p| p.destination_arrival_secs <= deadline)
            .map(|p| {
                (
                    p.origin_departure_secs,
                    p.destination_arrival_secs,
                    p.actual_transfers,
                    p.total_walk_secs,
                )
            }),
    )
}

/// Checks one query and selector on one owner; returns the scan's result.
fn assert_scan_certifies(
    owner: &mut DeadlineSession,
    preference: DeadlinePreference,
    q: &Query,
    window: Range<i64>,
    deadline: i64,
    expected: Optimum,
) -> Optimum {
    let scan = owner
        .selector_departure(preference, q, window.clone(), deadline)
        .unwrap_or_else(|e| panic!("scan: {e:?}"));
    let got = scan.optimum.zip(scan.departure);
    assert_eq!(scan.optimum.is_some(), scan.departure.is_some());
    assert_eq!(got, expected, "{preference:?} scan for {q:?}");
    let full = winner(owner, preference, q, window.clone(), deadline).expect("full window");
    assert_eq!(
        full.as_ref().map(|w| (
            key(preference, w.actual_transfers, w.total_walk_secs),
            w.origin_departure_secs
        )),
        got,
        "{preference:?} selector for {q:?}"
    );
    if let Some((_, d)) = got {
        let narrow = winner(owner, preference, q, d..d + 1, deadline).expect("one second");
        assert_eq!(narrow, full, "{preference:?} one-second winner for {q:?}");
    }
    got
}

/// Denser than [`random_net`] and in the scans' scope: more routes, trips
/// and walks, so the fewest-transfers and least-walking winners more often
/// depart before the latest journey.
fn dense_net(rng: &mut Rng) -> Net {
    let stops = 7u32;
    let mut n = Net::new(stops as usize, 6);
    n.services = (0..3).map(|_| (rng.next() as u8) | 0b0001_1000).collect();
    for route in 0..6u32 {
        let len = 2 + rng.below(4) as usize;
        let mut seq: Vec<u32> = (0..stops).collect();
        for i in 0..stops as usize {
            let j = i + rng.below(stops as u64 - i as u64) as usize;
            seq.swap(i, j);
        }
        seq.truncate(len);
        let mut first = 68_500 + rng.below(1_500) as u32;
        for _ in 0..(1 + rng.below(4)) {
            let mut t = first;
            let mut rows = Vec::new();
            for &s in &seq {
                rows.push((s, t, -(rng.below(3) as i16 * 20)));
                t += 60 + rng.below(500) as u32;
            }
            n.trips.push(TripSpec {
                route,
                service: rng.below(3) as u32,
                rows,
                block: match rng.below(4) {
                    0 => Some("A"),
                    1 => Some("B"),
                    _ => None,
                },
                wheelchair: 0,
            });
            first += 120 + rng.below(900) as u32;
        }
    }
    n.derive = rng.chance(50);
    for _ in 0..rng.below(10) {
        let a = rng.below(stops as u64) as u32;
        let b = rng.below(stops as u64) as u32;
        if a != b {
            n.ptft.push((a, b, 20 + rng.below(300) as u32));
        }
    }
    n
}

#[derive(Default, Debug)]
struct Corpus {
    cases: usize,
    found: usize,
    /// The winner departs before the latest journey's departure.
    not_latest: usize,
    /// The optimum is not zero: a change or some walking is unavoidable.
    nonzero: usize,
}

fn check_corpus(seed: u64, iterations: usize, stops: u64, dense: bool) -> Corpus {
    let mut rng = Rng(seed);
    let mut tally = Corpus::default();
    for _ in 0..iterations {
        let mut net = if dense {
            dense_net(&mut rng)
        } else {
            in_scope(random_net(&mut rng))
        };
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
            rng.below(stops) as u32,
            rng.below(stops) as u32,
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
        let raw: Vec<Tuple4> = expected(&net, &q, &window, ProfileObjectives::M4)
            .into_iter()
            .filter(|p| p.1 <= deadline)
            .collect();
        let latest = raw.iter().map(|p| p.0).max();
        let mut multi = q.clone();
        multi.entry_stops.push(StopWalk {
            stop: rng.below(stops) as u32,
            walk_secs: rng.below(90) as u32,
        });
        multi.exit_stops.push(StopWalk {
            stop: rng.below(stops) as u32,
            walk_secs: rng.below(90) as u32,
        });
        for mode in MODES {
            let index = Index::build(&reader, mode).unwrap();
            let mut owner = DeadlineSession::new_with_immutable_binding(
                Reader::from_bytes(net.bytes()).unwrap(),
                mode,
                net.ptft_table(),
            )
            .unwrap();
            for preference in SELECTORS {
                let oracle = optimum(preference, raw.iter().copied());
                let single = reference(
                    &reader,
                    &index,
                    walks.as_ref(),
                    preference,
                    &q,
                    &window,
                    deadline,
                );
                assert_eq!(
                    single, oracle,
                    "{preference:?} reference against the raw oracle"
                );
                let got = assert_scan_certifies(
                    &mut owner,
                    preference,
                    &q,
                    window.clone(),
                    deadline,
                    single,
                );
                tally.found += usize::from(got.is_some());
                tally.not_latest += usize::from(got.is_some_and(|g| Some(g.1) != latest));
                tally.nonzero += usize::from(got.is_some_and(|g| g.0 > 0));
                let multi_reference = reference(
                    &reader,
                    &index,
                    walks.as_ref(),
                    preference,
                    &multi,
                    &window,
                    deadline,
                );
                assert_scan_certifies(
                    &mut owner,
                    preference,
                    &multi,
                    window.clone(),
                    deadline,
                    multi_reference,
                );
                tally.cases += 2;
            }
        }
    }
    tally
}

#[test]
fn selector_scans_match_the_oracle_reference_and_selector_on_generated_networks() {
    let t = check_corpus(0x4838_315f_7363_616e, 600, 5, false);
    eprintln!("random {t:?}");
    assert!(t.found > 600, "sparse corpus: {t:?}");
    assert!(
        t.not_latest > 30 && t.nonzero > 100,
        "few distinct winners: {t:?}"
    );
}

#[test]
fn selector_scans_match_the_oracle_reference_and_selector_on_dense_networks() {
    let t = check_corpus(0x4838_315f_6465_6e73, 120, 7, true);
    eprintln!("dense {t:?}");
    assert!(t.found > 300, "sparse corpus: {t:?}");
    assert!(
        t.not_latest > 15 && t.nonzero > 200,
        "few distinct winners: {t:?}"
    );
}

#[test]
fn fewest_transfers_scan_trades_a_later_departure_for_fewer_changes() {
    // Direct 0 -> 2 at 1000, or 0 -> 1 at 1050 then 1 -> 2: one change later.
    let mut net = Net::new(3, 3);
    net.trip(0, &[(0, 1000), (2, 1500)]);
    net.trip(1, &[(0, 1050), (1, 1100)]);
    net.trip(2, &[(1, 1300), (2, 1400)]);
    let q = query(0, 2, 900, 2);
    let window = 900..1_101;
    // (rounds, deadline, fewest transfers, latest departure, least walking)
    for (rounds, deadline, transfers, walking) in [
        (2, 2_000, Some((0, 1_000)), Some((0, 1_050))),
        (1, 2_000, Some((0, 1_000)), Some((0, 1_000))),
        (2, 1_499, Some((1, 1_050)), Some((0, 1_050))),
        (1, 1_499, None, None),
    ] {
        let mut q = q.clone();
        q.max_rounds = Some(rounds);
        for mode in MODES {
            let mut owner = DeadlineSession::new_with_immutable_binding(
                Reader::from_bytes(net.bytes()).unwrap(),
                mode,
                None,
            )
            .unwrap();
            for (preference, expected) in SELECTORS.into_iter().zip([transfers, walking]) {
                assert_scan_certifies(
                    &mut owner,
                    preference,
                    &q,
                    window.clone(),
                    deadline,
                    expected,
                );
            }
        }
    }
}

#[test]
fn least_walking_scan_keeps_a_slower_walk_free_change() {
    // After 0 -> 1 at 1000-1100: walk 1 -> 3 (200 s) for a 1350 bus, or wait
    // at 1 for a 1600 bus. The walk-free change is later at the destination
    // but departs the same; an earlier walk-free ride competes on departure.
    let net = |early: bool| {
        let mut net = Net::new(4, 4);
        net.trip(0, &[(0, 1000), (1, 1100)]);
        net.ptft.push((1, 3, 200));
        net.trip(1, &[(3, 1350), (2, 1450)]);
        net.trip(2, &[(1, 1600), (2, 1700)]);
        if early {
            net.trip(3, &[(0, 950), (2, 1650)]);
        }
        net
    };
    let q = query(0, 2, 900, 2);
    let window = 900..1_101;
    // (early direct ride, deadline, fewest transfers, least walking)
    for (early, deadline, transfers, walking) in [
        (false, 2_000, Some((1, 1_000)), Some((0, 1_000))),
        (false, 1_699, Some((1, 1_000)), Some((200, 1_000))),
        (false, 1_449, None, None),
        (true, 1_699, Some((0, 950)), Some((0, 950))),
        (true, 2_000, Some((0, 950)), Some((0, 1_000))),
    ] {
        let net = net(early);
        for mode in MODES {
            let mut owner = DeadlineSession::new_with_immutable_binding(
                Reader::from_bytes(net.bytes()).unwrap(),
                mode,
                net.ptft_table(),
            )
            .unwrap();
            for (preference, expected) in SELECTORS.into_iter().zip([transfers, walking]) {
                assert_scan_certifies(
                    &mut owner,
                    preference,
                    &q,
                    window.clone(),
                    deadline,
                    expected,
                );
            }
        }
    }
}

#[test]
fn selector_scans_count_a_derived_continuation_as_no_transfer() {
    let net = after_first_ride(|net| {
        net.derive = true;
        net.trip(1, &[(1, 1160), (2, 1300)]);
        net.trips[0].block = Some("A");
        net.trips[1].block = Some("A");
    });
    let q = query(0, 2, 900, 2);
    for mode in MODES {
        let mut owner = DeadlineSession::new_with_immutable_binding(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            None,
        )
        .unwrap();
        for preference in SELECTORS {
            assert_scan_certifies(
                &mut owner,
                preference,
                &q,
                900..1_101,
                1_300,
                Some((0, 1_000)),
            );
        }
    }
}

#[test]
fn selector_scan_declines_latest_and_fastest() {
    let mut net = Net::new(3, 1);
    net.trip(0, &[(0, 1000), (1, 1100), (2, 1200)]);
    let mut owner = DeadlineSession::new(
        Reader::from_bytes(net.bytes()).unwrap(),
        PatternMode::CoveringMerge,
        None,
    )
    .unwrap();
    let q = query(0, 2, 900, 2);
    for preference in [
        DeadlinePreference::LatestDeparture,
        DeadlinePreference::Fastest,
    ] {
        assert_eq!(
            owner.selector_departure(preference, &q, 900..1_001, 1_200),
            Err(LatestScanError::Unsupported(
                "selector has no departure scan"
            ))
        );
    }
    let first = owner
        .selector_departure(DeadlinePreference::FewestTransfers, &q, 900..1_001, 1_200)
        .unwrap();
    let second = owner
        .selector_departure(DeadlinePreference::LeastWalking, &q, 900..1_001, 1_200)
        .unwrap();
    assert!(first.diagnostics.index_built && !second.diagnostics.index_built);
    assert_eq!((first.optimum, first.departure), (Some(0), Some(1_000)));
    assert_eq!((second.optimum, second.departure), (Some(0), Some(1_000)));
}
