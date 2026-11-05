// crates/pt-serve/tests/route_rt.rs
//
// Integration tests for GET /api/<city>/rt/<routeId>. The unit tests in
// `app::route_rt` cover the id guard; everything interesting here needs a REAL
// generation, because the whole route is a join between the PTB's trip->route
// table and the live RT snapshot. Mirrors `tests/rt_tile.rs`'s harness.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::app::response::Resp;
use pt_serve::app::route_rt::route_rt;
use pt_serve::rt::{RtSnapshot, TripUpdate};
use pt_serve::{Generation, Metrics, ServerCtx};
use pt_shared::clock::MockClock;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

const ANCHOR: u64 = 1779494400;

fn ctx() -> (TempDir, Arc<ServerCtx>) {
    let (dir, _config, _clock) = common::isolated_config();
    let data_root = dir.path().to_path_buf();
    let created_at = publisher::rfc3339_format(ANCHOR);
    let gen_id =
        publisher::publish_generation(&data_root, "vilnius", &common::tiny_ptb_path(), &created_at);

    let manifest_text = std::fs::read_to_string(publisher::manifest_path_for(&data_root, &gen_id))
        .expect("read manifest");
    let manifest: pt_shared::manifest::GenerationManifest =
        serde_json::from_str(&manifest_text).expect("parse manifest");
    let metrics = Arc::new(Metrics::default());
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR));
    let gen: Generation = pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(&data_root, &gen_id),
        transfers_path: None,
        expected_city: "vilnius",
        clock: &clock,
        is_startup: true,
        epoch: 0,
        metrics: Some(Arc::clone(&metrics)),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
    .expect("build generation");

    let cfg = common::default_test_config(data_root.clone());
    (dir, ServerCtx::new(gen, cfg, metrics))
}

fn clock() -> MockClock {
    MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR))
}

fn body_of(resp: &Resp) -> Vec<u8> {
    match resp {
        Resp::CachedBytes { body, .. } => match body {
            pt_serve::app::response::ByteBody::Raw(bytes) => bytes.to_vec(),
            _ => panic!("expected a raw body"),
        },
        other => panic!(
            "expected CachedBytes, got a different variant: {other:?}",
            other = std::mem::discriminant(other)
        ),
    }
}

/// Minimal RouteUpdate decoder — deliberately independent of the encoder's own
/// test helper so these assertions do not lean on the code under test.
fn decode(buf: &[u8]) -> (String, Vec<(String, i32, bool)>, i64) {
    use pt_serve::rt::protobuf::Reader;
    let mut reader = Reader::new(buf);
    let (mut route_id, mut trips, mut generated_at) = (String::new(), Vec::new(), 0i64);
    while let Some((field, wire)) = reader.read_tag() {
        match (field, wire) {
            (1, 2) => {
                route_id =
                    String::from_utf8(reader.read_length_delimited().unwrap().to_vec()).unwrap()
            }
            (2, 2) => {
                let mut sub = Reader::new(reader.read_length_delimited().unwrap());
                let (mut id, mut delay, mut cancelled) = (String::new(), 0i32, false);
                while let Some((f, w)) = sub.read_tag() {
                    match (f, w) {
                        (1, 2) => {
                            id = String::from_utf8(sub.read_length_delimited().unwrap().to_vec())
                                .unwrap()
                        }
                        (2, 0) => {
                            let raw = sub.read_varint().unwrap();
                            delay = ((raw >> 1) as i64 ^ -((raw & 1) as i64)) as i32;
                        }
                        (3, 0) => cancelled = sub.read_varint().unwrap() != 0,
                        (_, w) => sub.skip_field(w).unwrap(),
                    }
                }
                trips.push((id, delay, cancelled));
            }
            (3, 0) => generated_at = reader.read_varint().unwrap() as i64,
            (_, w) => reader.skip_field(w).unwrap(),
        }
    }
    (route_id, trips, generated_at)
}

/// Every (route_id, trip_id) pair in the fixture, read from the generation
/// itself rather than hardcoded — the fixture's ids are an implementation
/// detail of tiny.ptb and must not be duplicated here.
fn fixture_pairs(ctx: &ServerCtx) -> Vec<(String, String)> {
    let gen = ctx.current_generation();
    (0..gen.reader.num_trips())
        .filter_map(|i| {
            let route_idx = gen.reader.trip_route_idx(i).ok()? as usize;
            Some((
                gen.reader.route_id(route_idx).ok()?.to_string(),
                gen.reader.trip_id(i).ok()?.to_string(),
            ))
        })
        .collect()
}

fn publish(ctx: &ServerCtx, entries: &[(&str, i32, bool)]) {
    let merged: HashMap<String, TripUpdate> = entries
        .iter()
        .map(|(id, delay, cancelled)| {
            (
                (*id).to_string(),
                TripUpdate {
                    delay_seconds: *delay,
                    cancelled: *cancelled,
                    deleted: false,
                    time_prediction: None,
                },
            )
        })
        .collect();
    ctx.rt.publish(RtSnapshot::from_merged(merged, vec![]));
}

