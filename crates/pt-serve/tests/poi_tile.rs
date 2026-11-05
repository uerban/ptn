// crates/pt-serve/tests/poi_tile.rs
//
// Integration tests for GET /api/gtfs/poi-tile/<cityId>/<tileSize>/<tileCoords>
// - mirrors poiTile.test.ts's scenarios. Artifact-path tests write a real
// manifest and `.br` bundle under `poi_bundle_dir`.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::app::poi_tile::{poi_tile, poi_tile_with_version};
use pt_serve::app::response::{ByteBody, Resp};
use pt_serve::ops::ServerConfig;
use pt_serve::poi::PoiTileBounds;
use pt_serve::{Metrics, ServerCtx};
use pt_shared::clock::MockClock;
use pt_shared::poi_tile_grid::{tile_key_at, TileAnchor};
use std::io::Read as _;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

const ANCHOR: u64 = 1779494400;

// Published Vilnius anchor used by hand-built fixtures.
fn vilnius_anchor() -> TileAnchor {
    TileAnchor {
        min_lat: 54.58,
        min_lon: 25.08,
        ref_lat: (54.58 + 54.78) / 2.0,
    }
}

/// Build a real `ServerCtx` (through the production `build_generation`
/// path, same as `tests/rt_tile.rs::ctx_with`) — poi-tile touches no
/// `Generation` field, but `ServerCtx::new` still requires one.
/// `tweak` receives the SAME data-root path the returned `TempDir` wraps
/// (so a test can compute e.g. `data_root.join("bundles")` and reuse the
/// identical path after `ctx_with` returns) and mutates the config before
/// construction (`poi_bundle_dir`, `poi_tile_cache_max_entries`, ...).
fn ctx_with(tweak: impl FnOnce(&Path, &mut ServerConfig)) -> (TempDir, Arc<ServerCtx>) {
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
    let gen = pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
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

    let mut cfg = common::default_test_config(data_root.clone());
    tweak(&data_root, &mut cfg);
    let ctx = ServerCtx::new(gen, cfg, metrics);
    (dir, ctx)
}

fn entry_json(id: &str, lat: f64, lon: f64) -> String {
    format!(
        r#"{{"id":"{id}","name":"POI {id}","aliases":{{}},"category":"landmark","lat":{lat},"lon":{lon},"source":"osm","rankBoost":0,"tier":"strict"}}"#
    )
}

/// Write a real brotli-compressed `<cityId>.br` bundle under `dir`,
/// matching `PoiBundle`'s wire shape.
#[allow(clippy::too_many_arguments)] // Parameters intentionally mirror manifest fields.
fn write_manifest(
    dir: &Path,
    city_id: &str,
    size_bytes: usize,
    sha256: &str,
    edge_km: f64,
    anchor: TileAnchor,
    tile_bounds: PoiTileBounds,
    delivery_active: bool,
) {
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "generatedAt": 0,
        "bundles": [{
            "cityId": city_id,
            "filename": format!("{city_id}.br"),
            "sizeBytes": size_bytes,
            "sha256": sha256,
            "poiTile": {
                "edgeKm": edge_km,
                "anchor": {
                    "minLat": anchor.min_lat,
                    "minLon": anchor.min_lon,
                    "refLat": anchor.ref_lat,
                },
                "tilingPolicy": "fixed-edge",
                "kAnonWaived": true,
                "deliveryActive": delivery_active,
                "tileBounds": {
                    "minX": tile_bounds.min_x,
                    "maxX": tile_bounds.max_x,
                    "minY": tile_bounds.min_y,
                    "maxY": tile_bounds.max_y,
                },
            }
        }]
    });
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
}

