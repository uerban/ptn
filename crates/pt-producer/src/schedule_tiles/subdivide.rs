//! Quadtree subdivision of an over-cap 6 km cell — port of subdivideCell.ts.
//! Best-effort: never fails on size; irreducible nodes emit as oversized
//! leaves. Termination: depth < max_depth AND >1 stop. Pre-order 0→3, empty
//! quadrants dropped, stop order preserved by filter. Each node compresses
//! at most once; the over-cap root's bytes are handed in precompressed by
//! bundle.rs (the double-compress fix). The Node yieldFn is dropped — this
//! is a batch producer step with no event loop to keep responsive.

use super::brotli_tile::TileCompressor;
use super::grid::{bisect_quadrant, quadrant_digit_for_point, schedule_cell_bounds, Bbox};
use super::inputs::TileInputs;
use super::tile::build_tile_for_cell;
use super::wire::encode_schedule_tile;

pub struct Leaf {
    /// "" (root), "2", "0-3" — quadtree path digits joined by '-'.
    pub suffix: String,
    pub bbox: Bbox,
    /// Stop indexes (into TileInputs.stops), parent order preserved.
    pub stops: Vec<usize>,
    pub bytes: Vec<u8>,
    pub compressed_bytes: usize,
    pub oversized: bool,
}

pub struct Precompressed {
    pub bytes: Vec<u8>,
    pub compressed_bytes: usize,
    pub uncompressed: usize,
}

pub struct SubdivideArgs<'a> {
    pub inputs: &'a TileInputs,
    pub cell_stops: &'a [usize],
    pub bundle_hash: &'a str,
    pub city_id: &'a str,
    pub cell_x: i32,
    pub cell_y: i32,
    pub precompressed_root: Option<Precompressed>,
}

pub fn subdivide_cell(
    args: SubdivideArgs<'_>,
    cap: usize,
    max_depth: usize,
    compressor: &dyn TileCompressor,
) -> Vec<Leaf> {
    let cell_bounds = schedule_cell_bounds(args.cell_x, args.cell_y);
    let mut leaves = Vec::new();
    let mut root = args.precompressed_root;
    recurse(
        args.inputs,
        args.bundle_hash,
        args.city_id,
        args.cell_stops.to_vec(),
        cell_bounds,
        &mut Vec::new(),
        cap,
        max_depth,
        compressor,
        &mut root,
        &mut leaves,
    );
    leaves
}

