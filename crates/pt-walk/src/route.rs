//! On-device walking router over a decoded PTWG graph.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::format::{attr_class, decode, FormatError, WayClass};
use crate::geo::{dist, Projection, Xy};
use crate::graph::WalkGraph;
use crate::snap::{attach, Attachment, SegmentGrid};

pub const DETOUR_FACTOR: f64 = 3.0;
pub const DETOUR_SLACK_M: f64 = 1000.0;
/// The straight-line shortcut (no search when the two points are closer
/// than their snap distances) only applies up to this length. Longer hops
/// go through the network, so a walk is never drawn across a river or a
/// railway just because both ends are far from any path.
pub const DIRECT_MAX_M: f64 = 50.0;
const MERGE_EPS_M: f64 = 0.01;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    Default,
    Wheelchair,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WalkPath {
    /// `(lat, lon)`; first and last are the query endpoints.
    pub points: Vec<(f64, f64)>,
    /// Attr per segment (`points.len() - 1`); `None` = link off the network.
    pub segments: Vec<Option<u32>>,
    pub seg_len: Vec<f64>,
    pub distance_m: f64,
    /// Per point: at a junction, the ways there the profile may take
    /// (the way arrived on included), at most 255; 0 for points inside a
    /// chain, attachment feet and the query endpoints. A point within
    /// 1 cm of the previous one is dropped with its count, so a foot that
    /// lands exactly on a junction stays 0 (as over the uncontracted graph).
    pub choices: Vec<u8>,
}

impl Profile {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "default" => Some(Self::Default),
            "wheelchair" => Some(Self::Wheelchair),
            _ => None,
        }
    }

    pub fn allows(self, attr: u32) -> bool {
        self.allows_class(attr_class(attr))
    }

    pub fn allows_class(self, class: WayClass) -> bool {
        !(self == Self::Wheelchair && class == WayClass::Steps)
    }
}

/// How the search reached a junction.
#[derive(Clone, Copy)]
enum Pred {
    /// Along the chain of source attachment `si`: from its foot to the
    /// segment end at chain point `k` (`far` = point `k + 1`), then on to
    /// point 0 (`at_end` = the chain's last point).
    Source { si: usize, far: bool, at_end: bool },
    /// Along a whole chain from junction `prev`.
    Chain {
        prev: u32,
        chain: u32,
        reversed: bool,
    },
}

#[derive(Clone, Copy)]
enum End {
    /// Both feet on one segment: straight along it.
    SameSegment { s: usize, d: usize },
    /// Both feet on one chain, from the source segment end `s_far` to the
    /// destination segment end `d_far`, without leaving the chain.
    SameChain {
        s: usize,
        d: usize,
        s_far: bool,
        d_far: bool,
    },
    /// Through junction `node`, then along the destination chain from its
    /// start (or end, `from_end`) to the destination segment end `d_far`.
    Node {
        node: u32,
        d: usize,
        from_end: bool,
        d_far: bool,
    },
}

#[derive(Clone, Copy)]
struct Item {
    f: f64,
    g: f64,
    node: u32,
}

impl PartialEq for Item {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}
impl Eq for Item {}
impl PartialOrd for Item {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Item {
    /// Reversed: `BinaryHeap` pops the smallest f, ties by smallest node.
    fn cmp(&self, o: &Self) -> Ordering {
        o.f.total_cmp(&self.f).then_with(|| o.node.cmp(&self.node))
    }
}

fn relax(
    state: &mut HashMap<u32, (f64, Pred)>,
    heap: &mut BinaryHeap<Item>,
    node: u32,
    g: f64,
    h: f64,
    pred: Pred,
) {
    if state.get(&node).is_none_or(|&(old, _)| g < old) {
        state.insert(node, (g, pred));
        heap.push(Item { f: g + h, g, node });
    }
}

/// Chain point indices `from` → `to` inclusive, either direction.
fn steps(from: u32, to: u32) -> impl Iterator<Item = u32> {
    (0..=from.abs_diff(to)).map(move |i| if from <= to { from + i } else { from - i })
}

pub struct WalkIndex {
    graph: WalkGraph,
    proj: Projection,
    grid: SegmentGrid,
}

fn valid_lat_lon((lat, lon): (f64, f64)) -> bool {
    lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0
}

impl WalkIndex {
    /// Fails only when the segment grid would exceed its size limits.
    pub fn new(graph: WalkGraph) -> Result<Self, FormatError> {
        let proj = Projection::for_graph(&graph);
        let grid = SegmentGrid::build(&graph, &proj)?;
        Ok(Self { graph, proj, grid })
    }

    /// `format::decode` then `new`.
    pub fn from_bytes(buf: &[u8]) -> Result<Self, FormatError> {
        Self::new(decode(buf)?)
    }

    pub fn graph(&self) -> &WalkGraph {
        &self.graph
    }

    pub fn projection(&self) -> &Projection {
        &self.proj
    }

    /// Bytes owned on the heap: graph plus segment grid.
    pub fn heap_bytes(&self) -> usize {
        self.graph.heap_bytes() + self.grid.heap_bytes()
    }

    fn jxy(&self, j: u32) -> Xy {
        self.proj.project_e7(self.graph.junction_e7(j))
    }

    /// Point `i` of chain `c`, projected.
    fn pxy(&self, c: u32, i: u32) -> Xy {
        self.proj.project_e7(self.graph.chain_point_e7(c, i))
    }

