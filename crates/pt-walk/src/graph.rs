//! The decoded, routable walk graph: junctions joined by chains, built
//! straight from PTWG v2 bytes by `format::decode`.
//!
//! Terms:
//! - A *point* is a node of the original pedestrian graph. Every point is
//!   either a junction or the interior point of exactly one chain.
//! - A *junction* is a point the router has to stop at (degree ≠ 2, an attr
//!   change, or the anchor of a pure cycle). Ids `0..junction_count`, `< 2^30`.
//! - A *chain* is a polyline `a, p1, …, pm, b` between two junctions (a may
//!   equal b) whose `m` interior points all have degree 2. One attr per chain.
//!   Chain `c` has `m + 1` segments, segment `k` joins point `k` and `k + 1`
//!   (point 0 = a, point m + 1 = b).
//! - A *segment* has a global id: `segment_base(c) + k`. The segment grid and
//!   attachments refer to segments by that id.
//!
//! Layout:
//! - `jlat_e7`, `jlon_e7`: junction coordinates.
//! - `joff[j]..joff[j + 1]`: half-chains at junction `j` in `jadj`, each
//!   `chain << 1 | dir` (dir 0 = leaves through point 0, 1 = through the end).
//! - `chain_a[c]`: start junction in the low 30 bits, `WayClass` in the top 2.
//!   `chain_b[c]`: end junction. `chain_name[c]`: name id.
//! - `chain_pts[c]..chain_pts[c + 1]`: interior points of `c` in `plat_e7`,
//!   `plon_e7`, in chain order.
//! - `flip`: one bit per segment. Snapping measures a segment from its *snap
//!   origin*, the end the v1 node numbering put first; a set bit means the
//!   origin is point `k + 1`, not `k`. It keeps foot points bit-identical to
//!   routing over the uncontracted graph.
//!
//! Names are one string blob plus `name_count + 1` byte offsets.

use crate::format::{pack_attr, Meta, WayClass, MAX_NODES};

/// Low bits of `chain_a` that hold the junction.
pub(crate) const NODE_BITS: u32 = 30;
pub(crate) const NODE_MASK: u32 = (1 << NODE_BITS) - 1;
/// Name ids are stored as `u16`: decode refuses more names than this.
pub const MAX_INDEX_NAMES: u32 = 1 << 16;

const _: () = assert!(
    MAX_NODES <= 1 << NODE_BITS,
    "junction ids must fit in 30 bits"
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkGraph {
    pub(crate) jlat_e7: Vec<i32>,
    pub(crate) jlon_e7: Vec<i32>,
    pub(crate) joff: Vec<u32>,
    pub(crate) jadj: Vec<u32>,
    pub(crate) chain_a: Vec<u32>,
    pub(crate) chain_b: Vec<u32>,
    pub(crate) chain_name: Vec<u16>,
    pub(crate) chain_pts: Vec<u32>,
    pub(crate) plat_e7: Vec<i32>,
    pub(crate) plon_e7: Vec<i32>,
    pub(crate) flip: Vec<u64>,
    pub(crate) name_blob: String,
    pub(crate) name_off: Vec<u32>,
    pub(crate) meta: Meta,
}

pub(crate) fn pack_end(junction: u32, class: WayClass) -> u32 {
    junction | (class as u32) << NODE_BITS
}

fn class_of(packed: u32) -> WayClass {
    match packed >> NODE_BITS {
        0 => WayClass::Street,
        1 => WayClass::Path,
        2 => WayClass::Crossing,
        _ => WayClass::Steps,
    }
}

/// One end of a chain as seen from a junction: `jadj` entry decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HalfChain {
    pub chain: u32,
    /// `false`: the chain is walked from point 0; `true`: from its end.
    pub reversed: bool,
}

impl WalkGraph {
    /// Encode `g` and decode it again: the build-side graph goes through the
    /// same validation as bytes from the network.
    pub fn from_graph(g: &crate::format::Graph) -> Result<Self, crate::format::FormatError> {
        crate::format::decode(&crate::format::encode(g))
    }

    pub fn junction_count(&self) -> usize {
        self.jlat_e7.len()
    }

    pub fn chain_count(&self) -> usize {
        self.chain_b.len()
    }

    /// Interior points of all chains.
    pub fn interior_count(&self) -> usize {
        self.plat_e7.len()
    }

