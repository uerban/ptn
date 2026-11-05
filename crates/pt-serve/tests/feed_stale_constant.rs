//! Cross-language pin: `pt_serve::ops::FEED_STALE_DAYS` MUST equal the Node
//! constant `FEED_STALE_DAYS` exported from
//! `packages/backend/src/health/feedStaleConstants.ts`.
//!
//! `build.rs` greps the TS file at compile time and emits the value as
//! `NODE_FEED_STALE_DAYS`. This test asserts equality so a one-sided
//! change breaks the build, not silently.

#[test]
fn rust_feed_stale_days_matches_node() {
    let node: u32 = env!("NODE_FEED_STALE_DAYS")
        .parse()
        .expect("NODE_FEED_STALE_DAYS env emitted by build.rs must parse as u32");
    assert_eq!(
        pt_serve::ops::FEED_STALE_DAYS,
        node,
        "Rust FEED_STALE_DAYS ({}) != Node FEED_STALE_DAYS ({}). \
         Update BOTH in the same change: \
         pt_serve::ops::readiness::FEED_STALE_DAYS and \
         packages/backend/src/health/feedStaleConstants.ts",
        pt_serve::ops::FEED_STALE_DAYS,
        node,
    );
}

/// Sanity: the constant exposed via the `ops::` re-export matches the
/// canonical location in `ops::readiness`. Tests both compile sites.
#[test]
fn ops_reexport_matches_readiness_constant() {
    assert_eq!(
        pt_serve::ops::FEED_STALE_DAYS,
        pt_serve::ops::readiness::FEED_STALE_DAYS,
    );
}
