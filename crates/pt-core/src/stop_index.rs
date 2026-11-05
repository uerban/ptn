//! Persisted StopIndex — region `0x44`.
//!
//! A sorted `(fnv32 u32, stringpool_idx u32, ordinal u32)` table that resolves a
//! `stop_id` string to its ordinal without the eager `HashMap` rebuild at load.
//! `fnv32` is only a binary-search *filter*; an exact full-string tiebreak
//! (resolving `stringpool_idx` via the StringPool) means a hash collision can
//! never return a wrong ordinal. Duplicate `stop_id`s keep the LAST ordinal,
//! reproducing the `HashMap<String,u32>` last-wins semantics (reader.rs:196).

use alloc::vec::Vec;
use hashbrown::HashMap;

/// Tagged region ID for the persisted StopIndex (
/// `docs/ptb-region-ids.md` §4), addressed by `region_by_id` (it is not a carry;
/// see `header::CARRY_REGIONS`).
pub const REGION_ID: u16 = 0x44;

/// Bytes per table entry: `(fnv32 u32, stringpool_idx u32, ordinal u32)`.
const ENTRY: usize = 12;

/// FNV-1a, 32-bit. The hash stored in the table and recomputed at lookup.
pub fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Build the serialized StopIndex region from an insertion sequence of
/// `(stringpool_idx, ordinal)` pairs (stop order). Duplicate ids (same
/// `stringpool_idx`) keep the LAST ordinal. `resolve` maps a `stringpool_idx`
/// to its id string (for hashing). Output is sorted by `(fnv32, stringpool_idx)`.
pub fn build<'a>(seq: &[(u32, u32)], resolve: impl Fn(u32) -> Option<&'a str>) -> Vec<u8> {
    // last-wins per distinct id (same stringpool_idx) — mirrors the HashMap.
    let mut last: HashMap<u32, (u32, u32)> = HashMap::new();
    for &(idx, ord) in seq {
        if let Some(s) = resolve(idx) {
            last.insert(idx, (fnv1a32(s.as_bytes()), ord));
        }
    }
    let mut entries: Vec<(u32, u32, u32)> =
        last.iter().map(|(&idx, &(f, ord))| (f, idx, ord)).collect();
    // sort by (fnv32, stringpool_idx) for a deterministic binary search.
    entries.sort_unstable_by_key(|entry| (entry.0, entry.1));
    let mut out = Vec::with_capacity(entries.len() * ENTRY);
    for (f, idx, ord) in entries {
        out.extend_from_slice(&f.to_le_bytes());
        out.extend_from_slice(&idx.to_le_bytes());
        out.extend_from_slice(&ord.to_le_bytes());
    }
    out
}

/// Resolve `key` to its ordinal via the persisted `region`, or `None` if absent.
/// `resolve` maps a candidate's `stringpool_idx` to its id string for the tiebreak.
pub fn lookup<'a>(
    region: &[u8],
    key: &str,
    resolve: impl Fn(u32) -> Option<&'a str>,
) -> Option<u32> {
    let n = region.len() / ENTRY;
    let target = fnv1a32(key.as_bytes());
    // binary-search for the first entry with fnv >= target.
    let (mut lo, mut hi) = (0usize, n);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if read_u32(region, mid * ENTRY) < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    // scan the equal-hash run; full-string tiebreak via `resolve` so a hash
    // collision can never return a wrong ordinal.
    let mut i = lo;
    while i < n && read_u32(region, i * ENTRY) == target {
        let idx = read_u32(region, i * ENTRY + 4);
        if resolve(idx) == Some(key) {
            return Some(read_u32(region, i * ENTRY + 8));
        }
        i += 1;
    }
    None
}

#[inline]
fn read_u32(region: &[u8], byte_off: usize) -> u32 {
    u32::from_le_bytes([
        region[byte_off],
        region[byte_off + 1],
        region[byte_off + 2],
        region[byte_off + 3],
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use hashbrown::HashMap;

    #[test]
    fn lookup_matches_hashmap_with_dup_last_wins() {
        // StringPool: stringpool_idx -> id string (deduped, so a repeated id
        // reuses the same idx — mirrors the real pool).
        let pool = ["A", "B", "C"];
        let resolve = |i: u32| pool.get(i as usize).copied();
        // Insertion sequence (stringpool_idx, ordinal); "A" (idx 0) is a dup
        // whose later ordinal (3) must win.
        let seq = [(0u32, 0u32), (1, 1), (2, 2), (0, 3)];

        // Reference: HashMap with last-wins, keyed by the id string.
        let mut reference: HashMap<&str, u32> = HashMap::new();
        for &(idx, ord) in &seq {
            reference.insert(pool[idx as usize], ord);
        }

        let region = build(&seq, resolve);
        for &(idx, _) in &seq {
            let id = pool[idx as usize];
            assert_eq!(
                lookup(&region, id, resolve),
                reference.get(id).copied(),
                "id {id} must match HashMap"
            );
        }
        assert_eq!(lookup(&region, "A", resolve), Some(3), "dup id last-wins");
        assert_eq!(lookup(&region, "Z", resolve), None, "absent id => None");
    }

    #[test]
    fn lookup_resolves_real_fnv32_collision_via_string_tiebreak() {
        // "S2U9" and "AGCVF" are a verified fnv-1a32 collision (0xccc0c3b2).
        // Self-validating: if fnv1a32 ever changes this fires — regenerate the
        // pair. (QA A6-2: the parity corpus must contain a *real* collision, or
        // the binary-search-then-string-tiebreak path is never exercised.)
        assert_eq!(
            fnv1a32(b"S2U9"),
            fnv1a32(b"AGCVF"),
            "corpus needs a real fnv32 collision; regenerate if fnv1a32 changed"
        );
        let pool = ["S2U9", "AGCVF", "X"];
        let resolve = |i: u32| pool.get(i as usize).copied();
        // distinct ordinals for the colliding ids (a dedup-by-hash bug would
        // collapse them and return a wrong ordinal — this guards against that).
        let seq = [(0u32, 10u32), (1, 20), (2, 30)];
        let region = build(&seq, resolve);
        assert_eq!(lookup(&region, "S2U9", resolve), Some(10), "collision id A");
        assert_eq!(
            lookup(&region, "AGCVF", resolve),
            Some(20),
            "collision id B"
        );
        assert_eq!(lookup(&region, "X", resolve), Some(30));
        assert_eq!(lookup(&region, "ZZZZ", resolve), None, "absent => None");
    }
}