fn write_bundle_with_tiling(
    dir: &Path,
    city_id: &str,
    entries: &[String],
    edge_km: f64,
    anchor: TileAnchor,
) {
    let json = format!(
        r#"{{"meta":{{"cityId":"{city_id}","version":"1","attribution":"x","licenseUrl":"x","sourcePbfTimestamp":"2026-01-01T00:00:00Z","bundleGeneratedAt":"2026-01-02T00:00:00Z","tier":"strict","entryCount":{}}},"entries":[{}]}}"#,
        entries.len(),
        entries.join(",")
    );
    let mut compressed = Vec::new();
    brotli::BrotliCompress(
        &mut json.as_bytes(),
        &mut compressed,
        &brotli::enc::BrotliEncoderParams::default(),
    )
    .expect("brotli compress fixture bundle");
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(format!("{city_id}.br")), &compressed).unwrap();
    use sha2::{Digest, Sha256};
    let sha = format!("{:x}", Sha256::digest(&compressed));
    let mut bounds: Option<PoiTileBounds> = None;
    for entry in entries {
        let entry: serde_json::Value = serde_json::from_str(entry).expect("parse fixture entry");
        let lat = entry["lat"].as_f64().expect("fixture entry lat");
        let lon = entry["lon"].as_f64().expect("fixture entry lon");
        let tile_key = tile_key_at(city_id, lat, lon, edge_km, anchor);
        let coords = tile_key.rsplit('/').next().expect("fixture tile coords");
        let (x, y) = coords.split_once('_').expect("fixture x_y coords");
        let (x, y) = (
            x.parse::<i64>().expect("fixture x"),
            y.parse::<i64>().expect("fixture y"),
        );
        bounds = Some(match bounds {
            Some(bounds) => PoiTileBounds {
                min_x: bounds.min_x.min(x),
                max_x: bounds.max_x.max(x),
                min_y: bounds.min_y.min(y),
                max_y: bounds.max_y.max(y),
            },
            None => PoiTileBounds {
                min_x: x,
                max_x: x,
                min_y: y,
                max_y: y,
            },
        });
    }
    write_manifest(
        dir,
        city_id,
        compressed.len(),
        &sha,
        edge_km,
        anchor,
        bounds.expect("fixture bundle has entries"),
        true,
    );
}

fn write_bundle(dir: &Path, city_id: &str, entries: &[String]) {
    write_bundle_with_tiling(dir, city_id, entries, 12.0, vilnius_anchor());
}

fn write_compressed_text(dir: &Path, city_id: &str, text: &str) {
    let mut compressed = Vec::new();
    brotli::BrotliCompress(
        &mut text.as_bytes(),
        &mut compressed,
        &brotli::enc::BrotliEncoderParams::default(),
    )
    .expect("brotli compress fixture text");
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(format!("{city_id}.br")), &compressed).unwrap();
    use sha2::{Digest, Sha256};
    let sha = format!("{:x}", Sha256::digest(&compressed));
    write_manifest(
        dir,
        city_id,
        compressed.len(),
        &sha,
        12.0,
        vilnius_anchor(),
        PoiTileBounds {
            min_x: 0,
            max_x: 0,
            min_y: 0,
            max_y: 0,
        },
        true,
    );
}

/// Entries at one point keep fixture coordinates deterministic.
fn clustered_vilnius_entries() -> Vec<String> {
    (0..60)
        .map(|i| entry_json(&format!("v{i}"), 54.7, 25.3))
        .collect()
}

fn body_of(resp: &Resp) -> (u16, Option<String>, Option<Vec<u8>>) {
    match resp {
        Resp::PoiTile {
            status,
            json_body,
            body,
            ..
        } => {
            let bytes = body.as_ref().map(|b| match b {
                ByteBody::Raw(r) => r.to_vec(),
                _ => panic!("poi-tile only ever produces ByteBody::Raw"),
            });
            (*status, json_body.clone(), bytes)
        }
        _ => panic!("expected Resp::PoiTile, got a different Resp arm"),
    }
}

fn decompress(bytes: &[u8]) -> String {
    let mut out = Vec::new();
    brotli::BrotliDecompress(&mut &bytes[..], &mut out).expect("decompress poi-tile body");
    String::from_utf8(out).expect("utf8 poi-tile body")
}