    fn seg_len(&self, a: &Attachment) -> f64 {
        dist(self.pxy(a.chain, a.k), self.pxy(a.chain, a.k + 1))
    }

    /// `g` plus the segment lengths from point `from` to point `to` of chain
    /// `c`, added one by one in walking order: the sum an uncontracted
    /// search builds node by node, bit for bit.
    fn fold(&self, c: u32, from: u32, to: u32, mut g: f64) -> f64 {
        let mut it = steps(from, to);
        let Some(first) = it.next() else { return g };
        let mut prev = self.pxy(c, first);
        for i in it {
            let p = self.pxy(c, i);
            g += dist(prev, p);
            prev = p;
        }
        g
    }

    fn straight(from: (f64, f64), to: (f64, f64), d: f64) -> WalkPath {
        WalkPath {
            points: vec![from, to],
            segments: vec![None],
            seg_len: vec![d],
            distance_m: d,
            choices: vec![0, 0],
        }
    }

    /// Ways at junction `j` that `profile` may take, clamped to 255.
    fn choices(&self, j: u32, profile: Profile) -> u8 {
        let n = self
            .graph
            .half_chains(j)
            .filter(|hc| profile.allows_class(self.graph.chain_class(hc.chain)))
            .count();
        n.min(255) as u8
    }

