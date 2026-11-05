//! Read-side types for the producer-built `schedule-tiles/manifest.json`
//! (write side: `crates/pt-producer/src/schedule_tiles/artifacts.rs`'s
//! `WireManifest`, Serialize-only). Lives in `pt-shared` alongside
//! [`crate::manifest::GenerationManifest`] — same "shared wire type, Postel
//! rule" convention: unknown fields are silently dropped so a future
//! producer rev doesn't break older pt-serve binaries.
//!
//! Field names mirror the producer's `WireManifest` exactly: `schemaVersion`,
//! `bundleHash`, `generatedAt`, `tileSize`, `subdivisions` (map keyed by
//! `"<x>_<y>"` cell key, omitted entirely when empty) -> `leaves` ->
//! `suffix`/`bbox`/`compressedBytes`/`oversized`, `bbox` ->
//! `minLat`/`maxLat`/`minLon`/`maxLon`. Plain `rename_all = "camelCase"`
//! covers all of these without per-field renames.

use indexmap::IndexMap;
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTileBbox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTileLeaf {
    pub suffix: String,
    pub bbox: ScheduleTileBbox,
    pub compressed_bytes: u64,
    pub oversized: bool,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct ScheduleTileSubdivisionPlan {
    pub leaves: Vec<ScheduleTileLeaf>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTileManifest {
    pub schema_version: u32,
    pub bundle_hash: String,
    pub generated_at: u64,
    pub tile_size: u32,
    #[serde(default)]
    pub subdivisions: Option<IndexMap<String, ScheduleTileSubdivisionPlan>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_without_subdivisions() {
        let json = r#"{
            "schemaVersion": 1,
            "bundleHash": "abc123",
            "generatedAt": 1752300000000,
            "tileSize": 6000
        }"#;
        let m: ScheduleTileManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.schema_version, 1);
        assert_eq!(m.bundle_hash, "abc123");
        assert_eq!(m.generated_at, 1_752_300_000_000);
        assert_eq!(m.tile_size, 6000);
        assert!(m.subdivisions.is_none());
    }

    #[test]
    fn roundtrips_with_subdivisions() {
        let json = r#"{
            "schemaVersion": 1,
            "bundleHash": "abc123",
            "generatedAt": 42,
            "tileSize": 6000,
            "subdivisions": {
                "1_2": {
                    "leaves": [
                        {
                            "suffix": "0",
                            "bbox": {"minLat": 1.0, "maxLat": 2.0, "minLon": 3.0, "maxLon": 4.0},
                            "compressedBytes": 123,
                            "oversized": false
                        }
                    ]
                }
            }
        }"#;
        let m: ScheduleTileManifest = serde_json::from_str(json).unwrap();
        let plans = m.subdivisions.expect("subdivisions present");
        let plan = plans.get("1_2").expect("cell 1_2 present");
        assert_eq!(plan.leaves.len(), 1);
        let leaf = &plan.leaves[0];
        assert_eq!(leaf.suffix, "0");
        assert_eq!(leaf.compressed_bytes, 123);
        assert!(!leaf.oversized);
        assert_eq!(leaf.bbox.min_lat, 1.0);
        assert_eq!(leaf.bbox.max_lon, 4.0);
    }

    /// Postel rule: unknown fields parse without error — a producer rev
    /// adding a field must not break older pt-serve binaries.
    #[test]
    fn ignores_unknown_fields() {
        let json = r#"{
            "schemaVersion": 1,
            "bundleHash": "abc123",
            "generatedAt": 42,
            "tileSize": 6000,
            "futureRevField": "ignored"
        }"#;
        let m: ScheduleTileManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.bundle_hash, "abc123");
    }

    /// Insertion order of `subdivisions` is preserved (IndexMap, not a
    /// re-sorting map) — not load-bearing for this route's logic (keyed
    /// lookup only), but pins the type choice against an accidental
    /// `HashMap`/`BTreeMap` swap.
    #[test]
    fn subdivisions_preserve_insertion_order() {
        let json = r#"{
            "schemaVersion": 1,
            "bundleHash": "abc123",
            "generatedAt": 42,
            "tileSize": 6000,
            "subdivisions": {
                "9_9": {"leaves": []},
                "1_1": {"leaves": []}
            }
        }"#;
        let m: ScheduleTileManifest = serde_json::from_str(json).unwrap();
        let plans = m.subdivisions.expect("subdivisions present");
        let keys: Vec<&str> = plans.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["9_9", "1_1"]);
    }
}