fn http_status(url: &str) -> u16 {
    match ureq::get(url).call() {
        Ok(response) => response.status(),
        Err(ureq::Error::Status(status, _)) => status,
        Err(error) => panic!("request failed: {error}"),
    }
}

fn http_head(url: &str) -> (u16, Option<String>, Option<String>, usize) {
    let response = match ureq::head(url).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => panic!("request failed: {error}"),
    };
    let status = response.status();
    let content_length = response.header("content-length").map(str::to_owned);
    let transfer_encoding = response.header("transfer-encoding").map(str::to_owned);
    let mut body = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut body)
        .expect("read HEAD body");
    (status, content_length, transfer_encoding, body.len())
}

#[test]
fn invalid_city_id_is_400() {
    let (_dir, ctx) = ctx_with(|_, _| {});
    let resp = poi_tile(&ctx, "NotLowercase", "12km", "0_0", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 400);
    assert!(json.unwrap().contains("INVALID_CITY_ID"));
}

#[test]
fn unknown_manifest_record_absent_is_404() {
    let (_dir, ctx) = ctx_with(|_, _| {});
    let resp = poi_tile(&ctx, "warsaw", "12km", "0_0", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 404);
    assert!(json.unwrap().contains("UNKNOWN_CITY"));
}

#[test]
fn unknown_bundle_missing_is_404_not_cached_then_retry_succeeds() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    std::fs::create_dir_all(&bundle_dir).unwrap();
    // No manifest record exists yet, so this is UNKNOWN_CITY rather than an
    // inactive corpus.

    let first = poi_tile(&ctx, "sopot", "12km", "0_0", None);
    let (status, json, _) = body_of(&first);
    assert_eq!(status, 404);
    assert!(json.unwrap().contains("UNKNOWN_CITY"));

    // Publish the bundle and manifest now. The negative result must not have
    // been cached.
    write_bundle(&bundle_dir, "sopot", &clustered_vilnius_entries());
    let tile_key = tile_key_at("sopot", 54.7, 25.3, 12.0, vilnius_anchor());
    let coords = tile_key.rsplit('/').next().expect("tile coords");
    let second = poi_tile(&ctx, "sopot", "12km", coords, None);
    let (status2, _, _) = body_of(&second);
    assert_eq!(
        status2, 200,
        "must re-check disk, not replay the cached 404"
    );
}

#[test]
fn bundle_read_error_is_500_not_unknown_city() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    std::fs::create_dir_all(bundle_dir.join("vilnius.br")).unwrap();
    write_manifest(
        &bundle_dir,
        "vilnius",
        0,
        &"0".repeat(64),
        12.0,
        vilnius_anchor(),
        PoiTileBounds {
            min_x: 0,
            max_x: 0,
            min_y: 0,
            max_y: 0,
        },
        true,
    );

    let resp = poi_tile(&ctx, "vilnius", "12km", "0_0", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 500);
    let json = json.unwrap();
    assert!(json.contains("POI_BUNDLE_LOAD_ERROR"), "{json}");
    assert!(!json.contains("UNKNOWN_CITY"), "{json}");
}

#[test]
fn invalid_bundle_json_is_500_not_unknown_city() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    write_compressed_text(&bundle_dir, "vilnius", "{not valid json");

    let resp = poi_tile(&ctx, "vilnius", "12km", "0_0", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 500);
    let json = json.unwrap();
    assert!(json.contains("POI_BUNDLE_LOAD_ERROR"), "{json}");
    assert!(!json.contains("UNKNOWN_CITY"), "{json}");
}

