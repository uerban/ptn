// crates/pt-serve/src/rt/mod.rs

//! GTFS-RT subsystem: hand-rolled TripUpdate decoding (`protobuf`/`parser`),
//! pure poller state (`poller`), blocking fetch (`fetch`), the poll loop
//! (`runner`), time-only predictions turned into delays against the bundle
//! (`resolve`), and the arc-swap snapshot seam (`state`) that `/health/rt`
//! (and the future rtTile / departures-RT-merge routes) read.
//!
//! ServiceAlerts feeds (`alerts` decoding, `alerts_state` polling and the
//! published `/api/<city>/alerts` reply) share the poller, fetch and loop
//! shell, on a thread of their own.
//!
//! Node parity source: `packages/backend/src/gtfs/realtime.ts` +
//! `packages/backend/src/routes/rtHealth.ts`. Parsing/state landed in the
//! parsing-only slice (PR #426,
//! the rt poller parsing rust native notes);
//! the fetch loop, thread, config, and route landed with
//! the rt poller network rust native notes,
//! which also documents the deliberate divergences (empty-URL default,
//! 64 MiB body cap, sequential per-cycle fetch fan-out — Node fetches all
//! feeds in parallel via `Promise.allSettled` — sequential non-overlapping
//! cycles, and per-cycle health visibility).

pub mod alerts;
pub mod alerts_state;
pub mod encode;
pub mod fetch;
pub mod parser;
pub mod poller;
pub mod protobuf;
pub mod resolve;
pub mod runner;
pub mod state;

pub use alerts_state::AlertsState;
pub use parser::{parse_trip_updates_buffer, ParseError, TripUpdate};
pub use poller::{FeedHealth, FeedPayload, FeedPoller, FeedStatus, PollerConfigError, RtPoller};
pub use state::{RtSnapshot, RtState};
