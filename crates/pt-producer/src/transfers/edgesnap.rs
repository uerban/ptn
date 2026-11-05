//! Attach stops to nearby walking-graph EDGES — port of
//! scripts/lib/transfers/snapEdges.mjs. The two must stay arithmetically
//! identical (tests/transfers_differential.rs compares output bytes).
//!
//! A stop attaches to the closest point on each edge within the nearest
//! edge's distance + ATTACH_SLACK_METERS, at most MAX_ATTACHMENTS of them.
//! Each attachment splits its edge's walk time into offsets to both end
//! vertices, plus `link`: the straight walk from the stop onto the edge.
//! Several edges because the walking graph lacks sidewalks along roads it
//! does not contain, so the single nearest path is often on the far side.
//! Segment lookup uses a uniform grid whose cell is the snap radius (at
//! least MIN_CELL_METERS).
//! Candidates are ordered by (distance, edge index), so the grid's scan
//! order never changes the result.

use crate::error::{Error, Result};
use crate::transfers::graph::WalkingGraph;
use crate::transfers::kdtree::{EquirectProjection, KdTree2D, SkippedStop, Stop};
use std::collections::HashMap;

/// Most edges one stop attaches to.
pub const MAX_ATTACHMENTS: usize = 8;
/// Attach to edges up to this much farther than the nearest one.
pub const ATTACH_SLACK_METERS: f64 = 60.0;
/// Smallest grid cell. The cell is the snap radius, but every edge is
/// listed in each cell its bounding box touches, so a tiny radius would
/// list long edges in millions of cells.
const MIN_CELL_METERS: f64 = 50.0;

/// Undirected edge list: for each vertex u ascending, each CSR neighbor
/// v > u in CSR order. The edge index is the position here.
pub struct EdgeList {
    pub us: Vec<u32>,
    pub vs: Vec<u32>,
    pub ws: Vec<f64>,
}

pub fn list_edges(graph: &WalkingGraph) -> EdgeList {
    let mut edges = EdgeList {
        us: Vec::new(),
        vs: Vec::new(),
        ws: Vec::new(),
    };
    for u in 0..graph.node_count {
        let start = graph.offsets[u] as usize;
        let end = graph.offsets[u + 1] as usize;
        for i in start..end {
            let v = graph.neighbors[i];
            if v as usize <= u {
                continue;
            }
            edges.us.push(u as u32);
            edges.vs.push(v);
            edges.ws.push(graph.weights[i]);
        }
    }
    edges
}

/// Closest point on segment a-b to p: (t along a→b in [0, 1], squared
/// distance). Endpoints are returned exactly (no a + 1·(b−a) rounding), so
/// a stop on a shared vertex is distance 0 from every edge touching it.
pub fn point_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> (f64, f64) {
    let dx = bx - ax;
    let dy = by - ay;
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        ((px - ax) * dx + (py - ay) * dy) / len2
    } else {
        0.0
    };
    let (t, cx, cy) = if t <= 0.0 {
        (0.0, ax, ay)
    } else if t >= 1.0 {
        (1.0, bx, by)
    } else {
        (t, ax + t * dx, ay + t * dy)
    };
    let ex = px - cx;
    let ey = py - cy;
    (t, ex * ex + ey * ey)
}

/// One place a stop joins the walking graph.
#[derive(Debug, Clone)]
pub struct EdgeSnap {
    pub edge_idx: u32,
    pub u: u32,
    pub v: u32,
    /// Fraction along u→v, in [0, 1].
    pub t: f64,
    /// Walk seconds along the whole edge.
    pub w: f64,
    /// Walk seconds from the snap point to u.
    pub off_u: f64,
    /// Walk seconds from the snap point to v.
    pub off_v: f64,
    /// Walk seconds from the stop straight onto the edge.
    pub link: f64,
    /// Stop-to-attachment distance.
    pub snap_dist_meters: f64,
}

