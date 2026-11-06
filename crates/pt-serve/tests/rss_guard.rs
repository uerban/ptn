//! `--max-rss` startup guard tests.
//!
//! Two layers:
//!
//! 1. **Pure-function**: the 3-point factor bracketing pins the load-bearing
//!    `payload_factor` to exactly 2. A naive `assert!(factor > 1)` test would
//!    accept any factor ≥ 2; a `assert!(factor < 3)` would accept any factor
//!    ≤ 2. We need both bounds to pin it exactly — and the test data points
//!    that bracket the boundary live in this file so a future maintainer who
//!    edits `rss_guard::estimate_rss` cannot silently regress the factor.
//!
//! 2. **Process-level**: spawn the `pt-serve` binary with a producer-shaped
//!    `data_root` and contradictory budget knobs. Asserts that an over-limit
//!    config exits non-zero BEFORE binding and stderr names both
//!    `rss_guard_reject` and the headline limit/estimate numbers. The
//!    matched-pair "realistic budget → /ready 200" test lives in
//!    `tests/server.rs` (and every other test that calls `spawn(...)`) — we
//!    don't duplicate it here.

#![allow(clippy::assertions_on_constants)]

use pt_serve::{enforce_rss_budget, estimate_rss, RssDecision};

#[path = "common/mod.rs"]
mod common;

// ----------------------------------------------------------------------------
// Step 4 — 3-point factor bracketing (the core load-bearing assertion).
// ----------------------------------------------------------------------------

