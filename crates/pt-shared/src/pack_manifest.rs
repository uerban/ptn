use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackManifestError(pub String);

impl fmt::Display for PackManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for PackManifestError {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub schema_version: u32,
    pub pack_id: String,
    pub bundle_id: String,
    pub generation_id: String,
    pub publication_inputs_sha256: String,
    pub city_slug: String,
    /// IANA timezone of the city (e.g. "Europe/Vilnius"). Interprets the
    /// local-date fields (staleAfter, hardExpireAfter, serviceEndDate).
    /// Optional: absent when the producer was not given a tz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city_tz_iana: Option<String>,
    pub created_at: String,
    pub feed_start_date: u32,
    pub window_days: u16,
    pub service_end_date: u32,
    pub stale_after: String,
    pub hard_expire_after: String,
    #[serde(rename = "stopBBox")]
    pub stop_bbox: BBox,
    #[serde(rename = "coverageBBox")]
    pub coverage_bbox: BBox,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub coverage_incomplete_reasons: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feeds: Vec<PackFeed>,
    pub rights: PackRights,
    pub artifacts: Vec<PackArtifact>,
}

/// `[minLonE5, minLatE5, maxLonE5, maxLatE5]` — degrees × 1e5, i32 (same
/// quantization as shapes.bin / SHPB). Integers keep the packId canonical
/// bytes independent of any float-formatting or float-parsing algorithm.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BBox(pub [i32; 4]);

/// One degree in E5 units.
pub const E5: i32 = 100_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRights {
    pub redistributable: bool,
    pub status: String,
    pub note: String,
}

/// Provenance of one source GTFS feed. Populated from `feed_info.txt`
/// (GTFS reference: https://gtfs.org/documentation/schedule/reference/#feed_infotxt
/// — optional file, at most one row) plus the download URL. ODbL/CC-BY
/// attribution needs provenance to build from, so redistributable packs
/// require at least one feeds[] entry (sourceUrl alone when the feed has
/// no feed_info.txt; stricter per-feed clearance checks are backlog).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFeed {
    pub source_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed_version: Option<String>,
    /// License identifier/URL. Not a GTFS field — supplied by operator
    /// config; None in v1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackArtifact {
    pub kind: String,
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub required: bool,
    pub media_type: String,
    pub cache: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbox: Option<BBox>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub namespaces: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derived_from: Vec<String>,
    /// Wire-format version of the artifact (e.g. PTB header version).
    /// Lets an offline client preflight reader compatibility without
    /// downloading and parsing the artifact header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_version: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalPackManifest {
    schema_version: u32,
    bundle_id: String,
    generation_id: String,
    publication_inputs_sha256: String,
    city_slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    city_tz_iana: Option<String>,
    created_at: String,
    feed_start_date: u32,
    window_days: u16,
    service_end_date: u32,
    stale_after: String,
    hard_expire_after: String,
    #[serde(rename = "stopBBox")]
    stop_bbox: BBox,
    #[serde(rename = "coverageBBox")]
    coverage_bbox: BBox,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    coverage_incomplete_reasons: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    feeds: Vec<PackFeed>,
    rights: PackRights,
    artifacts: Vec<PackArtifact>,
}

impl CanonicalPackManifest {
    fn from_manifest(manifest: &PackManifest) -> Result<Self, PackManifestError> {
        let mut artifacts = manifest.artifacts.clone();
        artifacts.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.path.cmp(&b.path)));

        Ok(Self {
            schema_version: manifest.schema_version,
            bundle_id: manifest.bundle_id.clone(),
            generation_id: manifest.generation_id.clone(),
            publication_inputs_sha256: manifest.publication_inputs_sha256.clone(),
            city_slug: manifest.city_slug.clone(),
            city_tz_iana: manifest.city_tz_iana.clone(),
            created_at: manifest.created_at.clone(),
            feed_start_date: manifest.feed_start_date,
            window_days: manifest.window_days,
            service_end_date: manifest.service_end_date,
            stale_after: manifest.stale_after.clone(),
            hard_expire_after: manifest.hard_expire_after.clone(),
            stop_bbox: manifest.stop_bbox,
            coverage_bbox: manifest.coverage_bbox,
            coverage_incomplete_reasons: manifest.coverage_incomplete_reasons.clone(),
            feeds: manifest.feeds.clone(),
            rights: manifest.rights.clone(),
            artifacts,
        })
    }
}

