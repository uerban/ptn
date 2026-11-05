//! Uniform grid over segments, and attaching an off-network point to the edges
//! around it.

use crate::format::FormatError;
use crate::geo::{point_to_segment, Projection, Xy};
use crate::graph::WalkGraph;

pub const CELL_M: f64 = 100.0;
pub const MAX_SNAP_M: f64 = 250.0;
pub const ATTACH_SLACK_M: f64 = 60.0;
pub const MAX_ATTACHMENTS: usize = 8;
/// Absolute grid limits. A city is a few hundred cells a side; a graph whose
/// extent or edge lengths would need more is refused instead of allocated.
pub const MAX_GRID_CELLS: u64 = 1 << 22;
pub const MAX_GRID_ENTRIES: u64 = 1 << 24;
/// Proportional limits, so a tiny hostile file cannot buy a large grid:
/// at most `GRID_PER_ITEM` cells per point and entries per segment, plus
/// `GRID_ALLOWANCE`. Real cities use about 0.23 cells/point and 1.3
/// entries/segment.
pub const GRID_PER_ITEM: u64 = 4;
pub const GRID_ALLOWANCE: u64 = 1 << 16;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Attachment {
    /// Global segment id (`WalkGraph::segment_base(chain) + k`).
    pub seg: u32,
    pub chain: u32,
    /// The segment joins chain points `k` and `k + 1`.
    pub k: u32,
    /// The snap origin is point `k + 1` (see `WalkGraph::segment_flipped`).
    pub flipped: bool,
    /// Position of the foot point along origin → other end.
    pub t: f64,
    pub point: Xy,
    pub dist: f64,
}

impl Attachment {
    /// `(near, far)` foot-to-end lengths, for the ends at chain points `k`
    /// and `k + 1`, given the segment length `len`. Computed as `t * len`
    /// from the snap origin, so the values match an uncontracted graph.
    pub fn parts(&self, len: f64) -> (f64, f64) {
        let (from_origin, to_far) = (self.t * len, (1.0 - self.t) * len);
        if self.flipped {
            (to_far, from_origin)
        } else {
            (from_origin, to_far)
        }
    }
}

/// Cell of `p`. `as` saturates (NaN → 0), so any input gives some cell.
fn cell(p: Xy) -> (i32, i32) {
    ((p.0 / CELL_M).floor() as i32, (p.1 / CELL_M).floor() as i32)
}

/// Cell rectangle `(x0, y0, x1, y1)` covered by segment a-b's bounding box.
fn cell_box(a: Xy, b: Xy) -> (i32, i32, i32, i32) {
    let (x0, y0) = cell((a.0.min(b.0), a.1.min(b.1)));
    let (x1, y1) = cell((a.0.max(b.0), a.1.max(b.1)));
    (x0, y0, x1, y1)
}

/// Dense uniform grid over the graph's bounding box, in CSR form: the
/// segments listed in cell `i` are `entries[offsets[i]..offsets[i + 1]]`,
/// cells numbered row by row from `(x0, y0)`.
#[derive(Debug, Clone)]
pub struct SegmentGrid {
    x0: i32,
    y0: i32,
    w: u32,
    h: u32,
    offsets: Vec<u32>,
    entries: Vec<u32>,
}