#[test]
fn decoded_bundle_over_configured_cap_is_500() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
        cfg.poi_bundle_max_decoded_bytes = 1024;
    });
    let bundle_dir = dir.path().join("bundles");
    write_bundle(&bundle_dir, "vilnius", &clustered_vilnius_entries());
    assert!(
        std::fs::metadata(bundle_dir.join("vilnius.br"))
            .unwrap()
            .len()
            <= 1024,
        "fixture must pass the compressed cap and fail the decoded cap"
    );

    let resp = poi_tile(&ctx, "vilnius", "12km", "0_0", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 500);
    assert!(json.unwrap().contains("POI_BUNDLE_LOAD_ERROR"));
}

#[test]
fn manifest_controls_route_edge() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    write_bundle_with_tiling(
        &bundle_dir,
        "vilnius",
        &clustered_vilnius_entries(),
        24.0,
        vilnius_anchor(),
    );

    let ok = poi_tile(&ctx, "vilnius", "24km", "0_0", None);
    assert_eq!(body_of(&ok).0, 200);

    let mismatch = poi_tile(&ctx, "vilnius", "12km", "0_0", None);
    let (status, json, _) = body_of(&mismatch);
    assert_eq!(status, 400);
    let json = json.unwrap();
    assert!(json.contains("TILE_SIZE_MISMATCH"), "{json}");
    assert!(json.contains("24km"), "{json}");
}

#[test]
fn transport_enforces_requested_corpus_version() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    write_bundle(&bundle_dir, "vilnius", &clustered_vilnius_entries());
    let tile_key = tile_key_at("vilnius", 54.7, 25.3, 12.0, vilnius_anchor());
    let coords = tile_key
        .rsplit('/')
        .next()
        .expect("tile coords")
        .to_string();
    let (tile_x, tile_y) = coords.split_once('_').expect("x_y coords");
    let (tile_x, tile_y) = (
        tile_x.parse::<i64>().expect("tile x"),
        tile_y.parse::<i64>().expect("tile y"),
    );
    let empty_coords = format!("{}_{}", tile_x + 1, tile_y);
    let outside_coords = format!("{}_{}", tile_x + 2, tile_y);

    let mut manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(bundle_dir.join("manifest.json")).expect("read manifest"),
    )
    .expect("parse manifest");
    let bundle_sha256 = manifest["bundles"][0]["sha256"]
        .as_str()
        .expect("bundle sha")
        .to_string();
    manifest["bundles"][0]["poiTile"]["tileBounds"]["maxX"] = serde_json::json!(tile_x + 1);
    std::fs::write(
        bundle_dir.join("manifest.json"),
        serde_json::to_vec(&manifest).expect("serialize widened manifest"),
    )
    .expect("write widened manifest");

    let server = pt_serve::http::bind("127.0.0.1:0").expect("bind public test server");
    let addr = server.server_addr().to_ip().expect("TCP listener");
    let dispatch_ctx = Arc::clone(&ctx);
    let dispatch_server = Arc::clone(&server);
    let worker = std::thread::spawn(move || {
        for _ in 0..7 {
            let request = dispatch_server.recv().expect("receive request");
            pt_serve::dispatch(
                &dispatch_ctx,
                &mut None,
                request,
                None,
                pt_serve::router::ListenerKind::Public,
            );
        }
    });
    let base = format!("http://{addr}");
    let stale = http_status(&format!(
        "{base}/api/gtfs/poi-tile/vilnius/12km/{coords}?v={}",
        "b".repeat(64)
    ));
    let current = http_status(&format!(
        "{base}/api/gtfs/poi-tile/vilnius/12km/{coords}?v={bundle_sha256}"
    ));
    let encoded_version = format!(
        "%{:02X}{}",
        bundle_sha256.as_bytes()[0],
        &bundle_sha256[1..]
    );
    let encoded_current = http_status(&format!(
        "{base}/api/gtfs/poi-tile/vilnius/12km/{coords}?v={encoded_version}"
    ));
    let duplicate = http_status(&format!(
        "{base}/api/gtfs/poi-tile/vilnius/12km/{coords}?v={bundle_sha256}&v={bundle_sha256}"
    ));
    let head = http_head(&format!(
        "{base}/api/gtfs/poi-tile/vilnius/12km/{coords}?v={bundle_sha256}"
    ));
    let empty = http_status(&format!(
        "{base}/api/gtfs/poi-tile/vilnius/12km/{empty_coords}?v={bundle_sha256}"
    ));
    let outside = http_status(&format!(
        "{base}/api/gtfs/poi-tile/vilnius/12km/{outside_coords}?v={bundle_sha256}"
    ));
    worker.join().expect("dispatcher thread");

    assert_eq!(stale, 409);
    assert_eq!(current, 200);
    assert_eq!(encoded_current, 200);
    assert_eq!(duplicate, 409);
    assert_eq!(head.0, 200);
    assert!(
        head.1
            .as_deref()
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > 0),
        "HEAD must advertise the compressed representation length"
    );
    assert_eq!(head.2, None, "HEAD must not use chunked transfer encoding");
    assert_eq!(head.3, 0);
    assert_eq!(empty, 200);
    assert_eq!(outside, 404);
    assert_eq!(ctx.metrics.poi_tile_requests_total("vilnius", "409"), 2);
    assert_eq!(ctx.metrics.poi_tile_requests_total("vilnius", "200"), 4);
    assert_eq!(ctx.metrics.poi_tile_requests_total("vilnius", "404"), 1);
    assert_eq!(ctx.metrics.poi_tile_requests_total("unknown", "409"), 0);
}

