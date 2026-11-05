// crates/pt-serve/tests/rt_tile.rs
//
// Integration tests for GET /api/<city>/gtfs/rt-tile/<hash>/<size>/<coords> — full parity flow
// against a real generation built through the production `build_generation` path, on-disk
// schedule-tile fixtures, and a real `ctx.rt` snapshot populated via
// `RtState::publish`/`RtSnapshot::from_merged` (mirrors `tests/rt_health.rs`'s pattern).

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::app::response::Resp;
use pt_serve::app::rt_tile::rt_tile;
use pt_serve::rt::{RtSnapshot, TripUpdate};
use pt_serve::{Generation, Metrics, ServerCtx};
use pt_shared::clock::MockClock;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

const ANCHOR: u64 = 1779494400; // same anchor common::RELOAD_HARNESS_ANCHOR uses

/// Build a real generation (through the production `build_generation` path)
/// over an isolated data root, running `setup` with `(gen_dir, gen_id)`
/// BEFORE the generation is built — mirrors `tests/schedule_tile.rs`'s
/// `ctx_with` exactly, so the on-disk fixture layout is identical.
fn ctx_with(setup: impl FnOnce(&Path, &str)) -> (TempDir, Arc<ServerCtx>, String) {
    let (dir, _config, _clock) = common::isolated_config();
    let data_root = dir.path().to_path_buf();
    let created_at = publisher::rfc3339_format(ANCHOR);
    let gen_id =
        publisher::publish_generation(&data_root, "vilnius", &common::tiny_ptb_path(), &created_at);

    let gen_dir = data_root.join("generations").join(&gen_id);
    setup(&gen_dir, &gen_id);

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
    let ctx = ServerCtx::new(gen, cfg, metrics);
    (dir, ctx, gen_id)
}

