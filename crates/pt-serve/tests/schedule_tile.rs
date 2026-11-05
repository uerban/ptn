// crates/pt-serve/tests/schedule_tile.rs
//
// Integration tests for GET /api/<city>/gtfs/schedule-tile/<hash>/<size>/<coords> — full 10-step
// parity flow against a real generation built through the production `build_generation` path (same
// as the reload harness), with on-disk schedule-tile fixtures laid down under the generation dir.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::app::response::{ByteBody, Resp};
use pt_serve::app::schedule_tile::schedule_tile;
use pt_serve::{Generation, Metrics, ServerCtx};
use pt_shared::clock::MockClock;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

const ANCHOR: u64 = 1779494400; // same anchor common::RELOAD_HARNESS_ANCHOR uses

/// Build a real generation (through the production `build_generation` path)
/// over an isolated data root, running `setup` with `(gen_dir, gen_id)`
/// BEFORE the generation is built — so the callback can lay down
/// `schedule-tiles/manifest.json` + `.br` fixtures for `load_schedule_tiles`
/// to pick up.
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

/// Lay down `schedule-tiles/manifest.json` (no subdivisions) + one bare-cell
/// `.br` fixture file under `gen_dir`.
fn write_simple_tile(gen_dir: &Path, gen_id: &str, cell_coords: &str, bytes: &[u8]) {
    let st_dir = gen_dir.join("schedule-tiles");
    let tiles_dir = st_dir.join(gen_id).join("6km");
    std::fs::create_dir_all(&tiles_dir).unwrap();
    std::fs::write(tiles_dir.join(format!("{cell_coords}.br")), bytes).unwrap();
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
    leaf_bytes: &[u8],
) {
    let st_dir = gen_dir.join("schedule-tiles");
    let tiles_dir = st_dir.join(gen_id).join("6km");
    std::fs::create_dir_all(&tiles_dir).unwrap();
    std::fs::write(
        tiles_dir.join(format!("{cell_key}-{leaf_suffix}.br")),
        leaf_bytes,
    )
    .unwrap();
    std::fs::write(
        st_dir.join("manifest.json"),
        format!(
            r#"{{"schemaVersion":1,"bundleHash":"{gen_id}","generatedAt":1,"tileSize":6000,
               "subdivisions":{{"{cell_key}":{{"leaves":[
                 {{"suffix":"{leaf_suffix}","bbox":{{"minLat":0.0,"maxLat":1.0,"minLon":0.0,"maxLon":1.0}},"compressedBytes":{},"oversized":false}}
               ]}}}}}}"#,
            leaf_bytes.len()
        ),
    )
    .unwrap();
}

/// Lay down ONLY `schedule-tiles/manifest.json` — simulates a build that
/// wrote the manifest but crashed before writing the `<gen_id>/` tile-body
/// directory. `schedule_tiles_dir` is a computed path (always `Some` once
/// the manifest parses), so this exercises the explicit `tiles_dir.is_dir()`
/// gate distinct from "manifest absent entirely".
fn write_manifest_only(gen_dir: &Path, gen_id: &str) {
    let st_dir = gen_dir.join("schedule-tiles");
    std::fs::create_dir_all(&st_dir).unwrap();
    std::fs::write(
        st_dir.join("manifest.json"),
        format!(r#"{{"schemaVersion":1,"bundleHash":"{gen_id}","generatedAt":1,"tileSize":6000}}"#),
    )
    .unwrap();
}

fn body_of(resp: &Resp) -> (u16, Option<String>, Option<Vec<u8>>) {
    match resp {
        Resp::WithBundleHash {
            status,
            json_body,
            body,
            ..
        } => {
            let bytes = body.as_ref().map(|b| match b {
                ByteBody::Raw(a) => a.to_vec(),
                _ => panic!("expected Raw byte body in tests"),
            });
            (*status, json_body.clone(), bytes)
        }
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
fn success_200_serves_raw_bytes_with_all_headers() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_simple_tile(gen_dir, gid, "12_34", b"fake-brotli-bytes");
    });
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "12_34", None);
    let (status, json, bytes) = body_of(&resp);
    assert_eq!(status, 200);
    assert!(json.is_none());
    assert_eq!(bytes.unwrap(), b"fake-brotli-bytes");
    match resp {
        Resp::WithBundleHash {
            content_type,
            cache_control,
            etag,
            bundle_hash,
            ..
        } => {
            assert_eq!(content_type, "application/octet-stream");
            assert_eq!(cache_control, Some("public, max-age=31536000, immutable"));
            assert!(etag.is_some());
            assert_eq!(bundle_hash.as_deref(), Some(gen_id.as_str()));
        }
        _ => unreachable!(),
    }
}

#[test]
fn matching_etag_returns_304() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_simple_tile(gen_dir, gid, "12_34", b"fake-brotli-bytes");
    });
    let gen = ctx.current_generation();
    let first = schedule_tile(&ctx, &gen, &gen_id, "6km", "12_34", None);
    let etag = match &first {
        Resp::WithBundleHash { etag, .. } => etag.clone().unwrap(),
        _ => unreachable!(),
    };
    let second = schedule_tile(&ctx, &gen, &gen_id, "6km", "12_34", Some(&etag));
    let (status, _json, bytes) = body_of(&second);
    assert_eq!(status, 304);
    assert!(bytes.is_none());
}