#[test]
fn inactive_delivery_is_503() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    write_bundle(&bundle_dir, "gdansk", &clustered_vilnius_entries());
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(bundle_dir.join("manifest.json")).unwrap()).unwrap();
    manifest["bundles"][0]["poiTile"]["deliveryActive"] = serde_json::json!(false);
    std::fs::write(
        bundle_dir.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let resp = poi_tile(&ctx, "gdansk", "12km", "0_0", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 503);
    assert!(json.unwrap().contains("POI_TILE_DELIVERY_INACTIVE"));
}

#[test]
fn tile_size_mismatch_names_actual_edge() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    write_bundle_with_tiling(
        &dir.path().join("bundles"),
        "vilnius",
        &clustered_vilnius_entries(),
        24.0,
        vilnius_anchor(),
    );
    let resp = poi_tile(&ctx, "vilnius", "12km", "0_0", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 400);
    let json = json.unwrap();
    assert!(json.contains("TILE_SIZE_MISMATCH"));
    assert!(json.contains("24km"), "{json}");
}

#[test]
fn invalid_tile_key_rejects_leaf_suffix() {
    // POI tiles have no subdivision concept — unlike schedule/rt-tile, a
    // dash-suffixed coord is a 400, never passed through.
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    write_bundle(
        &dir.path().join("bundles"),
        "vilnius",
        &clustered_vilnius_entries(),
    );
    let resp = poi_tile(&ctx, "vilnius", "12km", "0_0-0", None);
    let (status, json, _) = body_of(&resp);
    assert_eq!(status, 400);
    assert!(json.unwrap().contains("INVALID_TILE_KEY"));

    let injected = poi_tile(&ctx, "vilnius", "12km", "0_\"quoted", None);
    let (status, json, _) = body_of(&injected);
    assert_eq!(status, 400);
    let parsed: serde_json::Value =
        serde_json::from_str(&json.expect("error body")).expect("error remains valid JSON");
    assert_eq!(parsed["error"]["code"], "INVALID_TILE_KEY");
}

