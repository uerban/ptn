use alloc::{string::String, vec::Vec};
use hashbrown::HashMap;
use rustc_hash::FxBuildHasher;

type FxHashMap<K, V> = HashMap<K, V, FxBuildHasher>;

/// Errors returned by [`Transfers::from_bytes`].
#[derive(Debug, PartialEq, Eq)]
pub enum TransfersError {
    BadMagic,
    BadVersion,
    Truncated,
    Overlong,
    TrailingBytes,
    NeighborOutOfRange,
    SelfEdge,
}

/// Decoded pedestrian-transfer table: a CSR adjacency list over stop IDs.
///
/// Built from a PTFT binary artifact (magic `PTFT`, version 1, varint-encoded
/// adjacency). Provides O(1) stop-ID lookup via an eager hash index and
/// zero-copy edge slices via the CSR offsets.
pub struct Transfers {
    stop_ids: Vec<String>,
    id_to_idx: FxHashMap<String, u32>,
    offsets: Vec<u32>, // len stop_count + 1
    neighbor_ix: Vec<u32>,
    walk_secs: Vec<u32>,
}

const MAGIC: [u8; 4] = [0x50, 0x54, 0x46, 0x54]; // "PTFT"
const VERSION: u8 = 1;

fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64, TransfersError> {
    let mut shift = 0u32;
    let mut out = 0u64;
    loop {
        let b = *buf.get(*pos).ok_or(TransfersError::Truncated)?;
        *pos += 1;
        // Reject over-long encodings (R3 "reject over-long" discipline): the
        // 10th group may only contribute bit 63, i.e. value 0 or 1.
        if shift >= 63 && b > 1 {
            return Err(TransfersError::Overlong);
        }
        out |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Ok(out);
        }
        shift += 7;
        if shift >= 64 {
            return Err(TransfersError::Overlong);
        }
    }
}

impl Transfers {
    /// Decode a PTFT binary buffer into a `Transfers` table.
    ///
    /// Expects magic `PTFT` at bytes [0..4] and version byte `1` at [4].
    /// Returns `BadMagic` / `BadVersion` for header mismatches, `Truncated`
    /// on premature end-of-buffer, `Overlong` on malformed varints,
    /// `TrailingBytes` when extra bytes remain after the final stop,
    /// `NeighborOutOfRange` if an edge target index ≥ stop_count, and
    /// `SelfEdge` if an edge target equals the source stop.
    pub fn from_bytes<B: AsRef<[u8]>>(buf: B) -> Result<Self, TransfersError> {
        let buf = buf.as_ref();
        if buf.len() < 5 || buf[0..4] != MAGIC {
            return Err(TransfersError::BadMagic);
        }
        if buf[4] != VERSION {
            return Err(TransfersError::BadVersion);
        }
        let mut pos = 5usize;
        let stop_count =
            usize::try_from(read_varint(buf, &mut pos)?).map_err(|_| TransfersError::Truncated)?;

        // Each stop needs at least 2 bytes on the wire (id_len + edge_count
        // varints), so a valid stop_count can never exceed the remaining buffer
        // length. Reject a corrupt/hostile count up front so the pre-sized
        // allocations below cannot trigger a multi-GB reservation → OOM/abort.
        if stop_count > buf.len() {
            return Err(TransfersError::Truncated);
        }

        let mut stop_ids = Vec::with_capacity(stop_count);
        let mut id_to_idx = FxHashMap::with_capacity_and_hasher(stop_count, FxBuildHasher);
        let mut offsets = Vec::with_capacity(stop_count + 1);
        let mut neighbor_ix = Vec::new();
        let mut walk_secs = Vec::new();
        offsets.push(0);

        // First pass cannot be split (varint stream is sequential): decode
        // the dictionary + edges in one walk, recording CSR offsets as we go.
        // The id list and edges interleave per wire layout, so we collect ids
        // and edges in the same loop; neighbor range is validated against
        // stop_count which is known up front.
        for i in 0..stop_count {
            let id_len = usize::try_from(read_varint(buf, &mut pos)?)
                .map_err(|_| TransfersError::Truncated)?;
            let end = pos.checked_add(id_len).ok_or(TransfersError::Truncated)?;
            let slice = buf.get(pos..end).ok_or(TransfersError::Truncated)?;
            let id = core::str::from_utf8(slice).map_err(|_| TransfersError::Truncated)?;
            pos = end;
            let owned = String::from(id); // allocate once
            id_to_idx.insert(owned.clone(), i as u32);
            stop_ids.push(owned);

            let edge_count = usize::try_from(read_varint(buf, &mut pos)?)
                .map_err(|_| TransfersError::Truncated)?;
            for _ in 0..edge_count {
                let nbr = u32::try_from(read_varint(buf, &mut pos)?)
                    .map_err(|_| TransfersError::NeighborOutOfRange)?;
                let w = u32::try_from(read_varint(buf, &mut pos)?)
                    .map_err(|_| TransfersError::Truncated)?;
                if nbr as usize >= stop_count {
                    return Err(TransfersError::NeighborOutOfRange);
                }
                if nbr as usize == i {
                    return Err(TransfersError::SelfEdge);
                }
                neighbor_ix.push(nbr);
                walk_secs.push(w);
            }
            let offset_val =
                u32::try_from(neighbor_ix.len()).map_err(|_| TransfersError::Truncated)?;
            offsets.push(offset_val);
        }
        if pos != buf.len() {
            return Err(TransfersError::TrailingBytes);
        }
        Ok(Self {
            stop_ids,
            id_to_idx,
            offsets,
            neighbor_ix,
            walk_secs,
        })
    }

