//! NORMATIVE pattern grouping — the Rust mirror of
//! `packages/shared/src/raptor/patternSignature.ts`. Changing the signature or enumeration order
//! requires editing BOTH in the same PR (lockstep).

use alloc::vec::Vec;

/// Trip-pattern rollout flag. Mirrors the TS `PatternMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatternMode {
    /// Legacy path: one RAPTOR route per GTFS route (longest-trip canonical).
    /// Bit-identical to the pre-pattern engine; ALL existing unit tests must pass
    /// unchanged under this mode.
    Off,
    /// One RAPTOR route per distinct stop-index signature (first-appearance order).
    /// Branch / variant stops become routable.
    Unbounded,
    /// `Unbounded` + covering-merge fold: a short trip whose stop-index signature is a CONTIGUOUS
    /// SUBSEQUENCE of a strictly-longer surviving pattern is folded into that pattern's route,
    /// riding its position slots with `DEP_SECS_NOT_SERVED` (`-1`) holes at the non-served
    /// positions. Implemented in [`covering_merge_fold`] (a post-pass over the first-appearance
    /// grouping); see that function for the normative semantics.
    CoveringMerge,
}

impl PatternMode {
    /// Returns `true` when pattern-splitting is active (any mode other than `Off`).
    pub fn enabled(self) -> bool {
        !matches!(self, PatternMode::Off)
    }
}

/// One group of trips sharing the same stop-index signature.
pub struct PatternGroup {
    /// This pattern's canonical stop-idx sequence (the shared signature).
    pub stop_idxs: Vec<u32>,
    /// Member trip ordinals (route_trips order), in input order.
    pub trip_idxs: Vec<u32>,
    /// Member positions into the route's `sorted_rows`/`trip_idxs` input slices, in input order.
    pub member_pos: Vec<usize>,
    /// Per-member alignment offset into THIS group's `stop_idxs`, aligned 1:1 with
    /// `trip_idxs`/`member_pos`. A NATIVE member (own signature IS this group's `stop_idxs`) has
    /// offset 0 and serves every position. A FOLDED member (`CoveringMerge` only) is a shorter trip
    /// whose signature is a CONTIGUOUS SUBSEQUENCE of `stop_idxs` starting at `offsets[i]`; it
    /// rides this longer pattern but is served only at positions `[offsets[i], offsets[i] +
    /// member_len)` — `DEP_SECS_NOT_SERVED` (`-1`) elsewhere. Under `Off`/`Unbounded` every offset
    /// is 0, so this field is inert and the built index is byte-identical to pre-Phase-5.
    pub offsets: Vec<u32>,
}

/// Group trips by their stop-idx signature (`sigs[i]` is trip `trip_idxs[i]`'s
/// stop-index sequence), in FIRST-APPEARANCE order over the input.
///
/// Members within each group retain their original input order. For
/// `Off`/`Unbounded` this is the plain first-appearance grouping (every member
/// offset 0). For `CoveringMerge` a post-pass folds each group whose signature
/// is a CONTIGUOUS SUBSEQUENCE of a strictly-longer SURVIVING group into that
/// group (see [`covering_merge_fold`] for the exact normative semantics).
///
/// A linear scan over the accumulated groups comparing `g.stop_idxs == sigs[i]`
/// is correct and sufficient — patterns per route are few (≤31 on Oslo).
///
/// Mirrors the TS `groupTripsByPattern` in `patternSignature.ts` (enumeration Pin): same
/// first-appearance order, same member ordering, and a byte-identical CoveringMerge fold.
pub fn group_by_pattern(
    trip_idxs: &[u32],
    sigs: &[Vec<u32>],
    mode: PatternMode,
) -> Vec<PatternGroup> {
    group_by_pattern_with_boarding(trip_idxs, sigs, None, mode)
}

