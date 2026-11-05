//! Wire-format manifest types.
//!
//! Two JSON shapes:
//! - [`GenerationManifest`] — per-generation: lives at
//!   `<data_root>/generations/<generation_id>/generation.json`. Records the
//!   bundle's content-derived identifiers (SHA-256, sizes), feed anchor, and
//!   optional transfers artifact.
//! - [`PointerManifest`] — pointer file: lives at `<data_root>/current.json`
//!   and `<data_root>/last-good.json`. Points at a generation by id; lets the
//!   producer publish a new generation atomically (write tmp + rename).
//!
//! ## Postel rule (deserialization)
//!
//! Both shapes deserialize leniently: unknown fields are silently dropped. This is by design: a
//! future producer rev introducing a new field must NOT break older pt-serve binaries. We achieve
//! this by **not** adding `#[serde(deny_unknown_fields)]`.
//!
//! ## Grammar invariant — enforced in validators, not in `Deserialize`
//!
//! Schema 2 binds `generation_id` to the PTB hash and publication-input digest. We do NOT enforce
//! this via `#[serde(try_from =...)]` — instead, the validator surface in [`crate::validate`]
//! checks it after parse. Rationale: a custom `TryFrom` impl would conflate parse-shape and
//! semantic invariants, making the error path harder to classify (and harder for the 5-class
//! `ValidationError` taxonomy to distinguish "wire-shape malformed" from "wire-shape OK but
//! invariant violated").

use serde::{Deserialize, Serialize};