/// Hand-build a valid schedule-tile wire JSON (matching
/// `crates/pt-producer/src/schedule_tiles/wire.rs`'s `WireScheduleTile`
/// field names, including a parallel `departureSecs` array — the shared
/// decoder rejects a stop where it's missing or mismatched in length)
/// whose trip membership is exactly `trip_ids`, brotli-compress
/// it (real q=11 encoder — same crate `app::rt_tile` decompresses with), and
/// write it under `<gen_dir>/schedule-tiles/<gen_id>/6km/<cell>.br`, plus a
/// matching `manifest.json` (no subdivisions unless `leaf` is given).
fn write_tile(gen_dir: &Path, gen_id: &str, cell_coords: &str, trip_ids: &[&str]) {
    let string_table: Vec<String> = trip_ids.iter().map(|s| s.to_string()).collect();
    let trips_json: Vec<String> = (0..trip_ids.len())
        .map(|i| format!(r#"{{"tripIdIx":{i},"routeIx":0,"serviceIx":0,"headsignIx":0}}"#))
        .collect();
    let trip_ixs: Vec<String> = (0..trip_ids.len()).map(|i| i.to_string()).collect();
    // `departureSecs` must be a parallel array to `tripIxs` — the shared
    // decoder rejects a stop whose two arrays disagree in length (same
    // check Node's `decodeScheduleTileFromText` makes). Values themselves
    // are never read by trip-membership resolution; any same-length filler
    // works.
    let departure_secs: Vec<String> = (0..trip_ids.len())
        .map(|i| (28_800 + i * 60).to_string())
        .collect();
    let json = format!(
        r#"{{"v":1,"bundleHash":"{gen_id}","cityId":"vilnius","tileSize":6000,"stringTable":[{}],"routes":[],"calendar":[],"trips":[{}],"stops":{{"s1":{{"tripIxs":[{}],"departureSecs":[{}]}}}}}}"#,
        string_table
            .iter()
            .map(|s| format!("\"{s}\""))
            .collect::<Vec<_>>()
            .join(","),
        trips_json.join(","),
        trip_ixs.join(","),
        departure_secs.join(","),
    );
    let mut compressed = Vec::new();
    brotli::BrotliCompress(
        &mut json.as_bytes(),
        &mut compressed,
        &brotli::enc::BrotliEncoderParams::default(),
    )
    .expect("brotli compress fixture tile");

    let st_dir = gen_dir.join("schedule-tiles");
    let tiles_dir = st_dir.join(gen_id).join("6km");
    std::fs::create_dir_all(&tiles_dir).unwrap();
    std::fs::write(tiles_dir.join(format!("{cell_coords}.br")), &compressed).unwrap();
    std::fs::write(
        st_dir.join("manifest.json"),
        format!(r#"{{"schemaVersion":1,"bundleHash":"{gen_id}","generatedAt":1,"tileSize":6000}}"#),
    )
    .unwrap();
}

fn write_subdivided(
    gen_dir: &Path,
    gen_id: &str,
    cell_key: &str,
    leaf_suffix: &str,
    trip_ids: &[&str],
) {
    write_tile(
        gen_dir,
        gen_id,
        &format!("{cell_key}-{leaf_suffix}"),
        trip_ids,
    );
    let st_dir = gen_dir.join("schedule-tiles");
    std::fs::write(
        st_dir.join("manifest.json"),
        format!(
            r#"{{"schemaVersion":1,"bundleHash":"{gen_id}","generatedAt":1,"tileSize":6000,
               "subdivisions":{{"{cell_key}":{{"leaves":[
                 {{"suffix":"{leaf_suffix}","bbox":{{"minLat":0.0,"maxLat":1.0,"minLon":0.0,"maxLon":1.0}},"compressedBytes":1,"oversized":false}}
               ]}}}}}}"#
        ),
    )
    .unwrap();
}

fn write_manifest_only(gen_dir: &Path, gen_id: &str) {
    let st_dir = gen_dir.join("schedule-tiles");
    std::fs::create_dir_all(&st_dir).unwrap();
    std::fs::write(
        st_dir.join("manifest.json"),
        format!(r#"{{"schemaVersion":1,"bundleHash":"{gen_id}","generatedAt":1,"tileSize":6000}}"#),
    )
    .unwrap();
}

fn trip_update(delay_seconds: i32, cancelled: bool) -> TripUpdate {
    TripUpdate {
        delay_seconds,
        cancelled,
        deleted: false,
        time_prediction: None,
    }
}

fn body_of(resp: &Resp) -> (u16, Option<String>) {
    match resp {
        Resp::WithBundleHash {
            status, json_body, ..
        } => (*status, json_body.clone()),
        other => panic!(
            "expected Resp::WithBundleHash, got a different arm ({})",
            match other {
                Resp::Json { .. } => "Json",
                _ => "other",
            }
        ),
    }
}

#[test]
fn success_200_overlays_rt_for_each_trip() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1", "T2"]);
    });
    let mut merged = HashMap::new();
    merged.insert("T1".to_string(), trip_update(60, false));
    ctx.rt.publish(RtSnapshot::from_merged(merged, vec![]));

    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR));
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 200);
    let json = json.unwrap();
    assert!(json.contains(r#""tripId":"T1""#), "{json}");
    assert!(json.contains(r#""delaySeconds":60"#), "{json}");
    assert!(
        !json.contains(r#""tripId":"T2""#),
        "T2 has no RT entry: {json}"
    );
    assert!(json.contains(r#""bundleHash":""#), "{json}");
    assert!(!json.contains("receivedAt"), "{json}");
    match resp {
        Resp::WithBundleHash {
            content_type,
            cache_control,
            bundle_hash,
            vary_accept_encoding,
            ..
        } => {
            assert_eq!(content_type, "application/json");
            assert_eq!(cache_control, Some("no-cache"));
            assert_eq!(bundle_hash.as_deref(), Some(gen_id.as_str()));
            assert!(vary_accept_encoding);
        }
        _ => unreachable!(),
    }
}

#[test]
fn overnight_trip_bare_and_dated_entries_both_appear_independently() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let mut merged = HashMap::new();
    merged.insert("T1".to_string(), trip_update(10, false));
    merged.insert("T1|20260721".to_string(), trip_update(20, false));
    merged.insert("T1|20260722".to_string(), trip_update(30, true));
    ctx.rt.publish(RtSnapshot::from_merged(merged, vec![]));

    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR));
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 200);
    let json = json.unwrap();
    // All three entries for T1 must appear independently — no merge/precedence.
    assert!(json.contains(r#""delaySeconds":10"#), "{json}");
    assert!(json.contains(r#""delaySeconds":20"#), "{json}");
    assert!(json.contains(r#""delaySeconds":30"#), "{json}");
    assert!(json.contains(r#""startDate":"20260721""#), "{json}");
    assert!(json.contains(r#""startDate":"20260722""#), "{json}");
    let trips_count = json.matches(r#""tripId":"T1""#).count();
    assert_eq!(trips_count, 3, "{json}");
}

#[test]
fn a_deleted_trip_says_so_and_no_other_trip_carries_the_field() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1", "T2"]);
    });
    let mut merged = HashMap::new();
    merged.insert("T1".to_string(), trip_update(0, false));
    merged.insert(
        "T2".to_string(),
        TripUpdate {
            delay_seconds: 0,
            cancelled: false,
            deleted: true,
            time_prediction: None,
        },
    );
    ctx.rt.publish(RtSnapshot::from_merged(merged, vec![]));
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR));
    let (status, json) = body_of(&rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34"));
    assert_eq!(status, 200);
    let json = json.unwrap();
    assert_eq!(json.matches(r#""deleted":true"#).count(), 1, "{json}");
    assert!(!json.contains(r#""deleted":false"#), "{json}");
}

#[test]
fn trip_with_no_rt_entry_is_omitted() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR));
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 200);
    assert_eq!(
        json.unwrap(),
        format!(
            r#"{{"bundleHash":"{gen_id}","generatedAt":{},"trips":[]}}"#,
            ANCHOR * 1000
        )
    );
}

#[test]
fn response_cache_hit_skips_disk_and_rt_relookup() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let mut merged = HashMap::new();
    merged.insert("T1".to_string(), trip_update(60, false));
    ctx.rt.publish(RtSnapshot::from_merged(merged, vec![]));

    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR));
    let first = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    assert_eq!(body_of(&first).0, 200);

    // Delete the tile AND change the RT snapshot — a cache hit must still
    // serve the ORIGINAL body.
    let tile_path = gen
        .schedule_tiles_dir
        .as_ref()
        .unwrap()
        .join("6km")
        .join("12_34.br");
    std::fs::remove_file(&tile_path).unwrap();
    let mut merged2 = HashMap::new();
    merged2.insert("T1".to_string(), trip_update(999, true));
    ctx.rt.publish(RtSnapshot::from_merged(merged2, vec![]));

    let second = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    let (status, json) = body_of(&second);
    assert_eq!(status, 200, "cache hit must survive the file deletion");
    assert!(json.unwrap().contains(r#""delaySeconds":60"#));
}

#[test]
fn response_cache_expires_after_ttl_and_refreshes_rt() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let mut merged = HashMap::new();
    merged.insert("T1".to_string(), trip_update(60, false));
    ctx.rt.publish(RtSnapshot::from_merged(merged, vec![]));

    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR));
    let first = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    assert!(body_of(&first).1.unwrap().contains(r#""delaySeconds":60"#));

    let mut merged2 = HashMap::new();
    merged2.insert("T1".to_string(), trip_update(70, false));
    ctx.rt.publish(RtSnapshot::from_merged(merged2, vec![]));
    clock.advance(Duration::from_millis(10_001)); // past the 10s TTL default

    let second = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    assert!(body_of(&second).1.unwrap().contains(r#""delaySeconds":70"#));
}

#[test]
fn bundle_hash_mismatch_is_409() {
    let (_dir, ctx, _gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let wrong_hash = "b".repeat(64);
    let resp = rt_tile(&ctx, &gen, &clock, &wrong_hash, "6km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 409);
    let json = json.unwrap();
    assert!(json.contains(r#""error":"bundle_hash_mismatch""#), "{json}");
    assert!(json.contains(&gen.generation_id), "{json}");
}

#[test]
fn no_schedule_tile_build_is_409_unavailable() {
    let (_dir, ctx, gen_id) = ctx_with(|_gen_dir, _gid| {});
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 409);
    assert_eq!(json.unwrap(), r#"{"error":"bundle_unavailable"}"#);
}

#[test]
fn manifest_present_but_tiles_dir_missing_is_409_unavailable() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_manifest_only(gen_dir, gid);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 409);
    assert_eq!(json.unwrap(), r#"{"error":"bundle_unavailable"}"#);
}

#[test]
fn unreadable_tile_file_is_503() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        let st_dir = gen_dir.join("schedule-tiles");
        let tile_as_dir = st_dir.join(gid).join("6km").join("12_34.br");
        std::fs::create_dir_all(&tile_as_dir).unwrap();
        std::fs::write(
            st_dir.join("manifest.json"),
            format!(
                r#"{{"schemaVersion":1,"bundleHash":"{gid}","generatedAt":1,"tileSize":6000}}"#
            ),
        )
        .unwrap();
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 503);
    assert!(json.unwrap().contains("TILE_READ_ERROR"));
}

#[test]
fn corrupt_brotli_is_503() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        let st_dir = gen_dir.join("schedule-tiles");
        let tiles_dir = st_dir.join(gid).join("6km");
        std::fs::create_dir_all(&tiles_dir).unwrap();
        std::fs::write(tiles_dir.join("12_34.br"), b"not-valid-brotli-bytes").unwrap();
        std::fs::write(
            st_dir.join("manifest.json"),
            format!(
                r#"{{"schemaVersion":1,"bundleHash":"{gid}","generatedAt":1,"tileSize":6000}}"#
            ),
        )
        .unwrap();
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 503);
    assert!(json.unwrap().contains("TILE_READ_ERROR"));
}

/// The gap between `manifest_present_but_tiles_dir_missing_is_409_unavailable`
/// and `unreadable_tile_file_is_503`: the dir is there, the file simply is not.
/// Node gates this with `existsSync(tilePath)` and answers 409
/// `bundle_unavailable` (routes/rtTile.ts) — "the build has not written this
/// tile yet, retry". pt-serve used to answer 503 `TILE_READ_ERROR` here,
/// because the read was `fs::read(..).ok()` and discarded the `ErrorKind`. No
/// test covered the case, so nothing caught the divergence.
#[test]
fn absent_tile_file_with_tiles_dir_present_is_409_unavailable() {
    // Writing SOME tile creates `6km/` and the manifest; `99_99` has no file.
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "99_99");
    let (status, json) = body_of(&resp);
    assert_eq!(
        status, 409,
        "absent tile file must not read as a read error"
    );
    assert_eq!(json.unwrap(), r#"{"error":"bundle_unavailable"}"#);
}

/// A decode failure must still be 503 — the 409 arm above is keyed on
/// `ErrorKind::NotFound` alone and must not swallow the corrupt-tile case.
/// `corrupt_brotli_is_503` covers that from the other side; this asserts the
/// two arms stay distinct for the SAME coord, which is what a future
/// simplification of the match would break.
#[test]
fn absent_and_corrupt_are_different_statuses_for_the_same_coord() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);

    let absent = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "77_77");
    assert_eq!(body_of(&absent).0, 409);

    // Same coord, now present but not valid brotli.
    let tiles_dir = ctx
        .current_generation()
        .schedule_tiles_dir
        .clone()
        .expect("tiles dir")
        .join("6km");
    std::fs::write(tiles_dir.join("77_77.br"), b"not-valid-brotli-bytes").unwrap();
    let corrupt = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "77_77");
    assert_eq!(body_of(&corrupt).0, 503);
}

/// `pt_serve_rt_tile_cache_total` is the counter the flip is verified with —
/// the route's premise is that the 10 s TTL response cache absorbs polling, and
/// nothing else this process emits would show that cache going cold.
#[test]
fn cache_counters_record_response_miss_then_hit() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);

    assert_eq!(
        body_of(&rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34")).0,
        200
    );
    assert_eq!(ctx.metrics.rt_tile_cache_total("response", "miss"), 1);
    assert_eq!(ctx.metrics.rt_tile_cache_total("membership", "miss"), 1);

    // Second request inside the TTL: served from the response cache, which
    // returns BEFORE the membership cache is consulted — so membership must
    // not move. That ordering is the point of the two separate series.
    assert_eq!(
        body_of(&rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "12_34")).0,
        200
    );
    assert_eq!(ctx.metrics.rt_tile_cache_total("response", "hit"), 1);
    assert_eq!(ctx.metrics.rt_tile_cache_total("response", "miss"), 1);
    assert_eq!(ctx.metrics.rt_tile_cache_total("membership", "hit"), 0);
    assert_eq!(ctx.metrics.rt_tile_cache_total("membership", "miss"), 1);
}

/// The case the membership cache exists for: the response body expired but the
/// decoded trip list did not, so the tile is NOT re-read and re-decoded. If
/// this ever regresses to a membership miss, every poll past the TTL pays a
/// disk read plus a brotli decompress on the request thread.
#[test]
fn membership_cache_hits_after_the_response_ttl_expires() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let cold = MockClock::new(SystemTime::UNIX_EPOCH);
    assert_eq!(
        body_of(&rt_tile(&ctx, &gen, &cold, &gen_id, "6km", "12_34")).0,
        200
    );

    // Past the 10 s response-cache TTL. Membership is epoch-gated with no TTL,
    // so it survives.
    let later = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(11));
    assert_eq!(
        body_of(&rt_tile(&ctx, &gen, &later, &gen_id, "6km", "12_34")).0,
        200
    );
    assert_eq!(ctx.metrics.rt_tile_cache_total("response", "miss"), 2);
    assert_eq!(ctx.metrics.rt_tile_cache_total("response", "hit"), 0);
    assert_eq!(ctx.metrics.rt_tile_cache_total("membership", "hit"), 1);
    assert_eq!(ctx.metrics.rt_tile_cache_total("membership", "miss"), 1);
}

