//! A fixed-length bit set backed by `Vec<u64>`, used for the once-per-query
//! active-service membership index.
//!
//! Replaces the previous `Vec<bool>` (one byte per service) with a packed
//! `Vec<u64>` (one bit per service). This is a pure REPRESENTATION change: the
//! hot-path predicate `!active.get(idx)` must decide IDENTICALLY to the old
//! `!active[idx]`, so [`Bitset`] keeps **panic-on-out-of-bounds** semantics —
//! the index path mirrors `Vec<bool>` exactly (it is safe by construction: every
//! caller indexes with `service_idx < num_services`, the length passed to
//! [`Bitset::with_len`]). Do NOT "improve" `get`/`set` to bounds-checked
//! `Option`/`&[]` — that would fork behaviour from the TS engine and the
//! `Vec<bool>` it ports.

use alloc::vec::Vec;

/// 64-bit word width of the backing store.
const WORD_BITS: usize = 64;

/// A fixed-length bit set: `len` logical bits packed into `ceil(len / 64)` `u64`
/// words, LSB-first within each word. Index `i` lives in word `i / 64` at bit
/// `i % 64`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Bitset {
    words: Vec<u64>,
    len: usize,
}

impl Bitset {
    /// Allocate a zero-initialised bit set holding `len` bits. The word count is
    /// `ceil(len / 64)`. `div_ceil` cannot overflow, which matters on wasm32
    /// where `usize == u32` (I15).
    #[inline]
    pub(crate) fn with_len(len: usize) -> Self {
        let words = len.div_ceil(WORD_BITS);
        Bitset {
            words: alloc::vec![0u64; words],
            len,
        }
    }

    /// Number of logical bits.
    #[inline]
    #[allow(dead_code)] // exercised by tests; kept for parity with `Vec::len`
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    /// Set bit `i` to 1. **Panics on out-of-bounds** (mirrors `Vec<bool>`
    /// indexing — safe by construction: `i < num_services`).
    #[inline(always)]
    pub(crate) fn set(&mut self, i: usize) {
        self.words[i / WORD_BITS] |= 1u64 << (i % WORD_BITS);
    }

    /// Read bit `i`. **Panics on out-of-bounds** (mirrors `Vec<bool>` indexing —
    /// safe by construction: `i < num_services`).
    #[inline(always)]
    pub(crate) fn get(&self, i: usize) -> bool {
        (self.words[i / WORD_BITS] >> (i % WORD_BITS)) & 1 == 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- I15 boundary: word-count is `ceil(len / 64)` ----
    #[test]
    fn with_len_word_count_boundaries() {
        assert_eq!(Bitset::with_len(0).words.len(), 0, "0 bits -> 0 words");
        assert_eq!(Bitset::with_len(1).words.len(), 1, "1 bit -> 1 word");
        assert_eq!(Bitset::with_len(63).words.len(), 1, "63 bits -> 1 word");
        assert_eq!(Bitset::with_len(64).words.len(), 1, "64 bits -> 1 word");
        assert_eq!(Bitset::with_len(65).words.len(), 2, "65 bits -> 2 words");
        assert_eq!(Bitset::with_len(128).words.len(), 2, "128 bits -> 2 words");
        assert_eq!(Bitset::with_len(129).words.len(), 3, "129 bits -> 3 words");
    }

    #[test]
    fn with_len_records_len() {
        assert_eq!(Bitset::with_len(0).len(), 0);
        assert_eq!(Bitset::with_len(65).len(), 65);
    }

    // ---- set/get round-trip, including across the 63/64 word boundary ----
    #[test]
    fn set_get_round_trip() {
        let mut b = Bitset::with_len(200);
        // Default: all clear.
        for i in 0..200 {
            assert!(!b.get(i), "bit {i} starts clear");
        }
        // Set a spread of bits including the 63/64 boundary and the next word.
        for &i in &[0usize, 1, 62, 63, 64, 65, 127, 128, 199] {
            b.set(i);
        }
        for i in 0..200 {
            let want = matches!(i, 0 | 1 | 62 | 63 | 64 | 65 | 127 | 128 | 199);
            assert_eq!(b.get(i), want, "bit {i}");
        }
    }

    #[test]
    fn set_idempotent_and_independent() {
        let mut b = Bitset::with_len(64);
        b.set(63);
        b.set(63); // idempotent
        assert!(b.get(63));
        // Setting bit 63 must not bleed into bit 0 of the (nonexistent) next word
        // or any other bit in the same word.
        for i in 0..63 {
            assert!(!b.get(i), "bit {i} unaffected by set(63)");
        }
    }

    #[test]
    #[should_panic]
    fn get_out_of_bounds_panics() {
        // Panic-on-OOB equivalence with Vec<bool> — index 1 in a 1-bit set whose
        // single word holds 64 slots still panics because words.len() == 1 and
        // word index 0 is the only valid word... so use a clearly OOB word index.
        let b = Bitset::with_len(0); // 0 words
        let _ = b.get(0); // word index 0 is out of bounds -> panic
    }

    #[test]
    #[should_panic]
    fn set_out_of_bounds_panics() {
        let mut b = Bitset::with_len(0); // 0 words
        b.set(0); // word index 0 is out of bounds -> panic
    }
}
