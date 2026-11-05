//! Trip-segment profiles versus the raw journey oracle and exhaustive v2
//! search. Witness legality is checked through the oracle's own boardings.
use super::*;
use crate::engine::temporal_probe::r3::{
    profile_m4, profile_r3, ProfileObjectives, R3Point, R3Request,
};
use crate::engine::temporal_probe::trip_based::*;
use core::ops::Range;

type Tuple = (i64, i64, u32, u64);

pub(super) fn tuples(points: &[R3Point], objective: ProfileObjectives) -> Vec<Tuple> {
    let mut out: Vec<_> = points
        .iter()
        .map(|p| {
            (
                p.origin_departure_secs,
                p.destination_arrival_secs,
                p.actual_transfers,
                if objective == ProfileObjectives::M4 {
                    p.total_walk_secs
                } else {
                    0
                },
            )
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

pub(super) fn expected(
    net: &Net,
    q: &Query,
    window: &Range<i64>,
    objective: ProfileObjectives,
) -> Vec<Tuple> {
    let mut all: Vec<_> = oracle_raw(net, q, Some(window))
        .profile
        .into_iter()
        .map(|(d, a, t, w)| {
            (
                d,
                a,
                t,
                if objective == ProfileObjectives::M4 {
                    w
                } else {
                    0
                },
            )
        })
        .collect();
    all.sort_unstable();
    all.dedup();
    all.iter()
        .copied()
        .filter(|p| {
            !all.iter()
                .any(|a| a != p && a.0 >= p.0 && a.1 <= p.1 && a.2 <= p.2 && a.3 <= p.3)
        })
        .collect()
}

fn config(q: &Query, window: &Range<i64>) -> TransferIndexConfig {
    TransferIndexConfig::for_query(q, window.start..window.end + ROUTING_HORIZON_SECS)
}

pub(super) fn legal_witnesses(net: &Net, q: &Query, index: &Index, points: &[R3Point]) {
    with_oracle(net, q, |o| {
        for point in points {
            assert_eq!(point.witness.len() as u32, point.transit_rounds);
            assert!(point.transit_rounds <= q.max_rounds.unwrap_or(8));
            assert_eq!(
                point.actual_transfers,
                point.transit_rounds
                    - 1
                    - point.witness.iter().filter(|l| l.in_seat).count() as u32
            );
            let mut previous: Option<(usize, usize)> = None;
            let first = point.witness.first().unwrap();
            let access = u32::try_from(first.board_secs - point.origin_departure_secs).unwrap();
            let board_stop =
                index.routes[first.route_idx as usize].stop_ids[first.board_position as usize];
            assert!(q
                .entry_stops
                .iter()
                .any(|e| e.stop == board_stop && e.walk_secs == access));
            let mut walking = access as u64;
            o.deadline = point.origin_departure_secs + ROUTING_HORIZON_SECS;
            for leg in &point.witness {
                assert!(leg.board_position < leg.alight_position);
                let route = &index.routes[leg.route_idx as usize];
                let trip = route
                    .trips
                    .iter()
                    .find(|t| t.trip_idx == leg.trip_idx)
                    .unwrap();
                let served = |pos| (0..pos).filter(|&p| trip.pos_to_row[p] != -1).count();
                let (b, k) = (
                    served(leg.board_position as usize),
                    served(leg.alight_position as usize),
                );
                let date = (crate::reader::days_from_civil(leg.service_date)
                    - crate::reader::days_from_civil(START)) as usize;
                let j = o
                    .insts
                    .iter()
                    .position(|t| {
                        t.trip == leg.trip_idx
                            && t.date == date
                            && t.evs[b].dep == leg.board_secs
                            && t.evs[k].arr == leg.alight_secs
                    })
                    .unwrap();
                assert!(leg.alight_secs <= o.deadline);
                if let Some((from, at)) = previous {
                    let boarding = o
                        .transfers_from(Ride {
                            inst: from,
                            k: at,
                            stay_only: !o.insts[from].evs[at].drop,
                        })
                        .into_iter()
                        .filter(|e| {
                            e.inst == j && e.b == b && e.kind.spends_transfer() == !leg.in_seat
                        })
                        .min_by_key(|e| e.walk)
                        .expect("witness transition must be allowed by the independent oracle");
                    walking += boarding.walk;
                } else {
                    assert!(o.insts[j].evs[b].pick);
                    assert!(!leg.in_seat);
                    assert_eq!(leg.board_secs, point.origin_departure_secs + access as i64);
                }
                previous = Some((j, k));
            }
            let (j, k) = previous.unwrap();
            assert!(o.insts[j].evs[k].drop);
            let end = &o.insts[j].evs[k];
            assert!(q.exit_stops.iter().any(|exit| {
                let mut egress = vec![];
                if end.stop == exit.stop {
                    egress.push(0);
                }
                egress.extend(
                    o.ptft
                        .iter()
                        .filter(|e| e.0 == end.stop && e.1 == exit.stop)
                        .map(|e| e.2),
                );
                egress.iter().any(|&w| {
                    end.arr + w <= o.deadline
                        && end.arr + w + exit.walk_secs as i64 == point.destination_arrival_secs
                        && walking + w as u64 + exit.walk_secs as u64 == point.total_walk_secs
                })
            }));
        }
    });
}

fn check(net: &Net, q: &Query, window: Range<i64>, case: &str) -> Vec<Tuple> {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let walks = net.ptft_table();
    let mut m4 = Vec::new();
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let mut table =
            build_transfer_index(&reader, &index, walks.as_ref(), &config(q, &window)).unwrap();
        for reduced in [false, true] {
            if reduced {
                (table, _) = reduce_transfer_index(table);
            }
            for objective in [ProfileObjectives::R3, ProfileObjectives::M4] {
                let mut request = TripProfileRequest::new(q, window.clone());
                request.transfers = walks.as_ref();
                let result = match objective {
                    ProfileObjectives::R3 => profile_trip_r3(&reader, &index, &table, request),
                    ProfileObjectives::M4 => profile_trip_m4(&reader, &index, &table, request),
                }
                .unwrap_or_else(|e| panic!("{case} {mode:?} {objective:?}: {e:?}"));
                let mut reference = R3Request::new(q, window.clone());
                reference.transfers = walks.as_ref();
                reference.max_labels = 1_000_000;
                let reference = match objective {
                    ProfileObjectives::R3 => profile_r3(&reader, &index, reference),
                    ProfileObjectives::M4 => profile_m4(&reader, &index, reference),
                }
                .unwrap();
                let got = tuples(&result.page.points, objective);
                assert_eq!(
                    got,
                    expected(net, q, &window, objective),
                    "raw oracle {case} {mode:?} {objective:?}"
                );
                assert_eq!(
                    got,
                    tuples(&reference.points, objective),
                    "exhaustive {case} {mode:?} {objective:?}"
                );
                assert_eq!(
                    result.page.points, reference.points,
                    "canonical witnesses {case} {mode:?} {objective:?}"
                );
                legal_witnesses(net, q, &index, &result.page.points);
                assert!(result.page.page_complete && result.page.window_exhausted);
                assert_eq!(result.page.covered_window, window);
                assert!(
                    result
                        .page
                        .latest_departure_certificate
                        .equal_time_boundary_closed
                );
                if objective == ProfileObjectives::M4 {
                    m4 = got;
                }
            }
        }
    }
    m4
}

#[test]
fn trip_profiles_match_raw_and_exhaustive_on_generated_networks() {
    let mut rng = Rng(0x44_5452_4950_4241);
    let mut nonempty = 0;
    for case in 0..200 {
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
        if !check(&net, &q, 68000..76000, &alloc::format!("random {case}")).is_empty() {
            nonempty += 1;
        }
    }
    assert!(nonempty > 40, "query corpus is too sparse: {nonempty}");
}

#[test]
fn trip_profiles_keep_the_slower_shorter_walk_on_a_loop() {
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (4, 1400), (3, 1500), (4, 1800)]);
    net.ptft.extend([(1, 2, 90), (1, 3, 30)]);
    let q = query(0, 4, 900, 2);
    assert_eq!(
        check(&net, &q, 900..901, "M4 loop"),
        [(900, 1400, 1, 90), (900, 1800, 1, 30)]
    );
}