/// A stop's projected position and the places it joins the walking graph.
#[derive(Debug, Clone)]
pub struct StopSnap {
    /// Projected position, meters.
    pub x: f64,
    pub y: f64,
    /// Distance to the nearest edge.
    pub nearest_meters: f64,
    /// Nearest first; never empty.
    pub attachments: Vec<EdgeSnap>,
}

/// Port of snapStopsToEdges (snapEdges.mjs). Attachments per stop come
/// nearest first; a stop with no edge within max_snap_meters is skipped.
pub fn snap_stops_to_edges(
    stops: &[Stop],
    graph: &WalkingGraph,
    max_snap_meters: f64,
) -> Result<(HashMap<String, StopSnap>, Vec<SkippedStop>)> {
    if !max_snap_meters.is_finite() || max_snap_meters <= 0.0 {
        return Err(Error::Config(format!(
            "snap_stops_to_edges: max_snap_meters must be a positive finite number (got {max_snap_meters})"
        )));
    }
    let mut snapped = HashMap::new();
    let mut skipped = Vec::new();

    let edges = list_edges(graph);
    if edges.us.is_empty() {
        for s in stops {
            skipped.push(SkippedStop {
                stop_id: s.id.clone(),
                nearest_meters: None,
                reason: "empty-graph",
            });
        }
        return Ok((snapped, skipped));
    }

    let projection = EquirectProjection::from_nodes(&graph.lats, &graph.lons);
    let mut xs = Vec::with_capacity(graph.node_count);
    let mut ys = Vec::with_capacity(graph.node_count);
    for i in 0..graph.node_count {
        let (x, y) = projection.project(graph.lats[i], graph.lons[i]);
        xs.push(x);
        ys.push(y);
    }

    let cell = max_snap_meters.max(MIN_CELL_METERS);
    let mut grid: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
    for e in 0..edges.us.len() {
        let a = edges.us[e] as usize;
        let b = edges.vs[e] as usize;
        let x0 = (xs[a].min(xs[b]) / cell).floor() as i64;
        let x1 = (xs[a].max(xs[b]) / cell).floor() as i64;
        let y0 = (ys[a].min(ys[b]) / cell).floor() as i64;
        let y1 = (ys[a].max(ys[b]) / cell).floor() as i64;
        for cx in x0..=x1 {
            for cy in y0..=y1 {
                grid.entry((cx, cy)).or_default().push(e as u32);
            }
        }
    }

    let max_snap2 = max_snap_meters * max_snap_meters;
    let mut vertex_tree: Option<KdTree2D> = None; // built only if a stop is skipped

    // seen_by[e] = 1 + the index of the last stop that tested edge e; an
    // edge can sit in several of a stop's cells.
    let mut seen_by = vec![0u32; edges.us.len()];
    for (stop_no, stop) in (1u32..).zip(stops) {
        let (px, py) = projection.project(stop.lat, stop.lon);
        // (edge index, t, d2) within the radius.
        let mut found: Vec<(u32, f64, f64)> = Vec::new();
        let x0 = ((px - max_snap_meters) / cell).floor() as i64;
        let x1 = ((px + max_snap_meters) / cell).floor() as i64;
        let y0 = ((py - max_snap_meters) / cell).floor() as i64;
        let y1 = ((py + max_snap_meters) / cell).floor() as i64;
        for cx in x0..=x1 {
            for cy in y0..=y1 {
                let Some(bucket) = grid.get(&(cx, cy)) else {
                    continue;
                };
                for &e in bucket {
                    if seen_by[e as usize] == stop_no {
                        continue;
                    }
                    seen_by[e as usize] = stop_no;
                    let a = edges.us[e as usize] as usize;
                    let b = edges.vs[e as usize] as usize;
                    let (t, d2) = point_to_segment(px, py, xs[a], ys[a], xs[b], ys[b]);
                    if d2 <= max_snap2 {
                        found.push((e, t, d2));
                    }
                }
            }
        }

        if found.is_empty() {
            // Distance to the nearest vertex that has an edge, for
            // diagnostics. Never closer than the nearest edge, so it is
            // always past the radius. Vertices without edges are left out.
            let tree = vertex_tree.get_or_insert_with(|| edge_vertex_tree(graph, &xs, &ys));
            let (_, dist2) = tree.nearest(px, py);
            skipped.push(SkippedStop {
                stop_id: stop.id.clone(),
                nearest_meters: Some(dist2.sqrt()),
                reason: "out-of-range",
            });
            continue;
        }

        let mut ranked = found;
        ranked.sort_by(|p, q| p.2.total_cmp(&q.2).then(p.0.cmp(&q.0)));
        let limit = ranked[0].2.sqrt() + ATTACH_SLACK_METERS;
        let mut attachments = Vec::new();
        for (e, t, d2) in ranked {
            if attachments.len() == MAX_ATTACHMENTS {
                break;
            }
            let d = d2.sqrt();
            if d > limit {
                break;
            }
            let w = edges.ws[e as usize];
            attachments.push(EdgeSnap {
                edge_idx: e,
                u: edges.us[e as usize],
                v: edges.vs[e as usize],
                t,
                w,
                off_u: t * w,
                off_v: (1.0 - t) * w,
                link: d / graph.walk_speed_mps,
                snap_dist_meters: d,
            });
        }
        snapped.insert(
            stop.id.clone(),
            StopSnap {
                x: px,
                y: py,
                nearest_meters: attachments[0].snap_dist_meters,
                attachments,
            },
        );
    }

    Ok((snapped, skipped))
}

