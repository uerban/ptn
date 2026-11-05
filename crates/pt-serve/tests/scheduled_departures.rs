//! `/scheduled-departures-for-stop` handler tests.
//!
//! These drive the transport-agnostic handler
//! [`pt_serve::app::scheduled_departures::scheduled_departures`] directly over a
//! production-built [`pt_serve::Generation`] (so `city_tz` is resolved and the
//! DPIX is mmapped + validated exactly as production does). Each test publishes
//! a bespoke v5 feed + DPIX via the extended publisher infra
//! (`common::publisher::{build_feed_ptb, build_departures_idx_csr}`).
//!
//! Time domain: `feed_start_date = 20260501`, tz `Europe/Vilnius` (EEST in
//! May 2026, +03:00). Reference unix instants were computed independently with
//! chrono-tz; see the inline constants.

use std::io::{BufRead as _, Read as _};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

#[path = "common/mod.rs"]
mod common;

use common::publisher::{self, BuiltFeed, RouteSpec, SidecarArtifacts, TripSpec};
use pt_serve::app::departures_for_stop::departures_for_stop;
use pt_serve::app::response::Resp;
use pt_serve::app::scheduled_departures::scheduled_departures;
use pt_serve::ops::ServerCtx;
use pt_serve::{Generation, Metrics};
use pt_shared::clock::{Clock, MockClock};
use pt_shared::manifest::GenerationManifest;

const ANCHOR_UNIX: u64 = 1779494400;
const FEED_START: u32 = 20260501;
/// Static UTC offset for Europe/Vilnius at FEED_START midnight UTC (EEST,
/// +03:00). pt-serve's load-time tz cross-check (`TzOffsetMismatch`) compares
/// the PTB header `[28..32]` field against chrono-tz; this is the value it
/// expects, so every fixture feed must carry it.
const VILNIUS_TZ_OFFSET: i32 = 10800;

// Reference unix instants for service date 2026-05-05 in Europe/Vilnius (+03:00),
// computed independently with chrono-tz.
const DEP_0800: i64 = 1777957200; // 08:00:00 local
const DEP_0805: i64 = 1777957500; // 08:05:00 local
const DEP_0810: i64 = 1777957800; // 08:10:00 local
const DEP_0830: i64 = 1777959000; // 08:30:00 local
const DEP_0900: i64 = 1777960800; // 09:00:00 local
const OVERNIGHT_0130: i64 = 1777933800; // service date 2026-05-04 @ 25:30:00 → 0505 01:30 local
const LOCAL_0100: i64 = 1777932000; // 2026-05-05 01:00:00 local
const LOCAL_0200: i64 = 1777935600; // 2026-05-05 02:00:00 local

fn anchored_clock() -> Arc<MockClock> {
    Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR_UNIX),
    ))
}

/// All-active 90-day service bitmask (every day in the window runs).
fn all_active_mask() -> [u8; 12] {
    [0xFFu8; 12]
}

/// Publish a custom feed + (optional) DPIX into a data_root, then build the
/// production `Generation` (tz resolved from `--city-tz-iana-default`). Returns
/// `(TempDir, Generation, ctx, generation_id)`.
struct Harness {
    _data_root: tempfile::TempDir,
    gen: Generation,
    ctx: Arc<ServerCtx>,
    gen_id: String,
}

/// Publish the feed + (optional) DPIX and build the production `Generation`.
/// When `dpix` is `None`, no DPIX file is written → the Generation's
/// `departures_idx_mmap` is `None` (the 503 path).
fn build_harness(feed: &BuiltFeed, dpix: Option<Vec<u8>>) -> Harness {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    // Write the custom bundle bytes through a temp source path so the publisher
    // (which reads a source ptb) lays them into the gen dir.
    let src = data_root.path().join("source.ptb");
    std::fs::write(&src, &feed.bytes).expect("write source feed");

    let artifacts = SidecarArtifacts {
        departures_idx: dpix,
        ..Default::default()
    };
    let gen_id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &src,
        &created_at,
        &artifacts,
    );

    let gen = build_from_published(data_root.path(), "vilnius", &gen_id, clock.as_ref())
        .expect("generation builds");

    // A ServerCtx so the handler can bump the truncation counter.
    let config = common::default_test_config(data_root.path().to_path_buf());
    let metrics = Metrics::new();
    // Build a SECOND Generation for the ctx (ServerCtx::new takes ownership);
    // the handler reads `gen` (the one we return) for its data, but writes
    // metrics through `ctx.metrics`. To keep a single source of truth, build the
    // ctx around a throwaway from_paths gen and expose its metrics.
    let ctx_gen =
        Generation::from_paths(&src, None, "vilnius".to_string(), pt_core::PatternMode::Off)
            .expect("ctx generation");
    let ctx = ServerCtx::new(ctx_gen, config, Arc::clone(&metrics));

    Harness {
        _data_root: data_root,
        gen,
        ctx,
        gen_id,
    }
}

fn build_from_published(
    data_root: &std::path::Path,
    city: &str,
    id: &str,
    clock: &dyn Clock,
) -> Result<Generation, pt_shared::validate::errors::ValidationError> {
    use pt_serve::bundle::{build_generation, BuildInputs};
    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(data_root, id)).unwrap();
    let manifest: GenerationManifest = serde_json::from_str(&manifest_text).unwrap();
    build_generation(BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(data_root, id),
        transfers_path: None,
        expected_city: city,
        clock,
        is_startup: true,
        epoch: 0,
        metrics: Some(Metrics::new()),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
}

/// Extract `(status, parsed JSON)` from a `Resp::Json`.
fn json_resp(resp: Resp) -> (u16, serde_json::Value) {
    match resp {
        Resp::Json { status, body } => {
            let v: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|e| panic!("body not JSON: {e}; {body}"));
            (status, v)
        }
        _ => panic!("expected Resp::Json"),
    }
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/// A simple feed: 3 stops (S1,S2,S3), 1 colored route + 1 color-less route,
/// trips departing S1. Used by the happy-path + several negative cases.
///
/// Trips:
///   T1: route 0 (colored, BUS), service 0, dir 0, wheelchair 1 — S1@08:00 → S2@08:10
///   T2: route 1 (color-less, TRAM), service 0, dir 0xFF (absent), wheelchair 0 — S1@08:30 → S2@08:40
fn happy_feed() -> BuiltFeed {
    publisher::build_feed_ptb(
        &["S1", "S2", "S3"],
        &[
            RouteSpec {
                route_id: "R_BUS",
                short_name: "10",
                route_type: 3, // BUS
                color: "FF0000",
                text_color: "FFFFFF",
            },
            RouteSpec {
                route_id: "R_TRAM",
                short_name: "T1",
                route_type: 0, // TRAM
                color: "",     // color-less route row (sentinel)
                text_color: "",
            },
        ],
        &[
            TripSpec {
                trip_id: "T1",
                headsign: "Downtown",
                route_idx: 0,
                service_idx: 0,
                direction_id: 0,
                wheelchair: 1,
                // S1 @ 08:00 (28800), arr_diff to next leg unused for this stop;
                // arr_diff = 600 (10 min) so arr = 08:10.
                stop_times: vec![(1, 0, 28800, 600), (2, 1, 29400, 0)],
            },
            TripSpec {
                trip_id: "T2",
                headsign: "Uptown",
                route_idx: 1,
                service_idx: 0,
                direction_id: 0xFF, // absent → directionId null
                wheelchair: 0,
                stop_times: vec![(1, 0, 30600, 300), (2, 1, 30900, 0)],
            },
        ],
        &[all_active_mask()],
        FEED_START,
        VILNIUS_TZ_OFFSET,
    )
}

