//! Shared `Generation` builder — the validation + assembly pipeline used by
//! both startup ([`crate::bundle::loader::load_initial`]) and the reload
//! runner ([`crate::reload::runner::ReloadRunner`]).
//!
//! ## Why a shared builder
//!
//! every adoption (initial, fallback, reload) runs the FULL validation surface. Two code paths
//! constructing `Generation` would inevitably drift — the reload runner has the strictest plumbing
//! (Index::build pre-swap, last-good pre-swap, epoch bump), and the startup path should reuse that
//! flow with `is_startup=true` rather than re-derive it.
//!
//! ## Reload order (code-order)
//!
//! 1. read pointer (caller responsibility — the loader/runner does this)
//! 2. re-read target generation.json
//! 3. file-size precheck (the cheap precheck that catches torn writes)
//! 4. mmap bundle (and optional transfers)
//! 5. structural validation (pt-core, no_std)
//! 6. metadata validation (pt-shared, std+serde — manifest cross-checks)
//! 7. `Index::build` (NEW pre-swap step — engine derivation that can fail
//!    with `ValidationError::Engine`)
//! 8. warm via `madvise(MADV_WILLNEED)` + page-touch (NO public-route query)
//! 9. write `last-good.json` PRE-SWAP (NEW ordering)
//! 10. `ArcSwap::store(new)` + bump `Generation::epoch`
//! 11. retire old (Drop fires when refcount → 0)
//!
//! This builder owns steps 4-8. Step 9 is a caller responsibility (write the
//! pointer BEFORE the swap; the runner does this). The startup path skips
//! the last-good write — its job is to ADOPT a generation, not republish.

use crate::bundle::generation::{Generation, GenerationParts};
use crate::mmap::MmapBytes;
use crate::ops::config::LogFormat;
use crate::ops::log::{log_event, Level};
use crate::ops::Metrics;
use pt_core::{Index, Reader, Transfers};
use pt_shared::clock::Clock;
use pt_shared::manifest::GenerationManifest;
use pt_shared::validate::errors::{EngineBuildError, IoErr, ValidationError};
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

/// Per-phase timing for the generation build.
///
/// Before this existed, everything between the `sentinel_verify_ok` and
/// `rss_guard_accept` log lines was a single silent stretch. On a real paris
/// generation that gap ran ~66 minutes with no output whatsoever, which is
/// indistinguishable from a hang — the generation was loading correctly the
/// whole time and an incident went into guessing which of a dozen steps was
/// running. Every completed phase now emits one line, so the answer is in the
/// log instead of in a debugger.
///
/// `format: None` disables emission entirely. That is the path tests and the
/// [`build_generation`] compatibility wrapper take: they have no operator log
/// format to route through, and a builder that printed to stderr from unit
/// tests would be a nuisance rather than a diagnostic.
struct PhaseLog {
    format: Option<LogFormat>,
    start: Instant,
    mark: Instant,
}

impl PhaseLog {
    fn new(format: Option<LogFormat>) -> Self {
        let now = Instant::now();
        Self {
            format,
            start: now,
            mark: now,
        }
    }

    /// Close out a phase and restart the per-phase clock.
    ///
    /// `phaseMs` is this phase alone; `elapsedMs` is cumulative since the build
    /// started, so a single line tells you both "what is slow" and "how far in
    /// are we" without subtracting timestamps by hand. The clock advances even
    /// when emission is disabled, so enabling it never changes the phase
    /// boundaries being measured.
    fn done(&mut self, phase: &str, extra: &[(&str, &str)]) {
        let now = Instant::now();
        if let Some(format) = self.format {
            let phase_ms = now.duration_since(self.mark).as_millis().to_string();
            let elapsed_ms = now.duration_since(self.start).as_millis().to_string();
            let mut fields: Vec<(&str, &str)> = Vec::with_capacity(3 + extra.len());
            fields.push(("phase", phase));
            fields.push(("phaseMs", &phase_ms));
            fields.push(("elapsedMs", &elapsed_ms));
            fields.extend_from_slice(extra);
            log_event(format, Level::Info, "generation_load_phase", &fields);
        }
        self.mark = now;
    }

