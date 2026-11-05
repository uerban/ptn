//! Test-only helper: lay down a producer-shaped generation directory from a source PTB file.
//!
//! Layout produced: <data_root>/current.json <data_root>/generations/<id>/generation.json
//! <data_root>/generations/<id>/bundle.ptb <data_root>/generations/<id>/transfers.bin (optional)
//!
//! `<id>` is the lowercase-hex SHA-256 of the bundle bytes (the manifest's `generationId` grammar
//! from). The bundle bytes are copied straight from the source path — when two tests want distinct
//! `generation_id`s, they pass two distinct source paths (e.g. `tiny.ptb` and `canary.ptb`).
//!
//! `feed_start_date` is read out of the bundle's header at offset [20..24]
//! so the metadata validator's manifest↔bundle cross-check passes.

#![allow(dead_code)]

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// Publish a new generation rooted at `data_root`, copying `source_ptb` into
/// `<data_root>/generations/<id>/bundle.ptb`. Updates `current.json` to point
/// at the new id. Returns the lowercase-hex generation id.
///
/// `created_at` controls the manifest's `createdAt` field — pass a value the
/// metadata validator's clock-skew tolerance accepts (e.g. the same time the
/// test's `MockClock` was anchored at, formatted with [`rfc3339_format`]).
pub fn publish_generation(
    data_root: &Path,
    city: &str,
    source_ptb: &Path,
    created_at: &str,
) -> String {
    publish_generation_with_schema_version(data_root, city, source_ptb, created_at, 2)
}

/// Like [`publish_generation`] but lets the test override the
/// `manifestSchemaVersion` field — used by `tests/forward_incompat.rs` to
/// publish a deliberately-too-high version and assert the loader rejects
/// it with `OperatorError::UnsupportedManifestSchemaVersion`.
pub fn publish_generation_with_schema_version(
    data_root: &Path,
    city: &str,
    source_ptb: &Path,
    created_at: &str,
    manifest_schema_version: u32,
) -> String {
    let bytes = fs::read(source_ptb).expect("read source ptb");
    let bundle_sha = sha256_hex(&bytes);
    // Schema 1 predates the publication id: its id is the PTB hash and it
    // carries no publicationInputsSha256.
    let id = if manifest_schema_version == 1 {
        bundle_sha.clone()
    } else {
        pt_shared::manifest::publication_id(&bundle_sha, &"0".repeat(64))
    };
    let gen_dir = data_root.join("generations").join(&id);
    fs::create_dir_all(&gen_dir).expect("create gen dir");
    let bundle_path = gen_dir.join("bundle.ptb");
    fs::write(&bundle_path, &bytes).expect("write bundle");

    let feed_start = feed_start_date_of(&bytes);
    let mut manifest = serde_json::json!({
        "manifestSchemaVersion": manifest_schema_version,
        "generationId": id,
        "citySlug": city,
        "bundleSha256": bundle_sha,
        "publicationInputsSha256": "0".repeat(64),
        "bundleSizeBytes": bytes.len() as u64,
        "feedStartDate": feed_start,
        "hasTransfers": false,
        "transfersSha256": null,
        "transfersSizeBytes": null,
        "createdAt": created_at,
    });
    if manifest_schema_version == 1 {
        manifest
            .as_object_mut()
            .unwrap()
            .remove("publicationInputsSha256");
    }
    fs::write(
        gen_dir.join("generation.json"),
        serde_json::to_string_pretty(&manifest).expect("serialize manifest"),
    )
    .expect("write manifest");

    let pointer = serde_json::json!({
        "manifestSchemaVersion": manifest_schema_version,
        "generationId": id,
        "citySlug": city,
        "createdAt": created_at,
    });
    fs::write(
        data_root.join("current.json"),
        serde_json::to_string_pretty(&pointer).expect("serialize pointer"),
    )
    .expect("write current.json");
    id
}

