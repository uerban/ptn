//! POI manifest and bundle loading shared by startup preflight and requests.

use super::{PoiTileBounds, PoiTileIndex};
use crate::ops::ServerConfig;
use pt_shared::artifact_lease::{ConsumerLease, ResolutionGuard};
use pt_shared::osm_manifest::valid_digest;
use pt_shared::poi_bundle_wire::{PoiBundle, PoiEntry, Tier};
use pt_shared::poi_manifest_wire::{
    DeferredJson, PoiManifest, PoiManifestBundle, PoiTileBounds as PoiTileBoundsWire,
    PoiTileManifest, PoiTilingPolicy, POI_MANIFEST_SCHEMA_VERSION,
};
use pt_shared::poi_tile_grid::{tile_coord_at, TileAnchor};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use thiserror::Error;

/// Static RSS reservation and startup validation both cap all strict
/// corpora at five. Identities and tiling values come from manifest.json.
pub use pt_shared::poi_manifest_wire::MAX_POI_CITY_SLOTS;
const MIN_POI_TILE_EDGE_KM: f64 = 3.0;
const MAX_POI_TILE_EDGE_KM: f64 = 200.0;
const MAX_TILE_COORD_ABS: i64 = 999_999;

fn tile_min_k() -> usize {
    env!("NODE_TILE_MIN_K")
        .parse()
        .expect("build.rs emits numeric NODE_TILE_MIN_K")
}

#[derive(Debug, Error)]
pub enum PoiBundleLoadError {
    #[error("bundle read failed: {0}")]
    Read(#[source] io::Error),
    #[error("{stage} artifact exceeds {max_bytes} byte cap")]
    TooLarge { stage: &'static str, max_bytes: u64 },
    #[error("brotli decompression failed: {0}")]
    Decompress(#[source] io::Error),
    #[error("brotli compression failed: {0}")]
    Compress(#[source] io::Error),
    #[error("JSON decode failed: {0}")]
    Json(#[source] serde_json::Error),
    #[error("invalid POI serving configuration: {0}")]
    Config(String),
}

impl PoiBundleLoadError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Read(_) => "read",
            Self::TooLarge { stage, .. } => stage,
            Self::Decompress(_) => "brotli",
            Self::Compress(_) => "brotli",
            Self::Json(_) => "json",
            Self::Config(_) => "config",
        }
    }
}

#[derive(Debug, Clone)]
pub enum PoiPreflightState {
    Cold,
    Ready(PoiPreflightReady),
    Failed(Arc<str>),
}

#[derive(Debug, Clone)]
pub struct PoiPreflightReady {
    pub pinned_dir: PathBuf,
    /// Held while any request or the manifest cache keeps this snapshot, so
    /// artifact retention cannot prune the release underneath it.
    pub lease: Option<Arc<ConsumerLease>>,
    pub manifest: Arc<PoiManifest>,
    pub cities: Vec<PoiPreflightCity>,
    /// Set when the worst-case charge for the full coordinate envelope exceeds
    /// `poi_tile_cache_max_bytes`. Advisory, not fatal: the estimate charges
    /// Brotli's incompressible worst case for content the cache stores
    /// compressed, so it runs several times high on real corpora. Startup logs
    /// it so a genuine thrash risk is still visible.
    pub envelope_exceeds_cache_budget: Option<PoiEnvelopePressure>,
}

/// Worst-case envelope charge against the configured byte budget, carried out
/// of preflight so the caller can log it with the rest of the startup events.
#[derive(Debug, Clone, Copy)]
pub struct PoiEnvelopePressure {
    pub required_bytes: u64,
    pub budget_bytes: u64,
}

#[derive(Debug, Clone)]
pub enum PoiPreflightCity {
    Inactive {
        city_id: String,
    },
    Active {
        city_id: String,
        contract: ActivePoiTiling,
        bundle_sha256: Arc<str>,
    },
}

#[derive(Debug, Clone)]
pub enum PoiManifestStatus {
    Cold,
    Ready,
    Failed(Arc<str>),
}

enum PoiManifestCacheState {
    Cold,
    Ready(Arc<PoiPreflightReady>),
    Failed(Arc<str>),
}

pub struct PoiManifestCache {
    inner: Mutex<PoiManifestCacheState>,
    rejected_path: Mutex<Option<PathBuf>>,
}

impl PoiManifestCache {
    pub fn new(preflight: Option<&PoiPreflightState>) -> Self {
        let state = match preflight {
            Some(PoiPreflightState::Ready(ready)) => {
                PoiManifestCacheState::Ready(Arc::new(ready.clone()))
            }
            Some(PoiPreflightState::Failed(error)) => {
                PoiManifestCacheState::Failed(Arc::clone(error))
            }
            Some(PoiPreflightState::Cold) | None => PoiManifestCacheState::Cold,
        };
        Self {
            inner: Mutex::new(state),
            rejected_path: Mutex::new(None),
        }
    }

    pub fn get_or_load(
        &self,
        config: &ServerConfig,
    ) -> Result<Option<Arc<PoiPreflightReady>>, PoiBundleLoadError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let candidate = config
            .poi_bundle_dir
            .as_deref()
            .and_then(|path| std::fs::canonicalize(path).ok());
        let mut rejected = self.rejected_path.lock().unwrap_or_else(|p| p.into_inner());
        match &*inner {
            PoiManifestCacheState::Ready(ready)
                if candidate.as_ref() == Some(&ready.pinned_dir) =>
            {
                return Ok(Some(Arc::clone(ready)));
            }
            // A snapshot retained while the pointer is absent or names a
            // rejected release. Without a lease root the manager may prune it
            // after its grace period; stop serving it then.
            PoiManifestCacheState::Ready(ready)
                if candidate.is_none() || *rejected == candidate =>
            {
                if ready.pinned_dir.is_dir() {
                    return Ok(Some(Arc::clone(ready)));
                }
                let detail = retired_snapshot(&ready.pinned_dir);
                eprintln!("pt-serve: {detail}");
                *inner = PoiManifestCacheState::Failed(Arc::clone(&detail));
                return Err(PoiBundleLoadError::Config(detail.to_string()));
            }
            PoiManifestCacheState::Failed(error)
                if candidate.is_none() || *rejected == candidate =>
            {
                return Err(PoiBundleLoadError::Config(error.to_string()));
            }
            _ => {}
        }

        // A missing manifest is a retryable cold-start state. Once an artifact
        // appears, run the complete preflight before exposing it to requests.
        // Managed release paths are immutable. Rejected targets are retried only
        // when the pointer changes; a working prior corpus remains available.
        let ready = match validate_poi_configuration(config) {
            Ok(Some(ready)) => ready,
            Ok(None) => return Ok(None),
            Err(error) => {
                let detail: Arc<str> = Arc::from(error.to_string());
                *rejected = candidate;
                if let PoiManifestCacheState::Ready(previous) = &*inner {
                    if previous.pinned_dir.is_dir() {
                        eprintln!(
                            "pt-serve: rejected POI update; retaining {}: {detail}",
                            previous.pinned_dir.display()
                        );
                        return Ok(Some(Arc::clone(previous)));
                    }
                    eprintln!("pt-serve: {}", retired_snapshot(&previous.pinned_dir));
                }
                *inner = PoiManifestCacheState::Failed(Arc::clone(&detail));
                return Err(PoiBundleLoadError::Config(detail.to_string()));
            }
        };
        let ready = Arc::new(ready);
        *rejected = None;
        *inner = PoiManifestCacheState::Ready(Arc::clone(&ready));
        Ok(Some(ready))
    }

    pub fn status(&self) -> PoiManifestStatus {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*inner {
            PoiManifestCacheState::Cold => PoiManifestStatus::Cold,
            PoiManifestCacheState::Ready(_) => PoiManifestStatus::Ready,
            PoiManifestCacheState::Failed(error) => PoiManifestStatus::Failed(Arc::clone(error)),
        }
    }
}

fn retired_snapshot(dir: &Path) -> Arc<str> {
    Arc::from(format!(
        "retained POI release {} was removed and the current release was rejected",
        dir.display()
    ))
}

/// Validate the shared Node/Rust route and manifest city-id grammar.
pub(crate) fn city_id_valid(city_id: &str) -> bool {
    let bytes = city_id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
}

pub fn read_manifest(config: &ServerConfig) -> Result<Option<PoiManifest>, PoiBundleLoadError> {
    let Some(dir) = config.poi_bundle_dir.as_deref() else {
        return Ok(None);
    };
    let path = dir.join("manifest.json");
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(PoiBundleLoadError::Read(error)),
    };
    let max_bytes = config.poi_bundle_max_decoded_bytes;
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(PoiBundleLoadError::Read)?;
    if bytes.len() as u64 > max_bytes {
        return Err(PoiBundleLoadError::TooLarge {
            stage: "manifest",
            max_bytes,
        });
    }
    let manifest: PoiManifest = serde_json::from_slice(&bytes).map_err(PoiBundleLoadError::Json)?;
    if manifest.schema_version != POI_MANIFEST_SCHEMA_VERSION {
        return Err(PoiBundleLoadError::Config(format!(
            "unsupported manifest schemaVersion {}; expected {POI_MANIFEST_SCHEMA_VERSION}",
            manifest.schema_version
        )));
    }
    Ok(Some(manifest))
}