    fn total_ms(&self) -> u128 {
        self.start.elapsed().as_millis()
    }
}

/// Inputs to the shared builder. The caller has already resolved the
/// bundle/transfers paths from the pointer + generation manifest.
pub struct BuildInputs<'a> {
    /// Already-parsed generation manifest (deserialized by the loader/runner).
    pub manifest: &'a GenerationManifest,
    /// Resolved on-disk path to `bundle.ptb`. Must exist; the builder mmaps it.
    pub bundle_path: &'a Path,
    /// Resolved on-disk path to `transfers.bin`. `Some` iff
    /// `manifest.has_transfers`.
    pub transfers_path: Option<&'a Path>,
    /// `--city` slug from the operator config. Cross-checked against
    /// `manifest.city_slug` in `validate_metadata`.
    pub expected_city: &'a str,
    /// Wall-clock source — `validate_metadata` reads it for createdAt skew.
    pub clock: &'a dyn Clock,
    /// `true` for the initial load, `false` for hot-reload. Selects the
    /// (wider/tighter) createdAt skew tolerance in `validate_metadata`.
    pub is_startup: bool,
    /// Operator-supplied fallback for v1 manifests that lack `cityTzIana`. `None` is acceptable on
    /// greenfield deploys where the producer publishes v2 from the start; on a brownfield deploy
    /// with retained v1 generations it MUST be `Some(...)` or the cross-check returns
    /// `OperatorError::TzIanaUnresolved`.
    pub city_tz_iana_default: Option<&'a str>,
    /// Epoch to stamp on the new generation. Startup uses `0`; the reload
    /// runner allocates from a monotonic counter.
    pub epoch: u64,
    /// Optional metrics handle. Plumbed into the Generation so its Drop can decrement
    /// `mapped_generation_count`.
    pub metrics: Option<Arc<Metrics>>,
    /// RAPTOR pattern-grouping mode passed to `Index::build`. Sourced from
    /// `ServerConfig.pattern_mode` at every production caller; tests pass `Off`.
    pub pattern_mode: pt_core::PatternMode,
}

/// Build a fully-validated `Generation` from on-disk artifacts.
///
/// Steps 4-8 of the reload sequence (see module docs). Returns a typed
/// [`ValidationError`] so the runner can label `reload_total{cause=...}`
/// and tests can assert on the exact class without string matching.
pub fn build_generation(inputs: BuildInputs<'_>) -> Result<Generation, ValidationError> {
    build_generation_with_page_warm(inputs, true, None)
}

/// Build a generation with an explicit mmap page-warming policy.
///
/// Production startup and reload use this entry point so constrained-host
/// configuration can disable speculative page-in. The compatibility wrapper
/// above retains the historical warm behavior for existing callers and tests.
///
/// `log_format` is `Some(..)` on the three production callers (initial load,
/// forced-current load, reload) and `None` everywhere else; it enables the
/// per-phase `generation_load_phase` timing lines described on [`PhaseLog`].
pub fn build_generation_with_page_warm(
    inputs: BuildInputs<'_>,
    page_warm_enabled: bool,
    log_format: Option<LogFormat>,
) -> Result<Generation, ValidationError> {
    build_generation_with_geometry(inputs, page_warm_enabled, log_format, true)
}

/// Build a generation with explicit geometry and page-warming policies.
/// Disabling geometry leaves publisher metadata intact and never opens shapes.
pub fn build_generation_with_geometry(
    inputs: BuildInputs<'_>,
    page_warm_enabled: bool,
    log_format: Option<LogFormat>,
    geometry_enabled: bool,
) -> Result<Generation, ValidationError> {
    build_generation_with_policy(
        inputs,
        page_warm_enabled,
        log_format,
        geometry_enabled,
        true,
    )
}

