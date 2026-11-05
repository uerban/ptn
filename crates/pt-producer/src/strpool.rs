use crate::error::Result;
use std::collections::HashMap;

/// Deduplicated UTF-8 string pool. Borrows the strings it interns (`&'a str`)
/// so it adds no second owned copy of the feed's strings during the producer's
/// peak-RSS window. Index 0 is always the empty string.
///
/// Region bytes: `count u32 | offsets[count+1] u32 | blob`, where string `i`
/// is `blob[offsets[i]..offsets[i+1]]`. Length is exact (no trailing pad).
pub struct StringPool<'a> {
    by_str: HashMap<&'a str, u32>,
    order: Vec<&'a str>,
}

impl<'a> StringPool<'a> {
    pub fn new() -> Self {
        let mut p = StringPool {
            by_str: HashMap::new(),
            order: Vec::new(),
        };
        p.intern(""); // reserve index 0
        p
    }

    pub fn intern(&mut self, s: &'a str) -> u32 {
        if let Some(&i) = self.by_str.get(s) {
            return i;
        }
        let i = self.order.len() as u32;
        self.by_str.insert(s, i);
        self.order.push(s);
        i
    }

    pub fn index_of(&self, s: &str) -> u32 {
        *self
            .by_str
            .get(s)
            .expect("StringPool::index_of on a string that was never interned")
    }

    pub fn count(&self) -> u32 {
        self.order.len() as u32
    }

    /// Exact region byte length: `4 + (count+1)*4 + blob_len`.
    pub fn byte_len(&self) -> u64 {
        let count = self.order.len() as u64;
        let blob: u64 = self.order.iter().map(|s| s.len() as u64).sum();
        4 + (count + 1) * 4 + blob
    }

    pub fn write(&self, dest: &mut [u8]) -> Result<()> {
        let count = self.order.len();
        dest[0..4].copy_from_slice(&(count as u32).to_le_bytes());
        let offsets_base = 4;
        let blob_base = offsets_base + (count + 1) * 4;
        // cur accumulates as u64 to avoid overflow on pathological inputs;
        // each offset slot is written as u32. No GTFS feed approaches 4 GiB of
        // string data, so the cast is safe — but u64 prevents a silent wrap.
        let mut cur: u64 = 0;
        for (i, s) in self.order.iter().enumerate() {
            let o = offsets_base + i * 4;
            dest[o..o + 4].copy_from_slice(&(cur as u32).to_le_bytes());
            let bytes = s.as_bytes();
            dest[blob_base + cur as usize..blob_base + cur as usize + bytes.len()]
                .copy_from_slice(bytes);
            cur += bytes.len() as u64;
        }
        let o = offsets_base + count * 4;
        dest[o..o + 4].copy_from_slice(&(cur as u32).to_le_bytes());
        Ok(())
    }
}

impl Default for StringPool<'_> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_string_is_index_zero() {
        let p = StringPool::new();
        assert_eq!(p.count(), 1);
        assert_eq!(p.index_of(""), 0);
    }

    #[test]
    fn dedups_and_assigns_indices_in_first_seen_order() {
        let mut p = StringPool::new();
        assert_eq!(p.intern("S1"), 1);
        assert_eq!(p.intern("Stop One"), 2);
        assert_eq!(p.intern("S1"), 1); // dedup
        assert_eq!(p.count(), 3); // "", S1, Stop One
    }

    #[test]
    fn byte_len_matches_written_region() {
        let mut p = StringPool::new();
        p.intern("S1");
        p.intern("ab");
        let len = p.byte_len() as usize;
        let mut buf = vec![0u8; len];
        p.write(&mut buf).unwrap();
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(buf[4..8].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(buf[8..12].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(buf[12..16].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(buf[16..20].try_into().unwrap()), 4);
        assert_eq!(&buf[20..24], b"S1ab");
        assert_eq!(len, 24);
    }
}
