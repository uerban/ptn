use super::*;
use crate::engine::temporal_probe::direct::{profile_direct, DirectObjectives};
use crate::engine::temporal_probe::enumerate_entry_events;
use crate::engine::temporal_probe::r3::{
    profile_m4, profile_r3, ProfileObjectives, R3Error, R3MultiDateStatus, R3Request, R3Session,
};

type Tuple = (i64, i64, u32, u64);

fn tuples(
    points: &[crate::engine::temporal_probe::r3::R3Point],
    objective: ProfileObjectives,
) -> Vec<Tuple> {
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

fn profile(
    net: &Net,
    q: &Query,
    window: core::ops::Range<i64>,
    objective: ProfileObjectives,
    mode: PatternMode,
) -> crate::engine::temporal_probe::r3::R3ProfilePage {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, mode).unwrap();
    let table = net.ptft_table();
    let mut req = R3Request::new(q, window.clone());
    req.transfers = table.as_ref();
    req.max_labels = 1_000_000;
    let page = match objective {
        ProfileObjectives::R3 => profile_r3(&reader, &index, req),
        ProfileObjectives::M4 => profile_m4(&reader, &index, req),
    }
    .unwrap();
    use crate::engine::temporal_probe::round::*;
    let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
    for (bounded, frontier) in [(false, false), (true, false), (true, true)] {
        let mut req = RoundProfileRequest::new(q, window.clone());
        req.transfers = table.as_ref();
        req.enable_scheduled_bounds = bounded;
        req.enable_source_frontiers = frontier;
        let candidate = match objective {
            ProfileObjectives::R3 => profile_round_r3(&reader, &index, &acceleration, req),
            ProfileObjectives::M4 => profile_round_m4(&reader, &index, &acceleration, req),
        }
        .unwrap();
        assert_eq!(
            tuples(&candidate.page.points, objective),
            tuples(&page.points, objective),
            "round {mode:?} {objective:?} bounded={bounded} frontier={frontier}"
        );
        for point in &candidate.page.points {
            assert_eq!(point.witness.len() as u32, point.transit_rounds);
            assert_eq!(
                point.actual_transfers,
                point.transit_rounds
                    - 1
                    - point.witness.iter().filter(|l| l.in_seat).count() as u32
            );
            for leg in &point.witness {
                let route = &index.routes[leg.route_idx as usize];
                let trip = route
                    .trips
                    .iter()
                    .find(|t| t.trip_idx == leg.trip_idx)
                    .unwrap();
                assert!(leg.board_position < leg.alight_position);
                let shift = reader
                    .service_day_origin(
                        crate::engine::v2::time::date_ordinal(&reader, leg.service_date).unwrap(),
                    )
                    .unwrap()
                    - reader
                        .service_day_origin(
                            crate::engine::v2::time::date_ordinal(&reader, q.date).unwrap(),
                        )
                        .unwrap()
                    + leg.frequency_offset_secs;
                assert_eq!(
                    leg.board_secs,
                    dep_secs_at(&reader, trip, leg.board_position as usize).unwrap() + shift
                );
                assert_eq!(
                    leg.alight_secs,
                    alight_secs_at(&reader, trip, leg.alight_position as usize).unwrap() + shift
                );
            }
        }
    }
    page
}

fn expected(
    net: &Net,
    q: &Query,
    window: &core::ops::Range<i64>,
    objective: ProfileObjectives,
) -> Vec<Tuple> {
    let mut all: Vec<Tuple> = oracle_raw(net, q, Some(window))
        .profile
        .into_iter()
        .filter(|p| window.contains(&p.0))
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
            !all.iter().any(|other| {
                other != p && other.0 >= p.0 && other.1 <= p.1 && other.2 <= p.2 && other.3 <= p.3
            })
        })
        .collect()
}

fn check_scheduled_bounds(net: &Net, q: &Query, window: core::ops::Range<i64>) {
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        for objective in [ProfileObjectives::R3, ProfileObjectives::M4] {
            let page = profile(net, q, window.clone(), objective, mode);
            assert_eq!(
                tuples(&page.points, objective),
                expected(net, q, &window, objective),
                "oracle {mode:?} {objective:?}"
            );
        }
    }
}

fn scan_diagnostics(
    net: &Net,
    q: &Query,
    window: core::ops::Range<i64>,
    bounded: bool,
) -> crate::engine::temporal_probe::round::RoundDiagnostics {
    use crate::engine::temporal_probe::round::*;
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
    let table = net.ptft_table();
    let mut req = RoundProfileRequest::new(q, window);
    req.transfers = table.as_ref();
    req.enable_scheduled_bounds = bounded;
    req.enable_source_frontiers = false;
    profile_round_m4(&reader, &index, &acceleration, req)
        .unwrap()
        .diagnostics
}

