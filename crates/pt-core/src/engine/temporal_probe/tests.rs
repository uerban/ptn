use alloc::format;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::ops::Range;

use super::direct::{profile_direct, DirectObjectives};
use super::events::first_frequency_start_at_or_after;
use super::r3::{
    profile_m4, profile_r3, ProfileObjectives, R3CoverageScope, R3Error, R3MultiDateStatus,
    R3PageCompletion, R3Point, R3PtftStatus, R3Request, R3Session,
};
use super::reset_ref::reset_reference;
use super::{enumerate_entry_events, EntryEvent};
use crate::engine::temporal_experiment::oracle::{
    oracle_profile, Event as OracleEvent, Objectives, OracleInput, StopWalk as OracleStopWalk,
    Transfer as OracleTransfer,
};
use crate::engine::testkit::{
    all_active_service, build_n_trip_ptb, build_pattern_band_ptb, build_ptft, build_v1_ptb,
    set_stop_wheelchair, set_trip_bikes_allowed, set_trip_wheelchair, ServicePoolSpec, SoaRoute,
    SoaStop, StopRoutes, TransferRow, V1Feed, V1Trip,
};
use crate::engine::{Index, Mobility, PatternMode, Query, StopWalk};
use crate::{Reader, Transfers};

const DATE: u32 = 20260501;

fn query(entry_stops: Vec<StopWalk>, departure_secs: i64, mobility: Mobility) -> Query {
    Query {
        excluded_routes: Default::default(),
        entry_stops,
        exit_stops: vec![],
        departure_secs,
        date: DATE,
        max_rounds: None,
        mobility,
        excluded_modes: vec![],
        walk_speed_mm_s: None,
        min_transfer_secs: None,
    }
}

fn event_key(event: &EntryEvent) -> (i64, u32, u32, u32, i64) {
    (
        event.origin_ready_secs,
        event.route_idx,
        event.trip_idx,
        event.board_position,
        event.frequency_offset_secs,
    )
}

fn feed_with_legality_cases() -> Vec<u8> {
    let stops = [
        SoaStop {
            id: "s0",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s1",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s2",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s3",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [
        SoaRoute {
            id: "bus",
            agency: "",
            short: "",
            long: "",
            color: "",
            text_color: "",
            route_type: 3,
        },
        SoaRoute {
            id: "rail",
            agency: "",
            short: "",
            long: "",
            color: "",
            text_color: "",
            route_type: 2,
        },
    ];
    let trip0_rows = &[
        (1, 0, 25_200),
        (2, 1, 25_800),
        (3, 2, 26_400),
        (4, 1, 27_000),
    ];
    let trip1_rows = &[
        (1, 0, 25_800),
        (2, 1, 26_400),
        (3, 2, 27_000),
        (4, 1, 28_000),
    ];
    let trip2_rows = &[
        (1, 0, 30_000),
        (2, 1, 30_600),
        (3, 2, 31_200),
        (4, 1, 31_800),
    ];
    let trip3_rows = &[(1, 0, 28_500), (2, 3, 29_100)];
    let trips = [
        V1Trip {
            id: "t0",
            route: 0,
            rows: trip0_rows,
            ..V1Trip::default()
        },
        V1Trip {
            id: "t1",
            route: 0,
            rows: trip1_rows,
            ..V1Trip::default()
        },
        V1Trip {
            id: "inactive",
            route: 0,
            service: 1,
            rows: trip2_rows,
            ..V1Trip::default()
        },
        V1Trip {
            id: "excluded-mode",
            route: 1,
            rows: trip3_rows,
            ..V1Trip::default()
        },
    ];
    let active = [0x01u8; 12];
    let inactive = [0x00u8; 12];
    let pool: [&[u8]; 2] = [&active, &inactive];
    let service_to_bitfield = [0u32, 1];
    let services = ServicePoolSpec {
        window_days: crate::WINDOW_DEFAULT_DAYS,
        pool: &pool,
        service_to_bitfield: &service_to_bitfield,
    };
    // t1's first s1 occurrence is pickup-forbidden; its repeated s1 occurrence
    // remains a legal board. All other rows are regular pickup/drop-off.
    let boarding = [
        0x50, 0x50, 0x50, 0x50, // t0
        0x50, 0x51, 0x50, 0x50, // t1
        0x50, 0x50, 0x50, 0x50, // inactive
        0x50, 0x50, // excluded mode
    ];
    build_v1_ptb(&V1Feed {
        stops: &stops,
        routes: &routes,
        trips: &trips,
        stop_routes: StopRoutes::Served,
        feed_start_date: DATE,
        city_tz_offset_seconds: 0,
        services,
        transfers: &[],
        boarding: &boarding,
        stop_index: false,
    })
}

fn enumerate(
    bytes: Vec<u8>,
    mode: PatternMode,
    query: &Query,
    window: Range<i64>,
) -> Vec<EntryEvent> {
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, mode).unwrap();
    enumerate_entry_events(&reader, &index, query, window).unwrap()
}

fn r3_feed(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[V1Trip<'_>],
    transfers: &[TransferRow],
) -> Vec<u8> {
    build_v1_ptb(&V1Feed {
        stops,
        routes,
        trips,
        stop_routes: StopRoutes::Served,
        feed_start_date: DATE,
        city_tz_offset_seconds: 0,
        services: all_active_service(),
        transfers,
        boarding: &[],
        stop_index: false,
    })
}

fn bare_stop(id: &str) -> SoaStop<'_> {
    SoaStop {
        id,
        name: "",
        lat: 0.0,
        lon: 0.0,
        parent: None,
        wheelchair: 0,
    }
}

fn bare_route(id: &str) -> SoaRoute<'_> {
    SoaRoute {
        id,
        agency: "",
        short: "",
        long: "",
        color: "",
        text_color: "",
        route_type: 3,
    }
}

fn r3_tuples(points: &[R3Point]) -> Vec<(i64, i64, u32)> {
    points
        .iter()
        .map(|point| {
            (
                point.origin_departure_secs,
                point.destination_arrival_secs,
                point.actual_transfers,
            )
        })
        .collect()
}

fn m4_tuples(points: &[R3Point]) -> Vec<(i64, i64, u32, u64)> {
    points
        .iter()
        .map(|point| {
            (
                point.origin_departure_secs,
                point.destination_arrival_secs,
                point.actual_transfers,
                point.total_walk_secs,
            )
        })
        .collect()
}

fn oracle_tuples(input: OracleInput) -> Vec<(i64, i64, u32)> {
    oracle_profile(input, Objectives::R3)
        .into_iter()
        .map(|point| {
            (
                point.origin_departure as i64,
                point.destination_arrival as i64,
                point.actual_transfers,
            )
        })
        .collect()
}

