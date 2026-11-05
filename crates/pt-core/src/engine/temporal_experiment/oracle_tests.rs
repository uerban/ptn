use alloc::vec;
use alloc::vec::Vec;

use super::oracle::{
    oracle_profile, Event, Objectives, OracleInput, OracleResult, StopWalk, Transfer,
};

const WEEKDAY: &str = "weekday";

fn event(
    from: &'static str,
    to: &'static str,
    depart: u32,
    arrive: u32,
    trip: &'static str,
    walk_secs: u32,
    in_seat: bool,
) -> Event {
    Event {
        from,
        to,
        depart,
        arrive,
        trip,
        service: WEEKDAY,
        walk_secs,
        in_seat,
    }
}

fn walk(stop: &'static str, walk_secs: u32) -> StopWalk {
    StopWalk { stop, walk_secs }
}

fn transfer(
    from: &'static str,
    to: &'static str,
    walk_secs: u32,
    from_trip: Option<&'static str>,
    to_trip: Option<&'static str>,
    in_seat: bool,
) -> Transfer {
    Transfer {
        from,
        to,
        walk_secs,
        from_trip,
        to_trip,
        in_seat,
    }
}

fn input(
    events: Vec<Event>,
    transfers: Vec<Transfer>,
    entry_walks: Vec<StopWalk>,
    exit_walks: Vec<StopWalk>,
) -> OracleInput {
    OracleInput {
        events,
        transfers,
        entry_walks,
        exit_walks,
        max_boards: 4,
        allowed_services: vec![WEEKDAY],
    }
}

#[test]
fn zero_board_budget_rejects_initial_transit_leg() {
    let mut fixture = input(
        vec![event("origin", "destination", 100, 200, "trip", 0, false)],
        vec![],
        vec![walk("origin", 0)],
        vec![walk("destination", 0)],
    );
    fixture.max_boards = 0;

    assert!(oracle_profile(fixture, Objectives::R3).is_empty());
}

#[test]
fn later_feeder_dominates_earlier_feeder_with_same_arrival_and_walk() {
    let fixture = input(
        vec![
            event(
                "origin",
                "trunk",
                8 * 3600,
                8 * 3600 + 40 * 60,
                "early",
                0,
                false,
            ),
            event(
                "origin",
                "trunk",
                8 * 3600 + 20 * 60,
                8 * 3600 + 40 * 60,
                "late",
                0,
                false,
            ),
            event(
                "trunk",
                "destination",
                9 * 3600,
                9 * 3600 + 30 * 60,
                "trunk",
                0,
                false,
            ),
        ],
        vec![
            transfer("trunk", "trunk", 0, Some("early"), Some("trunk"), false),
            transfer("trunk", "trunk", 0, Some("late"), Some("trunk"), false),
        ],
        vec![walk("origin", 0)],
        vec![walk("destination", 0)],
    );

    assert_eq!(
        oracle_profile(fixture, Objectives::R3),
        vec![OracleResult {
            origin_departure: 8 * 3600 + 20 * 60,
            destination_arrival: 9 * 3600 + 30 * 60,
            actual_transfers: 1,
            total_walk_secs: 0,
            witness: vec![1, 2],
        }]
    );
}