pub(crate) fn build_generation_with_policy(
    inputs: BuildInputs<'_>,
    page_warm_enabled: bool,
    log_format: Option<LogFormat>,
    geometry_enabled: bool,
    legacy_extras_enabled: bool,
) -> Result<Generation, ValidationError> {
    let mut phases = PhaseLog::new(log_format);

    // ---- Step 4: mmap bundle ----
    // SAFETY: read-only map backed by a static PTB artifact. The process does
    // not write the file. External modification during the map's lifetime is
    // UB per the memmap2 contract and is an operator responsibility (atomic-
    // replace + restart is the expected update path).
    let bundle_file =
        File::open(inputs.bundle_path).map_err(|e| ValidationError::Io(IoErr::from(e)))?;
    let bundle_mmap = unsafe { memmap2::Mmap::map(&bundle_file) }
        .map_err(|e| ValidationError::Io(IoErr::from(e)))?;
    let bundle_arc: Arc<memmap2::Mmap> = Arc::new(bundle_mmap);
    let bundle_bytes_view = MmapBytes(bundle_arc.clone());

    // Optional transfers mmap. We resolve mid-pipeline because the metadata
    // validator needs the bytes to compute the SHA-256 cross-check.
    let (transfers_arc, transfers_bytes_view): (Option<Arc<memmap2::Mmap>>, Option<MmapBytes>) =
        match inputs.transfers_path {
            Some(p) => {
                let f = File::open(p).map_err(|e| ValidationError::Io(IoErr::from(e)))?;
                let mm = unsafe { memmap2::Mmap::map(&f) }
                    .map_err(|e| ValidationError::Io(IoErr::from(e)))?;
                let arc = Arc::new(mm);
                (Some(arc.clone()), Some(MmapBytes(arc)))
            }
            None => (None, None),
        };
    phases.done(
        "mmap",
        &[
            ("bundleBytes", &bundle_arc.len().to_string()),
            (
                "transfersBytes",
                &transfers_arc
                    .as_ref()
                    .map(|t| t.len().to_string())
                    .unwrap_or_else(|| "0".to_string()),
            ),
        ],
    );

    // ---- Step 5: structural validation (pt-core, no_std) ----
    let bundle_slice: &[u8] = bundle_arc.as_ref();
    pt_core::validate::structural::validate_structural(bundle_slice)?;
    phases.done("validate_structural", &[]);

    // Construct the Reader (its own quick header parse) so we can extract
    // `feed_start_date` for the manifest cross-check. Reader::from_bytes
    // failures surface as `StructuralError` via the `?` (StructuralError is
    // From<PtbError> through pt-core's validate::structural::from_ptb_error
    // helper; we map manually here to preserve the typed taxonomy).
    let reader = Reader::from_bytes(bundle_bytes_view.clone()).map_err(|e| {
        ValidationError::Structural(pt_core::validate::structural::from_ptb_error(e))
    })?;
    let feed_start_date = reader.feed_start_date();
    phases.done(
        "reader_init",
        &[
            ("ptbVersion", &reader.header().version.to_string()),
            ("numStops", &reader.num_stops().to_string()),
            ("numRoutes", &reader.num_routes().to_string()),
            ("numTrips", &reader.num_trips().to_string()),
        ],
    );

    // ---- Step 6: metadata validation (pt-shared, std + serde) ----
    // Hashes the whole bundle (and transfers) for the manifest SHA cross-check,
    // so this phase scales with file size, not entity count.
    let transfers_slice: Option<&[u8]> = transfers_arc.as_ref().map(|t| t.as_ref().as_ref());
    pt_shared::validate::metadata::validate_metadata_with_clock(
        inputs.manifest,
        bundle_slice,
        transfers_slice,
        inputs.expected_city,
        feed_start_date,
        inputs.clock,
        inputs.is_startup,
    )?;
    phases.done("validate_metadata", &[]);

    // ---- T13 wiring: city-tz cross-check ----
    //
    // Validate that the PTB header's city_tz_offset_seconds agrees with the
    // bundled tzdb's computed offset for the manifest's cityTzIana at
    // feed_start_date. Catches: (a) a broken producer that wrote zeros to
    // [28..32], (b) a misconfigured operator pairing an IANA name to a bundle
    // that disagrees, (c) cities legitimately at UTC+0 where both sides report
    // 0 round-trip cleanly.
    //
    // The resolved IANA (and its parsed Jiff `TimeZone`) are ALSO threaded onto
    // the Generation for the C2c loopback handler. An unparseable IANA leaves
    // `city_tz = None`: the loopback handler returns 503, NOT a hard load
    // failure (the bundle must still serve `/plan`).
    let manifest_iana = inputs
        .manifest
        .city_tz_iana
        .as_deref()
        .or(inputs.city_tz_iana_default);
    let iana = manifest_iana.ok_or_else(|| {
        ValidationError::Operator(
            pt_shared::validate::errors::OperatorError::TzIanaUnresolved {
                city: inputs.expected_city.to_string(),
            },
        )
    })?;
    // Delegate to the shared helper — pt_shared::tz::offset_at_anchor is the
    // single source of truth for this computation; the producer also calls it
    // via resolve_city_tz_offset, so both sides are structurally coupled.
    let ymd = reader.header().feed_start_date;
    let expected_secs = pt_shared::tz::offset_at_anchor(iana, ymd).map_err(|e| match e {
        pt_shared::tz::TzOffsetError::UnknownIana => {
            ValidationError::Producer(pt_shared::validate::errors::ProducerError::UnknownIana {
                iana: iana.to_string(),
            })
        }
        pt_shared::tz::TzOffsetError::BadDate => ValidationError::Producer(
            pt_shared::validate::errors::ProducerError::FeedStartDateMismatch {
                manifest: inputs.manifest.feed_start_date,
                bundle: ymd,
            },
        ),
    })?;
    let found_secs = reader.header().city_tz_offset_seconds;
    if found_secs != expected_secs {
        return Err(ValidationError::Producer(
            pt_shared::validate::errors::ProducerError::TzOffsetMismatch {
                iana: iana.to_string(),
                ymd,
                found_secs,
                expected_secs,
            },
        ));
    }
    // Reuse the already-validated `iana`. `offset_at_anchor` succeeded above
    // (it round-tripped through the same bundled tzdb), so resolution here
    // resolves the same name; `.ok()` keeps an unexpected parse failure
    // non-fatal — it just leaves `city_tz = None` (loopback returns 503),
    // never blocking `/plan`.
    let city_tz_iana = iana.to_string();
    let city_tz = pt_shared::tz::resolve_time_zone(iana).ok();
    phases.done("tz_cross_check", &[]);

    // ---- Step 7: Index::build (engine pre-swap step) ----
    // Historically the long pole by a wide margin, and the phase an operator
    // most needs named: it is the one that scales with trips x stops rather
    // than with bytes, and the one whose cost depends on `pattern_mode`.
    let index = Index::build(&reader, inputs.pattern_mode).map_err(|e| {
        // Engine-class — derivation rejected a bundle that passed structural.
        ValidationError::Engine(EngineBuildError {
            reason: format!("{e:?}"),
        })
    })?;
    phases.done(
        "index_build",
        &[("patternMode", &format!("{:?}", inputs.pattern_mode))],
    );

    // ---- Optional: Transfers footpath table ----
    let transfers = match transfers_bytes_view.as_ref() {
        Some(b) => Some(Transfers::from_bytes(b.clone()).map_err(|_e| {
            // TransfersError is a wire-decode error on the PTFT bytes;
            // surface as Structural::PtntBoundsExceeded so the cause label
            // is "structural" (single source of truth — the structural-class
            // taxonomy already has a transfer-artifact bucket).
            ValidationError::Structural(
                pt_core::validate::errors::StructuralError::PtntBoundsExceeded,
            )
        })?),
        None => None,
    };
    phases.done("transfers", &[]);

    // ---- Stage-C: color provenance artifacts (color-config.json,
    // route-styles.json, shapes.bin) ----
    //
    // The artifacts live in the SAME generation dir as bundle.ptb. Each artifact's
    // full-file SHA is checked against the manifest. shapes.bin is additionally
    // mmapped, structurally validated, interner-cross-checked (X4: parse with the
    // BUNDLE's recomputed SHAs — a foreign sidecar is a hard ValidationError),
    // and body-hash-verified against manifest.shapes_json_sha256 (the hash the
    // frontend hard-fails on — streaming, no Vec materialisation).
    let gen_dir = inputs
        .bundle_path
        .parent()
        .unwrap_or_else(|| Path::new("."));
    // Iterates the Reader's Trips + Stops interners in record order, so this is
    // entity-count work, not a constant — worth its own phase rather than being
    // folded into the artifact load it feeds.
    let (recomputed_trips_sha, recomputed_stops_sha) =
        crate::bundle::integrity::bundle_namespace_shas(&reader)?;
    phases.done("namespace_shas", &[]);
    let artifacts = crate::bundle::generation::load_color_artifacts(
        gen_dir,
        inputs.manifest.color_config_sha256.as_deref(),
        inputs.manifest.route_styles_sha256.as_deref(),
        inputs.manifest.label_anchors_sha256.as_deref(),
        inputs.manifest.shapes_bin_sha256.as_deref(),
        &recomputed_trips_sha,
        &recomputed_stops_sha,
        inputs.manifest.shapes_json_sha256.as_deref(),
        inputs.manifest.shapes_json_size_bytes,
        geometry_enabled,
    )?;
    phases.done(
        "color_artifacts",
        &[(
            "shapesBinPresent",
            if artifacts.shapes_mmap.is_some() {
                "true"
            } else {
                "false"
            },
        )],
    );

    // ---- Stage-C C2c: departures-idx.bin (DPIX) sidecar ----
    //
    // Reuse the bundle's Trips/Stops interner SHAs recomputed above for the
    // color-artifact (X4) cross-check — `bundle_namespace_shas` is the single
    // canonical helper (it iterates the Reader in RECORD ORDER == the producer's
    // sorted finalize order). We mmap the DPIX sidecar alongside `bundle.ptb`.
    // Unlike the color artifacts, a PRESENT-but-inconsistent DPIX is a HARD load
    // error (namespace-SHA mismatch / truncation / bad magic / malformed CSR all
    // mean producer-side corruption — same severity as a corrupt PTB). An ABSENT
    // DPIX is degraded (`None`), never an error — older generations didn't emit
    // it. The recomputed SHAs are stored on the Generation regardless (the C2c
    // loopback handler re-asserts them per request via
    // `DeparturesIdx::parse_unchecked`).
    let dpix_trips_sha = recomputed_trips_sha;
    let dpix_stops_sha = recomputed_stops_sha;

    let dpix_path = gen_dir.join("departures-idx.bin");
    let departures_idx_mmap: Option<Arc<memmap2::Mmap>> = match File::open(&dpix_path) {
        Ok(f) => {
            let mm = unsafe { memmap2::Mmap::map(&f) }
                .map_err(|e| ValidationError::Io(IoErr::from(e)))?;
            let bytes: &[u8] = &mm[..];
            // (1) Full-file SHA check — when the manifest recorded a
            // `departuresIdxSha256`, verify the on-disk bytes match BEFORE
            // parsing. Mirrors the full-file SHA gates on the color artifacts
            // in `load_color_artifacts`. Older manifests (no field → `None`)
            // skip this check; the namespace-SHA parse below still runs.
            if let Some(expected) = inputs.manifest.departures_idx_sha256.as_deref() {
                use sha2::{Digest, Sha256};
                let actual: String = Sha256::digest(bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                if !actual.eq_ignore_ascii_case(expected) {
                    return Err(ValidationError::Producer(
                        pt_shared::validate::errors::ProducerError::DeparturesIdxInvalid {
                            reason: format!(
                                "full-file SHA mismatch: manifest={expected}, on-disk={actual}"
                            ),
                        },
                    ));
                }
            }
            // (2) Validate ONCE at load: header magic + length + CSR
            // monotonicity + the non-optional namespace-SHA cross-check
            // against the recomputed bundle SHAs. Any defect REJECTS the
            // generation.
            pt_shared::sidecar::DeparturesIdx::parse(bytes, &dpix_trips_sha, &dpix_stops_sha)
                .map_err(|e| {
                    ValidationError::Producer(
                        pt_shared::validate::errors::ProducerError::DeparturesIdxInvalid {
                            reason: e.to_string(),
                        },
                    )
                })?;
            Some(Arc::new(mm))
        }
        // Absent → degraded; the loopback handler returns 503. Mirrors the
        // shapes.bin absent-sidecar handling in `load_color_artifacts`.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(ValidationError::Io(IoErr::from(e))),
    };
    phases.done(
        "departures_idx",
        &[(
            "present",
            if departures_idx_mmap.is_some() {
                "true"
            } else {
                "false"
            },
        )],
    );

    // ---- Step 8: warm pages (best-effort; no public route query) ----
    // Pass the DPIX mmap so the loopback path (watchdog-less, no page-fault
    // tolerance) gets its hot region pre-faulted at load time alongside the
    // main bundle.
    //
    // Touches every page of the mapped artifacts, so on a large bundle over
    // slow or cold storage this is a genuine multi-second phase — and one an
    // operator can act on directly, via PT_SERVE_PAGE_WARM_MODE. The phase is
    // emitted either way so "warming" and "not warming" are distinguishable in
    // the log rather than inferred from config.
    if page_warm_enabled {
        warm_pages(
            bundle_arc.as_ref(),
            transfers_arc.as_deref(),
            departures_idx_mmap.as_deref(),
            artifacts.shapes_mmap.as_deref(),
        );
    }
    phases.done(
        "page_warm",
        &[("enabled", if page_warm_enabled { "true" } else { "false" })],
    );

    // ETags. `validate_metadata` is invoked before adoption and rejects an empty bundle_sha256 — so
    // by the time we reach this point on the production path the field is non-empty. The test-only
    // [`Generation::from_paths`] bypasses validate_metadata, but it doesn't go through
    // `build_generation` at all, so there is no observable code path where `bundle_sha256` is empty
    // here.
    if inputs.manifest.bundle_sha256.is_empty() {
        unreachable!(
            "validate_metadata ensures bundle_sha256 is non-empty before reaching build_generation"
        );
    }
    let bundle_etag = format!("\"{}\"", inputs.manifest.bundle_sha256);
    let transfers_etag = inputs
        .manifest
        .transfers_sha256
        .as_ref()
        .map(|s| format!("\"{s}\""));

    let has_transfers = transfers.is_some();
    // Use the load-verified, always-lowercase computed value from
    // load_color_artifacts — not the manifest field, which could be mixed-case
    // from a non-conforming producer and would cause the `/shapes` handler's
    // exact-lowercase `==` content-address to 404 every request.
    let shapes_json_etag = artifacts
        .shapes_json_sha256
        .as_ref()
        .map(|s| format!("\"{s}\""));
    let route_geometry_etag = artifacts
        .shapes_bin_sha256
        .as_ref()
        .map(|s| format!("\"{s}\""));

    // Schedule-tile serving (rtTile slice 3a): absent for generations built
    // before PR #412's producer tile build — a hard load-time error on a
    // present-but-corrupt manifest.json OR on an advertised-but-missing/
    // mismatched artifact (`scheduleTileBundleSha256`/`scheduleTileBundleHash`),
    // matching every other sidecar's full-file-integrity severity above.
    let (schedule_tile_manifest, schedule_tiles_dir, gtfs_manifest_response) =
        crate::bundle::generation::load_schedule_tiles(
            gen_dir,
            &inputs.manifest.generation_id,
            inputs.manifest.schedule_tile_bundle_sha256.as_deref(),
            inputs.manifest.schedule_tile_bundle_hash.as_deref(),
        )?;
    phases.done(
        "schedule_tiles",
        &[(
            "manifestPresent",
            if schedule_tile_manifest.is_some() {
                "true"
            } else {
                "false"
            },
        )],
    );

    let address_search = if legacy_extras_enabled {
        crate::bundle::generation::load_address_search_artifact(
            gen_dir,
            inputs.expected_city,
            &inputs.manifest.generation_id,
        )?
    } else {
        None
    };
    phases.done(
        "address_search",
        &[(
            "present",
            if address_search.is_some() {
                "true"
            } else {
                "false"
            },
        )],
    );

    let parts = GenerationParts {
        transfers_mmap: transfers_arc,
        bundle_mmap: bundle_arc,
        reader,
        index,
        transfers,
        city_slug: inputs.expected_city.to_string(),
        generation_id: inputs.manifest.generation_id.clone(),
        bundle_sha256: inputs.manifest.bundle_sha256.clone(),
        created_at: inputs.manifest.created_at.clone(),
        feed_start_date,
        has_transfers,
        bundle_etag,
        transfers_etag,
        route_geometry_etag,
        color_config: artifacts.color_config,
        route_styles: artifacts.route_styles,
        label_anchors: artifacts.label_anchors,
        shapes_mmap: artifacts.shapes_mmap,
        shapes_json_sha256: artifacts.shapes_json_sha256.clone(),
        shapes_json_size_bytes: artifacts.shapes_json_size_bytes,
        shapes_json_etag,
        departures_idx_mmap,
        dpix_trips_sha,
        dpix_stops_sha,
        city_tz,
        city_tz_iana,
        schedule_tile_manifest,
        schedule_tiles_dir,
        gtfs_manifest_response,
        address_search,
        epoch: inputs.epoch,
        pattern_mode: inputs.pattern_mode,
    };
    // Terminal line: the total the phases sum to. Emitted separately from the
    // per-phase lines so a log query can pull one row per load without also
    // matching every phase, and so the paris-class question ("did it hang, or
    // was it working?") has a single unambiguous answer.
    if let Some(format) = log_format {
        log_event(
            format,
            Level::Info,
            "generation_load_complete",
            &[
                ("generationId", &inputs.manifest.generation_id),
                ("totalMs", &phases.total_ms().to_string()),
                (
                    "isStartup",
                    if inputs.is_startup { "true" } else { "false" },
                ),
            ],
        );
    }
    Ok(Generation::new(parts, inputs.metrics))
}

/// Best-effort page warming. On Linux this calls `madvise(MADV_WILLNEED)` on each mmap so the
/// kernel queues read-ahead; on macOS / other platforms it falls back to a touch-pass that faults
/// the head + tail page (cheap, no public route query as requires).
///
/// `departures_idx` and `shapes` are included because the C2c loopback pool
/// runs without a request-timeout watchdog; major page-faults on the first
/// loopback request after a generation swap would stall a loopback worker
/// indefinitely. Pre-faulting at load time avoids this. Failure is
/// non-fatal — `advise` errors are silently discarded.
///
/// We do NOT issue a planning query here — that would invalidate the
/// first-query latency measurement.
fn warm_pages(
    bundle: &memmap2::Mmap,
    transfers: Option<&memmap2::Mmap>,
    departures_idx: Option<&memmap2::Mmap>,
    shapes: Option<&memmap2::Mmap>,
) {
    let _ = bundle.advise(memmap2::Advice::WillNeed);
    if let Some(t) = transfers {
        let _ = t.advise(memmap2::Advice::WillNeed);
    }
    // Pre-fault the loopback-hot sidecars (perf: avoid major faults on the
    // watchdog-less loopback path — see function doc above).
    if let Some(d) = departures_idx {
        let _ = d.advise(memmap2::Advice::WillNeed);
    }
    if let Some(s) = shapes {
        let _ = s.advise(memmap2::Advice::WillNeed);
    }
    // Read the first byte to defeat lazy faults on platforms where advise is
    // a no-op. We deliberately stay narrow — touching every page would defeat
    // the boundary-etag rationale (no whole-file fault for ETag derivation).
    let _ = bundle.first().copied();
    if let Some(t) = transfers {
        let _ = t.first().copied();
    }
    if let Some(d) = departures_idx {
        let _ = d.first().copied();
    }
    if let Some(s) = shapes {
        let _ = s.first().copied();
    }
}
