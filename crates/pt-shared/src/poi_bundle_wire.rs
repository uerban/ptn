//! Full-fidelity wire format for POI bundles - port of `PoiEntry`/
//! `PoiBundle`/`PoiBundleMeta` (`packages/shared/src/poi/bundleFormat.ts`).
//!
//! Unlike `schedule_tile_wire.rs`'s deliberately-partial decode (that route
//! only ever resolves trip ids, never re-emits the tile bytes), the
//! poi-tile route echoes every `PoiEntry` field verbatim in its response
//! body. Each entry therefore retains its canonical raw JSON plus only the
//! typed fields needed to validate and index it.
//!
//! The bundle producer writes entries with `JSON.stringify`. The route later
//! selects whole entries and stringifies them again, so preserving each entry's
//! original canonical JSON is both cheaper and more faithful than rebuilding it
//! from a typed Rust struct. In particular this retains explicit nulls, unknown
//! forward-compatible fields, object insertion order, and JavaScript's number
//! spelling. Typed fields remain available for tiling and validation.

use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Strict,
    Loose,
}

#[derive(Debug, Clone)]
pub struct PoiEntry {
    pub lat: f64,
    pub lon: f64,
    pub tier: Tier,
    /// Canonical entry JSON emitted by the Node bundle producer.
    #[doc(hidden)]
    pub raw_json: Box<RawValue>,
}

impl PartialEq for PoiEntry {
    fn eq(&self, other: &Self) -> bool {
        self.lat == other.lat
            && self.lon == other.lon
            && self.tier == other.tier
            && self.raw_json.get() == other.raw_json.get()
    }
}

#[derive(Deserialize)]
struct PoiEntryFields {
    lat: f64,
    lon: f64,
    tier: Tier,
}

impl<'de> Deserialize<'de> for PoiEntry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let fields: PoiEntryFields = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
        Ok(Self {
            lat: fields.lat,
            lon: fields.lon,
            tier: fields.tier,
            raw_json: raw,
        })
    }
}

impl Serialize for PoiEntry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.raw_json.serialize(serializer)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoiBundleMeta {
    #[serde(rename = "cityId")]
    pub city_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<String>,
    #[serde(
        rename = "licenseUrl",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub license_url: Option<String>,
    #[serde(
        rename = "sourcePbfTimestamp",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub source_pbf_timestamp: Option<String>,
    #[serde(
        rename = "bundleGeneratedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub bundle_generated_at: Option<String>,
    pub tier: Tier,
    #[serde(rename = "entryCount")]
    pub entry_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoiBundle {
    pub meta: PoiBundleMeta,
    pub entries: Vec<PoiEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry_json() -> &'static str {
        r#"{
            "id": "e1",
            "name": "Gdańsk Główny",
            "aliases": {"en": ["Gdansk Main Station"]},
            "category": "train_station",
            "lat": 54.355,
            "lon": 18.646,
            "source": "osm",
            "rankBoost": 1.5,
            "wikidataId": "Q1234",
            "nearestStopGroupId": null,
            "osmId": "way/123",
            "tier": "strict"
        }"#
    }

    #[test]
    fn decodes_only_route_fields_while_retaining_raw_json() {
        let e: PoiEntry = serde_json::from_str(sample_entry_json()).expect("decodes");
        assert_eq!(e.lat, 54.355);
        assert_eq!(e.lon, 18.646);
        assert_eq!(e.tier, Tier::Strict);
    }

    #[test]
    fn round_trips_through_serialize_deserialize() {
        let e: PoiEntry = serde_json::from_str(sample_entry_json()).expect("decodes");
        let reencoded = serde_json::to_string(&e).expect("serializes");
        let e2: PoiEntry = serde_json::from_str(&reencoded).expect("re-decodes");
        assert_eq!(e, e2);
        assert!(
            reencoded.contains(r#""nearestStopGroupId": null"#),
            "explicit null is retained verbatim"
        );
    }

    #[test]
    fn absent_optional_fields_remain_absent_on_encode() {
        let json = r#"{
            "id": "e2", "name": "n", "aliases": {}, "category": "c",
            "lat": 0, "lon": 0, "source": "curated", "rankBoost": 0, "tier": "loose"
        }"#;
        let e: PoiEntry = serde_json::from_str(json).expect("decodes");
        let encoded = serde_json::to_string(&e).expect("serializes");
        assert!(!encoded.contains("wikidataId"));
        assert!(!encoded.contains("nearestStopGroupId"));
        assert!(!encoded.contains("osmId"));
    }

    #[test]
    fn ignores_unneeded_typed_fields_during_decode() {
        let json = r#"{"lat":54.4,"lon":18.6,"tier":"loose","future":"kept"}"#;
        let entry: PoiEntry = serde_json::from_str(json).expect("minimal route fields decode");
        assert_eq!(entry.tier, Tier::Loose);
        assert_eq!(serde_json::to_string(&entry).unwrap(), json);
    }

    #[test]
    fn preserves_unknown_fields_alias_order_and_number_spelling() {
        let json = r#"{"id":"e3","name":"n","aliases":{"pl":["a"],"en":["b"]},"category":"c","lat":0,"lon":1,"source":"osm","rankBoost":0,"nearestStopGroupId":null,"future":{"x":1},"tier":"strict"}"#;
        let entry: PoiEntry = serde_json::from_str(json).expect("decodes");
        assert_eq!(
            serde_json::to_string(&entry).expect("serializes"),
            json,
            "producer-canonical entry JSON must be emitted byte-for-byte"
        );
    }

    #[test]
    fn decodes_full_bundle_shape() {
        let json = format!(
            r#"{{
                "meta": {{
                    "cityId": "gdansk",
                    "version": "1",
                    "attribution": "© OpenStreetMap contributors",
                    "licenseUrl": "https://opendatacommons.org/licenses/odbl/",
                    "sourcePbfTimestamp": "2026-01-01T00:00:00Z",
                    "bundleGeneratedAt": "2026-01-02T00:00:00Z",
                    "tier": "strict",
                    "entryCount": 1
                }},
                "entries": [{}]
            }}"#,
            sample_entry_json()
        );
        let bundle: PoiBundle = serde_json::from_str(&json).expect("decodes bundle");
        assert_eq!(bundle.meta.city_id, "gdansk");
        assert_eq!(bundle.entries.len(), 1);
    }

    #[test]
    fn decodes_bundle_when_unused_meta_fields_are_omitted() {
        let json = format!(
            r#"{{
                "meta": {{
                    "cityId": "gdansk",
                    "tier": "strict",
                    "entryCount": 1
                }},
                "entries": [{}]
            }}"#,
            sample_entry_json()
        );
        let bundle: PoiBundle = serde_json::from_str(&json).expect("minimal bundle decodes");
        assert_eq!(bundle.meta.version, None);
        assert_eq!(bundle.meta.attribution, None);
        assert_eq!(bundle.meta.license_url, None);
        assert_eq!(bundle.meta.source_pbf_timestamp, None);
        assert_eq!(bundle.meta.bundle_generated_at, None);
        let encoded = serde_json::to_value(&bundle).expect("minimal bundle serializes");
        assert!(encoded["meta"].get("version").is_none());
        assert!(encoded["meta"].get("attribution").is_none());
        assert!(encoded["meta"].get("licenseUrl").is_none());
        assert!(encoded["meta"].get("sourcePbfTimestamp").is_none());
        assert!(encoded["meta"].get("bundleGeneratedAt").is_none());
    }
}
