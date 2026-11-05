//! Time-only GTFS-RT predictions (`StopTimeEvent.time` with no `delay`) turned
//! into trip delays against the bundle — how krakow's tram feed and most of its
//! bus feed report (the rt cancelled trips notes
//! , ).
//!
//! Feed bytes come from `tests/fixtures/rt/time_only_cases.bin`, encoded by
//! `packages/backend/scripts/generate-rt-parser-fixtures.mjs`; the bundle below
//! carries the trip and stop ids that fixture names.
//!
//! Time domain: `feed_start_date = 20260501`, tz `Europe/Vilnius` (+03:00 in
//! May 2026). Service date 2026-05-05 unless a case says otherwise.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

#[path = "common/mod.rs"]
mod common;

use common::publisher::{self, BuiltFeed, RouteSpec, SidecarArtifacts, TripSpec};
use pt_serve::app::rt_health::rt_health;
use pt_serve::app::Resp;
use pt_serve::ops::config::LogFormat;
use pt_serve::rt::parser::{parse_trip_updates_buffer, TripUpdate};
use pt_serve::rt::resolve::{resolve_time_predictions, TimePredictionStats};
use pt_serve::rt::runner::run_cycle;
use pt_serve::rt::{RtPoller, RtState};
use pt_serve::{Generation, Metrics, ServerCtx};
use pt_shared::clock::{MockClock, SystemClock};
use pt_shared::manifest::GenerationManifest;

const ANCHOR_UNIX: u64 = 1779494400;
const FEED_START: u32 = 20260501;
const VILNIUS_TZ_OFFSET: i32 = 10800;
const URL: &str = "http://krakow.test/TripUpdates_T.pb";

fn fixture() -> &'static [u8] {
    include_bytes!("fixtures/rt/time_only_cases.bin")
}

/// Every trip S1@08:00 → S2@08:10 unless named otherwise:
///   T_LOOP  S1@08:00 → S2@08:15 → S1@08:30 (visits S1 twice)
///   T_NIGHT S1@25:30 → S2@25:40 (runs past midnight)
/// S3 exists but no trip serves it.
fn feed() -> BuiltFeed {
    let plain = |trip_id| TripSpec {
        trip_id,
        headsign: "Downtown",
        route_idx: 0,
        service_idx: 0,
        direction_id: 0,
        wheelchair: 0,
        stop_times: vec![(1, 0, 28800, 0), (2, 1, 29400, 0)],
    };
    let mut trips: Vec<TripSpec> = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]
        .into_iter()
        .map(plain)
        .collect();
    trips.push(TripSpec {
        stop_times: vec![(1, 0, 28800, 0), (2, 1, 29700, 0), (3, 0, 30600, 0)],
        ..plain("T_LOOP")
    });
    trips.push(TripSpec {
        stop_times: vec![(1, 0, 91800, 0), (2, 1, 92400, 0)],
        ..plain("T_NIGHT")
    });
    publisher::build_feed_ptb(
        &["S1", "S2", "S3"],
        &[RouteSpec {
            route_id: "R_TRAM",
            short_name: "8",
            route_type: 0,
            color: "",
            text_color: "",
        }],
        &trips,
        &[[0xFFu8; 12]],
        FEED_START,
        VILNIUS_TZ_OFFSET,
    )
}

/// The production `Generation` for [`feed`], tz resolved as in production.
fn generation(data_root: &std::path::Path) -> Generation {
    use pt_serve::bundle::{build_generation, BuildInputs};
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR_UNIX));
    let src = data_root.join("source.ptb");
    std::fs::write(&src, feed().bytes).expect("write source feed");
    let id = publisher::publish_generation_with_artifacts(
        data_root,
        "vilnius",
        &src,
        &publisher::rfc3339_format(ANCHOR_UNIX),
        &SidecarArtifacts::default(),
    );
    let manifest: GenerationManifest = serde_json::from_str(
        &std::fs::read_to_string(publisher::manifest_path_for(data_root, &id)).unwrap(),
    )
    .unwrap();
    build_generation(BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(data_root, &id),
        transfers_path: None,
        expected_city: "vilnius",
        clock: &clock,
        is_startup: true,
        epoch: 0,
        metrics: Some(Metrics::new()),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
    .expect("generation builds")
}

fn resolved() -> (HashMap<String, TripUpdate>, TimePredictionStats) {
    let dir = tempfile::TempDir::new().unwrap();
    let gen = generation(dir.path());
    let mut updates = parse_trip_updates_buffer(fixture()).unwrap();
    let stats = resolve_time_predictions(&mut updates, Some(&gen));
    (updates, stats)
}