/// DPIX for `happy_feed`: stop S1 (idx 0) has T1's row 0 and T2's row 0;
/// S2 (idx 1) has T1 row 1 and T2 row 1; S3 (idx 2) has none.
fn happy_dpix(feed: &BuiltFeed) -> Vec<u8> {
    let s1 = vec![
        (0u32, feed.abs_rows[0][0]), // T1 @ S1
        (1u32, feed.abs_rows[1][0]), // T2 @ S1
    ];
    let s2 = vec![(0u32, feed.abs_rows[0][1]), (1u32, feed.abs_rows[1][1])];
    let s3 = vec![];
    publisher::build_departures_idx_csr(&feed.bytes, &[s1, s2, s3])
}

// ---------------------------------------------------------------------------
// (a) 200 happy path with correct field values
// ---------------------------------------------------------------------------

#[test]
fn happy_path_200_field_values() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));

    // Window covers both T1 (08:00) and T2 (08:30) departing S1.
    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let resp = scheduled_departures(&q, &h.gen, &h.ctx, None);
    let (status, v) = json_resp(resp);
    assert_eq!(status, 200, "happy path must be 200; {v}");

    assert_eq!(v["contractVersion"], 1);
    assert_eq!(v["stopId"], "S1");
    assert_eq!(v["windowStart"], DEP_0800);
    assert_eq!(v["windowEnd"], DEP_0900);
    assert_eq!(v["generationId"], h.gen_id);
    assert_eq!(v["cityTzIana"], "Europe/Vilnius");
    assert_eq!(v["truncated"], false);
    assert_eq!(v["windowOutsideServiceRange"], false);

    let deps = v["departures"].as_array().expect("departures array");
    assert_eq!(deps.len(), 2, "S1 has T1@08:00 and T2@08:30 in window; {v}");

    // Sorted ascending by dep: T1 first.
    let d0 = &deps[0];
    assert_eq!(d0["tripId"], "T1");
    assert_eq!(d0["routeId"], "R_BUS");
    assert_eq!(d0["routeShortName"], "10");
    assert_eq!(d0["routeColor"], "FF0000");
    assert_eq!(d0["routeTextColor"], "FFFFFF");
    assert_eq!(d0["mode"], "BUS");
    assert!(d0["subMode"].is_null(), "subMode frozen null");
    assert_eq!(d0["serviceId"], "svc:0");
    assert_eq!(d0["headsign"], "Downtown");
    assert_eq!(d0["directionId"], 0);
    assert_eq!(d0["stopSequence"], 1);
    assert_eq!(d0["scheduledDepartureSecs"], DEP_0800);
    assert_eq!(d0["scheduledArrivalSecs"], DEP_0810); // 28800+600=29400 → 08:10
    assert_eq!(d0["wheelchairAccessible"], 1);

    // T2: color-less route, directionId null, TRAM.
    let d1 = &deps[1];
    assert_eq!(d1["tripId"], "T2");
    assert_eq!(d1["routeId"], "R_TRAM");
    assert_eq!(d1["routeColor"], "", "color-less route → empty sentinel");
    assert_eq!(d1["routeTextColor"], "");
    assert_eq!(d1["mode"], "TRAM");
    assert!(d1["directionId"].is_null(), "0xFF direction → null");
    assert_eq!(d1["scheduledDepartureSecs"], DEP_0830);
    assert_eq!(d1["wheelchairAccessible"], 0);
}

// ---------------------------------------------------------------------------
// (b) 404 unknown stopId
// ---------------------------------------------------------------------------

#[test]
fn unknown_stop_404() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let q = format!("stopId=NOPE&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 404);
    assert_eq!(v["error"], "unknown_stop");
}

// ---------------------------------------------------------------------------
// (c) 400 missing stopId
// ---------------------------------------------------------------------------

#[test]
fn missing_stop_id_400() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let q = format!("from={}&to={}", DEP_0800, DEP_0900);
    let (status, _) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 400, "missing stopId must be 400");
    // Also: missing `from`.
    let (status2, _) = json_resp(scheduled_departures("stopId=S1", &h.gen, &h.ctx, None));
    assert_eq!(status2, 400, "missing from must be 400");
}

// ---------------------------------------------------------------------------
// (d) 400 window > 6h
// ---------------------------------------------------------------------------

#[test]
fn window_over_6h_400() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let from = DEP_0800;
    let to = from + 6 * 3600 + 1; // one second over 6h
    let q = format!("stopId=S1&from={from}&to={to}");
    let (status, _) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 400, "window > 6h must be 400");
    // Exactly 6h is allowed.
    let q_ok = format!("stopId=S1&from={from}&to={}", from + 6 * 3600);
    let (status_ok, _) = json_resp(scheduled_departures(&q_ok, &h.gen, &h.ctx, None));
    assert_eq!(status_ok, 200, "exactly 6h must be allowed");
}

// ---------------------------------------------------------------------------
// (e) 503 when departures_idx_mmap is None
// ---------------------------------------------------------------------------

#[test]
fn sidecar_unavailable_503() {
    let feed = happy_feed();
    let h = build_harness(&feed, None); // no DPIX
    assert!(h.gen.departures_idx_mmap.is_none());
    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 503);
    assert_eq!(v["error"], "sidecar_unavailable");
}

// ---------------------------------------------------------------------------
// (f) 412 on wrong If-Generation-Match + body has current generationId
// ---------------------------------------------------------------------------

#[test]
fn generation_mismatch_412() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(
        &q,
        &h.gen,
        &h.ctx,
        Some("not-the-current-generation"),
    ));
    assert_eq!(status, 412);
    assert_eq!(
        v["generationId"], h.gen_id,
        "412 body must carry the current generationId"
    );
}

// ---------------------------------------------------------------------------
// (g) 200 when If-Generation-Match matches
// ---------------------------------------------------------------------------

#[test]
fn generation_match_200() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let gen_id = h.gen_id.clone();
    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, Some(&gen_id)));
    assert_eq!(status, 200, "matching If-Generation-Match must serve 200");
    assert_eq!(v["departures"].as_array().unwrap().len(), 2);
}

// ---------------------------------------------------------------------------
// (h) 200 empty departures when stop exists but window empty
// ---------------------------------------------------------------------------

