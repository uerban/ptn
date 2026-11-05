//! In-process replacement for schedule-tile-gen.mjs's `main()`
//! (packages/backend/scripts/schedule-tile-gen.mjs:72-176): reads the staged
//! generation (bundle.ptb + route-styles.json), builds the tile bundle into
//! `<staging>/schedule-tiles/`, writes manifest.json + trip-route.json +
//! stop-cell.json, and returns the hashes `refresh.rs` previously parsed from
//! the script's stdout protocol (`"<name> <sha256> <bytes> [<bundleHash>]"`
//! lines — schedule-tile-gen.mjs:60-69,130-135,167,175).
//!
//! Unlike the script, `bundleHash` is NOT re-read from a provisional
//! generation.json — the caller (refresh.rs Step 3g) already holds `gen_id`
//! and passes it straight through, so this path skips that round-trip
//! entirely.

use std::path::Path;

use super::brotli_tile::{Brotli, DEFAULT_TILE_BROTLI_QUALITY, MAX_COMPRESSED_TILE_BYTES};
use super::grid::MAX_SUBDIVISION_DEPTH;
use crate::build::sha256_hex;
use crate::error::{Error, Result};

/// Operator knobs for the tile build's cost. Neither changes what a client
/// decodes: threads only change how fast the same bytes are produced, and
/// quality only changes their compressed size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileBuildConfig {
    /// Cells built concurrently (`PT_TILE_THREADS`: a count, or `auto` for
    /// every CPU the process may run on, honouring cgroup quotas and CPU
    /// affinity). Each worker holds one cell's JSON and encoder state, so
    /// peak memory grows with it.
    pub threads: usize,
    /// Brotli quality, 0..=11 (`PT_TILE_BROTLI_QUALITY`).
    pub quality: u32,
}

impl TileBuildConfig {
    /// Read `PT_TILE_THREADS` and `PT_TILE_BROTLI_QUALITY`. Unset means the
    /// defaults: one thread and q=11, the build every bundle has had so far.
    /// A malformed value is a configuration error, not a silent default,
    /// matching `PT_TILE_BUILD`.
    pub fn from_env() -> Result<Self> {
        Self::parse(
            std::env::var_os("PT_TILE_THREADS").as_deref(),
            std::env::var_os("PT_TILE_BROTLI_QUALITY").as_deref(),
        )
    }

    fn parse(threads: Option<&std::ffi::OsStr>, quality: Option<&std::ffi::OsStr>) -> Result<Self> {
        let parse = |name: &str, v: &std::ffi::OsStr, ok: &dyn Fn(u32) -> bool, want: &str| {
            v.to_str()
                .and_then(|s| s.parse::<u32>().ok())
                .filter(|n| ok(*n))
                .ok_or_else(|| Error::Config(format!("invalid {name}={v:?}; expected {want}")))
        };
        let threads = match threads {
            None => 1,
            Some(v) if v == "auto" => std::thread::available_parallelism().map_or(1, |n| n.get()),
            Some(v) => {
                parse("PT_TILE_THREADS", v, &|n| n >= 1, "an integer >= 1 or auto")? as usize
            }
        };
        let quality = match quality {
            None => DEFAULT_TILE_BROTLI_QUALITY,
            Some(v) => parse(
                "PT_TILE_BROTLI_QUALITY",
                v,
                &|n| n <= 11,
                "an integer in 0..=11",
            )?,
        };
        Ok(Self { threads, quality })
    }
}

impl Default for TileBuildConfig {
    fn default() -> Self {
        Self {
            threads: 1,
            quality: DEFAULT_TILE_BROTLI_QUALITY,
        }
    }
}

/// Hashes + sizes of the artifacts this build wrote, mirroring the fields
/// `refresh.rs` previously parsed off the producer script's stdout
/// (`parse_producer_build_output`).
pub struct TileBuildOutputs {
    /// sha256 hex of the manifest.json bytes (generation.json
    /// `schedule_tile_bundle_sha256`).
    pub manifest_sha256: String,
    pub manifest_size_bytes: u64,
    /// == `gen_id` by construction (refresh.rs still asserts this holds).
    pub bundle_hash: String,
    pub trip_route_sha256: String,
    pub trip_route_size_bytes: u64,
    pub stop_cell_sha256: String,
    pub stop_cell_size_bytes: u64,
}