/// PatternSemantics is shared by a pattern, so native trips must agree on
/// every position's pickup/drop-off nibble. A missing column means all regular.
/// CoveringMerge may still fold different semantics: each folded trip reads
/// its own rows or its own original band's semantics, never its host's.
/// GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
pub fn group_by_pattern_with_boarding(
    trip_idxs: &[u32],
    sigs: &[Vec<u32>],
    boarding: Option<&[Vec<u8>]>,
    mode: PatternMode,
) -> Vec<PatternGroup> {
    debug_assert_eq!(
        trip_idxs.len(),
        sigs.len(),
        "trip_idxs and sigs must have the same length"
    );
    if let Some(bytes) = boarding {
        debug_assert_eq!(bytes.len(), trip_idxs.len());
        debug_assert!(bytes.iter().zip(sigs).all(|(b, s)| b.len() == s.len()));
    }

    let mut order: Vec<PatternGroup> = Vec::new();
    'outer: for (i, &t) in trip_idxs.iter().enumerate() {
        for g in order.iter_mut() {
            if g.stop_idxs == sigs[i] && boarding.is_none_or(|b| b[g.member_pos[0]] == b[i]) {
                g.member_pos.push(i);
                g.trip_idxs.push(t);
                g.offsets.push(0); // native member: rides its own signature
                continue 'outer;
            }
        }
        order.push(PatternGroup {
            stop_idxs: sigs[i].clone(),
            trip_idxs: alloc::vec![t],
            member_pos: alloc::vec![i],
            offsets: alloc::vec![0],
        });
    }

    if mode == PatternMode::CoveringMerge {
        covering_merge_fold(order)
    } else {
        order
    }
}

/// Return offset `k >= 0` such that `haystack[k .. k+needle.len()] == needle`
/// (a windowed slice equality — a CONTIGUOUS subsequence, NOT a scattered one),
/// or `None` when no such window exists. The FIRST (smallest) matching offset is
/// returned. Mirrors the TS `contiguousSubsequenceOffset` byte-for-byte.
fn contiguous_subsequence_offset(haystack: &[u32], needle: &[u32]) -> Option<u32> {
    if needle.len() > haystack.len() {
        return None;
    }
    let last = haystack.len() - needle.len();
    for k in 0..=last {
        if &haystack[k..k + needle.len()] == needle {
            return Some(k as u32);
        }
    }
    None
}

