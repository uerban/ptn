/**
 * B1.5 — pure byte-layout helpers for the pattern band, shared by `loader.ts`
 * (`decodePatternBand` 0x13-length cross-check) and `bandToFlatStopTimes.ts`
 * (per-pattern slab offsets). Lives in its own leaf module — it imports NOTHING,
 * so importing it from both `loader.ts` and `bandToFlatStopTimes.ts` introduces no
 * runtime import cycle (`loader → bandToFlat` is the only value edge; both pull
 * span/offset math from HERE, one direction). Single source of truth — the formula
 * must not drift between the loader's length validation and the materializer.
 *
 * Mirrors the Rust `pattern_trip_times_span` + `delta_bytes_for_flags`
 * (`crates/pt-core/src/reader.rs`). Locked layout:
 */

/** The v9 `0x13 TripTimes` `entryFlags` bit (`1 << 1`) declaring the i32-delta
 * variant: dep/dwell deltas are 4-byte i32 LE instead of the default 2-byte i16.
 * REGION-level — one width sizes every pattern's dep/dwell stride. Mirrors Rust
 * `reader::TRIP_TIMES_FLAG_I32_DELTAS`. (bit0 = ragged, still unsupported.) */
export const TRIP_TIMES_FLAG_I32_DELTAS = 1 << 1;

/**
 * The CANONICAL `0x13 TripTimes` delta width (bytes per dep/dwell element) for a
 * region whose `entryFlags` are `entryFlags`: `4` when the i32-delta variant is
 * declared (bit1, {@link TRIP_TIMES_FLAG_I32_DELTAS}), else `2` (the
 * byte-identical i16 layout). This is the SINGLE flag→width mapping — both the
 * loader's length gate and the materializer's stride math call it so the two can
 * never disagree. The TS twin of Rust `reader::delta_bytes_for_flags`.
 */
export function deltaBytesForFlags(entryFlags: number): number {
  return (entryFlags & TRIP_TIMES_FLAG_I32_DELTAS) !== 0 ? 4 : 2;
}

/**
 * Byte span of ONE pattern's `0x13 TripTimes` slab = `T*(4 + 2*W*S + ceil(S/8))`:
 * `T` × (`trip_first_dep u32` + `dep_deltas[S]` + `dwell_deltas[S]` each `W` bytes
 * + `served_bits[ceil(S/8)]`), where `T` = number of trips in the pattern, `S` =
 * the pattern's stop_count, and `W` = the per-element delta width (`deltaBytes` —
 * `2` for the i16 layout, `4` for the v9 i32-delta variant; pass
 * {@link deltaBytesForFlags}`(entryFlags)`). Mirrors the Rust
 * `pattern_trip_times_span`.
 */
export function patternTripTimesSpan(t: number, s: number, deltaBytes: number): number {
  const bits = Math.ceil(s / 8);
  return t * (4 + 2 * deltaBytes * s + bits);
}