impl PackManifest {
    pub fn canonical_bytes_without_pack_id(&self) -> Result<Vec<u8>, PackManifestError> {
        self.validate_shape()?;
        let projection = CanonicalPackManifest::from_manifest(self)?;
        serde_json::to_vec(&projection)
            .map_err(|e| PackManifestError(format!("pack manifest canonical serialize: {e}")))
    }

    pub fn compute_pack_id(&self) -> Result<String, PackManifestError> {
        let bytes = self.canonical_bytes_without_pack_id()?;
        let digest = Sha256::digest(&bytes);
        Ok(lowercase_hex(digest))
    }

    pub fn validate_pack_id(&self) -> Result<(), PackManifestError> {
        let want = self.compute_pack_id()?;
        if self.pack_id != want {
            return Err(PackManifestError("packId mismatch".into()));
        }
        Ok(())
    }

    pub fn validate_shape(&self) -> Result<(), PackManifestError> {
        if self.schema_version != 2 {
            return Err(PackManifestError("schemaVersion must be 2".to_string()));
        }
        if !crate::osm_manifest::valid_digest(&self.publication_inputs_sha256)
            || self.generation_id
                != crate::manifest::publication_id(&self.bundle_id, &self.publication_inputs_sha256)
        {
            return Err(PackManifestError(
                "generationId must bind bundleId and publicationInputsSha256".to_string(),
            ));
        }
        if let Some(tz) = &self.city_tz_iana {
            if tz.is_empty()
                || !tz
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'+' | b'-'))
            {
                return Err(PackManifestError(
                    "cityTzIana must be a plausible IANA zone name".to_string(),
                ));
            }
        }
        validate_created_at(&self.created_at)?;
        let feed_start_date = validate_numeric_yyyymmdd("feedStartDate", self.feed_start_date)?;
        let service_end_date = validate_numeric_yyyymmdd("serviceEndDate", self.service_end_date)?;
        let stale_after = validate_iso_date("staleAfter", &self.stale_after)?;
        let hard_expire_after = validate_iso_date("hardExpireAfter", &self.hard_expire_after)?;
        if feed_start_date > service_end_date {
            return Err(PackManifestError(
                "feedStartDate must be before or equal to serviceEndDate".to_string(),
            ));
        }
        if stale_after > hard_expire_after {
            return Err(PackManifestError(
                "staleAfter must be before or equal to hardExpireAfter".to_string(),
            ));
        }
        if hard_expire_after < service_end_date {
            return Err(PackManifestError(
                "hardExpireAfter must be on or after serviceEndDate".to_string(),
            ));
        }
        validate_bbox("stopBBox", &self.stop_bbox)?;
        validate_bbox("coverageBBox", &self.coverage_bbox)?;

        if self.rights.redistributable && self.feeds.is_empty() {
            return Err(PackManifestError(
                "redistributable packs must declare feeds[] provenance".to_string(),
            ));
        }
        for feed in &self.feeds {
            if feed.source_url.is_empty() {
                return Err(PackManifestError(
                    "feeds[].sourceUrl must be non-empty".to_string(),
                ));
            }
        }

        let mut paths = BTreeSet::new();
        let mut kind_paths = BTreeSet::new();
        let mut ptb_count = 0;
        let mut required_ptb_count = 0;

        for artifact in &self.artifacts {
            validate_artifact_path(&artifact.path)?;
            if !kind_paths.insert((artifact.kind.as_str(), artifact.path.as_str())) {
                return Err(PackManifestError(format!(
                    "duplicate artifact kind/path: {}/{}",
                    artifact.kind, artifact.path
                )));
            }
            if !paths.insert(artifact.path.as_str()) {
                return Err(PackManifestError(format!(
                    "duplicate artifact path: {}",
                    artifact.path
                )));
            }
            validate_sha256("artifact sha256", &artifact.sha256)?;
            if let Some(bbox) = &artifact.bbox {
                validate_bbox("artifact bbox", bbox)?;
            }
            if artifact.cache != "immutable" {
                return Err(PackManifestError(format!(
                    "artifact cache must be immutable: {}",
                    artifact.path
                )));
            }
            if artifact.kind == "ptb" {
                ptb_count += 1;
                if artifact.required {
                    required_ptb_count += 1;
                }
            }
        }

        if ptb_count != 1 {
            return Err(PackManifestError(format!(
                "expected exactly one ptb artifact, found {}",
                ptb_count
            )));
        }
        if required_ptb_count != 1 {
            return Err(PackManifestError(
                "the ptb artifact must be required".to_string(),
            ));
        }

        Ok(())
    }
}

