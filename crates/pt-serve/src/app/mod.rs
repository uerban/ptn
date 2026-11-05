//! Transport-agnostic request handlers.
//!
//! Handlers return a [`response::Resp`] which the `http::adapter` materialises into a
//! `tiny_http::ResponseBox` at the single seam.

pub mod address_search;
pub mod bytes;
pub mod client_report;
pub mod color_config;
pub mod departures_for_stop;
pub mod gtfs_manifest;
pub mod metrics;
pub mod plan;
pub mod poi_tile;
pub mod query;
pub mod response;
pub mod route_rt;
pub mod rt_health;
pub mod rt_tile;
pub mod schedule_tile;
pub mod scheduled_departures;
pub mod shapes;
pub mod stops;
pub mod version;

pub use response::Resp;