// Test-only arrive-by reference: arrival is a constraint, not an objective.
// This projects already complete, oracle-checked M4 profiles; it is not a
// reverse search and does not establish coverage outside the supplied window.
fn arrive_by(points: &[Tuple], deadline: i64) -> Vec<Tuple> {
    let feasible: Vec<_> = points.iter().copied().filter(|p| p.1 <= deadline).collect();
    feasible
        .iter()
        .copied()
        .filter(|p| {
            !feasible.iter().any(|a| {
                a.0 >= p.0 && a.2 <= p.2 && a.3 <= p.3 && (a.0 > p.0 || a.2 < p.2 || a.3 < p.3)
            })
        })
        .collect()
}

#[test]
fn arrive_by_must_use_the_chosen_deadline_not_only_sampled_arrivals() {
    let mut net = Net::new(2, 2);
    net.trip(0, &[(0, 1050), (1, 1120)]);
    net.trip(1, &[(0, 1100), (1, 1190)]);
    let points = check(&net, &query(0, 1, 900, 1), 900..1201, "arrive-by seeds");
    assert_eq!(points, [(1050, 1120, 0, 0), (1100, 1190, 0, 0)]);

    // Even ideal forward/reverse answers miss the latest feasible departure
    // when the only reverse deadlines are sampled earliest-arrival answers.
    let sampled_deadlines: Vec<_> = [900, 1200]
        .iter()
        .filter_map(|&start| points.iter().filter(|p| p.0 >= start).map(|p| p.1).min())
        .collect();
    assert_eq!(sampled_deadlines, [1120]);
    assert_eq!(
        arrive_by(&points, sampled_deadlines[0]),
        [(1050, 1120, 0, 0)]
    );
    assert_eq!(arrive_by(&points, 1190), [(1100, 1190, 0, 0)]);
    assert_eq!(arrive_by(&points, 1189), [(1050, 1120, 0, 0)]);
}

