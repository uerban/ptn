//! Dijkstra + per-stop candidate selection — port of dijkstra.mjs. The heap itself is NOT a
//! verbatim port; std::collections::BinaryHeap with Reverse gives min-heap behavior. Candidate
//! sort/truncate order ( 4) IS part of the contract.

use crate::transfers::edgesnap::StopSnap;
use crate::transfers::graph::WalkingGraph;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

/// Ordered f64 wrapper for the heap — walk-seconds are always finite and
/// non-negative in this domain (NaN never enters: haversine/graph.rs's
/// walk_speed_mps>0 guard and haversine's `.min(1.0)` clamp keep every
/// weight finite), so `total_cmp` gives the natural numeric order. Using
/// `total_cmp` rather than `partial_cmp().expect(...)` keeps this ordering
/// infallible — the NaN-can't-happen invariant stays documentation, not a
/// panic path.
#[derive(PartialEq)]
struct HeapKey(f64);
impl Eq for HeapKey {}
impl Ord for HeapKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}
impl PartialOrd for HeapKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Port of dijkstra (dijkstra.mjs). Returns node_idx -> walk_secs for
/// every node reached within max_walk_secs.
pub fn dijkstra(graph: &WalkingGraph, source_idx: u32, max_walk_secs: f64) -> HashMap<u32, f64> {
    dijkstra_from_seeds(graph, &[(source_idx, 0.0)], max_walk_secs)
}

/// Port of dijkstraFromSeeds (dijkstra.mjs): multi-source Dijkstra, each
/// seed `(node_idx, start_secs)`. Starts from a point inside an edge,
/// seeded at both ends. Seeds are kept even above max_walk_secs; only
/// expansion is capped.
pub fn dijkstra_from_seeds(
    graph: &WalkingGraph,
    seeds: &[(u32, f64)],
    max_walk_secs: f64,
) -> HashMap<u32, f64> {
    let mut search = SeedSearch::new(graph);
    for &(idx, secs) in seeds {
        search.seed(idx, secs);
    }
    while search.next(graph, max_walk_secs).is_some() {}
    search
        .touched
        .iter()
        .map(|&v| (v, search.dist[v as usize]))
        .collect()
}

/// Port of SeedSearch (dijkstra.mjs): Dijkstra over dense per-vertex
/// arrays, reusable across searches; only touched vertices are reset.
struct SeedSearch {
    dist: Vec<f64>,
    touched: Vec<u32>,
    heap: BinaryHeap<Reverse<(HeapKey, u32)>>,
}

impl SeedSearch {
    fn new(graph: &WalkingGraph) -> Self {
        Self {
            dist: vec![f64::INFINITY; graph.node_count],
            touched: Vec::new(),
            heap: BinaryHeap::new(),
        }
    }

    fn seed(&mut self, idx: u32, secs: f64) {
        let d = &mut self.dist[idx as usize];
        if secs < *d {
            if *d == f64::INFINITY {
                self.touched.push(idx);
            }
            *d = secs;
            self.heap.push(Reverse((HeapKey(secs), idx)));
        }
    }

    /// Smallest key still queued: no vertex left settles below it.
    fn peek_key(&self) -> f64 {
        self.heap
            .peek()
            .map_or(f64::INFINITY, |Reverse((HeapKey(k), _))| *k)
    }

    /// Settle and expand the next vertex; None when the queue is empty.
    fn next(&mut self, graph: &WalkingGraph, max_walk_secs: f64) -> Option<u32> {
        while let Some(Reverse((HeapKey(d), u))) = self.heap.pop() {
            if d > self.dist[u as usize] {
                continue; // stale heap entry
            }
            let base = graph.offsets[u as usize] as usize;
            let end = graph.offsets[u as usize + 1] as usize;
            for i in base..end {
                let v = graph.neighbors[i];
                let nd = d + graph.weights[i];
                if nd > max_walk_secs {
                    continue;
                }
                let dv = &mut self.dist[v as usize];
                if nd < *dv {
                    if *dv == f64::INFINITY {
                        self.touched.push(v);
                    }
                    *dv = nd;
                    self.heap.push(Reverse((HeapKey(nd), v)));
                }
            }
            return Some(u);
        }
        None
    }

    fn reset(&mut self) {
        for &v in &self.touched {
            self.dist[v as usize] = f64::INFINITY;
        }
        self.touched.clear();
        self.heap.clear();
    }
}