fn validate_strict_record(
    config: &ServerConfig,
    record: &PoiManifestBundle,
) -> Result<(), PoiBundleLoadError> {
    if !city_id_valid(&record.city_id) {
        return Err(PoiBundleLoadError::Config(format!(
            "manifest contains invalid cityId {}",
            record.city_id
        )));
    }
    let expected_filename = format!("{}.br", record.city_id);
    if record.filename != expected_filename {
        return Err(PoiBundleLoadError::Config(format!(
            "strict record for {} must use filename {expected_filename}",
            record.city_id
        )));
    }
    let max_bytes = config.poi_bundle_max_decoded_bytes;
    if record.size_bytes == 0 || record.size_bytes > max_bytes {
        return Err(PoiBundleLoadError::Config(format!(
            "strict record for {} has invalid sizeBytes {}; expected 1..={max_bytes}",
            record.city_id, record.size_bytes
        )));
    }
    if record.sha256.len() != 64
        || !record
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PoiBundleLoadError::Config(format!(
            "strict record for {} has invalid sha256",
            record.city_id
        )));
    }
    Ok(())
}

pub fn read_city_entries(
    config: &ServerConfig,
    record: &PoiManifestBundle,
) -> Result<Vec<PoiEntry>, PoiBundleLoadError> {
    let dir = config
        .poi_bundle_dir
        .as_deref()
        .ok_or_else(|| PoiBundleLoadError::Config("poi_bundle_dir is disabled".to_string()))?;
    read_city_entries_from(config, dir, record)
}

pub fn read_city_entries_from(
    config: &ServerConfig,
    dir: &Path,
    record: &PoiManifestBundle,
) -> Result<Vec<PoiEntry>, PoiBundleLoadError> {
    validate_strict_record(config, record)?;
    let path = dir.join(&record.filename);
    let max_bytes = config.poi_bundle_max_decoded_bytes;
    let mut compressed = Vec::new();
    File::open(&path)
        .map_err(PoiBundleLoadError::Read)?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut compressed)
        .map_err(PoiBundleLoadError::Read)?;
    if compressed.len() as u64 > max_bytes {
        return Err(PoiBundleLoadError::TooLarge {
            stage: "compressed",
            max_bytes,
        });
    }
    if compressed.len() as u64 != record.size_bytes {
        return Err(PoiBundleLoadError::Config(format!(
            "{} has {} bytes; manifest advertises {}",
            path.display(),
            compressed.len(),
            record.size_bytes
        )));
    }
    let actual_sha = format!("{:x}", Sha256::digest(&compressed));
    if actual_sha != record.sha256 {
        return Err(PoiBundleLoadError::Config(format!(
            "{} sha256 mismatch",
            path.display()
        )));
    }

    let mut json_bytes = Vec::new();
    brotli::Decompressor::new(&compressed[..], 4096)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut json_bytes)
        .map_err(PoiBundleLoadError::Decompress)?;
    if json_bytes.len() as u64 > max_bytes {
        return Err(PoiBundleLoadError::TooLarge {
            stage: "decompressed",
            max_bytes,
        });
    }
    let bundle: PoiBundle =
        serde_json::from_slice(&json_bytes).map_err(PoiBundleLoadError::Json)?;
    if bundle.meta.city_id != record.city_id {
        return Err(PoiBundleLoadError::Config(format!(
            "{} contains cityId {}",
            path.display(),
            bundle.meta.city_id
        )));
    }
    if bundle.meta.tier != Tier::Strict {
        return Err(PoiBundleLoadError::Config(format!(
            "{} strict serving bundle has meta tier other than strict",
            path.display()
        )));
    }
    if bundle.meta.entry_count != bundle.entries.len() as u64 {
        return Err(PoiBundleLoadError::Config(format!(
            "{} advertises {} entries but contains {}",
            path.display(),
            bundle.meta.entry_count,
            bundle.entries.len()
        )));
    }
    if bundle
        .entries
        .iter()
        .any(|entry| !(-90.0..=90.0).contains(&entry.lat) || !(-180.0..=180.0).contains(&entry.lon))
    {
        return Err(PoiBundleLoadError::Config(format!(
            "{} contains an out-of-range coordinate",
            path.display()
        )));
    }
    if bundle
        .entries
        .iter()
        .any(|entry| entry.tier != Tier::Strict)
    {
        return Err(PoiBundleLoadError::Config(format!(
            "{} strict serving bundle contains a non-strict entry",
            path.display()
        )));
    }
    Ok(bundle.entries)
}

#[derive(Debug, Clone, Copy)]
pub struct ValidatedPoiTiling {
    pub edge_km: f64,
    pub anchor: TileAnchor,
}

#[derive(Debug, Clone, Copy)]
pub struct ActivePoiTiling {
    pub tiling: ValidatedPoiTiling,
    pub policy: PoiTilingPolicy,
    pub k_anon_waived: bool,
    pub tile_bounds: PoiTileBounds,
}

pub trait PoiTileManifestSource {
    fn decode_manifest(&self) -> serde_json::Result<PoiTileManifest>;
}

impl PoiTileManifestSource for PoiTileManifest {
    fn decode_manifest(&self) -> serde_json::Result<PoiTileManifest> {
        Ok(self.clone())
    }
}

impl PoiTileManifestSource for DeferredJson<PoiTileManifest> {
    fn decode_manifest(&self) -> serde_json::Result<PoiTileManifest> {
        self.decode()
    }
}

