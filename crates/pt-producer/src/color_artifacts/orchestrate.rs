//! In-process replacement for color-artifacts-gen.mjs's `main()`. Reads a
//! staged `bundle.ptb`, runs the clustering/palette/anchor pipeline stages
//! (Tasks 1-6), encodes the three JSON artifacts, writes them into the
//! staging directory, and returns their SHA-256 hashes — the Rust-path
//! analog of what refresh.rs currently parses from color-artifacts-gen.mjs's
//! stdout lines.

use std::path::Path;

use indexmap::IndexMap;

use super::anchors::compute_label_anchors;
use super::cluster::cluster_route_colors;
use super::inputs::read_inputs;
use super::palettes::compute_palettes;
use super::wire::{encode_color_config, encode_label_anchors, encode_route_styles};
use crate::build::sha256_hex;
use crate::error::{Error, Result};
use crate::refresh::fsync_file;

pub struct ColorArtifactOutputs {
    pub color_config_sha256: String,
    pub route_styles_sha256: String,
    pub label_anchors_sha256: String,
}

fn write_and_hash(dir: &Path, name: &str, bytes: &[u8]) -> Result<String> {
    let path = dir.join(name);
    std::fs::write(&path, bytes)?;
    fsync_file(&path)?;
    Ok(sha256_hex(bytes))
}

/// Reads bundle.ptb from `staging_dir`, computes all three color artifacts,
/// writes them into `staging_dir`, and returns their SHA-256 hashes.
pub fn build_color_artifacts(staging_dir: &Path) -> Result<ColorArtifactOutputs> {
    let bundle_path = staging_dir.join("bundle.ptb");
    let bytes = std::fs::read(&bundle_path)
        .map_err(|e| Error::Config(format!("failed to read {}: {e}", bundle_path.display())))?;
    let reader = pt_core::Reader::from_bytes(bytes)
        .map_err(|e| Error::Config(format!("failed to parse {}: {e}", bundle_path.display())))?;

    let inputs = read_inputs(&reader)?;

    let cluster_result = cluster_route_colors(&inputs.routes);
    let base_colors: IndexMap<String, String> = cluster_result
        .sub_modes
        .iter()
        .map(|sm| (sm.id.clone(), sm.color.clone()))
        .collect();
    let palettes = compute_palettes(&base_colors);

    let color_config_bytes = encode_color_config(&cluster_result.sub_modes, &palettes);
    let color_config_sha256 =
        write_and_hash(staging_dir, "color-config.json", &color_config_bytes)?;

    let route_styles_bytes = encode_route_styles(
        &inputs.routes,
        &cluster_result.route_sub_mode_map,
        &cluster_result.sub_modes,
    );
    let route_styles_sha256 =
        write_and_hash(staging_dir, "route-styles.json", &route_styles_bytes)?;

    let anchors = compute_label_anchors(&inputs.stops);
    let label_anchors_bytes = encode_label_anchors(&anchors);
    let label_anchors_sha256 =
        write_and_hash(staging_dir, "label-anchors.json", &label_anchors_bytes)?;

    Ok(ColorArtifactOutputs {
        color_config_sha256,
        route_styles_sha256,
        label_anchors_sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_bytes(name: &str) -> Vec<u8> {
        let path = format!(
            "{}/../../packages/frontend/tests/services/__fixtures__/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read(&path).unwrap_or_else(|e| panic!("{name} fixture reads: {e}"))
    }

    /// Stages `bundle.ptb` in a temp dir, runs `build_color_artifacts`, and
    /// checks the wiring — NOT the individual stages' algorithmic
    /// correctness (cluster.rs/palettes.rs/anchors.rs/wire.rs already pin
    /// that against real culori/TS golden output in Tasks 3-6):
    ///
    /// 1. `build_color_artifacts` returns `Ok`.
    /// 2. The three output files exist in `staging_dir` with non-empty
    ///    bytes.
    /// 3. Those bytes match calling `read_inputs` +
    ///    `cluster_route_colors`/`compute_palettes`/`compute_label_anchors`
    ///    + `encode_*` directly in the test on the same bundle bytes — this
    ///    proves `orchestrate.rs` threads the right data through the right
    ///    functions in the right order (the thing this task actually owns),
    ///    without re-deriving stage correctness.
    /// 4. The returned SHA-256 hashes equal `sha256(bytes actually on
    ///    disk)`, catching any fsync/rehash/staleness bug.
    #[test]
    fn build_color_artifacts_wires_stages_and_hashes_correctly() {
        let bundle_bytes = fixture_bytes("three-leg.ptb");

        let staging_dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(staging_dir.path().join("bundle.ptb"), &bundle_bytes)
            .expect("stage bundle.ptb");

        let outputs =
            build_color_artifacts(staging_dir.path()).expect("build_color_artifacts succeeds");

        // Independently reproduce the expected artifact bytes by calling the
        // already-tested stages directly on the same bundle bytes.
        let reader =
            pt_core::Reader::from_bytes(bundle_bytes.clone()).expect("three-leg.ptb parses");
        let inputs = read_inputs(&reader).expect("read_inputs succeeds");
        let cluster_result = cluster_route_colors(&inputs.routes);
        let base_colors: IndexMap<String, String> = cluster_result
            .sub_modes
            .iter()
            .map(|sm| (sm.id.clone(), sm.color.clone()))
            .collect();
        let palettes = compute_palettes(&base_colors);
        let expected_color_config = encode_color_config(&cluster_result.sub_modes, &palettes);
        let expected_route_styles = encode_route_styles(
            &inputs.routes,
            &cluster_result.route_sub_mode_map,
            &cluster_result.sub_modes,
        );
        let anchors = compute_label_anchors(&inputs.stops);
        let expected_label_anchors = encode_label_anchors(&anchors);

        for (name, expected, returned_sha256) in [
            (
                "color-config.json",
                &expected_color_config,
                &outputs.color_config_sha256,
            ),
            (
                "route-styles.json",
                &expected_route_styles,
                &outputs.route_styles_sha256,
            ),
            (
                "label-anchors.json",
                &expected_label_anchors,
                &outputs.label_anchors_sha256,
            ),
        ] {
            let on_disk = std::fs::read(staging_dir.path().join(name))
                .unwrap_or_else(|e| panic!("{name} written to staging dir: {e}"));
            assert!(!on_disk.is_empty(), "{name} must not be empty");
            assert_eq!(
                &on_disk, expected,
                "{name} bytes must match direct stage calls"
            );
            assert_eq!(
                *returned_sha256,
                sha256_hex(&on_disk),
                "{name} returned hash must equal sha256 of the bytes actually on disk"
            );
        }
    }

    /// `build_color_artifacts` surfaces a missing `bundle.ptb` as an
    /// `Error`, not a panic.
    #[test]
    fn build_color_artifacts_errors_on_missing_bundle() {
        let staging_dir = tempfile::tempdir().expect("tempdir");
        let result = build_color_artifacts(staging_dir.path());
        assert!(result.is_err(), "missing bundle.ptb must be an error");
    }
}