/// Port of TransferPricer (dijkstra.mjs): prices walks from one stop to
/// the others, built once per stop set. A stop's walk is the cheapest of
/// the straight walk (when the stops are no farther apart than the
/// shorter of their links), the walk along the graph (Dijkstra seeded at
/// both ends of every source attachment, then offset + link), and the
/// walk along one shared edge. Only stops attached at settled vertices,
/// on the source's edges, or in nearby grid cells are looked at, and the
/// search stops once the max_degree cheapest are certain. Keep the float
/// operations in the same order as the JS.
pub struct TransferPricer<'a> {
    graph: &'a WalkingGraph,
    stop_snaps: &'a [Option<StopSnap>],
    search: SeedSearch,
    att_stop: Vec<u32>,
    att_off_u: Vec<f64>,
    att_off_v: Vec<f64>,
    att_link: Vec<f64>,
    att_t: Vec<f64>,
    /// Vertex → attachment ends, CSR; an entry is attachment * 2 + (0 for
    /// the u end, 1 for the v end).
    vertex_start: Vec<u32>,
    vertex_ends: Vec<u32>,
    edge_atts: HashMap<u32, Vec<u32>>,
    cell: f64,
    grid: HashMap<(i64, i64), Vec<u32>>,
    best: Vec<f64>,
    touched_stops: Vec<u32>,
}

impl<'a> TransferPricer<'a> {
    pub fn new(graph: &'a WalkingGraph, stop_snaps: &'a [Option<StopSnap>]) -> Self {
        let total: usize = stop_snaps
            .iter()
            .flatten()
            .map(|s| s.attachments.len())
            .sum();
        let mut att_stop = Vec::with_capacity(total);
        let mut att_off_u = Vec::with_capacity(total);
        let mut att_off_v = Vec::with_capacity(total);
        let mut att_link = Vec::with_capacity(total);
        let mut att_t = Vec::with_capacity(total);
        let mut vertex_start = vec![0u32; graph.node_count + 1];
        let mut edge_atts: HashMap<u32, Vec<u32>> = HashMap::new();
        for (i, snap) in stop_snaps.iter().enumerate() {
            let Some(snap) = snap else { continue };
            for c in &snap.attachments {
                edge_atts
                    .entry(c.edge_idx)
                    .or_default()
                    .push(att_stop.len() as u32);
                att_stop.push(i as u32);
                att_off_u.push(c.off_u);
                att_off_v.push(c.off_v);
                att_link.push(c.link);
                att_t.push(c.t);
                vertex_start[c.u as usize + 1] += 1;
                vertex_start[c.v as usize + 1] += 1;
            }
        }
        for v in 0..graph.node_count {
            vertex_start[v + 1] += vertex_start[v];
        }
        let mut vertex_ends = vec![0u32; total * 2];
        let mut fill: Vec<u32> = vertex_start[..graph.node_count].to_vec();
        let mut a = 0u32;
        for snap in stop_snaps.iter().flatten() {
            for c in &snap.attachments {
                vertex_ends[fill[c.u as usize] as usize] = a * 2;
                fill[c.u as usize] += 1;
                vertex_ends[fill[c.v as usize] as usize] = a * 2 + 1;
                fill[c.v as usize] += 1;
                a += 1;
            }
        }

        let max_nearest = stop_snaps
            .iter()
            .flatten()
            .fold(0.0f64, |m, s| m.max(s.nearest_meters));
        let cell = max_nearest.max(50.0);
        let mut grid: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
        for (i, snap) in stop_snaps.iter().enumerate() {
            let Some(snap) = snap else { continue };
            let key = (
                (snap.x / cell).floor() as i64,
                (snap.y / cell).floor() as i64,
            );
            grid.entry(key).or_default().push(i as u32);
        }

        Self {
            graph,
            stop_snaps,
            search: SeedSearch::new(graph),
            att_stop,
            att_off_u,
            att_off_v,
            att_link,
            att_t,
            vertex_start,
            vertex_ends,
            edge_atts,
            cell,
            grid,
            best: vec![f64::INFINITY; stop_snaps.len()],
            touched_stops: Vec::new(),
        }
    }

