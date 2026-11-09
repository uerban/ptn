//! Validator surface for manifests + bundles.
//!
//!
//! Structural validation (PTB magic bytes, region bounds, CSR bounds) lives in
//! `pt-core::validate::structural` — a `no_std` module so the bench harness
//! and the differential gate exercise the SAME validator that runs in the
//! server's load path. See `tests/boundaries.rs::no_duplicated_structural_validation_in_bundle_loader`.

pub mod errors;
pub mod metadata;

pub mod namespace;