/// Optional Stage-C color-provenance sidecars written alongside `bundle.ptb`.
/// Each `Some` blob is written verbatim and its full-file SHA-256 is recorded
/// in the manifest (`colorConfigSha256`/`routeStylesSha256`/`shapesBinSha256`).
#[derive(Default)]
pub struct SidecarArtifacts {
    /// `color-config.json` bytes.
    pub color_config: Option<Vec<u8>>,
    /// `route-styles.json` bytes.
    pub route_styles: Option<Vec<u8>>,
    /// `shapes.bin` bytes (build via [`encode_test_shapes_bin`]).
    pub shapes_bin: Option<Vec<u8>>,
    /// `departures-idx.bin` (DPIX) bytes. Build a VALID one with
    /// [`encode_test_departures_idx`] (its header SHAs match the source
    /// bundle's interning); build a deliberately-mismatched one with
    /// [`encode_test_departures_idx_wrong_trips_sha`].
    pub departures_idx: Option<Vec<u8>>,
    /// `label-anchors.json` bytes (Plan-C2a). Written verbatim; its full-file
    /// SHA-256 is recorded in the manifest as `labelAnchorsSha256`.
    pub label_anchors: Option<Vec<u8>>,
    /// Packed `address-search.fst` bytes (build one with
    /// `pt_geocode::AddrIndex::pack`). Written verbatim and NOT recorded in the
    /// manifest — the address corpus is a propagate-only passthrough with no
    /// manifest SHA field (pt-serve validates it structurally at load).
    pub address_search: Option<Vec<u8>>,
}

/// Recompute the source bundle's Trips/Stops interner SHA-256 in RECORD ORDER
/// — exactly what `build_generation` does. Returns `(trips_sha, stops_sha)`.
/// Mmaps the bundle through a real `pt_core::Reader` so the namespace bytes are
/// identical to the production recompute path (no hand-mirrored interner).
pub fn bundle_namespace_shas(source_ptb: &Path) -> ([u8; 32], [u8; 32]) {
    let mbytes = pt_serve::mmap::open_mmap(source_ptb).expect("mmap source ptb");
    let reader = pt_core::Reader::from_bytes(mbytes).expect("reader from bundle");
    let trips: Vec<&str> = (0..reader.num_trips())
        .map(|i| reader.trip_id(i).expect("trip_id"))
        .collect();
    let stops: Vec<&str> = (0..reader.num_stops())
        .map(|i| reader.stop_id(i).expect("stop_id"))
        .collect();
    (
        pt_shared::sidecar::intern_namespace_sha256(&trips),
        pt_shared::sidecar::intern_namespace_sha256(&stops),
    )
}

/// Build a VALID `departures-idx.bin` for `source_ptb`: a minimal empty-CSR
/// payload (every stop has zero departures) whose header SHAs match the
/// bundle's recomputed Trips/Stops interner SHAs — so `DeparturesIdx::parse`'s
/// non-optional namespace cross-check passes at load. An empty CSR is the
/// smallest well-formed DPIX (`offsets = [0; num_stops+1]`, no entries) and is
/// sufficient to exercise the load-time SHA cross-check + mmap retention.
pub fn encode_test_departures_idx(source_ptb: &Path) -> Vec<u8> {
    let (trips_sha, stops_sha) = bundle_namespace_shas(source_ptb);
    let num_stops = num_stops_of(source_ptb);
    let offsets = vec![0u32; num_stops + 1];
    pt_shared::sidecar::encode_departures_idx(&offsets, &[], &trips_sha, &stops_sha)
        .expect("encode test departures-idx.bin")
}

/// Build a DPIX whose `tripsInternSha256` is deliberately WRONG (does not match
/// the bundle), so `DeparturesIdx::parse` rejects it with
/// `NamespaceShaMismatch{which:"trips"}` at load — exercising the C2c
/// present-but-inconsistent hard-fail path.
pub fn encode_test_departures_idx_wrong_trips_sha(source_ptb: &Path) -> Vec<u8> {
    let (_trips_sha, stops_sha) = bundle_namespace_shas(source_ptb);
    let num_stops = num_stops_of(source_ptb);
    let offsets = vec![0u32; num_stops + 1];
    // [0xFF;32] cannot equal any real interner SHA.
    pt_shared::sidecar::encode_departures_idx(&offsets, &[], &[0xFFu8; 32], &stops_sha)
        .expect("encode mismatched departures-idx.bin")
}

fn num_stops_of(source_ptb: &Path) -> usize {
    let mbytes = pt_serve::mmap::open_mmap(source_ptb).expect("mmap source ptb");
    let reader = pt_core::Reader::from_bytes(mbytes).expect("reader from bundle");
    reader.num_stops()
}