/// The 3-point bracket. Three test points + four assertions pin the payload factor between 1 (too
/// loose) and 3 (too tight), leaving 2 as the only integer that satisfies all four.
///
/// Verbose comments deliberately mirror the plan so the maintainer who breaks
/// this test can find the rationale in two seconds.
#[test]
fn rss_guard_pins_2x_factor_exactly() {
    let (_dir, cfg, _clock) = common::isolated_config();
    // `overhead` is every FIXED additive term in `estimate_rss` — anything
    // not scaled by the payload factor. `schedule_tile_cache_max_bytes` and
    // the two rt-tile cache terms all joined that set alongside
    // process_fixed_overhead_bytes/per-worker.
    //
    // The POI terms are CONDITIONAL: every one of them is gated on
    // `poi_bundle_dir` so a process that does not serve POI reserves nothing
    // for it. Mirror that gating here, or this bracket drifts from the real
    // estimate the moment the test config leaves POI unconfigured.
    let poi_overhead = if cfg.poi_bundle_dir.is_some() {
        cfg.poi_city_entries_cache_max_bytes
            + cfg.poi_bundle_max_decoded_bytes
                * (4 + ((cfg.worker_pool_size + cfg.loopback_worker_count) as u64
                    + pt_serve::ops::rss_guard::AUXILIARY_WORKER_COUNT
                    + 1)
                    * pt_serve::ops::rss_guard::POI_CITY_ENTRIES_RSS_FACTOR_ASSUMED)
            + cfg.poi_tile_cache_max_bytes
            + (pt_serve::ops::rss_guard::POI_BROTLI_ENCODER_WORKING_SET_BYTES
                + cfg.poi_bundle_max_decoded_bytes
                    * pt_serve::ops::rss_guard::POI_BROTLI_TRANSIENT_BUFFER_FACTOR)
                * pt_serve::ops::poi_tile_cache::POI_TILE_BUILD_CONCURRENCY as u64
    } else {
        0
    };
    // The GTFS-RT poller term is CONDITIONAL in the same way, gated on a
    // non-empty `rt_trip_updates_urls`. Mirror its gating here too, for the
    // same reason: the bracket must track the real estimate, not the shape
    // the test config happens to have today.
    let rt_poller_overhead = if cfg.rt_urls().is_empty() {
        0
    } else {
        pt_serve::ops::rss_guard::RT_POLLER_PROCESS_FIXED_BYTES
            + cfg.rt_urls().len() as u64
                * pt_serve::ops::rss_guard::RT_POLLER_ASSUMED_MAX_ENTRIES_PER_FEED
                * pt_serve::ops::rss_guard::RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED
    };
    let overhead = cfg.process_fixed_overhead_bytes
        + ((cfg.worker_pool_size + cfg.loopback_worker_count) as u64
            + pt_serve::ops::rss_guard::AUXILIARY_WORKER_COUNT)
            * cfg.per_worker_overhead_bytes
        + cfg.schedule_tile_cache_max_bytes
        + cfg.rt_tile_membership_cache_max_entries
            * pt_serve::ops::rss_guard::RT_TILE_MEMBERSHIP_ENTRY_BYTES_ASSUMED
        + cfg.rt_tile_response_cache_max_entries
            * pt_serve::ops::rss_guard::RT_TILE_RESPONSE_ENTRY_BYTES_ASSUMED
        + poi_overhead
        + rt_poller_overhead;
    let max_rss = cfg.max_rss_bytes;

    // Sanity precondition: the default test config has enough headroom that
    // the three bracket points all stay positive. Surface a clear panic now
    // instead of an arithmetic underflow later.
    assert!(
        max_rss > overhead + 4096,
        "default_test_config must leave > 4 KiB headroom for the bracket points (overhead={overhead}, max_rss={max_rss})"
    );

    // ---- Point 1: payload = (max_rss
    // - OVERHEAD) / 2 + 1024
    //  → factor=2 estimate = 2 * (max_rss
    // - OVERHEAD)/2 + 2*1024 + OVERHEAD
    //                       = max_rss + ~2048 + slop  > max_rss   (rejects)
    //  → factor=1 estimate = (max_rss
    // - OVERHEAD)/2 + 1024 + OVERHEAD  <= max_rss (accepts)
    // i.e. p1 is above the f=2 boundary AND below the f=1 boundary.
    let p1 = (max_rss - overhead) / 2 + 1024;
    assert!(
        estimate_rss(&cfg, p1, 0) > max_rss,
        "factor=2 must reject p1 (estimate={}, limit={max_rss})",
        estimate_rss(&cfg, p1, 0),
    );
    // The bracket-below check: if a (hypothetical) factor=1 estimator were in
    // place, p1 would be accepted. The actual code is factor=2 so this check
    // is computed inline; it pins the LOWER bound on the factor.
    assert!(
        p1 + overhead <= max_rss,
        "factor=1 would accept p1 — pins factor >= 2 (p1={p1}, overhead={overhead}, max_rss={max_rss})"
    );

    // ---- Point 2: payload = (max_rss
    // - OVERHEAD) / 2 - 1024
    //  → factor=2 estimate = max_rss - ~2048  <= max_rss   (accepts)
    // Symmetric to p1; confirms the f=2 boundary is reached cleanly.
    let p2 = (max_rss - overhead) / 2 - 1024;
    assert!(
        estimate_rss(&cfg, p2, 0) <= max_rss,
        "factor=2 must accept p2 (estimate={}, limit={max_rss})",
        estimate_rss(&cfg, p2, 0),
    );

    // ---- Point 3: payload = (max_rss
    // - OVERHEAD) / 3 + 1024
    //  → factor=2 estimate = 2 * (max_rss-OVERHEAD)/3 + ~2048 + OVERHEAD
    //                       ≈ 2/3 max_rss + 1/3 OVERHEAD + ~2048  <= max_rss (accepts)
    //  → factor=3 estimate = 3 * (max_rss-OVERHEAD)/3 + ~3072 + OVERHEAD
    //                       = max_rss + ~3072  > max_rss   (rejects)
    let p3 = (max_rss - overhead) / 3 + 1024;
    assert!(
        estimate_rss(&cfg, p3, 0) <= max_rss,
        "factor=2 must accept p3 (estimate={}, limit={max_rss})",
        estimate_rss(&cfg, p3, 0),
    );
    // The bracket-above check: a (hypothetical) factor=3 estimator would
    // reject p3. The actual code is factor=2 so this is computed inline; it
    // pins the UPPER bound on the factor.
    assert!(
        3 * p3 + overhead > max_rss,
        "factor=3 would reject p3 — pins factor <= 2 (p3={p3}, overhead={overhead}, max_rss={max_rss})"
    );

    // The bracket is closed: factor=1 would accept p1 (rejected by f=2) AND
    // factor=3 would reject p3 (accepted by f=2). Only factor=2 satisfies
    // both. The `assert!` calls above did the real work; this final line is
    // documentation.
}

// ----------------------------------------------------------------------------
// Step 4 sidecars — sanity checks on the pure function.
// ----------------------------------------------------------------------------

