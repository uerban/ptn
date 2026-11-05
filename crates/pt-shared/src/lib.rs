//! `pt-shared` — types and helpers shared between the producer (publish path) and
//! pt-serve (read path) without dragging the engine crate into std/serde land.
//!
//! Layout:
//! - [`manifest`] — wire-format JSON shapes (`GenerationManifest`, `PointerManifest`) plus
//! the schema-version constants.
//! - [`fsync`] — cross-platform durable-fsync helper (Linux
//! `fsync(2)`, macOS `F_FULLFSYNC`). Used by both the producer publish protocol and pt-serve's
//! last-good promotion path.
//! - [`clock`] — `Clock` trait + `SystemClock` + `MockClock`. Lets the
//! server's staleness/reload logic be driven from tests without sleeping.
//! - [`validate`] —
//! validator API surface.

#[cfg(feature = "durable-fsync")]
pub mod artifact_lease;
pub mod clock;
#[cfg(feature = "durable-fsync")]
pub mod fsync;
pub mod js_json;
pub mod manifest;
pub mod osm_install;
pub mod osm_manifest;
pub mod pack_manifest;
pub mod poi_bundle_wire;
pub mod poi_manifest_wire;
pub mod poi_tile_grid;
pub mod schedule_tile_manifest;
pub mod schedule_tile_wire;
pub mod sidecar;
pub mod tile_coord;
pub mod tz;
pub mod validate;