impl SegmentGrid {
    /// Each segment is listed (by its global id) in every cell its bounding
    /// box touches, so the cell holding a segment's closest point to a query
    /// is always among the cells scanned around that query.
    pub fn build(g: &WalkGraph, proj: &Projection) -> Result<Self, FormatError> {
        let each = |f: &mut dyn FnMut(u32, (i32, i32, i32, i32))| {
            for c in 0..g.chain_count() as u32 {
                let base = g.segment_base(c);
                let mut a = proj.project_e7(g.chain_point_e7(c, 0));
                for k in 0..g.chain_segments(c) {
                    let b = proj.project_e7(g.chain_point_e7(c, k + 1));
                    f(base + k, cell_box(a, b));
                    a = b;
                }
            }
        };
        // Pass 1: extent and entry count, checked before any allocation.
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        let mut total = 0u64;
        each(&mut |_, (ax, ay, bx, by)| {
            x0 = x0.min(ax);
            y0 = y0.min(ay);
            x1 = x1.max(bx);
            y1 = y1.max(by);
            let span = (i64::from(bx) - i64::from(ax) + 1) * (i64::from(by) - i64::from(ay) + 1);
            total = total.saturating_add(span as u64);
        });
        if x0 > x1 {
            return Ok(Self {
                x0: 0,
                y0: 0,
                w: 0,
                h: 0,
                offsets: vec![0],
                entries: Vec::new(),
            });
        }
        let w = (i64::from(x1) - i64::from(x0) + 1) as u64;
        let h = (i64::from(y1) - i64::from(y0) + 1) as u64;
        let cells = w.saturating_mul(h);
        let max_cells = GRID_PER_ITEM * g.point_count() as u64 + GRID_ALLOWANCE;
        let max_entries = GRID_PER_ITEM * g.segment_count() as u64 + GRID_ALLOWANCE;
        if cells > MAX_GRID_CELLS.min(max_cells) || total > MAX_GRID_ENTRIES.min(max_entries) {
            return Err(FormatError::TooLarge("grid"));
        }
        let (w, h) = (w as u32, h as u32);
        let ncell = w as usize * h as usize;
        let at = |cx: i32, cy: i32| (cy - y0) as usize * w as usize + (cx - x0) as usize;

        // Pass 2: per-cell counts into offsets[i + 1].
        let mut offsets = vec![0u32; ncell + 1];
        each(&mut |_, (ax, ay, bx, by)| {
            for cx in ax..=bx {
                for cy in ay..=by {
                    offsets[at(cx, cy) + 1] += 1;
                }
            }
        });
        for i in 0..ncell {
            offsets[i + 1] += offsets[i];
        }
        // Pass 3: fill, using offsets[i] as cell i's cursor, then shift back.
        let mut entries = vec![0u32; total as usize];
        each(&mut |id, (ax, ay, bx, by)| {
            for cx in ax..=bx {
                for cy in ay..=by {
                    let i = at(cx, cy);
                    entries[offsets[i] as usize] = id;
                    offsets[i] += 1;
                }
            }
        });
        for i in (1..=ncell).rev() {
            offsets[i] = offsets[i - 1];
        }
        offsets[0] = 0;
        Ok(Self {
            x0,
            y0,
            w,
            h,
            offsets,
            entries,
        })
    }

