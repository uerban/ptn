//! PTWG v2: the walk-graph artifact, with degree-2 chains contracted at
//! build time.
//!
//! # Model
//!
//! The builder's pedestrian graph (`Graph`: nodes, undirected edges, one attr
//! per edge) is stored as *junctions* joined by *chains*:
//!
//! - A junction is a node with degree ≠ 2, a degree-2 node whose two edges
//!   carry different attrs, or the anchor (lowest node id) of a component
//!   that is a pure cycle of degree-2 nodes. Junction ids follow ascending
//!   node id.
//! - A chain is a maximal path `a, p1, …, pm, b` between junctions whose
//!   interior points are not junctions; all its edges share one attr. Chains
//!   are numbered in file order; chain `c` has `m + 1` segments.
//!
//! Every node is a junction or the interior point of exactly one chain, and
//! every edge is exactly one chain segment, so the uncontracted graph can be
//! rebuilt from the file. Contraction is done here and not at load time so
//! that the decoder never holds the uncontracted graph.
//!
//! # Layout (all integers little-endian)
//!
//! Header, `HEADER_LEN` = 104 bytes:
//!
//! | off | size | field                                      |
//! |-----|------|--------------------------------------------|
//! | 0   | 4    | magic `PTWG`                               |
//! | 4   | 2    | version = 2                                |
//! | 6   | 2    | flags = 0                                  |
//! | 8   | 4    | junction count `J`                         |
//! | 12  | 4    | chain count `C`                            |
//! | 16  | 4    | interior point count `P`                   |
//! | 20  | 4    | name count `N` (≥ 1)                       |
//! | 24  | 80   | 5 × (`u64` offset, `u64` length) sections  |
//!
//! Sections are contiguous, in order, from byte 104 to EOF:
//!
//! 1. **junctions**: `J` × (zigzag varint Δlat_e7, Δlon_e7), deltas from the
//!    previous junction (the first from 0).
//! 2. **chains**: for each junction `a` in id order, varint `k` (chains whose
//!    start is `a`), then `k` records, sorted by end junction:
//!    varint `b - prev` (prev starts at `a`, so `b ≥ a`), varint name id,
//!    `u8` class, varint `m`, then `m` × (zigzag Δlat_e7, Δlon_e7) for the
//!    interior points, each delta from the previous point (the first from
//!    junction `a`). A record with `a == b` and `m == 0` is invalid.
//! 3. **orient**: one bit per segment, LSB first, `ceil((P + C) / 8)` bytes,
//!    unused high bits zero. Segment ids run chain by chain (`k`-th segment
//!    of chain `c` is `c + (interior points before c) + k`). A set bit says
//!    the segment's snap origin is its far point `k + 1`: the builder's node
//!    numbering put that end first. Snapping measures foot points from the
//!    origin, so routes stay bit-identical to the uncontracted graph.
//! 4. **names**: `N` × (varint byte length, UTF-8). Name 0 is `""`.
//! 5. **meta**: three strings as in names: city id, generated at, source.
//!
//! The router walks chains point by point, adding segment lengths in walking
//! order exactly as an uncontracted search would, so no chain length is
//! stored.
//!
//! # Tiling (future)
//!
//! The layout is per junction and per chain on purpose. A tiled artifact
//! would cut chains at tile borders (the cut points become junctions),
//! number junctions in cell order, and emit one junctions/chains/orient
//! group per tile behind a tile directory. Open points for that change:
//!
//! - A chain whose end junction lies in another tile cannot name it by a
//!   local id. That needs a boundary-junction table or `(tile, local)` ids,
//!   so the chain record format does change for cross-tile ends.
//! - Tile cuts must fall on existing points; a cut at a new point would
//!   move geometry and break bit-identical routes.
//! - `Projection::for_graph` takes the mid-latitude of what is loaded, so a
//!   client holding different tiles would project differently. A tiled
//!   header must store the projection latitude.

use crate::graph::{pack_end, WalkGraph, MAX_INDEX_NAMES};
use crate::varint::{read_uvarint, unzigzag, write_uvarint, zigzag, VarintError};

pub const MAGIC: [u8; 4] = *b"PTWG";
pub const VERSION: u16 = 2;
pub const HEADER_LEN: usize = 104;
const SECTIONS: usize = 5;
/// Decode refuses larger counts before allocating (a hostile header must not
/// make the decoder reserve gigabytes).
pub const MAX_NODES: u32 = 1 << 26;
pub const MAX_NAMES: u32 = 1 << 24;
pub const MAX_EDGES: u32 = 1 << 28;

const _: () = assert!(MAX_INDEX_NAMES <= MAX_NAMES);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum WayClass {
    Street = 0,
    Path = 1,
    Crossing = 2,
    Steps = 3,
}

impl WayClass {
    pub fn from_u8(b: u8) -> Option<Self> {
        match b {
            0 => Some(Self::Street),
            1 => Some(Self::Path),
            2 => Some(Self::Crossing),
            3 => Some(Self::Steps),
            _ => None,
        }
    }
}

pub fn pack_attr(name_id: u32, class: WayClass) -> u32 {
    (name_id << 8) | class as u32
}

pub fn attr_name(attr: u32) -> u32 {
    attr >> 8
}