/// Per-generation manifest. One per `<data_root>/generations/<generation_id>/`.
///
/// All `*_sha256` fields are lowercase hex (64 chars). All `*_size_bytes`
/// fields are the on-disk size as observed by the producer at publish time.
///
/// `feed_start_date` is the YYYYMMDD u32 anchor that pins the 90-day service bitmask window — MUST
/// be cross-checked against the PTB header at load time (manifest↔bundle pairing).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GenerationManifest {
    /// Schema `2` is written today; readers still accept schema `1`. Other
    /// schemas fail closed in metadata validation.
    pub manifest_schema_version: u32,
    /// Schema 2: content-derived publication ID binding the PTB hash and the
    /// effective input digest. Schema 1: the PTB hash itself.
    pub generation_id: String,
    /// Operator-supplied city slug. Cross-checked against the running
    /// pt-serve's `--city` flag; a mismatch is a fail-closed error.
    pub city_slug: String,
    /// Full-content SHA-256 of `bundle.ptb` (lowercase hex, 64 chars).
    pub bundle_sha256: String,
    /// Digest of effective sidecar inputs, producer code and build settings.
    /// Absent (empty) on schema-1 generations, which predate it.
    #[serde(default)]
    pub publication_inputs_sha256: String,
    /// On-disk size of `bundle.ptb` at publish time.
    pub bundle_size_bytes: u64,
    /// 90-day service-window anchor (YYYYMMDD u32). Cross-checked against the
    /// PTB header at load time.
    pub feed_start_date: u32,
    /// Whether a transfers artifact is published alongside the bundle.
    pub has_transfers: bool,
    /// SHA-256 of `transfers.bin` (lowercase hex). `Some` iff `has_transfers`.
    pub transfers_sha256: Option<String>,
    /// On-disk size of `transfers.bin`. `Some` iff `has_transfers`.
    pub transfers_size_bytes: Option<u64>,
    /// ISO-8601 timestamp (RFC 3339) of when the producer published this
    /// generation. Used for `/version` exposition and `last-good` staleness
    /// telemetry.
    pub created_at: String,

    /// SHA-256 of `*.departures-idx.bin` (lowercase hex). Plan-C1a writes
    /// `None`; Plan-C1b populates with the real sha when the sidecar lands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub departures_idx_sha256: Option<String>,

    /// SHA-256 of `*.shapes.bin` (lowercase hex). Plan-C1a writes `None`;
    /// Plan-C1c populates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shapes_bin_sha256: Option<String>,

    /// SHA-256 (lowercase hex) of `color-config.json`. Plan-C-color-provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_config_sha256: Option<String>,

    /// SHA-256 (lowercase hex) of `route-styles.json`. Plan-C-color-provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_styles_sha256: Option<String>,

    /// SHA-256 (lowercase hex) of `label-anchors.json`. Plan-C2a.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_anchors_sha256: Option<String>,

    /// SHA-256 (lowercase hex) of the canonical shapes JSON body (NOT the
    /// binary `shapes.bin` — that is `shapes_bin_sha256`). Recorded so
    /// `raptor-data` can advertise the content-address pt-serve serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shapes_json_sha256: Option<String>,

    /// Byte length of the canonical shapes JSON body (for `raptor-data`'s
    /// `meta.shapesArtifact.sizeBytes`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shapes_json_size_bytes: Option<u64>,

    /// Canonical IANA tz name for the city this generation serves. Plan-C1a
    /// onward writes `Some(...)`; older generations leave this `None` and
    /// pt-serve falls back to a per-city compose-env default at load time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city_tz_iana: Option<String>,

    /// windowDays Step A.4 — the DERIVED service-window length (days) this
    /// generation's service bitmask was built at. `Some(90)` on a 90-default
    /// feed (which emits NO `0x01` region); `Some(>90)` carries the `0x01`
    /// WindowMeta region.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_days: Option<u16>,

    /// windowDays fidelity: the feed horizon exceeded the 400-day ceiling and
    /// the window was capped. Recorded for operator triage; default `false`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub window_clamped_high: bool,

    /// windowDays fidelity: the feed horizon (incl. stale / empty-fold feeds)
    /// fell below the 90-day floor and the window was raised. Default `false`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub window_floored_low: bool,

    /// Number of distinct deduplicated service bitfields in the
    /// `0x15 ServiceBitfieldPool`. With
    /// `num_services` it gives operators the dedup ratio `count / numServices`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_bitfield_pool_count: Option<u32>,

    /// Number of GTFS services (calendars), the denominator for the `0x15`
    /// deduplication ratio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_services: Option<u32>,

    /// Schedule-tile producer-build (interim spike-killer): SHA-256 (lowercase
    /// hex) of the producer-built `schedule-tiles/manifest.json`. The Rust producer
    /// shells out to `schedule-tile-gen.mjs` (sibling of the color-artifacts
    /// step), records this, and cross-checks it at publish + the backend at
    /// load (bridge pattern). `None` on generations built before the producer
    /// tile build (Postel rule — absent on the wire when None).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_tile_bundle_sha256: Option<String>,

    /// Schedule-tile producer-build: the bundle hash the producer built the
    /// tiles under (= `generationId`, distinct from PTB content SHA). The backend
    /// advertises + serves tiles under this hash from the generation dir
    /// (bridge pattern). `None` on generations built before the producer tile
    /// build.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_tile_bundle_hash: Option<String>,

    /// C4 (B4 producer-artifact shed): SHA-256 (lowercase hex) of the
    /// producer-built `trip-route.json` (the interned `{routes, trips}` map
    /// that lets producer-mode RT group by route without the resident GTFS
    /// index). Required iff the schedule-tile build ran; `None` otherwise
    /// (Postel rule — absent on the wire when None).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trip_route_sha256: Option<String>,

    /// C4 (B6 producer-artifact shed): SHA-256 (lowercase hex) of the
    /// producer-built `stop-cell.json` (the `{stopId: tileCoords}` map that
    /// replaces the lat/lon cell descent). Required iff the schedule-tile build
    /// ran; `None` otherwise (Postel rule — absent on the wire when None).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_cell_sha256: Option<String>,
}

/// `skip_serializing_if` helper — omit `false` booleans from the wire so a
/// 90-default generation's manifest stays minimal (and byte-stable vs the
/// pre-Step-A.4 schema when all four window fields are at their defaults).
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