    /// Segments listed in cell `(cx, cy)`; empty outside the grid.
    pub fn cell(&self, cx: i32, cy: i32) -> &[u32] {
        let dx = i64::from(cx) - i64::from(self.x0);
        let dy = i64::from(cy) - i64::from(self.y0);
        if dx < 0 || dy < 0 || dx >= i64::from(self.w) || dy >= i64::from(self.h) {
            return &[];
        }
        let i = dy as usize * self.w as usize + dx as usize;
        &self.entries[self.offsets[i] as usize..self.offsets[i + 1] as usize]
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn heap_bytes(&self) -> usize {
        self.offsets.capacity() * 4 + self.entries.capacity() * 4
    }
}

/// Segments to join `p` to the network. The result is sorted by distance,
/// and it is empty when nothing walkable lies within `MAX_SNAP_M`. `allow`
/// receives the chain attr.
pub fn attach(
    g: &WalkGraph,
    proj: &Projection,
    grid: &SegmentGrid,
    p: Xy,
    allow: impl Fn(u32) -> bool,
) -> Vec<Attachment> {
    let r = (MAX_SNAP_M / CELL_M).ceil() as i32;
    let (cx, cy) = cell(p);
    let mut seen: Vec<u32> = Vec::new();
    for dx in -r..=r {
        for dy in -r..=r {
            seen.extend_from_slice(grid.cell(cx.saturating_add(dx), cy.saturating_add(dy)));
        }
    }
    seen.sort_unstable();
    seen.dedup();
    let mut cands: Vec<Attachment> = seen
        .into_iter()
        .filter_map(|seg| {
            let (chain, k) = g.segment_chain(seg);
            if !allow(g.chain_attr(chain)) {
                return None;
            }
            let flipped = g.segment_flipped(seg);
            let near = proj.project_e7(g.chain_point_e7(chain, k));
            let far = proj.project_e7(g.chain_point_e7(chain, k + 1));
            let (a, b) = if flipped { (far, near) } else { (near, far) };
            let f = point_to_segment(p, a, b);
            Some(Attachment {
                seg,
                chain,
                k,
                flipped,
                t: f.t,
                point: f.point,
                dist: f.dist,
            })
        })
        .filter(|a| a.dist <= MAX_SNAP_M)
        .collect();
    cands.sort_by(|a, b| a.dist.total_cmp(&b.dist).then(a.seg.cmp(&b.seg)));
    if let Some(best) = cands.first().map(|a| a.dist) {
        cands.retain(|a| a.dist <= best + ATTACH_SLACK_M);
        cands.truncate(MAX_ATTACHMENTS);
    }
    cands
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{attr_class, WayClass};
    use crate::testutil::{graph, ll};

    fn setup(segs: &[crate::testutil::Seg<'_>]) -> (WalkGraph, SegmentGrid, Projection) {
        let g = graph(segs);
        let proj = Projection::for_graph(&g);
        let grid = SegmentGrid::build(&g, &proj).unwrap();
        (g, grid, proj)
    }

    fn at(proj: &Projection, x: f64, y: f64) -> Xy {
        let (lat, lon) = ll(x, y);
        proj.project(lat, lon)
    }

    #[test]
    fn indexes_each_segment_once_per_covered_cell() {
        // A 350 m east-west edge crosses 4 or 5 cells; a short one sits in 1-2.
        let (g, grid, _) = setup(&[
            ((0.0, 0.0), (350.0, 0.0), "", WayClass::Path),
            ((0.0, 50.0), (10.0, 50.0), "", WayClass::Path),
        ]);
        let total = grid.entry_count();
        assert!((5..=8).contains(&total), "total {total}");
        assert_eq!(g.segment_count(), 2);
    }

    #[test]
    fn a_long_edge_is_listed_in_every_cell_it_crosses() {
        // A 1 km diagonal crosses about 20 cells and its bounding box about
        // 121; it must be in each cell along its length.
        let (g, grid, proj) = setup(&[((0.0, 0.0), (1000.0, 1000.0), "", WayClass::Path)]);
        assert_eq!(g.segment_count(), 1);
        let (a, b) = (at(&proj, 0.0, 0.0), at(&proj, 1000.0, 1000.0));
        let mut crossed = std::collections::BTreeSet::new();
        for i in 0..=2000 {
            let t = f64::from(i) / 2000.0;
            let c = cell((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
            assert_eq!(grid.cell(c.0, c.1), &[0], "cell {c:?}");
            crossed.insert(c);
        }
        assert!(crossed.len() >= 19, "{}", crossed.len());
        let (x0, y0, x1, y1) = cell_box(a, b);
        assert_eq!(grid.entry_count(), ((x1 - x0 + 1) * (y1 - y0 + 1)) as usize);
    }

    #[test]
    fn finds_a_segment_at_the_snap_radius_three_cells_away() {
        // A north-south segment, placed so that a query `MAX_SNAP_M` west of
        // it lies three cells over: the edge of the scanned square.
        for shift in 0..10 {
            let x = f64::from(shift) * 10.0;
            let (g, grid, proj) = setup(&[((x, -50.0), (x, 50.0), "", WayClass::Path)]);
            let (a, b) = (
                proj.project_e7(g.chain_point_e7(0, 0)),
                proj.project_e7(g.chain_point_e7(0, 1)),
            );
            let seg = (a.0, (a.1 + b.1) / 2.0);
            let q = |d: f64| (seg.0 - d, seg.1);
            if cell(seg).0 - cell(q(MAX_SNAP_M - 0.01)).0 != 3 {
                continue;
            }
            let hit = attach(&g, &proj, &grid, q(MAX_SNAP_M - 0.01), |_| true);
            assert_eq!(hit.len(), 1);
            assert!((hit[0].dist - (MAX_SNAP_M - 0.01)).abs() < 1e-6);
            assert!(attach(&g, &proj, &grid, q(MAX_SNAP_M + 0.01), |_| true).is_empty());
            return;
        }
        panic!("no placement put the query three cells away");
    }

    #[test]
    fn attaches_nearest_and_near_ties_only() {
        let (g, grid, proj) = setup(&[
            ((0.0, 0.0), (100.0, 0.0), "near", WayClass::Street),
            ((0.0, 40.0), (100.0, 40.0), "tie", WayClass::Street),
            ((0.0, 200.0), (100.0, 200.0), "far", WayClass::Street),
        ]);
        let a = attach(&g, &proj, &grid, at(&proj, 50.0, 10.0), |_| true);
        assert_eq!(
            a.len(),
            2,
            "near (10 m) and tie (30 m) are within 60 m slack; far (190 m) is not"
        );
        assert!((a[0].dist - 10.0).abs() < 0.05);
        assert!((a[0].t - 0.5).abs() < 1e-3);
        assert!((a[1].dist - 30.0).abs() < 0.05);
    }

    #[test]
    fn respects_snap_radius_and_filter() {
        let (g, grid, proj) = setup(&[
            ((0.0, 0.0), (100.0, 0.0), "", WayClass::Steps),
            ((0.0, 30.0), (100.0, 30.0), "", WayClass::Path),
        ]);
        assert!(attach(&g, &proj, &grid, at(&proj, 50.0, 400.0), |_| true).is_empty());
        let no_steps = attach(&g, &proj, &grid, at(&proj, 50.0, -5.0), |a| {
            attr_class(a) != WayClass::Steps
        });
        assert_eq!(no_steps.len(), 1);
        assert_eq!(g.chain_class(no_steps[0].chain), WayClass::Path);
    }

    #[test]
    fn caps_at_eight() {
        let segs: Vec<_> = (0..12)
            .map(|i| {
                (
                    (0.0, f64::from(i)),
                    (100.0, f64::from(i)),
                    "",
                    WayClass::Path,
                )
            })
            .collect();
        let (g, grid, proj) = setup(&segs);
        assert_eq!(
            attach(&g, &proj, &grid, at(&proj, 50.0, -1.0), |_| true).len(),
            MAX_ATTACHMENTS
        );
    }

    #[test]
    fn points_outside_the_grid_find_nothing_and_never_overflow() {
        let (g, grid, proj) = setup(&[((0.0, 0.0), (100.0, 0.0), "", WayClass::Path)]);
        for p in [
            at(&proj, 50.0, 5_000.0),
            (f64::MAX, f64::MIN),
            (f64::INFINITY, f64::NEG_INFINITY),
            (f64::NAN, f64::NAN),
            (1e12, -1e12),
        ] {
            assert!(attach(&g, &proj, &grid, p, |_| true).is_empty(), "{p:?}");
        }
        assert!(grid.cell(i32::MAX, i32::MIN).is_empty());
    }

    #[test]
    fn empty_graph_has_an_empty_grid() {
        let (g, grid, proj) = setup(&[]);
        assert_eq!(grid.entry_count(), 0);
        assert!(attach(&g, &proj, &grid, (0.0, 0.0), |_| true).is_empty());
    }

    #[test]
    fn grid_size_is_bounded_by_graph_size() {
        use crate::format::{encode, pack_attr, Graph, Meta};
        // 6 nodes and 4 edges spanning a ~2000 × 2000-cell box: a 146-byte
        // file that would otherwise make the grid allocate tens of MB.
        let d = 18_000_000;
        let at = pack_attr(0, WayClass::Path);
        let g = Graph::from_edges(
            vec![0, d, 0, d, 1, d - 1],
            vec![0, d, d, 0, 1, d - 1],
            &[(0, 1, at), (2, 3, at), (0, 5, at), (2, 4, at)],
            vec![String::new()],
            Meta::default(),
        );
        let bytes = encode(&g);
        assert!(bytes.len() < 200);
        let w = crate::format::decode(&bytes).unwrap();
        let proj = Projection::for_graph(&w);
        assert_eq!(
            SegmentGrid::build(&w, &proj).err(),
            Some(FormatError::TooLarge("grid"))
        );
    }

    #[test]
    fn refuses_a_grid_too_large_to_allocate() {
        use crate::build::GraphBuilder;
        use crate::format::Meta;
        let build = |lines: &[[(f64, f64); 2]]| {
            let mut b = GraphBuilder::new();
            for l in lines {
                b.add_line(l, "", WayClass::Path);
            }
            let g = WalkGraph::from_graph(&b.finish(Meta::default())).unwrap();
            let proj = Projection::for_graph(&g);
            SegmentGrid::build(&g, &proj).map(|_| ())
        };
        // Two short edges at opposite corners of the world: a huge extent.
        assert_eq!(
            build(&[
                [(-170.0, -80.0), (-169.999, -80.0)],
                [(170.0, 80.0), (170.001, 80.0)]
            ]),
            Err(FormatError::TooLarge("grid"))
        );
        // A small extent crossed many times by long diagonals: too many entries.
        let diag: Vec<[(f64, f64); 2]> = (0..8)
            .map(|i| {
                [
                    (0.0, 0.0001 * f64::from(i)),
                    (1.5, 1.5 + 0.0001 * f64::from(i)),
                ]
            })
            .collect();
        assert_eq!(build(&diag), Err(FormatError::TooLarge("grid")));
        assert_eq!(build(&[[(25.28, 54.68), (25.29, 54.68)]]), Ok(()));
    }
}