pub fn attr_class(attr: u32) -> WayClass {
    // Every attr in a decoded graph went through `WayClass::from_u8`, so the
    // fallback is unreachable for decoded data.
    WayClass::from_u8((attr & 0xff) as u8).unwrap_or(WayClass::Path)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Meta {
    pub city_id: String,
    pub generated_at: String,
    pub source: String,
}

/// Build-side undirected pedestrian graph in CSR form, the input of
/// `encode`. Both half-edges of an edge carry the same attr. Routing uses the
/// contracted `WalkGraph` that `decode` produces instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Graph {
    pub lat_e7: Vec<i32>,
    pub lon_e7: Vec<i32>,
    pub offsets: Vec<u32>,
    pub neighbors: Vec<u32>,
    pub attrs: Vec<u32>,
    pub names: Vec<String>,
    pub meta: Meta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormatError {
    BadMagic,
    UnsupportedVersion(u16),
    UnknownFlags(u16),
    Truncated,
    BadLayout(&'static str),
    Varint(VarintError),
    CoordOutOfRange(u32),
    BadEdge(u32),
    BadName(u32),
    BadClass(u8),
    BadUtf8,
    CountMismatch(&'static str),
    TooLarge(&'static str),
}

impl From<VarintError> for FormatError {
    fn from(e: VarintError) -> Self {
        Self::Varint(e)
    }
}

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for FormatError {}

impl Graph {
    /// Build the CSR form from undirected edges `(u, v, attr)`.
    ///
    /// `edges` MUST be sorted by `(u, v)`, deduplicated, and have `u < v`.
    /// Under that order, each node's slice comes out sorted ascending.
    /// Every edge `(w, x)` with `w < x` precedes every edge `(x, v)`, and
    /// each group is itself ascending.
    pub fn from_edges(
        lat_e7: Vec<i32>,
        lon_e7: Vec<i32>,
        edges: &[(u32, u32, u32)],
        names: Vec<String>,
        meta: Meta,
    ) -> Graph {
        let n = lat_e7.len();
        let mut offsets = vec![0u32; n + 1];
        for &(u, v, _) in edges {
            offsets[u as usize + 1] += 1;
            offsets[v as usize + 1] += 1;
        }
        for i in 0..n {
            offsets[i + 1] += offsets[i];
        }
        let mut cursor: Vec<u32> = offsets[..n].to_vec();
        let mut neighbors = vec![0u32; edges.len() * 2];
        let mut attrs = vec![0u32; edges.len() * 2];
        for &(u, v, a) in edges {
            for (from, to) in [(u, v), (v, u)] {
                let slot = cursor[from as usize] as usize;
                neighbors[slot] = to;
                attrs[slot] = a;
                cursor[from as usize] += 1;
            }
        }
        Graph {
            lat_e7,
            lon_e7,
            offsets,
            neighbors,
            attrs,
            names,
            meta,
        }
    }

    pub fn node_count(&self) -> usize {
        self.lat_e7.len()
    }

    pub fn edge_count(&self) -> usize {
        self.neighbors.len() / 2
    }

    /// Half-edge index range of node `u`.
    pub fn neighbors_of(&self, u: u32) -> std::ops::Range<usize> {
        self.offsets[u as usize] as usize..self.offsets[u as usize + 1] as usize
    }
}

pub(crate) fn write_str(out: &mut Vec<u8>, s: &str) {
    write_uvarint(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

/// Header + the five contiguous sections. `counts` = (J, C, P, N).
pub(crate) fn assemble(counts: (u32, u32, u32, u32), sections: [&[u8]; SECTIONS]) -> Vec<u8> {
    let body: usize = sections.iter().map(|s| s.len()).sum();
    let mut out = Vec::with_capacity(HEADER_LEN + body);
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    for c in [counts.0, counts.1, counts.2, counts.3] {
        out.extend_from_slice(&c.to_le_bytes());
    }
    let mut offset = HEADER_LEN as u64;
    for s in &sections {
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&(s.len() as u64).to_le_bytes());
        offset += s.len() as u64;
    }
    for s in &sections {
        out.extend_from_slice(s);
    }
    out
}

/// One chain found by `contract`, in original node ids.
struct RawChain {
    a: u32,
    b: u32,
    attr: u32,
    /// `a`, interior nodes, `b`.
    path: Vec<u32>,
}

/// Junction flags and the chains between them (see the module docs).
fn contract(g: &Graph) -> (Vec<bool>, Vec<RawChain>) {
    let n = g.node_count();
    let mut junction: Vec<bool> = (0..n as u32)
        .map(|u| {
            let r = g.neighbors_of(u);
            r.len() != 2 || g.attrs[r.start] != g.attrs[r.start + 1]
        })
        .collect();
    // Next half-edge out of degree-2 node `cur` when it was entered from `prev`.
    let onward = |cur: u32, prev: u32| {
        let r = g.neighbors_of(cur);
        if g.neighbors[r.start] == prev {
            r.start + 1
        } else {
            r.start
        }
    };
    let walk = |junction: &[bool], u: u32, h: usize| {
        let mut path = vec![u];
        let (mut prev, mut cur) = (u, g.neighbors[h]);
        while !junction[cur as usize] {
            path.push(cur);
            let next = g.neighbors[onward(cur, prev)];
            prev = cur;
            cur = next;
        }
        path.push(cur);
        path
    };
    // Interior nodes reached from a junction; what is left lies on pure
    // cycles, each anchored at its lowest node id.
    let mut covered = junction.clone();
    for u in 0..n as u32 {
        if junction[u as usize] {
            for h in g.neighbors_of(u) {
                for &p in &walk(&junction, u, h) {
                    covered[p as usize] = true;
                }
            }
        }
    }
    for u in 0..n as u32 {
        if !covered[u as usize] {
            junction[u as usize] = true;
            for &p in &walk(&junction, u, g.neighbors_of(u).start) {
                covered[p as usize] = true;
            }
        }
    }
    let mut used = vec![false; g.neighbors.len()];
    let mut chains = Vec::new();
    for u in 0..n as u32 {
        if !junction[u as usize] {
            continue;
        }
        for h in g.neighbors_of(u) {
            if used[h] {
                continue;
            }
            used[h] = true;
            let path = walk(&junction, u, h);
            // Mark every half-edge of the chain, both directions.
            for w in path.windows(2) {
                for (x, y) in [(w[0], w[1]), (w[1], w[0])] {
                    let r = g.neighbors_of(x);
                    let i = r.start + g.neighbors[r].partition_point(|&t| t < y);
                    used[i] = true;
                }
            }
            chains.push(RawChain {
                a: u,
                b: *path.last().unwrap(),
                attr: g.attrs[h],
                path,
            });
        }
    }
    (junction, chains)
}

fn write_delta(out: &mut Vec<u8>, prev: &mut (i64, i64), (lat, lon): (i32, i32)) {
    let (la, lo) = (i64::from(lat), i64::from(lon));
    write_uvarint(out, zigzag(la - prev.0));
    write_uvarint(out, zigzag(lo - prev.1));
    *prev = (la, lo);
}

pub fn encode(g: &Graph) -> Vec<u8> {
    let (junction, mut chains) = contract(g);
    let mut jid = vec![u32::MAX; g.node_count()];
    let mut nj = 0u32;
    for (u, &is_j) in junction.iter().enumerate() {
        if is_j {
            jid[u] = nj;
            nj += 1;
        }
    }
    for c in &mut chains {
        c.a = jid[c.a as usize];
        c.b = jid[c.b as usize];
    }
    // Walk order already groups chains by start with a <= b; order each
    // group by end (stable, so parallel chains keep walk order).
    chains.sort_by_key(|c| (c.a, c.b));
    let coord = |u: u32| (g.lat_e7[u as usize], g.lon_e7[u as usize]);

    let mut juncs = Vec::with_capacity(nj as usize * 4);
    let mut prev = (0i64, 0i64);
    for (u, &is_j) in junction.iter().enumerate() {
        if is_j {
            write_delta(&mut juncs, &mut prev, coord(u as u32));
        }
    }

    let interior: usize = chains.iter().map(|c| c.path.len() - 2).sum();
    let segments = interior + chains.len();
    let mut orient = vec![0u8; segments.div_ceil(8)];
    let mut body = Vec::with_capacity(chains.len() * 6 + interior * 4 + nj as usize);
    let mut seg = 0usize;
    let mut next = 0usize;
    for a in 0..nj {
        let group = chains[next..].iter().take_while(|c| c.a == a).count();
        write_uvarint(&mut body, group as u64);
        let mut prev_b = a;
        for c in &chains[next..next + group] {
            write_uvarint(&mut body, u64::from(c.b - prev_b));
            prev_b = c.b;
            write_uvarint(&mut body, u64::from(attr_name(c.attr)));
            body.push((c.attr & 0xff) as u8);
            let inner = &c.path[1..c.path.len() - 1];
            write_uvarint(&mut body, inner.len() as u64);
            let mut p = {
                let (la, lo) = coord(c.path[0]);
                (i64::from(la), i64::from(lo))
            };
            for &x in inner {
                write_delta(&mut body, &mut p, coord(x));
            }
            for w in c.path.windows(2) {
                if w[1] < w[0] {
                    orient[seg / 8] |= 1 << (seg % 8);
                }
                seg += 1;
            }
        }
        next += group;
    }

    let mut names = Vec::new();
    for s in &g.names {
        write_str(&mut names, s);
    }
    let mut meta = Vec::new();
    for s in [&g.meta.city_id, &g.meta.generated_at, &g.meta.source] {
        write_str(&mut meta, s);
    }
    assemble(
        (
            nj,
            chains.len() as u32,
            interior as u32,
            g.names.len() as u32,
        ),
        [&juncs, &body, &orient, &names, &meta],
    )
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

/// Next string of a section, borrowed.
fn read_str_ref<'a>(sec: &'a [u8], pos: &mut usize) -> Result<&'a str, FormatError> {
    let len = usize::try_from(read_uvarint(sec, pos)?).map_err(|_| FormatError::Truncated)?;
    let end = pos
        .checked_add(len)
        .filter(|&e| e <= sec.len())
        .ok_or(FormatError::Truncated)?;
    let s = std::str::from_utf8(&sec[*pos..end]).map_err(|_| FormatError::BadUtf8)?;
    *pos = end;
    Ok(s)
}

fn read_str(sec: &[u8], pos: &mut usize) -> Result<String, FormatError> {
    read_str_ref(sec, pos).map(str::to_owned)
}

/// Next delta-coded coordinate, applied to `at`. `point` names it in errors.
fn read_coord(
    sec: &[u8],
    pos: &mut usize,
    at: &mut (i64, i64),
    point: u32,
) -> Result<(i32, i32), FormatError> {
    let lat =
        at.0.checked_add(unzigzag(read_uvarint(sec, pos)?))
            .ok_or(FormatError::CoordOutOfRange(point))?;
    let lon =
        at.1.checked_add(unzigzag(read_uvarint(sec, pos)?))
            .ok_or(FormatError::CoordOutOfRange(point))?;
    if !(-900_000_000..=900_000_000).contains(&lat)
        || !(-1_800_000_000..=1_800_000_000).contains(&lon)
    {
        return Err(FormatError::CoordOutOfRange(point));
    }
    *at = (lat, lon);
    Ok((lat as i32, lon as i32))
}

/// Fixed part of one chain record of junction `a`: `(b, name_id, class, m)`.
fn read_chain_head(
    sec: &[u8],
    pos: &mut usize,
    a: u32,
    prev: u32,
    junctions: u32,
    name_count: u32,
) -> Result<(u32, u32, WayClass, u32), FormatError> {
    let d = read_uvarint(sec, pos)?;
    let b = u64::from(prev)
        .checked_add(d)
        .filter(|&b| b < u64::from(junctions))
        .ok_or(FormatError::BadEdge(a))? as u32;
    let name = read_uvarint(sec, pos)?;
    if name >= u64::from(name_count) {
        return Err(FormatError::BadName(a));
    }
    let byte = *sec.get(*pos).ok_or(FormatError::Truncated)?;
    *pos += 1;
    let class = WayClass::from_u8(byte).ok_or(FormatError::BadClass(byte))?;
    let m = read_uvarint(sec, pos)?;
    if a == b && m == 0 {
        return Err(FormatError::BadEdge(a));
    }
    // Bounded by the caller against the interior count; this only keeps
    // the value in u32.
    let m = u32::try_from(m).map_err(|_| FormatError::TooLarge("interior points"))?;
    Ok((b, name as u32, class, m))
}

/// Decode PTWG v2 bytes straight into the contracted `WalkGraph`.
///
/// Two passes over the chains section: the first validates every record
/// and counts each junction's degree, the second fills the arrays in place.
/// No intermediate list is allocated, so peak memory is the result plus the
/// input.
pub fn decode(buf: &[u8]) -> Result<WalkGraph, FormatError> {
    if buf.len() < HEADER_LEN {
        return Err(FormatError::Truncated);
    }
    if buf[0..4] != MAGIC {
        return Err(FormatError::BadMagic);
    }
    let version = u16_at(buf, 4);
    if version != VERSION {
        return Err(FormatError::UnsupportedVersion(version));
    }
    let flags = u16_at(buf, 6);
    if flags != 0 {
        return Err(FormatError::UnknownFlags(flags));
    }
    let junctions = u32_at(buf, 8);
    let chain_count = u32_at(buf, 12);
    let interior = u32_at(buf, 16);
    let name_count = u32_at(buf, 20);
    let mut ranges = [(0usize, 0usize); SECTIONS];
    let mut expect = HEADER_LEN as u64;
    for (i, r) in ranges.iter_mut().enumerate() {
        let off = u64_at(buf, 24 + 16 * i);
        let len = u64_at(buf, 32 + 16 * i);
        if off != expect {
            return Err(FormatError::BadLayout("section offset"));
        }
        expect = off
            .checked_add(len)
            .ok_or(FormatError::BadLayout("section length"))?;
        if expect > buf.len() as u64 {
            return Err(FormatError::Truncated);
        }
        *r = (off as usize, (off + len) as usize);
    }
    if expect != buf.len() as u64 {
        return Err(FormatError::BadLayout("sections do not end at EOF"));
    }
    let [junc_sec, chain_sec, orient_sec, names_sec, meta_sec] = ranges.map(|(a, b)| &buf[a..b]);

    if u64::from(junctions) + u64::from(interior) > u64::from(MAX_NODES) {
        return Err(FormatError::TooLarge("nodes"));
    }
    if u64::from(chain_count) + u64::from(interior) > u64::from(MAX_EDGES) {
        return Err(FormatError::TooLarge("edges"));
    }
    if name_count == 0 {
        return Err(FormatError::BadName(0));
    }
    // The format allows MAX_NAMES; the decoded graph stores name ids as u16,
    // the tighter of the two limits.
    if name_count > MAX_INDEX_NAMES {
        return Err(FormatError::TooLarge("names"));
    }
    let segments = u64::from(chain_count) + u64::from(interior);
    // Every junction takes >= 2 bytes, every chain record >= 4 plus 1 per
    // junction for its group count, every interior point >= 2, every name
    // >= 1: cheap guards so counts cannot drive allocation past the input.
    if u64::from(junctions) * 2 > junc_sec.len() as u64
        || u64::from(junctions) + u64::from(chain_count) * 4 + u64::from(interior) * 2
            > chain_sec.len() as u64
        || u64::from(name_count) > names_sec.len() as u64
    {
        return Err(FormatError::Truncated);
    }
    if orient_sec.len() as u64 != segments.div_ceil(8) {
        return Err(FormatError::BadLayout("orient section length"));
    }
    if segments % 8 != 0 && orient_sec.last().is_some_and(|&b| b >> (segments % 8) != 0) {
        return Err(FormatError::BadLayout("orient padding"));
    }

    let nj = junctions as usize;
    let mut jlat_e7 = Vec::with_capacity(nj);
    let mut jlon_e7 = Vec::with_capacity(nj);
    let mut at = (0i64, 0i64);
    let mut p = 0usize;
    for i in 0..junctions {
        let (la, lo) = read_coord(junc_sec, &mut p, &mut at, i)?;
        jlat_e7.push(la);
        jlon_e7.push(lo);
    }
    if p != junc_sec.len() {
        return Err(FormatError::BadLayout("junctions section length"));
    }

    // Pass 1: validate every chain record and count each junction's degree
    // into `joff[j + 1]`. Degrees cannot overflow: 2 × chains <= 2^29.
    let mut joff = vec![0u32; nj + 1];
    let (mut seen, mut points) = (0u32, 0u32);
    let mut p = 0usize;
    for a in 0..junctions {
        let k = read_uvarint(chain_sec, &mut p)?;
        let mut prev = a;
        for _ in 0..k {
            let (b, _, _, m) = read_chain_head(chain_sec, &mut p, a, prev, junctions, name_count)?;
            prev = b;
            if seen == chain_count {
                return Err(FormatError::CountMismatch("chains"));
            }
            seen += 1;
            if m > interior - points {
                return Err(FormatError::CountMismatch("interior points"));
            }
            let mut at = (
                i64::from(jlat_e7[a as usize]),
                i64::from(jlon_e7[a as usize]),
            );
            for i in 0..m {
                read_coord(chain_sec, &mut p, &mut at, junctions + points + i)?;
            }
            points += m;
            joff[a as usize + 1] += 1;
            joff[b as usize + 1] += 1;
        }
    }
    if seen != chain_count {
        return Err(FormatError::CountMismatch("chains"));
    }
    if points != interior {
        return Err(FormatError::CountMismatch("interior points"));
    }
    if p != chain_sec.len() {
        return Err(FormatError::BadLayout("chains section length"));
    }

    // Names: validate and size first, then copy into one exact-size blob.
    let mut total = 0usize;
    let mut p = 0usize;
    for i in 0..name_count {
        let s = read_str_ref(names_sec, &mut p)?;
        if i == 0 && !s.is_empty() {
            return Err(FormatError::BadName(0));
        }
        total += s.len();
    }
    if p != names_sec.len() {
        return Err(FormatError::BadLayout("names section length"));
    }
    if u32::try_from(total).is_err() {
        return Err(FormatError::TooLarge("names"));
    }
    let mut name_blob = String::with_capacity(total);
    let mut name_off = Vec::with_capacity(name_count as usize + 1);
    name_off.push(0u32);
    let mut p = 0usize;
    for _ in 0..name_count {
        name_blob.push_str(read_str_ref(names_sec, &mut p)?);
        name_off.push(name_blob.len() as u32);
    }

    let mut p = 0usize;
    let meta = Meta {
        city_id: read_str(meta_sec, &mut p)?,
        generated_at: read_str(meta_sec, &mut p)?,
        source: read_str(meta_sec, &mut p)?,
    };
    if p != meta_sec.len() {
        return Err(FormatError::BadLayout("meta section length"));
    }

    let mut flip = vec![0u64; segments.div_ceil(64) as usize];
    for (i, &b) in orient_sec.iter().enumerate() {
        flip[i / 8] |= u64::from(b) << (8 * (i % 8));
    }

    // Pass 2: fill. `joff[x]` serves as junction x's write cursor (starting
    // at its slice start), then the array is shifted back by one slot.
    for i in 0..nj {
        joff[i + 1] += joff[i];
    }
    let nc = chain_count as usize;
    let mut jadj = vec![0u32; 2 * nc];
    let mut chain_a = Vec::with_capacity(nc);
    let mut chain_b = Vec::with_capacity(nc);
    let mut chain_name = Vec::with_capacity(nc);
    let mut chain_pts = Vec::with_capacity(nc + 1);
    chain_pts.push(0u32);
    let mut plat_e7 = Vec::with_capacity(interior as usize);
    let mut plon_e7 = Vec::with_capacity(interior as usize);
    let mut p = 0usize;
    for a in 0..junctions {
        let k = read_uvarint(chain_sec, &mut p)?;
        let mut prev = a;
        for _ in 0..k {
            let (b, name, class, m) =
                read_chain_head(chain_sec, &mut p, a, prev, junctions, name_count)?;
            prev = b;
            let c = chain_a.len() as u32;
            let mut at = (
                i64::from(jlat_e7[a as usize]),
                i64::from(jlon_e7[a as usize]),
            );
            for _ in 0..m {
                let i = plat_e7.len() as u32;
                let (la, lo) = read_coord(chain_sec, &mut p, &mut at, junctions + i)?;
                plat_e7.push(la);
                plon_e7.push(lo);
            }
            for (j, dir) in [(a, 0), (b, 1)] {
                let slot = &mut joff[j as usize];
                jadj[*slot as usize] = c << 1 | dir;
                *slot += 1;
            }
            chain_a.push(pack_end(a, class));
            chain_b.push(b);
            chain_name.push(name as u16);
            chain_pts.push(plat_e7.len() as u32);
        }
    }
    for i in (1..=nj).rev() {
        joff[i] = joff[i - 1];
    }
    joff[0] = 0;

    Ok(WalkGraph {
        jlat_e7,
        jlon_e7,
        joff,
        jadj,
        chain_a,
        chain_b,
        chain_name,
        chain_pts,
        plat_e7,
        plon_e7,
        flip,
        name_blob,
        name_off,
        meta,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Triangle 0-1-2 plus a tail 2-3. Node 0 is (54.68, 25.28).
    fn sample() -> Graph {
        let lat = vec![546_800_000, 546_800_000, 546_810_000, 546_820_000];
        let lon = vec![252_800_000, 252_810_000, 252_805_000, 252_805_000];
        let edges = [
            (0, 1, pack_attr(1, WayClass::Street)),
            (0, 2, pack_attr(0, WayClass::Path)),
            (1, 2, pack_attr(0, WayClass::Crossing)),
            (2, 3, pack_attr(0, WayClass::Steps)),
        ];
        Graph::from_edges(
            lat,
            lon,
            &edges,
            vec![String::new(), "Gedimino pr.".into()],
            Meta {
                city_id: "vilnius".into(),
                generated_at: "2026-10-26".into(),
                source: "test".into(),
            },
        )
    }

    /// `n` nodes on a ring (a pure cycle), one attr.
    fn ring(n: u32, lat0: i32) -> Vec<(i32, i32)> {
        (0..n)
            .map(|i| {
                let a = f64::from(i) / f64::from(n) * std::f64::consts::TAU;
                (
                    lat0 + (a.sin() * 1e4) as i32,
                    252_800_000 + (a.cos() * 1e4) as i32,
                )
            })
            .collect()
    }

    fn graph_of(coords: &[(i32, i32)], edges: &[(u32, u32, u32)], names: usize) -> Graph {
        let mut e = edges.to_vec();
        e.sort_unstable();
        Graph::from_edges(
            coords.iter().map(|c| c.0).collect(),
            coords.iter().map(|c| c.1).collect(),
            &e,
            (0..names)
                .map(|i| {
                    if i == 0 {
                        String::new()
                    } else {
                        format!("n{i}")
                    }
                })
                .collect(),
            Meta::default(),
        )
    }

    #[test]
    fn csr_lists_each_node_neighbors_sorted() {
        let g = sample();
        assert_eq!(g.offsets, vec![0, 2, 4, 7, 8]);
        assert_eq!(g.neighbors, vec![1, 2, 0, 2, 0, 1, 3, 2]);
        assert_eq!(g.edge_count(), 4);
        assert_eq!(attr_name(g.attrs[0]), 1);
        assert_eq!(attr_class(g.attrs[6]), WayClass::Steps);
    }

    /// Every segment of `w`, as `(snap origin, other end, attr)`.
    type Segment = ((i32, i32), (i32, i32), u32);

    pub(crate) fn segments_of(w: &WalkGraph) -> BTreeSet<Segment> {
        let mut out = BTreeSet::new();
        for c in 0..w.chain_count() as u32 {
            for k in 0..w.chain_segments(c) {
                let (p, q) = (w.chain_point_e7(c, k), w.chain_point_e7(c, k + 1));
                let s = w.segment_base(c) + k;
                let (o, e) = if w.segment_flipped(s) { (q, p) } else { (p, q) };
                assert!(out.insert((o, e, w.chain_attr(c))), "segment twice");
            }
        }
        out
    }

    /// `w` is `g` contracted: same points, same segments (with the
    /// lower-id end as snap origin), same names and meta, and every
    /// interior point has degree 2 with one attr.
    pub(crate) fn assert_same(g: &Graph, w: &WalkGraph) {
        assert_eq!(w.point_count(), g.node_count());
        assert_eq!(w.segment_count(), g.edge_count());
        let pts: BTreeSet<_> = (0..w.point_count()).map(|i| w.point_e7(i)).collect();
        let want_pts: BTreeSet<_> = (0..g.node_count())
            .map(|u| (g.lat_e7[u], g.lon_e7[u]))
            .collect();
        assert_eq!(pts, want_pts);
        let c = |u: u32| (g.lat_e7[u as usize], g.lon_e7[u as usize]);
        let mut want = BTreeSet::new();
        for u in 0..g.node_count() as u32 {
            for h in g.neighbors_of(u) {
                let v = g.neighbors[h];
                if v > u {
                    want.insert((c(u), c(v), g.attrs[h]));
                }
            }
        }
        assert_eq!(segments_of(w), want);
        let mut degree = 0;
        for j in 0..w.junction_count() as u32 {
            for hc in w.half_chains(j) {
                let (a, b) = w.chain_ends(hc.chain);
                assert_eq!(if hc.reversed { b } else { a }, j);
                degree += 1;
            }
        }
        assert_eq!(degree, 2 * w.chain_count());
        assert_eq!(w.name_count(), g.names.len());
        for (i, s) in g.names.iter().enumerate() {
            assert_eq!(w.name(i as u32), s);
        }
        assert_eq!(w.meta(), &g.meta);
    }

    #[test]
    fn round_trips_through_bytes() {
        let g = sample();
        let bytes = encode(&g);
        assert_eq!(&bytes[0..4], b"PTWG");
        assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 2);
        let w = decode(&bytes).unwrap();
        assert_same(&g, &w);
        // Every node of the triangle has degree 2 but 0 and 2 change attr;
        // 1 is a junction too (Street vs Crossing).
        assert_eq!((w.junction_count(), w.chain_count()), (4, 4));
    }

    #[test]
    fn round_trips_isolated_nodes_and_an_empty_graph() {
        let g = Graph::from_edges(
            vec![0, 0, 0],
            vec![0, 1, 2],
            &[(0, 2, pack_attr(0, WayClass::Path))],
            vec![String::new()],
            Meta::default(),
        );
        assert_same(&g, &decode(&encode(&g)).unwrap());
        let empty = Graph::from_edges(vec![], vec![], &[], vec![String::new()], Meta::default());
        assert_same(&empty, &decode(&encode(&empty)).unwrap());
    }

    #[test]
    fn contracts_a_pure_cycle_at_its_lowest_node() {
        // A 6-ring plus, separately, a path 6-7-8: the ring has no junction
        // of its own, so node 0 becomes its anchor.
        let mut coords = ring(6, 546_800_000);
        coords.extend([(546_900_000, 0), (546_900_000, 10), (546_900_000, 20)]);
        let p = pack_attr(0, WayClass::Path);
        let mut edges: Vec<_> = (0..6)
            .map(|i| (i.min((i + 1) % 6), i.max((i + 1) % 6), p))
            .collect();
        edges.extend([(6, 7, p), (7, 8, p)]);
        let g = graph_of(&coords, &edges, 1);
        let w = decode(&encode(&g)).unwrap();
        assert_same(&g, &w);
        // Junctions: the anchor 0 and the path ends 6, 8.
        assert_eq!((w.junction_count(), w.chain_count()), (3, 2));
        let cycle = (0..2).find(|&c| w.chain_ends(c) == (0, 0)).unwrap();
        assert_eq!(w.chain_segments(cycle), 6);
        assert_eq!(w.half_chains(0).count(), 2);
    }

    #[test]
    fn splits_a_chain_where_the_attr_changes() {
        // 0-1-2-3-4 straight; edges 0-1, 1-2 are Street, 2-3, 3-4 Path.
        let coords: Vec<_> = (0..5)
            .map(|i| (546_800_000, 252_800_000 + 100 * i))
            .collect();
        let s = pack_attr(1, WayClass::Street);
        let p = pack_attr(0, WayClass::Path);
        let g = graph_of(&coords, &[(0, 1, s), (1, 2, s), (2, 3, p), (3, 4, p)], 2);
        let w = decode(&encode(&g)).unwrap();
        assert_same(&g, &w);
        assert_eq!((w.junction_count(), w.chain_count()), (3, 2));
        let attrs: BTreeSet<_> = (0..2)
            .map(|c| (w.chain_attr(c), w.chain_segments(c)))
            .collect();
        assert_eq!(attrs, BTreeSet::from([(s, 2), (p, 2)]));
    }

    #[test]
    fn keeps_parallel_chains_and_lollipops() {
        // Two different 2-segment chains between junctions 0 and 1 (each a
        // degree-3 node because of a tail), and a loop 1-4-5-1.
        let coords = [
            (0, 0),
            (0, 1000),
            (100, 500),
            (-100, 500),
            (300, 1000),
            (300, 1300),
            (0, -100),
        ];
        let p = pack_attr(0, WayClass::Path);
        let edges = [
            (0, 2, p),
            (1, 2, p),
            (0, 3, p),
            (1, 3, p),
            (1, 4, p),
            (4, 5, p),
            (1, 5, p),
            (0, 6, p),
        ];
        let g = graph_of(&coords, &edges, 1);
        let w = decode(&encode(&g)).unwrap();
        assert_same(&g, &w);
        // Junctions 0, 1, 6; chains 0-2-1, 0-3-1, 1-4-5-1, 0-6.
        assert_eq!((w.junction_count(), w.chain_count()), (3, 4));
        assert_eq!(w.half_chains(1).count(), 4);
    }

    #[test]
    fn decoded_heap_bytes_are_exact() {
        let w = decode(&encode(&sample())).unwrap();
        // 4 junctions × 8 + 5 joff × 4 + 8 jadj × 4 + 4 chains × 10 + 5
        // chain_pts × 4 + 1 flip word × 8 + 12 name bytes + 3 name offsets
        // × 4 + 7 + 10 + 4 meta bytes.
        assert_eq!(w.heap_bytes(), 32 + 20 + 32 + 40 + 20 + 8 + 12 + 12 + 21);
    }

    #[test]
    fn encoding_is_deterministic() {
        assert_eq!(encode(&sample()), encode(&sample()));
    }

    #[test]
    fn rejects_bad_headers() {
        let good = encode(&sample());
        let mut b = good.clone();
        b[0] = b'X';
        assert_eq!(decode(&b), Err(FormatError::BadMagic));
        let mut b = good.clone();
        b[4] = 1;
        assert_eq!(decode(&b), Err(FormatError::UnsupportedVersion(1)));
        let mut b = good.clone();
        b[6] = 1;
        assert_eq!(decode(&b), Err(FormatError::UnknownFlags(1)));
        let mut b = good.clone();
        b[24] = 0;
        assert_eq!(decode(&b), Err(FormatError::BadLayout("section offset")));
        assert_eq!(decode(&good[..40]), Err(FormatError::Truncated));
    }

    #[test]
    fn rejects_trailing_and_missing_bytes() {
        let mut b = encode(&sample());
        b.push(0);
        assert_eq!(
            decode(&b),
            Err(FormatError::BadLayout("sections do not end at EOF"))
        );
        let b = encode(&sample());
        for cut in 1..b.len() - HEADER_LEN {
            assert!(decode(&b[..b.len() - cut]).is_err(), "cut {cut}");
        }
    }

    fn file(juncs: &[u8], chains: &[u8], orient: &[u8], counts: (u32, u32, u32, u32)) -> Vec<u8> {
        let mut names = Vec::new();
        write_str(&mut names, "");
        let mut meta = Vec::new();
        for s in ["c", "d", "s"] {
            write_str(&mut meta, s);
        }
        assemble(counts, [juncs, chains, orient, &names, &meta])
    }

    fn two_junctions() -> Vec<u8> {
        let mut j = Vec::new();
        for v in [546_800_000i64, 252_800_000, 0, 10_000] {
            write_uvarint(&mut j, zigzag(v));
        }
        j
    }

    #[test]
    fn decodes_a_minimal_hand_written_file() {
        // Junction 0 → 1 with one interior point, segment 1 flipped.
        let chains = [1u8, 1, 0, 1, 1, 2, 4, 0];
        let w = decode(&file(&two_junctions(), &chains, &[0b10], (2, 1, 1, 1))).unwrap();
        assert_eq!(w.chain_point_e7(0, 1), (546_800_001, 252_800_002));
        assert!(!w.segment_flipped(0) && w.segment_flipped(1));
        assert_eq!(w.chain_class(0), WayClass::Path);
    }

    #[test]
    fn rejects_bad_chains() {
        let j = two_junctions();
        let one = (2, 1, 0, 1);
        let bad = |chains: &[u8], orient: &[u8], counts| decode(&file(&j, chains, orient, counts));
        // Loop without interior points.
        assert_eq!(
            bad(&[1, 0, 0, 0, 0, 0], &[0], one),
            Err(FormatError::BadEdge(0))
        );
        // End junction that does not exist.
        assert_eq!(
            bad(&[1, 5, 0, 0, 0, 0], &[0], one),
            Err(FormatError::BadEdge(0))
        );
        // Name id out of range.
        assert_eq!(
            bad(&[1, 1, 3, 0, 0, 0], &[0], one),
            Err(FormatError::BadName(0))
        );
        // Unknown class byte.
        assert_eq!(
            bad(&[1, 1, 0, 9, 0, 0], &[0], one),
            Err(FormatError::BadClass(9))
        );
        // More interior points than the header admits.
        assert_eq!(
            bad(&[1, 1, 0, 0, 1, 2, 4, 0], &[0], one),
            Err(FormatError::CountMismatch("interior points"))
        );
        // Fewer interior points than the header says.
        assert_eq!(
            bad(&[1, 1, 0, 0, 0, 0, 0, 0], &[0], (2, 1, 1, 1)),
            Err(FormatError::CountMismatch("interior points"))
        );
        // A second chain the header does not count.
        assert_eq!(
            bad(&[2, 1, 0, 0, 0, 0, 0, 0, 0], &[0], one),
            Err(FormatError::CountMismatch("chains"))
        );
        // Header says 2 chains, section has 1.
        assert_eq!(
            bad(&[1, 1, 0, 0, 0, 0], &[0], (2, 2, 0, 1)),
            Err(FormatError::Truncated)
        );
        // Interior point off the globe.
        let mut far = vec![1u8, 1, 0, 0, 1];
        write_uvarint(&mut far, zigzag(900_000_000));
        far.extend([0, 0]);
        assert_eq!(
            bad(&far, &[0], (2, 1, 1, 1)),
            Err(FormatError::CoordOutOfRange(2))
        );
        // The valid version decodes.
        assert!(bad(&[1, 1, 0, 0, 0, 0], &[0], one).is_ok());
    }

    #[test]
    fn rejects_bad_orient_sections() {
        let j = two_junctions();
        let chains = [1u8, 1, 0, 0, 0, 0];
        let one = (2, 1, 0, 1);
        assert_eq!(
            decode(&file(&j, &chains, &[], one)),
            Err(FormatError::BadLayout("orient section length"))
        );
        assert_eq!(
            decode(&file(&j, &chains, &[0, 0], one)),
            Err(FormatError::BadLayout("orient section length"))
        );
        assert_eq!(
            decode(&file(&j, &chains, &[0b10], one)),
            Err(FormatError::BadLayout("orient padding"))
        );
        assert!(decode(&file(&j, &chains, &[1], one)).is_ok());
    }

    #[test]
    fn rejects_out_of_range_coordinates_and_bad_names() {
        let mut juncs = Vec::new();
        for v in [950_000_000i64, 0] {
            write_uvarint(&mut juncs, zigzag(v));
        }
        assert_eq!(
            decode(&file(&juncs, &[0], &[], (1, 0, 0, 1))),
            Err(FormatError::CoordOutOfRange(0))
        );
        let mut overflow = Vec::new();
        for v in [900_000_000i64, 0, i64::MAX, 0] {
            write_uvarint(&mut overflow, zigzag(v));
        }
        assert_eq!(
            decode(&file(&overflow, &[0, 0], &[], (2, 0, 0, 1))),
            Err(FormatError::CoordOutOfRange(1))
        );
        let mut bad_names = Vec::new();
        write_str(&mut bad_names, "x"); // names[0] must be ""
        let b = assemble(
            (2, 0, 0, 1),
            [&two_junctions(), &[0, 0], &[], &bad_names, &[0, 0, 0]],
        );
        assert_eq!(decode(&b), Err(FormatError::BadName(0)));
    }

    #[test]
    fn rejects_counts_before_allocating() {
        let j = two_junctions();
        for (counts, err) in [
            ((MAX_NODES + 1, 0, 0, 1), FormatError::TooLarge("nodes")),
            ((2, 0, MAX_NODES, 1), FormatError::TooLarge("nodes")),
            ((2, MAX_EDGES + 1, 0, 1), FormatError::TooLarge("edges")),
            ((2, MAX_EDGES, 1, 1), FormatError::TooLarge("edges")),
            (
                (2, 0, 0, MAX_INDEX_NAMES + 1),
                FormatError::TooLarge("names"),
            ),
            ((2, 0, 0, 0), FormatError::BadName(0)),
            // Plausible counts, but far more than the bytes can hold.
            ((2, 1_000_000, 0, 1), FormatError::Truncated),
            ((2, 0, 1_000_000, 1), FormatError::Truncated),
            ((1_000, 0, 0, 1), FormatError::Truncated),
        ] {
            assert_eq!(
                decode(&file(&j, &[0, 0], &[], counts)),
                Err(err),
                "{counts:?}"
            );
        }
    }
}