/// Exits that return before either cache is consulted must record nothing —
/// which is why these series deliberately do NOT sum to
/// `requests_total{route="rt-tile"}`.
#[test]
fn pre_cache_exits_record_no_cache_consultation() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);

    assert_eq!(
        body_of(&rt_tile(&ctx, &gen, &clock, "nothex", "6km", "12_34")).0,
        400
    );
    assert_eq!(
        body_of(&rt_tile(&ctx, &gen, &clock, &gen_id, "9km", "12_34")).0,
        400
    );
    assert_eq!(
        body_of(&rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "bad")).0,
        400
    );
    assert_eq!(
        body_of(&rt_tile(
            &ctx,
            &gen,
            &clock,
            &"b".repeat(64),
            "6km",
            "12_34"
        ))
        .0,
        409
    );

    for cache in ["response", "membership"] {
        for outcome in ["hit", "miss"] {
            assert_eq!(
                ctx.metrics.rt_tile_cache_total(cache, outcome),
                0,
                "{cache}/{outcome} moved on a pre-cache exit"
            );
        }
    }
}

#[test]
fn bare_coord_on_subdivided_cell_is_404_tile_subdivided_with_no_leaves_field() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_subdivided(gen_dir, gid, "5_5", "0", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "5_5");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 404);
    let json = json.unwrap();
    assert_eq!(
        json, r#"{"error":"tile_subdivided"}"#,
        "no leaves array here"
    );
}