#[test]
fn bundle_hash_mismatch_is_409() {
    let (_dir, ctx, _gen_id) = ctx_with(|gen_dir, gid| {
        write_simple_tile(gen_dir, gid, "12_34", b"bytes");
    });
    let gen = ctx.current_generation();
    let wrong_hash = "b".repeat(64);
    let resp = schedule_tile(&ctx, &gen, &wrong_hash, "6km", "12_34", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 409);
    let json = json.unwrap();
    assert!(json.contains(r#""error":"bundle_hash_mismatch""#), "{json}");
    assert!(json.contains(&gen.generation_id), "{json}");
}

#[test]
fn no_schedule_tile_build_is_409_unavailable() {
    // setup does nothing — this generation has no schedule-tiles/ dir at all.
    let (_dir, ctx, gen_id) = ctx_with(|_gen_dir, _gid| {});
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "12_34", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 409);
    assert_eq!(json.unwrap(), r#"{"error":"bundle_unavailable"}"#);
}

#[test]
fn manifest_present_but_tiles_dir_missing_is_409_unavailable() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_manifest_only(gen_dir, gid);
    });
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "12_34", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 409);
    assert_eq!(json.unwrap(), r#"{"error":"bundle_unavailable"}"#);
}

#[test]
fn unreadable_tile_file_is_503() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        // Make "12_34.br" a DIRECTORY instead of a file — std::fs::read then
        // fails with a non-NotFound error, hitting the 503 branch.
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
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "12_34", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 503);
    assert!(json.unwrap().contains("TILE_READ_ERROR"));
}

#[test]
fn bare_coord_on_subdivided_cell_is_404_tile_subdivided() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_subdivided(gen_dir, gid, "5_5", "0", b"leaf-bytes");
    });
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "5_5", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 404);
    let json = json.unwrap();
    assert!(json.contains(r#""error":"tile_subdivided""#), "{json}");
    assert!(json.contains(r#""leaves":["0"]"#), "{json}");
}

#[test]
fn known_leaf_coord_on_subdivided_cell_serves_200() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_subdivided(gen_dir, gid, "5_5", "0", b"leaf-bytes");
    });
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "5_5-0", None);
    let (status, _json, bytes) = body_of(&resp);
    assert_eq!(status, 200);
    assert_eq!(bytes.unwrap(), b"leaf-bytes");
}

#[test]
fn unknown_leaf_coord_is_404_tile_not_found() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_subdivided(gen_dir, gid, "5_5", "0", b"leaf-bytes");
    });
    let gen = ctx.current_generation();
    // suffix "1" was never planned for cell 5_5 (only "0" was).
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "5_5-1", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 404);
    assert_eq!(json.unwrap(), r#"{"error":"tile_not_found"}"#);
}

#[test]
fn leaf_coord_on_a_cell_with_no_plan_at_all_is_404_tile_not_found() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        // "5_5" has no subdivision plan whatsoever — a leaf request against
        // it is not-found (distinct code path from "known cell, unknown
        // leaf" above: `plan` itself is `None`, not `Some` with a miss).
        write_simple_tile(gen_dir, gid, "12_34", b"bytes");
    });
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "5_5-0", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 404);
    assert_eq!(json.unwrap(), r#"{"error":"tile_not_found"}"#);
}

#[test]
fn missing_file_on_unsubdivided_cell_is_404_tile_not_found() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        // manifest present (so we pass the 409 gate) but no matching .br file.
        write_simple_tile(gen_dir, gid, "12_34", b"bytes");
    });
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "99_99", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 404);
    assert_eq!(json.unwrap(), r#"{"error":"tile_not_found"}"#);
}

#[test]
fn invalid_bundle_hash_is_400() {
    let (_dir, ctx, _gen_id) = ctx_with(|gen_dir, gid| {
        write_simple_tile(gen_dir, gid, "12_34", b"bytes");
    });
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, "not-64-hex", "6km", "12_34", None);
    let (status, json, _) = body_of(&resp);
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
        write_simple_tile(gen_dir, gid, "12_34", b"bytes");
    });
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, &gen_id, "12km", "12_34", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 400);
    assert!(json.unwrap().contains("TILE_SIZE_MISMATCH"));
}

#[test]
fn invalid_tile_coords_is_400() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_simple_tile(gen_dir, gid, "12_34", b"bytes");
    });
    let gen = ctx.current_generation();
    let resp = schedule_tile(&ctx, &gen, &gen_id, "6km", "not-a-coord", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 400);
    assert!(json.unwrap().contains("INVALID_TILE_COORDS"));
}

#[test]
fn cache_hit_serves_without_touching_disk_again() {
    let (_dir, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_simple_tile(gen_dir, gid, "12_34", b"fake-brotli-bytes");
    });
    let gen = ctx.current_generation();
    let first = schedule_tile(&ctx, &gen, &gen_id, "6km", "12_34", None);
    assert_eq!(body_of(&first).0, 200);

    // Delete the on-disk tile — a cache hit must still serve it from memory.
    let tile_path = gen
        .schedule_tiles_dir
        .as_ref()
        .unwrap()
        .join("6km")
        .join("12_34.br");
    std::fs::remove_file(&tile_path).unwrap();

    let second = schedule_tile(&ctx, &gen, &gen_id, "6km", "12_34", None);
    let (status, _json, bytes) = body_of(&second);
    assert_eq!(status, 200, "cache hit must survive the file deletion");
    assert_eq!(bytes.unwrap(), b"fake-brotli-bytes");
}
