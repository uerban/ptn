//! `Generation` — the per-bundle bag of immutable, swap-targeted state.
//!
//! Every field that depends on a SPECIFIC `.ptb` (and optional transfers artifact) lives here. The
//! process-scoped pieces (`Metrics`, `ServerConfig`, the `ArcSwap` handle itself) live on
//! [`crate::ops::ServerCtx`] — those survive a reload; this struct is replaced wholesale by a
//! hot-reload swap.
//!
//!
//! Every live `Generation` increments `mapped_generation_count` at
//! construction; `Drop` decrements it AND increments `generation_retired_total`.
//! The harness asserts the gauge falls back to 1 after a reload (the swap
//! retires the old generation when the last in-flight request's `Arc<Generation>`
//! returns). To make Drop access the metrics, each `Generation` carries an
//! `Arc<Metrics>` clone — see [`Generation::new`].

use crate::app::stops::RouteStyle;
use crate::mmap::{open_mmap, open_mmap_with_mtime, MmapBytes};
use crate::ops::Metrics;
use pt_core::{Index, Reader, Transfers};
use pt_shared::validate::errors::{IoErr, ValidationError};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

/// Active bundle generation. Cloned cheaply (the `Arc<Mmap>` and the built
/// `Index`/`Transfers` are heavy but only live ONCE per generation — workers
/// share a single `Arc<Generation>` via [`arc_swap::ArcSwap::load_full`]).
pub struct Generation {
    /// Authenticated installed selection identity, distinct from pack/generation ID.
    pub transit_selection: Option<String>,
    /// Optional transfers artifact mmap. `None` when pt-serve was started without
    /// `--transfers`; the GET endpoint returns 404 in that case.
    transfers_mmap: Option<Arc<memmap2::Mmap>>,
    /// PTB bundle mmap. Private — owned through the lifetime of the generation
    /// so the [`pt_core::Reader`] (a borrowing view over the bytes via
    /// [`MmapBytes`]) outlives the map. Exposed only via [`Generation::bundle_bytes`],
    /// which clones a fresh [`MmapBytes`] handle off this `Arc` for callers that
    /// need to stream the raw PTB.
    bundle_mmap: Arc<memmap2::Mmap>,
    /// PTB reader keyed off the bundle mmap. `Send+Sync`; safe to share.
    pub reader: Reader<MmapBytes>,
    /// Built-once RAPTOR index.
    pub index: Index,
    /// Per-stop route membership (`stop_idx -> [route_idx]`, FIRST-SEEN order,
    /// deduped) — the ALL-TRIPS union, matching the backend MapView
    /// (`getActiveRoutesForStop`), NOT the canonical-only `Reader::stop_routes()`
    /// CSR. Built ONCE at construction (off the request path) by
    /// [`crate::domain::stop_membership::build_stop_membership`]; consumed by the
    /// C2a `/stops/all` + `/stops/nearby` handlers (Tasks 6-7).
    pub stop_membership: Vec<Vec<u32>>,
    /// Built-once O(1) stop-time row reader. On a carry-less bundle the flat
    /// `0xF4` carry is gone, so a bare `reader.stop_time(row)` re-derives the
    /// band addressing per call — an O(k) pattern-trip scan plus several O(p)
    /// slab prefix walks. `/scheduled-departures-for-stop` does that once per
    /// candidate `(trip, row)` pair, on the request path.
    ///
    /// `None` when the precompute failed. That is fail-OPEN by design: the
    /// cursor is a speed-up over [`pt_core::Reader::stop_time`], never a
    /// correctness dependency, so a bundle it cannot describe still serves
    /// correct departures through the reader — just at the old cost. The
    /// failure is logged at load so it is not silent.
    pub stop_time_cursor: Option<pt_core::stop_time_cursor::StopTimeCursor>,
    /// Built-once transfers footpath table (if `--transfers` was supplied).
    pub transfers: Option<Transfers>,
    /// City slug from `--city`. Cached here so the dispatcher can match the
    /// path prefix without cross-thread access to the static config.
    pub city_slug: String,

    /// Stable generation identifier surfaced via `/version` and the manifest.
    /// Filled by [`build_generation`] from the manifest; empty only in the
    /// test-only [`Generation::from_paths`].
    pub generation_id: String,
    /// Full-SHA-256 hex of the bundle's served bytes. Filled by
    /// [`build_generation`] from the manifest; empty only in the test-only
    /// [`Generation::from_paths`].
    pub bundle_sha256: String,
    /// ISO-8601 build time from the manifest. Filled by [`build_generation`];
    /// empty only in the test-only [`Generation::from_paths`].
    pub created_at: String,
    /// 90-day service-window anchor (YYYYMMDD u32). Read from the PTB header
    /// via [`Reader::feed_start_date`]; cross-checked against the manifest
    /// during reload (`pt_shared::validate::metadata::validate_metadata`).
    pub feed_start_date: u32,
    /// Whether a transfers artifact is loaded — `transfers.is_some()` mirror,
    /// surfaced flat for the metrics/version handlers.
    pub has_transfers: bool,

    /// ETag for the `/raptor-bundle` response. Content-derived — see the
    /// `boundary_etag` doc on this module. Stored on `Generation` so a
    /// post-swap response carries the NEW generation's ETag (and a client
    /// issuing `If-None-Match: <old-etag>` after a swap gets 200 + new bytes,
    /// not a false 304).
    pub bundle_etag: String,
    /// Lazily-built gzip body for `/raptor-bundle`. Per-generation so a swap
    /// invalidates the cache implicitly (the old `Arc<Generation>` is dropped
    /// once the last in-flight request returns).
    pub bundle_gzip: OnceLock<Arc<[u8]>>,
    /// ETag for `/transfers/fetch` (full-content sha256 hex). `None` when no
    /// transfers artifact is loaded.
    pub transfers_etag: Option<String>,
    /// Lazily-built gzip body for `/transfers/fetch`. Per-generation.
    pub transfers_gzip: OnceLock<Arc<[u8]>>,
    /// ETag for `/route-geometry/fetch` (full `shapes.bin` sha256 hex).
    pub route_geometry_etag: Option<String>,
    /// Lazily-built gzip body for `/route-geometry/fetch`.
    pub route_geometry_gzip: OnceLock<Arc<[u8]>>,

