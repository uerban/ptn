//! Rust-native producer color-artifacts build. Faithful port of the Node
//! pipeline: color-artifacts-gen.mjs → colorClustering.ts, colorblindPalettes.ts
//! and labelAnchors.ts. Output parity is enforced by the color-artifacts
//! differential CI steps in pt-serve-route-parity.yml: byte-identical
//! color-config.json / route-styles.json / label-anchors.json.
//!
//! Parity contract before touching color_math.rs or cluster.rs — the D50-vs-D65
//! Lab conversion culori applies inside CIEDE2000 is not obvious from the TS
//! source alone and is the single most likely source of a silent divergence.

pub mod anchors;
pub mod cluster;
pub mod color_math;
pub mod inputs;
pub mod palettes;
pub mod wire;

mod orchestrate;
pub use orchestrate::{build_color_artifacts, ColorArtifactOutputs};