    /// Points of the original graph: junctions plus interior points (the v1
    /// node count).
    pub fn point_count(&self) -> usize {
        self.junction_count() + self.interior_count()
    }

    /// Segments of the original graph (the v1 edge count).
    pub fn segment_count(&self) -> usize {
        self.interior_count() + self.chain_count()
    }

    pub fn name_count(&self) -> usize {
        self.name_off.len() - 1
    }

    pub fn meta(&self) -> &Meta {
        &self.meta
    }

    /// `(lat_e7, lon_e7)` of junction `j`.
    pub fn junction_e7(&self, j: u32) -> (i32, i32) {
        (self.jlat_e7[j as usize], self.jlon_e7[j as usize])
    }

    /// Point `i` of `0..point_count()`: junctions first, then interior points
    /// in chain order. For sampling; routing goes through chains.
    pub fn point_e7(&self, i: usize) -> (i32, i32) {
        let nj = self.junction_count();
        if i < nj {
            (self.jlat_e7[i], self.jlon_e7[i])
        } else {
            (self.plat_e7[i - nj], self.plon_e7[i - nj])
        }
    }

    /// Name `id`; `""` for the unnamed id 0 and for ids out of range.
    pub fn name(&self, id: u32) -> &str {
        let i = id as usize;
        match (self.name_off.get(i), self.name_off.get(i + 1)) {
            (Some(&a), Some(&b)) => &self.name_blob[a as usize..b as usize],
            _ => "",
        }
    }