#[test]
fn arrive_by_keeps_transfer_and_walk_choices_and_the_inclusive_deadline() {
    let mut net = Net::new(5, 3);
    net.trip(0, &[(0, 1000), (4, 1400)]);
    net.trip(1, &[(0, 1200), (1, 1250)]);
    net.trip(2, &[(2, 1400), (4, 1500)]);
    net.ptft.push((1, 2, 90));
    let points = check(&net, &query(0, 4, 900, 2), 900..1301, "arrive-by choices");
    assert_eq!(
        arrive_by(&points, 1500),
        [(1000, 1400, 0, 0), (1200, 1500, 1, 90)]
    );
    assert_eq!(arrive_by(&points, 1499), [(1000, 1400, 0, 0)]);

    let mut loop_net = Net::new(5, 2);
    loop_net.trip(0, &[(0, 900), (1, 1000)]);
    loop_net.trip(1, &[(2, 1200), (4, 1400), (3, 1500), (4, 1800)]);
    loop_net.ptft.extend([(1, 2, 90), (1, 3, 30)]);
    let points = check(
        &loop_net,
        &query(0, 4, 900, 2),
        900..901,
        "arrive-by walking",
    );
    assert_eq!(arrive_by(&points, 1799), [(900, 1400, 1, 90)]);
    assert_eq!(arrive_by(&points, 1800), [(900, 1800, 1, 30)]);
}

#[test]
fn arriving_early_does_not_prove_a_missed_transfer_has_a_backup() {
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(0, &[(0, 1100), (1, 1180)]);
    net.trip(1, &[(1, 1120), (2, 1250)]);
    net.trip(1, &[(1, 1300), (2, 1400)]);
    net.trip(1, &[(1, 1500), (2, 1600)]);
    let points = check(
        &net,
        &query(0, 2, 900, 2),
        900..1101,
        "missed-transfer primary choices",
    );
    assert_eq!(points, [(900, 1250, 1, 0), (1100, 1400, 1, 0)]);
    assert_eq!(arrive_by(&points, 1450), [(1100, 1400, 1, 0)]);

    // Illustrative failure model only: at the same boarding stop one second
    // after the selected connection departed, with one transit round left.
    // This is not a guarantee for arbitrary delay or repeated missed rides.
    let earlier_backup = check(
        &net,
        &query(1, 2, 1121, 1),
        1121..1501,
        "missed early connection",
    );
    assert_eq!(arrive_by(&earlier_backup, 1450), [(1300, 1400, 0, 0)]);
    let latest_backup = check(
        &net,
        &query(1, 2, 1301, 1),
        1301..1501,
        "missed late connection",
    );
    assert!(arrive_by(&latest_backup, 1450).is_empty());
}

