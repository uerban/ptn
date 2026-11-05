//! Feature-gated temporal experiment seam.
//!
//! Task A starts with a dated legal entry-event view. Later profile candidates
//! must consume this view without changing the production `plan()` contract.

#![allow(dead_code)]

pub mod direct;
mod events;
pub mod r3;
mod reset_ref;
pub mod round;
pub mod trip_based;
mod v2;

pub use events::{enumerate_entry_events, EntryEvent};
pub use reset_ref::{reset_reference, ReferenceRun, ReferenceSample};

#[cfg(test)]
mod tests;
