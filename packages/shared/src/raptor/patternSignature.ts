import { PatternMode } from "./patternMode.js";

/**
 * NORMATIVE pattern algorithm. Consumed by `ptbToBundleWire.ts` (Phase 1) and
 * `index-builder.ts` (Phase 4). Changing it requires editing all three sites in the same PR (no
 * CI links them — lockstep note).

 *
 * Signature encoding: decimal stop indices joined by ',' (0x2C), no trailing
 * separator, repeats preserved; the Rust mirror
 * (`crates/pt-core/src/engine/patterns.rs`) must produce the identical string.
 *
 * NOT the canonical-aligned (`-1`-holed) array; NOT pickup/drop_off, headsign,
 * or shape.
 */
export function patternSignature(stopIdxs: readonly number[]): string {
  return stopIdxs.join(",");
}

export interface TripForGrouping {
  tripIdx: number;
  /** The trip's own stop-idx sequence (sorted by stop_seq, repeats preserved). */
  stopIdxs: number[];
  /** Pickup/drop-off nibbles in stop sequence order; absent means all regular. */
  boarding?: number[];
}

export interface PatternGroup {
  /** The shared signature's stop-idx sequence (this pattern's canonical). */
  stopIdxs: number[];
  /** Member trip ordinals, in the input order. */
  tripIdxs: number[];
  /**
 * Per-member alignment offset into THIS group's `stopIdxs`, aligned 1:1 with `tripIdxs`
 * (offsets[i] is tripIdxs[i]'s offset). A NATIVE member (one whose own stop sequence IS this
 * group's `stopIdxs`) has offset 0 and serves every position. A FOLDED member (CoveringMerge
 * only) is a shorter trip whose stop sequence is a contiguous subsequence of this group's
 * `stopIdxs` starting at `offsets[i]`; it rides this longer pattern but is served only at
 * positions `[offsets[i], offsets[i] + memberLen)` — everywhere else its departure is the `-1`
 * / `MISSING_DEP_SENTINEL` unserved sentinel. Under `Off`/`Unbounded` every offset is 0 (no
 * fold), so this field is inert and the emitted wire is byte-identical to pre-Phase-5.
 */
  offsets: number[];
}

/**
 * Group trips by stop sequence and pickup/drop-off nibbles. The stop-only `patternSignature`
 * remains unchanged; absent boarding means all regular. ENUMERATION ORDER PIN: groups are
 * emitted in first-appearance order of the signature across the input trip order; member trips
 * keep their input order. The caller MUST pass trips in route_trips order so this matches the
 * Rust Index and the differential value-array-order precondition.

 *

 * * @param mode
 * - PatternMode flag (default Off). For `Off`/`Unbounded` this returns exactly
 * the plain first-appearance grouping (every member offset 0). For `CoveringMerge` a post-pass
 * folds each group whose signature is a CONTIGUOUS SUBSEQUENCE of a strictly-longer SURVIVING
 * group into that group — see {@link coveringMergeFold} for the exact normative semantics. This
 * fold must be byte-identical to the Rust `group_by_pattern` mirror in
 * `crates/pt-core/src/engine/patterns.rs`.
 */
export function groupTripsByPattern(
  trips: readonly TripForGrouping[],
  mode: PatternMode = PatternMode.Off,
): PatternGroup[] {
  const bySig = new Map<string, PatternGroup>();
  const order: PatternGroup[] = [];
  for (const t of trips) {
    // PatternSemantics is per pattern; GTFS pickup/drop-off is per stop_time.
    // https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    if (t.boarding && t.boarding.length !== t.stopIdxs.length) {
      throw new RangeError("pattern boarding length must match stop sequence");
    }
    const boarding = t.stopIdxs.map((_, i) => (t.boarding?.[i] ?? 0) & 0x0f);
    const sig = `${patternSignature(t.stopIdxs)};${boarding.join(",")}`;
    let g = bySig.get(sig);
    if (!g) {
      g = { stopIdxs: t.stopIdxs.slice(), tripIdxs: [], offsets: [] };
      bySig.set(sig, g);
      order.push(g);
    }
    g.tripIdxs.push(t.tripIdx);
    g.offsets.push(0); // native member: rides its own signature, offset 0
  }

  if (mode === PatternMode.CoveringMerge) {
    return coveringMergeFold(order);
  }
  return order;
}