// ---------------------------------------------------------------------------
// Custom PTB + DPIX builders for the C2c /scheduled-departures-for-stop tests.
//
// The committed tiny.ptb does not give the per-trip / per-stop_time control the
// handler test matrix needs (missing-departure sentinel, overnight >86400,
// loop/lasso revisit, direction_id 0xFF, distinct route colors). These builders
// emit a flat-carry PTB v1 through `pt_core::engine::testkit::build_v1_ptb` and
// a DPIX whose CSR maps each stop to the ABSOLUTE stop_times row indices that
// touch it — exactly what the handler reads.
// ---------------------------------------------------------------------------

/// One route's interner record fields.
pub struct RouteSpec {
    pub route_id: &'static str,
    pub short_name: &'static str,
    pub route_type: u16,
    pub color: &'static str,
    pub text_color: &'static str,
}

/// One trip: its interner record fields plus its `stop_times` rows in storage
/// order. Each row is `(stop_seq, stop_idx, dep_secs, arr_diff)`. `dep_secs` may
/// be `0xFFFFFFFF` (missing) or exceed 86400 (overnight).
pub struct TripSpec {
    pub trip_id: &'static str,
    pub headsign: &'static str,
    pub route_idx: u32,
    pub service_idx: u32,
    pub direction_id: u8,
    pub wheelchair: u8,
    /// `(stop_seq, stop_idx, dep_secs, arr_diff)` rows.
    pub stop_times: Vec<(u16, u32, u32, i16)>,
}

/// Result of [`build_feed_ptb`]: the PTB bytes plus, for each trip, the ABSOLUTE
/// stop_times row index of each of its rows (so the test can build the DPIX CSR
/// pointing at the same absolute indices the handler reads).
pub struct BuiltFeed {
    pub bytes: Vec<u8>,
    /// `abs_row[t][k]` = absolute stop_times row index of trip `t`'s row `k`.
    pub abs_rows: Vec<Vec<u32>>,
}

/// Build a flat-carry PTB v1. Service `i` gets its own pool bitfield
/// `service_bitmasks[i]` (the raw 12-byte window mask, LSB-first by day).
/// `stop_ids` are the stop interner ids in ordinal order. Each stop's
/// `stop→routes` CSR lists the routes that serve it (derived from the trips'
/// rows), in route-ordinal order.
pub fn build_feed_ptb(
    stop_ids: &[&str],
    routes: &[RouteSpec],
    trips: &[TripSpec],
    service_bitmasks: &[[u8; 12]],
    feed_start_date: u32,
    city_tz_offset_seconds: i32,
) -> BuiltFeed {
    use pt_core::engine::testkit::{
        bare_stops, build_v1_ptb, ServicePoolSpec, SoaRoute, StopRoutes, V1Feed, V1Trip,
    };
    assert!(!routes.is_empty() && !trips.is_empty() && !service_bitmasks.is_empty());

    let stops = bare_stops(stop_ids);
    let soa_routes: Vec<SoaRoute<'_>> = routes
        .iter()
        .map(|r| SoaRoute {
            id: r.route_id,
            agency: "",
            short: r.short_name,
            long: "",
            color: r.color,
            text_color: r.text_color,
            route_type: r.route_type,
        })
        .collect();
    let rows: Vec<Vec<(u16, u32, u32)>> = trips
        .iter()
        .map(|t| t.stop_times.iter().map(|&(q, s, d, _)| (q, s, d)).collect())
        .collect();
    let arr_diffs: Vec<Vec<i16>> = trips
        .iter()
        .map(|t| t.stop_times.iter().map(|r| r.3).collect())
        .collect();
    let v1_trips: Vec<V1Trip<'_>> = trips
        .iter()
        .enumerate()
        .map(|(t, ts)| V1Trip {
            id: ts.trip_id,
            headsign: ts.headsign,
            route: ts.route_idx,
            service: ts.service_idx,
            wheelchair: ts.wheelchair,
            direction_id: ts.direction_id,
            rows: &rows[t],
            arr_diffs: &arr_diffs[t],
        })
        .collect();
    let pool: Vec<&[u8]> = service_bitmasks.iter().map(|m| m.as_slice()).collect();
    let service_to_bitfield: Vec<u32> = (0..service_bitmasks.len() as u32).collect();
    let bytes = build_v1_ptb(&V1Feed {
        stops: &stops,
        routes: &soa_routes,
        trips: &v1_trips,
        stop_routes: StopRoutes::Served,
        feed_start_date,
        city_tz_offset_seconds,
        services: ServicePoolSpec {
            window_days: pt_core::WINDOW_DEFAULT_DAYS,
            pool: &pool,
            service_to_bitfield: &service_to_bitfield,
        },
        transfers: &[],
        boarding: &[],
        stop_index: false,
    });

    // StopTimes are concatenated in trip order.
    let mut abs_rows: Vec<Vec<u32>> = Vec::with_capacity(trips.len());
    let mut row = 0u32;
    for ts in trips {
        abs_rows.push((row..row + ts.stop_times.len() as u32).collect());
        row += ts.stop_times.len() as u32;
    }
    BuiltFeed { bytes, abs_rows }
}

