//! manifest.json (writeBundleManifest.ts), trip-route.json / stop-cell.json
//! (schedule-tile-gen.mjs:137-175). trip-route interns route ids
//! (routes: string[], trips: {tripId: routeIdx}) in trips-array order;
//! stop-cell is the stop→tile-coords map straight from build_bundle. Both
//! are compact JSON, byte-compared by the differential gate — IndexMap
//! preserves the Node insertion orders.
//!
//! Manifest pretty-printing: `serde_json::to_vec_pretty` was verified
//! byte-for-byte against `JSON.stringify(manifest, null, 2)` for this exact
//! shape (2-space indent, `": "` after keys, no trailing newline) — see the
//! golden test below. No hand-rolled formatter is needed, EXCEPT for f64
//! number tokens: integral doubles need `serialize_js_number` (JS prints
//! `0`, serde_json would print `0.0`) — see that function's doc.

use indexmap::IndexMap;
use serde::{Serialize, Serializer};
use std::path::Path;

use super::bundle::BuildBundleResult;
use super::inputs::TileInputs;
use super::js_key_order::reordered_like_js_object_keys;
use crate::error::Result;

/// Serialize an f64 the way `JSON.stringify` prints a JS number: an INTEGRAL
/// value gets an integer token with no fraction (`0`, not `0.0`), and `-0`
/// prints as `0`. serde_json would otherwise emit `0.0`/`-0.0` for integral
/// f64s, silently diverging manifest bytes for any subdivided cell whose bbox
/// touches the equator/prime meridian (`schedule_cell_bounds(0, y)` yields an
/// exact `0.0` minLon; `bisect_quadrant` preserves it in west children).
/// Non-integral values keep serde_json's shortest-round-trip formatting,
/// which matches JS `Number.prototype.toString` for doubles.
///
/// The i64 cast is exact here: bbox degrees are |v| < 360, far inside the
/// 2^53 range where f64 holds exact integers; the guard keeps the cast safe
/// against pathological inputs anyway.
fn serialize_js_number<S: Serializer>(v: &f64, s: S) -> std::result::Result<S::Ok, S::Error> {
    const F64_EXACT_INT_MAX: f64 = 9_007_199_254_740_992.0; // 2^53
    if v.is_finite() && v.fract() == 0.0 && v.abs() <= F64_EXACT_INT_MAX {
        // `-0.0 as i64` is 0, matching JSON.stringify(-0) === "0".
        s.serialize_i64(*v as i64)
    } else {
        s.serialize_f64(*v)
    }
}

#[derive(Serialize)]
struct WireBbox {
    #[serde(rename = "minLat", serialize_with = "serialize_js_number")]
    min_lat: f64,
    #[serde(rename = "maxLat", serialize_with = "serialize_js_number")]
    max_lat: f64,
    #[serde(rename = "minLon", serialize_with = "serialize_js_number")]
    min_lon: f64,
    #[serde(rename = "maxLon", serialize_with = "serialize_js_number")]
    max_lon: f64,
}

#[derive(Serialize)]
struct WireLeaf {
    suffix: String,
    bbox: WireBbox,
    #[serde(rename = "compressedBytes")]
    compressed_bytes: usize,
    oversized: bool,
}

#[derive(Serialize)]
struct WireSubdivisionPlan {
    leaves: Vec<WireLeaf>,
}

#[derive(Serialize)]
struct WireManifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "bundleHash")]
    bundle_hash: String,
    #[serde(rename = "generatedAt")]
    generated_at: u64,
    #[serde(rename = "tileSize")]
    tile_size: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    subdivisions: Option<IndexMap<String, WireSubdivisionPlan>>,
}