/// Resolve the serving contract without touching a bundle.
pub fn active_tiling_contract<T: PoiTileManifestSource + ?Sized>(
    schema_version: u64,
    city_id: &str,
    tiling: Option<&T>,
) -> Result<Option<ActivePoiTiling>, PoiBundleLoadError> {
    if schema_version != POI_MANIFEST_SCHEMA_VERSION {
        return Err(PoiBundleLoadError::Config(format!(
            "unsupported manifest schemaVersion {schema_version}; expected {POI_MANIFEST_SCHEMA_VERSION}"
        )));
    }

    let Some(tiling) = tiling else {
        return Ok(None);
    };
    let tiling = tiling.decode_manifest().map_err(|_| {
        PoiBundleLoadError::Config(format!(
            "manifest poiTile for {city_id} must be a valid object"
        ))
    })?;
    let delivery_active = tiling
        .delivery_active
        .as_ref()
        .ok_or_else(|| {
            PoiBundleLoadError::Config(format!(
                "manifest poiTile for {city_id} must explicitly set deliveryActive"
            ))
        })?
        .decode()
        .map_err(|_| {
            PoiBundleLoadError::Config(format!(
                "manifest deliveryActive for {city_id} must be boolean"
            ))
        })?;
    if !delivery_active {
        return Ok(None);
    }

    let edge_km = tiling
        .edge_km
        .as_ref()
        .ok_or_else(|| {
            PoiBundleLoadError::Config(format!(
                "active manifest poiTile for {city_id} must set edgeKm"
            ))
        })?
        .decode()
        .map_err(|_| {
            PoiBundleLoadError::Config(format!("manifest edgeKm for {city_id} must be a number"))
        })?;
    let anchor = tiling
        .anchor
        .as_ref()
        .ok_or_else(|| {
            PoiBundleLoadError::Config(format!(
                "active manifest poiTile for {city_id} must set anchor"
            ))
        })?
        .decode()
        .map_err(|_| {
            PoiBundleLoadError::Config(format!(
                "manifest anchor for {city_id} must be a valid object"
            ))
        })?;
    let policy = tiling
        .tiling_policy
        .as_ref()
        .ok_or_else(|| {
            PoiBundleLoadError::Config(format!(
                "active manifest poiTile for {city_id} must set tilingPolicy"
            ))
        })?
        .decode()
        .map_err(|_| {
            PoiBundleLoadError::Config(format!("manifest tilingPolicy for {city_id} is invalid"))
        })?;
    let k_anon_waived = tiling
        .k_anon_waived
        .as_ref()
        .ok_or_else(|| {
            PoiBundleLoadError::Config(format!(
                "active manifest poiTile for {city_id} must set kAnonWaived"
            ))
        })?
        .decode()
        .map_err(|_| {
            PoiBundleLoadError::Config(format!(
                "manifest kAnonWaived for {city_id} must be boolean"
            ))
        })?;
    let bounds = tiling
        .tile_bounds
        .as_ref()
        .ok_or_else(|| {
            PoiBundleLoadError::Config(format!(
                "active manifest poiTile for {city_id} must set tileBounds"
            ))
        })?
        .decode()
        .map_err(|_| {
            PoiBundleLoadError::Config(format!(
                "manifest tileBounds for {city_id} must be a valid object"
            ))
        })?;
    let tile_bounds = validate_tile_bounds(city_id, bounds)?;

    match policy {
        PoiTilingPolicy::KAnonFloor if k_anon_waived => {
            return Err(PoiBundleLoadError::Config(format!(
                "active k-anon-floor policy for {city_id} requires kAnonWaived=false"
            )));
        }
        PoiTilingPolicy::ByteBudget | PoiTilingPolicy::FixedEdge if !k_anon_waived => {
            return Err(PoiBundleLoadError::Config(format!(
                "active non-default policy for {city_id} requires kAnonWaived=true"
            )));
        }
        _ => {}
    }

    Ok(Some(ActivePoiTiling {
        tiling: ValidatedPoiTiling { edge_km, anchor },
        policy,
        k_anon_waived,
        tile_bounds,
    }))
}

pub const UNKNOWN_POI_CITY_METRIC_LABEL: &str = "unknown";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoiCityMetricClass<'a> {
    Known(&'a str),
    Unknown,
}

impl<'a> PoiCityMetricClass<'a> {
    pub fn label(self) -> &'a str {
        match self {
            Self::Known(city_id) => city_id,
            Self::Unknown => UNKNOWN_POI_CITY_METRIC_LABEL,
        }
    }
}

/// Classify a request for metrics without ever returning attacker-owned text.
/// Only the first five valid strict records can produce city labels, matching
/// the startup manifest ceiling; everything else collapses to `unknown`.
pub fn classify_poi_city_for_metrics<'a>(
    manifest: &'a PoiManifest,
    requested_city_id: &str,
) -> PoiCityMetricClass<'a> {
    if !city_id_valid(requested_city_id) {
        return PoiCityMetricClass::Unknown;
    }
    let Ok(Some(requested)) = manifest.strict_bundle(requested_city_id) else {
        return PoiCityMetricClass::Unknown;
    };

    let mut strict_count = 0u64;
    for record in &manifest.bundles {
        if !city_id_valid(&record.city_id) || record.filename != format!("{}.br", record.city_id) {
            continue;
        }
        strict_count += 1;
        if strict_count > MAX_POI_CITY_SLOTS {
            break;
        }
        if std::ptr::eq(record, requested) {
            return PoiCityMetricClass::Known(record.city_id.as_str());
        }
    }
    PoiCityMetricClass::Unknown
}

fn validate_tile_bounds(
    city_id: &str,
    bounds: PoiTileBoundsWire,
) -> Result<PoiTileBounds, PoiBundleLoadError> {
    if bounds.min_x > bounds.max_x || bounds.min_y > bounds.max_y {
        return Err(PoiBundleLoadError::Config(format!(
            "manifest tileBounds for {city_id} must have ordered inclusive bounds"
        )));
    }
    if [bounds.min_x, bounds.max_x, bounds.min_y, bounds.max_y]
        .into_iter()
        .any(|coord| !(-MAX_TILE_COORD_ABS..=MAX_TILE_COORD_ABS).contains(&coord))
    {
        return Err(PoiBundleLoadError::Config(format!(
            "manifest tileBounds for {city_id} exceeds the six-digit tile-coordinate contract"
        )));
    }
    Ok(PoiTileBounds {
        min_x: bounds.min_x,
        max_x: bounds.max_x,
        min_y: bounds.min_y,
        max_y: bounds.max_y,
    })
}

pub fn validate_tiling(
    city_id: &str,
    contract: &ActivePoiTiling,
    entries: &[PoiEntry],
) -> Result<PoiTileIndex, PoiBundleLoadError> {
    let tiling = contract.tiling;
    if !tiling.edge_km.is_finite()
        || !(MIN_POI_TILE_EDGE_KM..=MAX_POI_TILE_EDGE_KM).contains(&tiling.edge_km)
    {
        return Err(PoiBundleLoadError::Config(format!(
            "manifest edgeKm for {city_id} must be between {MIN_POI_TILE_EDGE_KM} and {MAX_POI_TILE_EDGE_KM}"
        )));
    }
    let anchor = tiling.anchor;
    // `ref_lat` is EXCLUSIVE at both poles, matching Node's
    // `refLat <= -90 || refLat >= 90` (routes/poiTile.ts). A half-open
    // `(-90.0..90.0)` would accept -90.0 and diverge from Node, which fails
    // closed on it. The divergence is not benign: `cos(-90°)` is 6.77e-15 in
    // f64 rather than 0, so `poi_tile_grid::tile_coord_at` computes
    // `step_lon = edge_km / 6.77e-15` ≈ 1.77e15 degrees, every longitude
    // floors to x = 0, and the whole city silently collapses onto one tile
    // column — no panic, no NaN, no error to notice.
    if !(-90.0..=90.0).contains(&anchor.min_lat)
        || !(-180.0..=180.0).contains(&anchor.min_lon)
        || !anchor.ref_lat.is_finite()
        || anchor.ref_lat <= -90.0
        || anchor.ref_lat >= 90.0
    {
        return Err(PoiBundleLoadError::Config(format!(
            "manifest anchor for {city_id} is outside geographic bounds"
        )));
    }
    if entries.is_empty() {
        return Err(PoiBundleLoadError::Config(format!(
            "active POI corpus for {city_id} is empty"
        )));
    }

    let mut occupied_counts: HashMap<(i64, i64), usize> = HashMap::new();
    for entry in entries {
        let coord = tile_coord_at(entry.lat, entry.lon, tiling.edge_km, anchor);
        if !(-MAX_TILE_COORD_ABS..=MAX_TILE_COORD_ABS).contains(&coord.x)
            || !(-MAX_TILE_COORD_ABS..=MAX_TILE_COORD_ABS).contains(&coord.y)
        {
            return Err(PoiBundleLoadError::Config(format!(
                "active POI corpus for {city_id} exceeds the six-digit tile-coordinate contract"
            )));
        }
        if !contract.tile_bounds.contains(coord.x, coord.y) {
            return Err(PoiBundleLoadError::Config(format!(
                "active POI corpus for {city_id} has occupied tile {}_{} outside manifest tileBounds",
                coord.x, coord.y
            )));
        }
        *occupied_counts.entry((coord.x, coord.y)).or_default() += 1;
    }

    if contract.policy == PoiTilingPolicy::KAnonFloor {
        let min_k = tile_min_k();
        if let Some(((x, y), count)) = occupied_counts.iter().find(|(_, count)| **count < min_k) {
            return Err(PoiBundleLoadError::Config(format!(
                "active k-anon-floor tile {x}_{y} for {city_id} contains {count} entries; minimum is {min_k}"
            )));
        }
    }

    Ok(PoiTileIndex::build(entries, tiling.edge_km, anchor))
}