#[test]
fn success_200_returns_only_the_requested_tiles_entries() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    write_bundle(&bundle_dir, "vilnius", &clustered_vilnius_entries());

    let anchor = vilnius_anchor();
    let cluster_key = tile_key_at("vilnius", 54.7, 25.3, 12.0, anchor);
    let cluster_coords = cluster_key.rsplit('/').next().unwrap();

    let resp = poi_tile(&ctx, "vilnius", "12km", cluster_coords, None);
    let (status, _, body) = body_of(&resp);
    assert_eq!(status, 200);
    let text = decompress(&body.unwrap());
    for i in 0..60 {
        assert!(text.contains(&format!("\"v{i}\"")), "{text}");
    }

    // A syntactically valid coordinate outside the finite city envelope is
    // rejected before cache lookup/compression.
    let empty_resp = poi_tile(&ctx, "vilnius", "12km", "9999_9999", None);
    let (empty_status, empty_json, _) = body_of(&empty_resp);
    assert_eq!(empty_status, 404);
    assert!(empty_json.unwrap().contains("UNKNOWN_TILE"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeDifferentialVector {
    cases: Vec<NodeCase>,
}

#[derive(serde::Deserialize)]
struct NodeCase {
    name: String,
    request: NodeRequest,
    response: NodeResponse,
}

#[derive(serde::Deserialize)]
struct NodeRequest {
    method: String,
    path: String,
    #[serde(default)]
    headers: std::collections::BTreeMap<String, String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeResponse {
    status: u16,
    headers: std::collections::BTreeMap<String, Option<String>>,
    body_base64: String,
}

struct RustResponse {
    status: u16,
    headers: std::collections::BTreeMap<String, Option<String>>,
    body: Vec<u8>,
}

fn send_transport_case(agent: &ureq::Agent, base: &str, case: &NodeCase) -> RustResponse {
    let url = format!("{base}{}", case.request.path);
    let mut request = agent.request(&case.request.method, &url);
    for (name, value) in &case.request.headers {
        request = request.set(name, value);
    }
    let response = match request.call() {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => panic!("{} transport request failed: {error}", case.name),
    };
    let status = response.status();
    let headers = case
        .response
        .headers
        .keys()
        .map(|name| {
            (
                name.clone(),
                response.header(name).map(std::borrow::ToOwned::to_owned),
            )
        })
        .collect();
    let mut body = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut body)
        .unwrap_or_else(|error| panic!("{} response body read failed: {error}", case.name));
    RustResponse {
        status,
        headers,
        body,
    }
}

#[test]
fn node_and_rust_tiny_http_transport_are_byte_equivalent() {
    if std::env::var_os("PT_REQUIRE_POI_DIFFERENTIAL").is_none() {
        return;
    }

    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("node")
        .args([
            "--no-warnings",
            "--experimental-strip-types",
            "packages/backend/scripts/poi-tile-reference.ts",
        ])
        .arg(&bundle_dir)
        .current_dir(repo_root)
        .output()
        .expect("run Node POI reference handler");
    assert!(
        output.status.success(),
        "Node POI reference failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("Node stdout is UTF-8");
    let json_line = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with('{'))
        .expect("Node reference emitted a JSON vector");
    let vector: NodeDifferentialVector =
        serde_json::from_str(json_line).expect("Node vector parses");
    assert!(
        !vector.cases.is_empty(),
        "Node reference must emit at least one differential case"
    );

    let server = pt_serve::http::bind("127.0.0.1:0").expect("bind public test server");
    let addr = server.server_addr().to_ip().expect("TCP listener");
    let dispatch_ctx = Arc::clone(&ctx);
    let dispatch_server = Arc::clone(&server);
    let case_count = vector.cases.len();
    let worker = std::thread::spawn(move || {
        for _ in 0..case_count {
            let request = dispatch_server
                .recv_timeout(Duration::from_secs(10))
                .expect("receive differential request")
                .expect("differential request timed out");
            pt_serve::dispatch(
                &dispatch_ctx,
                &mut None,
                request,
                None,
                pt_serve::router::ListenerKind::Public,
            );
        }
    });

    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let base = format!("http://{addr}");
    let rust_responses = vector
        .cases
        .iter()
        .map(|case| send_transport_case(&agent, &base, case))
        .collect::<Vec<_>>();
    worker.join().expect("differential dispatcher thread");

    use base64::Engine as _;
    for (case, rust) in vector.cases.iter().zip(rust_responses) {
        assert_eq!(rust.status, case.response.status, "{} status", case.name);
        assert_eq!(rust.headers, case.response.headers, "{} headers", case.name);
        let node_body = base64::engine::general_purpose::STANDARD
            .decode(&case.response.body_base64)
            .unwrap_or_else(|error| panic!("{} Node body is not base64: {error}", case.name));
        assert_eq!(rust.body, node_body, "{} body", case.name);
    }

    println!(
        "poi-tile-differential: {} tiles compared, 0 mismatch",
        vector.cases.len()
    );
}

#[test]
fn response_cache_hit_skips_disk() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    write_bundle(&bundle_dir, "vilnius", &clustered_vilnius_entries());

    let anchor = vilnius_anchor();
    let cluster_key = tile_key_at("vilnius", 54.7, 25.3, 12.0, anchor);
    let coords = cluster_key.rsplit('/').next().unwrap().to_string();

    let first = poi_tile(&ctx, "vilnius", "12km", &coords, None);
    assert_eq!(body_of(&first).0, 200);

    std::fs::remove_file(bundle_dir.join("vilnius.br")).unwrap();

    let second = poi_tile(&ctx, "vilnius", "12km", &coords, None);
    let (status, _, body) = body_of(&second);
    assert_eq!(status, 200, "response-cache hit must survive file deletion");
    let text = decompress(&body.unwrap());
    assert!(text.contains("\"v0\""), "{text}");
}

fn manifest_sha(dir: &Path) -> String {
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).expect("read manifest"))
            .expect("parse manifest");
    manifest["bundles"][0]["sha256"]
        .as_str()
        .expect("bundle sha")
        .to_string()
}