    /// The max_degree cheapest walks from source_stop_idx within
    /// max_walk_secs, as (neighbor_idx, walk_secs) sorted by
    /// (walk_secs, neighbor_idx).
    pub fn transfers_from(
        &mut self,
        source_stop_idx: usize,
        max_walk_secs: f64,
        max_degree: usize,
    ) -> Vec<(u32, u32)> {
        let Some(src) = &self.stop_snaps[source_stop_idx] else {
            return Vec::new();
        };
        if max_degree == 0 {
            return Vec::new();
        }
        let graph = self.graph;
        let mut prices = Prices {
            source: source_stop_idx as u32,
            max_walk_secs,
            best: &mut self.best,
            touched: &mut self.touched_stops,
            // Stops whose walk rounds to each whole second; only kept for a
            // bounded max_walk_secs.
            hist: if max_walk_secs.is_finite() {
                vec![0u32; max_walk_secs.floor() as usize + 2]
            } else {
                Vec::new()
            },
            settled_up_to: -1,
            settled: 0,
        };

        // Straight across.
        let r = src.nearest_meters;
        let x0 = ((src.x - r) / self.cell).floor() as i64 - 1;
        let x1 = ((src.x + r) / self.cell).floor() as i64 + 1;
        let y0 = ((src.y - r) / self.cell).floor() as i64 - 1;
        let y1 = ((src.y + r) / self.cell).floor() as i64 + 1;
        for cx in x0..=x1 {
            for cy in y0..=y1 {
                let Some(list) = self.grid.get(&(cx, cy)) else {
                    continue;
                };
                for &i in list {
                    let Some(dst) = &self.stop_snaps[i as usize] else {
                        continue;
                    };
                    let dx = dst.x - src.x;
                    let dy = dst.y - src.y;
                    let direct = (dx * dx + dy * dy).sqrt();
                    if direct <= src.nearest_meters.min(dst.nearest_meters) {
                        prices.price(i, direct / graph.walk_speed_mps);
                    }
                }
            }
        }

        // Along a shared edge.
        for s in &src.attachments {
            for &a in &self.edge_atts[&s.edge_idx] {
                let a = a as usize;
                prices.price(
                    self.att_stop[a],
                    (s.t - self.att_t[a]).abs() * s.w + s.link + self.att_link[a],
                );
            }
        }

        // Along the graph.
        for s in &src.attachments {
            self.search.seed(s.u, s.link + s.off_u);
            self.search.seed(s.v, s.link + s.off_v);
        }
        loop {
            if !prices.hist.is_empty() {
                let floor = self.search.peek_key();
                while ((prices.settled_up_to + 1) as usize) < prices.hist.len()
                    && prices.settled_up_to as f64 + 1.5 <= floor
                {
                    prices.settled_up_to += 1;
                    prices.settled += prices.hist[prices.settled_up_to as usize] as usize;
                }
                if prices.settled >= max_degree {
                    break;
                }
            }
            let Some(u) = self.search.next(graph, max_walk_secs) else {
                break;
            };
            let du = self.search.dist[u as usize];
            let start = self.vertex_start[u as usize] as usize;
            let end = self.vertex_start[u as usize + 1] as usize;
            for &e in &self.vertex_ends[start..end] {
                let a = (e >> 1) as usize;
                let d = if e & 1 == 0 {
                    du + self.att_off_u[a] + self.att_link[a]
                } else {
                    du + self.att_off_v[a] + self.att_link[a]
                };
                prices.price(self.att_stop[a], d);
            }
        }

        let mut candidates: Vec<(u32, u32)> = Vec::new(); // (neighbor_idx, walk_secs rounded)
        for &t in self.touched_stops.iter() {
            let d = self.best[t as usize];
            if d <= max_walk_secs {
                candidates.push((t, d.round() as u32));
            }
            self.best[t as usize] = f64::INFINITY;
        }
        self.touched_stops.clear();
        self.search.reset();

        sort_and_truncate_candidates(candidates, max_degree)
    }
}

/// Per-source best walks and the early-stop count: how many stops round
/// to settled_up_to or less.
struct Prices<'p> {
    source: u32,
    max_walk_secs: f64,
    best: &'p mut [f64],
    touched: &'p mut Vec<u32>,
    hist: Vec<u32>,
    settled_up_to: i64,
    settled: usize,
}