#[test]
fn returns_only_the_trips_belonging_to_the_requested_route() {
    let (_dir, ctx) = ctx();
    let pairs = fixture_pairs(&ctx);
    // The fixture must actually have two routes for this test to mean
    // anything — otherwise "filtered correctly" and "returned everything"
    // are indistinguishable.
    let mut routes: Vec<&String> = pairs.iter().map(|(r, _)| r).collect();
    routes.dedup();
    let route_a = pairs[0].0.clone();
    let other: Vec<&(String, String)> = pairs.iter().filter(|(r, _)| *r != route_a).collect();
    assert!(
        !other.is_empty(),
        "fixture has only one route; this test cannot distinguish filtering from passthrough"
    );

    // Publish RT for EVERY trip in the feed, on both routes.
    let all: Vec<(&str, i32, bool)> = pairs.iter().map(|(_, t)| (t.as_str(), 60, false)).collect();
    publish(&ctx, &all);

    let resp = route_rt(&route_a, &ctx.current_generation(), &ctx, &clock());
    let (route_id, trips, _) = decode(&body_of(&resp));
    assert_eq!(route_id, route_a);

    let expected: Vec<String> = pairs
        .iter()
        .filter(|(r, _)| *r == route_a)
        .map(|(_, t)| t.clone())
        .collect();
    let returned: Vec<String> = trips.iter().map(|(t, _, _)| t.clone()).collect();
    assert_eq!(returned, expected);
    // And nothing from the other route leaked in.
    for (_, trip_id) in &other {
        assert!(
            !returned.contains(trip_id),
            "{trip_id} belongs to another route"
        );
    }
}

#[test]
fn a_trip_with_no_rt_entry_is_omitted_rather_than_zero_filled() {
    // Node returns entries only for trips the feed actually mentions. Emitting
    // a zero-delay entry for every scheduled trip would look identical to "all
    // vehicles exactly on time" on the client.
    let (_dir, ctx) = ctx();
    let pairs = fixture_pairs(&ctx);
    let route_a = pairs[0].0.clone();
    let on_route: Vec<&(String, String)> = pairs.iter().filter(|(r, _)| *r == route_a).collect();
    assert!(
        on_route.len() >= 2,
        "need at least two trips on one route to test partial coverage"
    );

    publish(&ctx, &[(on_route[0].1.as_str(), 120, false)]);
    let resp = route_rt(&route_a, &ctx.current_generation(), &ctx, &clock());
    let (_, trips, _) = decode(&body_of(&resp));
    assert_eq!(trips.len(), 1);
    assert_eq!(trips[0], (on_route[0].1.clone(), 120, false));
}

#[test]
fn delay_and_cancellation_survive_the_round_trip() {
    let (_dir, ctx) = ctx();
    let pairs = fixture_pairs(&ctx);
    let route_a = pairs[0].0.clone();
    let on_route: Vec<&(String, String)> = pairs.iter().filter(|(r, _)| *r == route_a).collect();

    // A negative delay is a vehicle running EARLY — the case the sint32
    // zigzag mapping exists for, exercised end to end here rather than only
    // in the encoder's own tests.
    publish(&ctx, &[(on_route[0].1.as_str(), -90, true)]);
    let resp = route_rt(&route_a, &ctx.current_generation(), &ctx, &clock());
    let (_, trips, _) = decode(&body_of(&resp));
    assert_eq!(trips[0], (on_route[0].1.clone(), -90, true));
}

/// Field 4 of each TripUpdate: `deleted`, present only when true.
fn deleted_flags(buf: &[u8]) -> Vec<(String, bool)> {
    use pt_serve::rt::protobuf::Reader;
    let mut r = Reader::new(buf);
    let mut out = Vec::new();
    while let Some((f, w)) = r.read_tag() {
        if (f, w) != (2, 2) {
            r.skip_field(w).unwrap();
            continue;
        }
        let mut sub = Reader::new(r.read_length_delimited().unwrap());
        let (mut id, mut deleted) = (String::new(), false);
        while let Some((f, w)) = sub.read_tag() {
            match (f, w) {
                (1, 2) => {
                    id = String::from_utf8(sub.read_length_delimited().unwrap().to_vec()).unwrap()
                }
                (4, 0) => deleted = sub.read_varint().unwrap() != 0,
                (_, w) => sub.skip_field(w).unwrap(),
            }
        }
        out.push((id, deleted));
    }
    out
}