/// The boundary case: zero payload, zero transfers, zero overhead, zero
/// workers → estimate is zero. Subtraction-bug guard for any future
/// refactor that adds a `- 1` somewhere.
#[test]
fn estimate_with_all_zeros_is_zero() {
    let (_dir, mut cfg, _clock) = common::isolated_config();
    cfg.process_fixed_overhead_bytes = 0;
    cfg.per_worker_overhead_bytes = 0;
    cfg.worker_pool_size = 1; // 0 would fail validate(); irrelevant to this test
    cfg.schedule_tile_cache_max_bytes = 0;
    cfg.rt_tile_membership_cache_max_entries = 0;
    cfg.rt_tile_response_cache_max_entries = 0;
    cfg.poi_bundle_max_decoded_bytes = 0;
    cfg.poi_tile_cache_max_entries = 0;
    cfg.poi_tile_cache_max_bytes = 0;
    assert_eq!(estimate_rss(&cfg, 0, 0), 0);
}

/// Monotonicity: a bigger payload → a bigger estimate. The factor and the
/// overhead are fixed, so the difference must equal `factor * delta`.
#[test]
fn estimate_is_monotone_in_payload() {
    let (_dir, cfg, _clock) = common::isolated_config();
    let a = estimate_rss(&cfg, 1_000_000, 0);
    let b = estimate_rss(&cfg, 2_000_000, 0);
    assert!(b > a);
    // Delta = 2 * (2M - 1M) = 2M (factor pinned by the bracketing test above).
    assert_eq!(b - a, 2 * 1_000_000);
}

// ----------------------------------------------------------------------------
// `enforce` accept/reject API tests.
// ----------------------------------------------------------------------------

#[test]
fn enforce_accept_returns_estimate_under_limit() {
    let (_dir, cfg, _clock) = common::isolated_config();
    // 1 MB payload, no transfers — well under the 1 GiB sentinel.
    match enforce_rss_budget(&cfg, 1_000_000, 0) {
        RssDecision::Accept { estimate_bytes } => {
            assert!(estimate_bytes <= cfg.max_rss_bytes);
        }
        RssDecision::Reject { .. } => panic!("expected accept"),
    }
}

#[test]
fn enforce_reject_carries_full_breakdown() {
    let (_dir, mut cfg, _clock) = common::isolated_config();
    cfg.max_rss_bytes = 1024; // absurdly small so the overhead alone busts it
    let payload = 2_000_000;
    let transfers = 1_000_000;
    match enforce_rss_budget(&cfg, payload, transfers) {
        RssDecision::Reject {
            estimate_bytes,
            limit_bytes,
            breakdown,
        } => {
            assert_eq!(limit_bytes, 1024);
            assert!(estimate_bytes > limit_bytes);
            assert_eq!(breakdown.payload_bytes, payload);
            assert_eq!(breakdown.transfers_bytes, transfers);
            assert_eq!(breakdown.payload_factor, 2);
            // The JSON contract: every camelCase field present at least once
            // and there's no rogue whitespace surrounding the numeric values.
            let json = breakdown.to_json();
            assert!(json.starts_with("{"));
            assert!(json.ends_with("}"));
            for needle in [
                "payloadBytes",
                "transfersBytes",
                "payloadFactor",
                "payloadTermBytes",
                "processFixedOverheadBytes",
                "workerPoolSize",
                "auxiliaryWorkerCount",
                "loopbackWorkerCount",
                "totalWorkerCount",
                "perWorkerOverheadBytes",
                "workersTermBytes",
                "scheduleTileCacheMaxBytes",
                "rtTileMembershipCacheTermBytes",
                "rtTileResponseCacheTermBytes",
                "poiBundleMaxDecodedBytes",
                "poiCityEntriesCacheMaxBytes",
                "poiCityEntriesRssFactor",
                "poiCityEntriesCacheTermBytes",
                "poiTileCacheMaxBytes",
                "poiTileCacheTermBytes",
                "poiBrotliBuildConcurrency",
                "poiBrotliScratchBytesPerBuild",
                "poiBrotliScratchTermBytes",
                "rtPollerFeedCount",
                "rtPollerProcessFixedBytes",
                "rtPollerAssumedMaxEntriesPerFeed",
                "rtPollerSnapshotEntryBytes",
                "rtPollerTermBytes",
            ] {
                assert!(json.contains(needle), "json missing {needle}: {json}");
            }
        }
        RssDecision::Accept { .. } => panic!("expected reject"),
    }
}
