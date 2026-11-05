//! `pt-walk` — per-city pedestrian graph: the PTWG artifact format, its
//! builder, and the on-device walking router.
//!

pub mod build;
pub mod format;
pub mod geo;
pub mod graph;
#[cfg(feature = "build")]
pub mod osm;
pub mod route;
pub mod snap;
pub mod steps;
#[cfg(test)]
pub(crate) mod testutil;
pub mod varint;

/// Hard cap on the points (uncontracted nodes) of one PTWG artifact. The
/// whole graph is decoded into memory, so RAM grows with the artifact; the
/// builder refuses larger cities and the bench gates on it. It stands until
/// the graph is tiled and a client holds only the tiles in use.
pub const MAX_ARTIFACT_POINTS: usize = 1_000_000;