    /// Walking path `from` → `to`, both `(lat, lon)`.
    /// `None` when either point is not a finite latitude/longitude.
    ///
    /// A* over junctions. Chains are walked point by point, so every cost is
    /// the same floating-point sum a search over the uncontracted graph
    /// would compute; attachments seed and finish inside chains.
    ///
    /// Results are deterministic. In exact-tie cases (an endpoint exactly on
    /// a node or a segment end) the first or last link may carry a different
    /// attr than earlier versions reported; distances and points are
    /// unaffected in practice.
    pub fn route(&self, from: (f64, f64), to: (f64, f64), profile: Profile) -> Option<WalkPath> {
        if !valid_lat_lon(from) || !valid_lat_lon(to) {
            return None;
        }
        let pf = self.proj.project(from.0, from.1);
        let pt = self.proj.project(to.0, to.1);
        let straight = dist(pf, pt);
        let allow = |a: u32| profile.allows(a);
        let src = attach(&self.graph, &self.proj, &self.grid, pf, allow);
        let dst = attach(&self.graph, &self.proj, &self.grid, pt, allow);
        if src.is_empty() || dst.is_empty() {
            return None;
        }
        if straight <= src[0].dist + dst[0].dist && straight <= DIRECT_MAX_M {
            return Some(Self::straight(from, to, straight));
        }
        let limit = straight * DETOUR_FACTOR + DETOUR_SLACK_M;

        // Foot → segment end costs: (near end at point k, far end at k + 1).
        let seeds: Vec<(f64, f64)> = src
            .iter()
            .map(|s| {
                let (near, far) = s.parts(self.seg_len(s));
                (s.dist + near, s.dist + far)
            })
            .collect();
        let finish: Vec<(f64, f64)> = dst
            .iter()
            .map(|d| {
                let (near, far) = d.parts(self.seg_len(d));
                (near + d.dist, far + d.dist)
            })
            .collect();

        let mut best: Option<(f64, End)> = None;
        let offer = |best: &mut Option<(f64, End)>, c: f64, end: End| {
            if best.is_none_or(|(b, _)| c < b) {
                *best = Some((c, end));
            }
        };
        for (si, s) in src.iter().enumerate() {
            for (di, d) in dst.iter().enumerate() {
                if s.seg == d.seg {
                    let c = s.dist + dist(s.point, d.point) + d.dist;
                    offer(&mut best, c, End::SameSegment { s: si, d: di });
                }
            }
        }
        for (si, s) in src.iter().enumerate() {
            for (di, d) in dst.iter().enumerate() {
                if s.chain != d.chain {
                    continue;
                }
                for (s_far, seed) in [(false, seeds[si].0), (true, seeds[si].1)] {
                    for (d_far, fin) in [(false, finish[di].0), (true, finish[di].1)] {
                        let i = s.k + u32::from(s_far);
                        let j = d.k + u32::from(d_far);
                        let c = self.fold(s.chain, i, j, seed) + fin;
                        let end = End::SameChain {
                            s: si,
                            d: di,
                            s_far,
                            d_far,
                        };
                        offer(&mut best, c, end);
                    }
                }
            }
        }

        let mut targets: HashMap<u32, Vec<(usize, bool)>> = HashMap::new();
        for (di, d) in dst.iter().enumerate() {
            let (a, b) = self.graph.chain_ends(d.chain);
            targets.entry(a).or_default().push((di, false));
            targets.entry(b).or_default().push((di, true));
        }

        let h = |x: u32| dist(self.jxy(x), pt);
        let mut state: HashMap<u32, (f64, Pred)> = HashMap::new();
        let mut heap = BinaryHeap::new();
        for (si, s) in src.iter().enumerate() {
            let (a, b) = self.graph.chain_ends(s.chain);
            let n = self.graph.chain_segments(s.chain);
            let (near, far) = seeds[si];
            for (at_end, j, end) in [(false, a, 0), (true, b, n)] {
                // The segment end on this side first, then the other one.
                let order = if at_end {
                    [(true, far), (false, near)]
                } else {
                    [(false, near), (true, far)]
                };
                for (is_far, seed) in order {
                    let g = self.fold(s.chain, s.k + u32::from(is_far), end, seed);
                    let pred = Pred::Source {
                        si,
                        far: is_far,
                        at_end,
                    };
                    relax(&mut state, &mut heap, j, g, h(j), pred);
                }
            }
        }

        while let Some(Item { f, g, node }) = heap.pop() {
            if state.get(&node).is_none_or(|&(gs, _)| g > gs) {
                continue;
            }
            if best.is_some_and(|(b, _)| f >= b) || f > limit {
                break;
            }
            if let Some(ends) = targets.get(&node) {
                for &(di, from_end) in ends {
                    let d = &dst[di];
                    let n = self.graph.chain_segments(d.chain);
                    // The segment end on this side, then on through the
                    // segment to the other one.
                    let (start, order) = if from_end {
                        (n, [(true, finish[di].1), (false, finish[di].0)])
                    } else {
                        (0, [(false, finish[di].0), (true, finish[di].1)])
                    };
                    for (d_far, fin) in order {
                        let at = self.fold(d.chain, start, d.k + u32::from(d_far), g);
                        let end = End::Node {
                            node,
                            d: di,
                            from_end,
                            d_far,
                        };
                        offer(&mut best, at + fin, end);
                    }
                }
            }
            for hc in self.graph.half_chains(node) {
                let c = hc.chain;
                if !profile.allows_class(self.graph.chain_class(c)) {
                    continue;
                }
                let (a, b) = self.graph.chain_ends(c);
                let n = self.graph.chain_segments(c);
                let (w, ng) = if hc.reversed {
                    (a, self.fold(c, n, 0, g))
                } else {
                    (b, self.fold(c, 0, n, g))
                };
                let pred = Pred::Chain {
                    prev: node,
                    chain: c,
                    reversed: hc.reversed,
                };
                relax(&mut state, &mut heap, w, ng, h(w), pred);
            }
        }

        let (total, end) = best?;
        if total > limit {
            return None;
        }

        // Path as (point, attr of the segment that ends there, choices).
        let mut walk: Vec<(Xy, Option<u32>, u8)> = Vec::new();
        let along =
            |walk: &mut Vec<(Xy, Option<u32>, u8)>, c: u32, from: u32, to: u32, skip_first| {
                let attr = Some(self.graph.chain_attr(c));
                let n = self.graph.chain_segments(c);
                let (a, b) = self.graph.chain_ends(c);
                for i in steps(from, to).skip(usize::from(skip_first)) {
                    let ch = match i {
                        0 => self.choices(a, profile),
                        i if i == n => self.choices(b, profile),
                        _ => 0,
                    };
                    walk.push((self.pxy(c, i), attr, ch));
                }
            };
        match end {
            End::SameSegment { s, d } => {
                walk.push((src[s].point, None, 0));
                walk.push((dst[d].point, Some(self.graph.chain_attr(src[s].chain)), 0));
            }
            End::SameChain { s, d, s_far, d_far } => {
                let (s, d) = (&src[s], &dst[d]);
                walk.push((s.point, None, 0));
                let (i, j) = (s.k + u32::from(s_far), d.k + u32::from(d_far));
                along(&mut walk, s.chain, i, j, false);
                walk.push((d.point, Some(self.graph.chain_attr(d.chain)), 0));
            }
            End::Node {
                node,
                d,
                from_end,
                d_far,
            } => {
                let mut chains = Vec::new();
                let mut cur = node;
                let (si, far, at_end) = loop {
                    match state[&cur].1 {
                        Pred::Source { si, far, at_end } => break (si, far, at_end),
                        Pred::Chain {
                            prev,
                            chain,
                            reversed,
                        } => {
                            chains.push((chain, reversed));
                            cur = prev;
                        }
                    }
                };
                chains.reverse();
                let s = &src[si];
                walk.push((s.point, None, 0));
                let n = self.graph.chain_segments(s.chain);
                let end = if at_end { n } else { 0 };
                along(&mut walk, s.chain, s.k + u32::from(far), end, false);
                for &(c, reversed) in &chains {
                    let n = self.graph.chain_segments(c);
                    let (i, j) = if reversed { (n, 0) } else { (0, n) };
                    along(&mut walk, c, i, j, true);
                }
                let d = &dst[d];
                let n = self.graph.chain_segments(d.chain);
                let start = if from_end { n } else { 0 };
                along(&mut walk, d.chain, start, d.k + u32::from(d_far), true);
                walk.push((d.point, Some(self.graph.chain_attr(d.chain)), 0));
            }
        }
        walk.push((pt, None, 0));
        let (xy, segs, choices) = merge_points(pf, walk);

        let mut points: Vec<(f64, f64)> =
            xy.iter().map(|&(x, y)| self.proj.unproject(x, y)).collect();
        points[0] = from;
        let last = points.len() - 1;
        if last == 0 {
            return Some(Self::straight(from, to, straight));
        }
        points[last] = to;
        let seg_len: Vec<f64> = xy.windows(2).map(|w| dist(w[0], w[1])).collect();
        let distance_m = seg_len.iter().sum();
        Some(WalkPath {
            points,
            segments: segs,
            seg_len,
            distance_m,
            choices,
        })
    }
}

/// `start` then the `walk` points at least `MERGE_EPS_M` from the last kept
/// one, with their attrs and choices. The query endpoints (first and last)
/// get 0 choices.
fn merge_points(
    start: Xy,
    walk: Vec<(Xy, Option<u32>, u8)>,
) -> (Vec<Xy>, Vec<Option<u32>>, Vec<u8>) {
    let mut xy: Vec<Xy> = vec![start];
    let mut segs: Vec<Option<u32>> = Vec::new();
    let mut choices: Vec<u8> = vec![0];
    for (p, seg, ch) in walk {
        if dist(*xy.last().unwrap(), p) >= MERGE_EPS_M {
            xy.push(p);
            segs.push(seg);
            choices.push(ch);
        }
    }
    choices[0] = 0;
    *choices.last_mut().unwrap() = 0;
    (xy, segs, choices)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{pack_attr, WayClass::*};
    use crate::testutil::{graph, ll};

    fn idx(segs: &[crate::testutil::Seg<'_>]) -> WalkIndex {
        WalkIndex::new(graph(segs)).unwrap()
    }

    fn go(index: &WalkIndex, from: (f64, f64), to: (f64, f64), p: Profile) -> Option<WalkPath> {
        index.route(ll(from.0, from.1), ll(to.0, to.1), p)
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.1
    }

    #[test]
    fn parses_profiles() {
        assert_eq!(Profile::parse("default"), Some(Profile::Default));
        assert_eq!(Profile::parse("wheelchair"), Some(Profile::Wheelchair));
        assert_eq!(Profile::parse("bicycle"), None);
    }

    #[test]
    fn follows_the_streets_around_a_corner() {
        let index = idx(&[
            ((0.0, 0.0), (100.0, 0.0), "A", Street),
            ((100.0, 0.0), (100.0, 100.0), "B", Street),
        ]);
        let r = go(&index, (0.0, -5.0), (105.0, 100.0), Profile::Default).expect("route");
        assert!(near(r.distance_m, 210.0), "{}", r.distance_m);
        assert_eq!(r.points.len(), 5);
        assert_eq!(
            r.segments,
            vec![
                None,
                Some(pack_attr(1, Street)),
                Some(pack_attr(2, Street)),
                None
            ]
        );
        assert_eq!(r.points[0], ll(0.0, -5.0));
        assert_eq!(*r.points.last().unwrap(), ll(105.0, 100.0));
        let sum: f64 = r.seg_len.iter().sum();
        assert!(near(sum, r.distance_m));
    }

    #[test]
    fn wheelchair_avoids_steps() {
        let index = idx(&[
            ((0.0, 0.0), (100.0, 0.0), "", Steps),
            ((0.0, 0.0), (0.0, 80.0), "S", Street),
            ((0.0, 80.0), (100.0, 80.0), "S", Street),
            ((100.0, 80.0), (100.0, 0.0), "S", Street),
        ]);
        let d = go(&index, (-5.0, 0.0), (105.0, 0.0), Profile::Default).unwrap();
        assert!(near(d.distance_m, 110.0), "{}", d.distance_m);
        assert!(d.segments.iter().flatten().any(|&a| attr_class(a) == Steps));
        let w = go(&index, (-5.0, 0.0), (105.0, 0.0), Profile::Wheelchair).unwrap();
        assert!(near(w.distance_m, 270.0), "{}", w.distance_m);
        assert!(!w.segments.iter().flatten().any(|&a| attr_class(a) == Steps));
    }

    #[test]
    fn short_hop_walks_straight() {
        let index = idx(&[((0.0, 0.0), (100.0, 0.0), "X", Path)]);
        let r = go(&index, (50.0, 40.0), (60.0, 40.0), Profile::Default).unwrap();
        assert_eq!(r.points.len(), 2);
        assert_eq!(r.segments, vec![None]);
        assert!(near(r.distance_m, 10.0));
    }

    #[test]
    fn long_hop_across_a_gap_takes_the_network() {
        // Two paths 150 m apart, joined only by a U. The points are 70 m
        // apart, each 40 m from its own path: within the snap shortcut
        // (70 <= 40 + 40) but over DIRECT_MAX_M, so the network is searched.
        // Each point is 110 m from the other path and from the connector,
        // beyond the attach slack, so the only walk is the U:
        // 40 + 110 + 150 + 110 + 40.
        let index = idx(&[
            ((0.0, 0.0), (160.0, 0.0), "A", Path),
            ((160.0, 0.0), (160.0, 150.0), "C", Path),
            ((160.0, 150.0), (0.0, 150.0), "B", Path),
        ]);
        let r = go(&index, (50.0, 40.0), (50.0, 110.0), Profile::Default).unwrap();
        assert!(near(r.distance_m, 450.0), "{r:?}");
        assert_eq!(r.points.len(), 6);
        assert_eq!(
            r.segments,
            vec![
                None,
                Some(pack_attr(1, Path)),
                Some(pack_attr(2, Path)),
                Some(pack_attr(3, Path)),
                None
            ]
        );
    }

    #[test]
    fn same_edge_walks_along_it() {
        let index = idx(&[((0.0, 0.0), (100.0, 0.0), "X", Path)]);
        let r = go(&index, (10.0, 5.0), (90.0, 5.0), Profile::Default).unwrap();
        assert!(near(r.distance_m, 90.0), "{}", r.distance_m);
        assert_eq!(r.segments, vec![None, Some(pack_attr(1, Path)), None]);
    }

    #[test]
    fn disconnected_components_have_no_route() {
        let index = idx(&[
            ((0.0, 0.0), (100.0, 0.0), "", Path),
            ((0.0, 400.0), (100.0, 400.0), "", Path),
        ]);
        assert_eq!(
            go(&index, (50.0, 5.0), (50.0, 395.0), Profile::Default),
            None
        );
    }

    #[test]
    fn far_from_the_network_has_no_route() {
        let index = idx(&[((0.0, 0.0), (100.0, 0.0), "", Path)]);
        assert_eq!(
            go(&index, (50.0, 300.0), (50.0, 5.0), Profile::Default),
            None
        );
    }

    #[test]
    fn huge_detours_are_refused() {
        let index = idx(&[
            ((0.0, 0.0), (0.0, -2000.0), "", Path),
            ((0.0, -2000.0), (200.0, -2000.0), "", Path),
            ((200.0, -2000.0), (200.0, 0.0), "", Path),
        ]);
        // 4210 m of walking for a 210 m gap > 210 × 3 + 1000.
        assert_eq!(
            go(&index, (-5.0, 0.0), (205.0, 0.0), Profile::Default),
            None
        );
    }

    #[test]
    fn routes_are_deterministic() {
        let index = idx(&[
            ((0.0, 0.0), (100.0, 0.0), "A", Street),
            ((100.0, 0.0), (100.0, 100.0), "B", Street),
        ]);
        let a = go(&index, (0.0, -5.0), (105.0, 100.0), Profile::Default);
        assert_eq!(a, go(&index, (0.0, -5.0), (105.0, 100.0), Profile::Default));
    }

    #[test]
    fn reports_heap_size() {
        let index = idx(&[((0.0, 0.0), (100.0, 0.0), "A", Street)]);
        assert_eq!(
            index.heap_bytes(),
            index.graph().heap_bytes() + index.grid.heap_bytes()
        );
        assert!(index.grid.heap_bytes() > 0);
    }

    #[test]
    fn rejects_non_finite_and_out_of_range_points() {
        let index = idx(&[((0.0, 0.0), (100.0, 0.0), "A", Street)]);
        let ok = ll(50.0, 5.0);
        for bad in [
            (f64::NAN, ok.1),
            (ok.0, f64::NAN),
            (f64::INFINITY, ok.1),
            (ok.0, f64::NEG_INFINITY),
            (1e12, ok.1),
            (ok.0, -1e12),
            (90.5, ok.1),
            (ok.0, 180.5),
        ] {
            assert_eq!(index.route(bad, ok, Profile::Default), None, "{bad:?}");
            assert_eq!(index.route(ok, bad, Profile::Default), None, "{bad:?}");
        }
        assert!(index.route(ok, ll(60.0, 5.0), Profile::Default).is_some());
    }

    #[test]
    fn attaches_mid_chain_with_both_ends_on_one_chain() {
        // One 4-segment chain bent into an L; both points snap to it, on
        // different segments, so the route stays on the chain.
        let index = idx(&[
            ((0.0, 0.0), (50.0, 0.0), "L", Path),
            ((50.0, 0.0), (100.0, 0.0), "L", Path),
            ((100.0, 0.0), (100.0, 50.0), "L", Path),
            ((100.0, 50.0), (100.0, 100.0), "L", Path),
        ]);
        let g = index.graph();
        assert_eq!((g.junction_count(), g.chain_count()), (2, 1));
        let r = go(&index, (25.0, -5.0), (105.0, 75.0), Profile::Default).unwrap();
        // Off-network legs to the (50, 0) and (100, 50) points beat the
        // perpendicular feet; in between the walk follows the chain and
        // never reaches its end junctions.
        assert!(near(r.distance_m, 150.99), "{r:?}");
        assert_eq!(r.points.len(), 5);
        assert_eq!(
            r.segments,
            vec![
                None,
                Some(pack_attr(1, Path)),
                Some(pack_attr(1, Path)),
                None
            ]
        );
        let corner = ll(100.0, 0.0);
        assert!((r.points[2].0 - corner.0).abs() < 1e-7 && (r.points[2].1 - corner.1).abs() < 1e-7);
    }

    #[test]
    fn attaches_exactly_at_an_interior_point() {
        let index = idx(&[
            ((0.0, 0.0), (100.0, 0.0), "A", Street),
            ((100.0, 0.0), (200.0, 0.0), "A", Street),
            ((200.0, 0.0), (200.0, 300.0), "B", Street),
        ]);
        // (100, 0) is interior to chain A; start on it exactly.
        let r = go(&index, (100.0, 0.0), (200.0, 250.0), Profile::Default).unwrap();
        assert!(near(r.distance_m, 350.0), "{}", r.distance_m);
        // The start is the foot: start, (200, 0), end.
        assert_eq!(r.points.len(), 3);
        assert_eq!(
            r.segments,
            vec![Some(pack_attr(1, Street)), Some(pack_attr(2, Street))]
        );
    }

    #[test]
    fn wheelchair_skips_a_steps_chain() {
        // Steps chain of 3 segments straight across; a street detour.
        let index = idx(&[
            ((0.0, 0.0), (30.0, 0.0), "", Steps),
            ((30.0, 0.0), (60.0, 0.0), "", Steps),
            ((60.0, 0.0), (100.0, 0.0), "", Steps),
            ((0.0, 0.0), (0.0, 80.0), "S", Street),
            ((0.0, 80.0), (100.0, 80.0), "S", Street),
            ((100.0, 80.0), (100.0, 0.0), "S", Street),
            ((0.0, 0.0), (-50.0, 0.0), "W", Street),
            ((100.0, 0.0), (150.0, 0.0), "E", Street),
        ]);
        let d = go(&index, (-45.0, 5.0), (145.0, 5.0), Profile::Default).unwrap();
        // Links straight to the Steps chain ends (2 × hypot(45, 5)) + 100.
        assert!(near(d.distance_m, 190.55), "{}", d.distance_m);
        assert!(d.segments.iter().flatten().all(|&a| attr_class(a) == Steps));
        let w = go(&index, (-45.0, 5.0), (145.0, 5.0), Profile::Wheelchair).unwrap();
        // Links to the street verticals at y = 5: 45 + 75 + 100 + 75 + 45.
        assert!(near(w.distance_m, 340.0), "{}", w.distance_m);
        assert!(!w.segments.iter().flatten().any(|&a| attr_class(a) == Steps));
    }

    #[test]
    fn counts_the_ways_on_at_each_junction_for_the_profile() {
        // One street bends at (100, 0), where stairs also leave north.
        let index = idx(&[
            ((0.0, 0.0), (100.0, 0.0), "A", Street),
            ((100.0, 0.0), (100.0, -100.0), "A", Street),
            ((100.0, 0.0), (100.0, 50.0), "", Steps),
        ]);
        let (from, to) = ((0.0, 5.0), (105.0, -100.0));
        let corner = |r: &WalkPath| {
            let c = ll(100.0, 0.0);
            let k = r
                .points
                .iter()
                .position(|p| (p.0 - c.0).abs() < 1e-7 && (p.1 - c.1).abs() < 1e-7)
                .expect("corner on the path");
            (k, r.choices[k])
        };
        let d = go(&index, from, to, Profile::Default).unwrap();
        assert_eq!(d.choices.len(), d.points.len());
        let (k, n) = corner(&d);
        assert_eq!(n, 3);
        assert!(d.choices.iter().enumerate().all(|(i, &c)| i == k || c < 3));
        let s = crate::steps::steps(&d);
        assert_eq!(s[1].turn, Some(crate::steps::Turn::Right), "{s:?}");
        // Stairs are no way on in a wheelchair: the bend is not a choice.
        let w = go(&index, from, to, Profile::Wheelchair).unwrap();
        assert_eq!(corner(&w).1, 2);
        assert_eq!(crate::steps::steps(&w).len(), 2, "depart + arrive");
    }

    #[test]
    fn routes_around_a_pure_cycle() {
        // A square ring of one attr has no natural junction: the anchor
        // stands in, and both ways round are searched.
        let index = idx(&[
            ((0.0, 0.0), (100.0, 0.0), "R", Path),
            ((100.0, 0.0), (100.0, 100.0), "R", Path),
            ((100.0, 100.0), (0.0, 100.0), "R", Path),
            ((0.0, 100.0), (0.0, 0.0), "R", Path),
        ]);
        assert_eq!(index.graph().junction_count(), 1);
        for (a, b, want) in [
            // Off-network legs to the nearest corner: 2 × hypot(50, 5).
            ((50.0, -5.0), (105.0, 50.0), 100.5),
            ((50.0, 105.0), (-5.0, 50.0), 100.5),
            ((95.0, -5.0), (-5.0, 95.0), 200.0),
        ] {
            let r = go(&index, a, b, Profile::Default).unwrap();
            assert!(near(r.distance_m, want), "{a:?}→{b:?}: {}", r.distance_m);
        }
    }

    /// The pre-contraction router over the build-side graph, kept as the
    /// reference: contraction must not change a single bit of any route.
    mod reference {
        use super::super::*;
        use crate::format::Graph;
        use crate::geo::point_to_segment;
        use crate::snap::{ATTACH_SLACK_M, MAX_ATTACHMENTS, MAX_SNAP_M};

        struct Att {
            h: usize,
            u: u32,
            v: u32,
            t: f64,
            point: Xy,
            dist: f64,
        }

        fn xy(g: &Graph, p: &Projection, u: u32) -> Xy {
            p.project_e7((g.lat_e7[u as usize], g.lon_e7[u as usize]))
        }

        fn attach(g: &Graph, proj: &Projection, p: Xy, profile: Profile) -> Vec<Att> {
            let mut c: Vec<Att> = Vec::new();
            for u in 0..g.node_count() as u32 {
                for h in g.neighbors_of(u) {
                    let v = g.neighbors[h];
                    if v > u && profile.allows(g.attrs[h]) {
                        let f = point_to_segment(p, xy(g, proj, u), xy(g, proj, v));
                        if f.dist <= MAX_SNAP_M {
                            c.push(Att {
                                h,
                                u,
                                v,
                                t: f.t,
                                point: f.point,
                                dist: f.dist,
                            });
                        }
                    }
                }
            }
            c.sort_by(|a, b| a.dist.total_cmp(&b.dist).then(a.h.cmp(&b.h)));
            if let Some(best) = c.first().map(|a| a.dist) {
                c.retain(|a| a.dist <= best + ATTACH_SLACK_M);
                c.truncate(MAX_ATTACHMENTS);
            }
            c
        }

        #[derive(Clone, Copy)]
        enum P {
            Src(usize),
            Edge(u32, usize),
        }

        pub fn route(
            g: &Graph,
            proj: &Projection,
            from: (f64, f64),
            to: (f64, f64),
            profile: Profile,
        ) -> Option<WalkPath> {
            let pf = proj.project(from.0, from.1);
            let pt = proj.project(to.0, to.1);
            let straight = dist(pf, pt);
            let src = attach(g, proj, pf, profile);
            let dst = attach(g, proj, pt, profile);
            if src.is_empty() || dst.is_empty() {
                return None;
            }
            if straight <= src[0].dist + dst[0].dist && straight <= DIRECT_MAX_M {
                return Some(WalkIndex::straight(from, to, straight));
            }
            let limit = straight * DETOUR_FACTOR + DETOUR_SLACK_M;
            let len = |a: &Att| dist(xy(g, proj, a.u), xy(g, proj, a.v));
            // (cost, same-edge (si, di) | through `node` to dst `di`).
            type Best = (f64, Option<(usize, usize)>, u32, usize);
            let mut best: Option<Best> = None;
            for (si, s) in src.iter().enumerate() {
                for (di, d) in dst.iter().enumerate() {
                    if s.h == d.h {
                        let c = s.dist + dist(s.point, d.point) + d.dist;
                        if best.is_none_or(|b| c < b.0) {
                            best = Some((c, Some((si, di)), 0, 0));
                        }
                    }
                }
            }
            let mut targets: HashMap<u32, Vec<(usize, f64)>> = HashMap::new();
            for (di, d) in dst.iter().enumerate() {
                let l = len(d);
                targets.entry(d.u).or_default().push((di, d.t * l + d.dist));
                targets
                    .entry(d.v)
                    .or_default()
                    .push((di, (1.0 - d.t) * l + d.dist));
            }
            let hh = |x: u32| dist(xy(g, proj, x), pt);
            let mut state: HashMap<u32, (f64, P)> = HashMap::new();
            let mut heap = BinaryHeap::new();
            let relax = |state: &mut HashMap<u32, (f64, P)>,
                         heap: &mut BinaryHeap<Item>,
                         n: u32,
                         gg: f64,
                         p: P| {
                if state.get(&n).is_none_or(|&(o, _)| gg < o) {
                    state.insert(n, (gg, p));
                    heap.push(Item {
                        f: gg + hh(n),
                        g: gg,
                        node: n,
                    });
                }
            };
            for (si, s) in src.iter().enumerate() {
                let l = len(s);
                relax(&mut state, &mut heap, s.u, s.dist + s.t * l, P::Src(si));
                relax(
                    &mut state,
                    &mut heap,
                    s.v,
                    s.dist + (1.0 - s.t) * l,
                    P::Src(si),
                );
            }
            while let Some(Item { f, g: gv, node }) = heap.pop() {
                if state.get(&node).is_none_or(|&(gs, _)| gv > gs) {
                    continue;
                }
                if best.is_some_and(|b| f >= b.0) || f > limit {
                    break;
                }
                if let Some(ends) = targets.get(&node) {
                    for &(di, c) in ends {
                        if best.is_none_or(|b| gv + c < b.0) {
                            best = Some((gv + c, None, node, di));
                        }
                    }
                }
                for h in g.neighbors_of(node) {
                    if !profile.allows(g.attrs[h]) {
                        continue;
                    }
                    let w = g.neighbors[h];
                    let ng = gv + dist(xy(g, proj, node), xy(g, proj, w));
                    relax(&mut state, &mut heap, w, ng, P::Edge(node, h));
                }
            }
            let (total, same, node, di) = best?;
            if total > limit {
                return None;
            }
            // Ways the profile allows at each node (see `junction_choices`).
            let ch = |u: u32| {
                let n = g
                    .neighbors_of(u)
                    .filter(|&h| profile.allows(g.attrs[h]))
                    .count();
                n.min(255) as u8
            };
            let mut walk: Vec<(Xy, Option<u32>, u8)> = Vec::new();
            if let Some((si, di)) = same {
                walk.push((src[si].point, None, 0));
                walk.push((dst[di].point, Some(g.attrs[src[si].h]), 0));
            } else {
                let mut nodes = vec![node];
                let mut edges = Vec::new();
                let mut cur = node;
                let si = loop {
                    match state[&cur].1 {
                        P::Src(si) => break si,
                        P::Edge(prev, h) => {
                            edges.push(h);
                            nodes.push(prev);
                            cur = prev;
                        }
                    }
                };
                nodes.reverse();
                edges.reverse();
                walk.push((src[si].point, None, 0));
                let n0 = nodes[0];
                walk.push((xy(g, proj, n0), Some(g.attrs[src[si].h]), ch(n0)));
                for (i, &h) in edges.iter().enumerate() {
                    let u = nodes[i + 1];
                    walk.push((xy(g, proj, u), Some(g.attrs[h]), ch(u)));
                }
                walk.push((dst[di].point, Some(g.attrs[dst[di].h]), 0));
            }
            walk.push((pt, None, 0));
            let (pts, segs, choices) = merge_points(pf, walk);
            let mut points: Vec<(f64, f64)> =
                pts.iter().map(|&(x, y)| proj.unproject(x, y)).collect();
            points[0] = from;
            let last = points.len() - 1;
            if last == 0 {
                return Some(WalkIndex::straight(from, to, straight));
            }
            points[last] = to;
            let seg_len: Vec<f64> = pts.windows(2).map(|w| dist(w[0], w[1])).collect();
            let distance_m = seg_len.iter().sum();
            Some(WalkPath {
                points,
                segments: segs,
                seg_len,
                distance_m,
                choices,
            })
        }
    }

    /// Choices as the steps code reads them: a node of degree 2 in the
    /// uncontracted graph may or may not be a junction of the contracted
    /// one (an attr change is), so counts below 3 are compared as 0. The
    /// second and second-to-last points (the attachment feet, unless merged
    /// away) are left out: a foot exactly on a junction is an exact tie, and
    /// the two routers walk it differently (one through the junction, one
    /// past it), as the route docs allow.
    fn junction_choices(p: &WalkPath) -> Vec<u8> {
        let n = p.choices.len();
        p.choices
            .iter()
            .enumerate()
            .map(|(i, &c)| if c >= 3 && i != 1 && i + 2 != n { c } else { 0 })
            .collect()
    }

    /// Bitwise route equality, `f64` compared by bits.
    fn same_bits(a: &Option<WalkPath>, b: &Option<WalkPath>) -> bool {
        match (a, b) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                let bits = |p: &WalkPath| {
                    (
                        p.points
                            .iter()
                            .map(|&(x, y)| (x.to_bits(), y.to_bits()))
                            .collect::<Vec<_>>(),
                        p.seg_len.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                        p.distance_m.to_bits(),
                    )
                };
                a.segments == b.segments
                    && bits(a) == bits(b)
                    && junction_choices(a) == junction_choices(b)
                    && a.choices.len() == a.points.len()
            }
            _ => false,
        }
    }

