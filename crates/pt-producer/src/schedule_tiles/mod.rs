//! Rust-native producer schedule-tile build.
//!
//! Faithful port of the Node pipeline: schedule-tile-gen.mjs →
//! buildBundle.ts → buildTileForCell.ts → subdivideCell.ts. Output parity is
//! enforced by the schedule-tile differential CI gate: byte-identical
//! decompressed tiles when both engines choose the same leaves; byte-identical
//! trip-route.json plus equivalent stop-major schedules and self-consistent
//! manifests/stop-cell maps when engine-specific Brotli sizes choose different
//! subdivision layouts.
//! Iteration order, the unstable pairSortByB, and NFC interning are all part
//! of the wire contract.

pub mod artifacts;
pub mod brotli_tile;
pub mod bundle;
pub mod grid;
pub mod inputs;
pub mod js_key_order;
pub mod mode;
pub mod pair_sort;
pub mod subdivide;
pub mod tile;
pub mod wire;

mod orchestrate;
pub use orchestrate::{build_schedule_tiles, TileBuildConfig, TileBuildOutputs};
