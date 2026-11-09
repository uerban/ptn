// crates/pt-serve/tests/gtfs_manifest.rs
//
// Integration tests for GET /api/<city>/gtfs/manifest — the schedule-tile read
// path's entry point. Built against a real generation through the production
// `build_generation` path (same harness as tests/schedule_tile.rs), with
// on-disk `schedule-tiles/manifest.json` fixtures.
//
// Parity target: packages/backend/src/routes/gtfsManifest.ts and its four
// tests in packages/backend/src/routes/gtfsManifest.test.ts.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::app::gtfs_manifest::gtfs_manifest;
use pt_serve::app::response::{ByteBody, Resp};
use pt_serve::{Generation, Metrics, ServerCtx};
use pt_shared::clock::MockClock;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

const ANCHOR: u64 = 1779494400;

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

/// Write `schedule-tiles/manifest.json` verbatim (the caller controls the
/// exact bytes, which is the point for a byte-parity route).
fn write_manifest(gen_dir: &Path, text: &str) {
    let st_dir = gen_dir.join("schedule-tiles");
    std::fs::create_dir_all(&st_dir).unwrap();
    std::fs::write(st_dir.join("manifest.json"), text).unwrap();
}

/// The producer's real output shape: pretty-printed, two-space indent
/// (`serde_json::to_vec_pretty` in `schedule_tiles/artifacts.rs`).
fn pretty_manifest(gen_id: &str) -> String {
    format!(
        "{{\n  \"schemaVersion\": 1,\n  \"bundleHash\": \"{gen_id}\",\n  \"generatedAt\": 1752300000000,\n  \"tileSize\": 6000\n}}"
    )
}

struct Parts {
    status: u16,
    body: Option<Vec<u8>>,
    json_body: Option<String>,
    etag: Option<String>,
    bundle_hash: Option<String>,
    cache_control: Option<String>,
    vary: bool,
}

fn parts_of(resp: &Resp) -> Parts {
    match resp {
        Resp::WithBundleHash {
            status,
            cache_control,
            body,
            json_body,
            etag,
            bundle_hash,
            vary_accept_encoding,
            ..
        } => Parts {
            status: *status,
            body: body.as_ref().map(|b| match b {
                ByteBody::Raw(a) => a.to_vec(),
                _ => panic!("expected Raw byte body"),
            }),
            json_body: json_body.clone(),
            etag: etag.clone(),
            bundle_hash: bundle_hash.clone(),
            cache_control: cache_control.map(str::to_string),
            vary: *vary_accept_encoding,
        },
        _ => panic!("expected Resp::WithBundleHash"),
    }
}

/// Node: "200 body == snapshot.parsed, ETag from contentEtag". The body is the
/// COMPACT re-serialisation, not the pretty-printed file — that is the whole
/// parity risk this route carries.
#[test]
fn two_hundred_serves_compact_json_not_the_pretty_file() {
    let (_d, ctx, gen_id) = ctx_with(|gen_dir, gid| write_manifest(gen_dir, &pretty_manifest(gid)));
    let gen = ctx.current_generation();
    let p = parts_of(&gtfs_manifest(&gen, None));

    assert_eq!(p.status, 200);
    let body = String::from_utf8(p.body.expect("200 has a body")).unwrap();
    assert_eq!(
        body,
        format!(
            r#"{{"schemaVersion":1,"bundleHash":"{gen_id}","generatedAt":1752300000000,"tileSize":6000}}"#
        )
    );
    assert!(!body.contains('\n'), "body must be compact");
    assert_eq!(p.cache_control.as_deref(), Some("no-cache"));
    assert_eq!(p.bundle_hash.as_deref(), Some(gen_id.as_str()));
    assert!(p.vary, "200 carries Vary: Accept-Encoding");
}

/// The ETag is sha256 over the RAW FILE BYTES truncated to 32 hex chars, then
/// quoted — Node's `contentEtag` (`gtfs/scheduler.ts`). Deriving it from the
/// served body instead would silently diverge, since the two differ.
#[test]
fn etag_is_the_truncated_sha256_of_the_file_not_of_the_body() {
    let (_d, ctx, gid) = ctx_with(|gen_dir, gid| write_manifest(gen_dir, &pretty_manifest(gid)));
    let gen = ctx.current_generation();
    let p = parts_of(&gtfs_manifest(&gen, None));

    let file_sha = {
        use sha2::{Digest, Sha256};
        let bytes = pretty_manifest(&gid).into_bytes();
        format!("{:x}", Sha256::digest(&bytes))
    };
    assert_eq!(
        p.etag.as_deref(),
        Some(format!("\"{}\"", &file_sha[..32])).as_deref()
    );
}

/// Node: "304 when If-None-Match matches" — ETag + X-PT-Bundle-Hash only, no
/// body, no Cache-Control, no Vary.
#[test]
fn matching_if_none_match_yields_a_bare_304() {
    let (_d, ctx, gen_id) = ctx_with(|gen_dir, gid| write_manifest(gen_dir, &pretty_manifest(gid)));
    let gen = ctx.current_generation();
    let etag = parts_of(&gtfs_manifest(&gen, None))
        .etag
        .expect("200 has an ETag");

    let p = parts_of(&gtfs_manifest(&gen, Some(&etag)));
    assert_eq!(p.status, 304);
    assert!(p.body.is_none() && p.json_body.is_none(), "304 has no body");
    assert_eq!(p.etag.as_deref(), Some(etag.as_str()));
    assert_eq!(p.bundle_hash.as_deref(), Some(gen_id.as_str()));
    assert_eq!(p.cache_control, None);
    assert!(!p.vary);
}

