//! Conditional-GET behaviour across a `Generation` swap.
//!
//! ETag and gzip caches MUST live on `Generation`, not on the process-scoped `ServerCtx`. After the
//! active generation is replaced via `gen_handle.store(new_gen)`, a client cached `If-None-Match:
//! <old-etag>` header must receive the NEW bytes (200 + new ETag), not a false 304 against the old
//! generation's still-cached state.
//!

use std::path::PathBuf;

#[path = "common/mod.rs"]
mod common;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

fn canary_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/canary.ptb")
}

#[test]
fn conditional_get_after_generation_swap_returns_new_bytes_not_304() {
    use pt_serve::app::bytes::raptor_bundle;
    use pt_serve::app::response::Resp;
    use pt_serve::{Generation, Metrics, ServerCtx};

    // Build two distinct generations from two distinct on-disk bundles. The
    // boundary-page ETag is content-derived → different bundles → different
    // ETags (precondition for the swap test to be meaningful).
    let gen_a = Generation::from_paths(
        &tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("gen_a builds from tiny.ptb");
    let gen_b = Generation::from_paths(
        &canary_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("gen_b builds from canary.ptb");

    let etag_a = gen_a.bundle_etag.clone();
    let etag_b = gen_b.bundle_etag.clone();
    assert_ne!(
        etag_a, etag_b,
        "fixtures must have distinct ETags for this test to be meaningful"
    );

    // Park gen_a in the ctx, sanity-check the conditional GET would 304 on it.
    // Each test owns its own `Arc<Metrics>` so counter assertions don't
    // cross-pollute under cargo's harness-default parallel execution.
    let dir = tempfile::TempDir::new().expect("tempdir");
    let ctx = ServerCtx::new(
        gen_a,
        common::default_test_config(dir.path().to_path_buf()),
        Metrics::new(),
    );
    let gen_now = ctx.current_generation();
    let resp = raptor_bundle(&gen_now, Some(etag_a.as_str()), false, "vilnius");
    assert!(
        matches!(resp, Resp::NotModified { .. }),
        "If-None-Match against the active generation's own ETag must yield 304"
    );
    drop(gen_now);

    // Swap to gen_b — this is what the reload runner will do via gen_handle.store(new_gen). The
    // Arc<ArcSwap<Generation>> drops the old generation as soon as no in-flight requests hold a
    // strong reference.
    ctx.gen_handle.store(std::sync::Arc::new(gen_b));

    // Now issue a conditional GET carrying the OLD generation's ETag. The
    // active generation's etag != old etag → must be 200 + new ETag, not 304.
    let gen_now = ctx.current_generation();
    let resp = raptor_bundle(&gen_now, Some(etag_a.as_str()), false, "vilnius");
    match resp {
        Resp::Bytes { etag, .. } => {
            assert_eq!(
                etag, etag_b,
                "post-swap response must carry the NEW generation's ETag"
            );
            assert_ne!(
                etag, etag_a,
                "post-swap response must NOT echo the stale client ETag"
            );
        }
        Resp::NotModified { .. } => {
            panic!(
                "FALSE 304: a client cached `If-None-Match: <old-etag>` after a swap must receive \
                 the new bytes (200), not a 304 — the ETag cache must live on Generation, not \
                 on the process-scoped ServerCtx"
            );
        }
        other => panic!(
            "unexpected response variant: {:?}",
            core::mem::discriminant(&other)
        ),
    }
}

/// Sanity guard: an `If-None-Match` match against the ACTIVE generation's own
/// ETag still returns 304 — the swap test above is testing the across-swap
/// case, not blanket conditional-GET breakage.
#[test]
fn conditional_get_against_active_generation_still_304s() {
    use pt_serve::app::bytes::raptor_bundle;
    use pt_serve::app::response::Resp;
    use pt_serve::Generation;

    let gen = Generation::from_paths(
        &tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("gen builds from tiny.ptb");
    let etag = gen.bundle_etag.clone();
    let resp = raptor_bundle(&gen, Some(etag.as_str()), false, "vilnius");
    assert!(
        matches!(resp, Resp::NotModified { .. }),
        "matching ETag on the active generation must 304"
    );
}