/// Identical physical corridors do not imply identical future transfer rules.
/// https://gtfs.org/documentation/schedule/reference/#transferstxt
#[test]
fn trip_profiles_keep_vehicle_identity_across_a_shared_corridor() {
    let mut net = Net::new(3, 3);
    let banned = net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 900), (1, 1000)]);
    let downstream = net.trip(2, &[(1, 1200), (2, 1300)]);
    net.transfers
        .push((1, 1, ABSENT, ABSENT, banned, downstream, ABSENT, 3));
    assert_eq!(
        check(
            &net,
            &query(0, 2, 900, 2),
            900..901,
            "shared-corridor identity"
        ),
        [(900, 1300, 1, 0)]
    );
}

/// Both GTFS lasso representations: one round-trip trip_id, or two block-linked
/// trips. https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
#[test]
fn trip_profiles_keep_both_lasso_round_trip_representations() {
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
            check(
                &net,
                &query(1, 0, 950, 2),
                950..1101,
                "lasso representations"
            ),
            [(1000, 1300, 0, 0)]
        );
    }
}

#[test]
fn trip_profiles_keep_a_later_vehicle_with_a_distinct_future_rule() {
    let mut net = Net::new(4, 3);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let early = net.trip(1, &[(1, 1300), (2, 1500)]);
    net.trip(1, &[(1, 1400), (2, 1600)]);
    let downstream = net.trip(2, &[(2, 1800), (3, 1900)]);
    net.transfers
        .push((2, 2, ABSENT, ABSENT, early, downstream, ABSENT, 3));
    assert_eq!(
        check(&net, &query(0, 3, 900, 3), 900..901, "future trip rule"),
        [(900, 1900, 2, 0)]
    );
}

#[test]
fn trip_profiles_continue_in_seat_without_pickup_or_dropoff_and_spend_a_round() {
    let mut net = Net::new(3, 2);
    let first = net.trip(0, &[(0, 900), (1, 1000)]);
    let next = net.trip(1, &[(1, 1050), (2, 1200)]);
    net.boarding = vec![0x50, 0x54, 0x51, 0x50];
    net.transfers
        .push((1, 1, ABSENT, ABSENT, first, next, ABSENT, 4));
    assert_eq!(
        check(&net, &query(0, 2, 900, 2), 900..901, "in-seat"),
        [(900, 1200, 0, 0)]
    );
    assert!(check(&net, &query(0, 2, 900, 1), 900..901, "round cap").is_empty());
}

#[test]
fn trip_profiles_use_dated_frequency_instances_and_repeated_stops() {
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
        check(
            &net,
            &query(0, 3, 85000, 2),
            85000..87001,
            "overnight frequency/DST",
        );
    }
}

#[test]
fn trip_profiles_reject_stale_binding_and_incomplete_coverage() {
    let mut net = Net::new(3, 1);
    net.trip(0, &[(0, 900), (1, 1000), (2, 1100)]);
    let q = query(0, 2, 900, 1);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let short = build_transfer_index(
        &reader,
        &index,
        None,
        &TransferIndexConfig::new(QDATE, 0..10000),
    )
    .unwrap();
    assert!(matches!(
        profile_trip_r3(
            &reader,
            &index,
            &short,
            TripProfileRequest::new(&q, 900..901)
        ),
        Err(TripProfileError::IncompleteCoverage { .. })
    ));
    let full = build_transfer_index(&reader, &index, None, &config(&q, &(900..901))).unwrap();
    let mut mobility = q.clone();
    mobility.mobility = Mobility::Wheelchair;
    let mut modes = q.clone();
    modes.excluded_modes = vec![3];
    let mut date = q.clone();
    date.date += 1;
    for changed in [mobility, modes, date] {
        assert!(matches!(
            profile_trip_r3(
                &reader,
                &index,
                &full,
                TripProfileRequest::new(&changed, 900..901)
            ),
            Err(TripProfileError::BindingMismatch)
        ));
    }
}