#[test]
fn source_frontiers_prune_shared_boardings_and_keep_walking_tradeoffs() {
    use crate::engine::temporal_probe::round::*;
    for later_walk in [30, 5] {
        let mut net = Net::new(5, 2);
        net.trip(0, &[(0, 900), (1, 1000), (2, 1100)]);
        net.trip(1, &[(3, 1500), (4, 1600)]);
        net.ptft.extend([(1, 3, 20), (2, 3, later_walk)]);
        let q = query(0, 4, 900, 2);
        check_scheduled_bounds(&net, &q, 900..901);
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
        let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
        let table = net.ptft_table();
        let mut req = RoundProfileRequest::new(&q, 900..901);
        req.transfers = table.as_ref();
        // Isolate the source optimization from scheduled departure bounds.
        req.enable_scheduled_bounds = false;
        let out = profile_round_m4(&reader, &index, &acceleration, req).unwrap();
        assert!(out.diagnostics.source_frontier_patterns > 0);
        assert_eq!(
            out.diagnostics.source_frontier_inputs,
            out.diagnostics.source_frontier_pruned + out.diagnostics.source_frontier_survivors
        );
        if later_walk == 30 {
            assert!(out.diagnostics.source_frontier_pruned > 0);
        } else {
            assert_eq!(out.diagnostics.max_source_frontier_width, 2);
            let mut req = RoundProfileRequest::new(&q, 900..901);
            req.transfers = table.as_ref();
            req.max_bag_width = 1;
            assert!(matches!(
                profile_round_m4(&reader, &index, &acceleration, req),
                Err(RoundProfileError::BagWidthExhausted {
                    limit: 1,
                    attempted: 2
                })
            ));
        }
    }
}

#[test]
fn source_frontiers_resolve_incoming_rules_and_fall_back_for_target_rules() {
    use crate::engine::temporal_probe::round::*;
    for target_specific in [false, true] {
        let mut net = Net::new(5, 3);
        let early = net.trip(0, &[(0, 900), (1, 1000)]);
        net.trip(1, &[(0, 900), (2, 1100)]);
        let target = net.trip(2, &[(3, 1300), (4, 1400)]);
        net.ptft.extend([(1, 3, 20), (2, 3, 20)]);
        // The earlier source is made slower only after rule resolution.
        net.transfers.push((
            1,
            3,
            ABSENT,
            ABSENT,
            early,
            if target_specific { target } else { ABSENT },
            500,
            2,
        ));
        let q = query(0, 4, 900, 2);
        check_scheduled_bounds(&net, &q, 900..901);
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
        let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
        let table = net.ptft_table();
        let mut req = RoundProfileRequest::new(&q, 900..901);
        req.transfers = table.as_ref();
        let out = profile_round_m4(&reader, &index, &acceleration, req).unwrap();
        assert_eq!(out.page.points[0].destination_arrival_secs, 1400);
        assert_eq!(
            out.diagnostics.source_frontier_patterns,
            usize::from(!target_specific)
        );
    }
}

#[test]
fn source_frontiers_keep_a_different_vehicles_boarding_opportunity() {
    let mut net = Net::new(4, 2);
    let dwelling = net.trip(0, &[(0, 900), (1, 1500), (3, 1600)]);
    net.trips[dwelling as usize].rows[1].2 = -500;
    net.trip(1, &[(0, 900), (2, 1100)]);
    net.ptft.push((2, 1, 5));
    let q = query(0, 3, 900, 3);
    check_scheduled_bounds(&net, &q, 900..901);
}

#[test]
fn source_frontiers_preserve_frequency_and_repeated_stop_occurrences() {
    for exact in [0, 1] {
        let mut net = Net::new(6, 2);
        net.trip(0, &[(0, 900), (1, 1000), (2, 1100)]);
        let target = net.trip(1, &[(3, 1300), (4, 1400), (3, 1500), (5, 1600)]);
        net.freqs.push((target, 1300, 1600, 100, exact));
        net.ptft.extend([(1, 3, 20), (2, 3, 30)]);
        check_scheduled_bounds(&net, &query(0, 5, 900, 3), 900..901);
    }
}

#[test]
fn scheduled_bound_keeps_overtaking_and_the_double_spread_endpoint() {
    let mut net = Net::new(4, 2);
    net.trip(0, &[(0, 900), (2, 1000)]);
    net.trip(1, &[(1, 1100), (2, 1200), (3, 1600)]);
    net.trip(1, &[(1, 1150), (2, 1350), (3, 1550)]);
    // spread=100, so the overtake at +150 must survive. The +200 endpoint
    // is retained too; later trips have identical offsets and are dominated.
    for first in (1200..5000).step_by(100) {
        net.trip(1, &[(1, first), (2, first + 200), (3, first + 400)]);
    }
    let q = query(0, 3, 900, 2);
    check_scheduled_bounds(&net, &q, 900..901);
    let exact = scan_diagnostics(&net, &q, 900..901, false);
    let bounded = scan_diagnostics(&net, &q, 900..901, true);
    assert_eq!(bounded.bounded_pattern_scans, 1);
    assert_eq!(bounded.exact_fallback_scans, 0);
    assert_eq!(bounded.board_candidates - bounded.source_registrations, 4);
    assert!(bounded.board_candidates * 10 < exact.board_candidates);
}