/// KD-tree over the vertices that have at least one edge.
fn edge_vertex_tree(graph: &WalkingGraph, xs: &[f64], ys: &[f64]) -> KdTree2D {
    let mut ex = Vec::new();
    let mut ey = Vec::new();
    for i in 0..graph.node_count {
        if graph.offsets[i + 1] > graph.offsets[i] {
            ex.push(xs[i]);
            ey.push(ys[i]);
        }
    }
    KdTree2D::build(ex, ey)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::transfers::graph::load_walking_graph;

    const M_PER_DEG: f64 = 111_319.49079327357;
    const LAT0: f64 = 54.68;
    const LON0: f64 = 25.28;

    /// East/north offset in meters from (LAT0, LON0).
    pub(crate) fn offset(north: f64, east: f64) -> (f64, f64) {
        (
            LAT0 + north / M_PER_DEG,
            LON0 + east / (LAT0.to_radians().cos() * M_PER_DEG),
        )
    }

    /// Graph from polylines given as (lat, lon) points.
    pub(crate) fn graph_from(lines: &[&[(f64, f64)]]) -> WalkingGraph {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("walking.geojsonseq");
        let mut body = String::new();
        for line in lines {
            let coords: Vec<String> = line
                .iter()
                .map(|(lat, lon)| format!("[{lon},{lat}]"))
                .collect();
            body.push_str(&format!(
                "\u{1e}{{\"type\":\"Feature\",\"geometry\":{{\"type\":\"LineString\",\"coordinates\":[{}]}}}}\n",
                coords.join(",")
            ));
        }
        std::fs::write(&path, body).unwrap();
        load_walking_graph(&path, 1.25).unwrap()
    }

    fn stop(id: &str, (lat, lon): (f64, f64)) -> Stop {
        Stop {
            id: id.into(),
            lat,
            lon,
        }
    }

    #[test]
    fn snaps_to_the_interior_of_a_long_segment() {
        // 400 m segment, stop 10 m off its midpoint: 200 m from either
        // vertex, so a vertex snap would reject it at 200 m.
        let g = graph_from(&[&[(LAT0, LON0), offset(0.0, 400.0)]]);
        let (snapped, skipped) =
            snap_stops_to_edges(&[stop("mid", offset(10.0, 200.0))], &g, 200.0).unwrap();
        assert!(skipped.is_empty());
        let hit = &snapped["mid"].attachments[0];
        assert!((hit.snap_dist_meters - 10.0).abs() < 0.5, "{hit:?}");
        assert!((hit.t - 0.5).abs() < 0.01, "{hit:?}");
        assert!((hit.off_u + hit.off_v - hit.w).abs() < 1e-9);
        assert_eq!(hit.w, g.weights[g.offsets[hit.u as usize] as usize]);
        assert_eq!(hit.link, hit.snap_dist_meters / 1.25);
    }

    #[test]
    fn past_the_segment_end_clamps_onto_the_endpoint() {
        let g = graph_from(&[&[(LAT0, LON0), offset(0.0, 100.0)]]);
        let (snapped, _) =
            snap_stops_to_edges(&[stop("beyond", offset(0.0, 130.0))], &g, 200.0).unwrap();
        let hit = &snapped["beyond"].attachments[0];
        let at_end = (hit.t == 1.0 && hit.off_v == 0.0) || (hit.t == 0.0 && hit.off_u == 0.0);
        assert!(at_end, "{hit:?}");
        assert!((hit.snap_dist_meters - 30.0).abs() < 0.5);
    }

    #[test]
    fn out_of_range_stop_is_skipped_with_a_distance() {
        let g = graph_from(&[&[(LAT0, LON0), offset(0.0, 100.0)]]);
        let (snapped, skipped) =
            snap_stops_to_edges(&[stop("far", offset(500.0, 50.0))], &g, 200.0).unwrap();
        assert!(snapped.is_empty());
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].stop_id, "far");
        assert_eq!(skipped[0].reason, "out-of-range");
        assert!(skipped[0].nearest_meters.unwrap() > 200.0);
    }

    #[test]
    fn empty_graph_skips_every_stop() {
        let g = graph_from(&[]);
        let (snapped, skipped) =
            snap_stops_to_edges(&[stop("s", (LAT0, LON0))], &g, 200.0).unwrap();
        assert!(snapped.is_empty());
        assert_eq!(skipped[0].reason, "empty-graph");
        assert_eq!(skipped[0].nearest_meters, None);
    }

    #[test]
    fn equidistant_attachments_are_ordered_by_edge_index() {
        // A-B-C; a stop on vertex B is distance 0 from both edges.
        let b = offset(0.0, 100.0);
        let g = graph_from(&[&[(LAT0, LON0), b, offset(0.0, 200.0)]]);
        let (snapped, _) = snap_stops_to_edges(&[stop("on-b", b)], &g, 200.0).unwrap();
        let hit = &snapped["on-b"].attachments[0];
        assert_eq!(hit.edge_idx, 0);
        assert_eq!(hit.snap_dist_meters, 0.0);
        assert_eq!(hit.t, 1.0);
    }

    fn east_west(north: f64, half: f64) -> [(f64, f64); 2] {
        [offset(north, -half), offset(north, half)]
    }

    #[test]
    fn attaches_to_every_edge_within_nearest_plus_slack() {
        // Paths 10 m, 65 m and 90 m north; slack 60 m keeps the first two.
        let (a, b, c) = (
            east_west(10.0, 50.0),
            east_west(65.0, 50.0),
            east_west(90.0, 50.0),
        );
        let g = graph_from(&[&a, &b, &c]);
        let (snapped, _) = snap_stops_to_edges(&[stop("s", (LAT0, LON0))], &g, 200.0).unwrap();
        let dists: Vec<i64> = snapped["s"]
            .attachments
            .iter()
            .map(|h| h.snap_dist_meters.round() as i64)
            .collect();
        assert_eq!(dists, vec![10, 65]);
    }

    #[test]
    fn keeps_at_most_max_attachments_nearest_first() {
        let lines: Vec<[(f64, f64); 2]> = (1..=MAX_ATTACHMENTS + 2)
            .map(|k| east_west(3.0 * k as f64, 20.0))
            .collect();
        let refs: Vec<&[(f64, f64)]> = lines.iter().map(|l| &l[..]).collect();
        let g = graph_from(&refs);
        let (snapped, _) = snap_stops_to_edges(&[stop("s", (LAT0, LON0))], &g, 200.0).unwrap();
        let hits = &snapped["s"].attachments;
        assert_eq!(hits.len(), MAX_ATTACHMENTS);
        assert!(hits
            .windows(2)
            .all(|w| w[0].snap_dist_meters <= w[1].snap_dist_meters));
    }

    #[test]
    fn records_position_and_nearest_edge_distance() {
        let g = graph_from(&[&[(LAT0, LON0), offset(0.0, 100.0)]]);
        let stops = [stop("a", offset(12.0, 50.0)), stop("b", offset(12.0, 53.0))];
        let (snapped, _) = snap_stops_to_edges(&stops, &g, 200.0).unwrap();
        let (a, b) = (&snapped["a"], &snapped["b"]);
        assert_eq!(a.nearest_meters, a.attachments[0].snap_dist_meters);
        assert!((a.nearest_meters - 12.0).abs() < 0.5);
        assert!(((b.x - a.x).hypot(b.y - a.y) - 3.0).abs() < 0.01);
    }

    #[test]
    fn rejects_a_snap_radius_that_is_not_a_positive_finite_number() {
        let g = graph_from(&[&[(LAT0, LON0), offset(0.0, 100.0)]]);
        for r in [0.0, -5.0, f64::NAN, f64::INFINITY] {
            let err = snap_stops_to_edges(&[stop("s", (LAT0, LON0))], &g, r).unwrap_err();
            assert!(
                err.to_string()
                    .contains("max_snap_meters must be a positive finite number"),
                "{err}"
            );
        }
    }

    #[test]
    fn finds_the_interior_of_an_edge_spanning_many_cells_west_of_the_origin() {
        // A 2 km edge with a 50 m radius spans ~40 cells; the stop is near
        // its middle, far from both endpoints, at negative projected x.
        let g = graph_from(&[
            &[offset(0.0, -3000.0), offset(0.0, -1000.0)],
            // Keeps the projection origin east of the long edge.
            &[offset(0.0, 3000.0), offset(0.0, 3010.0)],
        ]);
        let (snapped, skipped) =
            snap_stops_to_edges(&[stop("mid", offset(-20.0, -2000.0))], &g, 50.0).unwrap();
        assert!(skipped.is_empty());
        let hit = &snapped["mid"].attachments[0];
        assert!((hit.snap_dist_meters - 20.0).abs() < 0.5, "{hit:?}");
        assert!((hit.t - 0.5).abs() < 0.01, "{hit:?}");
    }

    #[test]
    fn skipped_stop_reports_the_nearest_vertex_that_has_an_edge() {
        // An isolated vertex sits 1 m from the stop; the only edge is 500 m
        // away. The isolated vertex must not be reported.
        let g = graph_from(&[
            &[offset(500.0, 0.0), offset(500.0, 100.0)],
            &[offset(1.0, 0.0)],
        ]);
        let (_, skipped) = snap_stops_to_edges(&[stop("s", (LAT0, LON0))], &g, 200.0).unwrap();
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].reason, "out-of-range");
        let d = skipped[0].nearest_meters.unwrap();
        assert!((d - 500.0).abs() < 1.0, "{d}");
    }

    #[test]
    fn graph_with_vertices_but_no_edges_skips_every_stop_as_empty_graph() {
        let g = graph_from(&[&[(LAT0, LON0)]]);
        assert_eq!(g.node_count, 1);
        let (snapped, skipped) =
            snap_stops_to_edges(&[stop("s", (LAT0, LON0))], &g, 200.0).unwrap();
        assert!(snapped.is_empty());
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].reason, "empty-graph");
        assert_eq!(skipped[0].nearest_meters, None);
    }
}