#[test]
fn trip_profiles_keep_the_inclusive_horizon_and_reject_later_arrivals() {
    for delta in [0, 1] {
        let mut net = Net::new(3, 2);
        net.services = vec![0b0000_1000];
        net.trip(0, &[(0, 900), (1, 1000)]);
        let deadline = 900 + ROUTING_HORIZON_SECS as u32;
        net.trip(1, &[(1, deadline), (2, deadline + delta)]);
        let got = check(&net, &query(0, 2, 900, 2), 900..901, "inclusive horizon");
        assert_eq!(got.is_empty(), delta == 1);
    }
}

#[test]
fn trip_profiles_ignore_access_boardings_outside_their_origin_horizon() {
    let mut net = Net::new(2, 1);
    net.services = vec![0b0000_1000];
    net.trip(0, &[(0, 200900), (1, 201000)]);
    let mut q = query(0, 1, 900, 1);
    q.entry_stops[0].walk_secs = 200000;
    assert!(check(&net, &q, 900..901, "long access").is_empty());
}

#[test]
fn trip_profiles_match_exhaustive_search_for_multiple_access_and_egress_stops() {
    let mut net = Net::new(4, 2);
    net.trip(0, &[(0, 1000), (2, 1200)]);
    net.trip(1, &[(1, 1050), (3, 1300)]);
    net.ptft.push((2, 3, 60));
    let mut q = query(0, 2, 900, 1);
    q.entry_stops.push(StopWalk {
        stop: 1,
        walk_secs: 10,
    });
    q.exit_stops.push(StopWalk {
        stop: 3,
        walk_secs: 20,
    });
    let window = 900..1100;
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let walks = net.ptft_table();
    let table =
        build_transfer_index(&reader, &index, walks.as_ref(), &config(&q, &window)).unwrap();
    let mut request = TripProfileRequest::new(&q, window.clone());
    request.transfers = walks.as_ref();
    let got = profile_trip_m4(&reader, &index, &table, request).unwrap();
    let mut request = R3Request::new(&q, window);
    request.transfers = walks.as_ref();
    let want = profile_m4(&reader, &index, request).unwrap();
    assert_eq!(got.page.points, want.points);
    q.max_rounds = Some(0);
    let mut request = TripProfileRequest::new(&q, 900..1100);
    request.transfers = walks.as_ref();
    assert!(profile_trip_m4(&reader, &index, &table, request)
        .unwrap()
        .page
        .points
        .is_empty());
}

#[test]
fn trip_profiles_exhaust_limits_without_returning_partial_pages() {
    let mut net = Net::new(4, 3);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 1000), (2, 1100)]);
    net.trip(2, &[(1, 1400), (3, 1600)]);
    net.ptft.push((2, 1, 60));
    let q = query(0, 3, 900, 2);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let walks = net.ptft_table();
    let table =
        build_transfer_index(&reader, &index, walks.as_ref(), &config(&q, &(900..1001))).unwrap();
    for limit in 0..5 {
        let mut request = TripProfileRequest::new(&q, 900..1001);
        request.transfers = walks.as_ref();
        match limit {
            0 => request.max_entry_events = 1,
            1 => request.max_segments = 1,
            2 => request.max_frontier_width = 1,
            3 => request.max_stop_scans = 1,
            _ => request.max_edge_scans = 1,
        }
        let error = profile_trip_m4(&reader, &index, &table, request)
            .err()
            .expect("limit must exhaust");
        assert!(match (limit, error) {
            (0, TripProfileError::EntryEventsExhausted { .. })
            | (1, TripProfileError::SegmentsExhausted { .. })
            | (2, TripProfileError::FrontierExhausted { .. })
            | (3, TripProfileError::StopScansExhausted { .. })
            | (4, TripProfileError::EdgeScansExhausted { .. }) => true,
            other => panic!("unexpected limit error: {other:?}"),
        });
    }
}
