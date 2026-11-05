//! PTB v2 routing engine: service-day origins, transfer specificity, linked
//! trips and derived block continuations.
//!
//! The v1 scan (`engine::scan`) is frozen; a v2 bundle is planned only through
//! this module. See
//! the gtfs temporal transfer foundation notes.

pub mod index;
#[cfg(feature = "temporal-experiment")]
pub(crate) mod instances;
pub(crate) mod rules;
pub(crate) mod scan;
pub mod time;

pub use index::{commitment_of, recompute_block_commitment, V2Index};
pub use scan::plan_v2;
pub use time::{resolve_time, TimeResolution, ROUTING_HORIZON_SECS};

#[cfg(test)]
mod tests;