#[test]
fn empty_window_200_empty_array() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    // A 1h window AFTER both departures (10:00–11:00 local). In-service-range
    // (same day), but no departures fall inside.
    let from = DEP_0900 + 3600; // 10:00 local
    let to = from + 3600;
    let q = format!("stopId=S1&from={from}&to={to}");
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);
    assert_eq!(
        v["windowOutsideServiceRange"], false,
        "still inside the 90-day window"
    );
    assert_eq!(v["departures"].as_array().unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// (i) 200 windowOutsideServiceRange true past the 90-day horizon
// ---------------------------------------------------------------------------

#[test]
fn window_outside_service_range_true() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    // 2099 is far past feed_start_date+90d.
    let from = 4070908800i64; // 2099-01-01 00:00 UTC approx
    let to = from + 3600;
    let q = format!("stopId=S1&from={from}&to={to}");
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);
    assert_eq!(v["windowOutsideServiceRange"], true);
    assert_eq!(v["departures"].as_array().unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// (j) a stop_time with dep_secs == 0xFFFFFFFF is OMITTED
// ---------------------------------------------------------------------------

#[test]
fn missing_departure_time_omitted() {
    // Feed: a single trip whose row at S1 has dep_secs = 0xFFFFFFFF (missing),
    // plus a normal departure at S2. Querying S1 must yield zero departures even
    // though the DPIX lists the S1 entry.
    let feed = publisher::build_feed_ptb(
        &["S1", "S2"],
        &[RouteSpec {
            route_id: "R0",
            short_name: "1",
            route_type: 3,
            color: "00FF00",
            text_color: "000000",
        }],
        &[TripSpec {
            trip_id: "T0",
            headsign: "H",
            route_idx: 0,
            service_idx: 0,
            direction_id: 0,
            wheelchair: 0,
            // S1 row has MISSING dep_secs; S2 row is a normal 08:00 departure.
            stop_times: vec![(1, 0, 0xFFFF_FFFF, 0), (2, 1, 28800, 0)],
        }],
        &[all_active_mask()],
        FEED_START,
        VILNIUS_TZ_OFFSET,
    );
    // DPIX: S1 → T0 row 0 (the missing one); S2 → T0 row 1.
    let s1 = vec![(0u32, feed.abs_rows[0][0])];
    let s2 = vec![(0u32, feed.abs_rows[0][1])];
    let dpix = publisher::build_departures_idx_csr(&feed.bytes, &[s1, s2]);
    let h = build_harness(&feed, Some(dpix));

    let q = format!("stopId=S1&from={}&to={}", DEP_0800 - 3600, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);
    assert_eq!(
        v["departures"].as_array().unwrap().len(),
        0,
        "0xFFFFFFFF dep_secs row must be omitted; {v}"
    );
}

// ---------------------------------------------------------------------------
// (k) loop/lasso: one trip visits a stop twice → exactly 2 departures, distinct
//     stopSequence + times, no tripId dedup
// ---------------------------------------------------------------------------

#[test]
fn loop_trip_two_departures_no_dedup() {
    // Trip T0 visits S1 (idx 0) at seq 1 (08:00) and again at seq 3 (08:30) —
    // a loop revisiting the boarding stop. Both must surface for S1.
    let feed = publisher::build_feed_ptb(
        &["S1", "S2"],
        &[RouteSpec {
            route_id: "R_LOOP",
            short_name: "6G",
            route_type: 3,
            color: "0000FF",
            text_color: "FFFFFF",
        }],
        &[TripSpec {
            trip_id: "T_LOOP",
            headsign: "Loop",
            route_idx: 0,
            service_idx: 0,
            direction_id: 0,
            wheelchair: 0,
            // S1@08:00, S2@08:10, S1-again@08:30 (loop back).
            stop_times: vec![(1, 0, 28800, 0), (2, 1, 29400, 0), (3, 0, 30600, 0)],
        }],
        &[all_active_mask()],
        FEED_START,
        VILNIUS_TZ_OFFSET,
    );
    // DPIX: S1 → BOTH its rows (abs row 0 and abs row 2); S2 → row 1.
    let s1 = vec![
        (0u32, feed.abs_rows[0][0]), // seq 1 @ 08:00
        (0u32, feed.abs_rows[0][2]), // seq 3 @ 08:30
    ];
    let s2 = vec![(0u32, feed.abs_rows[0][1])];
    let dpix = publisher::build_departures_idx_csr(&feed.bytes, &[s1, s2]);
    let h = build_harness(&feed, Some(dpix));

    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);
    let deps = v["departures"].as_array().unwrap();
    assert_eq!(
        deps.len(),
        2,
        "loop revisit must surface BOTH stop_times; {v}"
    );
    // Both are the same tripId (no dedup), distinct stopSequence + dep.
    assert_eq!(deps[0]["tripId"], "T_LOOP");
    assert_eq!(deps[1]["tripId"], "T_LOOP");
    assert_eq!(deps[0]["stopSequence"], 1);
    assert_eq!(deps[1]["stopSequence"], 3);
    assert_eq!(deps[0]["scheduledDepartureSecs"], DEP_0800);
    assert_eq!(deps[1]["scheduledDepartureSecs"], DEP_0830);
}

// ---------------------------------------------------------------------------
// (l) overnight (25:30) crossing the civil-date boundary surfaces in a
//     midnight-straddling window
// ---------------------------------------------------------------------------

#[test]
fn overnight_departure_surfaces() {
    // Trip departs S1 on service date 2026-05-04 at 25:30:00 (91800s) — i.e.
    // 2026-05-05 01:30 local. The window 01:00–02:00 on 2026-05-05 must catch it
    // via the −1-day candidate window.
    let feed = publisher::build_feed_ptb(
        &["S1", "S2"],
        &[RouteSpec {
            route_id: "R_NIGHT",
            short_name: "N1",
            route_type: 3,
            color: "112233",
            text_color: "FFFFFF",
        }],
        &[TripSpec {
            trip_id: "T_NIGHT",
            headsign: "Night",
            route_idx: 0,
            service_idx: 0,
            direction_id: 1,
            wheelchair: 0,
            // S1 @ 25:30:00 (overnight), S2 @ 26:00:00.
            stop_times: vec![(1, 0, 91800, 0), (2, 1, 93600, 0)],
        }],
        &[all_active_mask()],
        FEED_START,
        VILNIUS_TZ_OFFSET,
    );
    let s1 = vec![(0u32, feed.abs_rows[0][0])];
    let s2 = vec![(0u32, feed.abs_rows[0][1])];
    let dpix = publisher::build_departures_idx_csr(&feed.bytes, &[s1, s2]);
    let h = build_harness(&feed, Some(dpix));

    // Window 2026-05-05 01:00..02:00 local.
    let q = format!("stopId=S1&from={}&to={}", LOCAL_0100, LOCAL_0200);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);
    let deps = v["departures"].as_array().unwrap();
    assert_eq!(deps.len(), 1, "overnight departure must surface; {v}");
    assert_eq!(deps[0]["tripId"], "T_NIGHT");
    assert_eq!(deps[0]["scheduledDepartureSecs"], OVERNIGHT_0130);
    assert_eq!(deps[0]["directionId"], 1);
}

// ---------------------------------------------------------------------------
// (m) maxResults truncation → exactly N, sorted, truncated:true + counter
// ---------------------------------------------------------------------------

