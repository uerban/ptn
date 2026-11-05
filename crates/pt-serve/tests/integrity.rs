//! `bundle_namespace_shas` recomputes the bundle's Trips/Stops interner SHAs by
//! walking the Reader in record order. Round-trip: a shapes.bin whose header
//! carries those SHAs parses; a foreign-SHA one is rejected. (The "real producer
//! sorts == record order" guarantee is covered by the integration parity gate
//! over a producer-built generation, not this unit test.)
use std::path::PathBuf;

fn tiny_ptb() -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb"),
    )
    .expect("read tiny.ptb")
}

#[test]
fn recompute_is_deterministic_and_parse_round_trips() {
    let bytes = tiny_ptb();
    let reader = pt_core::Reader::from_bytes(bytes).expect("reader");
    let (trips_sha, stops_sha) =
        pt_serve::bundle::integrity::bundle_namespace_shas(&reader).expect("recompute");
    // Deterministic.
    let again = pt_serve::bundle::integrity::bundle_namespace_shas(&reader).unwrap();
    assert_eq!((trips_sha, stops_sha), again);

    // A shapes.bin whose header carries the recomputed SHAs parses clean.
    use pt_shared::sidecar::{encode_shapes_bin, ShapeEncodeInput, ShapesBin};
    let shapes = [ShapeEncodeInput {
        shape_id: "SH_A",
        points: &[(54.69, 25.28), (54.70, 25.29)],
        trip_ref_count: 1,
    }];
    let bin = encode_shapes_bin(&shapes, &trips_sha, &stops_sha).expect("encode");
    assert!(ShapesBin::parse(&bin, &trips_sha, &stops_sha).is_ok());

    // Foreign SHAs are rejected (mismatch).
    let foreign = encode_shapes_bin(&shapes, &[0u8; 32], &[0u8; 32]).expect("encode foreign");
    assert!(
        ShapesBin::parse(&foreign, &trips_sha, &stops_sha).is_err(),
        "a shapes.bin built against a foreign interner must not parse against the bundle SHAs"
    );
}
