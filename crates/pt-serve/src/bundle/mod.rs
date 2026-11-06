//! Per-generation bundle state — see [`generation::Generation`].
//!
//! - [`generation`] — the swap-targeted state ([`Generation`]).
//! - [`loader`] — the startup load
//! path with last-good fallback.
pub mod generation;
pub mod handle;
pub mod installed;
pub mod integrity;
pub mod loader;

pub use generation::Generation;
pub use handle::{
    build_generation, build_generation_with_geometry, build_generation_with_page_warm, BuildInputs,
};

use crate::ops::config::LogFormat;
use crate::ops::log::{log_event, Level};
use crate::ops::Metrics;
use pt_shared::clock::Clock;
use pt_shared::manifest::GenerationManifest;
use pt_shared::validate::errors::{IoErr, OperatorError, ProducerError, ValidationError};
use std::io;
use std::path::Path;
use std::sync::Arc;

/// Startup-time helper used by `main.rs`: load the active pointer
/// (current → last-good fallback) and build the first `Generation` at
/// `epoch = 0`.
///
/// P4 is data-root-only. The old `--bundle` direct mode is gone, so `main.rs` always boots through
/// this path.
///
/// when the load falls back from `current.json` to `last-good.json`, the function sets
/// `metrics.set_startup_fallback_active(true)` so `/ready` exposes `servingLastGoodFallback`. The
/// flag clears on the first successful reload that adopts a different generation (the reload runner
/// consults the live pointer source on each pass — see `ReloadRunner::run_one`).
pub fn load_initial_generation(
    data_root: &Path,
    city: &str,
    clock: &dyn Clock,
    metrics: &Arc<Metrics>,
) -> Result<Generation, loader::LoadError> {
    // Test/back-compat wrapper. Production callers thread the operator's
    // `--log-format` choice through `load_initial_generation_with_force`;
    // tests that don't care about log format wire JSON (the production
    // default) so log_event output stays parser-friendly under cargo test.
    load_initial_generation_with_force(
        data_root,
        city,
        clock,
        metrics,
        None,
        LogFormat::Json,
        None,
        pt_core::PatternMode::Off,
    )
}

/// Same as [`load_initial_generation`] but with the DR escape hatch `--force-current`. When
/// `force_current` is `Some(id)` we bypass `current.json` and `last-good.json` entirely and load
/// `<data_root>/generations/<id>/{generation.json,bundle.ptb,transfers.bin?}` directly.
///
/// Forced mode emits an ERROR-level log line on adoption and sets
/// `metrics.set_forced_current_mode_active(true)` so `/ready` surfaces
/// `forcedCurrentMode: true` and `/metrics` emits
/// `pt_serve_forced_current_mode 1`. The flag is sticky for the process
/// lifetime — to clear it, restart without the flag AND re-publish via
/// `republish --from-cache`.
///
/// `is_fatal()` gate: for the non-forced path, after `current.json` fails we check
/// `error.is_fatal()` BEFORE attempting `last-good.json` fallback. A fatal class (currently only
/// `UnsupportedManifestSchemaVersion`) means the on-disk artifact is from a NEWER pt-serve than us;
/// a fresh `last-good.json` pointing at the SAME forward-incompat schema would fail the same way,
/// and the runbook says exit non-zero rather than fall back to a known-incompat older generation we
/// can't validate either.
#[allow(clippy::too_many_arguments)]
pub fn load_initial_generation_with_force(
    data_root: &Path,
    city: &str,
    clock: &dyn Clock,
    metrics: &Arc<Metrics>,
    force_current: Option<&str>,
    log_format: LogFormat,
    city_tz_iana_default: Option<&str>,
    pattern_mode: pt_core::PatternMode,
) -> Result<Generation, loader::LoadError> {
    load_initial_generation_with_force_and_page_warm(
        data_root,
        city,
        clock,
        metrics,
        force_current,
        log_format,
        city_tz_iana_default,
        pattern_mode,
        true,
    )
}