#[test]
fn known_leaf_coord_on_subdivided_cell_serves_200() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_subdivided(gen_dir, gid, "5_5", "0", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "5_5-0");
    let (status, _json) = body_of(&resp);
    assert_eq!(status, 200);
}

#[test]
fn unknown_leaf_coord_is_404_tile_not_found() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_subdivided(gen_dir, gid, "5_5", "0", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "5_5-1");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 404);
    assert_eq!(json.unwrap(), r#"{"error":"tile_not_found"}"#);
}

#[test]
fn leaf_coord_on_a_cell_with_no_plan_at_all_is_404_tile_not_found() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "5_5-0");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 404);
    assert_eq!(json.unwrap(), r#"{"error":"tile_not_found"}"#);
}

#[test]
fn subdivision_gate_runs_before_any_cache_lookup_even_with_a_warm_response_cache() {
    // Prime the response cache for the BARE coord under a DIFFERENT
    // generation's tiles setup is not directly testable here without a
    // reload; instead prove the gate order the other way: a subdivided
    // cell's bare coord must 404 even though nothing has been read from
    // disk or cached yet (i.e. the gate cannot have been skipped by a
    // phantom cache hit on a fresh cache).
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_subdivided(gen_dir, gid, "5_5", "0", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "5_5");
    assert_eq!(body_of(&resp).0, 404);
    // The membership cache must remain untouched by the subdivided bare
    // request (no disk read ever happened for it).
    assert!(ctx
        .rt_tile_membership_cache
        .get(gen.epoch, "6km/5_5")
        .is_none());
}

#[test]
fn invalid_bundle_hash_is_400() {
    let (_dir, ctx, _gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, "not-64-hex", "6km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 400);
    assert!(json.unwrap().contains("INVALID_BUNDLE_HASH"));
    match resp {
        Resp::WithBundleHash { bundle_hash, .. } => {
            assert!(bundle_hash.is_none(), "no hash known yet on a 400")
        }
        _ => unreachable!(),
    }
}

#[test]
fn wrong_tile_size_is_400() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "12km", "12_34");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 400);
    assert!(json.unwrap().contains("TILE_SIZE_MISMATCH"));
}

#[test]
fn invalid_tile_coords_is_400() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_tile(gen_dir, gid, "12_34", &["T1"]);
    });
    let gen = ctx.current_generation();
    let clock = MockClock::new(SystemTime::UNIX_EPOCH);
    let resp = rt_tile(&ctx, &gen, &clock, &gen_id, "6km", "not-a-coord");
    let (status, json) = body_of(&resp);
    assert_eq!(status, 400);
    assert!(json.unwrap().contains("INVALID_TILE_COORDS"));
}
