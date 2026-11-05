//! Verbatim port of pairSortByB (packages/backend/src/gtfs/index-builder.ts:541).
//! UNSTABLE quicksort over parallel u32 columns, sorted by `b`. The tie order
//! it produces is part of the tile wire contract — do NOT replace with
//! slice::sort_unstable_by_key or change the cutoff/pivot/partition.

/// Sort `a`/`b` (parallel columns) in `[lo, hi)` ascending by `b`, swapping
/// both columns together. Insertion sort for ranges <= 16; median-of-three
/// pivot; Hoare partition; smaller-half-first recursion.
///
/// # Panics
/// Panics on out-of-bounds indexing unless `lo <= hi <= a.len()` and
/// `b.len() >= a.len()` region-wise (the columns must be parallel); mirrors
/// the TS original, which has the same implicit contract.
pub fn pair_sort_by_b(a: &mut [u32], b: &mut [u32], lo: usize, hi: usize) {
    // Insertion sort for small sub-ranges (standard quicksort polish).
    if hi - lo <= 16 {
        for i in (lo + 1)..hi {
            let ai = a[i];
            let bi = b[i];
            let mut j = i;
            while j > lo && b[j - 1] > bi {
                a[j] = a[j - 1];
                b[j] = b[j - 1];
                j -= 1;
            }
            a[j] = ai;
            b[j] = bi;
        }
        return;
    }

    // Median-of-three pivot — guards against already-sorted input, which is
    // common because stop_times.txt rows often arrive near-departure order.
    let mid = (lo + hi) >> 1;
    let b0 = b[lo];
    let b1 = b[mid];
    let b2 = b[hi - 1];
    let pivot = if b0 > b1 {
        if b1 > b2 {
            b1
        } else if b0 > b2 {
            b2
        } else {
            b0
        }
    } else if b0 > b2 {
        b0
    } else if b1 > b2 {
        b2
    } else {
        b1
    };

    // Hoare partition — i/j as isize so j can pass below lo, mirroring the
    // JS `while (i <= j)` loop exactly.
    let mut i = lo as isize;
    let mut j = (hi - 1) as isize;
    while i <= j {
        while b[i as usize] < pivot {
            i += 1;
        }
        while b[j as usize] > pivot {
            j -= 1;
        }
        if i <= j {
            a.swap(i as usize, j as usize);
            b.swap(i as usize, j as usize);
            i += 1;
            j -= 1;
        }
    }

    // Standard Hoare recursion bounds: left = [lo, j+1), right = [j+1, hi).
    // Recurse on the smaller half first to bound stack depth. The comparison
    // is the TS's literal `j - lo < hi - (j + 1)` — i.e. left-first also when
    // the halves are exactly equal — kept verbatim even though recursion
    // order can never change the sorted output (disjoint ranges).
    let left_end = (j + 1) as usize;
    if j - (lo as isize) < hi as isize - (j + 1) {
        pair_sort_by_b(a, b, lo, left_end);
        pair_sort_by_b(a, b, left_end, hi);
    } else {
        pair_sort_by_b(a, b, left_end, hi);
        pair_sort_by_b(a, b, lo, left_end);
    }
}

#[cfg(test)]
mod tests {
    use super::pair_sort_by_b;

    #[test]
    fn sorts_by_b_carrying_a() {
        let mut a = vec![10u32, 20, 30];
        let mut b = vec![300u32, 100, 200];
        let n = a.len();
        pair_sort_by_b(&mut a, &mut b, 0, n);
        assert_eq!(b, vec![100, 200, 300]);
        assert_eq!(a, vec![20, 30, 10]);
    }

    // Tie order must match the TS algorithm exactly: pinned against the real
    // pairSortByB output. Generated with (after `pnpm --filter @pt/backend
    // build`):
    //
    //   node -e '
    //   import("./packages/backend/dist/gtfs/index-builder.js").then(m => {
    //     const a = Uint32Array.from({length: 20}, (_, i) => i);
    //     const b = Uint32Array.from([5,3,5,1,3,5,1,2,2,5,3,1,4,4,2,5,1,3,4,2]);
    //     m.pairSortByB(a, b, 0, 20);
    //     console.log(Array.from(a).join(","));
    //   })'
    #[test]
    fn tie_order_matches_ts_for_pinned_input() {
        // 20 pairs, heavy ties in b — exercises the quicksort path (cutoff 16).
        let mut a: Vec<u32> = (0..20).collect();
        let mut b: Vec<u32> = vec![5, 3, 5, 1, 3, 5, 1, 2, 2, 5, 3, 1, 4, 4, 2, 5, 1, 3, 4, 2];
        let n = a.len();
        pair_sort_by_b(&mut a, &mut b, 0, n);
        let expected_a: Vec<u32> = vec![
            16, 3, 11, 6, 19, 14, 7, 8, 17, 10, 4, 1, 12, 13, 18, 9, 5, 15, 2, 0,
        ];
        assert_eq!(a, expected_a);
        assert!(b.windows(2).all(|w| w[0] <= w[1]));
    }