fn append_frequencies(mut bytes: Vec<u8>, rows: &[(u32, u32, u32, u16, u8)]) -> Vec<u8> {
    const PAGE: usize = 4096;
    let mut body = Vec::with_capacity(4 + rows.len() * 16);
    body.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    for &(trip, start, end, headway, exact_times) in rows {
        body.extend_from_slice(&trip.to_le_bytes());
        body.extend_from_slice(&start.to_le_bytes());
        body.extend_from_slice(&end.to_le_bytes());
        body.extend_from_slice(&headway.to_le_bytes());
        body.push(exact_times);
        body.push(0);
    }
    let offset = (bytes.len() + PAGE - 1) & !(PAGE - 1);
    let total = (offset + body.len() + PAGE - 1) & !(PAGE - 1);
    bytes.resize(total, 0);
    bytes[offset..offset + body.len()].copy_from_slice(&body);

    let mut entry = 32;
    while u16::from_le_bytes(bytes[entry..entry + 2].try_into().unwrap()) != 0 {
        entry += 24;
    }
    bytes[entry..entry + 2].copy_from_slice(&crate::region_ids::FREQUENCIES.to_le_bytes());
    bytes[entry + 8..entry + 16].copy_from_slice(&(offset as u64).to_le_bytes());
    bytes[entry + 16..entry + 24].copy_from_slice(&(body.len() as u64).to_le_bytes());
    bytes
}

