//! Pass 3: `shapes.bin` encode bridge (Stage C).
//!
//! Maps the `Vec<ShapeGroup>` `parse_shapes_all` already produces (for the
//! JSON sidecar) into the crate-neutral `ShapeEncodeInput` view and calls the
//! shared `pt_shared::sidecar::encode_shapes_bin`. All wire-format logic lives
//! in `pt-shared` so the producer writer and pt-serve's Plan-C2b consumer
//! agree byte-for-byte. `shape_dist_traveled` is intentionally NOT carried on
//! the binary path (the JSON sidecar keeps it for `loadFromPtb.ts`); the
//! `/shapes/<id>` display contract does not surface it. Shape groups arrive in
//! ascending `shape_id` order (BTreeMap iteration in `pass2::shapes`), which
//! `encode_shapes_bin` requires for binary-search lookup.

use crate::error::{Error, Result};
use crate::sidecars::ShapeGroup;

/// Encode the parsed shape groups into the complete `shapes.bin` bytes.
///
/// Borrows each group's `(lat, lon)` into a per-shape `Vec<(f32, f32)>` (build-
/// time allocation; not a hot path), then hands crate-neutral
/// `ShapeEncodeInput` views to the shared encoder. `groups` must be in
/// ascending `shape_id` order (guaranteed by `parse_shapes_all`).
pub fn build_shapes_bin(
    groups: &[ShapeGroup],
    trips_intern_sha256: &[u8; 32],
    stops_intern_sha256: &[u8; 32],
) -> Result<Vec<u8>> {
    let coords: Vec<Vec<(f32, f32)>> = groups
        .iter()
        .map(|g| g.points.iter().map(|p| (p.lat, p.lon)).collect())
        .collect();
    let inputs: Vec<pt_shared::sidecar::ShapeEncodeInput<'_>> = groups
        .iter()
        .zip(&coords)
        .map(|(g, pts)| pt_shared::sidecar::ShapeEncodeInput {
            shape_id: &g.shape_id,
            points: pts,
            trip_ref_count: g.trip_ref_count,
        })
        .collect();
    pt_shared::sidecar::encode_shapes_bin(&inputs, trips_intern_sha256, stops_intern_sha256)
        .map_err(|e| Error::Config(format!("shapes-bin encode: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecars::ShapePoint;
    use pt_shared::sidecar::ShapesBin;

    fn pt(lat: f32, lon: f32) -> ShapePoint {
        // shape_dist_traveled is intentionally non-None here to prove the bridge
        // drops it (it is not carried on the binary path).
        ShapePoint {
            lat,
            lon,
            shape_dist_traveled: Some(1.0),
        }
    }

    #[test]
    fn bridge_encodes_parseable_shapes_bin() {
        let groups = vec![
            ShapeGroup {
                shape_id: "SH_A".into(),
                points: vec![pt(54.69, 25.28), pt(54.691, 25.281)],
                trip_ref_count: 2,
            },
            ShapeGroup {
                shape_id: "SH_B".into(),
                points: vec![pt(54.70, 25.30)],
                trip_ref_count: 1,
            },
        ];
        let trips = [7u8; 32];
        let stops = [8u8; 32];
        let bytes = build_shapes_bin(&groups, &trips, &stops).unwrap();
        let sb = ShapesBin::parse(&bytes, &trips, &stops).unwrap();
        assert_eq!(sb.num_shapes(), 2);
        assert_eq!(sb.lookup("SH_A"), Some(0));
        assert_eq!(sb.trip_ref_count(0), 2);
        let a = sb.points(0);
        assert_eq!(a.len(), 2);
        assert!((a[0].0 - 54.69).abs() < 1e-4);
        // Verify the second shape too — guards against an off-by-one that drops
        // the last shape from the index tables.
        assert_eq!(sb.lookup("SH_B"), Some(1));
        assert_eq!(sb.trip_ref_count(1), 1);
        let b = sb.points(1);
        assert_eq!(b.len(), 1);
        assert!((b[0].0 - 54.70).abs() < 1e-4);
    }

    #[test]
    fn bridge_handles_empty_shapes() {
        let bytes = build_shapes_bin(&[], &[0; 32], &[0; 32]).unwrap();
        let sb = ShapesBin::parse(&bytes, &[0; 32], &[0; 32]).unwrap();
        assert_eq!(sb.num_shapes(), 0);
    }
}