    /// Number of stops in the transfer table.
    pub fn stop_count(&self) -> usize {
        self.stop_ids.len()
    }

    /// Ordinal index of `stop_id`, or `None` if not present.
    pub fn index_of(&self, stop_id: &str) -> Option<u32> {
        self.id_to_idx.get(stop_id).copied()
    }

    /// GTFS stop ID for stop at ordinal `idx`.
    ///
    /// # Panics
    ///
    /// Panics if `idx >= stop_count()` (the slice index is out of range).
    ///
    /// # Index-guard contract (public surface)
    ///
    /// This is an INFALLIBLE, `pub` accessor BY DESIGN: P2's `gen_fixtures`
    /// self-tests consume it across the crate boundary, and the in-crate scan
    /// (`scan.rs`) only ever calls it with a `nbrs[j]` ordinal that decode
    /// already validated to be `< stop_count` (`TransfersError::NeighborOutOfRange`
    /// rejects any edge target `>= stop_count` in [`Transfers::from_bytes`]). So
    /// every internal call site is in-bounds by construction; the `debug_assert!`
    /// makes that contract explicit and trips loudly in debug/test if a future
    /// caller violates it, while release keeps the bare slice index (no `Option`
    /// branch on the hot path).
    ///
    /// The `Option`/`try_*` (fallible) refactor is DEFERRED to the P5 wasm
    /// consumer, where untrusted external indices warrant a checked variant;
    /// changing the signature now would ripple into `scan.rs` for no in-crate
    /// safety gain (see the same note on [`Transfers::edges`]).
    pub fn stop_id(&self, idx: u32) -> &str {
        debug_assert!(
            (idx as usize) < self.stop_ids.len(),
            "Transfers::stop_id index {idx} out of range (stop_count = {})",
            self.stop_ids.len(),
        );
        &self.stop_ids[idx as usize]
    }