#[allow(clippy::too_many_arguments)]
fn recurse(
    inputs: &TileInputs,
    bundle_hash: &str,
    city_id: &str,
    stops: Vec<usize>,
    bbox: Bbox,
    digits: &mut Vec<u8>,
    cap: usize,
    max_depth: usize,
    compressor: &dyn TileCompressor,
    root: &mut Option<Precompressed>,
    leaves: &mut Vec<Leaf>,
) {
    let depth = digits.len();
    let suffix = digits
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join("-");

    let compress_node = |stops: &[usize], root: &mut Option<Precompressed>| -> Precompressed {
        if depth == 0 {
            if let Some(pre) = root.take() {
                return pre;
            }
        }
        // Leaves keep tileSize 6000 — the sub-edge lives only in the manifest
        // bbox (subdivideCell.ts compressNode).
        let tile = build_tile_for_cell(inputs, stops, bundle_hash, city_id, 6000);
        let json = encode_schedule_tile(&tile);
        let bytes = compressor.compress(&json);
        let compressed_bytes = bytes.len();
        Precompressed {
            bytes,
            compressed_bytes,
            uncompressed: json.len(),
        }
    };

    let can_split = depth < max_depth && stops.len() > 1;
    if can_split {
        let node = compress_node(&stops, root);
        // brotli only shrinks ⇒ uncompressed <= cap is a certain-fit
        // short-circuit (mirrors the TS condition order).
        if node.uncompressed <= cap || node.compressed_bytes <= cap {
            leaves.push(Leaf {
                suffix,
                bbox,
                stops,
                bytes: node.bytes,
                compressed_bytes: node.compressed_bytes,
                oversized: false,
            });
            return;
        }
        // Partition by quadrant — FILTER preserves parent order.
        let mut quadrants: [Vec<usize>; 4] = Default::default();
        for &si in &stops {
            let s = &inputs.stops[si];
            quadrants[quadrant_digit_for_point(&bbox, s.lat, s.lon) as usize].push(si);
        }
        for digit in 0u8..=3 {
            let child = std::mem::take(&mut quadrants[digit as usize]);
            if child.is_empty() {
                continue;
            }
            digits.push(digit);
            let child_bbox = bisect_quadrant(&bbox, digit);
            recurse(
                inputs,
                bundle_hash,
                city_id,
                child,
                child_bbox,
                digits,
                cap,
                max_depth,
                compressor,
                root,
                leaves,
            );
            digits.pop();
        }
        return;
    }

    let node = compress_node(&stops, root);
    let oversized = node.compressed_bytes > cap;
    leaves.push(Leaf {
        suffix,
        bbox,
        stops,
        bytes: node.bytes,
        compressed_bytes: node.compressed_bytes,
        oversized,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule_tiles::grid::MAX_SUBDIVISION_DEPTH;
    use crate::schedule_tiles::inputs::{TileInputs, TileRoute, TileService, TileStop, TileTrip};
    use std::cell::Cell;
    use std::collections::HashMap;

    /// Deterministic mock: "compressed" output == input (size == JSON size),
    /// so cap decisions depend only on tile JSON size — no brotli variance.
    struct Identity;
    impl TileCompressor for Identity {
        fn compress(&self, input: &[u8]) -> Vec<u8> {
            input.to_vec()
        }
    }

    /// Wraps a compressor and counts calls, so tests can assert a
    /// short-circuit path genuinely skipped compression (rather than merely
    /// re-deriving the same size).
    struct CountingCompressor {
        inner: Identity,
        calls: Cell<u32>,
    }
    impl TileCompressor for CountingCompressor {
        fn compress(&self, input: &[u8]) -> Vec<u8> {
            self.calls.set(self.calls.get() + 1);
            self.inner.compress(input)
        }
    }

    /// Midpoint of the digit-th child of `bbox` — guaranteed (by construction)
    /// to fall in that exact quadrant under `quadrant_digit_for_point`'s
    /// upper-closed tie-break, since `bisect_quadrant` and
    /// `quadrant_digit_for_point` share the same mid-lat/mid-lon split.
    fn quadrant_center(bbox: &Bbox, digit: u8) -> (f64, f64) {
        let child = bisect_quadrant(bbox, digit);
        (
            (child.min_lat + child.max_lat) / 2.0,
            (child.min_lon + child.max_lon) / 2.0,
        )
    }

    /// Build a TileInputs where `assignments[i] = (quadrant_digit, stop_id)`
    /// places stop `i` at the center of that quadrant of `bbox`, each stop on
    /// its own distinct trip+route+headsign (so per-stop JSON contribution is
    /// independent, letting tests derive caps from measured sizes instead of
    /// guessed magic numbers).
    fn build_quadrant_inputs(bbox: &Bbox, assignments: &[(u8, &str)]) -> TileInputs {
        let mut stops = Vec::new();
        let mut routes = Vec::new();
        let mut trips = Vec::new();
        let mut stop_times = Vec::new();
        for (i, (digit, id)) in assignments.iter().enumerate() {
            let (lat, lon) = quadrant_center(bbox, *digit);
            stops.push(TileStop {
                id: (*id).to_string(),
                lat,
                lon,
            });
            routes.push(TileRoute {
                route_id: format!("R{i}"),
                short_name: format!("{i}"),
                long_name: format!("Route {i}"),
                route_color: "FF0000".into(),
                route_type: 3,
            });
            trips.push(TileTrip {
                trip_id: format!("T{i}"),
                route_idx: i as u32,
                service_idx: 0,
                headsign: format!("Headsign {i}"),
            });
            stop_times.push((vec![i as u32], vec![28_800 + i as u32]));
        }
        TileInputs {
            stops,
            trips,
            routes,
            services: vec![TileService {
                service_id: "svc:0".into(),
                added: vec![],
            }],
            stop_times,
            route_styles: HashMap::new(),
        }
    }

    /// Single stop with several departures on one trip — used by the
    /// irreducible-leaf and coincident-stop tests below.
    fn single_trip_inputs(stops: Vec<TileStop>, departures_per_stop: usize) -> TileInputs {
        let mut stop_times = Vec::with_capacity(stops.len());
        for _ in &stops {
            let trip_col = vec![0u32; departures_per_stop];
            let dep_col: Vec<u32> = (0..departures_per_stop as u32)
                .map(|i| 28_800 + i)
                .collect();
            stop_times.push((trip_col, dep_col));
        }
        TileInputs {
            stops,
            trips: vec![TileTrip {
                trip_id: "T0".into(),
                route_idx: 0,
                service_idx: 0,
                headsign: "H".into(),
            }],
            routes: vec![TileRoute {
                route_id: "R0".into(),
                short_name: "1".into(),
                long_name: "One".into(),
                route_color: "FF0000".into(),
                route_type: 3,
            }],
            services: vec![TileService {
                service_id: "svc:0".into(),
                added: vec![],
            }],
            stop_times,
            route_styles: HashMap::new(),
        }
    }

    fn encoded_len(inputs: &TileInputs, cell_stops: &[usize]) -> usize {
        let tile = build_tile_for_cell(inputs, cell_stops, "h", "city", 6000);
        encode_schedule_tile(&tile).len()
    }

    #[test]
    fn splits_preorder_and_preserves_stop_order() {
        let bbox = schedule_cell_bounds(10, 5);
        // Non-alphabetical ids within a quadrant prove the split is a FILTER
        // over input order, not a re-sort by id or anything else. Digits 1
        // and 3 are unused, proving empty quadrants are dropped.
        let assignments = [
            (0u8, "Zulu"),
            (2u8, "Alpha"),
            (0u8, "Mike"),
            (0u8, "Bravo"),
            (2u8, "Quebec"),
        ];
        let inputs = build_quadrant_inputs(&bbox, &assignments);
        let cell_stops: Vec<usize> = (0..assignments.len()).collect();

        // Derive the cap from measured sizes (no magic numbers): the cap is
        // exactly the larger of the two child-quadrant tile sizes, which is
        // guaranteed to be smaller than the whole (superset) cell's tile,
        // since every extra stop/trip strictly adds JSON bytes.
        let quad0_stops = vec![0usize, 2, 3];
        let quad2_stops = vec![1usize, 4];
        let quad0_len = encoded_len(&inputs, &quad0_stops);
        let quad2_len = encoded_len(&inputs, &quad2_stops);
        let cap = quad0_len.max(quad2_len);
        let whole_len = encoded_len(&inputs, &cell_stops);
        assert!(
            whole_len > cap,
            "test fixture must make the whole-cell tile exceed the derived cap \
             (whole={whole_len}, cap={cap})"
        );

        let leaves = subdivide_cell(
            SubdivideArgs {
                inputs: &inputs,
                cell_stops: &cell_stops,
                bundle_hash: "h",
                city_id: "city",
                cell_x: 10,
                cell_y: 5,
                precompressed_root: None,
            },
            cap,
            MAX_SUBDIVISION_DEPTH,
            &Identity,
        );

        assert_eq!(leaves.len(), 2, "digits 1 and 3 (empty quadrants) dropped");
        // Pre-order digit-ascending: "0" before "2".
        assert_eq!(leaves[0].suffix, "0");
        assert_eq!(leaves[1].suffix, "2");
        // Filter preserves parent order — not sorted by id or index value.
        assert_eq!(leaves[0].stops, vec![0, 2, 3]);
        assert_eq!(leaves[1].stops, vec![1, 4]);
        assert!(!leaves[0].oversized);
        assert!(!leaves[1].oversized);
    }

    #[test]
    fn dense_cluster_in_one_top_level_quadrant_still_subdivides() {
        // Port of subdivideCell.test.ts:193 — the regression pin for the
        // too-strong `occupied > 1` guard: a dense district whose stops ALL
        // land in ONE first-level quadrant is NOT irreducible. Depth 0
        // descends into that quadrant (the bbox halves), and the cluster
        // separates across its sub-quadrants at depth 2 — it must NOT be
        // emitted as a single oversized leaf.
        let cell_bounds = schedule_cell_bounds(10, 5);
        // All 8 stops inside top-level quadrant 3 (NE), two per sub-quadrant.
        let sub_bbox = bisect_quadrant(&cell_bounds, 3);
        let assignments = [
            (0u8, "A0"),
            (0u8, "A1"),
            (1u8, "B0"),
            (1u8, "B1"),
            (2u8, "C0"),
            (2u8, "C1"),
            (3u8, "D0"),
            (3u8, "D1"),
        ];
        let inputs = build_quadrant_inputs(&sub_bbox, &assignments);
        // Sanity: every stop's top-level quadrant is 3.
        for s in &inputs.stops {
            assert_eq!(quadrant_digit_for_point(&cell_bounds, s.lat, s.lon), 3);
        }
        let cell_stops: Vec<usize> = (0..assignments.len()).collect();

        // Derived cap: the largest depth-2 (2-stop) group fits exactly; the
        // whole cell AND the depth-1 node (same 8 stops → same tile JSON)
        // are strict supersets, hence strictly bigger, hence both split.
        let groups: [Vec<usize>; 4] = [vec![0, 1], vec![2, 3], vec![4, 5], vec![6, 7]];
        let cap = groups
            .iter()
            .map(|g| encoded_len(&inputs, g))
            .max()
            .unwrap();
        let whole_len = encoded_len(&inputs, &cell_stops);
        assert!(
            whole_len > cap,
            "fixture must make the one-quadrant cluster exceed the derived cap \
             (whole={whole_len}, cap={cap})"
        );

        let leaves = subdivide_cell(
            SubdivideArgs {
                inputs: &inputs,
                cell_stops: &cell_stops,
                bundle_hash: "h",
                city_id: "city",
                cell_x: 10,
                cell_y: 5,
                precompressed_root: None,
            },
            cap,
            MAX_SUBDIVISION_DEPTH,
            &Identity,
        );

        assert!(
            leaves.len() > 1,
            "one-corner district must subdivide, not emit a single oversized leaf"
        );
        assert_eq!(leaves.len(), 4, "one leaf per occupied sub-quadrant");
        for leaf in &leaves {
            assert!(!leaf.oversized, "leaf {} must come under cap", leaf.suffix);
            assert!(leaf.compressed_bytes <= cap);
            assert!(
                leaf.suffix.starts_with("3-"),
                "every leaf descends through top quadrant 3, got {:?}",
                leaf.suffix
            );
            assert_eq!(leaf.suffix.split('-').count(), 2, "separates at depth 2");
        }
        // Pre-order 0→3 within the descended quadrant, parent stop order kept.
        assert_eq!(leaves[0].suffix, "3-0");
        assert_eq!(leaves[0].stops, vec![0, 1]);
        assert_eq!(leaves[3].suffix, "3-3");
        assert_eq!(leaves[3].stops, vec![6, 7]);
    }

    #[test]
    fn irreducible_single_stop_is_oversized_leaf() {
        let bbox = schedule_cell_bounds(10, 5);
        let mid_lat = (bbox.min_lat + bbox.max_lat) / 2.0;
        let mid_lon = (bbox.min_lon + bbox.max_lon) / 2.0;
        let inputs = single_trip_inputs(
            vec![TileStop {
                id: "MEGA".into(),
                lat: mid_lat,
                lon: mid_lon,
            }],
            50,
        );
        let cell_stops = vec![0usize];

        let leaves = subdivide_cell(
            SubdivideArgs {
                inputs: &inputs,
                cell_stops: &cell_stops,
                bundle_hash: "h",
                city_id: "city",
                cell_x: 10,
                cell_y: 5,
                precompressed_root: None,
            },
            1, // tiny cap — guaranteed over-cap regardless of encoder output
            MAX_SUBDIVISION_DEPTH,
            &Identity,
        );

        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].suffix, "");
        assert!(leaves[0].oversized);
        assert_eq!(leaves[0].stops, vec![0]);
    }

    #[test]
    fn max_depth_bounds_recursion_on_coincident_stops() {
        let bbox = schedule_cell_bounds(10, 5);
        // A non-round fractional position so it never lands exactly on a
        // bisection midpoint at any depth (which would make the "same
        // quadrant every level" assumption fragile).
        let lat = bbox.min_lat + 0.37 * (bbox.max_lat - bbox.min_lat);
        let lon = bbox.min_lon + 0.29 * (bbox.max_lon - bbox.min_lon);
        let stops = vec![
            TileStop {
                id: "C0".into(),
                lat,
                lon,
            },
            TileStop {
                id: "C1".into(),
                lat,
                lon,
            },
            TileStop {
                id: "C2".into(),
                lat,
                lon,
            },
        ];
        let inputs = single_trip_inputs(stops, 1);
        let cell_stops = vec![0usize, 1, 2];
        let max_depth = 3;

        let leaves = subdivide_cell(
            SubdivideArgs {
                inputs: &inputs,
                cell_stops: &cell_stops,
                bundle_hash: "h",
                city_id: "city",
                cell_x: 10,
                cell_y: 5,
                precompressed_root: None,
            },
            1, // tiny cap — never fits, forcing recursion to the backstop
            max_depth,
            &Identity,
        );

        assert_eq!(
            leaves.len(),
            1,
            "coincident stops never separate — one leaf"
        );
        assert!(leaves[0].oversized);
        assert_eq!(leaves[0].stops.len(), 3);
        let depth = if leaves[0].suffix.is_empty() {
            0
        } else {
            leaves[0].suffix.split('-').count()
        };
        assert_eq!(depth, max_depth, "recursion halts exactly at max_depth");
    }

    #[test]
    fn precompressed_root_reuse_skips_compression() {
        // buildBundle already compressed the whole cell once; when that root
        // fits under cap (uncompressed <= cap), subdivide_cell must emit it
        // as the sole leaf WITHOUT calling the compressor again — the
        // "double-compress fix". Assert via a counting wrapper.
        let bbox = schedule_cell_bounds(10, 5);
        let inputs = single_trip_inputs(
            vec![TileStop {
                id: "S0".into(),
                lat: (bbox.min_lat + bbox.max_lat) / 2.0,
                lon: (bbox.min_lon + bbox.max_lon) / 2.0,
            }],
            1,
        );
        let cell_stops = vec![0usize];
        let counting = CountingCompressor {
            inner: Identity,
            calls: Cell::new(0),
        };

        let precompressed_bytes = b"already-compressed-by-buildBundle".to_vec();
        let leaves = subdivide_cell(
            SubdivideArgs {
                inputs: &inputs,
                cell_stops: &cell_stops,
                bundle_hash: "h",
                city_id: "city",
                cell_x: 10,
                cell_y: 5,
                precompressed_root: Some(Precompressed {
                    bytes: precompressed_bytes.clone(),
                    compressed_bytes: precompressed_bytes.len(),
                    uncompressed: 1, // artificially "certainly fits"
                }),
            },
            usize::MAX, // cap is irrelevant — the root reuse short-circuits first
            MAX_SUBDIVISION_DEPTH,
            &counting,
        );

        assert_eq!(
            counting.calls.get(),
            0,
            "root bytes reused, never recompressed"
        );
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].suffix, "");
        assert_eq!(leaves[0].bytes, precompressed_bytes);
        assert!(!leaves[0].oversized);
    }
}
