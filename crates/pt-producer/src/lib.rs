#[cfg(all(feature = "csv-bufwriter", feature = "csv-mmap"))]
compile_error!("features `csv-bufwriter` and `csv-mmap` are mutually exclusive");

#[cfg(all(feature = "hand-rolled", feature = "csv-bufwriter"))]
compile_error!("feature `hand-rolled` implies `csv-mmap`; pass `--no-default-features --features hand-rolled` (not combined with `csv-bufwriter`)");

#[cfg(not(any(feature = "csv-bufwriter", feature = "csv-mmap")))]
compile_error!("one of `csv-bufwriter` or `csv-mmap` must be enabled");

pub const VARIANT_LABEL: &str = if cfg!(feature = "hand-rolled") {
    "hand-rolled"
} else if cfg!(feature = "csv-mmap") {
    "csv-mmap"
} else {
    "csv-bufwriter"
};

// Re-export the single-source coordinate quantizer from pt-core so producer and
// reader use the same implementation. Both crates are root-workspace members.
pub use pt_core::coord_quant;

pub mod address_pack;
pub mod build;
mod build_inputs;
pub mod cli;
pub mod color_artifacts;
pub mod csr;
pub mod csv_open;
pub mod current_emit;
pub mod date_utils;
pub mod download;
pub mod error;
pub mod fault_inject;
pub mod header;
pub mod http;
pub mod idle;
pub mod interns;
pub mod janitor;
pub mod layout;
pub mod liveness;
pub mod pass1;
pub mod pass2;
pub mod pass3;
pub mod persist;
pub mod producer_lock;
pub mod ptb_v2;
pub mod refresh;
pub mod regions;
pub mod republish;
pub mod schedule_tiles;
pub mod sentinel;
pub mod service;
pub mod sidecars;
pub mod source;
pub mod strpool;
pub mod transfers;
pub mod writer;

pub use error::{Error, Result};