#[test]
fn max_results_truncation() {
    // Five trips departing S1 at 08:00, 08:05, 08:10, 08:30, 09:00 — published
    // to the DPIX in a NON-sorted order so we prove the handler sorts before
    // truncating (it must keep the earliest N).
    let feed = publisher::build_feed_ptb(
        &["S1"],
        &[RouteSpec {
            route_id: "R0",
            short_name: "1",
            route_type: 3,
            color: "AABBCC",
            text_color: "000000",
        }],
        &[
            TripSpec {
                trip_id: "T_0900",
                headsign: "H",
                route_idx: 0,
                service_idx: 0,
                direction_id: 0,
                wheelchair: 0,
                stop_times: vec![(1, 0, 32400, 0)],
            },
            TripSpec {
                trip_id: "T_0800",
                headsign: "H",
                route_idx: 0,
                service_idx: 0,
                direction_id: 0,
                wheelchair: 0,
                stop_times: vec![(1, 0, 28800, 0)],
            },
            TripSpec {
                trip_id: "T_0830",
                headsign: "H",
                route_idx: 0,
                service_idx: 0,
                direction_id: 0,
                wheelchair: 0,
                stop_times: vec![(1, 0, 30600, 0)],
            },
            TripSpec {
                trip_id: "T_0805",
                headsign: "H",
                route_idx: 0,
                service_idx: 0,
                direction_id: 0,
                wheelchair: 0,
                stop_times: vec![(1, 0, 29100, 0)],
            },
            TripSpec {
                trip_id: "T_0810",
                headsign: "H",
                route_idx: 0,
                service_idx: 0,
                direction_id: 0,
                wheelchair: 0,
                stop_times: vec![(1, 0, 29400, 0)],
            },
        ],
        &[all_active_mask()],
        FEED_START,
        VILNIUS_TZ_OFFSET,
    );
    // S1 entries listed in trip-storage (non-time) order.
    let s1: Vec<(u32, u32)> = (0..5u32)
        .map(|t| (t, feed.abs_rows[t as usize][0]))
        .collect();
    let dpix = publisher::build_departures_idx_csr(&feed.bytes, &[s1]);
    let h = build_harness(&feed, Some(dpix));

    // 6h window catches all 5; maxResults=3 keeps the 3 earliest.
    let q = format!(
        "stopId=S1&from={}&to={}&maxResults=3",
        DEP_0800,
        DEP_0900 + 1
    );
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);
    assert_eq!(v["truncated"], true);
    let deps = v["departures"].as_array().unwrap();
    assert_eq!(deps.len(), 3, "must keep exactly maxResults=3");
    // Sorted ascending, earliest three: 08:00, 08:05, 08:10.
    assert_eq!(deps[0]["scheduledDepartureSecs"], DEP_0800);
    assert_eq!(deps[1]["scheduledDepartureSecs"], DEP_0805);
    assert_eq!(deps[2]["scheduledDepartureSecs"], DEP_0810);
    assert_eq!(
        h.ctx.metrics.scheduled_departures_truncated_total(),
        1,
        "truncation counter must have incremented exactly once"
    );
}

// ---------------------------------------------------------------------------
// (n) directionId 0xFF → null in the JSON (covered by happy path T2, plus an
//     explicit single-trip assertion here for clarity)
// ---------------------------------------------------------------------------

#[test]
fn direction_absent_renders_null() {
    let feed = publisher::build_feed_ptb(
        &["S1"],
        &[RouteSpec {
            route_id: "R0",
            short_name: "1",
            route_type: 3,
            color: "AABBCC",
            text_color: "000000",
        }],
        &[TripSpec {
            trip_id: "T0",
            headsign: "H",
            route_idx: 0,
            service_idx: 0,
            direction_id: 0xFF,
            wheelchair: 2,
            stop_times: vec![(1, 0, 28800, 0)],
        }],
        &[all_active_mask()],
        FEED_START,
        VILNIUS_TZ_OFFSET,
    );
    let s1 = vec![(0u32, feed.abs_rows[0][0])];
    let dpix = publisher::build_departures_idx_csr(&feed.bytes, &[s1]);
    let h = build_harness(&feed, Some(dpix));

    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);
    let d = &v["departures"][0];
    assert!(d["directionId"].is_null(), "0xFF → null");
    assert_eq!(d["wheelchairAccessible"], 2);
}

// ---------------------------------------------------------------------------
// Contract golden: the happy-path body deserializes to a struct with the frozen
// keys and contractVersion == 1, and matches the committed golden fixture's
// shape. (Deliverable 5.)
// ---------------------------------------------------------------------------