#[test]
fn scheduled_bound_finds_the_first_active_accessible_vehicle_and_keeps_ties() {
    let mut net = Net::new(3, 2);
    net.services = vec![0b0000_1000, 0];
    net.trip(0, &[(0, 900), (1, 1000)]);
    let inactive = net.trip(1, &[(1, 1200), (2, 1400)]);
    net.trips[inactive as usize].service = 1;
    let forbidden = net.trip(1, &[(1, 1210), (2, 1410)]);
    net.trips[forbidden as usize].wheelchair = 2;
    for _ in 0..2 {
        net.trip(1, &[(1, 1220), (2, 1420)]);
    }
    net.trip(1, &[(1, 1230), (2, 1430)]);
    let mut q = query(0, 2, 900, 2);
    q.mobility = Mobility::Wheelchair;
    check_scheduled_bounds(&net, &q, 900..901);
    let bounded = scan_diagnostics(&net, &q, 900..901, true);
    assert_eq!(bounded.bounded_pattern_scans, 1);
    assert_eq!(bounded.board_candidates - bounded.source_registrations, 3);
    q.excluded_modes.push(3);
    check_scheduled_bounds(&net, &q, 900..901);
}

#[test]
fn scheduled_bound_uses_absolute_dst_and_overnight_board_times() {
    let mut net = Net::new(3, 2);
    net.services = vec![0b0000_1000, 0b0000_0100];
    net.trip(0, &[(0, 7000), (1, 7100)]);
    for dep in [90_000, 90_100, 90_200] {
        let trip = net.trip(1, &[(1, dep), (2, dep + 600)]);
        net.trips[trip as usize].service = 1;
    }
    let mut origins = utc_origins(START, DAYS as usize, 0);
    for o in &mut origins[3..] {
        *o -= 3600;
    }
    net.origins = Some(origins);
    let q = query(0, 2, 7000, 2);
    check_scheduled_bounds(&net, &q, 7000..7001);
    let bounded = scan_diagnostics(&net, &q, 7000..7001, true);
    assert_eq!(bounded.bounded_pattern_scans, 1);
    assert_eq!(bounded.board_candidates - bounded.source_registrations, 2);
}

#[test]
fn scheduled_bound_does_not_use_its_own_dwelling_vehicle_as_the_first_board() {
    let mut net = Net::new(3, 1);
    for first in [900, 1000] {
        let trip = net.trip(0, &[(0, first), (1, first + 300), (2, first + 600)]);
        net.trips[trip as usize].rows[1].2 = -200;
    }
    let q = query(0, 2, 900, 2);
    check_scheduled_bounds(&net, &q, 900..901);
    let bounded = scan_diagnostics(&net, &q, 900..901, true);
    assert_eq!(bounded.bounded_pattern_scans, 1);
    // Seed, own-instance rejection, and the next feasible trip. The exact
    // accounting primitive charges a candidate before rejecting self-boarding.
    assert_eq!(bounded.board_candidates - bounded.source_registrations, 3);
}

#[test]
fn scheduled_bound_guards_every_vehicle_sensitive_fallback() {
    let mut base = Net::new(4, 3);
    base.trip(0, &[(0, 900), (1, 1000)]);
    let a = base.trip(1, &[(1, 1200), (2, 1400)]);
    let b = base.trip(1, &[(1, 1300), (2, 1500)]);
    base.trip(2, &[(2, 1800), (3, 2000)]);
    for kind in 0..9 {
        let mut net = base.clone();
        match kind {
            0 => net.freqs.push((a, 1200, 1600, 100, 1)),
            1 => net.quarantine.push(a),
            2 => net.transfers.push((1, 1, ABSENT, ABSENT, ABSENT, b, 0, 1)),
            3 => net.transfers.push((2, 2, ABSENT, ABSENT, b, ABSENT, 0, 1)),
            4 => net.transfers.push((1, 1, ABSENT, ABSENT, 0, b, ABSENT, 4)),
            5 => {
                net.trips[a as usize].block = Some("block");
                net.trips[3].block = Some("block");
                net.trips[3].rows[0].1 = 1450;
                net.derive = true;
            }
            6 => net.trips[b as usize].rows[1].1 = 1300,
            7 => {
                net.trips[a as usize].rows.push((1, 1600, 0));
                net.trips[b as usize].rows.push((1, 1700, 0));
            }
            8 => {
                net.trips[a as usize].rows.push((3, 1600, 0));
            }
            _ => unreachable!(),
        }
        let q = query(0, 2, 900, 2);
        check_scheduled_bounds(&net, &q, 900..901);
        let bounded = scan_diagnostics(&net, &q, 900..901, true);
        assert!(bounded.exact_fallback_scans > 0, "fallback {kind}");
        assert_eq!(bounded.bounded_pattern_scans, 0, "fallback {kind}");
    }
}

#[test]
fn generated_scheduled_patterns_match_exact_exhaustive_and_raw_oracle() {
    for seed in 0..100u32 {
        let mut net = Net::new(5, 3);
        net.services = vec![0b0000_1000];
        net.trip(0, &[(0, 900), (1, 1000)]);
        for i in 0..6 {
            let first = 1100 + i * 70;
            let board = first + (seed * (i + 1) * 17 % 200) + 10;
            let arrive = board + 10 + (seed * (7 - i) * 31 % 350);
            net.trip(1, &[(2, first), (1, board), (3, arrive)]);
        }
        net.trip(2, &[(3, 1900), (4, 2100)]);
        if seed % 2 == 0 {
            net.ptft.push((3, 4, 80));
        }
        let q = query(0, 4, 900, 3);
        check_scheduled_bounds(&net, &q, 900..901);
        assert!(scan_diagnostics(&net, &q, 900..901, true).bounded_pattern_scans > 0);
    }
}

