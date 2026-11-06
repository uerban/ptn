//! `GET /api/<city>/rt/<routeId>` — live RT for every trip on one route,
//! as the `RouteUpdate` protobuf.
//!
//! Node parity: `packages/backend/src/routes/rt.ts`. The client polls it from
//! `services/rtPoller.ts` while navigating — one request per subscribed route
//! per interval — and decodes with `decodeRouteUpdate`.
//!
//! HOW THE ROUTE→TRIPS RESOLUTION WORKS, AND WHY IT IS A SCAN.
//!
//! Node in producer mode reads a prebuilt `trip-route.json` artifact to group
//! RT by route. pt-serve needs no artifact: the PTB reader already carries
//! `trip_route_idx`, so the grouping is derivable from the generation that is
//! already mmapped. The cost is one `O(num_trips)` pass over integer accessors
//! per request.
//!
//! The obvious alternative — precomputing a route→trips map — was rejected
//! twice over. Building it at generation load costs resident memory
//! proportional to the feed and would pull a guardrail-8 re-baseline into this
//! PR for a route nothing polls in steady state. Building it into `RtSnapshot`
//! at publish time is worse than that: the snapshot is published by the poll
//! thread, which holds no generation handle, and a generation can swap between
//! poll cycles — so any route grouping baked into a snapshot could go stale
//! against the generation actually serving the request. Resolving per request
//! against `&Generation` cannot drift by construction.
//!
//! `pt_core::Index` does already group trips by pattern-route with a
//! `reader_route_idx` back-pointer, which would make this `O(trips on route)`.
//! Its `routes` field is `pub(crate)` behind an explicit encapsulation note
//! ("external consumers never reach into the structural tables"), so reaching
//! through it would mean widening pt-core's public surface. Not worth it at
//! this route's traffic; revisit together if that changes.
//!
//! THE EARLY EXIT IS THE PART THAT MATTERS. A city with no RT feed — paris and
//! oslo today — has an empty snapshot, and returns before touching the reader
//! at all. So the scan is only ever paid by a city that actually has live data.

use crate::app::response::{ByteBody, Resp};
use crate::bundle::Generation;
use crate::ops::ServerCtx;
use crate::rt::encode::{encode_route_update, EncodedTrip};
use pt_shared::clock::Clock;
use std::sync::Arc;

/// `RT_CACHE_MAX_AGE_S` in `packages/shared/src/constants/defaults.ts`.
/// Duplicated across the language boundary; the value is short enough that a
/// drift is a caching nuisance rather than a correctness bug, but keep them
/// equal so the two planes cache identically during the cutover.
pub(super) const RT_CACHE_CONTROL: &str = "public, max-age=5, s-maxage=5";

/// Node's guard: non-empty, at most 100 chars, `/^[\w:._-]+$/`. `\w` in
/// JavaScript without the `u` flag is exactly `[A-Za-z0-9_]`, so this is an
/// ASCII-only class — a route id with any non-ASCII character is rejected on
/// BOTH planes, which is worth knowing before someone "fixes" it for a feed
/// that uses one.
fn route_id_valid(route_id: &str) -> bool {
    !route_id.is_empty()
        && route_id.len() <= 100
        && route_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-'))
}

const INVALID_ROUTE_ID: &str =
    r#"{"error":{"code":"INVALID_ROUTE_ID","message":"Invalid route ID format"}}"#;

fn now_ms(clock: &dyn Clock) -> i64 {
    clock
        .now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn protobuf_response(body: Vec<u8>) -> Resp {
    Resp::CachedBytes {
        status: 200,
        body: ByteBody::Raw(Arc::from(body.into_boxed_slice())),
        content_type: "application/x-protobuf",
        cache_control: RT_CACHE_CONTROL,
        etag: None,
        gzipped: false,
    }
}

/// Collect the RT updates for every trip on `route_id`, in reader trip order.
///
/// Reader trip order is deterministic for a given generation, which is what
/// makes the response byte-stable across repeat polls of an unchanged
/// snapshot. Node's order comes from its own store iteration and is NOT the
/// same; the client keys by `tripId` and never relies on order, so this is a
/// documented divergence rather than a parity break.
fn trips_for_route(
    gen: &Generation,
    snapshot: &crate::rt::RtSnapshot,
    route_id: &str,
) -> Vec<EncodedTrip> {
    let Some(route_idx) = (0..gen.reader.num_routes()).find(|i| {
        gen.reader
            .route_id(*i)
            .map(|id| id == route_id)
            .unwrap_or(false)
    }) else {
        // Unknown route id. Node answers 200 with an empty trip list here too
        // (its store lookup simply finds nothing), so this is NOT a 404.
        return Vec::new();
    };
    let route_idx = route_idx as u32;

    let mut out = Vec::new();
    for trip_i in 0..gen.reader.num_trips() {
        // A malformed record is skipped rather than failing the request: one
        // unreadable trip must not blank the live overlay for a whole route.
        if gen.reader.trip_route_idx(trip_i).ok() != Some(route_idx) {
            continue;
        }
        let Ok(trip_id) = gen.reader.trip_id(trip_i) else {
            continue;
        };
        // `by_trip` maps a bare tripId to every key `merged` holds for it —
        // itself plus any `"{tripId}|{startDate}"` variant. Take the first
        // present, matching Node's `getRtEntriesForTrip` preference order.
        let Some(keys) = snapshot.by_trip.get(trip_id) else {
            continue;
        };
        let Some(update) = keys.iter().find_map(|k| snapshot.merged.get(k)) else {
            continue;
        };
        out.push(EncodedTrip {
            trip_id: trip_id.to_string(),
            delay_seconds: update.delay_seconds,
            cancelled: update.cancelled,
            deleted: update.deleted,
        });
    }
    out
}

pub fn route_rt(route_id: &str, gen: &Generation, ctx: &ServerCtx, clock: &dyn Clock) -> Resp {
    if !route_id_valid(route_id) {
        return Resp::Json {
            status: 400,
            body: INVALID_ROUTE_ID.to_string(),
        };
    }

    let snapshot = ctx.rt.load();
    // The early exit. An RT-less city never touches the reader, so the scan
    // below is only ever paid where there is live data to find.
    if snapshot.merged.is_empty() {
        return protobuf_response(encode_route_update(route_id, &[], now_ms(clock)));
    }

    let trips = trips_for_route(gen, &snapshot, route_id);
    protobuf_response(encode_route_update(route_id, &trips, now_ms(clock)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_id_validation_matches_nodes_regex() {
        for ok in ["r1", "ROUTE_7", "a:b.c-d", "_", "9"] {
            assert!(route_id_valid(ok), "{ok} should be accepted");
        }
        for bad in ["", "a/b", "a b", "a+b", "a\nb", "café"] {
            assert!(!route_id_valid(bad), "{bad:?} should be rejected");
        }
        assert!(route_id_valid(&"a".repeat(100)));
        assert!(!route_id_valid(&"a".repeat(101)));
    }

    #[test]
    fn a_path_traversal_attempt_is_rejected_before_any_lookup() {
        // The route id lands in no filesystem path, but it does land in the
        // response body, so keep the reject list honest.
        assert!(!route_id_valid("../../etc/passwd"));
        assert!(!route_id_valid("a%2fb"));
    }
}