fn session_page_feed() -> Vec<u8> {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [
        bare_route("direct"),
        bare_route("feeder"),
        bare_route("trunk"),
        bare_route("early"),
    ];
    let trips = [
        V1Trip {
            id: "direct-trip",
            route: 0,
            rows: &[(1, 0, 150), (2, 2, 300)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "feeder-trip",
            route: 1,
            rows: &[(1, 0, 150), (2, 1, 180)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "trunk-trip",
            route: 2,
            rows: &[(1, 1, 190), (2, 2, 250)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "early-trip",
            route: 3,
            rows: &[(1, 0, 100), (2, 2, 200)],
            ..V1Trip::default()
        },
    ];
    let absent = u32::MAX;
    r3_feed(
        &stops,
        &routes,
        &trips,
        &[(1, 1, absent, absent, absent, absent, absent, 1)],
    )
}

fn pareto_tuples(candidates: Vec<(i64, i64, u32)>) -> Vec<(i64, i64, u32)> {
    let mut profile = Vec::new();
    for candidate in candidates {
        if profile.iter().any(|existing: &(i64, i64, u32)| {
            existing.0 >= candidate.0
                && existing.1 <= candidate.1
                && existing.2 <= candidate.2
                && (existing.0 > candidate.0
                    || existing.1 < candidate.1
                    || existing.2 < candidate.2)
        }) {
            continue;
        }
        profile.retain(|existing: &(i64, i64, u32)| {
            !(candidate.0 >= existing.0
                && candidate.1 <= existing.1
                && candidate.2 <= existing.2
                && (candidate.0 > existing.0
                    || candidate.1 < existing.1
                    || candidate.2 < existing.2))
        });
        if !profile.contains(&candidate) {
            profile.push(candidate);
        }
    }
    profile.sort_by_key(|point| (core::cmp::Reverse(point.0), point.1, point.2));
    profile
}

#[test]
fn transfer_r3_later_feeder_dominates_same_trunk_result() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [bare_route("early"), bare_route("late"), bare_route("trunk")];
    let trips = [
        V1Trip {
            id: "early-trip",
            route: 0,
            rows: &[(1, 0, 100), (2, 1, 200)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "late-trip",
            route: 1,
            rows: &[(1, 0, 150), (2, 1, 200)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "trunk-trip",
            route: 2,
            rows: &[(1, 1, 210), (2, 2, 400)],
            ..V1Trip::default()
        },
    ];
    let absent = u32::MAX;
    let bytes = r3_feed(
        &stops,
        &routes,
        &trips,
        &[(1, 1, absent, absent, absent, absent, absent, 1)],
    );
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];

    let result = profile_r3(&reader, &index, R3Request::new(&q, 0..200)).unwrap();
    let profile = &result.points;
    assert_eq!(r3_tuples(profile), vec![(150, 400, 1)]);
    assert_eq!(profile[0].transit_rounds, 2);
    assert_eq!(
        profile[0]
            .witness
            .iter()
            .map(|leg| {
                (
                    leg.route_idx,
                    leg.reader_route_idx,
                    leg.trip_idx,
                    leg.board_position,
                    leg.alight_position,
                )
            })
            .collect::<Vec<_>>(),
        vec![(1, 1, 1, 0, 1), (2, 2, 2, 0, 1)]
    );
    assert_eq!(result.diagnostics.entry_events, 2);
    assert_eq!(result.diagnostics.accepted_labels, 5);
    assert_eq!(result.diagnostics.propagated_labels, 3);
    assert_eq!(result.diagnostics.reused_labels, 1);

    let oracle = OracleInput {
        events: vec![
            OracleEvent {
                from: "origin",
                to: "trunk",
                depart: 100,
                arrive: 200,
                trip: "early",
                service: "weekday",
                walk_secs: 0,
                in_seat: false,
            },
            OracleEvent {
                from: "origin",
                to: "trunk",
                depart: 150,
                arrive: 200,
                trip: "late",
                service: "weekday",
                walk_secs: 0,
                in_seat: false,
            },
            OracleEvent {
                from: "trunk",
                to: "destination",
                depart: 210,
                arrive: 400,
                trip: "trunk",
                service: "weekday",
                walk_secs: 0,
                in_seat: false,
            },
        ],
        transfers: vec![
            OracleTransfer {
                from: "trunk",
                to: "trunk",
                walk_secs: 0,
                from_trip: Some("early"),
                to_trip: Some("trunk"),
                in_seat: false,
            },
            OracleTransfer {
                from: "trunk",
                to: "trunk",
                walk_secs: 0,
                from_trip: Some("late"),
                to_trip: Some("trunk"),
                in_seat: false,
            },
        ],
        entry_walks: vec![OracleStopWalk {
            stop: "origin",
            walk_secs: 0,
        }],
        exit_walks: vec![OracleStopWalk {
            stop: "destination",
            walk_secs: 0,
        }],
        max_boards: 2,
        allowed_services: vec!["weekday"],
    };
    assert_eq!(r3_tuples(profile), oracle_tuples(oracle));
}

#[test]
fn transfer_r3_retains_slower_incoming_trip_for_scoped_board_rule() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [bare_route("fast"), bare_route("slow"), bare_route("trunk")];
    let trips = [
        V1Trip {
            id: "fast-trip",
            route: 0,
            rows: &[(1, 0, 100), (2, 1, 200)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "slow-trip",
            route: 1,
            rows: &[(1, 0, 100), (2, 1, 250)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "trunk-trip",
            route: 2,
            rows: &[(1, 1, 260), (2, 2, 400)],
            ..V1Trip::default()
        },
    ];
    let absent = u32::MAX;
    let bytes = r3_feed(
        &stops,
        &routes,
        &trips,
        &[
            (1, 1, absent, absent, absent, absent, absent, 3),
            (1, 1, absent, absent, 1, 2, absent, 1),
        ],
    );
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];

    let result = profile_r3(&reader, &index, R3Request::new(&q, 0..200)).unwrap();
    let profile = &result.points;
    assert_eq!(r3_tuples(profile), vec![(100, 400, 1)]);
    assert_eq!(
        profile[0]
            .witness
            .iter()
            .map(|leg| leg.trip_idx)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );

    let oracle = OracleInput {
        events: vec![
            OracleEvent {
                from: "origin",
                to: "trunk",
                depart: 100,
                arrive: 200,
                trip: "fast",
                service: "weekday",
                walk_secs: 0,
                in_seat: false,
            },
            OracleEvent {
                from: "origin",
                to: "trunk",
                depart: 100,
                arrive: 250,
                trip: "slow",
                service: "weekday",
                walk_secs: 0,
                in_seat: false,
            },
            OracleEvent {
                from: "trunk",
                to: "destination",
                depart: 260,
                arrive: 400,
                trip: "trunk",
                service: "weekday",
                walk_secs: 0,
                in_seat: false,
            },
        ],
        transfers: vec![OracleTransfer {
            from: "trunk",
            to: "trunk",
            walk_secs: 0,
            from_trip: Some("slow"),
            to_trip: Some("trunk"),
            in_seat: false,
        }],
        entry_walks: vec![OracleStopWalk {
            stop: "origin",
            walk_secs: 0,
        }],
        exit_walks: vec![OracleStopWalk {
            stop: "destination",
            walk_secs: 0,
        }],
        max_boards: 2,
        allowed_services: vec!["weekday"],
    };
    assert_eq!(r3_tuples(profile), oracle_tuples(oracle));
}

#[test]
fn transfer_r3_does_not_bypass_scoped_rule_at_a_query_entry_stop() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [bare_route("feeder"), bare_route("trunk")];
    let trips = [
        V1Trip {
            id: "feeder-trip",
            route: 0,
            rows: &[(1, 0, 100), (2, 1, 200)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "trunk-trip",
            route: 1,
            rows: &[(1, 1, 400), (2, 2, 500)],
            ..V1Trip::default()
        },
    ];
    let absent = u32::MAX;
    let bytes = r3_feed(
        &stops,
        &routes,
        &trips,
        &[(1, 1, absent, absent, 0, 1, absent, 3)],
    );
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![
            StopWalk {
                stop: 0,
                walk_secs: 0,
            },
            StopWalk {
                stop: 1,
                walk_secs: 1_000,
            },
        ],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];

    let result = profile_r3(&reader, &index, R3Request::new(&q, 100..101)).unwrap();
    assert!(result.points.is_empty());
}

#[test]
fn transfer_r3_type_four_uses_two_rounds_and_zero_actual_transfers() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [bare_route("first"), bare_route("second")];
    let trips = [
        V1Trip {
            id: "first-trip",
            route: 0,
            rows: &[(1, 0, 100), (2, 1, 200)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "second-trip",
            route: 1,
            rows: &[(1, 1, 210), (2, 2, 300)],
            ..V1Trip::default()
        },
    ];
    let absent = u32::MAX;
    let bytes = r3_feed(
        &stops,
        &routes,
        &trips,
        &[(1, 1, absent, absent, 0, 1, absent, 4)],
    );
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];

    let result = profile_r3(&reader, &index, R3Request::new(&q, 0..200)).unwrap();
    let profile = &result.points;
    assert_eq!(r3_tuples(profile), vec![(100, 300, 0)]);
    assert_eq!(profile[0].transit_rounds, 2);
    assert_eq!(
        profile[0]
            .witness
            .iter()
            .map(|leg| (leg.trip_idx, leg.in_seat))
            .collect::<Vec<_>>(),
        vec![(0, false), (1, true)]
    );

    let oracle = OracleInput {
        events: vec![
            OracleEvent {
                from: "origin",
                to: "interchange",
                depart: 100,
                arrive: 200,
                trip: "first",
                service: "weekday",
                walk_secs: 0,
                in_seat: false,
            },
            OracleEvent {
                from: "interchange",
                to: "destination",
                depart: 210,
                arrive: 300,
                trip: "second",
                service: "weekday",
                walk_secs: 0,
                in_seat: true,
            },
        ],
        transfers: vec![OracleTransfer {
            from: "interchange",
            to: "interchange",
            walk_secs: 0,
            from_trip: Some("first"),
            to_trip: Some("second"),
            in_seat: true,
        }],
        entry_walks: vec![OracleStopWalk {
            stop: "origin",
            walk_secs: 0,
        }],
        exit_walks: vec![OracleStopWalk {
            stop: "destination",
            walk_secs: 0,
        }],
        max_boards: 2,
        allowed_services: vec!["weekday"],
    };
    assert_eq!(r3_tuples(profile), oracle_tuples(oracle));
}

#[test]
fn transfer_r3_type_four_does_not_require_passenger_drop_off_or_pickup() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [
        bare_route("first"),
        bare_route("second"),
        bare_route("ordinary"),
    ];
    let trips = [
        V1Trip {
            id: "first-trip",
            route: 0,
            rows: &[(1, 0, 100), (2, 1, 200)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "second-trip",
            route: 1,
            rows: &[(1, 1, 210), (2, 2, 300)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "ordinary-trip",
            route: 2,
            rows: &[(1, 1, 210), (2, 2, 250)],
            ..V1Trip::default()
        },
    ];
    let absent = u32::MAX;
    let bytes = build_v1_ptb(&V1Feed {
        stops: &stops,
        routes: &routes,
        trips: &trips,
        stop_routes: StopRoutes::Served,
        feed_start_date: DATE,
        city_tz_offset_seconds: 0,
        services: all_active_service(),
        transfers: &[
            (1, 1, absent, absent, 0, 1, absent, 4),
            (1, 1, absent, absent, 0, 2, absent, 1),
        ],
        // First trip forbids drop-off at s1; second forbids pickup there.
        boarding: &[0x50, 0x54, 0x51, 0x50, 0x50, 0x50],
        stop_index: false,
    });
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![
        StopWalk {
            stop: 1,
            walk_secs: 0,
        },
        StopWalk {
            stop: 2,
            walk_secs: 0,
        },
    ];

    let result = profile_r3(&reader, &index, R3Request::new(&q, 100..101)).unwrap();
    assert_eq!(r3_tuples(&result.points), vec![(100, 300, 0)]);
    assert_eq!(
        result.points[0]
            .witness
            .iter()
            .map(|leg| (leg.trip_idx, leg.in_seat))
            .collect::<Vec<_>>(),
        vec![(0, false), (1, true)]
    );
}

#[test]
fn transfer_r3_can_board_later_occurrence_of_repeated_loop_stop() {
    let stops = [
        bare_stop("s0"),
        bare_stop("s1"),
        bare_stop("s2"),
        bare_stop("s3"),
    ];
    let routes = [bare_route("loop")];
    let trips = [V1Trip {
        id: "loop-trip",
        route: 0,
        rows: &[
            (1, 0, 100),
            (2, 1, 200),
            (3, 2, 300),
            (4, 1, 400),
            (5, 3, 500),
        ],
        ..V1Trip::default()
    }];
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 1,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 3,
        walk_secs: 0,
    }];

    let result = profile_r3(&reader, &index, R3Request::new(&q, 350..450)).unwrap();
    let profile = &result.points;
    assert_eq!(r3_tuples(profile), vec![(400, 500, 0)]);
    assert_eq!(profile[0].witness.len(), 1);
    assert_eq!(profile[0].witness[0].trip_idx, 0);
    assert_eq!(profile[0].witness[0].board_position, 3);
    assert_eq!(profile[0].witness[0].alight_position, 4);

    let oracle = OracleInput {
        events: vec![OracleEvent {
            from: "loop-repeat",
            to: "destination",
            depart: 400,
            arrive: 500,
            trip: "loop",
            service: "weekday",
            walk_secs: 0,
            in_seat: false,
        }],
        transfers: vec![],
        entry_walks: vec![OracleStopWalk {
            stop: "loop-repeat",
            walk_secs: 0,
        }],
        exit_walks: vec![OracleStopWalk {
            stop: "destination",
            walk_secs: 0,
        }],
        max_boards: 1,
        allowed_services: vec!["weekday"],
    };
    assert_eq!(r3_tuples(profile), oracle_tuples(oracle));
}