#[test]
fn exact_frequency_template_is_not_an_entry_event() {
    let mut net = Net::new(2, 1);
    let trip = net.trip(0, &[(0, 0), (1, 600)]);
    net.freqs.push((trip, 36_000, 37_201, 600, 1));
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let events =
        enumerate_entry_events(&reader, &index, &query(0, 1, 36_000, 2), 36_000..37_201).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|e| e.effective_board_secs)
            .collect::<Vec<_>>(),
        vec![36_000, 36_600, 37_200]
    );
}

#[test]
fn v2_profile_obeys_station_and_one_sided_trip_rules() {
    let mut net = Net::new(4, 2);
    net.parents[1] = Some(3);
    let feeder = net.trip(0, &[(0, 36_000), (1, 36_600)]);
    net.trip(1, &[(1, 36_660), (2, 37_200)]);
    net.transfers
        .push((3, 3, ABSENT, ABSENT, feeder, ABSENT, ABSENT, 1));
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let q = query(0, 2, 36_000, 2);
    let page = profile_r3(&reader, &index, R3Request::new(&q, 36_000..36_001)).unwrap();
    assert_eq!(
        page.points
            .iter()
            .map(|p| (
                p.origin_departure_secs,
                p.destination_arrival_secs,
                p.actual_transfers
            ))
            .collect::<Vec<_>>(),
        vec![(36_000, 37_200, 1)]
    );
}

#[test]
fn v2_m4_keeps_a_real_access_walking_tradeoff() {
    let mut net = Net::new(4, 3);
    net.trip(0, &[(0, 36_000), (2, 37_200)]);
    net.trip(1, &[(1, 37_000), (2, 37_200)]);
    net.trip(2, &[(2, 37_500), (3, 38_000)]);
    let mut q = query(0, 3, 35_000, 2);
    q.entry_stops.push(StopWalk {
        stop: 1,
        walk_secs: 600,
    });
    q.exit_stops[0].walk_secs = 20;
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let r3 = profile(&net, &q, 35_000..37_500, ProfileObjectives::R3, mode);
        let m4 = profile(&net, &q, 35_000..37_500, ProfileObjectives::M4, mode);
        assert_eq!(
            tuples(&r3.points, ProfileObjectives::M4),
            vec![(36_400, 38_020, 1, 620)]
        );
        assert_eq!(
            tuples(&m4.points, ProfileObjectives::M4),
            vec![(36_000, 38_020, 1, 20), (36_400, 38_020, 1, 620)]
        );
    }
}

#[test]
fn v2_walking_objective_excludes_the_ptft_transfer_wait_floor() {
    let mut net = Net::new(4, 2);
    net.trip(0, &[(0, 36_000), (1, 36_600)]);
    net.trip(1, &[(2, 36_720), (3, 37_200)]);
    net.ptft.push((1, 2, 30));
    net.transfers
        .push((1, 2, ABSENT, ABSENT, ABSENT, ABSENT, 90, 2));
    let mut q = query(0, 3, 35_900, 2);
    q.entry_stops[0].walk_secs = 17;
    q.exit_stops[0].walk_secs = 11;
    let page = profile(
        &net,
        &q,
        35_900..36_000,
        ProfileObjectives::M4,
        PatternMode::CoveringMerge,
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::M4),
        vec![(35_983, 37_211, 1, 58)]
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::M4),
        expected(&net, &q, &(35_900..36_000), ProfileObjectives::M4)
    );
    net.ptft.clear();
    let page = profile(
        &net,
        &q,
        35_900..36_000,
        ProfileObjectives::M4,
        PatternMode::CoveringMerge,
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::M4),
        vec![(35_983, 37_211, 1, 118)]
    );
}

#[test]
fn v2_profile_uses_previous_service_dates_and_dst_origins() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 90_000), (1, 90_600)]);
    net.services = vec![0b0000_0100]; // only October 3
    let mut origins = utc_origins(START, DAYS as usize, 0);
    for o in &mut origins[3..] {
        *o -= 3600;
    }
    net.origins = Some(origins);
    let q = query(0, 1, 7_200, 1);
    let page = profile(
        &net,
        &q,
        7_200..7_201,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge,
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::R3),
        vec![(7_200, 7_800, 0, 0)]
    );
    assert_eq!(page.multi_date_status, R3MultiDateStatus::ServiceDayOrigins);
    assert_eq!(page.points[0].witness[0].service_date, 20261003);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let direct = profile_direct(&reader, &index, &q, 7_200..7_201, DirectObjectives::R3).unwrap();
    assert_eq!(direct[0].destination_arrival_secs, 7_800);
}

