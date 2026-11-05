//! Exhaustive oracle for hand-authored, small temporal graphs.
//!
//! This is intentionally independent of `scan::run_scan` and
//! `reconstruct::reconstruct`: it enumerates the supplied event occurrences,
//! then Pareto-reduces their objective tuples. It is a test-only experiment,
//! not a GTFS reader or a production rRAPTOR/McRAPTOR implementation.
//!
//! GTFS permits a stop to occur more than once in one trip and permits times
//! beyond 24:00:00, so event indices—not stop IDs—are the path identities here.
//! See <https://gtfs.org/documentation/schedule/reference/#stop_timestxt> and
//! the loop-route example at
//! <https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes>.

use alloc::vec::Vec;
use core::cmp::Ordering;

/// One directed, scheduled transit-leg occurrence in a synthetic timetable.
///
/// `walk_secs` is walking deliberately attributed to this synthetic leg. The
/// oracle's walking objective is the sum of entry, event, directed-transfer,
/// and exit walking; ordinary transit events therefore set it to zero.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Event {
    pub from: &'static str,
    pub to: &'static str,
    pub depart: u32,
    pub arrive: u32,
    pub trip: &'static str,
    pub service: &'static str,
    pub walk_secs: u32,
    /// True only when this event is entered through a scoped type-4 in-seat
    /// continuation, which is not a passenger transfer or a new boarding.
    pub in_seat: bool,
}

/// A directed, optionally trip-scoped eligibility edge between two events.
///
/// The edge's walking time is both the feasibility floor and part of the M4
/// objective. `in_seat` models a type-4 continuation; it must have zero walk
/// time and match an `Event` marked `in_seat`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Transfer {
    pub from: &'static str,
    pub to: &'static str,
    pub walk_secs: u32,
    pub from_trip: Option<&'static str>,
    pub to_trip: Option<&'static str>,
    pub in_seat: bool,
}

/// An access or egress stop and its directed walking duration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StopWalk {
    pub stop: &'static str,
    pub walk_secs: u32,
}

/// Input to the test-only exhaustive oracle.
///
/// The harness deliberately accepts only small, fully materialized synthetic
/// data: at most twelve events and four passenger boardings. `allowed_services`
/// is an exact active-service filter; an empty list means no service is active.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleInput {
    pub events: Vec<Event>,
    pub transfers: Vec<Transfer>,
    pub entry_walks: Vec<StopWalk>,
    pub exit_walks: Vec<StopWalk>,
    pub max_boards: usize,
    pub allowed_services: Vec<&'static str>,
}

/// One legal path together with all values used for objective comparison.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleResult {
    pub origin_departure: u32,
    pub destination_arrival: u32,
    pub actual_transfers: u32,
    pub total_walk_secs: u32,
    /// Event-occurrence indices in the input, in travel order.
    pub witness: Vec<usize>,
}

/// The profile objective being reduced.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Objectives {
    /// Later origin departure, earlier destination arrival, fewer passenger
    /// transfers. Less walking, then event-index order, selects the canonical
    /// witness for an equal tuple without making walking an R3 objective.
    R3,
    /// R3 plus less total walking as an independent Pareto dimension.
    M4,
}

/// Enumerate all legal simple paths and return one canonical witness for every
/// Pareto-optimal R3 or M4 tuple.
///
/// A path starts at an entry stop, so its origin departure is exactly the first
/// event's departure minus the entry walk. It may finish at any exit stop, and
/// destination arrival includes that exit walk. Passenger-transfer count is
/// incremented only on an ordinary inter-trip connection: staying on the same
/// trip and a scoped in-seat continuation each count as zero.
pub fn oracle_profile(input: OracleInput, objectives: Objectives) -> Vec<OracleResult> {
    assert!(
        input.events.len() <= 12,
        "temporal oracle is limited to at most twelve events"
    );
    assert!(
        input.max_boards <= 4,
        "temporal oracle is limited to at most four passenger boardings"
    );

    let mut candidates = Vec::new();
    for entry in &input.entry_walks {
        for (event_index, event) in input.events.iter().enumerate() {
            if input.max_boards == 0
                || event.in_seat
                || event.from != entry.stop
                || !is_active(&input, event)
                || event.depart > event.arrive
            {
                continue;
            }
            let Some(origin_departure) = event.depart.checked_sub(entry.walk_secs) else {
                continue;
            };
            let Some(total_walk_secs) = entry.walk_secs.checked_add(event.walk_secs) else {
                continue;
            };
            let mut witness = Vec::with_capacity(input.max_boards);
            witness.push(event_index);
            enumerate_from(
                &input,
                &mut witness,
                origin_departure,
                1,
                0,
                total_walk_secs,
                &mut candidates,
            );
        }
    }

    pareto_reduce(candidates, objectives)
}

