//! Independent OSM distribution envelope. Hashes identify exact serialized bytes;
//! signatures authenticate those bytes before deserialization by the installer.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_OBJECT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OsmManifest {
    pub schema_version: u32,
    pub city: String,
    pub coverage_e5: [i32; 4],
    pub created_at: String,
    pub source: Source,
    pub builder_revision: String,
    pub configuration_sha256: String,
    pub tools: BTreeMap<String, String>,
    pub attribution: String,
    pub license_url: String,
    pub components: BTreeMap<String, Component>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub url: String,
    /// Upstream snapshot time, never local download time or filesystem mtime.
    pub snapshot_at: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum Component {
    Present {
        format: String,
        #[serde(rename = "formatVersion")]
        format_version: u32,
        compression: Compression,
        sha256: String,
        bytes: u64,
        #[serde(rename = "decodedBytes")]
        decoded_bytes: u64,
    },
    Unsupported {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Compression {
    None,
    Gzip,
    Brotli,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn timestamp_seconds(value: &str) -> Result<i64, String> {
    value
        .parse::<jiff::Timestamp>()
        .map(|t| t.as_second())
        .map_err(|_| "invalid timestamp".to_owned())
}

pub fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Object paths are derived locally; manifests cannot redirect object downloads.
pub fn object_path(sha256: &str) -> Result<String, String> {
    if !valid_digest(sha256) {
        return Err("invalid SHA-256".into());
    }
    Ok(format!("objects/sha256/{sha256}"))
}

impl OsmManifest {
    pub fn validate(&self, expected_city: &str) -> Result<(), String> {
        let fail = |message: &str| Err(message.to_owned());
        if self.schema_version != SCHEMA_VERSION {
            return fail("unsupported OSM manifest schema");
        }
        if self.city != expected_city
            || self.city.is_empty()
            || !self
                .city
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return fail("invalid or unexpected city");
        }
        let [west, south, east, north] = self.coverage_e5;
        if west >= east
            || south >= north
            || west < -18_000_000
            || east > 18_000_000
            || south < -9_000_000
            || north > 9_000_000
        {
            return fail("invalid coverage");
        }
        if !valid_digest(&self.source.sha256) || !valid_digest(&self.configuration_sha256) {
            return fail("invalid provenance checksum");
        }
        for timestamp in [&self.created_at, &self.source.snapshot_at] {
            timestamp
                .parse::<jiff::Timestamp>()
                .map_err(|_| "invalid timestamp".to_owned())?;
        }
        if !self.source.url.starts_with("https://")
            || !self.license_url.starts_with("https://")
            || self.attribution.trim().is_empty()
            || self.builder_revision.trim().is_empty()
        {
            return fail("missing provenance or attribution");
        }
        for required in ["walking", "addresses", "walkGraph", "poi"] {
            if !self.components.contains_key(required) {
                return fail("missing component availability");
            }
        }
        for (name, component) in &self.components {
            if !["walking", "addresses", "walkGraph", "poi"].contains(&name.as_str()) {
                return fail("unknown component");
            }
            match component {
                Component::Present {
                    format,
                    format_version,
                    sha256,
                    bytes,
                    decoded_bytes,
                    compression,
                } => {
                    let expected = match name.as_str() {
                        "walking" => ("geojsonseq", 1, Compression::Gzip),
                        "addresses" => ("ptas", 1, Compression::None),
                        "walkGraph" => ("ptwg", 2, Compression::Brotli),
                        "poi" => ("poi-corpus", 1, Compression::Gzip),
                        _ => unreachable!(),
                    };
                    if format != expected.0
                        || *format_version != expected.1
                        || std::mem::discriminant(compression)
                            != std::mem::discriminant(&expected.2)
                        || !valid_digest(sha256)
                        || *bytes == 0
                        || *bytes > MAX_OBJECT_BYTES
                        || *decoded_bytes == 0
                        || *decoded_bytes > MAX_OBJECT_BYTES
                    {
                        return fail("invalid component bounds or format");
                    }
                    if matches!(compression, Compression::None) && bytes != decoded_bytes {
                        return fail("uncompressed size mismatch");
                    }
                }
                Component::Unsupported { reason } | Component::Failed { reason } => {
                    if reason.trim().is_empty() {
                        return fail("missing unavailability reason");
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> OsmManifest {
        OsmManifest {
            schema_version: 1,
            city: "vilnius".into(),
            coverage_e5: [1, 1, 2, 2],
            created_at: "2026-10-29T00:00:00Z".into(),
            source: Source {
                url: "https://example.org/source".into(),
                snapshot_at: "2026-10-28T00:00:00Z".into(),
                sha256: digest(b"source"),
            },
            builder_revision: "revision".into(),
            configuration_sha256: digest(b"config"),
            tools: BTreeMap::new(),
            attribution: "OpenStreetMap contributors".into(),
            license_url: "https://www.openstreetmap.org/copyright".into(),
            components: ["walking", "addresses", "walkGraph", "poi"]
                .into_iter()
                .map(|name| {
                    (
                        name.into(),
                        Component::Unsupported {
                            reason: "fixture".into(),
                        },
                    )
                })
                .collect(),
        }
    }
    #[test]
    fn roundtrip_and_explicit_unavailability() {
        let fixture = fixture();
        let bytes = serde_json::to_vec(&fixture).unwrap();
        let decoded: OsmManifest = serde_json::from_slice(&bytes).unwrap();
        decoded.validate("vilnius").unwrap();
        assert!(decoded.validate("oslo").is_err());
        let mut missing = decoded;
        missing.components.remove("poi");
        assert!(missing.validate("vilnius").is_err());
    }
    #[test]
    fn rejects_unsupported_and_oversized_objects() {
        let mut manifest = fixture();
        manifest.schema_version = 2;
        assert!(manifest.validate("vilnius").is_err());
        manifest.schema_version = 1;
        manifest.components.insert(
            "walking".into(),
            Component::Present {
                format: "geojson".into(),
                format_version: 1,
                compression: Compression::Gzip,
                sha256: digest(b"object"),
                bytes: 1,
                decoded_bytes: MAX_OBJECT_BYTES + 1,
            },
        );
        assert!(manifest.validate("vilnius").is_err());
    }
    #[test]
    fn rejects_path_injection_and_checks_exact_bytes() {
        assert!(object_path("../../etc/passwd").is_err());
        assert!(object_path(&digest(b"valid"))
            .unwrap()
            .starts_with("objects/sha256/"));
        assert_ne!(digest(b"{}"), digest(b"{ }"));
    }
}