#[test]
fn v2_linked_successor_keeps_its_calendar_identity_and_never_redates_a_missed_floor() {
    let mut net = Net::new(3, 2);
    let from = net.trip(0, &[(0, 86_000), (1, 86_300)]);
    let to = net.trip(1, &[(1, 500), (2, 1_000)]);
    net.transfers
        .push((ABSENT, ABSENT, ABSENT, ABSENT, from, to, ABSENT, 4));
    let q = query(0, 2, 86_000, 2);
    let page = profile(
        &net,
        &q,
        86_000..86_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge,
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::R3),
        vec![(86_000, 87_400, 0, 0)]
    );
    assert!(page.points[0].witness[1].in_seat);
    assert_eq!(page.points[0].witness[1].service_date, 20261005);
    net.transfers[0].6 = 1_000;
    assert!(profile(
        &net,
        &q,
        86_000..86_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge
    )
    .points
    .is_empty());
    net.transfers[0].6 = ABSENT;
    net.services.push(0b0010_0000); // successor active October 6, not October 5
    net.trips[to as usize].service = 1;
    assert!(profile(
        &net,
        &q,
        86_000..86_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge
    )
    .points
    .is_empty());
}

#[test]
fn v2_resource_limits_return_errors_and_poison_the_session() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 36_000), (1, 36_600)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let q = query(0, 1, 36_000, 1);
    let mut req = R3Request::new(&q, 36_000..36_001);
    req.max_entry_events = 0;
    assert!(matches!(
        profile_r3(&reader, &index, req),
        Err(R3Error::EntryEventsExhausted { .. })
    ));
    let mut req = R3Request::new(&q, 36_000..36_001);
    req.max_labels = 0;
    let mut session = R3Session::new(&reader, &index, req).unwrap();
    assert!(matches!(
        session.next_page(1),
        Err(R3Error::ResourceExhausted { .. })
    ));
    assert!(matches!(
        session.next_page(1),
        Err(R3Error::InvalidRequest(_))
    ));
}

#[test]
fn v2_loop_occurrences_and_derived_lasso_continuations_survive() {
    let mut net = Net::new(3, 1);
    net.trip(
        0,
        &[
            (0, 36_000),
            (1, 36_600),
            (2, 37_200),
            (1, 37_800),
            (0, 38_400),
        ],
    );
    let q = query(1, 0, 37_700, 1);
    let page = profile(
        &net,
        &q,
        37_700..37_900,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge,
    );
    assert_eq!(page.points[0].witness[0].board_position, 3);
    assert_eq!(page.points[0].witness[0].alight_position, 4);
    let mut net = Net::new(3, 2);
    let a = net.trip(0, &[(0, 36_000), (1, 36_600), (2, 37_200), (1, 37_800)]);
    let b = net.trip(1, &[(1, 37_860), (0, 38_400)]);
    net.trips[a as usize].block = Some("lasso");
    net.trips[b as usize].block = Some("lasso");
    net.derive = true;
    let q = query(0, 0, 36_000, 2);
    let page = profile(
        &net,
        &q,
        36_000..36_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge,
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::R3),
        vec![(36_000, 38_400, 0, 0)]
    );
    assert!(page.points[0].witness[1].in_seat);
    net.transfers
        .push((ABSENT, ABSENT, ABSENT, ABSENT, a, b, ABSENT, 5));
    let page = profile(
        &net,
        &q,
        36_000..36_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge,
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::R3),
        vec![(36_000, 38_400, 1, 0)]
    );
}

#[test]
fn v2_type5_counts_only_physical_walk_and_keeps_passenger_transfer() {
    let mut net = Net::new(4, 2);
    let a = net.trip(0, &[(0, 36_000), (1, 36_600)]);
    let b = net.trip(1, &[(2, 36_720), (3, 37_200)]);
    net.ptft.push((1, 2, 30));
    net.transfers
        .push((ABSENT, ABSENT, ABSENT, ABSENT, a, b, 90, 5));
    let q = query(0, 3, 36_000, 2);
    let page = profile(
        &net,
        &q,
        36_000..36_001,
        ProfileObjectives::M4,
        PatternMode::CoveringMerge,
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::M4),
        vec![(36_000, 37_200, 1, 30)]
    );
    assert!(!page.points[0].witness[1].in_seat);
    assert_eq!(
        tuples(&page.points, ProfileObjectives::M4),
        expected(&net, &q, &(36_000..36_001), ProfileObjectives::M4)
    );
}

#[test]
fn v2_frequency_instances_have_correct_approximation_and_quarantine() {
    let mut net = Net::new(2, 1);
    let trip = net.trip(0, &[(0, 0), (1, 600)]);
    for exact in [0, 1] {
        net.freqs = vec![(trip, 36_000, 37_201, 600, exact)];
        let q = query(0, 1, 36_000, 1);
        let page = profile(
            &net,
            &q,
            36_000..37_201,
            ProfileObjectives::R3,
            PatternMode::CoveringMerge,
        );
        assert_eq!(page.points.len(), 3);
        for p in &page.points {
            assert_eq!(p.witness[0].frequency_instance, exact == 0);
            assert_eq!(p.witness[0].frequency_offset_secs, p.origin_departure_secs);
        }
    }
    net.quarantine.push(trip);
    net.freqs.clear();
    let q = query(0, 1, 36_000, 1);
    assert!(profile(
        &net,
        &q,
        36_000..37_201,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge
    )
    .points
    .is_empty());
}