// Covers the cache's fixed structs, Arc counters, ETag allocation, and the
// largest formatted cache key admitted by the city/tile-coordinate grammar.
const POI_TILE_CACHE_METADATA_BOUND: u64 = 1024;
const EMPTY_TILE_RESPONSE_JSON_BYTES: u64 = br#"{"tileKey":"","entries":[]}"#.len() as u64;

fn brotli_max_compressed_bytes(input_bytes: u64) -> u64 {
    usize::try_from(input_bytes)
        .ok()
        .map(brotli::enc::BrotliEncoderMaxCompressedSize)
        .and_then(|bytes| u64::try_from(bytes).ok())
        .unwrap_or(u64::MAX)
}

/// Cache charge for every request-valid tile in one active corpus. Computes
/// JSON lengths and Brotli's maximum output size only; responses remain lazily
/// serialized and compressed on first request.
///
/// The two fields answer different questions and MUST NOT be used
/// interchangeably:
///
/// * `envelope_total` is a loose upper bound. It charges Brotli's
///   incompressible-worst-case output for content the cache actually stores at
///   `compressed.len()` (`ops::poi_tile_cache::PoiTileResponseCache::entry_charge`).
///   Real POI JSON compresses to roughly a sixth of that — the committed
///   Vilnius corpus is 89,653 bytes decoded against a 13,350-byte artifact — so
///   this overstates true occupancy several-fold. It is a thrash-risk signal,
///   not grounds to refuse a corpus.
/// * `max_single_tile` is decisive regardless of how loose the estimate is.
///   `insert_locked` rejects any entry whose charge exceeds the byte budget
///   (`charge > max_bytes` returns `false`), so a tile above the budget can
///   never be cached at all and is recompressed at q11 on every single request.
///   That is a permanent defect rather than a capacity estimate.
struct RequiredTileCache {
    envelope_total: u64,
    max_single_tile: u64,
}

fn required_tile_cache_bytes(
    record: &PoiManifestBundle,
    contract: &ActivePoiTiling,
    entries: &[PoiEntry],
) -> RequiredTileCache {
    let mut occupied: HashMap<(i64, i64), (u64, u64)> = HashMap::new();
    for entry in entries {
        let coord = tile_coord_at(
            entry.lat,
            entry.lon,
            contract.tiling.edge_km,
            contract.tiling.anchor,
        );
        let group = occupied.entry((coord.x, coord.y)).or_default();
        group.0 = group.0.saturating_add(entry.raw_json.get().len() as u64);
        group.1 = group.1.saturating_add(1);
    }

    let tile_label = format!("{}km", contract.tiling.edge_km);
    let response_charge = |tile_coords_len: u64, raw_bytes: u64, entry_count: u64| {
        let tile_key_len = (record.city_id.len() + tile_label.len() + 2) as u64 + tile_coords_len;
        let input_bytes = EMPTY_TILE_RESPONSE_JSON_BYTES
            .saturating_add(tile_key_len)
            .saturating_add(raw_bytes)
            .saturating_add(entry_count.saturating_sub(1));
        brotli_max_compressed_bytes(input_bytes).saturating_add(POI_TILE_CACHE_METADATA_BOUND)
    };

    let max_x_len = contract
        .tile_bounds
        .min_x
        .to_string()
        .len()
        .max(contract.tile_bounds.max_x.to_string().len());
    let max_y_len = contract
        .tile_bounds
        .min_y
        .to_string()
        .len()
        .max(contract.tile_bounds.max_y.to_string().len());
    let max_coords_len = (max_x_len + 1 + max_y_len) as u64;
    let empty_cells = contract
        .tile_bounds
        .cell_count()
        .saturating_sub(occupied.len() as u64);
    let empty_charge = response_charge(max_coords_len, 0, 0);
    let mut required = empty_cells.saturating_mul(empty_charge);
    // An empty in-bounds tile is still built and cached, so it counts toward the
    // per-tile maximum — but only when the envelope actually contains one.
    let mut max_single_tile = if empty_cells > 0 { empty_charge } else { 0 };

    for ((x, y), (raw_bytes, entry_count)) in occupied {
        let coords_len = format!("{x}_{y}").len() as u64;
        let charge = response_charge(coords_len, raw_bytes, entry_count);
        required = required.saturating_add(charge);
        max_single_tile = max_single_tile.max(charge);
    }
    RequiredTileCache {
        envelope_total: required,
        max_single_tile,
    }
}