#[test]
fn transfer_r3_reports_supported_scope_without_ptft() {
    let bytes = build_n_trip_ptb(2, &[&[(1, 0, 100), (2, 1, 200)]]);
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 1,
        walk_secs: 0,
    }];
    let result = profile_r3(&reader, &index, R3Request::new(&q, 0..300)).unwrap();
    assert_eq!(result.supported_service_date, DATE);
    assert_eq!(result.ptft_status, R3PtftStatus::NotSupplied);
    assert_eq!(
        result.multi_date_status,
        R3MultiDateStatus::UnsupportedSingleServiceDateOnly
    );
    assert_eq!(result.requested_window, 0..300);
    assert_eq!(result.covered_window, 0..300);
    assert_eq!(result.coverage_scope, R3CoverageScope::SuppliedWindowOnly);
    assert!(result.page_complete);
    assert!(result.window_exhausted);
    assert!(!result.day_exhausted);
}

#[test]
fn transfer_r3_applies_directed_ptft_between_transit_legs() {
    let stops = [
        bare_stop("s0"),
        bare_stop("s1"),
        bare_stop("s2"),
        bare_stop("s3"),
    ];
    let routes = [bare_route("first"), bare_route("second")];
    let first_rows = [(1, 0, 100), (2, 1, 200)];
    let second_rows = [(1, 2, 450), (2, 3, 500)];
    let trips = [
        V1Trip {
            id: "first-trip",
            route: 0,
            rows: &first_rows,
            ..V1Trip::default()
        },
        V1Trip {
            id: "second-trip",
            route: 1,
            rows: &second_rows,
            ..V1Trip::default()
        },
    ];
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let ptft = build_ptft(&["s3", "s2", "s1", "s0"], &[&[], &[], &[(1, 30)], &[]]);
    let transfers = Transfers::from_bytes(ptft).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: reader.stop_index("s0").unwrap(),
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: reader.stop_index("s3").unwrap(),
        walk_secs: 0,
    }];
    let mut request = R3Request::new(&q, 0..500);
    request.transfers = Some(&transfers);

    let result = profile_r3(&reader, &index, request).unwrap();

    assert_eq!(result.ptft_status, R3PtftStatus::Applied);
    assert_eq!(r3_tuples(&result.points), vec![(100, 500, 1)]);
    assert_eq!(result.points[0].transit_rounds, 2);
    assert_eq!(result.points[0].total_walk_secs, 120);
    assert_eq!(result.points[0].witness.len(), 2);

    let mut inaccessible_bytes = r3_feed(&stops, &routes, &trips, &[]);
    set_stop_wheelchair(&mut inaccessible_bytes, 2, 2);
    let inaccessible_reader = Reader::from_bytes(inaccessible_bytes).unwrap();
    let inaccessible_index = Index::build(&inaccessible_reader, PatternMode::Off).unwrap();
    let mut wheelchair_query = query(
        vec![StopWalk {
            stop: inaccessible_reader.stop_index("s0").unwrap(),
            walk_secs: 0,
        }],
        0,
        Mobility::Wheelchair,
    );
    wheelchair_query.exit_stops = vec![StopWalk {
        stop: inaccessible_reader.stop_index("s3").unwrap(),
        walk_secs: 0,
    }];
    let mut inaccessible_request = R3Request::new(&wheelchair_query, 0..500);
    inaccessible_request.transfers = Some(&transfers);
    assert!(profile_r3(
        &inaccessible_reader,
        &inaccessible_index,
        inaccessible_request
    )
    .unwrap()
    .points
    .is_empty());
}

#[test]
fn transfer_m4_retains_walk_totals_above_u32() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [bare_route("route")];
    let rows = [(1, 0, 100), (2, 1, 200)];
    let trips = [V1Trip {
        id: "trip",
        route: 0,
        rows: &rows,
        ..V1Trip::default()
    }];
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let ptft = build_ptft(&["s0", "s1", "s2"], &[&[], &[(2, u32::MAX)], &[]]);
    let transfers = Transfers::from_bytes(ptft).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: reader.stop_index("s0").unwrap(),
            walk_secs: 0,
        }],
        0,
        Mobility::Wheelchair,
    );
    q.exit_stops = vec![StopWalk {
        stop: reader.stop_index("s2").unwrap(),
        walk_secs: 0,
    }];
    let mut request = R3Request::new(&q, 0..300);
    request.transfers = Some(&transfers);

    let result = profile_m4(&reader, &index, request).unwrap();

    assert_eq!(result.points.len(), 1);
    assert!(result.points[0].total_walk_secs > u32::MAX as u64);
}

#[test]
fn transfer_r3_discards_trips_that_cannot_win_at_any_downstream_position() {
    let stops = [
        bare_stop("origin"),
        bare_stop("hub"),
        bare_stop("destination"),
    ];
    let routes = [bare_route("feeder"), bare_route("trunk")];
    let feeder_rows = [(1, 0, 100), (2, 1, 200)];
    let trip_ids: Vec<String> = (0..64).map(|trip| format!("trunk-{trip}")).collect();
    let trunk_rows: Vec<Vec<(u16, u32, u32)>> = (0..64)
        .map(|trip| {
            let departure = 400 + trip * 10;
            vec![(1, 1, departure), (2, 2, departure + 100)]
        })
        .collect();
    let mut trips = vec![V1Trip {
        id: "feeder-trip",
        route: 0,
        rows: &feeder_rows,
        ..V1Trip::default()
    }];
    trips.extend(trip_ids.iter().zip(&trunk_rows).map(|(id, rows)| V1Trip {
        id,
        route: 1,
        rows,
        ..V1Trip::default()
    }));
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: reader.stop_index("origin").unwrap(),
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: reader.stop_index("destination").unwrap(),
        walk_secs: 0,
    }];

    let result = profile_r3(&reader, &index, R3Request::new(&q, 0..300)).unwrap();
    let mut exhaustive_request = R3Request::new(&q, 0..300);
    exhaustive_request.preserve_all_boarding_trips_for_test = true;
    let exhaustive = profile_r3(&reader, &index, exhaustive_request).unwrap();

    assert_eq!(r3_tuples(&result.points), vec![(100, 500, 1)]);
    assert_eq!(result.points, exhaustive.points);
    assert!(
        result.diagnostics.accepted_labels < 10,
        "dominated trips retained {} labels",
        result.diagnostics.accepted_labels
    );
}