#[test]
fn v2_profile_checks_the_entire_window_and_each_departures_horizon() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 36_000), (1, 210_000)]); // ride exceeds 48h
    let q = query(0, 1, 36_000, 1);
    assert!(profile(
        &net,
        &q,
        36_000..36_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge
    )
    .points
    .is_empty());
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    assert!(
        profile_direct(&reader, &index, &q, 36_000..36_001, DirectObjectives::R3)
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        profile_r3(&reader, &index, R3Request::new(&q, 36_000..4 * 86_400)),
        Err(R3Error::Engine(EngineError::IncompleteHorizon))
    ));
    assert!(matches!(
        profile_r3(&reader, &index, R3Request::new(&q, -1..1)),
        Err(R3Error::Engine(EngineError::UnsupportedServiceDate))
    ));
}

#[test]
fn v2_page_closes_equal_departures_and_resumes_without_replay() {
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 36_000), (2, 37_000)]);
    net.trip(0, &[(0, 36_050), (2, 38_000)]);
    net.trip(1, &[(1, 36_600), (2, 36_700)]);
    let mut q = query(0, 2, 35_900, 1);
    q.entry_stops.push(StopWalk {
        stop: 1,
        walk_secs: 600,
    });
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let mut session = R3Session::new_with_objectives(
        &reader,
        &index,
        R3Request::new(&q, 35_900..36_100),
        ProfileObjectives::M4,
    )
    .unwrap();
    let first = session.next_page(1).unwrap();
    assert_eq!(first.points.len(), 1);
    assert!(!first.window_exhausted);
    let second = session.next_page(1).unwrap();
    assert_eq!(second.points.len(), 2);
    assert_eq!(second.page_diagnostics.entry_events, 2);
    assert!(
        second.window_exhausted
            && second
                .latest_departure_certificate
                .equal_time_boundary_closed
    );
    assert!(!second.day_exhausted);
    let mut joined = first.points;
    joined.extend(second.points);
    let full = profile(
        &net,
        &q,
        35_900..36_100,
        ProfileObjectives::M4,
        PatternMode::CoveringMerge,
    );
    assert_eq!(
        tuples(&joined, ProfileObjectives::M4),
        tuples(&full.points, ProfileObjectives::M4)
    );
    assert_eq!(
        session.next_page(1).unwrap().page_diagnostics.entry_events,
        0
    );
}

#[test]
fn v2_r3_and_m4_match_the_independent_exhaustive_corpus() {
    let mut rng = Rng(0x7b82_329d_6512_0fd1);
    let mut nonempty = 0;
    for case in 0..200 {
        let net = random_net(&mut rng);
        let from = rng.below(5) as u32;
        let to = (from + 1 + rng.below(4) as u32) % 5;
        let mut q = query(from, to, 68_000, 3);
        q.entry_stops[0].walk_secs = rng.below(120) as u32;
        q.exit_stops[0].walk_secs = rng.below(120) as u32;
        vary_walk_settings(&mut rng, &mut q);
        let window = 68_000..80_000;
        for objective in [ProfileObjectives::R3, ProfileObjectives::M4] {
            let want = expected(&net, &q, &window, objective);
            nonempty += usize::from(!want.is_empty());
            for mode in [
                PatternMode::Off,
                PatternMode::Unbounded,
                PatternMode::CoveringMerge,
            ] {
                let page = profile(&net, &q, window.clone(), objective, mode);
                assert_eq!(
                    tuples(&page.points, objective),
                    want,
                    "case {case}, {objective:?}, {mode:?}"
                );
            }
        }
    }
    assert!(
        nonempty > 100,
        "a mostly empty corpus proves little: {nonempty}"
    );
}

#[test]
fn v2_entry_enumeration_skips_unserved_covering_merge_positions() {
    let mut net = Net::new(3, 1);
    net.trip(0, &[(0, 35_000), (1, 36_000), (2, 36_600)]);
    net.trip(0, &[(1, 36_000), (2, 36_600)]);
    net.strip = true;
    let q = query(0, 2, 35_000, 1);
    for mode in [PatternMode::Unbounded, PatternMode::CoveringMerge] {
        let page = profile(&net, &q, 35_000..35_001, ProfileObjectives::R3, mode);
        assert_eq!(
            tuples(&page.points, ProfileObjectives::R3),
            vec![(35_000, 36_600, 0, 0)]
        );
    }
}