    /// `color-config.json` bytes (served verbatim by `/color-config`, a future
    /// plan's handler). `None` if the producer didn't emit it (older generation).
    pub color_config: Option<Arc<[u8]>>,
    /// `route-styles.json` bytes (`{routeId:{color,textColor,subMode}}`) consumed
    /// by `/stops/*` (future plan). `None` if absent.
    pub route_styles: Option<Arc<[u8]>>,
    /// `label-anchors.json` bytes (Plan-C2a) consumed by the `/stops` handlers
    /// (Tasks 5-7). `None` if the producer didn't emit it (older generation).
    pub label_anchors: Option<Arc<[u8]>>,
    /// `route-styles.json` parsed into a `routeId -> RouteStyle` map, ONCE at
    /// load (via [`crate::app::stops::parse_route_styles`]). Shared by the
    /// at-load `/stops/all` body build AND the per-request `/stops/nearby`
    /// compose — so the ~20k-entry parse never lands on a blocking worker.
    pub route_styles_map: HashMap<String, RouteStyle>,
    /// `label-anchors.json` parsed into a `stopId -> anchor` map, ONCE at load
    /// (via [`crate::app::stops::parse_label_anchors`]). Shared like
    /// [`Self::route_styles_map`].
    pub label_anchors_map: HashMap<String, String>,
    /// Spatial grid `(cellLat, cellLon) -> [stop_idx]`, built ONCE at load over
    /// `0..num_stops()` (= `.ptb` stop-region order = the backend `iterStops`
    /// insertion order). Cell key uses `floor(coord / SPATIAL_CELL_DEG)`. The
    /// per-bucket `Vec<u32>` preserves stop-region insertion order — the
    /// `/stops/nearby` response order is grid-traversal (`cy` outer, `cx`
    /// inner) × within-bucket insertion, parity-exact with the backend
    /// `getNearbyStops` (`store.ts:327-381`).
    pub spatial_grid: HashMap<(i32, i32), Vec<u32>>,
    /// The fully-serialized `GET /api/<city>/stops/all` body, assembled ONCE at
    /// load (mirrors the backend's memoized `allStopsCache`) from the reader +
    /// `route_styles` + `label_anchors` + `stop_membership`. Served verbatim by
    /// [`crate::app::stops::stops_all`] — never re-serialized per request.
    pub stops_all_body: Arc<[u8]>,
    /// Retained `shapes.bin` mmap, kept so `shapes_json` can be lazily built.
    /// `None` if no shapes sidecar in this generation.
    shapes_mmap: Option<Arc<memmap2::Mmap>>,
    /// Canonical shapes JSON, lazily Rust-serialized from `shapes_mmap` via
    /// `pt_shared::sidecar::shapes_json_bytes` (byte-identical to the producer's
    /// recorded `shapesJsonSha256`). Built on first access.
    shapes_json: OnceLock<Arc<[u8]>>,
    /// Lowercase-hex SHA-256 of the canonical shapes JSON body, pre-computed at
    /// load by the streaming `pt_shared::sidecar::shapes_json_sha256` and
    /// verified against the manifest's `shapesJsonSha256`. `None` when no
    /// `shapes.bin` is loaded. Used by the `/shapes` handler for `ETag` +
    /// response header — the lazy `shapes_json` OnceLock stays lazy.
    pub shapes_json_sha256: Option<String>,
    /// Canonical shapes JSON body length computed alongside
    /// [`Self::shapes_json_sha256`] without materialising the body. `None` when
    /// no `shapes.bin` is loaded. Surfaced by `/ready` so the browser can build
    /// the same content-addressed artifact manifest without Node raptor-data.
    pub shapes_json_size_bytes: Option<u64>,
    /// Strong ETag for the `/shapes` response: `"<shapes_json_sha256>"`. `None`
    /// when no `shapes.bin` is present.
    pub shapes_json_etag: Option<String>,
    /// Lazily-built gzip body for the `/shapes` handler. Per-generation.
    pub shapes_json_gzip: OnceLock<Arc<[u8]>>,

    /// Retained `departures-idx.bin` (DPIX) mmap, kept so the C2c loopback
    /// handler can reconstruct a `pt_shared::sidecar::DeparturesIdx` view per
    /// request (via `parse_unchecked` — it was validated once at load). `None`
    /// when the producer didn't emit it (older generation) — the loopback
    /// handler then returns 503.
    pub departures_idx_mmap: Option<Arc<memmap2::Mmap>>,
    /// Trips-namespace SHA-256 recomputed from THIS bundle's interner at load
    /// (`intern_namespace_sha256` over `reader.trip_id(i)` in record order).
    /// A present DPIX's header SHA was cross-checked against this; the loopback
    /// handler can re-assert it cheaply. `[0u8;32]` on the test-only `from_paths`.
    pub dpix_trips_sha: [u8; 32],
    /// Stops-namespace SHA-256 recomputed from THIS bundle's interner at load.
    /// See [`Self::dpix_trips_sha`]. `[0u8;32]` on the test-only `from_paths`.
    pub dpix_stops_sha: [u8; 32],
    /// Resolved Jiff `TimeZone` for the city this generation serves. `Some` when
    /// the IANA resolved (from the manifest or the operator default) AND parsed
    /// — load fails when it does not resolve; `None` on the test-only
    /// `from_paths` or an unparseable name. An absent tz makes
    /// the C2c loopback handler return 503 (it cannot project service-day
    /// seconds to unix without a zone).
    pub city_tz: Option<jiff::tz::TimeZone>,
    /// The IANA name behind [`Self::city_tz`] (e.g. `"Europe/Vilnius"`). Empty
    /// string when unresolved (`from_paths`). Surfaced for triage/version.
    pub city_tz_iana: String,

    /// Parsed `schedule-tiles/manifest.json` (subdivision plans + the
    /// bundle hash the producer built tiles under). `None` when the
    /// producer didn't emit a schedule-tile build for this generation
    /// (older generation, or a producer run with schedule-tile build
    /// disabled) — the `/gtfs/schedule-tile` route then returns 503, same
    /// pattern as the `/shapes` route's "artifact unavailable" fallback.
    /// Unlike every other artifact on this struct, tile BODIES are NOT
    /// preloaded here — see [`Self::schedule_tiles_dir`].
    pub schedule_tile_manifest: Option<pt_shared::schedule_tile_manifest::ScheduleTileManifest>,
    /// Directory holding this generation's `.br` tile bodies
    /// (`<gen_dir>/schedule-tiles/<bundleHash>/`), `Some` iff
    /// [`Self::schedule_tile_manifest`] is `Some`. Deliberate divergence
    /// from the rest of this struct's eager-preload pattern: tile bodies
    /// are numerous/large enough that neither the Node route nor this one
    /// preloads them — the `/gtfs/schedule-tile` handler reads lazily
    /// per-request through `ServerCtx.tile_cache`.
    pub schedule_tiles_dir: Option<PathBuf>,
    /// Pre-built `GET /api/<city>/gtfs/manifest` reply. `Some` iff
    /// [`Self::schedule_tile_manifest`] is `Some` — the route 503s otherwise,
    /// the same "no bundle published yet" arm Node serves when its own
    /// snapshot is absent.
    pub gtfs_manifest_response: Option<GtfsManifestResponse>,
    /// Optional FST-backed local address-search sidecar. Loaded from
    /// `<generation>/address-search.json` when present. It is independent of
    /// the PTB bytes but generation-scoped so hot reloads swap the address
    /// corpus atomically with the served city generation.
    pub address_search: Option<AddressSearchSidecar>,

    /// Monotonic generation counter. Workers compare this against their
    /// cached `ScanState.epoch` and rebuild scratch state on mismatch. The
    /// startup generation is `epoch=0`; the reload runner allocates +1 per
    /// adoption from its [`ReloadRunner::next_epoch`] counter.
    pub epoch: u64,
    /// The PatternMode this generation's `index` was built with. Reported by
    /// `/ready` so an operator can confirm which mode is live (split-brain
    /// signal). pt_core::PatternMode is Copy + Send + Sync, so the existing
    /// `assert_impl_all!(Generation: Send, Sync)` still holds.
    pub pattern_mode: pt_core::PatternMode,
    /// `Arc<Metrics>` clone so `Drop` can decrement `mapped_generation_count`
    /// and increment `generation_retired_total`. `Option` because the
    /// test-only [`Generation::from_paths`] doesn't need it. Production
    /// path (`build_generation` from the reload runner OR
    /// `load_initial_generation`) always supplies `Some(metrics)`.
    metrics: Option<Arc<Metrics>>,
}

static_assertions::assert_impl_all!(Generation: Send, Sync);

impl Drop for Generation {
    fn drop(&mut self) {
        // The Drop fires LATER than the swap — `ArcSwap::store(new)` returns
        // the old Arc but workers may still hold strong refs. This Drop runs
        // when the LAST in-flight handler's `Arc<Generation>` clone returns
        // (or when the test harness explicitly drops the prior gen).
        if let Some(m) = self.metrics.as_ref() {
            m.dec_mapped_generation_count();
            m.inc_generation_retired_total();
        }
    }
}

/// gzip helper — used by the byte handlers' lazy-init.
///
/// The two `expect`s here document an invariant rather than guard a
/// runtime path: `GzEncoder<Vec<u8>>` writes to an in-memory `Vec` whose
/// `Write` impl is infallible (the only `io::Error` it can return is
/// `OutOfMemory` from `Vec::try_reserve`, and the std impl unconditionally
/// allocates — OOM aborts the process before `Err` is observable). The
/// hot-path callers (`app::bytes`) lazy-init into a `OnceLock<Arc<[u8]>>`;
/// returning a `Result` from gzip would force every load_full caller to
/// thread an error type for a path that physically cannot fail. Keep the
/// expects; the invariant is in the type.
pub(crate) fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(bytes)
        .expect("gzip into Vec<u8> is infallible (Vec::Write never errors)");
    enc.finish()
        .expect("gzip finish into Vec<u8> is infallible (Vec::Write never errors)")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Read a generation-dir artifact into an `Arc<[u8]>`. `NotFound` → `Ok(None)`