/// Build the schedule-tile bundle + producer artifacts for a staged
/// generation, in-process (no `node` subprocess). Mirrors
/// schedule-tile-gen.mjs's `main()`: loads `bundle.ptb` + `route-styles.json`
/// from `staging_dir`, runs the tile build into
/// `<staging_dir>/schedule-tiles/`, writes `manifest.json` there and
/// `trip-route.json` / `stop-cell.json` into `staging_dir` itself (schedule-
/// tile-gen.mjs:167,175 — the staging ROOT, so both ride the step-8 whole-dir
/// publish rename and the backend loads them from the generation root).
pub fn build_schedule_tiles(
    staging_dir: &Path,
    city_id: &str,
    gen_id: &str,
    config: &TileBuildConfig,
) -> Result<TileBuildOutputs> {
    let inputs = super::inputs::load_tile_inputs(staging_dir)?;
    let data_dir = staging_dir.join("schedule-tiles");
    std::fs::create_dir_all(&data_dir)?;

    let result = super::bundle::build_bundle(
        &inputs,
        gen_id,
        city_id,
        &data_dir,
        MAX_COMPRESSED_TILE_BYTES,
        MAX_SUBDIVISION_DEPTH,
        &Brotli {
            quality: config.quality,
        },
        config.threads,
    )?;

    let generated_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| Error::Config(format!("clock before epoch: {e}")))?
        .as_millis() as u64;
    let manifest_bytes =
        super::artifacts::write_bundle_manifest(&data_dir, gen_id, generated_at_ms, &result)?;

    // trip-route.json / stop-cell.json land in the STAGING ROOT (not
    // schedule-tiles/) so they ride the whole-dir publish rename and the Node
    // backend loads them from the generation root (schedule-tile-gen.mjs:137).
    let trip_route = super::artifacts::trip_route_json(&inputs);
    std::fs::write(staging_dir.join("trip-route.json"), &trip_route)?;
    let stop_cell = super::artifacts::stop_cell_json(&result);
    std::fs::write(staging_dir.join("stop-cell.json"), &stop_cell)?;

    Ok(TileBuildOutputs {
        manifest_sha256: sha256_hex(&manifest_bytes),
        manifest_size_bytes: manifest_bytes.len() as u64,
        bundle_hash: gen_id.to_string(),
        trip_route_sha256: sha256_hex(&trip_route),
        trip_route_size_bytes: trip_route.len() as u64,
        stop_cell_sha256: sha256_hex(&stop_cell),
        stop_cell_size_bytes: stop_cell.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn unset_knobs_keep_the_sequential_q11_build() {
        assert_eq!(
            TileBuildConfig::parse(None, None).unwrap(),
            TileBuildConfig {
                threads: 1,
                quality: 11
            }
        );
    }

    #[test]
    fn knobs_parse_in_range_values() {
        let c = TileBuildConfig::parse(Some(OsStr::new("4")), Some(OsStr::new("0"))).unwrap();
        assert_eq!(
            c,
            TileBuildConfig {
                threads: 4,
                quality: 0
            }
        );
        let c = TileBuildConfig::parse(None, Some(OsStr::new("11"))).unwrap();
        assert_eq!(c.quality, 11);
        let c = TileBuildConfig::parse(Some(OsStr::new("auto")), None).unwrap();
        assert_eq!(
            c.threads,
            std::thread::available_parallelism().unwrap().get()
        );
    }

    #[test]
    fn malformed_knobs_are_config_errors() {
        for t in ["0", "-1", "two", " 4", "4 ", "", "AUTO"] {
            let err = TileBuildConfig::parse(Some(OsStr::new(t)), None).unwrap_err();
            assert!(
                err.to_string().contains("invalid PT_TILE_THREADS"),
                "{t:?}: {err}"
            );
        }
        for q in ["12", "-1", "q11", ""] {
            let err = TileBuildConfig::parse(None, Some(OsStr::new(q))).unwrap_err();
            assert!(
                err.to_string().contains("invalid PT_TILE_BROTLI_QUALITY"),
                "{q:?}: {err}"
            );
        }
    }
}