#[test]
fn contract_golden_v1_shape() {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Departure {
        #[serde(rename = "tripId")]
        trip_id: String,
        #[serde(rename = "routeId")]
        route_id: String,
        #[serde(rename = "routeShortName")]
        route_short_name: String,
        #[serde(rename = "routeColor")]
        route_color: String,
        #[serde(rename = "routeTextColor")]
        route_text_color: String,
        mode: String,
        #[serde(rename = "subMode")]
        sub_mode: Option<String>,
        #[serde(rename = "serviceId")]
        service_id: String,
        headsign: String,
        #[serde(rename = "directionId")]
        direction_id: Option<u8>,
        #[serde(rename = "stopSequence")]
        stop_sequence: u16,
        #[serde(rename = "scheduledDepartureSecs")]
        scheduled_departure_secs: i64,
        #[serde(rename = "scheduledArrivalSecs")]
        scheduled_arrival_secs: i64,
        #[serde(rename = "wheelchairAccessible")]
        wheelchair_accessible: u8,
    }
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Contract {
        #[serde(rename = "contractVersion")]
        contract_version: u32,
        #[serde(rename = "stopId")]
        stop_id: String,
        #[serde(rename = "windowStart")]
        window_start: i64,
        #[serde(rename = "windowEnd")]
        window_end: i64,
        #[serde(rename = "generationId")]
        generation_id: String,
        #[serde(rename = "cityTzIana")]
        city_tz_iana: String,
        truncated: bool,
        #[serde(rename = "windowOutsideServiceRange")]
        window_outside_service_range: bool,
        departures: Vec<Departure>,
    }

    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, _) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);

    // Re-run to get the raw body for golden comparison.
    let resp = scheduled_departures(&q, &h.gen, &h.ctx, None);
    let body = match resp {
        Resp::Json { body, .. } => body,
        _ => panic!("Json"),
    };
    let parsed: Contract =
        serde_json::from_str(&body).expect("happy body deserializes to the frozen Contract shape");
    assert_eq!(parsed.contract_version, 1);
    assert!(
        parsed.departures.iter().any(|d| d.route_color.is_empty()),
        "golden must include a color-less route row"
    );
    assert!(
        parsed.departures.iter().any(|d| d.direction_id.is_none()),
        "golden must include a directionId:null row"
    );

    // The committed golden mirrors this body's SHAPE (generationId / instants are
    // environment-derived, so we compare the stable structural fields).
    let golden_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/tests/__fixtures__/scheduled-departures-contract.v1.json"
    );
    let golden_text = std::fs::read_to_string(golden_path).expect("read golden fixture");
    let golden: serde_json::Value = serde_json::from_str(&golden_text).expect("golden is JSON");
    assert_eq!(golden["contractVersion"], 1);
    // The golden's department keys match the live response's keys exactly.
    let live: serde_json::Value = serde_json::from_str(&body).unwrap();
    let golden_keys: Vec<String> = golden.as_object().unwrap().keys().cloned().collect();
    let live_keys: Vec<String> = live.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        golden_keys, live_keys,
        "top-level key set must match the golden"
    );
    let g_dep_keys: Vec<String> = golden["departures"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let l_dep_keys: Vec<String> = live["departures"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(
        g_dep_keys, l_dep_keys,
        "departure key set must match the golden"
    );
}

// ---------------------------------------------------------------------------
// (7) Wire-level loopback smoke test — spawn the real binary over a published
// custom feed + DPIX, hit GET /api/<city>/scheduled-departures-for-stop on the
// LOOPBACK port (200 + expected shape), and assert GET /api/<city>/plan on the
// loopback port is 404 (the loopback listener serves ONLY this route).
// ---------------------------------------------------------------------------

struct SpawnedServer {
    child: Child,
    main_base: String,
    loopback_base: String,
    /// Base URL of the aux/metrics listener (serves `/metrics`, `/ready`, ...).
    metrics_base: String,
    _data_root: tempfile::TempDir,
}

impl Drop for SpawnedServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Publish a custom feed + DPIX into a fresh data_root and spawn the pt-serve
/// binary over it. Parses the main addr from stdout and the loopback addr from
/// the stderr startup line.
fn spawn_over_feed(feed: &BuiltFeed, dpix: Vec<u8>) -> SpawnedServer {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);
    let src = data_root.path().join("source.ptb");
    std::fs::write(&src, &feed.bytes).expect("write source feed");
    let artifacts = SidecarArtifacts {
        departures_idx: Some(dpix),
        ..Default::default()
    };
    let _id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &src,
        &created_at,
        &artifacts,
    );

    let bin = env!("CARGO_BIN_EXE_pt-serve");
    let mut cmd = Command::new(bin);
    cmd.args([
        "--listen-addr",
        "127.0.0.1:0",
        "--metrics-listen-addr",
        "127.0.0.1:0",
        "--loopback-listen-addr",
        "127.0.0.1:0",
        "--data-root",
        data_root.path().to_str().unwrap(),
        "--pidfile-path",
        data_root.path().join("pt-serve.pid").to_str().unwrap(),
        "--city-slug",
        "vilnius",
        "--city-tz-iana-default",
        "Europe/Vilnius",
        "--worker-pool-size",
        "2",
        "--max-rss-bytes",
        "1073741824",
        "--process-fixed-overhead-bytes",
        "200000000",
        "--per-worker-overhead-bytes",
        "50000000",
    ]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn pt-serve");

    // Loopback + aux addrs are on the stderr startup line:
    //   "pt-serve: listening on <main> (main) <aux> (aux) <loopback> (loopback) ..."
    let stderr = child.stderr.take().expect("stderr piped");
    // Channel carries Option<(aux_addr, loopback_addr)>.
    let (etx, erx) = mpsc::sync_channel::<Option<(String, String)>>(1);
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = etx.send(None);
                    break;
                }
                Ok(_) => {
                    if let Some(rest) = line.trim().strip_prefix("pt-serve: listening on ") {
                        // tokens: main (main) aux (aux) loopback (loopback) ...
                        let toks: Vec<&str> = rest.split_whitespace().collect();
                        let addr_before = |label: &str| -> Option<String> {
                            toks.iter()
                                .position(|t| *t == label)
                                .and_then(|i| i.checked_sub(1))
                                .and_then(|i| toks.get(i))
                                .map(|s| s.to_string())
                        };
                        let pair = match (addr_before("(aux)"), addr_before("(loopback)")) {
                            (Some(a), Some(l)) => Some((a, l)),
                            _ => None,
                        };
                        let _ = etx.send(pair);
                        break;
                    }
                }
                Err(_) => {
                    let _ = etx.send(None);
                    break;
                }
            }
        }
    });

    // Main addr on stdout.
    let stdout = child.stdout.take().expect("stdout piped");
    let (tx, rx) = mpsc::sync_channel::<Option<String>>(1);
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(None);
                    break;
                }
                Ok(_) => {
                    if let Some(rest) = line.trim().strip_prefix("pt-serve listening on ") {
                        let _ = tx.send(Some(rest.to_string()));
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                    break;
                }
            }
        }
    });

    let main_base = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(b)) => b,
        _ => {
            let _ = child.kill();
            panic!("pt-serve did not print its main bound address within 5s");
        }
    };
    let (aux_addr, loopback_addr) = match erx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(pair)) => pair,
        _ => {
            let _ = child.kill();
            panic!("pt-serve did not print its aux + loopback bound addresses within 5s");
        }
    };
    let loopback_base = format!("http://{loopback_addr}");
    let metrics_base = format!("http://{aux_addr}");

    // Wait for readiness on the main listener.
    let mut ready = false;
    for _ in 0..60 {
        if http_get(&format!("{main_base}/ready"))
            .map(|(s, _)| s == 200)
            .unwrap_or(false)
        {
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(ready, "pt-serve did not become ready within 3s");

    SpawnedServer {
        child,
        main_base,
        loopback_base,
        metrics_base,
        _data_root: data_root,
    }
}

/// Minimal blocking GET → (status, body). Raw TCP to avoid ureq's quirks on
/// arbitrary ports.
fn http_get(url: &str) -> Result<(u16, String), Box<dyn std::error::Error>> {
    use std::io::Write as _;
    use std::net::TcpStream;
    let parsed = url::Url::parse(url)?;
    let host = parsed.host_str().unwrap_or("127.0.0.1").to_string();
    let port = parsed.port().unwrap_or(80);
    let path = if parsed.query().is_some() {
        format!("{}?{}", parsed.path(), parsed.query().unwrap())
    } else {
        parsed.path().to_string()
    };
    let mut stream = TcpStream::connect(format!("{host}:{port}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw);
    let status: u16 = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    Ok((status, body))
}

/// Like [`http_get`] but with one extra request header (used to drive the
/// `If-Generation-Match` 412 path over the wire).
fn http_get_with_header(
    url: &str,
    header_name: &str,
    header_value: &str,
) -> Result<(u16, String), Box<dyn std::error::Error>> {
    use std::io::Write as _;
    use std::net::TcpStream;
    let parsed = url::Url::parse(url)?;
    let host = parsed.host_str().unwrap_or("127.0.0.1").to_string();
    let port = parsed.port().unwrap_or(80);
    let path = if parsed.query().is_some() {
        format!("{}?{}", parsed.path(), parsed.query().unwrap())
    } else {
        parsed.path().to_string()
    };
    let mut stream = TcpStream::connect(format!("{host}:{port}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\n{header_name}: {header_value}\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw);
    let status: u16 = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    Ok((status, body))
}

// ---------------------------------------------------------------------------
// FIX 4: the loopback dispatch arm bumps pt_serve_requests_total{route,status}
// (mirrors the color-config/shapes arms). Drive a 200 + a 412 over the wire and
// confirm both land in /metrics under route="scheduled-departures-for-stop".
// ---------------------------------------------------------------------------

#[test]
fn wire_loopback_increments_per_route_counter() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let s = spawn_over_feed(&feed, dpix);

    // A 200 request.
    let url_200 = format!(
        "{}/api/vilnius/scheduled-departures-for-stop?stopId=S1&from={}&to={}",
        s.loopback_base, DEP_0800, DEP_0900
    );
    let (status_200, _) = http_get(&url_200).expect("loopback 200 GET");
    assert_eq!(status_200, 200);

    // A 412 request (wrong If-Generation-Match).
    let (status_412, _) =
        http_get_with_header(&url_200, "If-Generation-Match", "definitely-not-the-gen")
            .expect("loopback 412 GET");
    assert_eq!(status_412, 412, "wrong If-Generation-Match → 412");

    // Scrape /metrics off the aux listener and confirm BOTH labels appear.
    let (mcode, metrics_body) =
        http_get(&format!("{}/metrics", s.metrics_base)).expect("metrics GET");
    assert_eq!(mcode, 200, "/metrics must be 200; {metrics_body}");
    assert!(
        metrics_body.contains(
            "pt_serve_requests_total{route=\"scheduled-departures-for-stop\",status=\"200\"}"
        ),
        "200 counter must appear after a 200 loopback request; metrics:\n{metrics_body}"
    );
    assert!(
        metrics_body.contains(
            "pt_serve_requests_total{route=\"scheduled-departures-for-stop\",status=\"412\"}"
        ),
        "412 counter must appear after a 412 loopback request; metrics:\n{metrics_body}"
    );
}

#[test]
fn wire_loopback_serves_scheduled_departures_and_404s_plan() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let s = spawn_over_feed(&feed, dpix);

    // Loopback: scheduled-departures-for-stop returns 200 with the expected shape.
    let url = format!(
        "{}/api/vilnius/scheduled-departures-for-stop?stopId=S1&from={}&to={}",
        s.loopback_base, DEP_0800, DEP_0900
    );
    let (status, body) = http_get(&url).expect("loopback GET");
    assert_eq!(
        status, 200,
        "loopback scheduled-departures must be 200; {body}"
    );
    let v: serde_json::Value = serde_json::from_str(&body).expect("body is JSON");
    assert_eq!(v["contractVersion"], 1);
    assert_eq!(v["stopId"], "S1");
    assert_eq!(v["cityTzIana"], "Europe/Vilnius");
    assert!(
        v["departures"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false),
        "expected ≥1 departure for S1; {v}"
    );

    // Loopback: /plan is NOT served on the loopback listener → 404.
    let plan_url = format!("{}/api/vilnius/plan", s.loopback_base);
    let (plan_status, _) = http_get(&plan_url).expect("loopback /plan GET");
    assert_eq!(
        plan_status, 404,
        "loopback listener must 404 /plan (it serves only scheduled-departures)"
    );

    // Public: scheduled-departures-for-stop is 404 on the MAIN listener.
    let pub_url = format!(
        "{}/api/vilnius/scheduled-departures-for-stop?stopId=S1&from={}&to={}",
        s.main_base, DEP_0800, DEP_0900
    );
    let (pub_status, _) = http_get(&pub_url).expect("public GET");
    assert_eq!(
        pub_status, 404,
        "public listener must 404 scheduled-departures (loopback-only route)"
    );
}

// ---------------------------------------------------------------------------
// (overflow) i64 overflow on malicious from/to values → 400, not panic
// ---------------------------------------------------------------------------

#[test]
fn overflow_from_is_400() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));

    // from = i64::MAX with no `to`: the default `to = from + DEFAULT_WINDOW_SECS`
    // would overflow without saturating_add. With saturating_add, to = i64::MAX,
    // so to <= from → the existing "to must be greater than from" 400.
    let q = "stopId=S1&from=9223372036854775807";
    let (status, _) = json_resp(scheduled_departures(q, &h.gen, &h.ctx, None));
    assert_eq!(
        status, 400,
        "from=i64::MAX with no to must be 400 not panic/500"
    );

    // from = i64::MIN, to = i64::MAX: saturating_sub gives i64::MAX > MAX_WINDOW_SECS
    // → the existing "window exceeds 6h" 400.
    let q2 = "stopId=S1&from=-9223372036854775808&to=9223372036854775807";
    let (status2, _) = json_resp(scheduled_departures(q2, &h.gen, &h.ctx, None));
    assert_eq!(
        status2, 400,
        "from=i64::MIN&to=i64::MAX must be 400 not panic/500"
    );
}