#[cfg(unix)]
#[test]
fn promoted_release_reaches_a_city_that_already_served_tiles() {
    use std::os::unix::fs::symlink;

    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("current"));
    });
    let current = dir.path().join("current");
    let release_a = dir.path().join("release-a");
    let release_b = dir.path().join("release-b");
    write_bundle(
        &release_a,
        "vilnius",
        &[entry_json("release-a", 54.7, 25.3)],
    );
    write_bundle(
        &release_b,
        "vilnius",
        &[entry_json("release-b", 54.7, 25.3)],
    );
    let (sha_a, sha_b) = (manifest_sha(&release_a), manifest_sha(&release_b));
    assert_ne!(sha_a, sha_b);
    symlink(&release_a, &current).expect("publish release-a");

    let key = tile_key_at("vilnius", 54.7, 25.3, 12.0, vilnius_anchor());
    let coords = key.rsplit('/').next().expect("tile coords").to_string();
    let served = |version: &str| {
        let resp = poi_tile_with_version(&ctx, "vilnius", "12km", &coords, Some(version), None);
        let (status, _, body) = body_of(&resp);
        (status, body.map(|body| decompress(&body)))
    };

    let (status, body) = served(&sha_a);
    assert_eq!(status, 200);
    assert!(body.expect("tile body").contains("\"release-a\""));

    std::fs::remove_file(&current).expect("retire release-a pointer");
    symlink(&release_b, &current).expect("promote release-b");

    let (status, body) = served(&sha_b);
    assert_eq!(status, 200, "the promoted release must be served");
    let body = body.expect("tile body");
    assert!(body.contains("\"release-b\""), "{body}");
    assert!(!body.contains("\"release-a\""), "{body}");
    assert_eq!(
        served(&sha_a).0,
        409,
        "the retired release is a version mismatch"
    );
}