#[test]
fn a_predicted_time_becomes_the_delay_against_the_timetable() {
    let (u, _) = resolved();
    assert_eq!(
        u["T1"].delay_seconds, 120,
        "08:12 predicted at S2, due 08:10"
    );
    assert_eq!(u["T7"].delay_seconds, 180, "arrival-only prediction");
}

#[test]
fn a_bus_running_early_gets_a_negative_delay_under_both_keys() {
    let (u, _) = resolved();
    assert_eq!(u["T2"].delay_seconds, -60);
    assert_eq!(u["T2|20260505"].delay_seconds, -60);
}

#[test]
fn a_later_predicted_time_wins_over_an_earlier_stop_delay() {
    let (u, _) = resolved();
    assert_eq!(u["T4"].delay_seconds, 90, "not the 30 s reported at S1");
}

#[test]
fn a_given_delay_is_left_alone() {
    let (u, _) = resolved();
    assert_eq!(u["T5"].delay_seconds, 45);
}

#[test]
fn a_loop_matches_the_visit_nearest_the_prediction() {
    let (u, _) = resolved();
    assert_eq!(
        u["T_LOOP"].delay_seconds, 60,
        "second visit to S1, not the first"
    );
}

#[test]
fn an_overnight_run_matches_on_the_previous_service_date() {
    let (u, _) = resolved();
    assert_eq!(u["T_NIGHT"].delay_seconds, 300);
}

#[test]
fn a_start_date_pins_the_run_under_both_keys() {
    let (u, _) = resolved();
    // 08:09 on 05-05 would be T8's 05-05 run 1 min early, but the feed dated
    // it 05-04: a day from that run, so not trusted.
    assert_eq!(u["T8"].delay_seconds, 0);
    assert_eq!(u["T8|20260504"].delay_seconds, 0);
}

#[test]
fn a_prediction_that_matches_nothing_keeps_the_fallback() {
    let (u, _) = resolved();
    assert_eq!(u["T3"].delay_seconds, 0, "5 h from any run of T3");
    assert_eq!(u["T6"].delay_seconds, 0, "S9 is not on T6");
}

#[test]
fn no_prediction_survives_resolution_and_every_trip_is_counted_once() {
    let (u, stats) = resolved();
    assert!(u.values().all(|t| t.time_prediction.is_none()));
    // T1 T2 T4 T7 T_LOOP T_NIGHT resolve; T3 T6 T8 don't. T5 carried a delay.
    assert_eq!(
        stats,
        TimePredictionStats {
            resolved: 6,
            unresolved: 3
        }
    );
}

#[test]
fn without_a_generation_predictions_are_dropped_as_unresolved() {
    let mut updates = parse_trip_updates_buffer(fixture()).unwrap();
    let stats = resolve_time_predictions(&mut updates, None);
    assert!(updates.values().all(|t| t.time_prediction.is_none()));
    assert_eq!(updates["T4"].delay_seconds, 30, "fallback stands");
    assert_eq!(
        stats,
        TimePredictionStats {
            resolved: 0,
            unresolved: 9
        }
    );
}

#[test]
fn a_poll_cycle_publishes_resolved_delays_and_reports_them_in_health() {
    let (dir, mut config, _clock) = common::isolated_config();
    config.rt_trip_updates_urls = URL.to_string();
    let gen = Arc::new(generation(dir.path()));
    let ctx = ServerCtx::new(
        Generation::from_paths(
            &common::tiny_ptb_path(),
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .unwrap(),
        config,
        Arc::new(Metrics::default()),
    );
    let state: &RtState = &ctx.rt;
    let mut poller = RtPoller::new(vec![URL.to_string()]).unwrap();

    run_cycle(
        &mut poller,
        state,
        &SystemClock,
        LogFormat::Text,
        &mut |_| Ok(fixture().to_vec()),
        &|| Some(Arc::clone(&gen)),
    );

    let snap = state.load();
    assert_eq!(snap.merged["T1"].delay_seconds, 120);
    assert!(snap.merged.values().all(|t| t.time_prediction.is_none()));
    let body = match rt_health(&ctx) {
        Resp::Json { body, .. } => body,
        _ => panic!("expected Resp::Json"),
    };
    assert!(
        body.contains(r#""timePredictions":{"resolved":6,"unresolved":3}"#),
        "{body}"
    );
}