    // 500 deterministic pseudo-random pairs (LCG), heavy ties — exercises
    // deep recursion + both partition branches. Same LCG mirrored in the node
    // generation snippet (verified byte-for-byte against a matching Rust LCG
    // dump before pinning):
    //
    //   node -e '
    //   let seed = 42n;
    //   const M = (1n << 64n) - 1n;
    //   const next = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & M; return Number((seed >> 33n) % 50n); };
    //   const bArr = Array.from({length: 500}, () => next());
    //   import("./packages/backend/dist/gtfs/index-builder.js").then(m => {
    //     const a = Uint32Array.from({length: 500}, (_, i) => i);
    //     const b = Uint32Array.from(bArr);
    //     m.pairSortByB(a, b, 0, 500);
    //     console.log(Array.from(a).join(","));
    //   })'
    #[test]
    fn large_random_matches_ts() {
        let mut seed: u64 = 42;
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((seed >> 33) % 50) as u32
        };
        let mut a: Vec<u32> = (0..500).collect();
        let mut b: Vec<u32> = (0..500).map(|_| next()).collect();
        let n = a.len();
        pair_sort_by_b(&mut a, &mut b, 0, n);
        let expected_a: Vec<u32> = vec![
            161, 80, 262, 96, 462, 287, 449, 232, 86, 235, 220, 207, 393, 282, 478, 292, 311, 493,
            153, 468, 195, 473, 348, 122, 28, 317, 3, 238, 475, 476, 281, 395, 448, 126, 290, 95,
            349, 10, 242, 430, 162, 224, 109, 61, 65, 93, 418, 253, 408, 340, 405, 184, 409, 144,
            45, 280, 170, 272, 231, 425, 5, 458, 334, 407, 420, 112, 73, 51, 218, 216, 284, 461,
            264, 38, 388, 187, 138, 397, 189, 210, 193, 111, 482, 486, 325, 21, 302, 15, 487, 64,
            128, 217, 411, 49, 150, 279, 113, 483, 16, 24, 117, 450, 148, 350, 259, 379, 7, 226,
            209, 123, 400, 62, 69, 85, 480, 35, 48, 137, 159, 186, 142, 141, 433, 119, 246, 463,
            440, 199, 77, 276, 13, 139, 439, 104, 426, 200, 484, 41, 389, 52, 443, 53, 171, 386,
            335, 289, 76, 313, 8, 412, 477, 256, 116, 167, 336, 102, 341, 498, 419, 25, 331, 98,
            447, 300, 423, 294, 267, 362, 84, 452, 188, 83, 233, 240, 370, 18, 6, 332, 323, 437,
            230, 75, 236, 190, 58, 456, 179, 353, 129, 429, 275, 363, 181, 378, 382, 164, 442, 491,
            305, 270, 375, 146, 27, 390, 492, 196, 366, 87, 55, 436, 432, 391, 295, 54, 78, 140,
            401, 194, 453, 136, 421, 118, 347, 88, 30, 274, 417, 213, 125, 416, 427, 108, 306, 247,
            245, 269, 355, 204, 191, 337, 9, 107, 310, 92, 1, 339, 254, 293, 312, 384, 383, 343,
            31, 244, 79, 467, 237, 166, 151, 469, 124, 174, 435, 251, 252, 202, 143, 169, 399, 319,
            63, 307, 59, 342, 91, 297, 97, 208, 176, 225, 206, 497, 373, 329, 250, 158, 321, 410,
            438, 211, 258, 387, 485, 66, 322, 266, 214, 444, 428, 261, 44, 43, 414, 201, 309, 434,
            413, 68, 273, 455, 239, 479, 219, 152, 12, 36, 277, 249, 301, 57, 359, 260, 402, 344,
            156, 120, 22, 314, 90, 243, 222, 0, 263, 131, 308, 352, 82, 228, 296, 227, 29, 74, 26,
            424, 114, 364, 496, 371, 241, 248, 422, 46, 70, 372, 101, 403, 198, 132, 490, 303, 2,
            445, 374, 495, 180, 182, 299, 14, 358, 72, 33, 351, 354, 396, 130, 328, 367, 489, 474,
            172, 11, 192, 392, 203, 205, 271, 471, 37, 135, 147, 460, 441, 333, 472, 105, 298, 255,
            278, 154, 265, 415, 338, 127, 212, 494, 376, 404, 327, 368, 160, 481, 39, 465, 56, 381,
            459, 451, 185, 99, 100, 110, 67, 89, 94, 103, 40, 121, 19, 4, 499, 268, 346, 157, 163,
            165, 316, 466, 42, 60, 356, 23, 286, 288, 178, 315, 431, 175, 106, 134, 318, 145, 326,
            377, 50, 229, 360, 34, 221, 71, 283, 149, 394, 488, 173, 291, 406, 234, 324, 133, 155,
            177, 454, 457, 385, 223, 47, 115, 464, 330, 168, 470, 304, 446, 81, 285, 32, 257, 357,
            380, 197, 20, 345, 17, 215, 398, 183, 369, 365, 361, 320,
        ];
        assert_eq!(a[..], expected_a[..]);
    }
}
