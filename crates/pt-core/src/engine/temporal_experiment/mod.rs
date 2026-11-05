//! Small synthetic-timetable oracle tests for temporal-routing experiments.
//!
//! The implementation intentionally remains outside the production scan and
//! reconstruction modules so it can act as an independent test oracle.

pub(crate) mod oracle;

#[cfg(test)]
mod oracle_tests;