/// Pointer file. Two are written by the producer: `current.json` (target of
/// hot-reload), and `last-good.json` (validated-OK fallback). Both point at a
/// generation in `<data_root>/generations/<generation_id>/`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PointerManifest {
    /// Schema-version pin. Same semantics as `GenerationManifest`.
    pub manifest_schema_version: u32,
    /// Target generation id. Loader resolves this to
    /// `<data_root>/generations/<generation_id>/generation.json`.
    pub generation_id: String,
    /// Operator-supplied city slug; mirrored from the generation manifest so a
    /// loader can fail closed without first opening the generation dir.
    pub city_slug: String,
    /// ISO-8601 publish timestamp.
    pub created_at: String,
}

/// Maximum supported `manifest_schema_version`. Bump when a NEW required field
/// is added; never bump for an OPTIONAL addition (Postel rule covers that).
pub const MANIFEST_SCHEMA_VERSION_MAX: u32 = 2;

/// Oldest `manifest_schema_version` readers still accept. Schema-1
/// generations predate the publication id; an upgraded reader keeps serving
/// them and the producer's janitor keeps retaining them.
pub const MANIFEST_SCHEMA_VERSION_MIN: u32 = 1;

/// Versioned publication identity. PTB content identity remains `bundle_sha256`;
/// the generation changes when effective OSM inputs or build settings change.
pub fn publication_id(bundle_sha256: &str, inputs_sha256: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"ptn-publication-v1\0");
    hash.update(bundle_sha256.as_bytes());
    hash.update(b"\0");
    hash.update(inputs_sha256.as_bytes());
    format!("{:x}", hash.finalize())
}