// ---------------------------------------------------------------------------
// FIX 1: stopId is form-urldecoded. A stop_id containing a space + '+' + a
// non-ASCII char, passed in its FORM-ENCODED form (URLSearchParams style),
// resolves to the correctly-decoded stop → 200 with that stop's departures
// (not 404). The Node loopback client form-encodes via URLSearchParams.
// ---------------------------------------------------------------------------

#[test]
fn stop_id_form_urldecoded_resolves() {
    // Publish a stop whose id contains a space, a literal '+', and a non-ASCII
    // char — exactly the bytes URLSearchParams would percent/`+`-encode.
    // Literal id: "de:08111: 6+ä" (a real GTFS-style id shape with a space).
    let stop_id_literal = "de:08111: 6+\u{00e4}"; // space, '+', 'ä'
    let feed = publisher::build_feed_ptb(
        &[stop_id_literal, "S2"],
        &[RouteSpec {
            route_id: "R0",
            short_name: "1",
            route_type: 3,
            color: "AABBCC",
            text_color: "000000",
        }],
        &[TripSpec {
            trip_id: "T0",
            headsign: "H",
            route_idx: 0,
            service_idx: 0,
            direction_id: 0,
            wheelchair: 0,
            stop_times: vec![(1, 0, 28800, 0), (2, 1, 29400, 0)],
        }],
        &[all_active_mask()],
        FEED_START,
        VILNIUS_TZ_OFFSET,
    );
    let s0 = vec![(0u32, feed.abs_rows[0][0])];
    let s2 = vec![(0u32, feed.abs_rows[0][1])];
    let dpix = publisher::build_departures_idx_csr(&feed.bytes, &[s0, s2]);
    let h = build_harness(&feed, Some(dpix));

    // Form-encode the id the way URLSearchParams.set would:
    //   space → '+', '+' → "%2B", 'ä' (U+00E4 → UTF-8 0xC3 0xA4) → "%C3%A4",
    //   ':' stays literal (URLSearchParams does not encode ':').
    let encoded = "de:08111:+6%2B%C3%A4";
    let q = format!("stopId={encoded}&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(
        status, 200,
        "form-encoded stopId must decode + resolve (not 404); {v}"
    );
    // The echoed stopId is the DECODED literal.
    assert_eq!(v["stopId"], stop_id_literal);
    let deps = v["departures"].as_array().unwrap();
    assert_eq!(deps.len(), 1, "decoded stop has its 08:00 departure; {v}");
    assert_eq!(deps[0]["tripId"], "T0");

    // Sanity: the still-encoded form must NOT match (proves decoding is required).
    let q_raw = format!("stopId={encoded}", encoded = "de:08111:+6%2B%C3%A4-WRONG");
    let q_raw = format!("{q_raw}&from={}&to={}", DEP_0800, DEP_0900);
    let (status_raw, _) = json_resp(scheduled_departures(&q_raw, &h.gen, &h.ctx, None));
    assert_eq!(status_raw, 404, "a different id must still 404");
}

// ---------------------------------------------------------------------------
// FIX 7: maxResults=0 → empty departures, truncated:true, truncation counter
// incremented (0 is a valid usize; simplest consistent behavior is empty+trunc).
// ---------------------------------------------------------------------------

#[test]
fn max_results_zero_empty_truncated() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    // Window covers both S1 departures, but maxResults=0 truncates to empty.
    let q = format!("stopId=S1&from={}&to={}&maxResults=0", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200, "maxResults=0 is a valid usize → 200; {v}");
    assert_eq!(
        v["truncated"], true,
        "maxResults=0 truncates the 2 survivors"
    );
    assert_eq!(v["departures"].as_array().unwrap().len(), 0);
    assert_eq!(
        h.ctx.metrics.scheduled_departures_truncated_total(),
        1,
        "maxResults=0 truncation must bump the counter"
    );
}

// ---------------------------------------------------------------------------
// FIX 7: malformed maxResults (-1, abc) → 400.
// ---------------------------------------------------------------------------

#[test]
fn malformed_max_results_400() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    for bad in ["-1", "abc", "1.5", "9999999999999999999999"] {
        let q = format!(
            "stopId=S1&from={}&to={}&maxResults={bad}",
            DEP_0800, DEP_0900
        );
        let (status, _) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
        assert_eq!(status, 400, "maxResults={bad} must be 400");
    }
}

// ---------------------------------------------------------------------------
// FIX 7: out-of-range stopTimeIdx (a DPIX entry pointing past the StopTimes
// region) → the row is omitted, NO panic, 200.
// ---------------------------------------------------------------------------