#[test]
fn transfer_r3_merges_behaviorally_equivalent_arriving_trips() {
    let stop_ids: Vec<String> = core::iter::once("origin".into())
        .chain(core::iter::once("hub".into()))
        .chain((0..8).map(|stop| format!("branch-{stop}")))
        .chain(core::iter::once("destination".into()))
        .collect();
    let stops: Vec<SoaStop<'_>> = stop_ids.iter().map(|id| bare_stop(id)).collect();
    let routes = [bare_route("feeder"), bare_route("trunk")];
    let feeder_rows = [(1, 0, 100), (2, 1, 200)];
    let trip_ids: Vec<String> = (0..8).map(|trip| format!("trunk-{trip}")).collect();
    let destination = (stops.len() - 1) as u32;
    let trunk_rows: Vec<Vec<(u16, u32, u32)>> = (0..8)
        .map(|trip| {
            let departure = 400 + trip * 10;
            vec![
                (1, 1, departure),
                (2, trip + 2, departure + 50),
                (3, destination, departure + 100),
            ]
        })
        .collect();
    let mut trips = vec![V1Trip {
        id: "feeder-trip",
        route: 0,
        rows: &feeder_rows,
        ..V1Trip::default()
    }];
    trips.extend(trip_ids.iter().zip(&trunk_rows).map(|(id, rows)| V1Trip {
        id,
        route: 1,
        rows,
        ..V1Trip::default()
    }));
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Unbounded).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: reader.stop_index("origin").unwrap(),
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: reader.stop_index("destination").unwrap(),
        walk_secs: 0,
    }];

    let optimized = profile_r3(&reader, &index, R3Request::new(&q, 0..300)).unwrap();
    let mut exhaustive_request = R3Request::new(&q, 0..300);
    exhaustive_request.preserve_all_boarding_trips_for_test = true;
    let exhaustive = profile_r3(&reader, &index, exhaustive_request).unwrap();

    assert_eq!(optimized.points, exhaustive.points);
    assert!(
        optimized.diagnostics.accepted_labels < exhaustive.diagnostics.accepted_labels,
        "optimized={} exhaustive={}",
        optimized.diagnostics.accepted_labels,
        exhaustive.diagnostics.accepted_labels
    );
}

#[test]
fn transfer_r3_does_not_chain_two_ptft_edges_in_one_round() {
    let stops = [
        bare_stop("s0"),
        bare_stop("s1"),
        bare_stop("s2"),
        bare_stop("s3"),
        bare_stop("s4"),
    ];
    let routes = [bare_route("first"), bare_route("second")];
    let first_rows = [(1, 0, 100), (2, 1, 200)];
    let second_rows = [(1, 3, 600), (2, 4, 700)];
    let trips = [
        V1Trip {
            id: "first-trip",
            route: 0,
            rows: &first_rows,
            ..V1Trip::default()
        },
        V1Trip {
            id: "second-trip",
            route: 1,
            rows: &second_rows,
            ..V1Trip::default()
        },
    ];
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let ptft = build_ptft(
        &["s0", "s1", "s2", "s3", "s4"],
        &[&[], &[(2, 30)], &[(3, 30)], &[], &[]],
    );
    let transfers = Transfers::from_bytes(ptft).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: reader.stop_index("s0").unwrap(),
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: reader.stop_index("s4").unwrap(),
        walk_secs: 0,
    }];
    let mut request = R3Request::new(&q, 0..800);
    request.transfers = Some(&transfers);

    let result = profile_r3(&reader, &index, request).unwrap();

    assert!(result.points.is_empty());
}

#[test]
fn transfer_m4_retains_slower_arrival_with_less_walking_at_shared_frontier() {
    let stops = [
        bare_stop("origin"),
        bare_stop("fast-alight"),
        bare_stop("slow-alight"),
        bare_stop("hub"),
        bare_stop("destination"),
    ];
    let routes = [
        bare_route("fast-feeder"),
        bare_route("slow-feeder"),
        bare_route("trunk"),
    ];
    let fast_rows = [(1, 0, 100), (2, 1, 200)];
    let slow_rows = [(1, 0, 100), (2, 2, 450)];
    let early_rows = [(1, 3, 620), (2, 4, 700)];
    let late_rows = [(1, 3, 700), (2, 4, 800)];
    let trips = [
        V1Trip {
            id: "fast-feeder-trip",
            route: 0,
            rows: &fast_rows,
            ..V1Trip::default()
        },
        V1Trip {
            id: "slow-feeder-trip",
            route: 1,
            rows: &slow_rows,
            ..V1Trip::default()
        },
        V1Trip {
            id: "early-trunk-trip",
            route: 2,
            rows: &early_rows,
            ..V1Trip::default()
        },
        V1Trip {
            id: "late-trunk-trip",
            route: 2,
            rows: &late_rows,
            ..V1Trip::default()
        },
    ];
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let ptft = build_ptft(
        &["origin", "fast-alight", "slow-alight", "hub", "destination"],
        &[&[], &[(3, 300)], &[(3, 30)], &[], &[]],
    );
    let transfers = Transfers::from_bytes(ptft).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: reader.stop_index("origin").unwrap(),
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: reader.stop_index("destination").unwrap(),
        walk_secs: 0,
    }];
    let mut r3_request = R3Request::new(&q, 0..900);
    r3_request.transfers = Some(&transfers);
    let mut m4_request = R3Request::new(&q, 0..900);
    m4_request.transfers = Some(&transfers);

    let r3 = profile_r3(&reader, &index, r3_request).unwrap();
    let m4 = profile_m4(&reader, &index, m4_request).unwrap();

    assert_eq!(r3.objectives, ProfileObjectives::R3);
    assert_eq!(m4.objectives, ProfileObjectives::M4);
    assert_eq!(m4_tuples(&r3.points), vec![(100, 700, 1, 300)]);
    assert_eq!(
        m4_tuples(&m4.points),
        vec![(100, 700, 1, 300), (100, 800, 1, 120)]
    );

    let mut session_request = R3Request::new(&q, 0..900);
    session_request.transfers = Some(&transfers);
    let mut session =
        R3Session::new_with_objectives(&reader, &index, session_request, ProfileObjectives::M4)
            .unwrap();
    let page = session.next_page(1).unwrap();
    assert_eq!(page.objectives, ProfileObjectives::M4);
    assert_eq!(m4_tuples(&page.points), m4_tuples(&m4.points));
}

#[test]
fn transfer_r3_session_pages_match_one_shot_and_reuse_prior_state() {
    let reader = Reader::from_bytes(session_page_feed()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];
    let full = profile_r3(&reader, &index, R3Request::new(&q, 0..200)).unwrap();
    let mut session = R3Session::new(&reader, &index, R3Request::new(&q, 0..200)).unwrap();
    assert!(matches!(
        session.next_page(0),
        Err(R3Error::InvalidRequest(_))
    ));

    let first = session.next_page(1).unwrap();
    assert_eq!(r3_tuples(&first.points), vec![(150, 250, 1), (150, 300, 0)]);
    assert_eq!(first.requested_page_size, 1);
    assert_eq!(first.completion, R3PageCompletion::SurvivorTargetClosed);
    assert_eq!(first.page_diagnostics.entry_events, 2);
    assert_eq!(first.page_diagnostics.timestamp_buckets, 1);
    assert_eq!(first.diagnostics.entry_events, 2);
    assert_eq!(first.covered_window, 150..200);
    assert_eq!(first.covered_frontier_secs, 150);
    assert_eq!(first.latest_departure_certificate.covered_from_secs, 150);
    assert_eq!(
        first
            .latest_departure_certificate
            .covered_until_exclusive_secs,
        200
    );
    assert_eq!(
        first
            .latest_departure_certificate
            .next_unprocessed_origin_ready_secs,
        Some(100)
    );
    assert!(
        first
            .latest_departure_certificate
            .equal_time_boundary_closed
    );
    assert!(first.page_complete);
    assert!(!first.window_exhausted);
    assert!(!first.day_exhausted);

    let second = session.next_page(1).unwrap();
    assert_eq!(r3_tuples(&second.points), vec![(100, 200, 0)]);
    assert_eq!(second.page_diagnostics.entry_events, 1);
    assert_eq!(second.page_diagnostics.timestamp_buckets, 1);
    assert_eq!(second.diagnostics.entry_events, 3);
    assert_eq!(second.completion, R3PageCompletion::SurvivorTargetClosed);
    assert!(second.window_exhausted);
    assert_eq!(
        second
            .latest_departure_certificate
            .next_unprocessed_origin_ready_secs,
        None
    );

    let mut concatenated = first.points;
    concatenated.extend(second.points);
    assert_eq!(concatenated, full.points);
}