/// Production startup variant with explicit mmap page-warming policy.
#[allow(clippy::too_many_arguments)]
pub fn load_initial_generation_with_force_and_page_warm(
    data_root: &Path,
    city: &str,
    clock: &dyn Clock,
    metrics: &Arc<Metrics>,
    force_current: Option<&str>,
    log_format: LogFormat,
    city_tz_iana_default: Option<&str>,
    pattern_mode: pt_core::PatternMode,
    page_warm_enabled: bool,
) -> Result<Generation, loader::LoadError> {
    load_initial_generation_with_geometry(
        data_root,
        city,
        clock,
        metrics,
        force_current,
        log_format,
        city_tz_iana_default,
        pattern_mode,
        page_warm_enabled,
        true,
    )
}

/// Startup policy shared by normal and forced-current generation loading.
#[allow(clippy::too_many_arguments)]
pub fn load_initial_generation_with_geometry(
    data_root: &Path,
    city: &str,
    clock: &dyn Clock,
    metrics: &Arc<Metrics>,
    force_current: Option<&str>,
    log_format: LogFormat,
    city_tz_iana_default: Option<&str>,
    pattern_mode: pt_core::PatternMode,
    page_warm_enabled: bool,
    geometry_enabled: bool,
) -> Result<Generation, loader::LoadError> {
    if let Some(forced_id) = force_current {
        // DR mode. Operator-invoked recovery — they typed --force-current
        // intentionally — so WARN (not ERROR) matches the actual severity:
        // the sticky `pt_serve_forced_current_mode` gauge is what alerts on,
        // and an ERROR here would pollute incident timelines with self-
        // induced false positives. Routed through `log_event` so
        // `--log-format=text` is honoured.
        log_event(
            log_format,
            Level::Warn,
            "forced_current_mode",
            &[
                ("forcedGenerationId", forced_id),
                ("dataRoot", &data_root.to_string_lossy()),
                ("city", city),
                ("note", "bypassing current.json / last-good.json"),
            ],
        );
        let loaded = load_forced_generation(data_root, city, forced_id)?;
        // Sticky flag for the process lifetime — surfaced in /ready and
        // /metrics. Operators clear it by restarting without --force-current.
        metrics.set_forced_current_mode_active(true);
        let g = build_generation_with_geometry(
            BuildInputs {
                manifest: &loaded.manifest,
                bundle_path: &loaded.bundle_path,
                transfers_path: loaded.transfers_path.as_deref(),
                expected_city: city,
                clock,
                is_startup: true,
                epoch: 0,
                metrics: Some(Arc::clone(metrics)),
                city_tz_iana_default,
                pattern_mode,
            },
            page_warm_enabled,
            Some(log_format),
            geometry_enabled,
        )?;
        return Ok(g);
    }

    // Normal startup: try current → optionally last-good.
    //
    // We can't use `loader::load_initial` directly because it collapses
    // both per-pointer errors into the opaque `BothPointersInvalid`. The
    // is_fatal() gate needs the per-pointer ValidationError BEFORE we
    // attempt the second pointer, so we re-implement the two-step here
    // (with the cleanup_startup_artifacts call still in `loader::load_initial`
    // — call it explicitly).
    loader::cleanup_startup_artifacts(data_root, clock)
        .map_err(|e| loader::LoadError::Validation(ValidationError::Io(IoErr::from(e))))?;
    let loaded = match loader::try_load_pointer(data_root, city, loader::PointerSource::Current) {
        Ok(g) => g,
        Err(e) if e.is_fatal() => {
            // Fail-closed: a fatal validation class (unsupported manifest
            // schema version) means falling back to last-good is the wrong
            // move — older generations validate the same way and we'd
            // either silently serve stale data or hit the same failure.
            // Surface the specific error to the caller's exit log via
            // log_event so --log-format=text operators see a readable line.
            let detail = e.to_string();
            log_event(
                log_format,
                Level::Error,
                "fatal_validation_no_fallback",
                &[("cause", e.cause_label()), ("detail", &detail)],
            );
            return Err(loader::LoadError::Validation(e));
        }
        Err(current_err) => {
            match loader::try_load_pointer(data_root, city, loader::PointerSource::LastGood) {
                Ok(g) => g,
                Err(last_good_err) => {
                    return Err(loader::LoadError::BothPointersInvalid {
                        current_err: Box::new(current_err),
                        last_good_err: Box::new(last_good_err),
                    })
                }
            }
        }
    };
    if matches!(loaded.source_pointer, loader::PointerSource::LastGood) {
        metrics.set_startup_fallback_active(true);
        metrics.inc_startup_generation_fallback_total();
    }
    let g = build_generation_with_geometry(
        BuildInputs {
            manifest: &loaded.manifest,
            bundle_path: &loaded.bundle_path,
            transfers_path: loaded.transfers_path.as_deref(),
            expected_city: city,
            clock,
            is_startup: true,
            epoch: 0,
            metrics: Some(Arc::clone(metrics)),
            city_tz_iana_default,
            pattern_mode,
        },
        page_warm_enabled,
        Some(log_format),
        geometry_enabled,
    )?;
    Ok(g)
}