/// CoveringMerge post-pass. NORMATIVE merge semantics — MUST be byte-identical to the TS
/// `coveringMergeFold` in `packages/shared/src/raptor/patternSignature.ts`:
///
/// - **Fold predicate.** Group `G` folds into group `H` iff `G.stop_idxs` is a CONTIGUOUS
/// SUBSEQUENCE of `H.stop_idxs` (∃ offset `k>=0` with `H.stop_idxs[k..k+G.len] == G.stop_idxs`) AND
/// `H` is strictly LONGER (`H.len > G.len`). Equal-length distinct groups never fold; identical
/// signatures were already merged in the first pass. - **Tie-break.** If several `H` cover `G`,
/// fold into the FIRST covering `H` in enumeration order. - **Fold-into-surviving (MULTI-LEVEL via
/// composition).** Folds are evaluated in enumeration order; only a SURVIVING (not-yet-folded)
/// group may be a source or a target. A group already folded away is skipped as both. A surviving
/// group `H` may FIRST receive folds (as a target) and LATER fold into a strictly-longer surviving
/// group `H'` (as a source). When that happens its members' offsets COMPOSE: a member `H` earlier
/// absorbed from `G` at relative offset `k_child` lands in `H'` at `k_child + k_parent` (where
/// `k_parent` is `H`'s offset into `H'`); `H`'s own native members (offset 0) land at `k_parent`.
/// The covering predicate (`H ⊑ H'`, strictly longer) guarantees the composed offset is a valid
/// window into `H'`. Chains are NOT prevented — the spec wants every contiguous-subsequence group
/// folded into a longer one, so blocking `H` from ever becoming a source would wrongly leave it
/// unfolded. - **Alignment.** A folded member is appended to `H` with its composed offset; the
/// downstream Index builder serves it only at `H` positions `[offset, offset+member_len)` and
/// writes the `DEP_SECS_NOT_SERVED` (`-1`) sentinel elsewhere.
///
/// `H`'s own members keep their existing offsets; `G`'s members are appended
/// carrying `G.offsets[m] + k` (the source member's own offset within `G`
/// composed with `G`'s offset `k` into `H`). The folded group is dropped from
/// the output; survivors retain their enumeration order.
pub(crate) fn covering_merge_fold(mut groups: Vec<PatternGroup>) -> Vec<PatternGroup> {
    let n = groups.len();
    let mut folded = alloc::vec![false; n];

    for gi in 0..n {
        if folded[gi] {
            continue;
        }
        // Find the FIRST surviving, strictly-longer group that covers `gi`.
        let mut target: Option<(usize, u32)> = None;
        for hi in 0..n {
            if hi == gi || folded[hi] {
                continue;
            }
            if groups[hi].stop_idxs.len() <= groups[gi].stop_idxs.len() {
                continue; // strictly longer only
            }
            if let Some(k) =
                contiguous_subsequence_offset(&groups[hi].stop_idxs, &groups[gi].stop_idxs)
            {
                target = Some((hi, k));
                break; // first covering H wins
            }
        }
        if let Some((hi, k)) = target {
            // Move G's members into H carrying their COMPOSED offset. A native G
            // member has offset 0 → lands at k; a member G itself absorbed
            // earlier carries k_child → lands at k_child + k (composition).
            let src_trips = core::mem::take(&mut groups[gi].trip_idxs);
            let src_pos = core::mem::take(&mut groups[gi].member_pos);
            let src_offsets = core::mem::take(&mut groups[gi].offsets);
            let h = &mut groups[hi];
            for m in 0..src_trips.len() {
                h.trip_idxs.push(src_trips[m]);
                h.member_pos.push(src_pos[m]);
                h.offsets.push(src_offsets[m] + k);
            }
            folded[gi] = true;
        }
    }

    let mut out: Vec<PatternGroup> = Vec::with_capacity(n);
    for (i, g) in groups.into_iter().enumerate() {
        if !folded[i] {
            out.push(g);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    // Mirrors the TS unit tests in patternSignature.test.ts.

    /// Two trips with identical signatures → one group; two with distinct → two groups.
    #[test]
    fn signature_grouping_with_repeats() {
        let trip_idxs: Vec<u32> = vec![10, 11, 12];
        let sigs: Vec<Vec<u32>> = vec![
            vec![0, 1, 2], // trip 10
            vec![0, 1, 2], // trip 11 — same sig, joins group 0
            vec![0, 1, 3], // trip 12 — different sig, new group
        ];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::Off);

        assert_eq!(groups.len(), 2, "two distinct signatures → two groups");

        // Group 0: trips 10 and 11 (sig [0,1,2]).
        assert_eq!(groups[0].stop_idxs, vec![0u32, 1, 2]);
        assert_eq!(groups[0].trip_idxs, vec![10u32, 11]);
        assert_eq!(groups[0].member_pos, vec![0usize, 1]);

        // Group 1: trip 12 only (sig [0,1,3]).
        assert_eq!(groups[1].stop_idxs, vec![0u32, 1, 3]);
        assert_eq!(groups[1].trip_idxs, vec![12u32]);
        assert_eq!(groups[1].member_pos, vec![2usize]);
    }

    /// Branch vs longer distinct: the longer pattern does NOT absorb the branch.
    #[test]
    fn branch_vs_longer_distinct() {
        // LOCAL: [0,1,2,4], BRANCH: [0,1,3,4] — they differ at position 2.
        let trip_idxs: Vec<u32> = vec![0, 1];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2, 4], vec![0, 1, 3, 4]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::Unbounded);

        assert_eq!(groups.len(), 2, "LOCAL and BRANCH are distinct patterns");
        assert_eq!(groups[0].stop_idxs, vec![0u32, 1, 2, 4]);
        assert_eq!(groups[1].stop_idxs, vec![0u32, 1, 3, 4]);
    }

    /// First-appearance order: reversing the input flips which group is group[0].
    #[test]
    fn first_appearance_order_reversed_input() {
        // Input reversed: BRANCH first, then LOCAL.
        let trip_idxs: Vec<u32> = vec![1, 0];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 3, 4], vec![0, 1, 2, 4]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::Off);

        assert_eq!(groups.len(), 2);
        // group[0] is now the BRANCH pattern (first appearance in reversed input).
        assert_eq!(groups[0].stop_idxs, vec![0u32, 1, 3, 4]);
        assert_eq!(groups[0].trip_idxs, vec![1u32]);
        // group[1] is the LOCAL pattern.
        assert_eq!(groups[1].stop_idxs, vec![0u32, 1, 2, 4]);
        assert_eq!(groups[1].trip_idxs, vec![0u32]);
    }

    /// Single-pattern route → exactly one group containing all trips.
    #[test]
    fn single_pattern_one_group() {
        let trip_idxs: Vec<u32> = vec![5, 6, 7];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2], vec![0, 1, 2], vec![0, 1, 2]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::Unbounded);

        assert_eq!(groups.len(), 1, "all same sig → one group");
        assert_eq!(groups[0].trip_idxs, vec![5u32, 6, 7]);
        assert_eq!(groups[0].member_pos, vec![0usize, 1, 2]);
    }

    /// Native members carry offset 0 under Off and Unbounded (no fold).
    #[test]
    fn native_members_offset_zero() {
        let trip_idxs: Vec<u32> = vec![10, 11, 12];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2, 4], vec![0, 1, 3, 4], vec![0, 1, 2, 4]];
        for mode in [PatternMode::Off, PatternMode::Unbounded] {
            let groups = group_by_pattern(&trip_idxs, &sigs, mode);
            assert_eq!(groups.len(), 2);
            assert_eq!(groups[0].offsets, vec![0u32, 0]); // trips 10,12
            assert_eq!(groups[1].offsets, vec![0u32]); // trip 11
        }
    }

    // ── CoveringMerge fold ─────────────────────────────────

    #[test]
    fn covering_merge_folds_contiguous_subsequence() {
        // [1,2,3] is the window [1..4) of [0,1,2,3,4] → fold trip 1 into trip 0's
        // group at offset 1. One group survives; trip 1 carries offset 1.
        let trip_idxs: Vec<u32> = vec![0, 1];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2, 3, 4], vec![1, 2, 3]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::CoveringMerge);

        assert_eq!(groups.len(), 1, "folds into one surviving group");
        assert_eq!(groups[0].stop_idxs, vec![0u32, 1, 2, 3, 4]); // longer pattern survives
        assert_eq!(groups[0].trip_idxs, vec![0u32, 1]);
        assert_eq!(groups[0].member_pos, vec![0usize, 1]);
        assert_eq!(groups[0].offsets, vec![0u32, 1]); // native @0, folded @1
    }

    #[test]
    fn covering_merge_prefix_and_suffix() {
        // prefix [0,1,2] @0, suffix [2,3,4] @2, both windows of [0,1,2,3,4].
        let trip_idxs: Vec<u32> = vec![0, 1, 2];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2, 3, 4], vec![0, 1, 2], vec![2, 3, 4]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::CoveringMerge);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].stop_idxs, vec![0u32, 1, 2, 3, 4]);
        assert_eq!(groups[0].trip_idxs, vec![0u32, 1, 2]);
        assert_eq!(groups[0].offsets, vec![0u32, 0, 2]);
    }

    #[test]
    fn covering_merge_does_not_fold_reverse() {
        // [4,3,2,1,0] is the reverse of [0,1,2,3,4] — NOT a contiguous subsequence.
        let trip_idxs: Vec<u32> = vec![0, 1];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2, 3, 4], vec![4, 3, 2, 1, 0]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::CoveringMerge);

        assert_eq!(groups.len(), 2, "reverse stays distinct");
        assert_eq!(groups[0].stop_idxs, vec![0u32, 1, 2, 3, 4]);
        assert_eq!(groups[1].stop_idxs, vec![4u32, 3, 2, 1, 0]);
        assert_eq!(groups[0].offsets, vec![0u32]);
        assert_eq!(groups[1].offsets, vec![0u32]);
    }

    #[test]
    fn covering_merge_tie_break_first_in_enumeration() {
        // Two distinct covering patterns both contain [1,2] as a window:
        //   H0 = [0,1,2,3] (first), H1 = [9,1,2,8]. G=[1,2] folds into H0.
        let trip_idxs: Vec<u32> = vec![0, 1, 2];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2, 3], vec![9, 1, 2, 8], vec![1, 2]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::CoveringMerge);

        assert_eq!(groups.len(), 2);
        // H0 absorbed G at offset 1; H1 untouched.
        assert_eq!(groups[0].stop_idxs, vec![0u32, 1, 2, 3]);
        assert_eq!(groups[0].trip_idxs, vec![0u32, 2]);
        assert_eq!(groups[0].offsets, vec![0u32, 1]);
        assert_eq!(groups[1].stop_idxs, vec![9u32, 1, 2, 8]);
        assert_eq!(groups[1].trip_idxs, vec![1u32]);
        assert_eq!(groups[1].offsets, vec![0u32]);
    }

    #[test]
    fn covering_merge_equal_length_distinct_never_folds() {
        let trip_idxs: Vec<u32> = vec![0, 1];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2], vec![3, 4, 5]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::CoveringMerge);

        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].offsets, vec![0u32]);
        assert_eq!(groups[1].offsets, vec![0u32]);
    }

    #[test]
    fn covering_merge_multi_trip_source_folds_wholesale() {
        // Trips 1 and 2 share signature [1,2,3]; that group folds into
        // [0,1,2,3,4] @1, carrying BOTH members.
        let trip_idxs: Vec<u32> = vec![0, 1, 2];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2, 3, 4], vec![1, 2, 3], vec![1, 2, 3]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::CoveringMerge);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].trip_idxs, vec![0u32, 1, 2]);
        assert_eq!(groups[0].member_pos, vec![0usize, 1, 2]);
        assert_eq!(groups[0].offsets, vec![0u32, 1, 1]);
    }

    #[test]
    fn covering_merge_transitive_fold_composes_offsets() {
        // Transitive chain: [1,2] folds into [0,1,2] @1, then [0,1,2] folds into
        // [0,1,2,3] @0. trip0's offset must COMPOSE to 1 (k_child=1 + k_parent=0),
        // NOT be re-set to the parent offset 0. One surviving group:
        //   stop_idxs [0,1,2,3]; trip_idxs [2,1,0] (native first, then the
        //   absorbed members in append order); offsets [0,0,1].
        let trip_idxs: Vec<u32> = vec![0, 1, 2];
        let sigs: Vec<Vec<u32>> = vec![vec![1, 2], vec![0, 1, 2], vec![0, 1, 2, 3]];
        let groups = group_by_pattern(&trip_idxs, &sigs, PatternMode::CoveringMerge);

        assert_eq!(groups.len(), 1, "transitive chain folds to one group");
        assert_eq!(groups[0].stop_idxs, vec![0u32, 1, 2, 3]);
        assert_eq!(groups[0].trip_idxs, vec![2u32, 1, 0]);
        assert_eq!(groups[0].member_pos, vec![2usize, 1, 0]);
        assert_eq!(
            groups[0].offsets,
            vec![0u32, 0, 1],
            "trip0 offset composed to 1 (k_child 1 + k_parent 0)"
        );
    }

    #[test]
    fn covering_merge_branches_that_dont_cover_are_unchanged() {
        // [0,1,2,4] and [0,1,3,4] differ at position 2 — neither covers the
        // other, so CoveringMerge == Unbounded for this input.
        let trip_idxs: Vec<u32> = vec![10, 11, 12];
        let sigs: Vec<Vec<u32>> = vec![vec![0, 1, 2, 4], vec![0, 1, 3, 4], vec![0, 1, 2, 4]];
        let covering = group_by_pattern(&trip_idxs, &sigs, PatternMode::CoveringMerge);

        assert_eq!(covering.len(), 2);
        assert_eq!(covering[0].stop_idxs, vec![0u32, 1, 2, 4]);
        assert_eq!(covering[0].trip_idxs, vec![10u32, 12]);
        assert_eq!(covering[0].offsets, vec![0u32, 0]);
        assert_eq!(covering[1].stop_idxs, vec![0u32, 1, 3, 4]);
        assert_eq!(covering[1].offsets, vec![0u32]);
    }
}