#[test]
fn earlier_low_walk_and_later_high_walk_survive_only_in_m4() {
    let fixture = input(
        vec![
            event(
                "origin",
                "trunk",
                8 * 3600,
                8 * 3600 + 40 * 60,
                "low-walk",
                0,
                false,
            ),
            event(
                "origin",
                "trunk",
                8 * 3600 + 20 * 60,
                8 * 3600 + 40 * 60,
                "high-walk",
                10 * 60,
                false,
            ),
            event(
                "trunk",
                "destination",
                9 * 3600,
                9 * 3600 + 30 * 60,
                "trunk",
                0,
                false,
            ),
        ],
        vec![
            transfer("trunk", "trunk", 0, Some("low-walk"), Some("trunk"), false),
            transfer("trunk", "trunk", 0, Some("high-walk"), Some("trunk"), false),
        ],
        vec![walk("origin", 0)],
        vec![walk("destination", 0)],
    );

    assert_eq!(
        oracle_profile(fixture.clone(), Objectives::R3),
        vec![OracleResult {
            origin_departure: 8 * 3600 + 20 * 60,
            destination_arrival: 9 * 3600 + 30 * 60,
            actual_transfers: 1,
            total_walk_secs: 10 * 60,
            witness: vec![1, 2],
        }]
    );
    assert_eq!(
        oracle_profile(fixture, Objectives::M4),
        vec![
            OracleResult {
                origin_departure: 8 * 3600 + 20 * 60,
                destination_arrival: 9 * 3600 + 30 * 60,
                actual_transfers: 1,
                total_walk_secs: 10 * 60,
                witness: vec![1, 2],
            },
            OracleResult {
                origin_departure: 8 * 3600,
                destination_arrival: 9 * 3600 + 30 * 60,
                actual_transfers: 1,
                total_walk_secs: 0,
                witness: vec![0, 2],
            },
        ]
    );
}

#[test]
fn type_four_in_seat_chain_has_two_legs_but_zero_passenger_transfers() {
    let fixture = input(
        vec![
            event(
                "origin",
                "interchange",
                8 * 3600,
                8 * 3600 + 20 * 60,
                "first",
                0,
                false,
            ),
            event(
                "interchange",
                "destination",
                8 * 3600 + 21 * 60,
                8 * 3600 + 40 * 60,
                "second",
                0,
                true,
            ),
        ],
        vec![transfer(
            "interchange",
            "interchange",
            0,
            Some("first"),
            Some("second"),
            true,
        )],
        vec![walk("origin", 0)],
        vec![walk("destination", 0)],
    );

    assert_eq!(
        oracle_profile(fixture, Objectives::M4),
        vec![OracleResult {
            origin_departure: 8 * 3600,
            destination_arrival: 8 * 3600 + 40 * 60,
            actual_transfers: 0,
            total_walk_secs: 0,
            witness: vec![0, 1],
        }]
    );
}

#[test]
fn later_express_that_arrives_sooner_is_the_only_r3_result() {
    let fixture = input(
        vec![
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600 + 30 * 60,
                "slow",
                0,
                false,
            ),
            event(
                "origin",
                "destination",
                8 * 3600 + 20 * 60,
                9 * 3600,
                "express",
                0,
                false,
            ),
        ],
        vec![],
        vec![walk("origin", 0)],
        vec![walk("destination", 0)],
    );

    assert_eq!(
        oracle_profile(fixture, Objectives::R3),
        vec![OracleResult {
            origin_departure: 8 * 3600 + 20 * 60,
            destination_arrival: 9 * 3600,
            actual_transfers: 0,
            total_walk_secs: 0,
            witness: vec![1],
        }]
    );
}

#[test]
fn equal_departures_keep_six_distinct_m4_objective_tuples() {
    let fixture = input(
        vec![
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600,
                "one",
                500,
                false,
            ),
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600 + 60,
                "two",
                400,
                false,
            ),
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600 + 120,
                "three",
                300,
                false,
            ),
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600 + 180,
                "four",
                200,
                false,
            ),
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600 + 240,
                "five",
                100,
                false,
            ),
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600 + 300,
                "six",
                0,
                false,
            ),
        ],
        vec![],
        vec![walk("origin", 0)],
        vec![walk("destination", 0)],
    );

    assert_eq!(
        oracle_profile(fixture.clone(), Objectives::R3),
        vec![OracleResult {
            origin_departure: 8 * 3600,
            destination_arrival: 9 * 3600,
            actual_transfers: 0,
            total_walk_secs: 500,
            witness: vec![0],
        }]
    );
    assert_eq!(
        oracle_profile(fixture, Objectives::M4),
        vec![
            OracleResult {
                origin_departure: 8 * 3600,
                destination_arrival: 9 * 3600,
                actual_transfers: 0,
                total_walk_secs: 500,
                witness: vec![0]
            },
            OracleResult {
                origin_departure: 8 * 3600,
                destination_arrival: 9 * 3600 + 60,
                actual_transfers: 0,
                total_walk_secs: 400,
                witness: vec![1]
            },
            OracleResult {
                origin_departure: 8 * 3600,
                destination_arrival: 9 * 3600 + 120,
                actual_transfers: 0,
                total_walk_secs: 300,
                witness: vec![2]
            },
            OracleResult {
                origin_departure: 8 * 3600,
                destination_arrival: 9 * 3600 + 180,
                actual_transfers: 0,
                total_walk_secs: 200,
                witness: vec![3]
            },
            OracleResult {
                origin_departure: 8 * 3600,
                destination_arrival: 9 * 3600 + 240,
                actual_transfers: 0,
                total_walk_secs: 100,
                witness: vec![4]
            },
            OracleResult {
                origin_departure: 8 * 3600,
                destination_arrival: 9 * 3600 + 300,
                actual_transfers: 0,
                total_walk_secs: 0,
                witness: vec![5]
            },
        ]
    );
}