/// The startup preflight's copy of the first snapshot must not keep that
/// release leased after a promoted release replaces it.
#[cfg(unix)]
#[test]
fn startup_release_lease_ends_once_a_promoted_release_replaces_it() {
    use pt_shared::artifact_lease::CollectionGuard;
    use pt_shared::osm_manifest::digest;
    use std::os::unix::fs::symlink;

    let [a, b] = [digest(b"release-a"), digest(b"release-b")];
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        let releases = data_root.join("releases");
        for id in [&a, &b] {
            write_bundle(&releases.join(id), "vilnius", &[entry_json(id, 54.7, 25.3)]);
        }
        symlink(releases.join(&a), data_root.join("current")).expect("publish release a");
        cfg.poi_bundle_dir = Some(data_root.join("current"));
        cfg.poi_lease_root = Some(data_root.join("leases"));
        cfg.validate().expect("startup preflight");
    });
    let leases = dir.path().join("leases");
    let live = |id: &str| {
        CollectionGuard::try_acquire(&leases)
            .unwrap()
            .is_live(id)
            .unwrap()
    };
    assert!(live(&a), "the startup release is leased");

    let current = dir.path().join("current");
    std::fs::remove_file(&current).expect("retire release a");
    symlink(dir.path().join("releases").join(&b), &current).expect("promote release b");
    let sha_b = manifest_sha(&dir.path().join("releases").join(&b));
    let key = tile_key_at("vilnius", 54.7, 25.3, 12.0, vilnius_anchor());
    let coords = key.rsplit('/').next().expect("tile coords").to_string();
    let resp = poi_tile_with_version(&ctx, "vilnius", "12km", &coords, Some(&sha_b), None);
    assert_eq!(body_of(&resp).0, 200);

    assert!(live(&b), "the promoted release is leased");
    assert!(!live(&a), "nothing reads release a any more");
}

#[test]
fn etag_304_on_if_none_match() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
    });
    let bundle_dir = dir.path().join("bundles");
    write_bundle(&bundle_dir, "vilnius", &clustered_vilnius_entries());
    let anchor = vilnius_anchor();
    let cluster_key = tile_key_at("vilnius", 54.7, 25.3, 12.0, anchor);
    let coords = cluster_key.rsplit('/').next().unwrap().to_string();

    let first = poi_tile(&ctx, "vilnius", "12km", &coords, None);
    let etag = match &first {
        Resp::PoiTile { etag, status, .. } => {
            assert_eq!(*status, 200);
            etag.clone().expect("200 carries an etag")
        }
        _ => panic!("expected Resp::PoiTile"),
    };

    let second = poi_tile(&ctx, "vilnius", "12km", &coords, Some(&etag));
    match second {
        Resp::PoiTile {
            status,
            body,
            json_body,
            etag: etag2,
            attribution,
            ..
        } => {
            assert_eq!(status, 304);
            assert!(body.is_none());
            assert!(json_body.is_none());
            assert_eq!(etag2, Some(etag));
            assert!(attribution, "304 still carries the attribution headers");
        }
        _ => panic!("expected Resp::PoiTile"),
    }
}

#[test]
fn undersized_response_cache_fails_closed_before_serving() {
    let (dir, ctx) = ctx_with(|data_root, cfg| {
        cfg.poi_bundle_dir = Some(data_root.join("bundles"));
        cfg.poi_tile_cache_max_entries = 2;
    });
    let bundle_dir = dir.path().join("bundles");
    let anchor = vilnius_anchor();
    let lat_step = 3.0 / 111.32;
    let entries = vec![
        entry_json("a", anchor.min_lat + lat_step * 0.5, anchor.min_lon + 0.001),
        entry_json("b", anchor.min_lat + lat_step * 1.5, anchor.min_lon + 0.001),
        entry_json("c", anchor.min_lat + lat_step * 2.5, anchor.min_lon + 0.001),
    ];
    write_bundle_with_tiling(&bundle_dir, "vilnius", &entries, 3.0, anchor);

    let (status, json, _) = body_of(&poi_tile(&ctx, "vilnius", "3km", "0_0", None));
    assert_eq!(status, 500);
    assert!(json.unwrap().contains("POI_BUNDLE_LOAD_ERROR"));
    assert!(ctx.poi_tile_response_cache.get("vilnius/3km/0_0").is_none());
}