#[test]
fn transfer_r3_session_skips_empty_buckets_until_survivor_or_exhaustion() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [bare_route("dead"), bare_route("useful")];
    let trips = [
        V1Trip {
            id: "dead-trip",
            route: 0,
            rows: &[(1, 0, 200), (2, 1, 220)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "useful-trip",
            route: 1,
            rows: &[(1, 0, 100), (2, 2, 300)],
            ..V1Trip::default()
        },
    ];
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];
    let mut session = R3Session::new(&reader, &index, R3Request::new(&q, 0..300)).unwrap();

    let page = session.next_page(2).unwrap();
    assert_eq!(r3_tuples(&page.points), vec![(100, 300, 0)]);
    assert_eq!(page.page_diagnostics.timestamp_buckets, 2);
    assert_eq!(page.page_diagnostics.entry_events, 2);
    assert_eq!(page.completion, R3PageCompletion::WindowExhausted);
    assert!(page.page_complete);
    assert!(page.window_exhausted);
    assert!(!page.day_exhausted);
}

#[test]
fn transfer_r3_max_label_bound_returns_typed_resource_error() {
    let bytes = build_n_trip_ptb(2, &[&[(1, 0, 100), (2, 1, 200)]]);
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 1,
        walk_secs: 0,
    }];
    let mut request = R3Request::new(&q, 0..300);
    request.max_labels = 1;

    assert!(matches!(
        profile_r3(&reader, &index, request),
        Err(R3Error::ResourceExhausted {
            max_labels: 1,
            attempted_labels: 2,
        })
    ));
}

#[test]
fn transfer_r3_bounds_entry_event_materialization_before_session_creation() {
    let bytes = append_frequencies(
        build_n_trip_ptb(2, &[&[(1, 0, 0), (2, 1, 10)]]),
        &[(0, 0, 1_000, 1, 0)],
    );
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 1,
        walk_secs: 0,
    }];
    let mut request = R3Request::new(&q, 0..1_000);
    request.max_entry_events = 2;

    assert!(matches!(
        R3Session::new(&reader, &index, request),
        Err(R3Error::EntryEventsExhausted {
            max_entry_events: 2,
            attempted_events: 3,
        })
    ));
}

#[test]
fn transfer_r3_uses_concrete_exact_times_zero_instance_after_transfer() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [bare_route("feeder"), bare_route("frequency")];
    let trips = [
        V1Trip {
            id: "feeder-trip",
            route: 0,
            rows: &[(1, 0, 100), (2, 1, 200)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "frequency-trip",
            route: 1,
            rows: &[(1, 1, 1_000), (2, 2, 1_100)],
            ..V1Trip::default()
        },
    ];
    let bytes = append_frequencies(
        r3_feed(&stops, &routes, &trips, &[]),
        &[(1, 300, 600, 100, 0)],
    );
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];

    let result = profile_r3(&reader, &index, R3Request::new(&q, 100..101)).unwrap();
    assert_eq!(r3_tuples(&result.points), vec![(100, 500, 1)]);
    assert_eq!(result.points[0].witness.len(), 2);
    assert_eq!(result.points[0].witness[1].board_secs, 400);
    assert_eq!(result.points[0].witness[1].alight_secs, 500);
    assert_eq!(result.points[0].witness[1].frequency_offset_secs, -600);
    assert!(result.points[0].witness[1].frequency_instance);
}

#[test]
fn transfer_r3_max_rounds_rejects_two_leg_path() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [bare_route("first"), bare_route("second")];
    let trips = [
        V1Trip {
            id: "first-trip",
            route: 0,
            rows: &[(1, 0, 100), (2, 1, 200)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "second-trip",
            route: 1,
            rows: &[(1, 1, 320), (2, 2, 400)],
            ..V1Trip::default()
        },
    ];
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];
    q.max_rounds = Some(1);

    let result = profile_r3(&reader, &index, R3Request::new(&q, 0..200)).unwrap();
    assert!(result.points.is_empty());
}

#[test]
fn transfer_r3_equal_tuple_prefers_less_walking_without_making_it_objective() {
    let stops = [bare_stop("s0"), bare_stop("s1"), bare_stop("s2")];
    let routes = [bare_route("zero-walk"), bare_route("walk")];
    let trips = [
        V1Trip {
            id: "zero-walk-trip",
            route: 0,
            rows: &[(1, 0, 100), (2, 2, 300)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "walk-trip",
            route: 1,
            rows: &[(1, 1, 150), (2, 2, 300)],
            ..V1Trip::default()
        },
    ];
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![
            StopWalk {
                stop: 0,
                walk_secs: 0,
            },
            StopWalk {
                stop: 1,
                walk_secs: 50,
            },
        ],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];

    let result = profile_r3(&reader, &index, R3Request::new(&q, 100..101)).unwrap();
    assert_eq!(r3_tuples(&result.points), vec![(100, 300, 0)]);
    assert_eq!(result.points[0].total_walk_secs, 0);
    assert_eq!(result.points[0].witness[0].trip_idx, 0);
}

#[test]
fn transfer_r3_semantic_tie_break_ignores_equal_bucket_traversal_order() {
    let stops = [bare_stop("s0"), bare_stop("s1")];
    let routes = [bare_route("canonical"), bare_route("alternate")];
    let trips = [
        V1Trip {
            id: "canonical-trip",
            route: 0,
            rows: &[(1, 0, 100), (2, 1, 300)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "alternate-trip",
            route: 1,
            rows: &[(1, 0, 100), (2, 1, 300)],
            ..V1Trip::default()
        },
    ];
    let reader = Reader::from_bytes(r3_feed(&stops, &routes, &trips, &[])).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 1,
        walk_secs: 0,
    }];

    let canonical = profile_r3(&reader, &index, R3Request::new(&q, 100..101)).unwrap();
    let mut reversed_request = R3Request::new(&q, 100..101);
    reversed_request.reverse_bucket_events_for_test = true;
    let reversed = profile_r3(&reader, &index, reversed_request).unwrap();

    assert_eq!(canonical.points, reversed.points);
    assert_eq!(canonical.points[0].witness[0].reader_route_idx, 0);
    assert_eq!(canonical.points[0].witness[0].trip_idx, 0);
}