    #[test]
    fn matches_the_uncontracted_router_bit_for_bit() {
        use crate::build::GraphBuilder;
        use crate::format::{Graph, Meta};
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut rnd = move |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let classes = [Street, Path, Crossing, Steps];
        let (mut compared, mut routed, mut junctions) = (0, 0, 0);
        for _ in 0..30 {
            // A jittered 12 × 12 lattice with random gaps, random attrs per
            // way, and long same-attr runs so chains form.
            let mut b = GraphBuilder::new();
            let jitter = |r: &mut dyn FnMut(u64) -> u64| (r(9) as f64 - 4.0) * 1.5;
            let mut pts = vec![vec![(0.0, 0.0); 12]; 12];
            for (i, row) in pts.iter_mut().enumerate() {
                for (j, p) in row.iter_mut().enumerate() {
                    *p = (
                        j as f64 * 40.0 + jitter(&mut rnd),
                        i as f64 * 40.0 + jitter(&mut rnd),
                    );
                }
            }
            for i in 0..12 {
                for j in 0..12 {
                    for (di, dj) in [(0, 1), (1, 0)] {
                        let (ni, nj) = (i + di, j + dj);
                        if ni >= 12 || nj >= 12 || rnd(10) < 3 {
                            continue;
                        }
                        let name = ["", "A", "B"][rnd(3) as usize];
                        let class = classes[if rnd(4) == 0 { rnd(4) as usize } else { 1 }];
                        let (a, c) = (pts[i][j], pts[ni][nj]);
                        let (la, oa) = ll(a.0, a.1);
                        let (lc, oc) = ll(c.0, c.1);
                        b.add_line(&[(oa, la), (oc, lc)], name, class);
                    }
                }
            }
            let g: Graph = b.finish(Meta::default());
            let index = WalkIndex::new(crate::graph::WalkGraph::from_graph(&g).unwrap()).unwrap();
            let proj = *index.projection();
            assert!(index.graph().interior_count() > 0);
            for _ in 0..40 {
                let p =
                    |r: &mut dyn FnMut(u64) -> u64| ll(r(520) as f64 - 30.0, r(520) as f64 - 30.0);
                let (from, to) = (p(&mut rnd), p(&mut rnd));
                for profile in [Profile::Default, Profile::Wheelchair] {
                    let want = reference::route(&g, &proj, from, to, profile);
                    let got = index.route(from, to, profile);
                    assert!(
                        same_bits(&want, &got),
                        "{from:?} → {to:?} {profile:?}\nwant {want:?}\ngot  {got:?}"
                    );
                    compared += 1;
                    routed += usize::from(got.is_some());
                    junctions += got.as_ref().map_or(0, |p| {
                        junction_choices(p).iter().filter(|&&c| c > 0).count()
                    });
                }
            }
        }
        assert!(routed > compared / 2, "{routed} of {compared}");
        assert!(junctions > compared, "{junctions} junctions compared");
    }

    #[test]
    fn builds_from_bytes() {
        let g = crate::build::GraphBuilder::new().finish(Default::default());
        let index = WalkIndex::from_bytes(&crate::format::encode(&g)).unwrap();
        assert_eq!(index.graph().point_count(), 0);
        assert_eq!(
            index.route(ll(0.0, 0.0), ll(1.0, 0.0), Profile::Default),
            None
        );
        assert_eq!(
            WalkIndex::from_bytes(b"nope").err(),
            Some(FormatError::Truncated)
        );
    }
}
