//! Poll-reload shapes-hash advancement.
//!
//! Structural proof that the shapes hash pt-serve advertises (`/ready`'s
//! `servingShapesJsonSha256`) and serves (`/api/<city>/gtfs/shapes/shapes-<hash>.json`)
//! can never be stale-by-construction: both are read from the SAME live
//! `Generation.shapes_json_sha256`. After a poll-reload to a new generation
//! carrying a DIFFERENT `shapes.bin`, the live generation's
//! `shapes_json_sha256` ADVANCES to the new hash, so:
//!   - the OLD content-addressed `/shapes` request 404s (the gen no longer
//!     advertises that hash), and
//!   - the NEW one 200s.
//!
//! The two generations carry DISTINCT shapes payloads (different polyline
//! coordinates → different canonical `shapesJsonSha256`), so the advancement
//! assertion is non-trivial. The harness's initial generation is published
//! from `tiny.ptb` (with shapes payload "A"); the "new" generation is published
//! from `canary.ptb` (with shapes payload "B") so their `generation_id`s differ
//! and the reload is an actual adopt (not a no-op).

#[path = "common/mod.rs"]
mod common;

use common::{canary_ptb_path, publisher, reload_harness_with_shapes, tiny_ptb_path};
use pt_serve::app::response::Resp;
use pt_serve::app::shapes::shapes;
use pt_serve::reload::poll::poll_tick;
use std::sync::atomic::AtomicU64;

/// Mock-clock anchor shared with the rest of the reload corpus (see
/// [`common::RELOAD_HARNESS_ANCHOR`]). NOT the unix epoch — epoch fails the
/// `createdAt`-skew validator.
const ANCHOR: u64 = common::RELOAD_HARNESS_ANCHOR;

/// Polyline set "A": the initial generation's shapes.
fn shapes_a() -> Vec<publisher::OwnedShape> {
    vec![
        publisher::OwnedShape {
            shape_id: "SH_A".to_string(),
            points: vec![(54.69, 25.28), (54.691, 25.281), (54.692, 25.282)],
            trip_ref_count: 2,
        },
        publisher::OwnedShape {
            shape_id: "SH_B".to_string(),
            points: vec![(54.70, 25.30)],
            trip_ref_count: 1,
        },
    ]
}

/// Polyline set "B": the new generation's shapes — DIFFERENT coordinates and a
/// different point count from "A", so the canonical `shapesJsonSha256` differs.
fn shapes_b() -> Vec<publisher::OwnedShape> {
    vec![
        publisher::OwnedShape {
            shape_id: "SH_A".to_string(),
            points: vec![(48.85, 2.35), (48.851, 2.351)],
            trip_ref_count: 3,
        },
        publisher::OwnedShape {
            shape_id: "SH_B".to_string(),
            points: vec![(48.86, 2.36), (48.861, 2.361), (48.862, 2.362)],
            trip_ref_count: 4,
        },
    ]
}

#[test]
fn poll_reload_advances_served_shapes_hash_and_404s_the_old() {
    // ---- 1. Initial generation WITH shapes payload "A". ----
    // The interner SHAs in shapes.bin's header are recomputed from the SAME
    // source PTB (tiny.ptb), so the load-time X4 cross-check passes and
    // `build_generation` populates `shapes_json_sha256`.
    let shapes_a_bin = publisher::encode_test_shapes_bin_variant(&tiny_ptb_path(), &shapes_a());
    let h = reload_harness_with_shapes("vilnius", shapes_a_bin);

    let old_hash = h
        .gen_handle
        .load()
        .shapes_json_sha256
        .clone()
        .expect("initial generation must carry a shapes.bin hash");

    // ---- 2. New generation from canary.ptb WITH shapes payload "B". ----
    // canary.ptb → a distinct bundle SHA → a distinct generation_id, so the
    // reload is an actual adopt and not a pointer-unchanged no-op. shapes.bin
    // "B" is built against canary.ptb's interner so the new gen's X4 check
    // passes too.
    let shapes_b_bin = publisher::encode_test_shapes_bin_variant(&canary_ptb_path(), &shapes_b());
    let created_at = publisher::rfc3339_format(ANCHOR + 60);
    let new_id = publisher::publish_generation_with_artifacts(
        &h.data_root,
        "vilnius",
        &canary_ptb_path(),
        &created_at,
        &publisher::SidecarArtifacts {
            shapes_bin: Some(shapes_b_bin),
            ..Default::default()
        },
    );
    publisher::point_current_at(&h.data_root, "vilnius", &new_id, &created_at);

    let new_hash = publisher::manifest_shapes_json_sha256(&h.data_root, &new_id)
        .expect("new generation's manifest must record shapesJsonSha256");

    // ---- 3. Precondition: the two shapes payloads really are distinct. ----
    // If these were equal the advancement assertion below would be trivially
    // true (and the fixtures would be broken — fix them, don't weaken this).
    assert_ne!(
        old_hash, new_hash,
        "the two shapes.bin payloads must produce distinct shapesJsonSha256 \
         (else the advancement assertion is meaningless)"
    );

    // ---- 4. Poll-reload and assert the served hash advanced. ----
    let last_mtime = AtomicU64::new(0);
    poll_tick(&h.runner, &h.data_root, &last_mtime);

    let adopted = h.gen_handle.load();
    assert_eq!(
        adopted.generation_id, new_id,
        "poll must adopt the new generation"
    );
    assert_eq!(
        adopted.shapes_json_sha256.as_deref(),
        Some(new_hash.as_str()),
        "the live generation must serve the NEW shapes hash after reload"
    );
    assert_ne!(
        adopted.shapes_json_sha256.as_deref(),
        Some(old_hash.as_str()),
        "the live generation must NOT still serve the OLD shapes hash"
    );

    // ---- 5. HTTP-level proof over the post-reload generation. ----
    // The `/shapes` handler content-addresses by `gen.shapes_json_sha256`, so a
    // request for the OLD hash 404s (the gen no longer advertises it) and the
    // NEW hash 200s. This is the structural guarantee: the advertised hash and
    // the served body are the same field, so they can never diverge.
    let old_artifact = format!("shapes-{old_hash}.json");
    assert!(
        matches!(
            shapes(&adopted, &old_artifact, None, false),
            Resp::NotFoundEmpty
        ),
        "the OLD shapes hash must 404 after the reload advanced the generation"
    );

    let new_artifact = format!("shapes-{new_hash}.json");
    match shapes(&adopted, &new_artifact, None, false) {
        Resp::CachedBytes { status, etag, .. } => {
            assert_eq!(status, 200, "the NEW shapes hash must serve 200");
            assert_eq!(
                etag.as_deref(),
                Some(format!("\"{new_hash}\"").as_str()),
                "the 200 response's ETag must be the new shapes hash"
            );
        }
        _ => panic!("expected CachedBytes 200 for the new shapes hash"),
    }

    // The harness's _tmp backs data_root; keep it alive past the assertions.
    drop(h._tmp);
}