impl Prices<'_> {
    fn price(&mut self, t: u32, d: f64) {
        if t == self.source {
            return;
        }
        let old = self.best[t as usize];
        if d >= old {
            return;
        }
        if old == f64::INFINITY {
            self.touched.push(t);
        }
        self.best[t as usize] = d;
        if self.hist.is_empty() || d > self.max_walk_secs {
            return;
        }
        let nb = d.round() as i64;
        if old <= self.max_walk_secs {
            let ob = old.round() as i64;
            if ob == nb {
                return;
            }
            self.hist[ob as usize] -= 1;
            if ob > self.settled_up_to && nb <= self.settled_up_to {
                self.settled += 1;
            }
        } else if nb <= self.settled_up_to {
            self.settled += 1;
        }
        self.hist[nb as usize] += 1;
    }
}

/// Port of buildTransfersFromStop (dijkstra.mjs): builds a TransferPricer
/// per call. For every stop of a set, build one TransferPricer and call
/// transfers_from instead.
pub fn build_transfers_from_stop(
    graph: &WalkingGraph,
    source_stop_idx: usize,
    stop_snaps: &[Option<StopSnap>],
    max_walk_secs: f64,
    max_degree: usize,
) -> Vec<(u32, u32)> {
    TransferPricer::new(graph, stop_snaps).transfers_from(
        source_stop_idx,
        max_walk_secs,
        max_degree,
    )
}