pub fn validate_bbox(name: &str, bbox: &BBox) -> Result<(), PackManifestError> {
    let [min_lon, min_lat, max_lon, max_lat] = bbox.0;
    if !(-180 * E5..=180 * E5).contains(&min_lon) || !(-180 * E5..=180 * E5).contains(&max_lon) {
        return Err(PackManifestError(format!(
            "{} longitude out of range",
            name
        )));
    }
    if !(-90 * E5..=90 * E5).contains(&min_lat) || !(-90 * E5..=90 * E5).contains(&max_lat) {
        return Err(PackManifestError(format!("{} latitude out of range", name)));
    }
    if min_lon > max_lon || min_lat > max_lat {
        return Err(PackManifestError(format!("{} min exceeds max", name)));
    }
    Ok(())
}

pub fn validate_artifact_path(path: &str) -> Result<(), PackManifestError> {
    if path.is_empty() {
        return Err(PackManifestError("unsafe artifact path: empty".to_string()));
    }
    if path.starts_with('/') {
        return Err(PackManifestError(format!("unsafe artifact path: {}", path)));
    }
    if path.contains('\\')
        || path.contains('%')
        || path.contains(':')
        || !path.is_ascii()
        || path.chars().any(char::is_control)
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'-' | b'_'))
    {
        return Err(PackManifestError(format!(
            "unsafe artifact path: {}",
            path.escape_debug()
        )));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(PackManifestError(format!(
                "unsafe artifact path segment: {}",
                path
            )));
        }
        if segment.ends_with(' ') || segment.ends_with('.') || is_windows_device_name(segment) {
            return Err(PackManifestError(format!(
                "unsafe artifact path segment: {}",
                path
            )));
        }
    }
    Ok(())
}

fn is_windows_device_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or(segment);
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0')
}

fn validate_sha256(name: &str, value: &str) -> Result<(), PackManifestError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(PackManifestError(format!(
            "{} must be 64 lowercase ASCII hex characters",
            name
        )));
    }
    Ok(())
}

fn lowercase_hex(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(NIBBLE[(b >> 4) as usize] as char);
        out.push(NIBBLE[(b & 0x0f) as usize] as char);
    }
    out
}

const NIBBLE: &[u8; 16] = b"0123456789abcdef";

fn validate_created_at(value: &str) -> Result<(), PackManifestError> {
    if value.len() != 20
        || value.as_bytes()[4] != b'-'
        || value.as_bytes()[7] != b'-'
        || value.as_bytes()[10] != b'T'
        || value.as_bytes()[13] != b':'
        || value.as_bytes()[16] != b':'
        || value.as_bytes()[19] != b'Z'
    {
        return Err(PackManifestError(
            "createdAt must use YYYY-MM-DDTHH:MM:SSZ timestamp grammar".to_string(),
        ));
    }
    let date = parse_iso_date_parts("createdAt", &value[..10])?;
    let hour = parse_two_digits("createdAt hour", &value[11..13])?;
    let minute = parse_two_digits("createdAt minute", &value[14..16])?;
    let second = parse_two_digits("createdAt second", &value[17..19])?;
    if hour > 23 || minute > 59 || second > 59 {
        return Err(PackManifestError(
            "createdAt time is out of range".to_string(),
        ));
    }
    validate_calendar_date("createdAt", date)?;
    Ok(())
}

