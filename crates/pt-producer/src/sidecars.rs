use crate::error::{Error, Result};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
pub struct FeedMeta {
    pub url: String,
    #[serde(rename = "blobSha256")]
    pub blob_sha256: String,
    pub etag: Option<String>,
}

#[derive(Serialize)]
struct MetaFile<'a> {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "producerGitSha")]
    producer_git_sha: &'a str,
    /// Day-0 of the service-bitmask window, as YYYY-MM-DD. Loaders must
    /// anchor their service-active interpretation here — using
    /// process-start-date instead silently shifts every weekday bit by
    /// (now - feedStartDate) days.
    #[serde(rename = "feedStartDate")]
    feed_start_date: &'a str,
    /// Canonical IANA tz name for service-day arithmetic. Optional in
    /// serialized output (None → field omitted).
    #[serde(rename = "cityTzIana", skip_serializing_if = "Option::is_none")]
    city_tz_iana: Option<&'a str>,
    /// Number of type-4 in-seat transfer rules derived from block_id
    /// continuations. `Some(0)` means derivation ran but found none; `None`
    /// means derivation was not applicable (e.g. the P4 gen-dir bridge path).
    /// Optional in serialized output (None → field omitted).
    #[serde(rename = "derivedInseatRules", skip_serializing_if = "Option::is_none")]
    derived_inseat_rules: Option<u32>,
    feeds: &'a [FeedMeta],
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ShapePoint {
    pub lat: f32,
    pub lon: f32,
    #[serde(
        rename = "shape_dist_traveled",
        skip_serializing_if = "Option::is_none"
    )]
    pub shape_dist_traveled: Option<f32>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ShapeGroup {
    #[serde(rename = "shapeId")]
    pub shape_id: String,
    pub points: Vec<ShapePoint>,
    /// Number of trips in trips.txt whose `shape_id` references this shape.
    /// The Node `buildShapesIndex` keys orphan-filtering, cap-eviction order,
    /// and output ordering off this count; carrying it lets `loadFromPtb`
    /// reproduce that exactly without re-counting trips. 0 ⇒ orphan shape
    /// (present in shapes.txt, referenced by no trip) — the loader drops it,
    /// matching the Node path.
    #[serde(rename = "tripRefCount")]
    pub trip_ref_count: u32,
}

#[derive(Serialize)]
struct ShapesFile<'a> {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    shapes: &'a [ShapeGroup],
}

fn json_err(e: serde_json::Error) -> Error {
    Error::Io(std::io::Error::other(e))
}

pub fn write_meta(
    path: &Path,
    feeds: &[FeedMeta],
    producer_git_sha: &str,
    feed_start_date: &str,
    city_tz_iana: Option<&str>,
    derived_inseat_rules: Option<u32>,
) -> Result<()> {
    let file = MetaFile {
        schema_version: 1,
        producer_git_sha,
        feed_start_date,
        city_tz_iana,
        derived_inseat_rules,
        feeds,
    };
    let s = serde_json::to_string(&file).map_err(json_err)?;
    std::fs::write(path, s)?;
    Ok(())
}

/// Format a YYYYMMDD u32 (the producer's internal date repr) as YYYY-MM-DD.
/// Returns `"1970-01-01"` for the sentinel value `0` (producer found no
/// dated services — defensive default keeps callers from crashing).
pub fn format_ymd(ymd: u32) -> String {
    if ymd == 0 {
        return "1970-01-01".to_string();
    }
    let y = ymd / 10000;
    let m = (ymd / 100) % 100;
    let d = ymd % 100;
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn write_shapes(path: &Path, shapes: &[ShapeGroup]) -> Result<()> {
    let file = ShapesFile {
        schema_version: 1,
        shapes,
    };
    let s = serde_json::to_string(&file).map_err(json_err)?;
    std::fs::write(path, s)?;
    Ok(())
}