/// Build a DPIX over `source_bytes` whose CSR maps each stop to the given
/// `(trip_idx, stopTimeIdx)` entries. `per_stop[s]` is the entry list for stop
/// `s` (already sorted as the producer would). The header SHAs are recomputed
/// from the bundle interner so the namespace cross-check passes at load.
pub fn build_departures_idx_csr(source_bytes: &[u8], per_stop: &[Vec<(u32, u32)>]) -> Vec<u8> {
    let reader =
        pt_core::Reader::from_bytes(source_bytes.to_vec()).expect("reader from feed bytes");
    let num_stops = reader.num_stops();
    assert_eq!(
        per_stop.len(),
        num_stops,
        "per_stop must have one entry list per stop"
    );
    let trips: Vec<&str> = (0..reader.num_trips())
        .map(|i| reader.trip_id(i).expect("trip_id"))
        .collect();
    let stops: Vec<&str> = (0..reader.num_stops())
        .map(|i| reader.stop_id(i).expect("stop_id"))
        .collect();
    let trips_sha = pt_shared::sidecar::intern_namespace_sha256(&trips);
    let stops_sha = pt_shared::sidecar::intern_namespace_sha256(&stops);

    let mut offsets = vec![0u32; num_stops + 1];
    let mut entries: Vec<u32> = Vec::new();
    for (s, list) in per_stop.iter().enumerate() {
        for &(trip_idx, st_idx) in list {
            entries.push(trip_idx);
            entries.push(st_idx);
        }
        offsets[s + 1] = (entries.len() / 2) as u32;
    }
    pt_shared::sidecar::encode_departures_idx(&offsets, &entries, &trips_sha, &stops_sha)
        .expect("encode departures-idx.bin from CSR")
}

/// Build a `shapes.bin` whose header carries the bundle's REAL recomputed interner SHAs (so 's
/// load-time interner cross-check passes). `source_ptb` is the same PTB the generation is published
/// from.
pub fn encode_test_shapes_bin(source_ptb: &Path) -> Vec<u8> {
    use pt_shared::sidecar::{encode_shapes_bin, ShapeEncodeInput};
    let bytes: Vec<u8> = fs::read(source_ptb).expect("read source ptb for shapes SHAs");
    let reader = pt_core::Reader::from_bytes(bytes).expect("reader for shapes SHAs");
    let (trips, stops) =
        pt_serve::bundle::integrity::bundle_namespace_shas(&reader).expect("recompute SHAs");
    let shapes = [
        ShapeEncodeInput {
            shape_id: "SH_A",
            points: &[(54.69, 25.28), (54.691, 25.281), (54.692, 25.282)],
            trip_ref_count: 2,
        },
        ShapeEncodeInput {
            shape_id: "SH_B",
            points: &[(54.70, 25.30)],
            trip_ref_count: 1,
        },
    ];
    encode_shapes_bin(&shapes, &trips, &stops).expect("encode test shapes.bin")
}

/// One shape's wire input expressed in owned terms so callers can hand-build a
/// `shapes.bin` with arbitrary polylines (the borrowed `ShapeEncodeInput` can't
/// outlive a temporary `Vec<(f32,f32)>`). Points are `(lat, lon)` in degrees, in
/// `shape_pt_sequence` order; `shape_id`s MUST be passed in ascending order
/// (`encode_shapes_bin`'s binary-search precondition).
pub struct OwnedShape {
    pub shape_id: String,
    pub points: Vec<(f32, f32)>,
    pub trip_ref_count: u32,
}