#[test]
fn transfer_r3_matches_reset_reference_and_oracle_on_direct_scalar_safe_fixture() {
    // Scope is deliberately direct, one-route, zero-walk, and transfer-free.
    // Production reset's scalar stop label is sufficient here; this comparison
    // does not claim reset_reference is an oracle for transfer-aware profiles.
    let bytes = build_n_trip_ptb(
        2,
        &[&[(1, 0, 100), (2, 1, 300)], &[(1, 0, 150), (2, 1, 250)]],
    );
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 1,
        walk_secs: 0,
    }];

    let profile = profile_r3(&reader, &index, R3Request::new(&q, 0..200)).unwrap();
    let reset = reset_reference(&reader, &index, None, &q, 0..200, usize::MAX).unwrap();
    let reset_tuples = pareto_tuples(
        reset
            .samples
            .iter()
            .flat_map(|sample| {
                sample.itineraries.iter().map(|itinerary| {
                    (
                        sample.event.origin_ready_secs,
                        itinerary.alight_secs,
                        itinerary.transfers,
                    )
                })
            })
            .collect(),
    );
    let oracle = OracleInput {
        events: vec![
            OracleEvent {
                from: "origin",
                to: "destination",
                depart: 100,
                arrive: 300,
                trip: "early",
                service: "weekday",
                walk_secs: 0,
                in_seat: false,
            },
            OracleEvent {
                from: "origin",
                to: "destination",
                depart: 150,
                arrive: 250,
                trip: "late",
                service: "weekday",
                walk_secs: 0,
                in_seat: false,
            },
        ],
        transfers: vec![],
        entry_walks: vec![OracleStopWalk {
            stop: "origin",
            walk_secs: 0,
        }],
        exit_walks: vec![OracleStopWalk {
            stop: "destination",
            walk_secs: 0,
        }],
        max_boards: 1,
        allowed_services: vec!["weekday"],
    };

    assert_eq!(r3_tuples(&profile.points), vec![(150, 250, 0)]);
    assert_eq!(r3_tuples(&profile.points), reset_tuples);
    assert_eq!(r3_tuples(&profile.points), oracle_tuples(oracle));
}

#[test]
fn transfer_r3_objectives_match_across_all_pattern_modes() {
    let bytes = include_bytes!(
        "../../../../../packages/frontend/tests/services/__fixtures__/lasso-boarding.ptb"
    );
    let reader = Reader::from_bytes(bytes.to_vec()).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: reader.stop_index("s1").unwrap(),
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.date = 20260505;
    q.exit_stops = vec![StopWalk {
        stop: reader.stop_index("s0").unwrap(),
        walk_secs: 0,
    }];

    let mut by_mode = Vec::new();
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let result = profile_r3(&reader, &index, R3Request::new(&q, 0..500)).unwrap();
        by_mode.push(r3_tuples(&result.points));
    }
    assert_eq!(by_mode[0], vec![(360, 420, 0)]);
    assert_eq!(by_mode[1], by_mode[0]);
    assert_eq!(by_mode[2], by_mode[0]);
}

#[test]
fn legal_events_cover_access_positions_and_all_legality_filters() {
    let mut first_query = query(
        vec![
            StopWalk {
                stop: 1,
                walk_secs: 300,
            },
            StopWalk {
                stop: 0,
                walk_secs: 0,
            },
        ],
        0,
        Mobility::Default,
    );
    first_query.excluded_modes = vec![2];
    let events = enumerate(
        feed_with_legality_cases(),
        PatternMode::Off,
        &first_query,
        25_000..31_000,
    );

    // Literal expected opportunities: t0 boards at s1 twice and s0 once;
    // t1 boards at its second s1 occurrence and s0 once. The inactive t2,
    // excluded rail route, and t1's pickup-forbidden first s1 are absent.
    assert_eq!(events.len(), 5);
    assert_eq!(
        events.iter().map(event_key).collect::<Vec<_>>(),
        vec![
            (25_200, 0, 0, 0, 0),
            (25_500, 0, 0, 1, 0),
            (25_800, 0, 1, 0, 0),
            (26_700, 0, 0, 3, 0),
            (27_700, 0, 1, 3, 0),
        ]
        .into_iter()
        .collect::<Vec<_>>(),
    );
    assert_eq!(events[1].effective_board_secs, 25_800);
    assert_eq!(events[1].origin_ready_secs, 25_500);

    let inactive_only = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    assert!(enumerate(
        feed_with_legality_cases(),
        PatternMode::Off,
        &inactive_only,
        29_900..30_100,
    )
    .is_empty());

    let mut wheelchair_bytes = feed_with_legality_cases();
    set_trip_wheelchair(&mut wheelchair_bytes, 1, 2);
    let wheelchair_events = enumerate(
        wheelchair_bytes,
        PatternMode::Off,
        &query(
            vec![StopWalk {
                stop: 1,
                walk_secs: 300,
            }],
            0,
            Mobility::Wheelchair,
        ),
        25_000..29_000,
    );
    assert_eq!(wheelchair_events.len(), 2);
    assert!(wheelchair_events.iter().all(|e| e.trip_idx == 0));

    let mut bicycle_bytes = feed_with_legality_cases();
    set_trip_bikes_allowed(&mut bicycle_bytes, 0, 2);
    let mut bicycle_query = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        0,
        Mobility::Bicycle,
    );
    bicycle_query.excluded_modes = vec![2];
    let bicycle_events = enumerate(
        bicycle_bytes,
        PatternMode::Off,
        &bicycle_query,
        25_000..29_000,
    );
    assert_eq!(bicycle_events.len(), 1);
    assert_eq!(bicycle_events[0].trip_idx, 1);
}

#[test]
fn overnight_time_stays_on_originating_service_date() {
    let bytes = build_n_trip_ptb(2, &[&[(1, 0, 91_800), (2, 1, 92_400)]]);
    let events = enumerate(
        bytes,
        PatternMode::Off,
        &query(
            vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            0,
            Mobility::Default,
        ),
        91_000..92_000,
    );

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].service_date, DATE);
    assert_eq!(events[0].effective_board_secs, 91_800);
    assert_eq!(events[0].origin_ready_secs, 91_800);
}

#[test]
fn exact_times_zero_enumerates_both_window_edges_and_applies_board_offset() {
    let bytes = include_bytes!(
        "../../../../../packages/shared/src/ptb/__fixtures__/frequencies-parity.ptb"
    )
    .to_vec();
    let events = enumerate(
        bytes,
        PatternMode::Off,
        &Query {
            date: 20260601,
            ..query(
                vec![StopWalk {
                    stop: 1,
                    walk_secs: 0,
                }],
                0,
                Mobility::Default,
            )
        },
        21_600..86_400,
    );

    // Trip 0: 108 starts at 21_600 and ends at 85_800. Trip 1: 40 starts at
    // 36_000 and ends at 71_100. The GTFS end is exclusive, so neither 86_400
    // nor 72_000 appears. The board at s1 is +300 from each first-stop start.
    assert_eq!(events.len(), 148);
    assert_eq!(events.first().unwrap().trip_idx, 0);
    assert_eq!(events.first().unwrap().effective_board_secs, 21_900);
    assert_eq!(events.first().unwrap().frequency_offset_secs, -3_600);
    let trip0_events: Vec<_> = events.iter().filter(|e| e.trip_idx == 0).collect();
    let trip1_events: Vec<_> = events.iter().filter(|e| e.trip_idx == 1).collect();
    assert_eq!(trip0_events.len(), 108);
    assert_eq!(trip1_events.len(), 40);
    assert_eq!(trip0_events[107].effective_board_secs, 86_100);
    assert_eq!(trip0_events[107].frequency_offset_secs, 60_600);
    assert_eq!(trip1_events[0].effective_board_secs, 36_300);
    assert_eq!(events.last().unwrap().trip_idx, 0);
    assert_eq!(events.last().unwrap().effective_board_secs, 86_100);
    assert!(events.iter().all(|e| e.service_date == 20260601));
}