/// Validate every active strict corpus before listeners bind. The response
/// cache must fit the complete coordinate envelope so cycling valid requests
/// cannot force repeated q11 work after eviction.
pub fn validate_poi_configuration(
    config: &ServerConfig,
) -> Result<Option<PoiPreflightReady>, PoiBundleLoadError> {
    let Some(configured_dir) = config.poi_bundle_dir.as_deref() else {
        return Ok(None);
    };
    // Resolve and pin under the resolution guard: retention cannot prune the
    // release between canonicalizing the pointer and taking its lease.
    let resolving = match config.poi_lease_root.as_deref() {
        Some(root) => Some(
            ResolutionGuard::acquire(root)
                .map_err(|e| PoiBundleLoadError::Config(format!("POI lease root: {e}")))?,
        ),
        None => None,
    };
    let pinned_dir = match std::fs::canonicalize(configured_dir) {
        Ok(path) if path.is_dir() => path,
        Ok(path) => {
            return Err(PoiBundleLoadError::Config(format!(
                "poi_bundle_dir {} is not a directory",
                path.display()
            )));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(PoiBundleLoadError::Read(error)),
    };
    let lease = match &resolving {
        Some(guard) => {
            let identity = pinned_dir
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| valid_digest(name))
                .ok_or_else(|| {
                    PoiBundleLoadError::Config(format!(
                        "POI release {} is not a managed release identity",
                        pinned_dir.display()
                    ))
                })?;
            let lease = guard
                .pin(identity)
                .map_err(|e| PoiBundleLoadError::Config(format!("POI lease: {e}")))?;
            Some(Arc::new(lease))
        }
        None => None,
    };
    drop(resolving);
    let mut pinned_config = config.clone();
    pinned_config.poi_bundle_dir = Some(pinned_dir.clone());
    let config = &pinned_config;

    let Some(manifest) = read_manifest(config)? else {
        return Ok(None);
    };

    let mut active = Vec::new();
    let mut cities = Vec::new();
    let mut required_cache_entries = 0u64;
    let mut required_cache_bytes = 0u64;
    let mut seen = HashSet::new();
    for record in &manifest.bundles {
        if record.filename != format!("{}.br", record.city_id) {
            continue;
        }
        if !seen.insert(record.city_id.as_str()) {
            return Err(PoiBundleLoadError::Config(format!(
                "duplicate strict manifest record for {}",
                record.city_id
            )));
        }
        if seen.len() as u64 > MAX_POI_CITY_SLOTS {
            return Err(PoiBundleLoadError::Config(format!(
                "manifest has more than {MAX_POI_CITY_SLOTS} strict POI cities"
            )));
        }
        validate_strict_record(config, record)?;
        let Some(contract) = active_tiling_contract(
            manifest.schema_version,
            &record.city_id,
            record.poi_tile.as_ref(),
        )?
        else {
            cities.push(PoiPreflightCity::Inactive {
                city_id: record.city_id.clone(),
            });
            continue;
        };
        required_cache_entries =
            required_cache_entries.saturating_add(contract.tile_bounds.cell_count());
        if required_cache_entries > config.poi_tile_cache_max_entries {
            return Err(PoiBundleLoadError::Config(format!(
                "POI tile cache holds {} entries but configured corpora expose {} coordinates",
                config.poi_tile_cache_max_entries, required_cache_entries
            )));
        }
        active.push((record, contract));
    }

    for (record, contract) in active {
        let entries = read_city_entries(config, record)?;
        validate_tiling(&record.city_id, &contract, &entries)?;
        let charge = required_tile_cache_bytes(record, &contract, &entries);
        // Fail closed only on the condition that is decisive rather than
        // estimated: a tile charged above the whole budget is refused by
        // `insert_locked`, so it can never be cached and is recompressed at q11
        // on every request. No amount of budget tuning fixes that corpus.
        if charge.max_single_tile > config.poi_tile_cache_max_bytes {
            return Err(PoiBundleLoadError::Config(format!(
                "POI tile cache byte budget is {} but {} declares a single tile charged at up to {} bytes, which the cache can never admit",
                config.poi_tile_cache_max_bytes, record.city_id, charge.max_single_tile
            )));
        }
        required_cache_bytes = required_cache_bytes.saturating_add(charge.envelope_total);
        cities.push(PoiPreflightCity::Active {
            city_id: record.city_id.clone(),
            contract,
            bundle_sha256: Arc::from(record.sha256.as_str()),
        });
    }
    let envelope_exceeds_cache_budget = (required_cache_bytes > config.poi_tile_cache_max_bytes)
        .then_some(PoiEnvelopePressure {
            required_bytes: required_cache_bytes,
            budget_bytes: config.poi_tile_cache_max_bytes,
        });
    Ok(Some(PoiPreflightReady {
        pinned_dir,
        lease,
        manifest: Arc::new(manifest),
        cities,
        envelope_exceeds_cache_budget,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use pt_shared::poi_tile_grid::TileAnchor;
    use serde_json::{json, Value};
    use std::path::Path;
    use tempfile::TempDir;

    fn config(dir: &Path) -> ServerConfig {
        ServerConfig::try_parse_from([
            "pt-serve",
            "--data-root",
            "/tmp",
            "--pidfile-path",
            "/tmp/pt-serve-catalog-test.pid",
            "--city-slug",
            "vilnius",
            "--max-rss-bytes",
            "1073741824",
            "--process-fixed-overhead-bytes",
            "200000000",
            "--per-worker-overhead-bytes",
            "50000000",
            "--poi-bundle-dir",
            dir.to_str().expect("temp path is UTF-8"),
        ])
        .expect("test config parses")
    }

    fn publish(dir: &Path, entries: &[Value], edge_km: f64) -> Value {
        let anchor = TileAnchor {
            min_lat: 54.58,
            min_lon: 25.08,
            ref_lat: 54.68,
        };
        let (mut min_x, mut max_x, mut min_y, mut max_y) = (0, 0, 0, 0);
        if (MIN_POI_TILE_EDGE_KM..=MAX_POI_TILE_EDGE_KM).contains(&edge_km) {
            for (entry_ix, entry) in entries.iter().enumerate() {
                let coord = tile_coord_at(
                    entry["lat"].as_f64().expect("entry lat"),
                    entry["lon"].as_f64().expect("entry lon"),
                    edge_km,
                    anchor,
                );
                if entry_ix == 0 {
                    (min_x, max_x, min_y, max_y) = (coord.x, coord.x, coord.y, coord.y);
                } else {
                    min_x = min_x.min(coord.x);
                    max_x = max_x.max(coord.x);
                    min_y = min_y.min(coord.y);
                    max_y = max_y.max(coord.y);
                }
            }
        }
        let bundle = json!({
            "meta": {
                "cityId": "vilnius",
                "version": "1",
                "attribution": "x",
                "licenseUrl": "x",
                "sourcePbfTimestamp": "2026-01-01T00:00:00Z",
                "bundleGeneratedAt": "2026-01-02T00:00:00Z",
                "tier": "strict",
                "entryCount": entries.len()
            },
            "entries": entries
        });
        let json_bytes = serde_json::to_vec(&bundle).expect("bundle serializes");
        let mut compressed = Vec::new();
        brotli::BrotliCompress(
            &mut json_bytes.as_slice(),
            &mut compressed,
            &brotli::enc::BrotliEncoderParams::default(),
        )
        .expect("bundle compresses");
        std::fs::write(dir.join("vilnius.br"), &compressed).expect("bundle writes");
        let record = json!({
            "cityId": "vilnius",
            "filename": "vilnius.br",
            "sizeBytes": compressed.len(),
            "sha256": format!("{:x}", Sha256::digest(&compressed)),
            "poiTile": {
                "edgeKm": edge_km,
                "anchor": {"minLat": 54.58, "minLon": 25.08, "refLat": 54.68},
                "tilingPolicy": "fixed-edge",
                "kAnonWaived": true,
                "tileBounds": {
                    "minX": min_x,
                    "maxX": max_x,
                    "minY": min_y,
                    "maxY": max_y
                },
                "deliveryActive": true
            }
        });
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&json!({"schemaVersion": 1, "bundles": [&record]}))
                .expect("manifest serializes"),
        )
        .expect("manifest writes");
        record
    }

    fn entry(id: &str, lat: f64, lon: f64) -> Value {
        json!({
            "id": id,
            "name": id,
            "aliases": {},
            "category": "landmark",
            "lat": lat,
            "lon": lon,
            "source": "osm",
            "rankBoost": 0,
            "tier": "strict"
        })
    }

    fn deferred_tiling(value: Value) -> DeferredJson<PoiTileManifest> {
        serde_json::from_value(value).expect("poiTile raw JSON decodes")
    }

    fn captured_preflight_error(mut cfg: ServerConfig) -> String {
        cfg.validate()
            .expect("POI preflight failures must not reject transit config");
        match cfg.validated_poi_manifest {
            Some(PoiPreflightState::Failed(error)) => error.to_string(),
            other => panic!("expected captured POI preflight failure, got {other:?}"),
        }
    }

    fn write_manifest(dir: &Path, record: &Value) {
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&json!({"schemaVersion": 1, "bundles": [record]}))
                .expect("manifest serializes"),
        )
        .expect("manifest writes");
    }

    #[test]
    fn valid_artifacts_pass_startup_preflight() {
        let dir = TempDir::new().expect("temp dir");
        publish(dir.path(), &[entry("v1", 54.6, 25.2)], 12.0);
        let mut cfg = config(dir.path());
        cfg.validate().expect("valid config");
        let preflight = cfg
            .validated_poi_manifest
            .clone()
            .expect("startup retains the POI preflight state");
        let ready = match &preflight {
            PoiPreflightState::Ready(ready) => ready,
            other => panic!("expected ready POI preflight, got {other:?}"),
        };

        std::fs::write(dir.path().join("manifest.json"), b"not-json")
            .expect("replace source manifest after validation");
        let cache = PoiManifestCache::new(Some(&preflight));
        let retained = cache
            .get_or_load(&cfg)
            .expect("retained preflight remains readable")
            .expect("retained preflight exists");
        assert!(Arc::ptr_eq(&retained.manifest, &ready.manifest));
        assert_eq!(retained.manifest.schema_version, 1);
        assert_eq!(retained.manifest.bundles.len(), 1);
    }

    #[cfg(unix)]
    /// `classify_poi_city_for_metrics` is the ONLY thing keeping the
    /// `pt_serve_poi_tile_requests_total{poi_city}` label set bounded, and
    /// `poi_city` originates in the request URL. The classifier is correct
    /// today — it returns Known only on `std::ptr::eq` against a strict
    /// manifest record, after a `city_id_valid` gate and a MAX_POI_CITY_SLOTS
    /// break — but nothing asserted it, so a future edit to that pointer
    /// comparison could silently unbound a Prometheus label map from untrusted
    /// input.
    #[test]
    fn metric_city_label_never_echoes_untrusted_input() {
        let root = TempDir::new().expect("temp dir");
        let release = root.path().join("release");
        std::fs::create_dir(&release).expect("create release");
        // `publish` returns the bundle RECORD; wrap it the way it writes
        // manifest.json on disk.
        let record = publish(&release, &[entry("vilnius-entry", 54.6, 25.2)], 12.0);
        let manifest: PoiManifest =
            serde_json::from_value(json!({"schemaVersion": 1, "bundles": [record]}))
                .expect("manifest decodes");

        // A city present in the manifest classifies to its own id.
        let known = manifest.bundles[0].city_id.clone();
        assert_eq!(
            classify_poi_city_for_metrics(&manifest, &known).label(),
            known.as_str()
        );

        // Everything else collapses to the fixed bucket — including inputs that
        // would be attacker-controlled cardinality if echoed back.
        for hostile in [
            "not-in-manifest",
            "../../etc/passwd",
            "a-very-long-city-id-that-should-never-become-a-label",
            "UPPERCASE",
            "",
            "vilnius\ninjected",
        ] {
            assert_eq!(
                classify_poi_city_for_metrics(&manifest, hostile).label(),
                UNKNOWN_POI_CITY_METRIC_LABEL,
                "{hostile:?} must not reach the metric label set"
            );
        }
    }

    /// Reject an immutable candidate once, then recover when discovery points
    /// to a different validated release without restarting the service.
    #[test]
    fn failed_candidate_recovers_only_after_pointer_changes() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().expect("temp dir");
        let current = root.path().join("current");
        let bad_release = root.path().join("release-bad");
        std::fs::create_dir(&bad_release).expect("create bad release");
        // edgeKm below MIN_POI_TILE_EDGE_KM — validate_tiling rejects it, which
        // is a malformed artifact rather than a missing one.
        publish(&bad_release, &[entry("bad-entry", 54.6, 25.2)], 1.0);
        symlink(&bad_release, &current).expect("publish bad release");
        let mut cfg = config(&current);
        cfg.validate().expect("POI never fails config validation");

        let cache = PoiManifestCache::new(Some(&PoiPreflightState::Cold));
        assert!(matches!(cache.status(), PoiManifestStatus::Cold));

        let first = cache.get_or_load(&cfg);
        assert!(first.is_err(), "a malformed manifest must fail the route");
        assert!(
            matches!(cache.status(), PoiManifestStatus::Failed(_)),
            "rejection must latch Failed"
        );

        // Repairing a rejected immutable target in place must not retry it.
        publish(&bad_release, &[entry("repaired-entry", 54.6, 25.2)], 12.0);
        assert!(cache.get_or_load(&cfg).is_err());

        // A different immutable target is eligible for complete validation.
        std::fs::remove_file(&current).expect("remove current");
        let good_release = root.path().join("release-good");
        std::fs::create_dir(&good_release).expect("create good release");
        publish(&good_release, &[entry("good-entry", 54.6, 25.2)], 12.0);
        symlink(&good_release, &current).expect("publish good release");

        let second = cache
            .get_or_load(&cfg)
            .expect("new release validates")
            .unwrap();
        assert_eq!(
            second.pinned_dir,
            std::fs::canonicalize(good_release).unwrap()
        );
        assert!(matches!(cache.status(), PoiManifestStatus::Ready));
    }

    #[test]
    fn pointer_updates_adopt_new_release_and_preserve_inflight_snapshot() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().expect("temp dir");
        let current = root.path().join("current");
        let cold_release = root.path().join("release-cold");
        std::fs::create_dir(&cold_release).expect("create cold release");
        symlink(&cold_release, &current).expect("publish cold release");
        let mut cfg = config(&current);
        cfg.validate()
            .expect("a release without a manifest is a cold state");
        let preflight = cfg
            .validated_poi_manifest
            .as_ref()
            .expect("configured POI retains a state");
        assert!(matches!(preflight, PoiPreflightState::Cold));
        assert_eq!(cfg.poi_bundle_dir.as_deref(), Some(current.as_path()));

        let release_a = root.path().join("release-a");
        std::fs::create_dir(&release_a).expect("create release-a");
        publish(&release_a, &[entry("release-a-entry", 54.6, 25.2)], 12.0);
        std::fs::remove_file(&current).expect("remove cold current");
        symlink(&release_a, &current).expect("publish release-a");

        let cache = PoiManifestCache::new(Some(preflight));
        assert!(matches!(cache.status(), PoiManifestStatus::Cold));
        let retained_a = cache
            .get_or_load(&cfg)
            .expect("late release validates")
            .expect("late release exists");
        assert!(matches!(cache.status(), PoiManifestStatus::Ready));

        std::fs::remove_file(&current).expect("remove current");
        let release_b = root.path().join("release-b");
        std::fs::create_dir(&release_b).expect("create release-b");
        publish(&release_b, &[entry("release-b-entry", 54.6, 25.2)], 12.0);
        symlink(&release_b, &current).expect("publish release-b");

        let retained_after_flip = cache
            .get_or_load(&cfg)
            .expect("cached release remains valid")
            .expect("cached release exists");
        assert!(!Arc::ptr_eq(&retained_a, &retained_after_flip));
        assert_eq!(
            retained_after_flip.pinned_dir,
            std::fs::canonicalize(&release_b).unwrap()
        );
        let PoiPreflightCity::Active { city_id, .. } = &retained_a.cities[0] else {
            panic!("expected active release-a city");
        };
        let record = retained_a
            .manifest
            .strict_bundle(city_id)
            .expect("strict lookup succeeds")
            .expect("strict release-a record exists");
        let entries = read_city_entries_from(&cfg, &retained_a.pinned_dir, record)
            .expect("request read stays pinned to release-a");
        let retained_entry: Value =
            serde_json::from_str(entries[0].raw_json.get()).expect("entry JSON remains valid");
        assert_eq!(retained_entry["id"], "release-a-entry");

        // A rejected update and a temporarily absent pointer preserve B.
        std::fs::remove_file(&current).unwrap();
        let bad = root.path().join("release-bad");
        std::fs::create_dir(&bad).unwrap();
        publish(&bad, &[entry("bad-entry", 54.6, 25.2)], 1.0);
        symlink(&bad, &current).unwrap();
        assert!(Arc::ptr_eq(
            &retained_after_flip,
            &cache.get_or_load(&cfg).unwrap().unwrap()
        ));
        std::fs::remove_file(&current).unwrap();
        assert!(Arc::ptr_eq(
            &retained_after_flip,
            &cache.get_or_load(&cfg).unwrap().unwrap()
        ));

        // Rollback adopts the previous immutable directory again.
        symlink(&release_a, &current).unwrap();
        let rolled_back = cache.get_or_load(&cfg).unwrap().unwrap();
        assert_eq!(rolled_back.pinned_dir, retained_a.pinned_dir);
    }

    /// Without a lease root the manager prunes a non-current composition after
    /// its grace period, so a snapshot retained past a rejected update must not
    /// outlive its directory.
    #[cfg(unix)]
    #[test]
    fn retained_snapshot_is_dropped_once_its_directory_is_pruned() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let current = root.path().join("current");
        let release_a = root.path().join("release-a");
        std::fs::create_dir(&release_a).unwrap();
        publish(&release_a, &[entry("release-a-entry", 54.6, 25.2)], 12.0);
        symlink(&release_a, &current).unwrap();
        let cfg = config(&current);
        let cache = PoiManifestCache::new(Some(&PoiPreflightState::Cold));
        let retained = cache.get_or_load(&cfg).unwrap().unwrap();

        std::fs::remove_file(&current).unwrap();
        let bad = root.path().join("release-bad");
        std::fs::create_dir(&bad).unwrap();
        publish(&bad, &[entry("bad-entry", 54.6, 25.2)], 1.0);
        symlink(&bad, &current).unwrap();
        assert!(Arc::ptr_eq(
            &retained,
            &cache.get_or_load(&cfg).unwrap().unwrap()
        ));

        std::fs::remove_dir_all(&release_a).unwrap();
        assert!(
            cache.get_or_load(&cfg).is_err(),
            "a pruned snapshot must not keep serving"
        );
        assert!(matches!(cache.status(), PoiManifestStatus::Failed(_)));

        std::fs::remove_file(&current).unwrap();
        let release_b = root.path().join("release-b");
        std::fs::create_dir(&release_b).unwrap();
        publish(&release_b, &[entry("release-b-entry", 54.6, 25.2)], 12.0);
        symlink(&release_b, &current).unwrap();
        let adopted = cache.get_or_load(&cfg).unwrap().unwrap();
        assert_eq!(
            adopted.pinned_dir,
            std::fs::canonicalize(&release_b).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn ready_startup_keeps_discovery_pointer_for_later_updates() {
        use std::os::unix::fs::symlink;
        let root = TempDir::new().unwrap();
        let current = root.path().join("current");
        let a = root.path().join("a");
        let b = root.path().join("b");
        for (path, id) in [(&a, "a"), (&b, "b")] {
            std::fs::create_dir(path).unwrap();
            publish(path, &[entry(id, 54.6, 25.2)], 12.0);
        }
        symlink(&a, &current).unwrap();
        let mut cfg = config(&current);
        cfg.validate().unwrap();
        assert_eq!(cfg.poi_bundle_dir.as_ref(), Some(&current));
        let cache = PoiManifestCache::new(cfg.validated_poi_manifest.as_ref());
        let previous = cache.get_or_load(&cfg).unwrap().unwrap();
        std::fs::remove_file(&current).unwrap();
        symlink(&b, &current).unwrap();
        let next = cache.get_or_load(&cfg).unwrap().unwrap();
        assert_eq!(previous.pinned_dir, std::fs::canonicalize(a).unwrap());
        assert_eq!(next.pinned_dir, std::fs::canonicalize(b).unwrap());
    }

    /// With a lease root, a served release stays leased until it is replaced
    /// and the last in-flight request drops its snapshot.
    #[test]
    fn served_release_is_leased_until_replaced_and_released() {
        use pt_shared::artifact_lease::CollectionGuard;
        use pt_shared::osm_manifest::digest;
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let leases = root.path().join("leases");
        let releases = root.path().join("releases");
        let [a, b] = [digest(b"a"), digest(b"b")];
        for id in [&a, &b] {
            let dir = releases.join(id);
            std::fs::create_dir_all(&dir).unwrap();
            publish(&dir, &[entry(id, 54.6, 25.2)], 12.0);
        }
        let current = root.path().join("current");
        symlink(releases.join(&a), &current).unwrap();
        let mut cfg = config(&current);
        cfg.poi_lease_root = Some(leases.clone());
        cfg.validate().unwrap();
        let live = |id: &str| {
            CollectionGuard::try_acquire(&leases)
                .unwrap()
                .is_live(id)
                .unwrap()
        };

        let cache = PoiManifestCache::new(cfg.validated_poi_manifest.take().as_ref());
        let first = cache.get_or_load(&cfg).unwrap().unwrap();
        assert!(live(&a), "the served release is leased");

        std::fs::remove_file(&current).unwrap();
        symlink(releases.join(&b), &current).unwrap();
        let second = cache.get_or_load(&cfg).unwrap().unwrap();
        assert!(live(&b));
        assert!(live(&a), "an in-flight request still reads release a");
        drop(first);
        assert!(!live(&a), "release a is free once nothing reads it");
        drop(second);
        assert!(live(&b), "the cache still serves release b");
    }

    #[test]
    fn leased_serving_rejects_a_directory_that_is_not_a_managed_release() {
        let root = TempDir::new().unwrap();
        let release = root.path().join("unmanaged");
        std::fs::create_dir(&release).unwrap();
        publish(&release, &[entry("e", 54.6, 25.2)], 12.0);
        let mut cfg = config(&release);
        cfg.poi_lease_root = Some(root.path().join("leases"));
        let error = validate_poi_configuration(&cfg).unwrap_err();
        assert!(
            error.to_string().contains("not a managed release"),
            "{error}"
        );
    }

    #[test]
    fn request_read_rechecks_bundle_after_preflight() {
        let dir = TempDir::new().expect("temp dir");
        publish(dir.path(), &[entry("v1", 54.6, 25.2)], 12.0);
        let cfg = config(dir.path());
        let ready = validate_poi_configuration(&cfg)
            .expect("preflight succeeds")
            .expect("manifest exists");
        std::fs::write(dir.path().join("vilnius.br"), b"tampered").expect("tamper after preflight");
        let record = ready
            .manifest
            .strict_bundle("vilnius")
            .expect("strict lookup succeeds")
            .expect("strict record exists");

        let error = read_city_entries_from(&cfg, &ready.pinned_dir, record)
            .expect_err("first request must detect post-preflight tampering");
        assert!(
            error.to_string().contains("manifest advertises")
                || error.to_string().contains("sha256 mismatch"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn preflight_fails_closed_when_a_single_tile_can_never_be_admitted() {
        let dir = TempDir::new().expect("temp dir");
        let mut record = publish(dir.path(), &[entry("v1", 54.6, 25.2)], 12.0);
        let max_x = record["poiTile"]["tileBounds"]["maxX"]
            .as_i64()
            .expect("maxX");
        record["poiTile"]["tileBounds"]["maxX"] = json!(max_x + 1);
        write_manifest(dir.path(), &record);

        let mut cfg = config(dir.path());
        cfg.poi_tile_cache_max_entries = 2;
        cfg.poi_tile_cache_max_bytes = 1;
        let error = captured_preflight_error(cfg);
        assert!(
            error.contains("can never admit"),
            "unexpected error: {error}"
        );
    }

    /// The regression that shipped: a corpus whose per-tile charges all fit but
    /// whose worst-case ENVELOPE sum does not was refused outright. The envelope
    /// figure charges Brotli's incompressible worst case for content the cache
    /// stores compressed, so it runs several times high — refusing on it left
    /// POI dead in a deployment whose cache would never have thrashed.
    #[test]
    fn envelope_over_budget_is_advisory_when_every_tile_still_fits() {
        let dir = TempDir::new().expect("temp dir");
        let record = publish(
            dir.path(),
            &[entry("v1", 54.6, 25.2), entry("v2", 54.9, 25.6)],
            12.0,
        );
        write_manifest(dir.path(), &record);

        // Stock defaults: comfortably under budget, nothing to report.
        let mut cfg = config(dir.path());
        assert!(
            validate_poi_configuration(&cfg)
                .expect("preflight succeeds")
                .expect("manifest present")
                .envelope_exceeds_cache_budget
                .is_none(),
            "a two-entry corpus must not register envelope pressure under stock defaults"
        );

        // Squeeze the budget so it sits between one tile's charge and the sum
        // over the envelope. Each tile stays individually admissible, so the
        // cache would never permanently reject one — the only exposure is
        // eviction under full-envelope cycling, which is advisory. 2 KiB
        // straddles that band for two single-entry tiles; if the per-tile
        // charge constants move, this fails loudly rather than silently
        // stopping testing what it claims to test.
        cfg.poi_tile_cache_max_bytes = 2048;
        let ready = validate_poi_configuration(&cfg)
            .expect("preflight must NOT fail on the envelope estimate")
            .expect("manifest present");
        let pressure = ready
            .envelope_exceeds_cache_budget
            .expect("envelope pressure is reported");
        assert_eq!(pressure.budget_bytes, 2048);
        assert!(
            pressure.required_bytes > pressure.budget_bytes,
            "pressure must only be reported when the envelope actually exceeds the budget"
        );
    }

    #[test]
    fn tile_min_k_matches_the_reviewed_privacy_floor() {
        assert_eq!(tile_min_k(), 50);
    }

    #[test]
    fn corrupt_hash_and_invalid_grid_are_captured_without_blocking_bind() {
        let corrupt = TempDir::new().expect("temp dir");
        publish(corrupt.path(), &[entry("v1", 54.6, 25.2)], 12.0);
        let bundle_path = corrupt.path().join("vilnius.br");
        let mut bytes = std::fs::read(&bundle_path).expect("bundle reads");
        bytes[0] ^= 1;
        std::fs::write(&bundle_path, bytes).expect("tamper");
        let error = captured_preflight_error(config(corrupt.path()));
        assert!(error.contains("sha256 mismatch"));

        let grid = TempDir::new().expect("temp dir");
        publish(grid.path(), &[entry("v1", 54.6, 25.2)], 0.0);
        let error = captured_preflight_error(config(grid.path()));
        assert!(error.contains("between 3 and 200"));
    }

    #[test]
    fn invalid_manifest_contracts_are_captured_without_blocking_bind() {
        let duplicate = TempDir::new().expect("temp dir");
        let record = publish(duplicate.path(), &[entry("v1", 54.6, 25.2)], 12.0);
        std::fs::write(
            duplicate.path().join("manifest.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "bundles": [&record, &record]
            }))
            .expect("manifest serializes"),
        )
        .expect("manifest writes");
        let error = captured_preflight_error(config(duplicate.path()));
        assert!(error.contains("duplicate strict"));

        let envelope = TempDir::new().expect("temp dir");
        publish(
            envelope.path(),
            &[entry("a", 54.58, 25.08), entry("b", 55.58, 26.08)],
            3.0,
        );
        let mut cfg = config(envelope.path());
        cfg.poi_tile_cache_max_entries = 4;
        let error = captured_preflight_error(cfg);
        assert!(error.contains("configured corpora expose"));

        let too_many = TempDir::new().expect("temp dir");
        let records: Vec<Value> = (0..6)
            .map(|index| {
                json!({
                    "cityId": format!("city{index}"),
                    "filename": format!("city{index}.br"),
                    "sizeBytes": 1,
                    "sha256": "0".repeat(64),
                    "poiTile": {
                        "edgeKm": 12,
                        "anchor": {"minLat": 54.58, "minLon": 25.08, "refLat": 54.68},
                        "tilingPolicy": "k-anon-floor",
                        "kAnonWaived": false,
                        "tileBounds": {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0},
                        "deliveryActive": false
                    }
                })
            })
            .collect();
        std::fs::write(
            too_many.path().join("manifest.json"),
            serde_json::to_vec(&json!({"schemaVersion": 1, "bundles": records}))
                .expect("manifest serializes"),
        )
        .expect("manifest writes");
        let error = captured_preflight_error(config(too_many.path()));
        assert!(error.contains("more than 5 strict POI cities"));

        let invalid_inactive = TempDir::new().expect("temp dir");
        std::fs::write(
            invalid_inactive.path().join("manifest.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "bundles": [{
                    "cityId": "vilnius",
                    "filename": "vilnius.br",
                    "sizeBytes": 0,
                    "sha256": "A".repeat(64),
                    "poiTile": {
                        "edgeKm": 12,
                        "anchor": {"minLat": 54.58, "minLon": 25.08, "refLat": 54.68},
                        "tilingPolicy": "k-anon-floor",
                        "kAnonWaived": false,
                        "tileBounds": {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0},
                        "deliveryActive": false
                    }
                }]
            }))
            .expect("manifest serializes"),
        )
        .expect("manifest writes");
        let error = captured_preflight_error(config(invalid_inactive.path()));
        assert!(error.contains("invalid sizeBytes"));

        let unsafe_city = TempDir::new().expect("temp dir");
        std::fs::write(
            unsafe_city.path().join("manifest.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "bundles": [{
                    "cityId": "../outside",
                    "filename": "../outside.br",
                    "sizeBytes": 0,
                    "sha256": "0".repeat(64),
                    "poiTile": {
                        "edgeKm": 12,
                        "anchor": {"minLat": 54.58, "minLon": 25.08, "refLat": 54.68},
                        "tilingPolicy": "fixed-edge",
                        "kAnonWaived": true,
                        "tileBounds": {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0},
                        "deliveryActive": true
                    }
                }]
            }))
            .expect("manifest serializes"),
        )
        .expect("manifest writes");
        let error = captured_preflight_error(config(unsafe_city.path()));
        assert!(error.contains("invalid cityId"));
    }

    #[test]
    fn activation_contract_covers_inactive_and_active_tiling() {
        let inactive = deferred_tiling(json!({"deliveryActive": false}));
        let active = deferred_tiling(json!({
            "edgeKm": 12,
            "anchor": {"minLat": 54.58, "minLon": 25.08, "refLat": 54.68},
            "tilingPolicy": "fixed-edge",
            "kAnonWaived": true,
            "tileBounds": {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0},
            "deliveryActive": true
        }));
        let scalar = deferred_tiling(json!(false));

        for version in [0, 2, 3] {
            assert!(active_tiling_contract(version, "vilnius", Some(&active))
                .expect_err("only schemaVersion 1 is served")
                .to_string()
                .contains(&format!("schemaVersion {version}")));
        }
        assert!(active_tiling_contract(1, "vilnius", Some(&scalar))
            .expect_err("poiTile must be an object")
            .to_string()
            .contains("valid object"));
        assert!(active_tiling_contract(1, "vilnius", Some(&inactive))
            .expect("inactive tiling short-circuits")
            .is_none());

        let malformed_inactive = deferred_tiling(json!({
            "deliveryActive": false,
            "edgeKm": "ignored",
            "anchor": "ignored",
            "tilingPolicy": "future-policy",
            "kAnonWaived": "ignored",
            "tileBounds": "ignored"
        }));
        assert!(
            active_tiling_contract(1, "vilnius", Some(&malformed_inactive))
                .expect("inactive tiling ignores active-only fields")
                .is_none()
        );

        let contract = active_tiling_contract(1, "vilnius", Some(&active))
            .expect("active tiling validates")
            .expect("active contract");
        assert_eq!(contract.tiling.edge_km, 12.0);

        let incomplete_active = deferred_tiling(json!({"deliveryActive": true}));
        let error = active_tiling_contract(1, "vilnius", Some(&incomplete_active))
            .expect_err("active tiling requires edge and anchor");
        assert!(error.to_string().contains("edgeKm"));

        let wrong_delivery = deferred_tiling(json!({"deliveryActive": "true"}));
        let error = active_tiling_contract(1, "vilnius", Some(&wrong_delivery))
            .expect_err("active flag must be boolean");
        assert!(error.to_string().contains("must be boolean"));

        let unknown_policy = deferred_tiling(json!({
            "edgeKm": 12,
            "anchor": {"minLat": 54.58, "minLon": 25.08, "refLat": 54.68},
            "tilingPolicy": "future-policy",
            "kAnonWaived": true,
            "tileBounds": {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0},
            "deliveryActive": true
        }));
        let error = active_tiling_contract(1, "vilnius", Some(&unknown_policy))
            .expect_err("active unknown policy must fail");
        assert!(error.to_string().contains("tilingPolicy"));
    }

    #[test]
    fn k_anon_floor_rejects_49_and_accepts_50_entries_in_one_tile() {
        for (count, should_pass) in [(49usize, false), (50usize, true)] {
            let dir = TempDir::new().expect("temp dir");
            let entries: Vec<Value> = (0..count)
                .map(|index| entry(&format!("v{index}"), 54.6, 25.2))
                .collect();
            let mut record = publish(dir.path(), &entries, 12.0);
            record["poiTile"]["tilingPolicy"] = json!("k-anon-floor");
            record["poiTile"]["kAnonWaived"] = json!(false);
            write_manifest(dir.path(), &record);

            let result = validate_poi_configuration(&config(dir.path()));
            if should_pass {
                assert!(
                    result.expect("50 entries meet the floor").is_some(),
                    "50 entries must activate"
                );
            } else {
                let error = result.expect_err("49 entries violate the floor");
                assert!(
                    error
                        .to_string()
                        .contains("contains 49 entries; minimum is 50"),
                    "unexpected error: {error}"
                );
            }
        }
    }
}