/// Like [`encode_test_shapes_bin`] but with caller-chosen polylines, so two
/// calls with DIFFERENT `shapes` produce `shapes.bin` byte vectors with distinct
/// canonical `shapesJsonSha256` hashes (`encode_test_shapes_bin` always emits the
/// SAME fixed payload). The header still carries the bundle's REAL recomputed
/// interner SHAs so the load-time X4 cross-check passes. `source_ptb` is the same
/// PTB the generation is published from.
pub fn encode_test_shapes_bin_variant(source_ptb: &Path, shapes: &[OwnedShape]) -> Vec<u8> {
    use pt_shared::sidecar::{encode_shapes_bin, ShapeEncodeInput};
    let bytes: Vec<u8> = fs::read(source_ptb).expect("read source ptb for shapes SHAs");
    let reader = pt_core::Reader::from_bytes(bytes).expect("reader for shapes SHAs");
    let (trips, stops) =
        pt_serve::bundle::integrity::bundle_namespace_shas(&reader).expect("recompute SHAs");
    let inputs: Vec<ShapeEncodeInput<'_>> = shapes
        .iter()
        .map(|s| ShapeEncodeInput {
            shape_id: &s.shape_id,
            points: &s.points,
            trip_ref_count: s.trip_ref_count,
        })
        .collect();
    encode_shapes_bin(&inputs, &trips, &stops).expect("encode test shapes.bin variant")
}

/// Read the canonical `shapesJsonSha256` a published generation recorded in its
/// `generation.json`. Returns `None` when the field is absent/null (no shapes.bin).
pub fn manifest_shapes_json_sha256(data_root: &Path, generation_id: &str) -> Option<String> {
    let text = fs::read_to_string(manifest_path_for(data_root, generation_id))
        .expect("read manifest for shapesJsonSha256");
    let v: serde_json::Value = serde_json::from_str(&text).expect("parse manifest json");
    v.get("shapesJsonSha256")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
}

/// Like [`publish_generation`] but also writes the Stage-C color-provenance
/// sidecars (`color-config.json`, `route-styles.json`, `shapes.bin`) and records
/// their SHAs in the manifest. Returns the lowercase-hex generation id.
pub fn publish_generation_with_artifacts(
    data_root: &Path,
    city: &str,
    source_ptb: &Path,
    created_at: &str,
    artifacts: &SidecarArtifacts,
) -> String {
    let bytes = fs::read(source_ptb).expect("read source ptb");
    let bundle_sha = sha256_hex(&bytes);
    let components = [
        &artifacts.color_config,
        &artifacts.route_styles,
        &artifacts.shapes_bin,
        &artifacts.departures_idx,
        &artifacts.label_anchors,
        &artifacts.address_search,
    ];
    let inputs_sha = sha256_hex(
        &serde_json::to_vec(&components.map(|component| component.as_ref().map(|b| sha256_hex(b))))
            .unwrap(),
    );
    let id = pt_shared::manifest::publication_id(&bundle_sha, &inputs_sha);
    let gen_dir = data_root.join("generations").join(&id);
    fs::create_dir_all(&gen_dir).expect("create gen dir");
    fs::write(gen_dir.join("bundle.ptb"), &bytes).expect("write bundle");

    let color_config_sha = artifacts.color_config.as_ref().map(|b| {
        fs::write(gen_dir.join("color-config.json"), b).expect("write color-config.json");
        sha256_hex(b)
    });
    let route_styles_sha = artifacts.route_styles.as_ref().map(|b| {
        fs::write(gen_dir.join("route-styles.json"), b).expect("write route-styles.json");
        sha256_hex(b)
    });
    let shapes_bin_sha = artifacts.shapes_bin.as_ref().map(|b| {
        fs::write(gen_dir.join("shapes.bin"), b).expect("write shapes.bin");
        sha256_hex(b)
    });
    let departures_idx_sha = artifacts.departures_idx.as_ref().map(|b| {
        fs::write(gen_dir.join("departures-idx.bin"), b).expect("write departures-idx.bin");
        sha256_hex(b)
    });
    let label_anchors_sha = artifacts.label_anchors.as_ref().map(|b| {
        fs::write(gen_dir.join("label-anchors.json"), b).expect("write label-anchors.json");
        sha256_hex(b)
    });
    if let Some(b) = artifacts.address_search.as_ref() {
        fs::write(gen_dir.join("address-search.fst"), b).expect("write address-search.fst");
    }

    let (shapes_json_sha, shapes_json_size) = match artifacts.shapes_bin.as_ref() {
        Some(b) => {
            let reader = pt_core::Reader::from_bytes(bytes.clone()).expect("reader");
            let (trips, stops) =
                pt_serve::bundle::integrity::bundle_namespace_shas(&reader).expect("recompute");
            // Parsing may fail for intentionally-corrupt test fixtures (e.g. the
            // "corrupt shapes.bin" test). In that case skip the JSON hash — the
            // test only needs the full-file SHA (shapesBinSha256) to be present.
            if let Ok(sb) = pt_shared::sidecar::ShapesBin::parse(b, &trips, &stops) {
                let (digest, len) = pt_shared::sidecar::shapes_json_sha256(&sb);
                (
                    Some(
                        digest
                            .iter()
                            .map(|x| format!("{x:02x}"))
                            .collect::<String>(),
                    ),
                    Some(len),
                )
            } else {
                (None, None)
            }
        }
        None => (None, None),
    };

    let feed_start = feed_start_date_of(&bytes);
    let manifest = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": city,
        "bundleSha256": bundle_sha,
        "publicationInputsSha256": inputs_sha,
        "bundleSizeBytes": bytes.len() as u64,
        "feedStartDate": feed_start,
        "hasTransfers": false,
        "transfersSha256": null,
        "transfersSizeBytes": null,
        "createdAt": created_at,
        "colorConfigSha256": color_config_sha,
        "routeStylesSha256": route_styles_sha,
        "shapesBinSha256": shapes_bin_sha,
        "shapesJsonSha256": shapes_json_sha,
        "shapesJsonSizeBytes": shapes_json_size,
        "departuresIdxSha256": departures_idx_sha,
        "labelAnchorsSha256": label_anchors_sha,
    });
    fs::write(
        gen_dir.join("generation.json"),
        serde_json::to_string_pretty(&manifest).expect("serialize manifest"),
    )
    .expect("write manifest");

    let pointer = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": city,
        "createdAt": created_at,
    });
    fs::write(
        data_root.join("current.json"),
        serde_json::to_string_pretty(&pointer).expect("serialize pointer"),
    )
    .expect("write current.json");
    id
}