#[test]
fn v2_profile_resolves_all_six_transfer_specificity_tiers() {
    for (tier, (fr, tr, ft, tt)) in [
        (ABSENT, ABSENT, 0, 1),
        (ABSENT, 1, 0, ABSENT),
        (ABSENT, ABSENT, 0, ABSENT),
        (0, 1, ABSENT, ABSENT),
        (0, ABSENT, ABSENT, ABSENT),
        (ABSENT, ABSENT, ABSENT, ABSENT),
    ]
    .into_iter()
    .enumerate()
    {
        let mut net = Net::new(3, 2);
        net.trip(0, &[(0, 36_000), (1, 36_600)]);
        net.trip(1, &[(1, 36_660), (2, 37_200)]);
        if tier < 5 {
            net.transfers
                .push((1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3));
        }
        net.transfers.push((1, 1, fr, tr, ft, tt, ABSENT, 1));
        let q = query(0, 2, 36_000, 2);
        let page = profile(
            &net,
            &q,
            36_000..36_001,
            ProfileObjectives::R3,
            PatternMode::CoveringMerge,
        );
        assert_eq!(
            tuples(&page.points, ProfileObjectives::R3),
            vec![(36_000, 37_200, 1, 0)],
            "tier {}",
            tier + 1
        );
    }
}

#[test]
fn v2_entry_events_apply_mobility_and_mode_filters() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 36_000), (1, 36_600)]);
    net.trips[0].wheelchair = 2;
    let mut q = query(0, 1, 36_000, 1);
    q.mobility = Mobility::Wheelchair;
    assert!(profile(
        &net,
        &q,
        36_000..36_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge
    )
    .points
    .is_empty());
    q.mobility = Mobility::Default;
    q.excluded_modes = vec![3];
    assert!(profile(
        &net,
        &q,
        36_000..36_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge
    )
    .points
    .is_empty());
}

#[test]
fn round_occurrences_keep_every_loop_position_and_reject_foreign_indices() {
    use crate::engine::temporal_probe::round::*;
    let mut net = Net::new(3, 1);
    net.trip(
        0,
        &[
            (0, 36_000),
            (1, 36_600),
            (2, 37_200),
            (1, 37_800),
            (0, 38_400),
        ],
    );
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
    assert_eq!(
        acceleration
            .occurrences(1)
            .iter()
            .map(|o| o.position)
            .collect::<Vec<_>>(),
        vec![1, 3]
    );
    let other = Index::build(&reader, PatternMode::Off).unwrap();
    let q = query(1, 0, 37_700, 1);
    assert!(matches!(
        profile_round_r3(
            &reader,
            &other,
            &acceleration,
            RoundProfileRequest::new(&q, 37_700..37_900)
        ),
        Err(RoundProfileError::Engine(EngineError::IndexBundleMismatch))
    ));
}

#[test]
fn round_profile_matches_exhaustive_with_station_rules_and_ptft() {
    use crate::engine::temporal_probe::round::*;
    let mut net = Net::new(5, 2);
    net.parents[1] = Some(4);
    net.parents[2] = Some(4);
    net.trip(0, &[(0, 36_000), (1, 36_600)]);
    net.trip(1, &[(2, 36_720), (3, 37_200)]);
    net.ptft.push((1, 2, 30));
    net.transfers
        .push((4, 4, ABSENT, ABSENT, ABSENT, ABSENT, 90, 2));
    let q = query(0, 3, 36_000, 2);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
    let table = net.ptft_table();
    let mut req = RoundProfileRequest::new(&q, 36_000..36_001);
    req.transfers = table.as_ref();
    let out = profile_round_m4(&reader, &index, &acceleration, req).unwrap();
    assert_eq!(
        tuples(&out.page.points, ProfileObjectives::M4),
        vec![(36_000, 37_200, 1, 30)]
    );
    assert!(out.page.window_exhausted && out.page.page_complete);
    assert!(out.diagnostics.pattern_scans > 0);
}

#[test]
fn round_ordinary_dominance_keeps_a_derived_vehicle_continuation() {
    use crate::engine::temporal_probe::round::*;
    let mut net = Net::new(4, 4);
    net.trip(0, &[(0, 35_000), (1, 35_500)]);
    net.trip(1, &[(1, 36_000), (2, 36_600)]);
    let b = net.trip(2, &[(1, 36_060), (2, 36_660)]);
    let c = net.trip(3, &[(2, 36_720), (3, 37_200)]);
    net.trips[b as usize].block = Some("vehicle");
    net.trips[c as usize].block = Some("vehicle");
    net.derive = true;
    let q = query(0, 3, 35_000, 3);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
    let out = profile_round_r3(
        &reader,
        &index,
        &acceleration,
        RoundProfileRequest::new(&q, 35_000..35_001),
    )
    .unwrap();
    assert_eq!(
        tuples(&out.page.points, ProfileObjectives::R3),
        vec![(35_000, 37_200, 1, 0)]
    );
    assert!(out.page.points[0].witness[2].in_seat);
    assert!(out.diagnostics.dominated_states > 0 && out.diagnostics.continuation_candidates > 0);
}

#[test]
fn round_zero_time_loops_preserve_same_vehicle_boarding_exclusions() {
    let mut net = Net::new(5, 2);
    net.trip(
        0,
        &[
            (1, 36_000),
            (2, 36_000),
            (4, 36_000),
            (1, 36_000),
            (3, 36_000),
        ],
    );
    net.trip(1, &[(4, 36_000), (1, 36_000)]);
    let q = query(4, 2, 36_000, 2);
    let page = profile(
        &net,
        &q,
        36_000..36_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge,
    );
    // Permit the zero-time re-board of the different vehicle with a timed rule.
    assert_eq!(
        tuples(&page.points, ProfileObjectives::R3),
        vec![(36_000, 122_400, 1, 0)]
    );
    net.transfers
        .push((1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 1));
    let page = profile(
        &net,
        &q,
        36_000..36_001,
        ProfileObjectives::R3,
        PatternMode::CoveringMerge,
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::R3),
        vec![(36_000, 36_000, 1, 0)]
    );
    assert_eq!(
        tuples(&page.points, ProfileObjectives::R3),
        expected(&net, &q, &(36_000..36_001), ProfileObjectives::R3)
    );
}