#[test]
fn weak_listed_or_proxy_suffixed_if_none_match_yields_a_304() {
    let (_d, ctx, _) = ctx_with(|gen_dir, gid| write_manifest(gen_dir, &pretty_manifest(gid)));
    let gen = ctx.current_generation();
    let etag = parts_of(&gtfs_manifest(&gen, None))
        .etag
        .expect("200 has an ETag");
    let opaque = etag.trim_matches('"');
    for header in [
        format!("W/{etag}"),
        format!("\"other\", {etag}"),
        format!("\"{opaque}-br\""),
    ] {
        assert_eq!(
            parts_of(&gtfs_manifest(&gen, Some(&header))).status,
            304,
            "{header}"
        );
    }
}

#[test]
fn stale_if_none_match_yields_a_fresh_200() {
    let (_d, ctx, _) = ctx_with(|gen_dir, gid| write_manifest(gen_dir, &pretty_manifest(gid)));
    let gen = ctx.current_generation();
    let p = parts_of(&gtfs_manifest(
        &gen,
        Some("\"0000000000000000000000000000000\""),
    ));
    assert_eq!(p.status, 200);
    assert!(p.body.is_some());
}

/// Node: "503 MANIFEST_UNAVAILABLE on cold start". pt-serve reaches the same
/// arm when the generation carries no schedule-tile build at all.
#[test]
fn missing_schedule_tile_build_yields_the_node_503_body() {
    let (_d, ctx, _) = ctx_with(|_gen_dir, _gid| {});
    let gen = ctx.current_generation();
    let p = parts_of(&gtfs_manifest(&gen, None));

    assert_eq!(p.status, 503);
    assert_eq!(
        p.json_body.as_deref(),
        Some(
            r#"{"error":{"code":"MANIFEST_UNAVAILABLE","message":"No bundle has been published yet"}}"#
        )
    );
    // Deliberate divergence: Node can report a previous-good hash here because
    // its snapshot can go stale mid-rename. pt-serve adopts generations
    // atomically, so no such hash exists.
    assert_eq!(p.bundle_hash, None);
    assert_eq!(p.etag, None);
}

/// The reason this route re-emits the source text instead of serialising
/// `ScheduleTileManifest`: that struct drops unknown fields by design, while
/// Node echoes whatever the file holds.
#[test]
fn unknown_producer_fields_survive_into_the_response() {
    let (_d, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_manifest(
            gen_dir,
            &format!(
                "{{\n  \"schemaVersion\": 1,\n  \"bundleHash\": \"{gid}\",\n  \"generatedAt\": 1,\n  \"tileSize\": 6000,\n  \"futureRevField\": {{\"nested\": [1, true]}}\n}}"
            ),
        )
    });
    let gen = ctx.current_generation();
    let body = String::from_utf8(parts_of(&gtfs_manifest(&gen, None)).body.unwrap()).unwrap();
    assert_eq!(
        body,
        format!(
            r#"{{"schemaVersion":1,"bundleHash":"{gen_id}","generatedAt":1,"tileSize":6000,"futureRevField":{{"nested":[1,true]}}}}"#
        )
    );
}

/// Integral-valued `bbox` corners are the reachable number-formatting trap:
/// serde_json writes `54.0`, JS writes `54`.
#[test]
fn integral_bbox_corners_render_the_way_javascript_would() {
    let (_d, ctx, _) = ctx_with(|gen_dir, gid| {
        write_manifest(
            gen_dir,
            &format!(
                r#"{{"schemaVersion":1,"bundleHash":"{gid}","generatedAt":1,"tileSize":6000,"subdivisions":{{"1_2":{{"leaves":[{{"suffix":"0","bbox":{{"minLat":54.0,"maxLat":54.5,"minLon":25.0,"maxLon":25.25}},"compressedBytes":123,"oversized":false}}]}}}}}}"#
            ),
        )
    });
    let gen = ctx.current_generation();
    let body = String::from_utf8(parts_of(&gtfs_manifest(&gen, None)).body.unwrap()).unwrap();
    assert!(
        body.contains(r#""minLat":54,"maxLat":54.5,"minLon":25,"maxLon":25.25"#),
        "integral corners must lose the decimal point: {body}"
    );
}

/// Key order follows the file, not an alphabetical or struct-declaration
/// order — a client diffing bodies across the two planes would see any
/// reordering as a change.
#[test]
fn field_order_follows_the_file() {
    let (_d, ctx, gen_id) = ctx_with(|gen_dir, gid| {
        write_manifest(
            gen_dir,
            &format!(
                r#"{{"tileSize":6000,"bundleHash":"{gid}","schemaVersion":1,"generatedAt":1}}"#
            ),
        )
    });
    let gen = ctx.current_generation();
    let body = String::from_utf8(parts_of(&gtfs_manifest(&gen, None)).body.unwrap()).unwrap();
    assert_eq!(
        body,
        format!(r#"{{"tileSize":6000,"bundleHash":"{gen_id}","schemaVersion":1,"generatedAt":1}}"#)
    );
}