/// Forced-mode loader. Reads
/// `<data_root>/generations/<forced_id>/{generation.json,bundle.ptb}` (+
/// `transfers.bin` if `manifest.has_transfers`) and returns the same
/// `LoadedGeneration` shape `try_load_pointer` does. The same city-slug and
/// bundle-size cross-checks apply: forced mode is a fallback adoption, not a
/// permission to serve garbage.
fn load_forced_generation(
    data_root: &Path,
    city: &str,
    forced_id: &str,
) -> Result<loader::LoadedGeneration, ValidationError> {
    let gen_dir = data_root.join("generations").join(forced_id);
    if !gen_dir.is_dir() {
        return Err(ValidationError::Io(IoErr {
            kind: io::ErrorKind::NotFound,
            msg: format!(
                "--force-current generation `{forced_id}` not found under `{}`",
                data_root.display()
            ),
        }));
    }
    let manifest_path = gen_dir.join("generation.json");
    let manifest_text =
        std::fs::read_to_string(&manifest_path).map_err(|e| ValidationError::Io(IoErr::from(e)))?;
    let manifest: GenerationManifest = serde_json::from_str(&manifest_text).map_err(|e| {
        ValidationError::Io(IoErr {
            kind: io::ErrorKind::InvalidData,
            msg: format!("manifest at {} is malformed: {e}", manifest_path.display()),
        })
    })?;
    if manifest.city_slug != city {
        return Err(ValidationError::Operator(OperatorError::WrongCity {
            expected: city.to_string(),
            found: manifest.city_slug.clone(),
        }));
    }
    let bundle_path = gen_dir.join("bundle.ptb");
    let bundle_meta =
        std::fs::metadata(&bundle_path).map_err(|e| ValidationError::Io(IoErr::from(e)))?;
    if bundle_meta.len() != manifest.bundle_size_bytes {
        return Err(ValidationError::Producer(
            ProducerError::BundleSizeMismatch {
                expected: manifest.bundle_size_bytes,
                actual: bundle_meta.len(),
            },
        ));
    }
    let transfers_path = if manifest.has_transfers {
        Some(gen_dir.join("transfers.bin"))
    } else {
        None
    };
    // Note: source_pointer is recorded as `Current` so downstream metrics
    // (servingLastGoodFallback) report "not on fallback" — forced mode is
    // tracked via the orthogonal `forced_current_mode_active` flag.
    Ok(loader::LoadedGeneration {
        source_pointer: loader::PointerSource::Current,
        manifest,
        bundle_path,
        transfers_path,
    })
}