/// Default `feed_stale_days` threshold. The reload runner / `/ready` handler use this to decide
/// when to expose `feed_stale=true` and trip the readiness probe. Operators can override via
/// config.
pub const FEED_STALE_DAYS_DEFAULT: u32 = 80;

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal valid `GenerationManifest` for `..sample_manifest()` spread in
    /// tests that only vary one or two fields. All optionals default to `None`.
    fn sample_manifest() -> GenerationManifest {
        GenerationManifest {
            manifest_schema_version: 1,
            generation_id: "abc123".into(),
            city_slug: "vilnius".into(),
            bundle_sha256: "abc123".into(),
            publication_inputs_sha256: "0".repeat(64),
            bundle_size_bytes: 4096,
            feed_start_date: 20260501,
            has_transfers: false,
            transfers_sha256: None,
            transfers_size_bytes: None,
            created_at: "2026-05-23T10:00:00Z".into(),
            departures_idx_sha256: None,
            shapes_bin_sha256: None,
            color_config_sha256: None,
            route_styles_sha256: None,
            label_anchors_sha256: None,
            shapes_json_sha256: None,
            shapes_json_size_bytes: None,
            city_tz_iana: None,
            window_days: None,
            window_clamped_high: false,
            window_floored_low: false,
            service_bitfield_pool_count: None,
            num_services: None,
            schedule_tile_bundle_sha256: None,
            schedule_tile_bundle_hash: None,
            trip_route_sha256: None,
            stop_cell_sha256: None,
        }
    }

    #[test]
    fn generation_manifest_roundtrips() {
        let m = GenerationManifest {
            manifest_schema_version: 1,
            generation_id: "abc123".into(),
            city_slug: "vilnius".into(),
            bundle_sha256: "abc123".into(),
            publication_inputs_sha256: "0".repeat(64),
            bundle_size_bytes: 4096,
            feed_start_date: 20260501,
            has_transfers: true,
            transfers_sha256: Some("def456".into()),
            transfers_size_bytes: Some(1024),
            created_at: "2026-05-23T10:00:00Z".into(),
            departures_idx_sha256: None,
            shapes_bin_sha256: None,
            color_config_sha256: None,
            route_styles_sha256: None,
            label_anchors_sha256: None,
            shapes_json_sha256: None,
            shapes_json_size_bytes: None,
            city_tz_iana: None,
            window_days: Some(330),
            window_clamped_high: false,
            window_floored_low: false,
            service_bitfield_pool_count: Some(7),
            num_services: Some(42),
            schedule_tile_bundle_sha256: Some("aa".into()),
            schedule_tile_bundle_hash: Some("bb".into()),
            trip_route_sha256: None,
            stop_cell_sha256: None,
        };
        let json = serde_json::to_string(&m).unwrap();
        let parsed: GenerationManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.generation_id, "abc123");
        assert_eq!(parsed.feed_start_date, 20260501);
        assert!(parsed.has_transfers);
        // Confirm camelCase on the wire — the bare `feed_start_date`
        // (snake_case Rust field) MUST be rendered as `feedStartDate`.
        assert!(json.contains("feedStartDate"));
        assert!(json.contains("citySlug"));
        assert!(!json.contains("feed_start_date"));
        // A present window renders camelCase; both
        // default-`false` fidelity flags are omitted from the wire.
        assert_eq!(parsed.window_days, Some(330));
        assert!(json.contains("windowDays"));
        assert!(!json.contains("windowClampedHigh"));
        assert!(!json.contains("windowFlooredLow"));
        // Deduplication provenance fields render camelCase when
        // present and round-trip.
        assert_eq!(parsed.service_bitfield_pool_count, Some(7));
        assert_eq!(parsed.num_services, Some(42));
        assert!(json.contains("serviceBitfieldPoolCount"));
        assert!(json.contains("numServices"));
        // Schedule-tile producer-build: present values render camelCase + round-trip.
        assert_eq!(parsed.schedule_tile_bundle_sha256.as_deref(), Some("aa"));
        assert_eq!(parsed.schedule_tile_bundle_hash.as_deref(), Some("bb"));
        assert!(json.contains("scheduleTileBundleSha256"));
        assert!(json.contains("scheduleTileBundleHash"));
    }

    #[test]
    fn pointer_manifest_roundtrips() {
        let p = PointerManifest {
            manifest_schema_version: 1,
            generation_id: "gen_xyz".into(),
            city_slug: "vilnius".into(),
            created_at: "2026-05-23T10:00:00Z".into(),
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: PointerManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.generation_id, "gen_xyz");
        assert!(json.contains("generationId"));
    }

    /// Postel rule: unknown fields parse without error. A producer rev adding
    /// a field MUST NOT break older pt-serve binaries.
    #[test]
    fn generation_manifest_ignores_unknown_fields() {
        let json = r#"{
            "manifestSchemaVersion": 1,
            "generationId": "abc",
            "citySlug": "vilnius",
            "publicationInputsSha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "bundleSha256": "abc",
            "bundleSizeBytes": 4096,
            "feedStartDate": 20260501,
            "hasTransfers": false,
            "transfersSha256": null,
            "transfersSizeBytes": null,
            "createdAt": "2026-05-23T10:00:00Z",
            "futureRevField": "ignored",
            "anotherOne": 42
        }"#;
        let parsed: GenerationManifest = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.generation_id, "abc");
    }

    /// Plan-C1a Postel-compliant addition: three new Optional fields can be
    /// populated on a `manifestSchemaVersion: 1` manifest and parse cleanly.
    /// Tightens the contract that NEW required-field additions warrant a
    /// schema bump, but NEW optional-field additions do not.
    #[test]
    fn manifest_with_optional_fields_is_schema_v1_compat() {
        let json = serde_json::json!({
            "manifestSchemaVersion": 1,
            "generationId": "abc123",
            "citySlug": "vilnius",
            "publicationInputsSha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "bundleSha256": "def456",
            "bundleSizeBytes": 1024,
            "feedStartDate": 20260501,
            "hasTransfers": false,
            "createdAt": "2026-05-27T00:00:00Z",
            "cityTzIana": "Europe/Vilnius",
            "departuresIdxSha256": null,
            "shapesBinSha256": null
        });
        let parsed: GenerationManifest = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.manifest_schema_version, 1);
        assert_eq!(parsed.city_tz_iana.as_deref(), Some("Europe/Vilnius"));
        assert!(parsed.departures_idx_sha256.is_none());
        assert!(parsed.shapes_bin_sha256.is_none());
    }

    /// A manifest with the new Optional fields absent (i.e. older producer
    /// rev that pre-dates Plan-C1a) parses cleanly — `#[serde(default)]` on
    /// the new fields makes them default to `None`.
    #[test]
    fn manifest_without_optional_fields_still_parses() {
        let json = r#"{
            "manifestSchemaVersion": 1,
            "generationId": "abc",
            "citySlug": "vilnius",
            "publicationInputsSha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "bundleSha256": "abc",
            "bundleSizeBytes": 4096,
            "feedStartDate": 20260501,
            "hasTransfers": false,
            "transfersSha256": null,
            "transfersSizeBytes": null,
            "createdAt": "2026-05-23T10:00:00Z"
        }"#;
        let parsed: GenerationManifest = serde_json::from_str(json).unwrap();
        assert!(parsed.departures_idx_sha256.is_none());
        assert!(parsed.shapes_bin_sha256.is_none());
        assert!(parsed.city_tz_iana.is_none());
    }

    /// `skip_serializing_if = "Option::is_none"` means the new fields don't
    /// show up on the wire when None — older pt-serve binaries reading the
    /// produced JSON won't see the extra keys.
    #[test]
    fn manifest_omits_none_optional_fields_on_serialize() {
        let m = GenerationManifest {
            manifest_schema_version: 1,
            generation_id: "abc".into(),
            city_slug: "vilnius".into(),
            bundle_sha256: "abc".into(),
            publication_inputs_sha256: "0".repeat(64),
            bundle_size_bytes: 4096,
            feed_start_date: 20260501,
            has_transfers: false,
            transfers_sha256: None,
            transfers_size_bytes: None,
            created_at: "2026-05-23T10:00:00Z".into(),
            departures_idx_sha256: None,
            shapes_bin_sha256: None,
            color_config_sha256: None,
            route_styles_sha256: None,
            label_anchors_sha256: None,
            shapes_json_sha256: None,
            shapes_json_size_bytes: None,
            city_tz_iana: None,
            window_days: None,
            window_clamped_high: false,
            window_floored_low: false,
            service_bitfield_pool_count: None,
            num_services: None,
            schedule_tile_bundle_sha256: None,
            schedule_tile_bundle_hash: None,
            trip_route_sha256: None,
            stop_cell_sha256: None,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("departuresIdxSha256"));
        assert!(!json.contains("shapesBinSha256"));
        assert!(!json.contains("cityTzIana"));
        // A missing window and false flags omit all window keys.
        assert!(!json.contains("windowDays"));
        assert!(!json.contains("windowClampedHigh"));
        assert!(!json.contains("windowFlooredLow"));
        // Missing deduplication provenance omits both keys.
        assert!(!json.contains("serviceBitfieldPoolCount"));
        assert!(!json.contains("numServices"));
        // Schedule-tile producer-build: None omits both keys (Postel rule).
        assert!(!json.contains("scheduleTileBundleSha256"));
        assert!(!json.contains("scheduleTileBundleHash"));
        // C2a: None omits the key (Postel rule).
        assert!(!json.contains("labelAnchorsSha256"));
    }

    #[test]
    fn manifest_carries_color_provenance_fields() {
        let json = serde_json::json!({
            "manifestSchemaVersion": 1,
            "generationId": "abc",
            "citySlug": "vilnius",
            "publicationInputsSha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "bundleSha256": "abc",
            "bundleSizeBytes": 4096,
            "feedStartDate": 20260501,
            "hasTransfers": false,
            "createdAt": "2026-05-29T00:00:00Z",
            "colorConfigSha256": "11",
            "routeStylesSha256": "22",
            "shapesJsonSha256": "33",
            "shapesJsonSizeBytes": 12345
        });
        let m: GenerationManifest = serde_json::from_value(json).unwrap();
        assert_eq!(m.color_config_sha256.as_deref(), Some("11"));
        assert_eq!(m.route_styles_sha256.as_deref(), Some("22"));
        assert_eq!(m.shapes_json_sha256.as_deref(), Some("33"));
        assert_eq!(m.shapes_json_size_bytes, Some(12345));
        // Absent on the wire when None (Postel).
        let mut bare = m.clone();
        bare.color_config_sha256 = None;
        bare.route_styles_sha256 = None;
        bare.shapes_json_sha256 = None;
        bare.shapes_json_size_bytes = None;
        let s = serde_json::to_string(&bare).unwrap();
        assert!(
            !s.contains("colorConfigSha256")
                && !s.contains("routeStylesSha256")
                && !s.contains("shapesJsonSha256")
                && !s.contains("shapesJsonSizeBytes")
        );
    }

    /// Plan-C2a: `label_anchors_sha256` round-trips as `"labelAnchorsSha256"` when
    /// `Some`, and is omitted from the wire when `None`.
    #[test]
    fn manifest_carries_label_anchors_sha256() {
        let hex64 = "a".repeat(64);
        let json = serde_json::json!({
            "manifestSchemaVersion": 1,
            "generationId": "abc",
            "citySlug": "vilnius",
            "publicationInputsSha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "bundleSha256": "abc",
            "bundleSizeBytes": 4096,
            "feedStartDate": 20260501,
            "hasTransfers": false,
            "createdAt": "2026-05-29T00:00:00Z",
            "labelAnchorsSha256": hex64
        });
        let m: GenerationManifest = serde_json::from_value(json).unwrap();
        assert_eq!(m.label_anchors_sha256.as_deref(), Some(hex64.as_str()));

        // Round-trips and serializes as camelCase key.
        let serialized = serde_json::to_string(&m).unwrap();
        assert!(serialized.contains("labelAnchorsSha256"));
        assert!(!serialized.contains("label_anchors_sha256"));
        let reparsed: GenerationManifest = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            reparsed.label_anchors_sha256.as_deref(),
            Some(hex64.as_str())
        );

        // Absent on the wire when None (Postel rule).
        let mut bare = m.clone();
        bare.label_anchors_sha256 = None;
        let s = serde_json::to_string(&bare).unwrap();
        assert!(!s.contains("labelAnchorsSha256"));
    }

    /// C4 (B4/B6): `trip_route_sha256` + `stop_cell_sha256` round-trip as
    /// `"tripRouteSha256"` / `"stopCellSha256"` when `Some`.
    #[test]
    fn trip_route_and_stop_cell_shas_roundtrip() {
        let m = GenerationManifest {
            trip_route_sha256: Some("a".repeat(64)),
            stop_cell_sha256: Some("b".repeat(64)),
            ..sample_manifest()
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("tripRouteSha256"));
        assert!(json.contains("stopCellSha256"));
        let back: GenerationManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.trip_route_sha256.as_deref(), Some(&"a".repeat(64)[..]));
        assert_eq!(back.stop_cell_sha256.as_deref(), Some(&"b".repeat(64)[..]));
    }

    /// C4 (B4/B6): both fields absent on the wire when `None` (Postel rule).
    #[test]
    fn trip_route_and_stop_cell_shas_omitted_when_none() {
        let m = GenerationManifest {
            trip_route_sha256: None,
            stop_cell_sha256: None,
            ..sample_manifest()
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("tripRouteSha256"));
        assert!(!json.contains("stopCellSha256"));
    }

    #[test]
    fn pointer_manifest_ignores_unknown_fields() {
        let json = r#"{
            "manifestSchemaVersion": 1,
            "generationId": "gen_xyz",
            "citySlug": "vilnius",
            "createdAt": "2026-05-23T10:00:00Z",
            "experimentalAuthor": "foo"
        }"#;
        let parsed: PointerManifest = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.generation_id, "gen_xyz");
    }
}