/**
 * Return offset `k >= 0` such that `haystack[k .. k+needle.length] === needle`
 * (a windowed slice equality — a CONTIGUOUS subsequence, NOT a scattered one),
 * or `-1` when no such window exists. The FIRST (smallest) matching offset is
 * returned. Mirrors the Rust `contiguous_subsequence_offset` byte-for-byte.
 */
function contiguousSubsequenceOffset(
  haystack: readonly number[],
  needle: readonly number[],
): number {
  if (needle.length > haystack.length) return -1;
  const last = haystack.length - needle.length;
  for (let k = 0; k <= last; k++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[k + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return k;
  }
  return -1;
}

/**
 * CoveringMerge post-pass. NORMATIVE merge semantics — MUST be byte-identical to the Rust
 * `covering_merge_fold` in `crates/pt-core/src/engine/patterns.rs`:

 *

 * * - **Fold predicate.** Group `G` folds into group `H` iff `G.stopIdxs` is a CONTIGUOUS
 * SUBSEQUENCE of `H.stopIdxs` (∃ offset `k>=0` with `H.stopIdxs[k..k+G.len] == G.stopIdxs`) AND
 * `H` is strictly LONGER (`H.len > G.len`). Equal-length distinct groups never fold; identical
 * signatures were already merged in the first pass. - **Tie-break.** If several `H` cover `G`,
 * fold into the FIRST covering `H` in enumeration order. - **Fold-into-surviving (MULTI-LEVEL
 * via composition).** Folds are evaluated in enumeration order; only a SURVIVING
 * (not-yet-folded) group may be a source or a target. A group already folded away is skipped as
 * both. A surviving group H may FIRST receive folds (becoming a target) and LATER fold into a
 * strictly-longer surviving group H' (becoming a source). When that happens its members'
 * offsets COMPOSE: a member that H earlier absorbed from G at relative offset `k_child` lands
 * in H' at `k_child + k_parent` (where `k_parent` is H's offset into H'); H's own native
 * members (offset 0) land at `k_parent`. The covering predicate (H ⊑ H', strictly longer)
 * guarantees this composition is a valid window into H'. Chains are NOT prevented — the spec
 * wants every contiguous-subsequence group folded into a longer one, so blocking H from ever
 * becoming a source would wrongly leave it unfolded. - **Alignment.** A folded member is
 * appended to `H` with its composed offset; the downstream Index/wire builder serves it only at
 * `H` positions `[offset, offset+memberLen)` and writes the `-1` sentinel elsewhere.

 *
 * Native member offsets are preserved (0). `H`'s own members keep their existing
 * offsets; `G`'s members are appended carrying `G.offsets[m] + k` (the source
 * member's own offset within G composed with G's offset k into H). The folded
 * group is dropped from the output. Survivors retain their enumeration order.
 *
 * Exported so the band-sourced grouping in `ptbToBundleWire.ts` (B1.4, Design A)
 * can run the SAME fold over its `pattern_idx`-grouped base — single-sourcing the
 * fold logic with the flat `groupTripsByPattern` path (and the Rust
 * `covering_merge_fold` mirror) instead of duplicating it. The algorithm is
 * UNCHANGED; this is an additive export only.
 */
export function coveringMergeFold(groups: PatternGroup[]): PatternGroup[] {
  const folded = new Array<boolean>(groups.length).fill(false);

  // Evaluate each candidate source G in enumeration order. Skip already-folded
  // groups (as source). Only fold into a SURVIVING strictly-longer target H,
  // first-in-enumeration-order wins.
  for (let gi = 0; gi < groups.length; gi++) {
    if (folded[gi]) continue;
    const g = groups[gi]!;
    for (let hi = 0; hi < groups.length; hi++) {
      if (hi === gi || folded[hi]) continue;
      const h = groups[hi]!;
      if (h.stopIdxs.length <= g.stopIdxs.length) continue; // strictly longer only
      const k = contiguousSubsequenceOffset(h.stopIdxs, g.stopIdxs);
      if (k < 0) continue;
      // Fold G into H at offset k: append G's members carrying their COMPOSED
      // offset. A native G member has offset 0 → lands at k; a member G itself
      // absorbed earlier carries k_child → lands at k_child + k (composition).
      for (let m = 0; m < g.tripIdxs.length; m++) {
        h.tripIdxs.push(g.tripIdxs[m]!);
        h.offsets.push(g.offsets[m]! + k);
      }
      folded[gi] = true;
      break; // first covering H wins
    }
  }

  return groups.filter((_, i) => !folded[i]);
}