fn enumerate_from(
    input: &OracleInput,
    witness: &mut Vec<usize>,
    origin_departure: u32,
    boardings: usize,
    actual_transfers: u32,
    total_walk_secs: u32,
    candidates: &mut Vec<OracleResult>,
) {
    let current_index = *witness
        .last()
        .expect("enumeration always has a start event");
    let current = input.events[current_index];

    for exit in &input.exit_walks {
        if current.to != exit.stop {
            continue;
        }
        let Some(destination_arrival) = current.arrive.checked_add(exit.walk_secs) else {
            continue;
        };
        let Some(total_walk_secs) = total_walk_secs.checked_add(exit.walk_secs) else {
            continue;
        };
        candidates.push(OracleResult {
            origin_departure,
            destination_arrival,
            actual_transfers,
            total_walk_secs,
            witness: witness.clone(),
        });
    }

    for (next_index, next) in input.events.iter().enumerate() {
        if witness.contains(&next_index) || !is_active(input, next) || next.depart > next.arrive {
            continue;
        }

        if current.trip == next.trip {
            // A same-trip continuation is valid at the exact stop occurrence;
            // it neither walks nor creates a passenger transfer/boarding.
            if next.in_seat || current.to != next.from || current.arrive > next.depart {
                continue;
            }
            let Some(next_walk) = total_walk_secs.checked_add(next.walk_secs) else {
                continue;
            };
            witness.push(next_index);
            enumerate_from(
                input,
                witness,
                origin_departure,
                boardings,
                actual_transfers,
                next_walk,
                candidates,
            );
            witness.pop();
            continue;
        }

        for transfer in &input.transfers {
            if !transfer_matches(transfer, current, next)
                || transfer.in_seat != next.in_seat
                || (transfer.in_seat && transfer.walk_secs != 0)
            {
                continue;
            }
            let Some(ready_at) = current.arrive.checked_add(transfer.walk_secs) else {
                continue;
            };
            if ready_at > next.depart {
                continue;
            }

            let new_boardings = boardings + usize::from(!transfer.in_seat);
            if new_boardings > input.max_boards {
                continue;
            }
            let Some(next_walk) = total_walk_secs
                .checked_add(transfer.walk_secs)
                .and_then(|walk| walk.checked_add(next.walk_secs))
            else {
                continue;
            };
            witness.push(next_index);
            enumerate_from(
                input,
                witness,
                origin_departure,
                new_boardings,
                actual_transfers + u32::from(!transfer.in_seat),
                next_walk,
                candidates,
            );
            witness.pop();
        }
    }
}

fn is_active(input: &OracleInput, event: &Event) -> bool {
    input.allowed_services.contains(&event.service)
}

fn transfer_matches(transfer: &Transfer, current: Event, next: &Event) -> bool {
    transfer.from == current.to
        && transfer.to == next.from
        && transfer.from_trip.is_none_or(|trip| trip == current.trip)
        && transfer.to_trip.is_none_or(|trip| trip == next.trip)
}

fn pareto_reduce(candidates: Vec<OracleResult>, objectives: Objectives) -> Vec<OracleResult> {
    let mut profile: Vec<OracleResult> = Vec::new();
    for candidate in candidates {
        if let Some(equal_index) = profile
            .iter()
            .position(|existing| same_objectives(existing, &candidate, objectives))
        {
            if canonical_witness_preferred(&candidate, &profile[equal_index], objectives) {
                profile[equal_index] = candidate;
            }
            continue;
        }
        if profile
            .iter()
            .any(|existing| dominates(existing, &candidate, objectives))
        {
            continue;
        }
        profile.retain(|existing| !dominates(&candidate, existing, objectives));
        profile.push(candidate);
    }
    profile.sort_by(result_order);
    profile
}

fn dominates(left: &OracleResult, right: &OracleResult, objectives: Objectives) -> bool {
    let at_least_as_good = left.origin_departure >= right.origin_departure
        && left.destination_arrival <= right.destination_arrival
        && left.actual_transfers <= right.actual_transfers
        && (objectives == Objectives::R3 || left.total_walk_secs <= right.total_walk_secs);
    let strictly_better = left.origin_departure > right.origin_departure
        || left.destination_arrival < right.destination_arrival
        || left.actual_transfers < right.actual_transfers
        || (objectives == Objectives::M4 && left.total_walk_secs < right.total_walk_secs);
    at_least_as_good && strictly_better
}

fn same_objectives(left: &OracleResult, right: &OracleResult, objectives: Objectives) -> bool {
    left.origin_departure == right.origin_departure
        && left.destination_arrival == right.destination_arrival
        && left.actual_transfers == right.actual_transfers
        && (objectives == Objectives::R3 || left.total_walk_secs == right.total_walk_secs)
}

fn canonical_witness_preferred(
    candidate: &OracleResult,
    existing: &OracleResult,
    objectives: Objectives,
) -> bool {
    objectives == Objectives::R3
        && (candidate.total_walk_secs, &candidate.witness)
            < (existing.total_walk_secs, &existing.witness)
}

fn result_order(left: &OracleResult, right: &OracleResult) -> Ordering {
    right
        .origin_departure
        .cmp(&left.origin_departure)
        .then_with(|| left.destination_arrival.cmp(&right.destination_arrival))
        .then_with(|| left.actual_transfers.cmp(&right.actual_transfers))
        .then_with(|| left.total_walk_secs.cmp(&right.total_walk_secs))
        .then_with(|| left.witness.cmp(&right.witness))
}