/// Repoint `current.json` at a generation id WITHOUT touching the
/// generation dir itself. Used by tests that publish multiple generations
/// up front and then swap which one is "current".
pub fn point_current_at(data_root: &Path, city: &str, generation_id: &str, created_at: &str) {
    let pointer = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": generation_id,
        "citySlug": city,
        "createdAt": created_at,
    });
    fs::write(
        data_root.join("current.json"),
        serde_json::to_string_pretty(&pointer).expect("serialize pointer"),
    )
    .expect("write current.json");
}

/// Look up the `generation.json` path for a given id.
pub fn manifest_path_for(data_root: &Path, id: &str) -> PathBuf {
    data_root
        .join("generations")
        .join(id)
        .join("generation.json")
}

/// Look up the `bundle.ptb` path for a given id.
pub fn bundle_path_for(data_root: &Path, id: &str) -> PathBuf {
    data_root.join("generations").join(id).join("bundle.ptb")
}

/// `last-good.json` path inside the data root.
pub fn last_good_path(data_root: &Path) -> PathBuf {
    data_root.join("last-good.json")
}

/// Lowercase-hex SHA-256 — matches the validator's expectation.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// PTB header carries `feed_start_date` (YYYYMMDD u32) at bytes [20..24] LE.
/// Mirrors `Reader::feed_start_date()` so the test can mint a metadata that
/// passes the manifest↔bundle cross-check.
pub fn feed_start_date_of(bytes: &[u8]) -> u32 {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&bytes[20..24]);
    u32::from_le_bytes(buf)
}

/// Format `YYYY-MM-DDTHH:MM:SSZ` from a unix-seconds u64. Matches the
/// strict RFC 3339 subset the metadata validator parses.
pub fn rfc3339_format(unix_secs: u64) -> String {
    // Trivial conversion via SystemTime — avoids adding a chrono/time dep
    // for one timestamp.
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(unix_secs);
    // Use SystemTime → Duration since epoch → manual format. We mirror the
    // strict 20-char grammar:  YYYY-MM-DDTHH:MM:SSZ.
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard-Hinnant `civil_from_days`. Returns (year, month, day).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