/// (the artifact is optional — older generations didn't emit it); any other IO
/// error is a hard `ValidationError::Io` (a present-but-unreadable artifact is
/// a load-time failure, never a silent `None`).
fn read_optional_arc(p: &Path) -> Result<Option<Arc<[u8]>>, ValidationError> {
    match std::fs::read(p) {
        Ok(b) => Ok(Some(Arc::from(b.into_boxed_slice()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ValidationError::Io(IoErr::from(e))),
    }
}

/// Loaded `address-search.json` sidecar plus the pre-built endpoint manifest.
pub struct AddressSearchSidecar {
    pub artifact_body: Arc<[u8]>,
    /// Lazily-built gzip body for `/address-search/bundle`. Lives on the
    /// sidecar rather than on `Generation` (where the `/raptor-bundle` and
    /// `/transfers/fetch` caches live) because it is only reachable when a
    /// corpus is loaded at all, and it dies with the corpus on a swap.
    ///
    /// Worth the memory: the artifact is the largest thing this process
    /// serves, and it is the one the PWA downloads whole before address search
    /// works offline. On the vilnius corpus it is 21.4 MB raw against 3.2 MB
    /// gzipped.
    pub artifact_gzip: OnceLock<Arc<[u8]>>,
    pub manifest_body: Arc<[u8]>,
    pub etag: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub row_count: usize,
    pub key_count: usize,
    pub index: pt_geocode::AddrIndex,
}

/// Load optional `<generation>/address-search.fst`.
///
/// Absent is a supported "city has no address corpus" state. Present-but-bad is
/// a hard generation load error: a malformed corpus must not be served as a
/// silently-empty geocoder.
///
/// The file is the packed index (`pt_geocode::artifact`, magic `PTAS`, schema
/// version 1), so this is a header parse and a bounds check — not a
/// deserialize. Anything else is refused rather than coerced: a file whose
/// magic is not `PTAS` — the extractor's JSON intermediate, most likely — is
/// rejected with an error naming `pt-producer pack-address-search`, and a
/// header claiming any other schema version is rejected outright.
pub(crate) fn load_address_search_artifact(
    gen_dir: &Path,
    city_slug: &str,
    generation_id: &str,
) -> Result<Option<AddressSearchSidecar>, ValidationError> {
    let Some(bytes) = read_optional_arc(&gen_dir.join("address-search.fst"))? else {
        return Ok(None);
    };

    let sha256 = sha256_hex(bytes.as_ref());
    let size_bytes = bytes.len() as u64;
    let index = pt_geocode::AddrIndex::from_bytes(Arc::clone(&bytes))
        .map_err(|e| artifact_invalid("address-search.fst", e.to_string()))?;

    // The corpus names the city it was built for; serving it under another slug
    // would answer a Vilnius query with Gdansk streets. Checked here rather
    // than trusted from the filename, which the operator controls.
    if let Some(artifact_city) = index.meta().city_id.as_deref() {
        if artifact_city != city_slug {
            return Err(artifact_invalid(
                "address-search.fst",
                format!("cityId {artifact_city:?} does not match served city {city_slug:?}"),
            ));
        }
    }

    let row_count = index.row_count();
    let key_count = index.key_count();
    let etag = format!("\"{sha256}\"");
    let mut manifest = serde_json::json!({
        "schemaVersion": pt_geocode::SCHEMA_VERSION,
        "cityId": city_slug,
        "generatedAt": index.meta().generated_at,
        "artifactUrl": format!("/api/{city_slug}/address-search/bundle"),
        "sha256": sha256.clone(),
        "sizeBytes": size_bytes,
        "rowCount": row_count,
        "keyCount": key_count,
        "bundleGenerationId": generation_id,
    });
    if let (Some(source), Some(obj)) = (index.meta().source.clone(), manifest.as_object_mut()) {
        obj.insert("source".to_string(), serde_json::Value::String(source));
    }
    let manifest_body = manifest.to_string().into_bytes();

    Ok(Some(AddressSearchSidecar {
        artifact_body: bytes,
        artifact_gzip: OnceLock::new(),
        manifest_body: Arc::from(manifest_body.into_boxed_slice()),
        etag,
        sha256,
        size_bytes,
        row_count,
        key_count,
        index,
    }))
}

/// Wrap a color-provenance sidecar load-time defect as a `ValidationError`. A
/// corrupt artifact (`shapes.bin` bad magic / truncation / malformed CSR, or a
/// full-file SHA mismatch vs the manifest on ANY of the three artifacts) is
/// on-disk data that is malformed but is NOT a PTB-structural defect — so we
/// surface it as `Io { InvalidData }`, the same taxonomy bucket the loader
/// already uses for a malformed manifest JSON (`serde_to_validation`). This
/// keeps the load-time validation pt-serve-local without expanding the shared
/// `ValidationError` enum. `artifact` names the offending file so triage can
/// distinguish e.g. `shapes.bin` from `color-config.json`.
fn artifact_invalid(artifact: &str, reason: String) -> ValidationError {
    ValidationError::Io(IoErr {
        kind: std::io::ErrorKind::InvalidData,
        msg: format!("{artifact} invalid: {reason}"),
    })
}

/// Outcome of [`load_color_artifacts`]: the two JSON byte blobs + the retained
/// `shapes.bin` mmap (all optional).
pub(crate) struct ColorArtifacts {
    pub color_config: Option<Arc<[u8]>>,
    pub route_styles: Option<Arc<[u8]>>,
    pub label_anchors: Option<Arc<[u8]>>,
    pub shapes_mmap: Option<Arc<memmap2::Mmap>>,
    /// Lowercase-hex SHA-256 of the complete `shapes.bin` artifact.
    pub shapes_bin_sha256: Option<String>,
    /// Lowercase-hex SHA-256 of the canonical shapes JSON body, computed at
    /// load via the streaming `pt_shared::sidecar::shapes_json_sha256`. `None`
    /// when no `shapes.bin` is present. This is the body hash the
    /// `/shapes` handler serves in `ETag` + `shapesJsonSha256` fields.
    pub shapes_json_sha256: Option<String>,
    /// Canonical shapes JSON body length computed by the same streaming pass.
    pub shapes_json_size_bytes: Option<u64>,
}

/// Load the Stage-C color provenance artifacts from a generation directory:
/// `color-config.json` + `route-styles.json` (verbatim bytes) and `shapes.bin`
/// (mmapped + structurally validated at load).
///
/// ## Load-time validation
///
/// For each of the three artifacts we verify **full-file integrity**: when the
/// blob is present AND the manifest recorded its SHA-256, the on-disk full-file
/// SHA must match the manifest's recorded value — hard `ValidationError` on
/// mismatch. The expected SHAs are `None` on the test-only `from_paths` path
/// (no manifest) and for older manifests lacking the field — the SHA check is
/// then skipped, but the `shapes.bin` structural parse below still runs.
///
/// When `shapes.bin` is present:
///
/// 1. **Full-file SHA check** (`expected_shapes_bin_sha`).
/// 2. **Header parse** (`parse_sidecar_header(.., SHPB)`).
/// 3. **Interner cross-check (X4):** `ShapesBin::parse(bytes,
///    recomputed_trips_sha, recomputed_stops_sha)` — feeding the BUNDLE's
///    recomputed SHAs, not the sidecar header's own. A sidecar built against a
///    different interner namespace yields `NamespaceShaMismatch` →
///    `artifact_invalid("shapes.bin", …"namespace"…)`.
/// 4. **Body-hash check:** compute `pt_shared::sidecar::shapes_json_sha256`
///    (streaming — no body materialisation) and compare against
///    `expected_shapes_json_sha`. This is the hash the frontend hard-fails on.
#[allow(clippy::too_many_arguments)]
pub(crate) fn load_color_artifacts(
    gen_dir: &Path,
    color_config_sha: Option<&str>,
    route_styles_sha: Option<&str>,
    label_anchors_sha: Option<&str>,
    expected_shapes_bin_sha: Option<&str>,
    recomputed_trips_sha: &[u8; 32],
    recomputed_stops_sha: &[u8; 32],
    expected_shapes_json_sha: Option<&str>,
    expected_shapes_json_size: Option<u64>,
    geometry_enabled: bool,
) -> Result<ColorArtifacts, ValidationError> {
    let color_config = read_optional_arc(&gen_dir.join("color-config.json"))?;
    if let (Some(bytes), Some(expected)) = (color_config.as_deref(), color_config_sha) {
        let actual = sha256_hex(bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(artifact_invalid(
                "color-config.json",
                format!("sha256 mismatch: manifest={expected}, on-disk={actual}"),
            ));
        }
    }

    let route_styles = read_optional_arc(&gen_dir.join("route-styles.json"))?;
    if let (Some(bytes), Some(expected)) = (route_styles.as_deref(), route_styles_sha) {
        let actual = sha256_hex(bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(artifact_invalid(
                "route-styles.json",
                format!("sha256 mismatch: manifest={expected}, on-disk={actual}"),
            ));
        }
    }

    let label_anchors = read_optional_arc(&gen_dir.join("label-anchors.json"))?;
    if let (Some(bytes), Some(expected)) = (label_anchors.as_deref(), label_anchors_sha) {
        let actual = sha256_hex(bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(artifact_invalid(
                "label-anchors.json",
                format!("sha256 mismatch: manifest={expected}, on-disk={actual}"),
            ));
        }
    }

    if !geometry_enabled {
        return Ok(ColorArtifacts {
            color_config,
            route_styles,
            label_anchors,
            shapes_mmap: None,
            shapes_bin_sha256: None,
            shapes_json_sha256: None,
            shapes_json_size_bytes: None,
        });
    }

    let shapes_path = gen_dir.join("shapes.bin");
    let mut shapes_json_size_bytes = None;
    let (shapes_mmap, shapes_json_sha256, shapes_bin_sha256) =
        match std::fs::File::open(&shapes_path) {
            Ok(f) => {
                let mm = unsafe { memmap2::Mmap::map(&f) }
                    .map_err(|e| ValidationError::Io(IoErr::from(e)))?;
                let bytes: &[u8] = &mm[..];

                // (1) Full-file integrity vs manifest (skipped when no manifest SHA).
                let actual = sha256_hex(bytes);
                if let Some(expected) = expected_shapes_bin_sha {
                    if !actual.eq_ignore_ascii_case(expected) {
                        return Err(artifact_invalid(
                            "shapes.bin",
                            format!(
                                "full-file sha256 mismatch: manifest={expected}, on-disk={actual}"
                            ),
                        ));
                    }
                }

                // (2) Header parse — must happen BEFORE ShapesBin::parse so a
                // truncated file reports Truncated/BadMagic, not NamespaceShaMismatch.
                let header = pt_shared::sidecar::parse_sidecar_header(
                    bytes,
                    pt_shared::sidecar::SHAPES_MAGIC,
                )
                .map_err(|e| artifact_invalid("shapes.bin", e.to_string()))?;

                // (3) Interner cross-check (X4): parse with the BUNDLE's recomputed SHAs,
                // not the sidecar header's own — a foreign sidecar yields NamespaceShaMismatch.
                let sb = pt_shared::sidecar::ShapesBin::parse(
                    bytes,
                    recomputed_trips_sha,
                    recomputed_stops_sha,
                )
                .map_err(|e| artifact_invalid("shapes.bin", e.to_string()))?;

                // Suppress the "unused variable" warning for the header after the
                // cross-check parse above supersedes it (header.trips_intern_sha256 /
                // header.stops_intern_sha256 are no longer fed into parse).
                let _ = header;

                // (4) Body-hash check (streaming — does NOT materialise the Vec).
                // The shapes points are decoded twice: once here for the streaming
                // hash, and once on first serve (`shapes_json_bytes` OnceLock).
                // This is intentional — retaining the multi-MB serialised body at
                // load time would add steady-state RSS proportional to the shapes
                // payload. Do NOT "optimise" by caching the body here.
                let (digest, body_len) = pt_shared::sidecar::shapes_json_sha256(&sb);
                let computed_hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();

                if let Some(expected_size) = expected_shapes_json_size {
                    if body_len != expected_size {
                        return Err(artifact_invalid(
                            "shapes.json",
                            format!(
                                "body size mismatch: manifest={expected_size}, computed={body_len}"
                            ),
                        ));
                    }
                }
                if let Some(expected_hex) = expected_shapes_json_sha {
                    let expected_lc = expected_hex.to_ascii_lowercase();
                    if computed_hex != expected_lc {
                        return Err(artifact_invalid(
                            "shapes.json",
                            format!(
                            "body sha256 mismatch: manifest={expected_lc}, computed={computed_hex}"
                        ),
                        ));
                    }
                }

                shapes_json_size_bytes = Some(body_len);
                (Some(Arc::new(mm)), Some(computed_hex), Some(actual))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, None, None),
            Err(e) => return Err(ValidationError::Io(IoErr::from(e))),
        };

    Ok(ColorArtifacts {
        color_config,
        route_styles,
        label_anchors,
        shapes_mmap,
        shapes_bin_sha256,
        shapes_json_sha256,
        shapes_json_size_bytes,
    })
}

/// Pre-built `GET /api/<city>/gtfs/manifest` reply for one generation.
///
/// Both fields are derived from `schedule-tiles/manifest.json` at load time so
/// the route never touches disk, re-parses, or re-hashes per request — Node's
/// route is backed by an equivalent cached `ManifestSnapshot`
/// (`packages/backend/src/gtfs/scheduler.ts`).
#[derive(Clone, Debug)]
pub struct GtfsManifestResponse {
    /// The 200 body: the manifest re-emitted the way `JSON.stringify` would.
    pub body: std::sync::Arc<[u8]>,
    /// Quoted strong ETag, byte-identical to Node's.
    pub etag: String,
}

/// What [`load_schedule_tiles`] resolves: the parsed manifest, the tile-body
/// directory, and the pre-built `/gtfs/manifest` reply. All three are `Some`
/// together or `None` together — there is no state where one is available
/// without the others.
pub(crate) type LoadedScheduleTiles = (
    Option<pt_shared::schedule_tile_manifest::ScheduleTileManifest>,
    Option<PathBuf>,
    Option<GtfsManifestResponse>,
);

/// Load `<gen_dir>/schedule-tiles/manifest.json` (if present) and resolve
/// the tile-body directory.
///
/// `expected_sha256`/`expected_bundle_hash` come from the PTB
/// `generation.json`'s `scheduleTileBundleSha256`/`scheduleTileBundleHash`
/// fields (`None` on manifests predating those fields, and on the
/// manifest-less test-only [`Generation::from_paths`] path).
///
/// ## Severity, matching [`load_color_artifacts`]'s per-artifact pattern
///
/// - Exactly one of the two expected fields is `Some`: hard
///   `ValidationError` — the pair is written atomically by the producer
///   (`crates/pt-shared/src/manifest.rs`'s doc on these fields), so one
///   present without the other means the manifest itself is corrupt.
/// - Neither expected field set AND the file is absent: this generation
///   genuinely has no schedule-tile build (older generation, or a producer
///   run with the tile build disabled) — non-error, all three `None`. Same
///   pattern as `color_config`/`shapes.bin` when their manifest SHA fields
///   are `None`.
/// - `expected_bundle_hash` is `Some` but disagrees with `generation_id`:
///   hard `ValidationError`, checked BEFORE touching disk. The tile-body
///   directory is always resolved from `generation_id` (see below) — a
///   `scheduleTileBundleHash` that disagrees with it can never be verified
///   against the directory actually being read, no matter how internally
///   self-consistent the manifest.json on disk is. Catches the case a
///   `manifest.bundle_hash == expected_bundle_hash` check alone would miss:
///   a wrong hash that agrees with itself but not with reality.
/// - Both expected fields `Some` but the file is absent: hard
///   `ValidationError` — an advertised-but-missing artifact means the
///   producer's publish was incomplete, not merely "feature absent".
/// - File present but unparseable: hard `ValidationError` (unchanged from
///   the original implementation) — a malformed artifact means the
///   producer emitted a directory it didn't finish writing correctly.
/// - File present, `expected_sha256` is `Some`: the on-disk bytes' full-file
///   SHA-256 must match, hard `ValidationError` on mismatch — same
///   full-file-integrity check every other sidecar in this file performs.
/// - File present, `expected_bundle_hash` is `Some`: the parsed
///   `manifest.bundle_hash` must equal it, hard `ValidationError` on
///   mismatch. Combined with the `expected_bundle_hash == generation_id`
///   check above, this transitively pins `manifest.bundle_hash ==
///   generation_id` whenever the pointer fields are present — the earlier
///   review gap (a self-consistent-but-wrong pair) closed by checking both
///   links of the chain, not just one.
/// - File present but NEITHER expected field is `Some` (an older manifest
///   schema predating these fields, yet a schedule-tiles dir exists
///   anyway): falls back to the original soft check — `manifest.bundle_hash
///   == generation_id` is only logged on mismatch, not rejected, preserving
///   backward compatibility with pre-field manifests (Postel rule).
///
/// The tile-body directory is always resolved from `generation_id` (the
/// producer names the tiles subdir after it, see
/// `crates/pt-producer/src/schedule_tiles/bundle.rs`), never from the
/// manifest's own `bundleHash` field, even when that field is verified —
/// `generation_id` is the single source of truth for on-disk layout.
pub(crate) fn load_schedule_tiles(
    gen_dir: &Path,
    generation_id: &str,
    expected_sha256: Option<&str>,
    expected_bundle_hash: Option<&str>,
) -> Result<LoadedScheduleTiles, ValidationError> {
    match (expected_sha256, expected_bundle_hash) {
        (Some(_), Some(_)) | (None, None) => {}
        _ => {
            return Err(artifact_invalid(
                "generation.json",
                "scheduleTileBundleSha256 and scheduleTileBundleHash must be set together, or neither"
                    .to_string(),
            ));
        }
    }
    if let Some(expected_hash) = expected_bundle_hash {
        if expected_hash != generation_id {
            return Err(artifact_invalid(
                "generation.json",
                format!(
                    "scheduleTileBundleHash ({expected_hash}) != generationId ({generation_id}) — tiles are always read from generationId's directory, so an advertised hash that disagrees with it can never describe what's actually being served"
                ),
            ));
        }
    }
    let manifest_path = gen_dir.join("schedule-tiles").join("manifest.json");
    let bytes = match std::fs::read(&manifest_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if expected_bundle_hash.is_some() {
                return Err(artifact_invalid(
                    "schedule-tiles/manifest.json",
                    format!(
                        "generation.json advertises a schedule-tile build but {} is missing",
                        manifest_path.display()
                    ),
                ));
            }
            return Ok((None, None, None));
        }
        Err(e) => return Err(ValidationError::Io(IoErr::from(e))),
    };
    // Hoisted out of the `expected_sha256` check below because the `/gtfs/manifest`
    // route's ETag is derived from it too, and that route exists whether or not
    // `generation.json` carries the pointer fields.
    let on_disk_sha256 = sha256_hex(&bytes);
    if let Some(expected) = expected_sha256 {
        if !on_disk_sha256.eq_ignore_ascii_case(expected) {
            return Err(artifact_invalid(
                "schedule-tiles/manifest.json",
                format!("sha256 mismatch: manifest={expected}, on-disk={on_disk_sha256}"),
            ));
        }
    }
    let manifest: pt_shared::schedule_tile_manifest::ScheduleTileManifest =
        serde_json::from_slice(&bytes)
            .map_err(|e| artifact_invalid("schedule-tiles/manifest.json", e.to_string()))?;
    match expected_bundle_hash {
        Some(expected) => {
            if manifest.bundle_hash != expected {
                return Err(artifact_invalid(
                    "schedule-tiles/manifest.json",
                    format!(
                        "bundleHash mismatch: generation.json advertises {expected}, manifest.json has {}",
                        manifest.bundle_hash
                    ),
                ));
            }
        }
        None if manifest.bundle_hash != generation_id => {
            eprintln!(
                "pt-serve: schedule-tiles/manifest.json bundleHash ({}) != generation_id ({generation_id}) in {}",
                manifest.bundle_hash,
                gen_dir.display()
            );
        }
        None => {}
    }
    let tiles_dir = gen_dir.join("schedule-tiles").join(generation_id);
    // Build the `/gtfs/manifest` reply ONCE per generation load, off the request
    // path — same eager-preload pattern as every other artifact on `Generation`
    // (the tile BODIES are the documented exception). The body is a few KiB, so
    // this is not a budget term in `ops/rss_guard.rs`.
    let manifest_response = GtfsManifestResponse {
        // Byte parity with Node's `reply.send(snapshot.parsed)`, which
        // re-serialises rather than echoing the pretty-printed file.
        body: pt_shared::js_json::compact_normalize(&bytes)
            .map_err(|e| artifact_invalid("schedule-tiles/manifest.json", e.to_string()))?
            .into(),
        // Node's ETag is `sha256(file text)` truncated to 32 hex chars, quoted
        // (`gtfs/scheduler.ts` `contentEtag` + `routes/gtfsManifest.ts`). The
        // producer pins `generation.json.scheduleTileBundleSha256` to that same
        // full-file SHA, so the two planes agree by construction.
        etag: format!("\"{}\"", &on_disk_sha256[..32]),
    };
    Ok((Some(manifest), Some(tiles_dir), Some(manifest_response)))
}

/// Boundary-page ETag for the mmaped bundle: sha256 over the head page, the tail page, the total
/// length, and the file mtime (nanos since the UNIX epoch) — never the interior (a whole-file hash
/// would fault every body page and inflate RSS). Faults at most one extra page at startup (the head
/// is touched anyway when the reader parses it). The mtime term makes this an `mtime+size`-grade
/// validator: a rebuilt bundle is a freshly-written file with a newer mtime → a different ETag,
/// which closes the cross-process stale-304 hole on a `--bundle` swap + restart without faulting
/// any body page.
pub(crate) fn boundary_etag(bytes: &[u8], mtime_nanos: u128) -> String {
    use sha2::{Digest, Sha256};
    let len = bytes.len();
    let head = &bytes[..len.min(4096)];
    let tail = &bytes[len.saturating_sub(4096)..];
    let mut hasher = Sha256::new();
    hasher.update(head);
    hasher.update(tail);
    hasher.update((len as u64).to_le_bytes());
    hasher.update(mtime_nanos.to_le_bytes());
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("\"{hex}\"")
}

/// Fields required to construct a `Generation` via the shared builder. Used by
/// both startup ([`crate::bundle::loader`]) and reload
/// ([`crate::reload::runner`]) so the field initialisation lives in one
/// place.
pub struct GenerationParts {
    pub transfers_mmap: Option<Arc<memmap2::Mmap>>,
    pub bundle_mmap: Arc<memmap2::Mmap>,
    pub reader: Reader<MmapBytes>,
    pub index: Index,
    pub transfers: Option<Transfers>,
    pub city_slug: String,
    pub generation_id: String,
    pub bundle_sha256: String,
    pub created_at: String,
    pub feed_start_date: u32,
    pub has_transfers: bool,
    pub bundle_etag: String,
    pub transfers_etag: Option<String>,
    /// Strong ETag for `/route-geometry/fetch`.
    pub route_geometry_etag: Option<String>,
    /// `color-config.json` bytes (loaded by the loader; `None` if absent).
    pub color_config: Option<Arc<[u8]>>,
    /// `route-styles.json` bytes (loaded by the loader; `None` if absent).
    pub route_styles: Option<Arc<[u8]>>,
    /// `label-anchors.json` bytes (loaded by the loader; `None` if absent).
    pub label_anchors: Option<Arc<[u8]>>,
    /// `shapes.bin` mmap (loaded + structurally validated by the loader; `None`
    /// if no shapes sidecar). The lazy `shapes_json` cache is NOT a part — like
    /// the gzip `OnceLock`s, it is initialised empty in [`Generation::new`].
    pub shapes_mmap: Option<Arc<memmap2::Mmap>>,
    /// Lowercase-hex SHA-256 of the canonical shapes JSON body, computed
    /// at load via streaming `shapes_json_sha256`. `None` when no `shapes.bin`.
    pub shapes_json_sha256: Option<String>,
    /// Canonical shapes JSON body length, computed without retaining the body.
    pub shapes_json_size_bytes: Option<u64>,
    /// Strong ETag for the `/shapes` handler: `"<shapes_json_sha256>"`. `None`
    /// when no `shapes.bin` is present.
    pub shapes_json_etag: Option<String>,
    /// `departures-idx.bin` (DPIX) mmap (loaded + validated by the builder;
    /// `None` if absent — degraded, not an error).
    pub departures_idx_mmap: Option<Arc<memmap2::Mmap>>,
    /// Trips-namespace SHA-256 recomputed from the bundle interner at load.
    pub dpix_trips_sha: [u8; 32],
    /// Stops-namespace SHA-256 recomputed from the bundle interner at load.
    pub dpix_stops_sha: [u8; 32],
    /// Resolved city timezone (`Some` iff the IANA resolved + parsed).
    pub city_tz: Option<jiff::tz::TimeZone>,
    /// IANA name behind `city_tz` (empty string when unresolved).
    pub city_tz_iana: String,
    /// Parsed `schedule-tiles/manifest.json`, loaded by
    /// [`load_schedule_tiles`]. `None` when the producer didn't emit one.
    pub schedule_tile_manifest: Option<pt_shared::schedule_tile_manifest::ScheduleTileManifest>,
    /// Tile-body directory resolved by [`load_schedule_tiles`]. `Some` iff
    /// `schedule_tile_manifest` is `Some`.
    pub schedule_tiles_dir: Option<PathBuf>,
    /// Pre-built `/gtfs/manifest` reply from [`load_schedule_tiles`]. `Some` iff
    /// `schedule_tile_manifest` is `Some`.
    pub gtfs_manifest_response: Option<GtfsManifestResponse>,
    /// Optional loaded `address-search.json` sidecar.
    pub address_search: Option<AddressSearchSidecar>,
    pub epoch: u64,
    pub pattern_mode: pt_core::PatternMode,
}

impl Generation {
    /// Assemble a `Generation` from already-validated parts. The reload runner (and the simple
    /// `from_paths` path) calls this AFTER: 1. mmap'ing bundle (and optional transfers) 2.
    /// structural validation 3. metadata validation (reload path; `from_paths` skips) 4.
    /// `Index::build` (the engine pre-swap step) 5. ETag derivation
    ///
    /// Incrementing `mapped_generation_count` is the load-bearing side effect
    /// — paired with the `Drop` decrement so the gauge tracks live instances.
    pub fn new(parts: GenerationParts, metrics: Option<Arc<Metrics>>) -> Self {
        if let Some(m) = metrics.as_ref() {
            m.inc_mapped_generation_count();
        }
        // Derive the all-trips stop->routes membership ONCE per generation load
        // (off the request path), from the reader before it is moved into `Self`.
        let stop_membership = crate::domain::stop_membership::build_stop_membership(&parts.reader);
        // Same idea, for the rows `/scheduled-departures-for-stop` reads: pay the
        // band precompute once per generation instead of re-deriving the
        // addressing on every request. See the field doc for why a failure here
        // degrades to the reader rather than failing the load.
        let stop_time_cursor = match pt_core::stop_time_cursor::StopTimeCursor::new(&parts.reader) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!(
                    "pt-serve: stop-time cursor precompute failed ({e}); \
                         /scheduled-departures-for-stop falls back to per-row band decode"
                );
                None
            }
        };
        // Parse the color-provenance maps ONCE per generation load (off the
        // request path), so the per-request `/stops/nearby` compose never
        // re-parses the ~20k-entry blobs. Shared by the `/stops/all` body build
        // below AND the `/stops/nearby` handler.
        let route_styles_map = crate::app::stops::parse_route_styles(parts.route_styles.as_deref());
        let label_anchors_map =
            crate::app::stops::parse_label_anchors(parts.label_anchors.as_deref());
        // Build the spatial grid ONCE per generation load (off the request
        // path). Insertion order = `0..num_stops()` = the backend `iterStops`
        // order, so the `/stops/nearby` response order matches.
        let spatial_grid = crate::app::stops::build_spatial_grid(&parts.reader);
        let mut gen = Self {
            transit_selection: None,
            transfers_mmap: parts.transfers_mmap,
            bundle_mmap: parts.bundle_mmap,
            reader: parts.reader,
            index: parts.index,
            stop_membership,
            stop_time_cursor,
            transfers: parts.transfers,
            city_slug: parts.city_slug,
            generation_id: parts.generation_id,
            bundle_sha256: parts.bundle_sha256,
            created_at: parts.created_at,
            feed_start_date: parts.feed_start_date,
            has_transfers: parts.has_transfers,
            bundle_etag: parts.bundle_etag,
            bundle_gzip: OnceLock::new(),
            transfers_etag: parts.transfers_etag,
            transfers_gzip: OnceLock::new(),
            route_geometry_etag: parts.route_geometry_etag,
            route_geometry_gzip: OnceLock::new(),
            color_config: parts.color_config,
            route_styles: parts.route_styles,
            label_anchors: parts.label_anchors,
            route_styles_map,
            label_anchors_map,
            spatial_grid,
            // Placeholder — replaced below once the struct exists, because
            // `build_stops_all_body` composes over the assembled reader +
            // membership + the parsed route-styles/label-anchors.
            stops_all_body: Arc::from(Vec::new().into_boxed_slice()),
            shapes_mmap: parts.shapes_mmap,
            shapes_json: OnceLock::new(),
            shapes_json_sha256: parts.shapes_json_sha256,
            shapes_json_size_bytes: parts.shapes_json_size_bytes,
            shapes_json_etag: parts.shapes_json_etag,
            shapes_json_gzip: OnceLock::new(),
            departures_idx_mmap: parts.departures_idx_mmap,
            dpix_trips_sha: parts.dpix_trips_sha,
            dpix_stops_sha: parts.dpix_stops_sha,
            city_tz: parts.city_tz,
            city_tz_iana: parts.city_tz_iana,
            schedule_tile_manifest: parts.schedule_tile_manifest,
            gtfs_manifest_response: parts.gtfs_manifest_response,
            schedule_tiles_dir: parts.schedule_tiles_dir,
            address_search: parts.address_search,
            epoch: parts.epoch,
            pattern_mode: parts.pattern_mode,
            metrics,
        };
        // Assemble + serialize the `/stops/all` body ONCE (memoized for the
        // life of this generation; the handler serves these bytes verbatim).
        gen.stops_all_body = crate::app::stops::build_stops_all_body(&gen);
        gen
    }

    /// Test-only constructor — builds a fresh generation from on-disk
    /// artifacts using the boundary+mtime ETag policy (no manifest). The
    /// production path goes through
    /// [`crate::bundle::handle::build_generation`] which carries the
    /// manifest-validated `bundle_sha256`, `created_at`, `generation_id`,
    /// etc.
    ///
    /// **Not used in production** as of P4. Kept `pub` because integration
    /// tests (a separate crate) wire fixtures through it; gating behind a
    /// `test-utils` feature would force all in-tree tests to enable that
    /// feature. The `from_paths`-built `Generation` is missing the manifest-
    /// derived fields (`bundle_sha256`, `created_at`, `generation_id`),
    /// which surfaces as `null` / empty in `/ready` + `/version` — that's
    /// the test-only signature.
    pub fn from_paths(
        ptb: &Path,
        transfers_path: Option<&Path>,
        city: String,
        pattern_mode: pt_core::PatternMode,
    ) -> Result<Generation, String> {
        // Map the bundle and read its mtime from the SAME fd — pairing bytes with the
        // mtime of a different inode (an atomic-replace racing a second path stat) would
        // recreate the false-304 the mtime term closes.
        let (bundle, bundle_mtime) =
            open_mmap_with_mtime(ptb).map_err(|e| format!("mmap {ptb:?}: {e}"))?;
        let bundle_mmap = bundle.0.clone();
        let bundle_etag = boundary_etag(bundle.as_ref(), bundle_mtime);
        let generation_id = bundle_etag.trim_matches('"').to_string();
        let reader = Reader::from_bytes(bundle.clone()).map_err(|e| format!("reader: {e:?}"))?;
        let feed_start_date = reader.feed_start_date();
        let index = Index::build(&reader, pattern_mode).map_err(|e| format!("index: {e:?}"))?;

        let (transfers, transfers_mmap, transfers_etag) = match transfers_path {
            Some(p) => {
                let tb = open_mmap(p).map_err(|e| format!("mmap {p:?}: {e}"))?;
                let mm = tb.0.clone();
                let t =
                    Transfers::from_bytes(tb.clone()).map_err(|e| format!("transfers: {e:?}"))?;
                // Full-content sha256 hex — byte-parity with Node's transfersStore.
                let etag = format!("\"{}\"", sha256_hex(tb.as_ref()));
                (Some(t), Some(mm), Some(etag))
            }
            None => (None, None, None),
        };
        let has_transfers = transfers.is_some();

        // Stage-C color artifacts live in the same generation dir as bundle.ptb.
        // `from_paths` has no manifest, so we pass `None` for all expected SHAs
        // (skips the full-file + body-hash checks) — but the shapes.bin structural
        // parse + interner cross-check still run, so a corrupt shapes.bin or
        // cross-namespace sidecar is rejected here too.
        let gen_dir = ptb.parent().unwrap_or_else(|| Path::new("."));
        let (trips_sha, stops_sha) = crate::bundle::integrity::bundle_namespace_shas(&reader)
            .map_err(|e| format!("interner: {e}"))?;
        let artifacts = load_color_artifacts(
            gen_dir, None, None, None, None, &trips_sha, &stops_sha, None, None, true,
        )
        .map_err(|e| format!("color artifacts: {e}"))?;
        let shapes_json_etag = artifacts
            .shapes_json_sha256
            .as_ref()
            .map(|s| format!("\"{s}\""));
        let route_geometry_etag = artifacts
            .shapes_bin_sha256
            .as_ref()
            .map(|s| format!("\"{s}\""));
        // `from_paths` has no manifest, so no advertised SHA/hash to verify
        // against (mirrors the `None, None, None, None` pattern the color
        // artifacts call above uses).
        let (schedule_tile_manifest, schedule_tiles_dir, gtfs_manifest_response) =
            load_schedule_tiles(gen_dir, &generation_id, None, None)
                .map_err(|e| format!("schedule tiles: {e}"))?;
        let address_search = load_address_search_artifact(gen_dir, &city, &generation_id)
            .map_err(|e| format!("address search: {e}"))?;

        Ok(Generation::new(
            GenerationParts {
                transfers_mmap,
                bundle_mmap,
                reader,
                index,
                transfers,
                city_slug: city,
                generation_id,

                bundle_sha256: String::new(),
                created_at: String::new(),
                feed_start_date,
                has_transfers,
                bundle_etag,
                transfers_etag,
                route_geometry_etag,
                color_config: artifacts.color_config,
                route_styles: artifacts.route_styles,
                label_anchors: artifacts.label_anchors,
                shapes_mmap: artifacts.shapes_mmap,
                shapes_json_sha256: artifacts.shapes_json_sha256,
                shapes_json_size_bytes: artifacts.shapes_json_size_bytes,
                shapes_json_etag,
                // `from_paths` has no manifest and does not load the DPIX
                // sidecar / resolve the city tz — those are production
                // (`build_generation`) concerns. Default them.
                departures_idx_mmap: None,
                dpix_trips_sha: [0u8; 32],
                dpix_stops_sha: [0u8; 32],
                city_tz: None,
                city_tz_iana: String::new(),
                schedule_tile_manifest,
                schedule_tiles_dir,
                gtfs_manifest_response,
                address_search,
                // Single-generation P3 baseline; the reload runner increments per generation.
                epoch: 0,
                pattern_mode,
            },
            None,
        ))
    }

    /// Access the raw bundle bytes — used by the byte handlers' streaming
    /// response builder. The bundle map is kept private; this view goes through
    /// the `MmapBytes` newtype because that is what `pt_core::Reader` requires.
    pub fn bundle_bytes(&self) -> MmapBytes {
        MmapBytes(self.bundle_mmap.clone())
    }

    /// Access the raw transfers bytes (if loaded). `None` when no transfers
    /// artifact was supplied at startup.
    pub fn transfers_bytes(&self) -> Option<MmapBytes> {
        self.transfers_mmap.as_ref().map(|m| MmapBytes(m.clone()))
    }

    /// Access the validated SHPB bytes used by native route geometry.
    pub fn route_geometry_bytes(&self) -> Option<MmapBytes> {
        self.shapes_mmap.as_ref().map(|m| MmapBytes(m.clone()))
    }

    /// Canonical shapes JSON (lazy, cached). `None` if no shapes sidecar is
    /// loaded. The serialization is byte-identical to the producer's recorded
    /// `shapesJsonSha256` (both go through `pt_shared::sidecar::shapes_json_bytes`).
    pub fn shapes_json_bytes(&self) -> Option<Arc<[u8]>> {
        let mm = self.shapes_mmap.as_ref()?;
        Some(
            self.shapes_json
                .get_or_init(|| {
                    // Sound because shapes.bin was fully validated at load:
                    // `load_color_artifacts` parses the header + ShapesBin and
                    // hard-rejects any structural defect before this mmap is
                    // retained. Additionally, the interner cross-check (X4) in
                    // `load_color_artifacts` re-parsed the sidecar with the
                    // BUNDLE's recomputed SHAs — a sidecar whose namespace SHAs
                    // disagreed with the bundle was rejected then. The lazy
                    // re-parse here uses the HEADER's own SHAs (not the
                    // bundle's recomputed SHAs) and is guaranteed to succeed
                    // because the X4 cross-check already confirmed the header
                    // SHAs match the bundle's namespace.
                    let bytes: &[u8] = &mm[..];
                    let hdr = pt_shared::sidecar::parse_sidecar_header(
                        bytes,
                        pt_shared::sidecar::SHAPES_MAGIC,
                    )
                    .expect("shapes.bin validated at load");
                    let sb = pt_shared::sidecar::ShapesBin::parse(
                        bytes,
                        &hdr.trips_intern_sha256,
                        &hdr.stops_intern_sha256,
                    )
                    .expect("shapes.bin validated at load");
                    Arc::from(pt_shared::sidecar::shapes_json_bytes(&sb).into_boxed_slice())
                })
                .clone(),
        )
    }

    /// Size of the mapped `bundle.ptb` in bytes. Cheap — just an `Arc::len` call on the mmap.
    pub fn payload_bytes_len(&self) -> u64 {
        self.bundle_mmap.len() as u64
    }

    /// Size of the mapped `transfers.bin` in bytes, or 0 when no transfers artifact is loaded.
    pub fn transfers_bytes_len(&self) -> u64 {
        self.transfers_mmap
            .as_ref()
            .map(|m| m.len() as u64)
            .unwrap_or(0)
    }

    /// Size of the mapped route-geometry artifact, or zero when absent.
    pub fn route_geometry_bytes_len(&self) -> u64 {
        self.shapes_mmap.as_ref().map_or(0, |m| m.len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::{load_address_search_artifact, load_schedule_tiles};

    const MANIFEST_JSON: &str =
        r#"{"schemaVersion":1,"bundleHash":"deadbeef","generatedAt":1,"tileSize":6000}"#;
    /// A one-row packed corpus, built through the same `pack` the producer's
    /// `pack-address-search` calls.
    fn packed_address_corpus(city: Option<&str>) -> Vec<u8> {
        pt_geocode::AddrIndex::pack(
            &[pt_geocode::AddrRow {
                label: "V. Kudirkos aikštė 1".to_string(),
                lat: 54.6872,
                lon: 25.2797,
            }],
            &[pt_geocode::AddrKey {
                key: "kudirk aikste".to_string(),
                row_id: 0,
            }],
            &pt_geocode::ArtifactMeta {
                city_id: city.map(str::to_string),
                source: Some("test".to_string()),
                generated_at: "2026-08-15T00:00:00.000Z".to_string(),
            },
        )
        .expect("pack test corpus")
    }

    fn write_manifest(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        let st_dir = dir.join("schedule-tiles");
        std::fs::create_dir_all(&st_dir).unwrap();
        std::fs::write(st_dir.join("manifest.json"), body).unwrap();
        st_dir
    }

    fn sha256_of(body: &str) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(body.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn absent_address_search_sidecar_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sidecar = load_address_search_artifact(dir.path(), "vilnius", "gen-1")
            .expect("absent address-search.fst is optional");
        assert!(sidecar.is_none());
    }

    #[test]
    fn address_search_sidecar_builds_manifest_and_index() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("address-search.fst"),
            packed_address_corpus(Some("vilnius")),
        )
        .unwrap();

        let sidecar = load_address_search_artifact(dir.path(), "vilnius", "gen-1")
            .expect("valid address-search.fst loads")
            .expect("sidecar present");
        assert_eq!(sidecar.row_count, 1);
        assert_eq!(sidecar.key_count, 1);
        assert_eq!(
            sidecar.index.prefix_search("kudirk aikste", 1)[0].label,
            "V. Kudirkos aikštė 1"
        );

        let manifest: serde_json::Value =
            serde_json::from_slice(&sidecar.manifest_body).expect("manifest json");
        assert_eq!(manifest["schemaVersion"], 1);
        assert_eq!(manifest["cityId"], "vilnius");
        assert_eq!(
            manifest["artifactUrl"],
            "/api/vilnius/address-search/bundle"
        );
        assert_eq!(manifest["bundleGenerationId"], "gen-1");
        assert_eq!(manifest["source"], "test");
        assert_eq!(manifest["generatedAt"], "2026-08-15T00:00:00.000Z");
    }

    #[test]
    fn address_corpus_built_for_another_city_is_rejected() {
        // Serving a Gdansk corpus under /api/vilnius/ would answer Vilnius
        // queries with Gdansk streets. The slug in the file wins over the path.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("address-search.fst"),
            packed_address_corpus(Some("gdansk")),
        )
        .unwrap();

        let Err(err) = load_address_search_artifact(dir.path(), "vilnius", "gen-1") else {
            panic!("cityId mismatch must fail the generation load");
        };
        assert!(format!("{err:?}").contains("gdansk"), "{err:?}");
    }

    #[test]
    fn schema_v1_json_left_in_a_generation_is_not_silently_ignored() {
        // The v1 filename is gone, so a stale JSON corpus is simply absent —
        // address search 404s rather than serving something half-understood.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("address-search.json"),
            b"{\"schemaVersion\":1}",
        )
        .unwrap();
        assert!(load_address_search_artifact(dir.path(), "vilnius", "gen-1")
            .expect("v1 file is simply not the artifact we look for")
            .is_none());
    }

    #[test]
    fn corrupt_packed_corpus_fails_the_generation_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut bytes = packed_address_corpus(Some("vilnius"));
        bytes[4..6].copy_from_slice(&99u16.to_le_bytes()); // schema version
        std::fs::write(dir.path().join("address-search.fst"), bytes).unwrap();

        assert!(
            load_address_search_artifact(dir.path(), "vilnius", "gen-1").is_err(),
            "an unreadable corpus must not load as an empty geocoder",
        );
    }

    #[test]
    fn absent_schedule_tiles_dir_is_none_not_error_when_unadvertised() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (manifest, tiles_dir, _manifest_response) =
            load_schedule_tiles(dir.path(), "deadbeef", None, None)
                .expect("absent dir is not an error when generation.json advertised nothing");
        assert!(manifest.is_none());
        assert!(tiles_dir.is_none());
    }

    #[test]
    fn absent_but_advertised_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        // generation.json advertises a build (Some sha/hash) but nothing is
        // on disk — an incomplete publish, not "feature absent".
        let err =
            load_schedule_tiles(dir.path(), "deadbeef", Some("aa"), Some("deadbeef")).unwrap_err();
        assert!(err.to_string().contains("advertises"), "{err}");
    }

    #[test]
    fn present_manifest_resolves_tiles_dir_from_generation_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let st_dir = write_manifest(dir.path(), MANIFEST_JSON);
        let (manifest, tiles_dir, _manifest_response) =
            load_schedule_tiles(dir.path(), "deadbeef", None, None).expect("valid manifest parses");
        assert_eq!(manifest.unwrap().bundle_hash, "deadbeef");
        assert_eq!(tiles_dir.unwrap(), st_dir.join("deadbeef"));
    }

    #[test]
    fn unadvertised_hash_mismatch_is_logged_not_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let st_dir = write_manifest(
            dir.path(),
            r#"{"schemaVersion":1,"bundleHash":"stale-hash","generatedAt":1,"tileSize":6000}"#,
        );
        // No expected_bundle_hash (pre-field manifest) — falls back to the
        // soft log-only check; the dir is still resolved from the
        // authoritative generation_id, not the (possibly stale) field.
        let (manifest, tiles_dir, _manifest_response) =
            load_schedule_tiles(dir.path(), "real-gen-id", None, None)
                .expect("unadvertised mismatch is not an error");
        assert_eq!(manifest.unwrap().bundle_hash, "stale-hash");
        assert_eq!(tiles_dir.unwrap(), st_dir.join("real-gen-id"));
    }

    #[test]
    fn advertised_hash_mismatch_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body =
            r#"{"schemaVersion":1,"bundleHash":"stale-hash","generatedAt":1,"tileSize":6000}"#;
        write_manifest(dir.path(), body);
        // expected_bundle_hash ("deadbeef") matches generation_id (passes
        // the early check), but manifest.json's own bundleHash is
        // "stale-hash" — the deep manifest-vs-pointer check must still
        // reject, not log-and-continue.
        let err = load_schedule_tiles(
            dir.path(),
            "deadbeef",
            Some(&sha256_of(body)),
            Some("deadbeef"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("bundleHash mismatch"), "{err}");
    }

    /// The gap the code review flagged: a `scheduleTileBundleHash` that
    /// matches `manifest.json`'s own `bundleHash` (internally
    /// self-consistent) but disagrees with the REAL `generation_id` must
    /// still reject — tiles are always read from `generation_id`'s
    /// directory, so a self-consistent-but-wrong pair would otherwise pass
    /// verification while describing a directory nothing actually reads
    /// from.
    #[test]
    fn advertised_hash_matching_manifest_but_not_generation_id_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = r#"{"schemaVersion":1,"bundleHash":"wrong-but-consistent","generatedAt":1,"tileSize":6000}"#;
        write_manifest(dir.path(), body);
        let err = load_schedule_tiles(
            dir.path(),
            "real-gen-id",
            Some(&sha256_of(body)),
            Some("wrong-but-consistent"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("generationId"), "{err}");
    }

    #[test]
    fn advertised_sha256_mismatch_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_manifest(dir.path(), MANIFEST_JSON);
        let err = load_schedule_tiles(
            dir.path(),
            "deadbeef",
            Some(&"a".repeat(64)),
            Some("deadbeef"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("sha256 mismatch"), "{err}");
    }

    #[test]
    fn advertised_matching_sha256_and_hash_succeed() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_manifest(dir.path(), MANIFEST_JSON);
        let (manifest, tiles_dir, _manifest_response) = load_schedule_tiles(
            dir.path(),
            "deadbeef",
            Some(&sha256_of(MANIFEST_JSON)),
            Some("deadbeef"),
        )
        .expect("matching advertised sha256+hash succeed");
        assert_eq!(manifest.unwrap().bundle_hash, "deadbeef");
        assert!(tiles_dir.is_some());
    }

    #[test]
    fn sha256_alone_without_bundle_hash_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_manifest(dir.path(), MANIFEST_JSON);
        let err = load_schedule_tiles(
            dir.path(),
            "deadbeef",
            Some(&sha256_of(MANIFEST_JSON)),
            None,
        )
        .unwrap_err();
        assert!(err.to_string().contains("together"), "{err}");
    }

    #[test]
    fn bundle_hash_alone_without_sha256_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_manifest(dir.path(), MANIFEST_JSON);
        let err = load_schedule_tiles(dir.path(), "deadbeef", None, Some("deadbeef")).unwrap_err();
        assert!(err.to_string().contains("together"), "{err}");
    }

    #[test]
    fn malformed_manifest_is_a_hard_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let st_dir = dir.path().join("schedule-tiles");
        std::fs::create_dir_all(&st_dir).unwrap();
        std::fs::write(st_dir.join("manifest.json"), b"not json").unwrap();
        let err = load_schedule_tiles(dir.path(), "deadbeef", None, None).unwrap_err();
        assert!(err.to_string().contains("schedule-tiles/manifest.json"));
    }
}