#[test]
fn band_index_and_flat_index_produce_the_same_entry_opportunity() {
    let stops = [
        SoaStop {
            id: "s0",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s1",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R",
        agency: "",
        short: "",
        long: "",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 100), (2, 1, 200)]];
    let bytes = build_pattern_band_ptb(&stops, &routes, trips, &[]);
    let q = Query {
        date: 20260601,
        ..query(
            vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            0,
            Mobility::Default,
        )
    };

    let flat = enumerate(bytes.clone(), PatternMode::Off, &q, 0..300);
    let band = enumerate(bytes, PatternMode::Unbounded, &q, 0..300);
    assert_eq!(flat.len(), 1);
    assert_eq!(band, flat);
    assert_eq!(band[0].effective_board_secs, 100);
}

#[test]
fn reset_reference_counts_actual_scans_and_marks_event_cap_incomplete() {
    let reader = Reader::from_bytes(feed_with_legality_cases()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        25_000,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];

    let capped = reset_reference(&reader, &index, None, &q, 25_000..30_000, 2).unwrap();
    assert_eq!(capped.total_events, 3);
    assert_eq!(capped.examined_events, 2);
    assert!(capped.incomplete);
    assert_eq!(capped.samples.len(), 2);
    assert_eq!(capped.samples[0].event.effective_board_secs, 25_200);
    assert_eq!(capped.samples[1].event.effective_board_secs, 25_800);
    assert_eq!(capped.samples[0].first_board_secs, Some(25_200));
    assert_eq!(capped.samples[1].first_board_secs, Some(25_800));

    let complete = reset_reference(&reader, &index, None, &q, 25_000..30_000, 3).unwrap();
    assert_eq!(complete.total_events, 3);
    assert_eq!(complete.examined_events, 3);
    assert!(!complete.incomplete);
    assert_eq!(complete.samples.len(), 3);
    assert_eq!(complete.samples[2].event.effective_board_secs, 28_500);
    assert_eq!(complete.samples[2].first_board_secs, None);
}

#[test]
fn reset_reference_threshold_is_not_the_returned_first_board() {
    let reader = Reader::from_bytes(feed_with_legality_cases()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 300,
        }],
        0,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];

    let result = reset_reference(&reader, &index, None, &q, 24_900..25_000, 1).unwrap();
    assert_eq!(result.total_events, 1);
    assert_eq!(result.examined_events, 1);
    assert!(!result.incomplete);
    assert_eq!(result.samples[0].event.origin_ready_secs, 24_900);
    assert_eq!(result.samples[0].first_board_secs, Some(25_200));
}

#[test]
fn direct_r3_and_m4_disagree_on_a_real_access_walking_tradeoff() {
    let reader = Reader::from_bytes(feed_with_legality_cases()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![
            StopWalk {
                stop: 0,
                walk_secs: 0,
            },
            StopWalk {
                stop: 1,
                walk_secs: 300,
            },
        ],
        24_000,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];

    let r3 = profile_direct(&reader, &index, &q, 24_000..30_000, DirectObjectives::R3).unwrap();
    let m4 = profile_direct(&reader, &index, &q, 24_000..30_000, DirectObjectives::M4).unwrap();

    let objectives = |points: &[super::direct::DirectPoint]| {
        points
            .iter()
            .map(|p| {
                (
                    p.origin_departure_secs,
                    p.destination_arrival_secs,
                    p.total_walk_secs,
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        objectives(&r3),
        vec![(25_800, 27_000, 0), (25_500, 26_400, 300)]
    );
    assert_eq!(
        objectives(&m4),
        vec![
            (25_800, 27_000, 0),
            (25_500, 26_400, 300),
            (25_200, 26_400, 0)
        ]
    );
    assert_eq!(r3[1].board_position, 1);
    assert!(m4.iter().all(|p| p.actual_transfers == 0));
}

#[test]
fn direct_profile_respects_zero_round_limit() {
    let reader = Reader::from_bytes(feed_with_legality_cases()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: 0,
            walk_secs: 0,
        }],
        25_000,
        Mobility::Default,
    );
    q.exit_stops = vec![StopWalk {
        stop: 2,
        walk_secs: 0,
    }];
    q.max_rounds = Some(0);
    assert!(
        profile_direct(&reader, &index, &q, 25_000..30_000, DirectObjectives::R3)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn direct_profile_uses_later_loop_occurrence_and_concrete_frequency_time() {
    let loop_bytes = include_bytes!(
        "../../../../../packages/frontend/tests/services/__fixtures__/lasso-boarding.ptb"
    );
    let reader = Reader::from_bytes(loop_bytes.to_vec()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: reader.stop_index("s1").unwrap(),
            walk_secs: 0,
        }],
        0,
        Mobility::Default,
    );
    q.date = 20260505;
    q.exit_stops = vec![StopWalk {
        stop: reader.stop_index("s0").unwrap(),
        walk_secs: 0,
    }];
    let loop_profile = profile_direct(&reader, &index, &q, 0..500, DirectObjectives::R3).unwrap();
    assert_eq!(loop_profile.len(), 1);
    assert_eq!(loop_profile[0].origin_departure_secs, 360);
    assert_eq!(loop_profile[0].destination_arrival_secs, 420);
    assert_eq!(loop_profile[0].board_position, 6);
    assert_eq!(loop_profile[0].alight_position, 7);

    let freq_bytes = include_bytes!(
        "../../../../../packages/frontend/tests/services/__fixtures__/frequency-exact0.ptb"
    );
    let reader = Reader::from_bytes(freq_bytes.to_vec()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let mut q = query(
        vec![StopWalk {
            stop: reader.stop_index("s0").unwrap(),
            walk_secs: 0,
        }],
        29_100,
        Mobility::Default,
    );
    q.date = 20260601;
    q.exit_stops = vec![StopWalk {
        stop: reader.stop_index("s1").unwrap(),
        walk_secs: 0,
    }];
    let frequency_profile =
        profile_direct(&reader, &index, &q, 29_100..30_000, DirectObjectives::R3).unwrap();
    assert!(frequency_profile
        .iter()
        .any(|p| p.origin_departure_secs == 29_400
            && p.destination_arrival_secs == 29_700
            && p.frequency_offset_secs != 0));
}

#[test]
fn frequency_probe_jumps_to_first_instance_inside_window() {
    assert_eq!(
        first_frequency_start_at_or_after(999_999, 0, 0, 0, 0, 1_000_000, 1),
        Some(999_999)
    );
    // A downstream boarding occurrence is 300 seconds after the template's
    // first served departure. 100 and 130 imply origin times 400 and 430;
    // the first instance reachable at 450 is the 160 service-second start.
    assert_eq!(
        first_frequency_start_at_or_after(450, 0, 1_300, 1_000, 100, 190, 30),
        Some(160)
    );
    assert_eq!(
        first_frequency_start_at_or_after(500, 0, 1_300, 1_000, 100, 190, 30),
        None
    );
}