#[test]
fn r3_uses_less_walking_then_event_order_for_an_equal_objective_tuple() {
    let fixture = input(
        vec![
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600,
                "more-walk",
                90,
                false,
            ),
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600,
                "less-walk",
                30,
                false,
            ),
            event(
                "origin",
                "destination",
                8 * 3600,
                9 * 3600,
                "same-walk",
                30,
                false,
            ),
        ],
        vec![],
        vec![walk("origin", 0)],
        vec![walk("destination", 0)],
    );

    assert_eq!(
        oracle_profile(fixture, Objectives::R3),
        vec![OracleResult {
            origin_departure: 8 * 3600,
            destination_arrival: 9 * 3600,
            actual_transfers: 0,
            total_walk_secs: 30,
            witness: vec![1],
        }]
    );
}

#[test]
fn objectives_include_access_connection_event_and_egress_walking() {
    let fixture = input(
        vec![
            event(
                "boarding",
                "platform",
                8 * 3600 + 10 * 60,
                8 * 3600 + 20 * 60,
                "first",
                5,
                false,
            ),
            event(
                "other-platform",
                "destination",
                8 * 3600 + 25 * 60,
                8 * 3600 + 40 * 60,
                "second",
                7,
                false,
            ),
        ],
        vec![transfer(
            "platform",
            "other-platform",
            3 * 60,
            Some("first"),
            Some("second"),
            false,
        )],
        vec![walk("boarding", 2 * 60)],
        vec![walk("destination", 4 * 60)],
    );

    assert_eq!(
        oracle_profile(fixture, Objectives::M4),
        vec![OracleResult {
            origin_departure: 8 * 3600 + 8 * 60,
            destination_arrival: 8 * 3600 + 44 * 60,
            actual_transfers: 1,
            total_walk_secs: 5 + 3 * 60 + 7 + 2 * 60 + 4 * 60,
            witness: vec![0, 1],
        }]
    );
}

#[test]
fn only_directed_and_trip_scoped_connections_are_legal() {
    let fixture = input(
        vec![
            event(
                "origin",
                "left",
                8 * 3600,
                8 * 3600 + 10 * 60,
                "first",
                0,
                false,
            ),
            event(
                "right",
                "destination",
                8 * 3600 + 12 * 60,
                8 * 3600 + 30 * 60,
                "second",
                0,
                false,
            ),
            event(
                "left",
                "destination",
                8 * 3600 + 20 * 60,
                8 * 3600 + 40 * 60,
                "second",
                0,
                false,
            ),
        ],
        vec![
            transfer("right", "left", 0, Some("first"), Some("second"), false),
            transfer("left", "left", 0, Some("other-trip"), Some("second"), false),
        ],
        vec![walk("origin", 0)],
        vec![walk("destination", 0)],
    );

    assert_eq!(oracle_profile(fixture, Objectives::R3), Vec::new());
}