fn validate_numeric_yyyymmdd(name: &str, value: u32) -> Result<Date, PackManifestError> {
    let year = value / 10_000;
    let month = (value / 100) % 100;
    let day = value % 100;
    if !(1000..=9999).contains(&year) {
        return Err(PackManifestError(format!(
            "{} must use YYYYMMDD integer date grammar",
            name
        )));
    }
    validate_calendar_date(name, Date { year, month, day })
}

fn validate_iso_date(name: &str, value: &str) -> Result<Date, PackManifestError> {
    if value.len() != 10 || value.as_bytes()[4] != b'-' || value.as_bytes()[7] != b'-' {
        return Err(PackManifestError(format!(
            "{} must use YYYY-MM-DD date grammar",
            name
        )));
    }
    validate_calendar_date(name, parse_iso_date_parts(name, value)?)
}

fn parse_iso_date_parts(name: &str, value: &str) -> Result<Date, PackManifestError> {
    let year = parse_four_digits(name, &value[0..4])?;
    let month = parse_two_digits(name, &value[5..7])?;
    let day = parse_two_digits(name, &value[8..10])?;
    Ok(Date { year, month, day })
}

fn parse_four_digits(name: &str, value: &str) -> Result<u32, PackManifestError> {
    if value.len() != 4 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PackManifestError(format!(
            "{} has invalid date digits",
            name
        )));
    }
    value
        .parse()
        .map_err(|_| PackManifestError(format!("{} has invalid date digits", name)))
}

fn parse_two_digits(name: &str, value: &str) -> Result<u32, PackManifestError> {
    if value.len() != 2 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PackManifestError(format!(
            "{} has invalid date digits",
            name
        )));
    }
    value
        .parse()
        .map_err(|_| PackManifestError(format!("{} has invalid date digits", name)))
}