#[test]
fn out_of_range_stop_time_idx_omitted_no_panic() {
    let feed = happy_feed();
    // S1's DPIX: one VALID entry (T1's real row) + one entry whose stopTimeIdx
    // points FAR past the StopTimes region (reader.stop_time → SliceOutOfBounds,
    // which the handler `continue`s on). build_departures_idx_csr does not
    // validate stopTimeIdx range, so this assembles cleanly.
    let s1 = vec![
        (0u32, feed.abs_rows[0][0]), // valid: T1 @ S1 @ 08:00
        (0u32, 0xFFFF_FFFEu32),      // bogus: past the StopTimes region
    ];
    let s2 = vec![(0u32, feed.abs_rows[0][1]), (1u32, feed.abs_rows[1][1])];
    let s3: Vec<(u32, u32)> = vec![];
    let dpix = publisher::build_departures_idx_csr(&feed.bytes, &[s1, s2, s3]);
    let h = build_harness(&feed, Some(dpix));

    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200, "out-of-range stopTimeIdx must not panic; {v}");
    let deps = v["departures"].as_array().unwrap();
    assert_eq!(
        deps.len(),
        1,
        "only the valid row surfaces; the bogus stopTimeIdx is omitted; {v}"
    );
    assert_eq!(deps[0]["tripId"], "T1");
}

// ---------------------------------------------------------------------------
// FIX 7: windowOutsideServiceRange boundary — pins the `delta >= 90` cutoff.
//   - `from` on the LAST in-window service day (day 89) → flag false, a
//     departure surfaces.
//   - `from` past the window such that ALL candidate dates (incl. the −1-day
//     back-scan) are `delta >= 90` → flag true, empty.
// ---------------------------------------------------------------------------

#[test]
fn window_outside_service_range_boundary() {
    // feed_start_date=20260501, 90-day window. day0=2026-05-01, day89=2026-07-29
    // (last in-window), day90=2026-07-30 (first outside).
    const DAY89_0800: i64 = 1785301200; // 2026-07-29 08:00 local (+03:00, EEST)
    const DAY91_0800: i64 = 1785474000; // 2026-07-31 08:00 local — candidates {day90,day91} both outside

    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));

    // Last in-window day: short 1h window stays inside day 89.
    let q_in = format!("stopId=S1&from={}&to={}", DAY89_0800, DAY89_0800 + 3600);
    let (status_in, v_in) = json_resp(scheduled_departures(&q_in, &h.gen, &h.ctx, None));
    assert_eq!(status_in, 200);
    assert_eq!(
        v_in["windowOutsideServiceRange"], false,
        "day 89 (delta 89 < 90) is the last in-window day; {v_in}"
    );
    // Both S1 departures (T1 @ 08:00, T2 @ 08:30) fall in the 1h window and are
    // active on day 89 (all-active mask).
    assert_eq!(
        v_in["departures"].as_array().unwrap().len(),
        2,
        "S1's two departures are active on day 89; {v_in}"
    );

    // Past the window: from on day 91 → candidate dates {day90, day91}, both
    // delta >= 90 → flag true, empty.
    let q_out = format!("stopId=S1&from={}&to={}", DAY91_0800, DAY91_0800 + 3600);
    let (status_out, v_out) = json_resp(scheduled_departures(&q_out, &h.gen, &h.ctx, None));
    assert_eq!(status_out, 200);
    assert_eq!(
        v_out["windowOutsideServiceRange"], true,
        "day 91 candidate set is fully past the 90-day window; {v_out}"
    );
    assert_eq!(v_out["departures"].as_array().unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// FIX 7: 412 precedence — a harness with dpix:None (sidecar absent) AND a wrong
// If-Generation-Match → 412 (not 503), proving the generation check runs BEFORE
// the sidecar/stop gates.
// ---------------------------------------------------------------------------

#[test]
fn generation_mismatch_precedes_sidecar_503() {
    let feed = happy_feed();
    let h = build_harness(&feed, None); // NO DPIX → would otherwise 503
    assert!(h.gen.departures_idx_mmap.is_none());
    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(
        &q,
        &h.gen,
        &h.ctx,
        Some("wrong-generation"),
    ));
    assert_eq!(
        status, 412,
        "generation mismatch must win over the absent-sidecar 503; {v}"
    );
    assert_eq!(v["generationId"], h.gen_id);
}

// ---------------------------------------------------------------------------
// FIX 6: a near-max overnight departure (47:00:00 on a service date) surfaces in
// a window covering it — proving the −1-day back-scan suffices at the producer's
// `h <= 47` (dep_secs < 2 days) cap boundary.
// ---------------------------------------------------------------------------

#[test]
fn overnight_at_47h_cap_surfaces_via_back_scan() {
    // Service date 2026-05-04 (day 3), 47:00:00 = 169200s (< 2 days = 172800s,
    // the producer cap). The civil instant lands on 2026-05-05 23:00 local.
    const DEP_47H: i64 = 1778011200; // 2026-05-05 23:00 local (+03:00)
    const WIN_2230: i64 = 1778009400; // 2026-05-05 22:30 local
    const WIN_2330: i64 = 1778013000; // 2026-05-05 23:30 local

    let feed = publisher::build_feed_ptb(
        &["S1", "S2"],
        &[RouteSpec {
            route_id: "R_CAP",
            short_name: "C1",
            route_type: 3,
            color: "445566",
            text_color: "FFFFFF",
        }],
        &[TripSpec {
            trip_id: "T_CAP",
            headsign: "Cap",
            route_idx: 0,
            service_idx: 0,
            direction_id: 0,
            wheelchair: 0,
            // S1 @ 47:00:00 (169200s), S2 @ 47:10:00.
            stop_times: vec![(1, 0, 169200, 0), (2, 1, 169800, 0)],
        }],
        &[all_active_mask()],
        FEED_START,
        VILNIUS_TZ_OFFSET,
    );
    let s1 = vec![(0u32, feed.abs_rows[0][0])];
    let s2 = vec![(0u32, feed.abs_rows[0][1])];
    let dpix = publisher::build_departures_idx_csr(&feed.bytes, &[s1, s2]);
    let h = build_harness(&feed, Some(dpix));

    // Window 2026-05-05 22:30..23:30 local. The departure's SERVICE date is
    // 2026-05-04 (the day before the civil instant), reached only via the
    // −1-day back-scan from localDate(from)=2026-05-05.
    let q = format!("stopId=S1&from={WIN_2230}&to={WIN_2330}");
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);
    let deps = v["departures"].as_array().unwrap();
    assert_eq!(
        deps.len(),
        1,
        "47:00 overnight must surface via the −1-day back-scan at the cap; {v}"
    );
    assert_eq!(deps[0]["tripId"], "T_CAP");
    assert_eq!(deps[0]["scheduledDepartureSecs"], DEP_47H);
}

// ---------------------------------------------------------------------------
// FIX 2: a `from` near the i64 extreme that still passes the local_date guard
// must 400 (checked NaiveDate arithmetic), not panic → 500. (Cheap extra cover
// on top of overflow_from_is_400; here the candidate-window add/sub is the
// failure site.)
// ---------------------------------------------------------------------------

#[test]
fn extreme_from_near_i64_max_is_400_not_panic() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    // A very large but representable `from` with a 1s window: local_date may
    // succeed, but the candidate-window NaiveDate arithmetic must not panic.
    let from = 200_000_000_000i64; // ~year 8338 — well within Jiff's range
    let q = format!("stopId=S1&from={from}&to={}", from + 1);
    let (status, _) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    // Either 200 (representable, no departures) or 400 (date guard) — never a
    // 500/panic. Both are acceptable; the contract is "no panic".
    assert!(
        status == 200 || status == 400,
        "extreme from must be 200 or 400, never 500/panic; got {status}"
    );
}