/// Atomic manifest write (tmp + rename), pretty-printed 2-space like
/// JSON.stringify(manifest, null, 2). Returns the exact bytes written so the
/// caller records their sha without a re-read race.
///
/// Mirrors writeBundleManifest.ts: stale tmp from a previous failed write is
/// best-effort removed up front, and cleaned up again on any error so a
/// half-written tmp never lingers.
pub fn write_bundle_manifest(
    data_dir: &Path,
    bundle_hash: &str,
    generated_at_ms: u64,
    result: &BuildBundleResult,
) -> Result<Vec<u8>> {
    let subdivisions = if result.subdivisions.is_empty() {
        None
    } else {
        Some(
            result
                .subdivisions
                .iter()
                .map(|(k, plans)| {
                    (
                        k.clone(),
                        WireSubdivisionPlan {
                            leaves: plans
                                .iter()
                                .map(|p| WireLeaf {
                                    suffix: p.suffix.clone(),
                                    bbox: WireBbox {
                                        min_lat: p.bbox.min_lat,
                                        max_lat: p.bbox.max_lat,
                                        min_lon: p.bbox.min_lon,
                                        max_lon: p.bbox.max_lon,
                                    },
                                    compressed_bytes: p.compressed_bytes,
                                    oversized: p.oversized,
                                })
                                .collect(),
                        },
                    )
                })
                .collect(),
        )
    };
    let manifest = WireManifest {
        schema_version: 1,
        bundle_hash: bundle_hash.to_string(),
        generated_at: generated_at_ms,
        tile_size: super::grid::SCHEDULE_TILE_EDGE_METERS,
        subdivisions,
    };
    let body = serde_json::to_vec_pretty(&manifest).expect("manifest serialization is infallible");

    let final_path = data_dir.join("manifest.json");
    let tmp_path = data_dir.join("manifest.json.tmp");
    // Best-effort cleanup of stale tmp from a previous failed write
    // (writeBundleManifest.ts:37).
    let _ = std::fs::remove_file(&tmp_path);
    let write = || -> Result<()> {
        std::fs::write(&tmp_path, &body)?;
        std::fs::rename(&tmp_path, &final_path)?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    Ok(body)
}

#[derive(Serialize)]
struct TripRouteWire<'a> {
    routes: Vec<&'a str>,
    trips: IndexMap<String, u32>,
}

/// trip-route.json body — routes interned in trips-array order.
///
/// Parity note: Node uses `Object.create(null)` keyed by RAW tripId
/// (`__proto__`-safe) and `iterTrips` order; `IndexMap<String, u32>`
/// reproduces both (no prototype hazard in Rust). Duplicate tripIds cannot
/// occur (PTB trip ids unique). GTFS `trip_id` may legally be a
/// numeric-looking string (e.g. "42"), and Node's `trips` map is a real
/// object (`Object.create(null)` only strips the prototype — the
/// OrdinaryOwnPropertyKeys integer-index reordering rule applies
/// regardless), so `trips` is reordered to match right before
/// serialization — see `js_key_order`.
pub fn trip_route_json(inputs: &TileInputs) -> Vec<u8> {
    let mut route_index: IndexMap<u32, u32> = IndexMap::new();
    let mut routes: Vec<&str> = Vec::new();
    let mut trips: IndexMap<String, u32> = IndexMap::new();
    for t in &inputs.trips {
        let idx = *route_index.entry(t.route_idx).or_insert_with(|| {
            routes.push(inputs.routes[t.route_idx as usize].route_id.as_str());
            (routes.len() - 1) as u32
        });
        trips.insert(t.trip_id.clone(), idx);
    }
    let trips: IndexMap<String, u32> = reordered_like_js_object_keys(&trips)
        .into_iter()
        .map(|(k, v)| (k, *v))
        .collect();
    serde_json::to_vec(&TripRouteWire { routes, trips }).expect("infallible")
}