fn validate_calendar_date(name: &str, date: Date) -> Result<Date, PackManifestError> {
    if !(1..=12).contains(&date.month)
        || date.day == 0
        || date.day > days_in_month(date.year, date.month)
    {
        return Err(PackManifestError(format!(
            "{} has invalid calendar date",
            name
        )));
    }
    Ok(date)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Date {
    year: u32,
    month: u32,
    day: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_hash() -> String {
        "a".repeat(64)
    }

    fn sample_id() -> String {
        "pack:vilnius:20260627".to_string()
    }

    fn sample_artifact() -> PackArtifact {
        PackArtifact {
            kind: "ptb".to_string(),
            path: "bundle.ptb".to_string(),
            sha256: sample_hash(),
            size_bytes: 123,
            required: true,
            media_type: "application/octet-stream".to_string(),
            cache: "immutable".to_string(),
            bbox: None,
            namespaces: BTreeMap::new(),
            encoding: None,
            derived_from: Vec::new(),
            format_version: None,
        }
    }

    fn sample_pack_manifest() -> PackManifest {
        PackManifest {
            schema_version: 2,
            pack_id: sample_id(),
            bundle_id: sample_id(),
            generation_id: crate::manifest::publication_id(&sample_id(), &"0".repeat(64)),
            publication_inputs_sha256: "0".repeat(64),
            city_slug: "vilnius".to_string(),
            city_tz_iana: None,
            created_at: "2026-06-27T00:00:00Z".to_string(),
            feed_start_date: 20260627,
            window_days: 90,
            service_end_date: 20260925,
            stale_after: "2026-09-15".to_string(),
            hard_expire_after: "2026-09-25".to_string(),
            stop_bbox: BBox([2_500_000, 5_400_000, 2_600_000, 5_500_000]),
            coverage_bbox: BBox([2_500_000, 5_400_000, 2_600_000, 5_500_000]),
            coverage_incomplete_reasons: Vec::new(),
            rights: PackRights {
                redistributable: true,
                status: "ok".to_string(),
                note: "sample".to_string(),
            },
            feeds: vec![PackFeed {
                source_url: "https://example.com/gtfs.zip".to_string(),
                publisher_name: None,
                lang: None,
                feed_version: None,
                license: None,
            }],
            artifacts: vec![sample_artifact()],
        }
    }

    #[test]
    fn feeds_serialize_and_gate_redistributable() {
        let mut m = sample_pack_manifest();
        m.feeds.clear();
        // sample manifest is redistributable:true — with no feeds it must fail
        assert!(m.validate_shape().is_err());

        m.feeds = vec![PackFeed {
            source_url: "https://example.com/gtfs.zip".to_string(),
            publisher_name: Some("Example Transit".to_string()),
            lang: Some("lt".to_string()),
            feed_version: Some("2026-06".to_string()),
            license: None,
        }];
        assert!(m.validate_shape().is_ok());
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(
            json["feeds"][0]["sourceUrl"],
            "https://example.com/gtfs.zip"
        );
        assert_eq!(json["feeds"][0]["publisherName"], "Example Transit");
        assert!(json["feeds"][0].get("license").is_none());

        // non-redistributable pack may omit feeds
        m.feeds.clear();
        m.rights.redistributable = false;
        assert!(m.validate_shape().is_ok());
    }

    #[test]
    fn pack_id_ignores_existing_pack_id_and_sorts_artifacts() {
        let mut a = sample_pack_manifest();
        let mut shape = sample_artifact();
        shape.kind = "shapes-bin".into();
        shape.path = "shapes.bin".into();
        shape.required = false;
        shape.media_type = "application/vnd.ptn.shpb".into();
        a.artifacts.push(shape.clone());
        a.pack_id = "old".into();

        let mut b = a.clone();
        b.pack_id = "different".into();
        b.artifacts.reverse();

        assert_eq!(a.compute_pack_id().unwrap(), b.compute_pack_id().unwrap());
    }

    #[test]
    fn artifact_format_version_serializes_when_present() {
        let mut m = sample_pack_manifest();
        m.artifacts[0].format_version = Some(9);
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["artifacts"][0]["formatVersion"], 9);
        // absent → omitted
        m.artifacts[0].format_version = None;
        let json = serde_json::to_value(&m).unwrap();
        assert!(json["artifacts"][0].get("formatVersion").is_none());
    }

    #[test]
    fn canonical_pack_manifest_sorts_same_kind_artifacts_by_path() {
        let mut m = sample_pack_manifest();
        let mut z = sample_artifact();
        z.kind = "metadata".into();
        z.path = "z.json".into();
        z.sha256 = "b".repeat(64);
        z.required = false;
        z.media_type = "application/json".into();

        let mut a = z.clone();
        a.path = "a.json".into();
        a.sha256 = "c".repeat(64);

        m.artifacts.push(z);
        m.artifacts.push(a);

        let json = String::from_utf8(m.canonical_bytes_without_pack_id().unwrap()).unwrap();
        let ptb = json.find(r#""kind":"ptb","path":"bundle.ptb""#).unwrap();
        let a = json.find(r#""kind":"metadata","path":"a.json""#).unwrap();
        let z = json.find(r#""kind":"metadata","path":"z.json""#).unwrap();

        assert!(a < z);
        assert!(z < ptb);
    }

    #[test]
    fn canonical_pack_manifest_rejects_invalid_artifact_shape() {
        let mut m = sample_pack_manifest();
        let mut duplicate_path = sample_artifact();
        duplicate_path.kind = "shapes-bin".into();
        duplicate_path.sha256 = "b".repeat(64);
        duplicate_path.required = false;
        duplicate_path.media_type = "application/vnd.ptn.shpb".into();
        m.artifacts.push(duplicate_path);

        let err = m.compute_pack_id().unwrap_err().to_string();
        assert!(err.contains("duplicate artifact path"));

        let mut m = sample_pack_manifest();
        m.artifacts.push(m.artifacts[0].clone());
        let err = m.canonical_bytes_without_pack_id().unwrap_err().to_string();
        assert!(err.contains("duplicate artifact kind/path"));
    }

    #[test]
    fn canonical_pack_manifest_bytes_omit_pack_id_and_keep_stable_ordering() {
        let mut m = sample_pack_manifest();
        let mut shape = sample_artifact();
        shape.kind = "shapes-bin".into();
        shape.path = "shapes.bin".into();
        shape.sha256 = "b".repeat(64);
        shape.size_bytes = 456;
        shape.required = false;
        shape.media_type = "application/vnd.ptn.shpb".into();
        shape.bbox = Some(BBox([2_510_000, 5_410_000, 2_590_000, 5_490_000]));
        shape.namespaces.insert("stops".into(), "stop-sha".into());
        shape.namespaces.insert("trips".into(), "trip-sha".into());
        shape.encoding = Some("identity".into());
        shape.derived_from = vec!["bundle.ptb".into()];

        m.pack_id = "must-not-appear".into();
        m.coverage_incomplete_reasons = vec!["missing-shapes".into()];
        m.artifacts.push(shape);
        m.artifacts.reverse();

        let bytes = m.canonical_bytes_without_pack_id().unwrap();
        let json = String::from_utf8(bytes).unwrap();

        assert!(!json.contains("packId"));
        assert_eq!(
            json,
            concat!(
                r#"{"schemaVersion":2,"bundleId":"pack:vilnius:20260627","generationId":"cc38c0913f7ce2ae5b0cee47a935d0bfb04c1d5b6339c215f347d2c3dfbc32e4","publicationInputsSha256":"0000000000000000000000000000000000000000000000000000000000000000","#,
                r#""citySlug":"vilnius","createdAt":"2026-06-27T00:00:00Z","feedStartDate":20260627,"#,
                r#""windowDays":90,"serviceEndDate":20260925,"staleAfter":"2026-09-15","hardExpireAfter":"2026-09-25","#,
                r#""stopBBox":[2500000,5400000,2600000,5500000],"coverageBBox":[2500000,5400000,2600000,5500000],"#,
                r#""coverageIncompleteReasons":["missing-shapes"],"feeds":[{"sourceUrl":"https://example.com/gtfs.zip"}],"#,
                r#""rights":{"redistributable":true,"status":"ok","note":"sample"},"#,
                r#""artifacts":[{"kind":"ptb","path":"bundle.ptb","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","#,
                r#""sizeBytes":123,"required":true,"mediaType":"application/octet-stream","cache":"immutable"},"#,
                r#"{"kind":"shapes-bin","path":"shapes.bin","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","#,
                r#""sizeBytes":456,"required":false,"mediaType":"application/vnd.ptn.shpb","cache":"immutable","#,
                r#""bbox":[2510000,5410000,2590000,5490000],"namespaces":{"stops":"stop-sha","trips":"trip-sha"},"#,
                r#""encoding":"identity","derivedFrom":["bundle.ptb"]}]}"#
            )
        );
        assert_eq!(
            m.compute_pack_id().unwrap(),
            "63c3795dd3eb5b4e51d23f8511a7b10fc94797ec4f78a159f11f70a98da1c5ef"
        );
    }

    #[test]
    fn validate_pack_id_rejects_mismatch() {
        let mut m = sample_pack_manifest();
        m.pack_id = m.compute_pack_id().unwrap();
        assert!(m.validate_pack_id().is_ok());

        m.pack_id = "wrong".into();
        let err = m.validate_pack_id().unwrap_err().to_string();
        assert_eq!(err, "packId mismatch");
    }

    #[test]
    fn pack_manifest_serializes_camel_case_json_shape() {
        let json = serde_json::to_value(sample_pack_manifest()).unwrap();
        assert_eq!(json["schemaVersion"], 2);
        assert_eq!(json["packId"], sample_id());
        assert_eq!(json["bundleId"], sample_id());
        assert_eq!(
            json["generationId"],
            crate::manifest::publication_id(&sample_id(), &"0".repeat(64))
        );
        assert_eq!(json["citySlug"], "vilnius");
        assert_eq!(json["feedStartDate"], 20260627);
        assert_eq!(json["windowDays"], 90);
        assert_eq!(json["serviceEndDate"], 20260925);
        assert_eq!(
            json["stopBBox"],
            serde_json::json!([2_500_000, 5_400_000, 2_600_000, 5_500_000])
        );
        assert_eq!(
            json["coverageBBox"],
            serde_json::json!([2_500_000, 5_400_000, 2_600_000, 5_500_000])
        );
        assert!(json.get("coverageIncompleteReasons").is_none());
        assert_eq!(json["rights"]["redistributable"], true);
        assert_eq!(json["artifacts"][0]["sizeBytes"], 123);
        assert!(json["artifacts"][0].get("namespaces").is_none());
        assert!(json["artifacts"][0].get("derivedFrom").is_none());
    }

    #[test]
    fn pack_manifest_requires_one_required_ptb_artifact() {
        let mut m = sample_pack_manifest();
        assert!(m.validate_shape().is_ok());

        m.artifacts.clear();
        let err = m.validate_shape().unwrap_err().to_string();
        assert!(err.contains("exactly one ptb artifact"));

        let mut m = sample_pack_manifest();
        m.artifacts[0].required = false;
        let err = m.validate_shape().unwrap_err().to_string();
        assert!(err.contains("ptb artifact must be required"));
    }

    #[test]
    fn pack_manifest_rejects_duplicate_kind_path() {
        let mut m = sample_pack_manifest();
        m.artifacts.push(m.artifacts[0].clone());
        let err = m.validate_shape().unwrap_err().to_string();
        assert!(err.contains("duplicate artifact"));
    }

    #[test]
    fn pack_manifest_rejects_duplicate_paths() {
        let mut m = sample_pack_manifest();
        let mut artifact = m.artifacts[0].clone();
        artifact.kind = "shapes".to_string();
        artifact.sha256 = "b".repeat(64);
        m.artifacts.push(artifact);

        let err = m.validate_shape().unwrap_err().to_string();
        assert!(err.contains("duplicate artifact path"));
    }

    #[test]
    fn pack_manifest_rejects_unsafe_artifact_paths() {
        for path in [
            "",
            "/bundle.ptb",
            "C:foo",
            ".",
            "..",
            "aux",
            "COM1.bin",
            "Lpt9",
            "bundle.ptb.",
            "bundle.ptb ",
            "dir/./bundle.ptb",
            "dir/../bundle.ptb",
            "dir//bundle.ptb",
            "dir/name. ",
            "dir\\bundle.ptb",
            "dir/\u{0007}bundle.ptb",
            "shapes-ñ.bin",
            "%2e%2e/bundle.ptb",
        ] {
            let mut m = sample_pack_manifest();
            m.artifacts[0].path = path.to_string();
            let err = m.validate_shape().unwrap_err().to_string();
            assert!(err.contains("unsafe artifact path"), "path {path:?}: {err}");
        }
    }

    #[test]
    fn pack_manifest_accepts_current_artifact_paths() {
        for path in [
            "bundle.ptb",
            "departures-idx.bin",
            "shapes.bin",
            "color-config.json",
            "route-styles.json",
            "label-anchors.json",
            "schedule-tiles/manifest.json",
        ] {
            let mut m = sample_pack_manifest();
            m.artifacts[0].path = path.to_string();
            assert!(m.validate_shape().is_ok(), "path {path:?}");
        }
    }

    #[test]
    fn pack_manifest_rejects_invalid_bboxes() {
        for bbox in [
            BBox([-18_000_001, 5_400_000, 2_600_000, 5_500_000]), // lon < -180°
            BBox([2_500_000, -9_000_001, 2_600_000, 5_500_000]),  // lat < -90°
            BBox([2_500_000, 5_400_000, 18_000_001, 5_500_000]),  // lon > 180°
            BBox([2_500_000, 5_400_000, 2_600_000, 9_000_001]),   // lat > 90°
            BBox([2_700_000, 5_400_000, 2_600_000, 5_500_000]),   // min_lon > max_lon
            BBox([2_500_000, 5_600_000, 2_600_000, 5_500_000]),   // min_lat > max_lat
        ] {
            let mut m = sample_pack_manifest();
            m.stop_bbox = bbox;
            assert!(m.validate_shape().is_err(), "bbox {bbox:?}");
        }
        let mut m = sample_pack_manifest();
        m.artifacts[0].bbox = Some(BBox([2_500_000, 5_400_000, -18_000_001, 5_500_000]));
        assert!(m.validate_shape().is_err());
    }

    #[test]
    fn pack_manifest_validates_basic_hex_and_date_grammar() {
        let mut m = sample_pack_manifest();
        m.schema_version = 3;
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("schemaVersion"));

        let mut m = sample_pack_manifest();
        m.generation_id = "different-generation-id".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("generationId"));

        let mut m = sample_pack_manifest();
        m.artifacts[0].sha256 = "abc".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("64 lowercase ASCII hex"));

        let mut m = sample_pack_manifest();
        m.artifacts[0].sha256 = "A".repeat(64);
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("lowercase"));

        let mut m = sample_pack_manifest();
        m.created_at = "20260627".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("timestamp grammar"));

        let mut m = sample_pack_manifest();
        m.created_at = "2026-99-99T99:99:99Z".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("time is out of range"));

        let mut m = sample_pack_manifest();
        m.created_at = "2026-02-29T00:00:00Z".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("invalid calendar date"));

        let mut m = sample_pack_manifest();
        m.created_at = "2024-02-29T23:59:59Z".to_string();
        assert!(m.validate_shape().is_ok());

        let mut m = sample_pack_manifest();
        m.feed_start_date = 20261301;
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("invalid calendar date"));

        let mut m = sample_pack_manifest();
        m.service_end_date = 20260229;
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("invalid calendar date"));

        let mut m = sample_pack_manifest();
        m.stale_after = "2026-09-15".to_string();
        assert!(m.validate_shape().is_ok());

        let mut m = sample_pack_manifest();
        m.stale_after = "20260915".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("YYYY-MM-DD"));

        let mut m = sample_pack_manifest();
        m.hard_expire_after = "20261301".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("YYYY-MM-DD"));

        let mut m = sample_pack_manifest();
        m.hard_expire_after = "2026-02-29".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("invalid calendar date"));
    }

    #[test]
    fn pack_manifest_validates_date_ordering() {
        let mut m = sample_pack_manifest();
        m.feed_start_date = 20260926;
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("feedStartDate"));

        let mut m = sample_pack_manifest();
        m.stale_after = "2026-09-26".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("staleAfter"));

        let mut m = sample_pack_manifest();
        m.hard_expire_after = "2026-09-24".to_string();
        assert!(m
            .validate_shape()
            .unwrap_err()
            .to_string()
            .contains("hardExpireAfter must be on or after serviceEndDate"));
    }

    #[test]
    fn hard_expire_after_may_exceed_service_end_date() {
        let mut m = sample_pack_manifest();
        m.hard_expire_after = "2026-10-05".to_string(); // 10 days past serviceEndDate
        assert!(m.validate_shape().is_ok());

        m.hard_expire_after = "2026-09-24".to_string(); // before serviceEndDate
        let err = m.validate_shape().unwrap_err().to_string();
        assert!(err.contains("hardExpireAfter must be on or after serviceEndDate"));
    }

    #[test]
    fn city_tz_iana_serializes_and_validates() {
        let mut m = sample_pack_manifest();
        m.city_tz_iana = Some("Europe/Vilnius".to_string());
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["cityTzIana"], "Europe/Vilnius");

        m.city_tz_iana = Some("has space".to_string());
        assert!(m.validate_shape().is_err());
        m.city_tz_iana = Some(String::new());
        assert!(m.validate_shape().is_err());
        m.city_tz_iana = None;
        assert!(m.validate_shape().is_ok());
    }

    #[test]
    fn pack_manifest_requires_immutable_artifact_cache() {
        let mut m = sample_pack_manifest();
        m.artifacts[0].cache = "no-store".to_string();

        let err = m.validate_shape().unwrap_err().to_string();
        assert!(err.contains("cache must be immutable"));
    }
}