    /// Edge slice for stop `idx`: `(neighbor_indices, walk_secs)`.
    ///
    /// # Panics
    ///
    /// Panics if `idx >= stop_count()` (the `offsets[idx]` / `offsets[idx + 1]`
    /// slice indices are out of range).
    ///
    /// # Index-guard contract (public surface)
    ///
    /// Like [`Transfers::stop_id`], this stays an INFALLIBLE, `pub` accessor:
    /// the in-crate scan (`scan.rs`) calls it with the source ordinal returned
    /// by `index_of`, which is always `< stop_count`, and `gen_fixtures`
    /// self-tests call it across the crate boundary. The `offsets` vec has length
    /// `stop_count + 1` (built in [`Transfers::from_bytes`]), so `offsets[idx]`
    /// and `offsets[idx + 1]` are both in range whenever `idx < stop_count`. The
    /// `debug_assert!` documents and enforces that bound in debug/test; release
    /// keeps the bare indices so the footpath-relaxation hot path takes no
    /// `Option` branch.
    ///
    /// An `Option`-returning `edges` (and a `try_stop_id`) is DEFERRED to the P5
    /// wasm consumer: a fallible signature here would ripple into `scan.rs`'s
    /// footpath loop (which relies on the infallible `(&[u32], &[u32])` return)
    /// for no in-crate benefit, since all current call sites are bounds-checked
    /// by `from_bytes` at decode time.
    pub fn edges(&self, idx: u32) -> (&[u32], &[u32]) {
        debug_assert!(
            (idx as usize) + 1 < self.offsets.len(),
            "Transfers::edges index {idx} out of range (stop_count = {})",
            self.stop_count(),
        );
        let s = self.offsets[idx as usize] as usize;
        let e = self.offsets[idx as usize + 1] as usize;
        (&self.neighbor_ix[s..e], &self.walk_secs[s..e])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Encode: magic, version=2, stopCount, then per stop: idLen,id, edgeCount, (neighborIdx, walkSecs)*
    fn push_varint(out: &mut alloc::vec::Vec<u8>, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                break;
            } else {
                out.push(b | 0x80);
            }
        }
    }

    fn tiny() -> alloc::vec::Vec<u8> {
        let mut b = alloc::vec![0x50, 0x54, 0x46, 0x54, 0x01]; // PTFT v1
        push_varint(&mut b, 2); // stopCount
                                // stop 0 "A": one edge -> 1 @ 200s
        push_varint(&mut b, 1);
        b.push(b'A');
        push_varint(&mut b, 1);
        push_varint(&mut b, 1);
        push_varint(&mut b, 200);
        // stop 1 "B": no edges
        push_varint(&mut b, 1);
        b.push(b'B');
        push_varint(&mut b, 0);
        b
    }

    #[test]
    fn decodes_csr_and_index() {
        let t = Transfers::from_bytes(tiny()).unwrap();
        assert_eq!(t.stop_count(), 2);
        assert_eq!(t.index_of("A"), Some(0));
        assert_eq!(t.index_of("B"), Some(1));
        assert_eq!(t.index_of("Z"), None);
        // CSR: A has edges [0,1); offsets = [0,1,1]
        let (n, w) = t.edges(0);
        assert_eq!(n, &[1]);
        assert_eq!(w, &[200]);
        assert_eq!(t.edges(1), (&[][..], &[][..]));
    }

    #[test]
    fn rejects_bad_magic() {
        let mut b = tiny();
        b[0] = b'X';
        assert!(Transfers::from_bytes(b).is_err());
    }

    #[test]
    fn rejects_other_versions() {
        for v in [0u8, 2] {
            let mut b = tiny();
            b[4] = v;
            assert!(matches!(
                Transfers::from_bytes(b),
                Err(TransfersError::BadVersion)
            ));
        }
    }

    #[test]
    fn rejects_legacy_ptnt_v1() {
        let b = alloc::vec![0x50, 0x54, 0x4e, 0x54, 0x01, 0x00];
        assert!(matches!(
            Transfers::from_bytes(b),
            Err(TransfersError::BadMagic)
        ));
    }

    #[test]
    fn rejects_neighbor_out_of_range() {
        // 2 stops; stop 0 has an edge to index 5 (>= stopCount=2).
        let mut b = alloc::vec![0x50, 0x54, 0x46, 0x54, 0x01]; // PTFT v1
        push_varint(&mut b, 2); // stopCount
                                // stop 0 "A": one edge -> 5 (out of range)
        push_varint(&mut b, 1);
        b.push(b'A');
        push_varint(&mut b, 1);
        push_varint(&mut b, 5); // neighborIdx >= stopCount
        push_varint(&mut b, 60);
        // stop 1 "B": no edges
        push_varint(&mut b, 1);
        b.push(b'B');
        push_varint(&mut b, 0);
        assert!(matches!(
            Transfers::from_bytes(b),
            Err(TransfersError::NeighborOutOfRange)
        ));
    }

    #[test]
    fn rejects_self_edge() {
        // 2 stops; stop 0 has an edge to itself (index 0).
        let mut b = alloc::vec![0x50, 0x54, 0x46, 0x54, 0x01]; // PTFT v1
        push_varint(&mut b, 2); // stopCount
                                // stop 0 "A": one edge -> 0 (self)
        push_varint(&mut b, 1);
        b.push(b'A');
        push_varint(&mut b, 1);
        push_varint(&mut b, 0); // neighborIdx == i (self-edge)
        push_varint(&mut b, 60);
        // stop 1 "B": no edges
        push_varint(&mut b, 1);
        b.push(b'B');
        push_varint(&mut b, 0);
        assert!(matches!(
            Transfers::from_bytes(b),
            Err(TransfersError::SelfEdge)
        ));
    }

    #[test]
    fn rejects_truncated() {
        // Valid header + stopCount=2, but buffer ends mid-stream (no stop data).
        let mut b = alloc::vec![0x50, 0x54, 0x46, 0x54, 0x01]; // PTFT v1
        push_varint(&mut b, 2); // stopCount=2, but nothing follows
        assert!(matches!(
            Transfers::from_bytes(b),
            Err(TransfersError::Truncated)
        ));
    }

    #[test]
    fn rejects_trailing_bytes() {
        let mut b = tiny();
        b.extend_from_slice(&[0xff, 0x00]);
        assert!(Transfers::from_bytes(b).is_err());
    }
}