/// Sort candidates by (walk_secs, neighbor_idx) ascending and truncate to
/// max_degree — port of the sort/slice at dijkstra.mjs:281-282. Extracted
/// from build_transfers_from_stop so the tie-break comparator is testable
/// independently of the collection loop's inherent ascending-neighbor_idx
/// push order (which alone would mask a broken/missing secondary key —
/// see the tie test below).
fn sort_and_truncate_candidates(
    mut candidates: Vec<(u32, u32)>,
    max_degree: usize,
) -> Vec<(u32, u32)> {
    candidates.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    candidates.truncate(max_degree);
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfers::edgesnap::{EdgeSnap, StopSnap};
    use crate::transfers::graph::WalkingGraph;

    fn line_graph() -> WalkingGraph {
        // 0 --10s-- 1 --10s-- 2 --10s-- 3
        WalkingGraph {
            node_count: 4,
            edge_count: 3,
            lats: vec![0.0; 4],
            lons: vec![0.0; 4],
            offsets: vec![0, 1, 3, 5, 6],
            neighbors: vec![1, 0, 2, 1, 3, 2],
            weights: vec![10.0, 10.0, 10.0, 10.0, 10.0, 10.0],
            walk_speed_mps: 1.25,
        }
    }

    #[test]
    fn dijkstra_finds_shortest_distances_within_cap() {
        let g = line_graph();
        let dist = dijkstra(&g, 0, 25.0);
        assert_eq!(dist.get(&0), Some(&0.0));
        assert_eq!(dist.get(&1), Some(&10.0));
        assert_eq!(dist.get(&2), Some(&20.0));
        assert_eq!(dist.get(&3), None); // 30.0 > cap
    }

    /// Attachment at fraction `t` along line_graph edge `e` (= nodes
    /// e..e+1), `link` seconds off the edge.
    fn at(e: u32, t: f64, link: f64) -> EdgeSnap {
        let w = 10.0;
        EdgeSnap {
            edge_idx: e,
            u: e,
            v: e + 1,
            t,
            w,
            off_u: t * w,
            off_v: (1.0 - t) * w,
            link,
            snap_dist_meters: link * 1.25,
        }
    }

    /// Stop at projected (x, 0) with the given attachments, nearest first.
    fn stop_at(x: f64, attachments: Vec<EdgeSnap>) -> Option<StopSnap> {
        Some(StopSnap {
            x,
            y: 0.0,
            nearest_meters: attachments[0].snap_dist_meters,
            attachments,
        })
    }

    /// Stops far enough apart (1 km per unit of `e`, `t`) that the straight
    /// walk never applies.
    fn on_edge(e: u32, t: f64) -> Option<StopSnap> {
        stop_at(1000.0 * (e as f64 + t), vec![at(e, t, 0.0)])
    }

    #[test]
    fn build_transfers_from_stop_sorts_and_truncates() {
        let g = line_graph();
        // stops on nodes 0, 1, 2, 3
        let snaps = vec![
            on_edge(0, 0.0),
            on_edge(0, 1.0),
            on_edge(1, 1.0),
            on_edge(2, 1.0),
        ];
        let out = build_transfers_from_stop(&g, 0, &snaps, 900.0, 2);
        // reachable: s1@10s, s2@20s, s3@30s -- max_degree=2 keeps the 2 cheapest
        assert_eq!(out, vec![(1, 10), (2, 20)]);
    }

    #[test]
    fn skipped_source_returns_empty() {
        let g = line_graph();
        let snaps = vec![None, on_edge(0, 1.0)];
        let out = build_transfers_from_stop(&g, 0, &snaps, 900.0, 16);
        assert!(out.is_empty());
    }

    #[test]
    fn stops_on_the_same_edge_walk_along_it_plus_both_links() {
        // Both on edge 1-2; vertex snapping put both on one node (0 s).
        let g = line_graph();
        let snaps = vec![
            stop_at(0.0, vec![at(1, 0.4, 3.0)]),
            stop_at(500.0, vec![at(1, 0.6, 4.0)]),
        ];
        let out = build_transfers_from_stop(&g, 0, &snaps, 900.0, 16);
        assert_eq!(out, vec![(1, 9)]); // 2 along the edge + 3 + 4
    }

    #[test]
    fn stops_on_different_edges_route_from_both_snap_ends() {
        // s0 at 0.5 along 0-1, s1 at 0.5 along 2-3: 5 + 10 + 5 = 20 s.
        let g = line_graph();
        let snaps = vec![on_edge(0, 0.5), on_edge(2, 0.5)];
        let out = build_transfers_from_stop(&g, 0, &snaps, 900.0, 16);
        assert_eq!(out, vec![(1, 20)]);
    }

    #[test]
    fn cheapest_attachment_pair_wins() {
        // s0 attaches to edge 0 (near node 0, 1 s link) and edge 2 (near
        // node 3, 6 s link); s1 sits on node 3. Via edge 2: 6 + 1 = 7 s,
        // beating 1 + 1 + 20 = 22 s along the line.
        let g = line_graph();
        let snaps = vec![
            stop_at(0.0, vec![at(0, 0.1, 1.0), at(2, 0.9, 6.0)]),
            on_edge(2, 1.0),
        ];
        let out = build_transfers_from_stop(&g, 0, &snaps, 900.0, 16);
        assert_eq!(out, vec![(1, 7)]);
    }

    #[test]
    fn max_walk_secs_covers_the_whole_walk_including_links() {
        let g = line_graph();
        let snaps = vec![
            stop_at(0.0, vec![at(0, 0.5, 2.0)]),
            stop_at(500.0, vec![at(2, 0.5, 2.0)]),
        ];
        assert!(build_transfers_from_stop(&g, 0, &snaps, 23.0, 16).is_empty());
        assert_eq!(
            build_transfers_from_stop(&g, 0, &snaps, 24.0, 16),
            vec![(1, 24)]
        );
    }

    #[test]
    fn stops_on_the_same_spot_are_zero_seconds_apart() {
        let g = line_graph();
        let snaps = vec![
            stop_at(0.0, vec![at(1, 0.5, 8.0)]),
            stop_at(0.0, vec![at(1, 0.5, 8.0)]),
        ];
        assert_eq!(
            build_transfers_from_stop(&g, 0, &snaps, 900.0, 16),
            vec![(1, 0)]
        );
    }

    #[test]
    fn stops_closer_than_their_links_walk_straight_across() {
        // 8 m apart, each 20 m (16 s) off the graph: 8 m / 1.25 = 6.4 s.
        let g = line_graph();
        let snaps = vec![
            stop_at(0.0, vec![at(0, 0.5, 16.0)]),
            stop_at(8.0, vec![at(2, 0.5, 16.0)]),
        ];
        assert_eq!(
            build_transfers_from_stop(&g, 0, &snaps, 900.0, 16),
            vec![(1, 6)]
        );
    }

    #[test]
    fn no_straight_walk_beyond_the_shorter_link() {
        // 30 m apart; links 10 m (8 s) and 40 m (32 s), same edge point:
        // 30 m > 10 m, so the walk is 8 + 32 = 40 s, not 24 s straight.
        let g = line_graph();
        let snaps = vec![
            stop_at(0.0, vec![at(1, 0.5, 8.0)]),
            stop_at(30.0, vec![at(1, 0.5, 32.0)]),
        ];
        assert_eq!(
            build_transfers_from_stop(&g, 0, &snaps, 900.0, 16),
            vec![(1, 40)]
        );
    }

    #[test]
    fn seeds_keep_the_cheaper_of_two_on_one_vertex() {
        let g = line_graph();
        for seeds in [[(0, 9.0), (0, 4.0)], [(0, 4.0), (0, 9.0)]] {
            let dist = dijkstra_from_seeds(&g, &seeds, 900.0);
            assert_eq!(dist[&0], 4.0);
            assert_eq!(dist[&1], 14.0);
        }
    }

    #[test]
    fn a_seed_above_max_walk_is_kept_but_not_expanded() {
        let g = line_graph();
        let dist = dijkstra_from_seeds(&g, &[(0, 50.0)], 40.0);
        assert_eq!(dist[&0], 50.0);
        assert!(!dist.contains_key(&1));
    }

    #[test]
    fn a_stop_on_a_vertex_seeds_both_attachments_at_that_vertex() {
        // Source on vertex 1 (end of edge 0, start of edge 1); target on
        // vertex 3, two edges away.
        let g = line_graph();
        let snaps = vec![
            stop_at(0.0, vec![at(0, 1.0, 0.0), at(1, 0.0, 0.0)]),
            stop_at(5000.0, vec![at(2, 1.0, 0.0)]),
        ];
        assert_eq!(
            build_transfers_from_stop(&g, 0, &snaps, 900.0, 16),
            vec![(1, 20)]
        );
    }

    #[test]
    fn a_stop_found_later_that_rounds_to_the_same_second_still_wins_on_index() {
        // 0 --10 s-- 1 --0.3 s-- 2 --10 s-- 3. Source (stop 2) on vertex 0;
        // stop 1 on vertex 1 (10 s); stop 0 on vertex 2 (10.3 s, rounds to
        // 10). Stop 0 is settled later but ties at 10 s with the lower
        // index, so with max_degree 1 it is the answer.
        let g = WalkingGraph {
            weights: vec![10.0, 10.0, 0.3, 0.3, 10.0, 10.0],
            ..line_graph()
        };
        let on = |x: f64, e: u32, t: f64| {
            let mut c = at(e, t, 0.0);
            c.w = g.weights[2 * e as usize];
            c.off_u = t * c.w;
            c.off_v = (1.0 - t) * c.w;
            Some(StopSnap {
                x,
                y: 0.0,
                nearest_meters: 0.0,
                attachments: vec![c],
            })
        };
        let snaps = vec![on(300.0, 2, 0.0), on(200.0, 0, 1.0), on(0.0, 0, 0.0)];
        assert_eq!(
            build_transfers_from_stop(&g, 2, &snaps, 900.0, 1),
            vec![(0, 10)]
        );
    }

    /// The plain definition: every other stop priced from every term.
    fn reference(
        graph: &WalkingGraph,
        source: usize,
        snaps: &[Option<StopSnap>],
        max_walk_secs: f64,
        max_degree: usize,
    ) -> Vec<(u32, u32)> {
        let Some(src) = &snaps[source] else {
            return Vec::new();
        };
        let mut seeds = Vec::new();
        for s in &src.attachments {
            seeds.push((s.u, s.link + s.off_u));
            seeds.push((s.v, s.link + s.off_v));
        }
        let dist = dijkstra_from_seeds(graph, &seeds, max_walk_secs);
        let mut candidates = Vec::new();
        for (i, snap) in snaps.iter().enumerate() {
            let Some(dst) = snap else { continue };
            if i == source {
                continue;
            }
            let mut d = f64::INFINITY;
            let dx = dst.x - src.x;
            let dy = dst.y - src.y;
            let direct = (dx * dx + dy * dy).sqrt();
            if direct <= src.nearest_meters.min(dst.nearest_meters) {
                d = direct / graph.walk_speed_mps;
            }
            for c in &dst.attachments {
                if let Some(&du) = dist.get(&c.u) {
                    d = d.min(du + c.off_u + c.link);
                }
                if let Some(&dv) = dist.get(&c.v) {
                    d = d.min(dv + c.off_v + c.link);
                }
                for s in &src.attachments {
                    if s.edge_idx == c.edge_idx {
                        d = d.min((s.t - c.t).abs() * s.w + s.link + c.link);
                    }
                }
            }
            if d <= max_walk_secs {
                candidates.push((i as u32, d.round() as u32));
            }
        }
        sort_and_truncate_candidates(candidates, max_degree)
    }

    #[test]
    fn pricer_matches_the_plain_definition_on_random_grids() {
        use crate::transfers::edgesnap::{snap_stops_to_edges, tests::graph_from};
        use crate::transfers::kdtree::Stop;
        for seed in 1u64..=12 {
            // xorshift64*: deterministic, no dependency.
            let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
            let mut r = move || {
                state ^= state >> 12;
                state ^= state << 25;
                state ^= state >> 27;
                (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
            };
            let n = 8;
            let step = 0.0012;
            let mut pt = vec![vec![(0.0, 0.0); n]; n];
            for (i, row) in pt.iter_mut().enumerate() {
                for (j, p) in row.iter_mut().enumerate() {
                    *p = (
                        54.68 + i as f64 * step + (r() - 0.5) * 0.0004,
                        25.28 + j as f64 * step + (r() - 0.5) * 0.0004,
                    );
                }
            }
            let mut lines: Vec<[(f64, f64); 2]> = Vec::new();
            for i in 0..n {
                for j in 0..n {
                    if j + 1 < n && r() > 0.2 {
                        lines.push([pt[i][j], pt[i][j + 1]]);
                    }
                    if i + 1 < n && r() > 0.2 {
                        lines.push([pt[i][j], pt[i + 1][j]]);
                    }
                }
            }
            let refs: Vec<&[(f64, f64)]> = lines.iter().map(|l| &l[..]).collect();
            let g = graph_from(&refs);
            let span = step * (n - 1) as f64;
            let mut stops = Vec::new();
            for k in 0..60 {
                stops.push(Stop {
                    id: format!("r{k}"),
                    lat: 54.68 + r() * span,
                    lon: 25.28 + r() * span,
                });
            }
            for k in 0..6 {
                let (lat, lon) = pt[(r() * n as f64) as usize][(r() * n as f64) as usize];
                stops.push(Stop {
                    id: format!("v{k}"),
                    lat,
                    lon,
                });
            }
            for k in 0..6 {
                let b = &stops[(r() * 60.0) as usize];
                let lat = b.lat + if r() < 0.5 { 0.0 } else { 0.00003 };
                let lon = b.lon;
                stops.push(Stop {
                    id: format!("twin{k}"),
                    lat,
                    lon,
                });
            }
            stops.push(Stop {
                id: "far".into(),
                lat: 54.8,
                lon: 25.28,
            });
            let (snapped, _) = snap_stops_to_edges(&stops, &g, 120.0).unwrap();
            let snaps: Vec<Option<StopSnap>> =
                stops.iter().map(|s| snapped.get(&s.id).cloned()).collect();
            let mut pricer = TransferPricer::new(&g, &snaps);
            for (max_walk, max_degree) in [
                (900.0, 16),
                (900.0, 5),
                (900.0, 3),
                (900.0, 2),
                (900.0, 1),
                (900.0, 0),
                (150.5, 16),
                (900.0, 200),
            ] {
                for i in 0..snaps.len() {
                    assert_eq!(
                        pricer.transfers_from(i, max_walk, max_degree),
                        reference(&g, i, &snaps, max_walk, max_degree),
                        "seed {seed} source {i} max_walk {max_walk} max_degree {max_degree}"
                    );
                }
            }
        }
    }

    // NOTE: build_transfers_from_stop's collection loop always pushes
    // candidates in strictly ascending neighbor_idx order (it iterates
    // stop_snaps by position, never by graph structure), so a stable
    // sort produces the same result whether or not the (walk_secs,
    // neighbor_idx) secondary key is present -- no graph fixture routed
    // through build_transfers_from_stop can exercise the tiebreak. Test
    // sort_and_truncate_candidates directly instead, with candidates
    // pushed in the WRONG order relative to neighbor_idx, so the
    // secondary key is load-bearing for the assertion.
    #[test]
    fn tie_at_truncation_boundary_prefers_lower_neighbor_idx() {
        // Both tied at walk_secs=10; higher neighbor_idx (5) pushed first.
        // A sort keyed on walk_secs alone (stable) would keep (5, 10)
        // first since it appears first in insertion order -- only the
        // (walk_secs, neighbor_idx) two-key comparator promotes (2, 10).
        let candidates = vec![(5, 10), (2, 10)];
        let out = sort_and_truncate_candidates(candidates, 1);
        assert_eq!(out, vec![(2, 10)]); // neighbor_idx 2 wins the tie over 5
    }
}