#[test]
fn round_limits_fail_explicitly_without_partial_coverage() {
    use crate::engine::temporal_probe::round::*;
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 35_500), (1, 36_600)]);
    net.trip(0, &[(0, 36_000), (1, 36_800)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
    let q = query(0, 1, 35_000, 1);
    let request = || RoundProfileRequest::new(&q, 35_000..36_001);
    let mut req = request();
    req.max_entry_events = 1;
    assert!(matches!(
        profile_round_r3(&reader, &index, &acceleration, req),
        Err(RoundProfileError::EntryEventsExhausted { .. })
    ));
    let mut req = request();
    req.max_accepted_states = 1;
    assert!(matches!(
        profile_round_r3(&reader, &index, &acceleration, req),
        Err(RoundProfileError::StatesExhausted { .. })
    ));
    let mut req = request();
    req.max_bag_width = 1;
    assert!(matches!(
        profile_round_r3(&reader, &index, &acceleration, req),
        Err(RoundProfileError::BagWidthExhausted { .. })
    ));
    let mut req = request();
    req.max_board_candidates = 1;
    assert!(matches!(
        profile_round_r3(&reader, &index, &acceleration, req),
        Err(RoundProfileError::BoardCandidatesExhausted { .. })
    ));
    let mut req = request();
    req.max_bag_width = 0;
    assert!(matches!(
        profile_round_r3(&reader, &index, &acceleration, req),
        Err(RoundProfileError::InvalidRequest(_))
    ));
}

#[test]
fn round_bag_width_is_checked_after_dominance_and_witnesses_stay_immutable() {
    use crate::engine::temporal_probe::round::*;
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 36_000), (1, 36_600)]);
    net.trip(1, &[(2, 35_900), (1, 36_600)]);
    let mut q = query(0, 1, 35_900, 1);
    q.entry_stops[0].walk_secs = 100;
    q.entry_stops.push(StopWalk {
        stop: 2,
        walk_secs: 0,
    });
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
    let mut req = RoundProfileRequest::new(&q, 35_900..35_901);
    req.max_bag_width = 1;
    let out = profile_round_m4(&reader, &index, &acceleration, req).unwrap();
    assert_eq!(out.diagnostics.max_bag_width, 1);
    assert_eq!(out.diagnostics.accepted_states, 2);
    assert_eq!(
        tuples(&out.page.points, ProfileObjectives::M4),
        vec![(35_900, 36_600, 0, 0)]
    );
    assert_eq!(out.page.points[0].witness[0].trip_idx, 1);
}

#[test]
fn round_cross_departure_pruning_preserves_remaining_boarding_capacity() {
    let mut net = Net::new(4, 4);
    let a = net.trip(0, &[(0, 35_010), (1, 35_500)]);
    let b = net.trip(1, &[(1, 35_560), (2, 36_600)]);
    net.trip(2, &[(0, 35_000), (2, 36_700)]);
    net.trip(3, &[(2, 36_820), (3, 37_200)]);
    net.transfers
        .push((ABSENT, ABSENT, ABSENT, ABSENT, a, b, ABSENT, 4));
    let q = query(0, 3, 35_000, 2);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let out = profile(&net, &q, 35_000..35_011, ProfileObjectives::R3, mode);
        assert_eq!(
            tuples(&out.points, ProfileObjectives::R3),
            vec![(35_000, 37_200, 1, 0)]
        );
    }
}

#[test]
fn round_reuses_later_departures_without_replaying_dominated_frontiers() {
    use crate::engine::temporal_probe::round::*;
    let mut net = Net::new(3, 2);
    for offset in 0..10 {
        net.trip(0, &[(0, 36_000 + offset * 10), (1, 36_600)]);
    }
    net.trip(1, &[(1, 36_720), (2, 37_200)]);
    let q = query(0, 2, 36_000, 2);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let acceleration = RoundProfileIndex::build(&reader, &index).unwrap();
    let reference = profile_r3(&reader, &index, R3Request::new(&q, 36_000..36_100)).unwrap();
    let candidate = profile_round_r3(
        &reader,
        &index,
        &acceleration,
        RoundProfileRequest::new(&q, 36_000..36_100),
    )
    .unwrap();
    assert_eq!(
        tuples(&candidate.page.points, ProfileObjectives::R3),
        tuples(&reference.points, ProfileObjectives::R3)
    );
    assert_eq!(candidate.page.diagnostics.entry_events, 10);
    assert_eq!(candidate.diagnostics.pattern_scans, 1);
    assert!(candidate.diagnostics.accepted_states < reference.diagnostics.accepted_labels);
    assert!(candidate.page.diagnostics.reused_labels >= 9);
}
