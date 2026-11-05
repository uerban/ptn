//! Rust-native PTFT transfer-table build (`--engine=dijkstra` only —
//! `--engine=osrm` uses Node/Docker).
//! Faithful port of scripts/lib/transfers/{dijkstra,snapEdges,snapStops,wire}.mjs.
//! Output parity is enforced by a differential test against the Node CLI
//! on a small synthetic fixture — see tests/transfers_differential.rs.

pub mod build;
pub mod dijkstra;
pub mod edgesnap;
pub mod graph;
pub mod kdtree;
pub mod wire;

pub use build::{build_transfers, run_build, BuildArgs, BuildReport, StopPoint, TransferParams};
