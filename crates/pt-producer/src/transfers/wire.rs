//! PTFT wire encoder — port of scripts/lib/transfers/wire.mjs encode() (canonical spec:
//! packages/shared/src/transfers/wire.ts). Magic "PTFT", version 1, varint(stopCount), then
//! per-stop: varint(idLen) + utf8 bytes + varint(edgeCount) + (varint(neighborIdx) +
//! varint(walkSecs)) pairs, edges sorted by walkSecs ascending (stable — ties keep input order,
//! matching V8's stable sort and Rust's stable sort_by).

use crate::error::{Error, Result};

const MAGIC: [u8; 4] = *b"PTFT";
const VERSION: u8 = 1;

/// `edges[i]` = outgoing (neighbor_idx, walk_secs) pairs for stop i. Mirrors `encode(stopIds,
/// edges)` (wire.mjs:21). Panics on the same invariant violations the JS throws on (self-edge,
/// out-of-range neighbor) — use `encode_checked` if the caller needs a `Result` instead (build.rs
/// uses `encode_checked`).
pub fn encode(stop_ids: &[String], edges: &[Vec<(u32, u32)>]) -> Vec<u8> {
    encode_checked(stop_ids, edges).expect("transfers wire encode invariants")
}

pub fn encode_checked(stop_ids: &[String], edges: &[Vec<(u32, u32)>]) -> Result<Vec<u8>> {
    if edges.len() != stop_ids.len() {
        return Err(Error::Config(format!(
            "transfers encode: edges.len() ({}) must equal stop_ids.len() ({})",
            edges.len(),
            stop_ids.len()
        )));
    }

    let mut out = Vec::new();
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    encode_varint(stop_ids.len() as u64, &mut out);

    for (i, id) in stop_ids.iter().enumerate() {
        let id_bytes = id.as_bytes();
        encode_varint(id_bytes.len() as u64, &mut out);
        out.extend_from_slice(id_bytes);

        for &(neighbor_idx, _) in &edges[i] {
            if neighbor_idx as usize == i {
                return Err(Error::Config(format!(
                    "transfers encode: stop index {i} has a self-edge"
                )));
            }
            if neighbor_idx as usize >= stop_ids.len() {
                return Err(Error::Config(format!(
                    "transfers encode: stop index {i} has out-of-range neighborIdx {neighbor_idx}"
                )));
            }
        }

        // Stable sort by walk_secs ascending — matches V8's spec-stable
        // Array.prototype.sort (wire.mjs:65) and preserves the caller's
        // (walk_secs, neighbor_idx) tie order from build_transfers_from_stop.
        let mut sorted = edges[i].clone();
        sorted.sort_by_key(|&(_, secs)| secs);
        encode_varint(sorted.len() as u64, &mut out);
        for (neighbor_idx, walk_secs) in sorted {
            encode_varint(neighbor_idx as u64, &mut out);
            encode_varint(walk_secs as u64, &mut out);
        }
    }

    Ok(out)
}

/// LEB128 varint, matching wire.mjs's encodeVarint (wire.mjs:175-187).
fn encode_varint(mut value: u64, out: &mut Vec<u8>) {
    loop {
        if value < 0x80 {
            out.push(value as u8);
            return;
        }
        out.push(((value & 0x7f) | 0x80) as u8);
        value >>= 7;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_node_golden() {
        let stop_ids = vec!["s0".to_string(), "s1".to_string(), "s2".to_string()];
        let edges = vec![vec![(1u32, 120u32), (2, 45)], vec![], vec![(0, 45)]];
        let expected = include_bytes!("../../tests/fixtures/transfers_wire_golden.bin");
        assert_eq!(encode(&stop_ids, &edges), expected.to_vec());
    }

    #[test]
    fn rejects_self_edge() {
        let stop_ids = vec!["s0".to_string()];
        let edges = vec![vec![(0u32, 10u32)]];
        assert!(encode_checked(&stop_ids, &edges).is_err());
    }

    #[test]
    fn rejects_out_of_range_neighbor() {
        let stop_ids = vec!["s0".to_string()];
        let edges = vec![vec![(5u32, 10u32)]]; // only 1 stop, neighbor_idx 5 is out of range
        assert!(encode_checked(&stop_ids, &edges).is_err());
    }

    #[test]
    fn rejects_length_mismatch() {
        let stop_ids = vec!["s0".to_string(), "s1".to_string()];
        let edges = vec![vec![]]; // length 1, should be 2
        assert!(encode_checked(&stop_ids, &edges).is_err());
    }
}