#[test]
fn a_deleted_trip_reaches_the_wire_marked_deleted() {
    let (_dir, ctx) = ctx();
    let pairs = fixture_pairs(&ctx);
    let route_a = pairs[0].0.clone();
    let trip = pairs.iter().find(|(r, _)| *r == route_a).unwrap().1.clone();
    let mut merged = HashMap::new();
    merged.insert(
        trip.clone(),
        TripUpdate {
            delay_seconds: 0,
            cancelled: false,
            deleted: true,
            time_prediction: None,
        },
    );
    ctx.rt.publish(RtSnapshot::from_merged(merged, vec![]));
    let resp = route_rt(&route_a, &ctx.current_generation(), &ctx, &clock());
    assert_eq!(deleted_flags(&body_of(&resp)), vec![(trip, true)]);
}

#[test]
fn an_empty_snapshot_returns_a_well_formed_empty_update() {
    // The paris/oslo case: no RT feed at all. Must be a 200 with an empty trip
    // list carrying the requested routeId, NOT a 404 — same as Node.
    let (_dir, ctx) = ctx();
    let pairs = fixture_pairs(&ctx);
    let resp = route_rt(&pairs[0].0, &ctx.current_generation(), &ctx, &clock());
    let (route_id, trips, generated_at) = decode(&body_of(&resp));
    assert_eq!(route_id, pairs[0].0);
    assert!(trips.is_empty());
    assert_eq!(generated_at, ANCHOR as i64 * 1000);
}

#[test]
fn an_unknown_route_id_is_an_empty_200_not_a_404() {
    // Node's store lookup simply finds nothing for an unknown route, so it
    // answers 200 with no trips. Diverging to a 404 here would make the
    // client's rtPoller log a failure for every poll of a route that has
    // merely been dropped from a newer feed.
    let (_dir, ctx) = ctx();
    let pairs = fixture_pairs(&ctx);
    publish(&ctx, &[(pairs[0].1.as_str(), 60, false)]);

    let resp = route_rt("no-such-route", &ctx.current_generation(), &ctx, &clock());
    match &resp {
        Resp::CachedBytes { status, .. } => assert_eq!(*status, 200),
        _ => panic!("expected a 200 protobuf response"),
    }
    let (route_id, trips, _) = decode(&body_of(&resp));
    assert_eq!(route_id, "no-such-route");
    assert!(trips.is_empty());
}

#[test]
fn a_date_scoped_rt_key_is_found_through_the_bare_trip_id() {
    // GTFS-RT feeds may set trip.start_date, in which case the snapshot key is
    // "{tripId}|{startDate}" and the bare id is absent from `merged`. The
    // lookup must go through `by_trip`, which indexes both spellings — the
    // stops.lt feed sets no start_date, so this path is NOT covered by
    // anything running against real vilnius bytes.
    let (_dir, ctx) = ctx();
    let pairs = fixture_pairs(&ctx);
    let route_a = pairs[0].0.clone();
    let trip = pairs
        .iter()
        .find(|(r, _)| *r == route_a)
        .map(|(_, t)| t.clone())
        .unwrap();

    let mut merged = HashMap::new();
    merged.insert(
        format!("{trip}|20260811"),
        TripUpdate {
            delay_seconds: 300,
            cancelled: false,
            deleted: false,
            time_prediction: None,
        },
    );
    ctx.rt.publish(RtSnapshot::from_merged(merged, vec![]));

    let resp = route_rt(&route_a, &ctx.current_generation(), &ctx, &clock());
    let (_, trips, _) = decode(&body_of(&resp));
    assert_eq!(trips, vec![(trip, 300, false)]);
}

#[test]
fn the_response_carries_the_protobuf_content_type_and_the_shared_cache_ttl() {
    let (_dir, ctx) = ctx();
    let pairs = fixture_pairs(&ctx);
    let resp = route_rt(&pairs[0].0, &ctx.current_generation(), &ctx, &clock());
    match resp {
        Resp::CachedBytes {
            content_type,
            cache_control,
            etag,
            gzipped,
            ..
        } => {
            assert_eq!(content_type, "application/x-protobuf");
            // RT_CACHE_MAX_AGE_S = 5 in packages/shared/src/constants/defaults.ts.
            assert_eq!(cache_control, "public, max-age=5, s-maxage=5");
            // No ETag: the body embeds `generatedAt`, so it changes on every
            // request and an ETag could never match.
            assert!(etag.is_none());
            assert!(!gzipped);
        }
        _ => panic!("expected CachedBytes"),
    }
}

#[test]
fn an_invalid_route_id_is_a_400_before_the_generation_is_touched() {
    let (_dir, ctx) = ctx();
    match route_rt("a/../b", &ctx.current_generation(), &ctx, &clock()) {
        Resp::Json { status, body } => {
            assert_eq!(status, 400);
            assert!(body.contains("INVALID_ROUTE_ID"), "{body}");
        }
        _ => panic!("expected a 400 JSON error"),
    }
}