/// stop-cell.json body — the build's stop→tile map. Node builds this via
/// `Object.fromEntries(result.stopTileCoords)`, a real JS object, so any
/// numeric-looking stop_id (valid per the GTFS spec) is subject to JS
/// OrdinaryOwnPropertyKeys integer-index reordering — reorder a CLONE
/// here, not `result.stop_tile_coords` itself: that field's plain
/// insertion order is relied on elsewhere (build_bundle's per-stop
/// bucketing), so it must not be mutated for this serialization-only
/// concern.
pub fn stop_cell_json(result: &BuildBundleResult) -> Vec<u8> {
    let reordered = reordered_like_js_object_keys(&result.stop_tile_coords);
    serde_json::to_vec(&reordered).expect("infallible")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule_tiles::bundle::{BuildStats, LeafPlan};
    use crate::schedule_tiles::grid::Bbox;
    use crate::schedule_tiles::inputs::{TileInputs, TileRoute, TileService, TileTrip};
    use std::collections::HashMap;

    fn empty_result() -> BuildBundleResult {
        BuildBundleResult {
            tiles_written: 1,
            subdivisions: IndexMap::new(),
            stats: BuildStats {
                subdivided_cells: 0,
                max_depth: 0,
                oversized_leaves: 0,
                max_leaf_bytes: 10,
                cell_count: 1,
            },
            stop_tile_coords: IndexMap::new(),
        }
    }

    #[test]
    fn manifest_without_subdivisions_omits_the_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let result = empty_result();
        let body = write_bundle_manifest(dir.path(), "abc123", 1_752_300_000_000, &result)
            .expect("write succeeds");
        let text = String::from_utf8(body.clone()).unwrap();
        assert!(
            !text.contains("subdivisions"),
            "empty subdivisions must be omitted"
        );

        // Pretty format parses back to the same logical value.
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["schemaVersion"], 1);
        assert_eq!(parsed["bundleHash"], "abc123");
        assert_eq!(parsed["tileSize"], 6000);
        assert!(parsed.get("subdivisions").is_none());

        // Matches JSON.stringify(manifest, null, 2): 2-space indent after
        // each key line, no trailing newline.
        assert!(text.starts_with("{\n  \"schemaVersion\": 1,"));
        assert!(!text.ends_with('\n'));

        let on_disk = std::fs::read(dir.path().join("manifest.json")).unwrap();
        assert_eq!(on_disk, body);
        assert!(!dir.path().join("manifest.json.tmp").exists());
    }

    #[test]
    fn manifest_with_subdivisions_includes_leaves() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut result = empty_result();
        result.subdivisions.insert(
            "1_2".to_string(),
            vec![LeafPlan {
                suffix: "0".to_string(),
                bbox: Bbox {
                    min_lat: 1.0,
                    max_lat: 2.0,
                    min_lon: 3.0,
                    max_lon: 4.0,
                },
                compressed_bytes: 123,
                oversized: false,
            }],
        );
        let body =
            write_bundle_manifest(dir.path(), "abc123", 42, &result).expect("write succeeds");
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let leaf = &parsed["subdivisions"]["1_2"]["leaves"][0];
        assert_eq!(leaf["suffix"], "0");
        assert_eq!(leaf["compressedBytes"], 123);
        assert_eq!(leaf["oversized"], false);
        assert_eq!(leaf["bbox"]["minLat"], 1.0);
        assert_eq!(leaf["bbox"]["maxLon"], 4.0);
    }

    /// Golden byte-comparison against a real `JSON.stringify(x, null, 2)`
    /// invocation for this exact manifest shape (generated via `node -e`,
    /// regen command in tests/fixtures/README.md) — pins serde_json's pretty
    /// formatter to Node's, not just "parses to the same value".
    ///
    /// The "0_0" cell exercises JS number-token parity for integral doubles:
    /// its bbox carries an exact `0.0` (equator min_lat) and a `-0.0`
    /// (negative-zero min_lon, reachable through float arithmetic on
    /// west-of-meridian bounds), both of which `JSON.stringify` prints as
    /// `0` — never `0.0`/`-0.0`. Without `serialize_js_number` this test
    /// fails, which is exactly the differential-gate divergence a
    /// subdivided London/Accra/Quito cell would hit.
    #[test]
    fn manifest_pretty_bytes_match_node_golden() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut result = empty_result();
        result.subdivisions.insert(
            "1_2".to_string(),
            vec![LeafPlan {
                suffix: "0".to_string(),
                bbox: Bbox {
                    min_lat: 1.5,
                    max_lat: 2.5,
                    min_lon: 3.5,
                    max_lon: 4.5,
                },
                compressed_bytes: 123,
                oversized: false,
            }],
        );
        result.subdivisions.insert(
            "0_0".to_string(),
            vec![LeafPlan {
                suffix: "2".to_string(),
                bbox: Bbox {
                    min_lat: 0.0,
                    max_lat: 0.05390377113111174,
                    min_lon: -0.0,
                    max_lon: 0.05390463256446938,
                },
                compressed_bytes: 456,
                oversized: true,
            }],
        );
        let body = write_bundle_manifest(dir.path(), "abc123", 1_752_300_000_000, &result)
            .expect("write succeeds");
        let expected = include_bytes!("../../tests/fixtures/manifest_golden.json");
        assert_eq!(
            String::from_utf8_lossy(&body),
            String::from_utf8_lossy(expected),
            "manifest bytes must match JSON.stringify(x, null, 2) exactly"
        );
    }

    fn two_route_inputs() -> TileInputs {
        TileInputs {
            stops: vec![],
            trips: vec![
                TileTrip {
                    trip_id: "T1".into(),
                    route_idx: 0,
                    service_idx: 0,
                    headsign: "H1".into(),
                },
                TileTrip {
                    trip_id: "T2".into(),
                    route_idx: 0,
                    service_idx: 0,
                    headsign: "H2".into(),
                },
                TileTrip {
                    trip_id: "T3".into(),
                    route_idx: 1,
                    service_idx: 0,
                    headsign: "H3".into(),
                },
            ],
            routes: vec![
                TileRoute {
                    route_id: "R0".into(),
                    short_name: "0".into(),
                    long_name: "Route 0".into(),
                    route_color: "FF0000".into(),
                    route_type: 3,
                },
                TileRoute {
                    route_id: "R1".into(),
                    short_name: "1".into(),
                    long_name: "Route 1".into(),
                    route_color: "00FF00".into(),
                    route_type: 3,
                },
            ],
            services: vec![TileService {
                service_id: "svc:0".into(),
                added: vec![],
            }],
            stop_times: vec![],
            route_styles: HashMap::new(),
        }
    }

    #[test]
    fn trip_route_json_interns_routes_in_trips_array_order() {
        let inputs = two_route_inputs();
        let body = trip_route_json(&inputs);
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["routes"], serde_json::json!(["R0", "R1"]));
        assert_eq!(parsed["trips"]["T1"], 0);
        assert_eq!(
            parsed["trips"]["T2"], 0,
            "two trips on the same route share one routes entry"
        );
        assert_eq!(parsed["trips"]["T3"], 1);
    }

    /// GTFS trip_id may legally be a numeric-looking string. Node's `trips`
    /// map (`Object.create(null)`) is still subject to JS
    /// OrdinaryOwnPropertyKeys integer-index reordering (prototype is
    /// irrelevant to enumeration order) — numeric-looking trip ids must
    /// enumerate ahead of non-numeric ones, ascending, regardless of the
    /// order trips were interned in.
    #[test]
    fn trip_route_json_reorders_numeric_trip_ids_like_js_object_keys() {
        let mut inputs = two_route_inputs();
        // Insertion order via iterTrips-equivalent: "stopA-ish" trip_id
        // first, then two numeric-looking trip ids that are NOT already
        // ascending.
        inputs.trips = vec![
            TileTrip {
                trip_id: "tripA".into(),
                route_idx: 0,
                service_idx: 0,
                headsign: "H1".into(),
            },
            TileTrip {
                trip_id: "42".into(),
                route_idx: 0,
                service_idx: 0,
                headsign: "H2".into(),
            },
            TileTrip {
                trip_id: "7".into(),
                route_idx: 1,
                service_idx: 0,
                headsign: "H3".into(),
            },
        ];
        let body = trip_route_json(&inputs);
        // NOTE: not parsed via serde_json::Value — this crate doesn't
        // enable serde_json's `preserve_order` feature, so Value's object
        // map re-sorts keys alphabetically (BTreeMap), hiding the
        // reordering bug under test. Check raw byte order instead.
        let text = String::from_utf8(body).unwrap();
        let pos = |needle: &str| text.find(needle).unwrap();
        assert!(
            pos("\"7\":") < pos("\"42\":") && pos("\"42\":") < pos("\"tripA\":"),
            "numeric-looking trip ids must sort ascending ahead of non-numeric ids; got: {text}"
        );
    }

    #[test]
    fn stop_cell_json_preserves_insertion_order() {
        let mut result = empty_result();
        result
            .stop_tile_coords
            .insert("S2".to_string(), "1_2".to_string());
        result
            .stop_tile_coords
            .insert("S1".to_string(), "1_2-0".to_string());
        let body = stop_cell_json(&result);
        // Compact JSON — insertion order preserved (S2 before S1), matching
        // Object.fromEntries(result.stopTileCoords) over a Map.
        let text = String::from_utf8(body).unwrap();
        let s2_pos = text.find("S2").unwrap();
        let s1_pos = text.find("S1").unwrap();
        assert!(
            s2_pos < s1_pos,
            "insertion order must be preserved, not sorted"
        );
        assert_eq!(text, r#"{"S2":"1_2","S1":"1_2-0"}"#);
    }

    /// GTFS stop_id may legally be a numeric-looking string. Node builds
    /// stop-cell.json via `Object.fromEntries(result.stopTileCoords)`, a
    /// real JS object, so numeric-looking stop ids enumerate ahead of
    /// non-numeric ones (ascending), regardless of insertion order —
    /// mirrors the "S1"/"S2" non-numeric test above, which stays valid
    /// unchanged since only integer-index-shaped keys move.
    #[test]
    fn stop_cell_json_reorders_numeric_stop_ids_like_js_object_keys() {
        let mut result = empty_result();
        result
            .stop_tile_coords
            .insert("stopA".to_string(), "1_2".to_string());
        result
            .stop_tile_coords
            .insert("42".to_string(), "1_2-0".to_string());
        result
            .stop_tile_coords
            .insert("7".to_string(), "1_2-1".to_string());
        let body = stop_cell_json(&result);
        // NOTE: not parsed via serde_json::Value — this crate doesn't
        // enable serde_json's `preserve_order` feature, so Value's object
        // map re-sorts keys alphabetically (BTreeMap), hiding the
        // reordering bug under test. Check raw byte order instead, like
        // the sibling insertion-order test above.
        let text = String::from_utf8(body).unwrap();
        let pos = |needle: &str| text.find(needle).unwrap();
        assert!(
            pos("\"7\":") < pos("\"42\":") && pos("\"42\":") < pos("\"stopA\":"),
            "numeric stop ids must sort ascending ahead of non-numeric ids; got: {text}"
        );
    }
}