    /// Half-chains at junction `j`, in decode order.
    pub fn half_chains(&self, j: u32) -> impl Iterator<Item = HalfChain> + '_ {
        let r = self.joff[j as usize] as usize..self.joff[j as usize + 1] as usize;
        self.jadj[r].iter().map(|&e| HalfChain {
            chain: e >> 1,
            reversed: e & 1 == 1,
        })
    }

    /// `(start, end)` junctions of chain `c`.
    pub fn chain_ends(&self, c: u32) -> (u32, u32) {
        (
            self.chain_a[c as usize] & NODE_MASK,
            self.chain_b[c as usize],
        )
    }

    pub fn chain_class(&self, c: u32) -> WayClass {
        class_of(self.chain_a[c as usize])
    }

    pub fn chain_name_id(&self, c: u32) -> u32 {
        u32::from(self.chain_name[c as usize])
    }

    /// `format::pack_attr` of the chain's name and class.
    pub fn chain_attr(&self, c: u32) -> u32 {
        pack_attr(self.chain_name_id(c), self.chain_class(c))
    }

    /// Segments of chain `c` (interior points + 1).
    pub fn chain_segments(&self, c: u32) -> u32 {
        self.chain_pts[c as usize + 1] - self.chain_pts[c as usize] + 1
    }

    /// Point `i` (`0..=chain_segments(c)`) of chain `c`, in chain order.
    pub fn chain_point_e7(&self, c: u32, i: u32) -> (i32, i32) {
        let (a, b) = self.chain_ends(c);
        if i == 0 {
            self.junction_e7(a)
        } else if i == self.chain_segments(c) {
            self.junction_e7(b)
        } else {
            let p = (self.chain_pts[c as usize] + i - 1) as usize;
            (self.plat_e7[p], self.plon_e7[p])
        }
    }

    /// Global id of segment 0 of chain `c`.
    pub fn segment_base(&self, c: u32) -> u32 {
        self.chain_pts[c as usize] + c
    }

    /// `(chain, index in chain)` of global segment `s`.
    pub fn segment_chain(&self, s: u32) -> (u32, u32) {
        // Largest c with segment_base(c) <= s; segment_base is increasing.
        let (mut lo, mut hi) = (0u32, self.chain_count() as u32);
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if self.segment_base(mid) <= s {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        (lo, s - self.segment_base(lo))
    }

    /// Whether segment `s` is snapped from its point `k + 1` (see `flip`).
    pub fn segment_flipped(&self, s: u32) -> bool {
        self.flip[(s / 64) as usize] >> (s % 64) & 1 == 1
    }

    /// Bytes owned on the heap (allocated capacity, not length).
    pub fn heap_bytes(&self) -> usize {
        (self.jlat_e7.capacity()
            + self.jlon_e7.capacity()
            + self.joff.capacity()
            + self.jadj.capacity()
            + self.chain_a.capacity()
            + self.chain_b.capacity()
            + self.chain_pts.capacity()
            + self.plat_e7.capacity()
            + self.plon_e7.capacity()
            + self.name_off.capacity())
            * 4
            + self.chain_name.capacity() * 2
            + self.flip.capacity() * 8
            + self.name_blob.capacity()
            + self.meta.city_id.capacity()
            + self.meta.generated_at.capacity()
            + self.meta.source.capacity()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{pack_attr, Graph};

    /// Triangle 0-1-2, a tail 2-3-4 (one attr, so 3 is interior), and an
    /// isolated node 5.
    fn sample() -> WalkGraph {
        let edges = [
            (0, 1, pack_attr(1, WayClass::Street)),
            (0, 2, pack_attr(0, WayClass::Path)),
            (1, 2, pack_attr(2, WayClass::Crossing)),
            (2, 3, pack_attr(0, WayClass::Steps)),
            (3, 4, pack_attr(0, WayClass::Steps)),
        ];
        let g = Graph::from_edges(
            vec![
                546_800_000,
                546_800_000,
                546_810_000,
                546_820_000,
                546_830_000,
                546_840_000,
            ],
            vec![
                252_800_000,
                252_810_000,
                252_805_000,
                252_805_000,
                252_806_000,
                252_805_000,
            ],
            &edges,
            vec![String::new(), "Gedimino pr.".into(), "Pylimo g.".into()],
            Meta::default(),
        );
        WalkGraph::from_graph(&g).unwrap()
    }

    #[test]
    fn contracts_the_degree_2_tail() {
        let g = sample();
        // Junctions 0, 1, 2, 4, 5 (node 3 is interior).
        assert_eq!((g.junction_count(), g.chain_count()), (5, 4));
        assert_eq!((g.point_count(), g.segment_count()), (6, 5));
        assert_eq!(g.name_count(), 3);
        let tail = (0..4).find(|&c| g.chain_segments(c) == 2).unwrap();
        assert_eq!(g.chain_ends(tail), (2, 3));
        assert_eq!(g.chain_class(tail), WayClass::Steps);
        assert_eq!(g.chain_point_e7(tail, 1), (546_820_000, 252_805_000));
        assert_eq!(g.chain_point_e7(tail, 2), (546_830_000, 252_806_000));
        assert_eq!(g.half_chains(4).count(), 0, "isolated junction");
        assert_eq!(g.junction_e7(4), (546_840_000, 252_805_000));
        assert_eq!(g.half_chains(2).count(), 3);
    }

    #[test]
    fn maps_segments_to_chains_and_back() {
        let g = sample();
        let mut seen = 0;
        for c in 0..g.chain_count() as u32 {
            for k in 0..g.chain_segments(c) {
                assert_eq!(g.segment_chain(g.segment_base(c) + k), (c, k));
                seen += 1;
            }
        }
        assert_eq!(seen, g.segment_count());
    }

    #[test]
    fn names_are_sliced_from_one_blob() {
        let g = sample();
        assert_eq!(g.name(0), "");
        assert_eq!(g.name(1), "Gedimino pr.");
        assert_eq!(g.name(2), "Pylimo g.");
        assert_eq!(g.name(3), "");
        assert_eq!(g.name(u32::MAX), "");
    }

    #[test]
    fn packs_every_class_next_to_a_large_junction_id() {
        for class in [
            WayClass::Street,
            WayClass::Path,
            WayClass::Crossing,
            WayClass::Steps,
        ] {
            let a = pack_end(NODE_MASK, class);
            assert_eq!((a & NODE_MASK, class_of(a)), (NODE_MASK, class));
        }
    }

    #[test]
    fn heap_bytes_counts_every_buffer() {
        let g = sample();
        // 5 junctions × 8 + 6 joff × 4 + 8 jadj × 4 + 4 chains × (4 + 4 + 2)
        // + 5 chain_pts × 4 + 1 interior × 8 + 1 flip word × 8 + 21 name
        // bytes + 4 name offsets × 4 + empty meta.
        assert_eq!(g.heap_bytes(), 40 + 24 + 32 + 40 + 20 + 8 + 8 + 21 + 16);
    }
}
