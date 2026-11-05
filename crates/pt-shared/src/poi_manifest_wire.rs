//! POI manifest (`schemaVersion` 1) reader shared by Rust serving code.

use crate::poi_tile_grid::TileAnchor;
use serde::{de::DeserializeOwned, Deserialize, Deserializer};
use serde_json::value::RawValue;
use std::marker::PhantomData;

/// The only POI `manifest.json` schemaVersion; readers reject every other value.
pub const POI_MANIFEST_SCHEMA_VERSION: u64 = 1;
/// Startup validation and fixed serving-memory reservation share this limit.
pub const MAX_POI_CITY_SLOTS: u64 = 5;

#[derive(Debug, Clone, Deserialize)]
pub struct PoiManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u64,
    pub bundles: Vec<PoiManifestBundle>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoiManifestBundle {
    #[serde(rename = "cityId")]
    pub city_id: String,
    pub filename: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub sha256: String,
    #[serde(rename = "poiTile")]
    pub poi_tile: Option<DeferredJson<PoiTileManifest>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoiTileManifest {
    #[serde(rename = "edgeKm", default)]
    pub edge_km: Option<DeferredJson<f64>>,
    #[serde(default)]
    pub anchor: Option<DeferredJson<TileAnchor>>,
    #[serde(rename = "deliveryActive", default)]
    pub delivery_active: Option<DeferredJson<bool>>,
    #[serde(rename = "tilingPolicy", default)]
    pub tiling_policy: Option<DeferredJson<PoiTilingPolicy>>,
    #[serde(rename = "kAnonWaived", default)]
    pub k_anon_waived: Option<DeferredJson<bool>>,
    #[serde(rename = "tileBounds", default)]
    pub tile_bounds: Option<DeferredJson<PoiTileBounds>>,
}

/// Raw JSON whose type is checked only when the serving contract activates.
///
/// The complete `poiTile` value is deferred so a record whose contract is never
/// resolved (a loose record, say) cannot fail the whole manifest decode. Once a
/// value decodes as [`PoiTileManifest`], its individual fields remain deferred
/// so inactive records can ignore active-only values.
#[derive(Debug, Clone)]
pub struct DeferredJson<T> {
    raw: Box<RawValue>,
    expected: PhantomData<fn() -> T>,
}

impl<T> DeferredJson<T> {
    pub fn raw_json(&self) -> &str {
        self.raw.get()
    }
}

impl<T: DeserializeOwned> DeferredJson<T> {
    pub fn decode(&self) -> serde_json::Result<T> {
        serde_json::from_str(self.raw.get())
    }
}

impl<'de, T> Deserialize<'de> for DeferredJson<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Self {
            raw: Box::<RawValue>::deserialize(deserializer)?,
            expected: PhantomData,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PoiTilingPolicy {
    KAnonFloor,
    ByteBudget,
    FixedEdge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoiTileBounds {
    pub min_x: i64,
    pub max_x: i64,
    pub min_y: i64,
    pub max_y: i64,
}

impl PoiManifest {
    /// Return the exact strict record (`<cityId>.br`). Loose records share
    /// `cityId`, so a city-only lookup is not a valid serving contract.
    pub fn strict_bundle(&self, city_id: &str) -> Result<Option<&PoiManifestBundle>, String> {
        if self.schema_version != POI_MANIFEST_SCHEMA_VERSION {
            return Err(format!(
                "unsupported POI manifest schemaVersion {}; expected {POI_MANIFEST_SCHEMA_VERSION}",
                self.schema_version
            ));
        }
        let filename = format!("{city_id}.br");
        let mut matches = self
            .bundles
            .iter()
            .filter(|bundle| bundle.city_id == city_id && bundle.filename == filename);
        let first = matches.next();
        if matches.next().is_some() {
            return Err(format!(
                "POI manifest has duplicate strict records for {city_id}"
            ));
        }
        Ok(first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_tiling(manifest: &PoiManifest) -> PoiTileManifest {
        manifest.bundles[0]
            .poi_tile
            .as_ref()
            .expect("tiling")
            .decode()
            .expect("poiTile is an object")
    }

    #[test]
    fn strict_selector_ignores_loose_record() {
        let manifest: PoiManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"bundles":[
              {"cityId":"vilnius","filename":"vilnius.loose.br","sizeBytes":1,"sha256":"a"},
              {"cityId":"vilnius","filename":"vilnius.br","sizeBytes":2,"sha256":"b",
               "poiTile":{"edgeKm":12,"anchor":{"minLat":54.58,"minLon":25.08,"refLat":54.68},"deliveryActive":true}}
            ]}"#,
        )
        .expect("manifest decodes");
        let selected = manifest
            .strict_bundle("vilnius")
            .expect("selector succeeds")
            .expect("strict record exists");
        assert_eq!(selected.filename, "vilnius.br");
    }

    #[test]
    fn poi_tile_object_is_deferred_whole() {
        let manifest = serde_json::from_str::<PoiManifest>(
            r#"{"schemaVersion":1,"bundles":[{
              "cityId":"vilnius","filename":"vilnius.br","sizeBytes":2,"sha256":"b",
              "poiTile":{"edgeKm":12,"anchor":{"minLat":54.58,"minLon":25.08,"refLat":54.68}}
            }]}"#,
        )
        .expect("poiTile is deferred on decode");
        assert_eq!(
            manifest.bundles[0]
                .poi_tile
                .as_ref()
                .expect("raw poiTile")
                .raw_json(),
            r#"{"edgeKm":12,"anchor":{"minLat":54.58,"minLon":25.08,"refLat":54.68}}"#
        );
    }

    #[test]
    fn delivery_contract_fields_decode() {
        let manifest = serde_json::from_str::<PoiManifest>(
            r#"{"schemaVersion":1,"bundles":[{
              "cityId":"vilnius","filename":"vilnius.br","sizeBytes":2,"sha256":"b",
              "poiTile":{
                "edgeKm":12,
                "anchor":{"minLat":54.58,"minLon":25.08,"refLat":54.68},
                "deliveryActive":true,
                "tilingPolicy":"byte-budget",
                "kAnonWaived":true,
                "tileBounds":{"minX":-1,"maxX":2,"minY":0,"maxY":3}
              }
            }]}"#,
        )
        .expect("manifest decodes");
        let tiling = decode_tiling(&manifest);
        assert_eq!(
            tiling
                .edge_km
                .as_ref()
                .expect("edgeKm")
                .decode()
                .expect("edgeKm decodes"),
            12.0
        );
        assert!(tiling.anchor.as_ref().expect("anchor").decode().is_ok());
        assert!(tiling
            .delivery_active
            .as_ref()
            .expect("deliveryActive")
            .decode()
            .expect("deliveryActive decodes"));
        assert_eq!(
            tiling
                .tiling_policy
                .as_ref()
                .expect("tilingPolicy")
                .decode()
                .expect("tilingPolicy decodes"),
            PoiTilingPolicy::ByteBudget
        );
        assert!(tiling
            .k_anon_waived
            .as_ref()
            .expect("kAnonWaived")
            .decode()
            .expect("kAnonWaived decodes"));
        assert_eq!(
            tiling
                .tile_bounds
                .as_ref()
                .expect("tileBounds")
                .decode()
                .expect("tileBounds decodes"),
            PoiTileBounds {
                min_x: -1,
                max_x: 2,
                min_y: 0,
                max_y: 3,
            }
        );
    }

    #[test]
    fn inactive_tiling_decodes_without_active_only_fields() {
        let manifest = serde_json::from_str::<PoiManifest>(
            r#"{"schemaVersion":1,"bundles":[{
              "cityId":"vilnius","filename":"vilnius.br","sizeBytes":2,"sha256":"b",
              "poiTile":{"deliveryActive":false}
            }]}"#,
        )
        .expect("inactive tiling does not require active-only fields");
        let tiling = decode_tiling(&manifest);
        assert!(!tiling
            .delivery_active
            .as_ref()
            .expect("deliveryActive")
            .decode()
            .expect("deliveryActive decodes"));
        assert!(tiling.edge_km.is_none());
        assert!(tiling.anchor.is_none());
        assert!(tiling.tiling_policy.is_none());
        assert!(tiling.k_anon_waived.is_none());
        assert!(tiling.tile_bounds.is_none());
    }

    #[test]
    fn accepts_any_poi_tile_json_type_without_decoding_it() {
        for raw in [
            "false",
            "42",
            r#""legacy""#,
            "[]",
            r#"{"deliveryActive":"wrong"}"#,
            "null",
        ] {
            let json = format!(
                r#"{{"schemaVersion":1,"futureManifestField":true,"bundles":[{{
                  "cityId":"vilnius","filename":"vilnius.br","sizeBytes":2,"sha256":"b",
                  "futureBundleField":{{"accepted":true}},
                  "poiTile":{raw}
                }}]}}"#
            );
            let manifest = serde_json::from_str::<PoiManifest>(&json)
                .unwrap_or_else(|error| panic!("decode must defer poiTile={raw}: {error}"));
            if raw == "null" {
                assert!(manifest.bundles[0].poi_tile.is_none());
            } else {
                assert_eq!(
                    manifest.bundles[0]
                        .poi_tile
                        .as_ref()
                        .expect("non-null raw poiTile")
                        .raw_json(),
                    raw
                );
            }
        }
    }

    #[test]
    fn missing_poi_tile_decodes_as_inactive_candidate() {
        let manifest = serde_json::from_str::<PoiManifest>(
            r#"{"schemaVersion":1,"bundles":[{
              "cityId":"vilnius","filename":"vilnius.br","sizeBytes":2,"sha256":"b",
              "futureBundleField":"accepted"
            }]}"#,
        )
        .expect("a record may omit poiTile");
        assert!(manifest.bundles[0].poi_tile.is_none());
    }

    #[test]
    fn inactive_defers_malformed_active_only_fields() {
        let manifest = serde_json::from_str::<PoiManifest>(
            r#"{"schemaVersion":1,"bundles":[{
              "cityId":"vilnius","filename":"vilnius.br","sizeBytes":2,"sha256":"b",
              "poiTile":{
                "deliveryActive":false,
                "edgeKm":"wrong",
                "anchor":[],
                "tilingPolicy":{"wrong":"type"},
                "kAnonWaived":"wrong",
                "tileBounds":42,
                "futurePoiTileField":true
              }
            }]}"#,
        )
        .expect("inactive tiling ignores malformed active-only fields");
        let tiling = decode_tiling(&manifest);
        assert!(!tiling
            .delivery_active
            .as_ref()
            .expect("deliveryActive")
            .decode()
            .expect("deliveryActive decodes"));
        assert!(tiling.edge_km.as_ref().expect("edgeKm").decode().is_err());
        assert!(tiling.anchor.as_ref().expect("anchor").decode().is_err());
        assert!(tiling
            .tiling_policy
            .as_ref()
            .expect("tilingPolicy")
            .decode()
            .is_err());
        assert!(tiling
            .k_anon_waived
            .as_ref()
            .expect("kAnonWaived")
            .decode()
            .is_err());
        assert!(tiling
            .tile_bounds
            .as_ref()
            .expect("tileBounds")
            .decode()
            .is_err());
    }

    #[test]
    fn strict_selector_rejects_every_other_schema_version() {
        for version in [0, 2, 3] {
            let manifest: PoiManifest =
                serde_json::from_str(&format!(r#"{{"schemaVersion":{version},"bundles":[]}}"#))
                    .expect("manifest decodes");
            let error = manifest
                .strict_bundle("vilnius")
                .expect_err("only schemaVersion 1 is served");
            assert!(
                error.contains(&format!("schemaVersion {version}")),
                "{error}"
            );
        }
    }
}