#[test]
fn jiff_date_boundaries_are_safe_and_out_of_range_instants_return_400() {
    let feed = happy_feed();
    let h = build_harness(&feed, Some(happy_dpix(&feed)));
    for from in [
        jiff::Timestamp::MIN.as_second(),
        jiff::Timestamp::MAX.as_second() - 1,
    ] {
        let q = format!("stopId=S1&from={from}&to={}", from + 1);
        let (status, body) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
        assert!(status == 200 || status == 400, "{from}: {body}");
    }
    for from in [
        jiff::Timestamp::MIN.as_second() - 1,
        jiff::Timestamp::MAX.as_second() + 1,
    ] {
        let q = format!("stopId=S1&from={from}&to={}", from + 1);
        let (status, _) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
        assert_eq!(status, 400);
    }
}

// ---------------------------------------------------------------------------
// Public departures-for-stop route: worker-occupancy bound
//
// These live here because they exercise `compute_departures`, the computation
// this file's harness already builds a generation for, and which the public
// route shares with C2c.
// ---------------------------------------------------------------------------

/// The scan MUST abort on the watchdog flag.
///
/// `entries_iter` walks every stop_time row at the stop once per candidate
/// service date, and `maxResults` truncates only afterwards — so request cost
/// tracks the busiest stop in the feed, not anything the caller asked for. The
/// request watchdog cannot preempt a worker (`ops::timeout` only sets a flag),
/// so without this the route could pin a worker in the pool shared with /plan
/// for arbitrarily long. This is the bound that gates flipping the route on.
#[test]
fn public_route_aborts_when_the_watchdog_flag_is_set() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);

    let aborted = std::sync::atomic::AtomicBool::new(true);
    let (status, _) = json_resp(departures_for_stop(
        &q,
        &h.gen,
        &h.ctx,
        None,
        Some(&aborted),
    ));
    assert_eq!(
        status, 503,
        "a set abort flag must end the scan, not be ignored"
    );
}

/// …and the SAME request without the flag succeeds — otherwise the test above
/// would pass for the wrong reason (a route that 503s unconditionally).
#[test]
fn public_route_serves_normally_when_not_aborted() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);

    let running = std::sync::atomic::AtomicBool::new(false);
    let (status, v) = json_resp(departures_for_stop(
        &q,
        &h.gen,
        &h.ctx,
        None,
        Some(&running),
    ));
    assert_eq!(status, 200, "unaborted request must serve; {v}");
    assert!(v["data"].is_array(), "public shape is {{data, meta}}; {v}");
    assert_eq!(v["meta"]["source"], "pt-serve");
    // ISO-8601, not C2c's unix seconds — the public Departure contract.
    let t = v["data"][0]["scheduledTime"].as_str().unwrap_or_default();
    assert!(
        t.ends_with('Z') && t.contains('T'),
        "scheduledTime must be ISO-8601, got {t:?}"
    );
    // No RT feed configured in the harness, so the overlay must be absent
    // rather than fabricated.
    assert_eq!(v["meta"]["realtimeApplied"], false);
    assert!(v["data"][0].get("delaySeconds").is_none());
}

/// From real GTFS-RT bytes through the parser and the RT snapshot to the
/// stop board: T1 is DELETED — "must not be shown to users" — so it is not
/// listed at all; T2 has every stop SKIPPED, a cancelled run, so it is listed
/// as cancelled.
#[test]
fn a_deleted_trip_leaves_the_board_and_a_fully_skipped_one_is_cancelled() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let bytes = include_bytes!("fixtures/rt/departures_cancellations.bin");
    let merged = pt_serve::rt::parse_trip_updates_buffer(bytes).expect("fixture parses");
    h.ctx
        .rt
        .publish(pt_serve::rt::RtSnapshot::from_merged(merged, vec![]));

    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(departures_for_stop(&q, &h.gen, &h.ctx, None, None));
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["meta"]["realtimeApplied"], true);
    let rows = v["data"].as_array().expect("data array");
    assert!(
        rows.iter().all(|r| r["tripId"] != "T1"),
        "a DELETED trip must not be listed: {v}"
    );
    let t2 = rows
        .iter()
        .find(|r| r["tripId"] == "T2")
        .unwrap_or_else(|| panic!("T2 missing from the board: {v}"));
    assert_eq!(t2["cancelled"], true, "T2 must be cancelled: {t2}");
}

/// The loopback C2c route is unchanged by the abort plumbing: it passes `None`
/// (its pool has no watchdog), so its behaviour cannot regress.
#[test]
fn loopback_route_unaffected_by_abort_plumbing() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));
    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0900);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 200);
    assert_eq!(v["contractVersion"], 1);
}

// ---------------------------------------------------------------------------
// The window-exceeded 400 must name the bound the route actually enforces.
//
// The message was hardcoded "exceeds 6h" while the bound itself is the
// caller-supplied `max_window_secs`. That is correct for the loopback C2c
// route, which owns the 6h constant, and wrong for the public
// `departures-for-stop` route, which passes 24h — a rejected caller was told a
// limit four times tighter than the one being applied, with nothing in the
// response to reveal the real one.
//
// Both directions are pinned here. The C2c assertion is the load-bearing half:
// its body is part of a frozen `contractVersion: 1`, so the fix must leave it
// byte-identical, and only a test that reads the STRING can catch a change that
// a status-only assertion would sail past.
// ---------------------------------------------------------------------------

#[test]
fn public_route_window_rejection_names_its_own_24h_bound() {
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));

    // 24h + 1s — one second past the public route's ceiling.
    let q = format!(
        "stopId=S1&from={}&to={}",
        DEP_0800,
        DEP_0800 + 24 * 3600 + 1
    );
    let (status, v) = json_resp(departures_for_stop(&q, &h.gen, &h.ctx, None, None));
    assert_eq!(status, 400, "25h window must be rejected; {v}");
    assert_eq!(
        v["error"], "window (to - from) exceeds 24h",
        "the public route enforces 24h and must say so; {v}"
    );
}

#[test]
fn public_route_accepts_a_window_exactly_at_its_24h_bound() {
    // Without this the test above would pass for a route that rejects
    // everything, and the "24h" in its message would be unearned.
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));

    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0800 + 24 * 3600);
    let (status, v) = json_resp(departures_for_stop(&q, &h.gen, &h.ctx, None, None));
    assert_eq!(status, 200, "a window exactly at the bound must serve; {v}");
}

#[test]
fn loopback_window_rejection_message_stays_byte_identical_at_6h() {
    // `contractVersion: 1` is frozen. C2c passes 6*3600, so the rendered hour
    // count must still be exactly "6" — the pre-change literal.
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));

    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0800 + 6 * 3600 + 1);
    let (status, v) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    assert_eq!(status, 400, "7h window must be rejected on C2c; {v}");
    assert_eq!(
        v["error"], "window (to - from) exceeds 6h",
        "C2c's frozen body must not move; {v}"
    );
}

#[test]
fn loopback_still_rejects_a_window_the_public_route_accepts() {
    // The two bounds are genuinely different, not accidentally equal — which is
    // the whole reason a single hardcoded message was wrong.
    let feed = happy_feed();
    let dpix = happy_dpix(&feed);
    let h = build_harness(&feed, Some(dpix));

    let q = format!("stopId=S1&from={}&to={}", DEP_0800, DEP_0800 + 12 * 3600);
    let (c2c_status, _) = json_resp(scheduled_departures(&q, &h.gen, &h.ctx, None));
    let (public_status, _) = json_resp(departures_for_stop(&q, &h.gen, &h.ctx, None, None));
    assert_eq!(c2c_status, 400, "12h is past C2c's 6h bound");
    assert_eq!(
        public_status, 200,
        "12h is inside the public route's 24h bound"
    );
}
