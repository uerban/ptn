/**
 * B1.5 — band → flat `{ stopTimes, tripStarts, boarding }` materialization.
 *
 * Walks the pattern band (`0x10` Patterns / `0x11` PatternStops /
 * `0x12` PatternSemantics / `0x13` TripTimes / `0x14` TripMeta / `0x46`
 * PatternTrips) and synthesizes the SAME `{ stopTimes, tripStarts }` the flat
 * `0xF4`/`0xF5`/`0xF6` carry yields PLUS the SAME flat per-stop_time `boarding`
 * column the `0xFA StopTimeBoarding` carry yields, so the existing flat-carry
 * consumers (`loadFromPtb.ts buildPtnbStreamedShape`, `ptbToBundleWire.ts`) read
 * it unchanged.
 *

 * * **Why this exists (B1.5 teardown).** Both the backend `loadFromPtb` boot path and the
 * differential `ptbToBundleWire` adapter read the flat carry (`ptb.stopTimes` +
 * `ptb.tripStarts`) and the flat boarding column (`ptb.boarding`) directly. At B1.5 the flat
 * carry AND the `0xFA` boarding region are DROPPED from the published bundle, leaving only the
 * pattern band. Without re-materialization the consumers would have no `stopTimes` (and
 * silently fall back to network GTFS) and no boarding column. This decoder rebuilds the flat
 * representation from the band so NO consumer changes. **The flat carry is STILL PRESENT in
 * every committed fixture during this task, so this path is dormant** — `loadPtb` only
 * materializes from the band when the carry is absent/empty (see `loader.ts loadPtb`), and the
 * flat path is byte-unchanged otherwise. The equivalence is proved by
 * `bandToFlatStopTimes.test.ts` (shared) and the differential gate (carry present → flat path →
 * byte-identical result).

 *
 * Lives in `@pt/shared` so it is the SINGLE `0x13`/`0x12` → flat decoder. The sole
 * caller is {@link loadPtb} (loader), which invokes it on the carry-less
 * materialization path; downstream consumers (`loadFromPtb` backend boot,
 * `ptbToBundleWire` differential gate) then read the materialized
 * `stopTimes`/`tripStarts`/`boarding` off the bundle unchanged — they never call
 * this decoder directly (one decoder, no duplication).
 *
 * ── Algorithm (mirrors the Rust `encode_trip_times_for_pattern` decode contract,
 * `crates/pt-core/src/pattern_emit.rs` region 0x13, and `Reader::band_semantics_byte`
 * region 0x12; LOCKED layout:
 *    the b1 1 pattern band locked layout notes).
 *
 * Rows are assembled in **trip_idx order** (0..numTrips), so `tripStarts` is the
 * prefix-sum and `tripIdx === i` for each slice — exactly what the flat consumers
 * rely on. For each trip:
 *   1. Its pattern `p = 0x14 TripMeta.pattern_idx[tripIdx]`.
 *   2. Its row index `j` WITHIN the pattern's `0x13` slab = the position of
 *      `tripIdx` in the `0x46` PatternTrips slice for `p`. The `0x46` slice is
 *      stored in the SAME Pin-4 (pos-0-dep) order as the slab's `T` rows
 *      (`pattern_emit.rs` builds both from `p.trips` in lockstep), so slab row
 *      `j` ⟷ `0x46` value `j`.
 *   3. For each canonical position `pos` (0..stopCount of `p`):
 *        `stopIdx  = 0x11[stopsOff + pos]`
 *        `served   = served_bits[j][pos]`
 *        `dep      = served ? trip_first_dep[j] + dep_deltas[j][pos] : NOT_SERVED`
 *        `arrDiff  = served ? dwell_deltas[j][pos] : 0`
 *        `boarding = expand(0x12[p][pos])`  (per-position, SAME for every trip of
 *                                            the pattern — the locked-layout invariant)
 *      emitting one row PER CANONICAL POSITION (reproducing the cursor's
 *      served / NOT_SERVED holes — what the express-skip / lasso / skip-pos-0
 *      alignment relies on).
 *
 * ── `0x12 PatternSemantics` → flat `0xFA` boarding (the boarding column).
 *
 * `0x12` carries 1 packed byte per canonical position FOR NON-ALL-REGULAR
 * PATTERNS ONLY, concatenated in pattern-ordinal order; an all-regular pattern
 * (`patterns[p].flags & ALL_REGULAR`) contributes NO bytes (and the whole region
 * is OMITTED when every pattern is all-regular). The per-pattern base offset into
 * the `0x12` array is therefore `Σ stopCount over EARLIER non-all-regular
 * patterns` — a byte-for-byte mirror of Rust `Reader::band_semantics_byte` /
 * `band_semantics_base` (`crates/pt-core/src/reader.rs`).
 *
 * The `0x12` byte packs only the pickup/drop-off nibble:
 *   `pickup_type[1:0]` · `drop_off_type[3:2]` · `timepoint[4]` · `[5:7]=0`
 * whereas the flat `0xFA` byte packs:
 *   `pickup_type[1:0]` · `drop_off_type[3:2]` · `continuous_pickup[5:4]` ·
 *   `continuous_drop_off[7:6]`  (default `0x50` = continuous "no" both ways).
 * We {@link expandSemanticsToBoarding expand} the `0x12` low nibble back into the
 * `0xFA` packing by OR-ing in the continuous-default bits (`0x50`) and dropping
 * `0x12`'s timepoint bit (the `0xFA` column never carried timepoint). The two
 * flat consumers only ever read the low 4 bits (`pickup = b & 0b11`,
 * `dropOff = (b >> 2) & 0b11`; continuous bits are YAGNI), so this is exactly
 * boarding-equivalent; the OR-in of `0x50` additionally makes the WHOLE byte
 * equal the `0xFA` carry for any feed whose continuous flags are the GTFS default
 * (the only kind B1.x produces — `0x12` does not carry continuous bits).
 *
 * **Omit-when-all-default (the `boarding === undefined` equivalence).** The `0xFA`
 * producer OMITS the region when every byte is the default `0x50`, and `loadPtb`
 * then exposes `boarding === undefined`. We mirror that: if every materialized
 * boarding byte is `0x50` (which is exactly the all-regular / `0x12`-absent case),
 * we return `boarding: undefined`, so a carry-less load is byte-identical in shape
 * to a carry-bearing load (whose `0xFA` is likewise absent for an all-regular
 * feed). A non-default `0x12` yields a populated `Uint8Array` of length
 * `stopTimes.length` (1:1 with the flat `0xFA` index space).
 *
 * ── B1.5 dependencies / caveats (documented per the task):
 *
 *   - **`stopSeq` = canonical position.** The band carries no original GTFS
 *     `stop_sequence` (the `PatternStopSeq` column is deferred); the flat carry
 *     remains the `stop_sequence` SoT until T5. We set `stopSeq` to the canonical
 *     position so the downstream stable sort preserves the band's row order. For
 *     consecutive-`stop_sequence` feeds this is order-identical to the feed's
 *     `stop_sequence`; a non-consecutive real feed needs `PatternStopSeq` to
 *     recover the exact values. The flat consumers only SORT by `stopSeq` (never
 *     read the absolute value), so canonical position is sufficient for routing.
 *
 *   - **entryFlags width.** The `0x13` i32-delta variant (entryFlags bit1) IS
 *     decoded: the region-level delta width (4 B vs the i16 default 2 B) is
 *     resolved once via `deltaBytesForFlags` and widens the dep/dwell stride —
 *     byte-for-byte the Rust `delta_bytes_for_flags` / `rd_delta` behaviour. A
 *     ragged `0x13` (bit0), or any unknown bit, is still unsupported;
 *     `decodePatternBand` fails closed on it and we re-assert defensively below so
 *     this decoder is safe in isolation.
 *
 * The returned arrays are byte-equivalent to the flat carry on the routing-
 * relevant fields (`stopIdx`, `depSecs` incl. the `0xFFFFFFFF` NOT_SERVED
 * sentinel, `arrDiff`), the `boarding` byte's pickup/drop-off nibble, and on
 * trip-idx order / the `tripStarts` prefix-sum.
 *
 * `buf` is the original PTB bytes `loadPtb` decoded — the band's `tripTimes`
 * region carries only `{ offset, length }` into this buffer (it does not retain
 * the slab bytes), so the caller passes the same `Uint8Array` it handed `loadPtb`.
 * (The `0x12` bytes, by contrast, are already sliced into `band.patternSemantics`
 * by `decodePatternBand`, so boarding needs no raw-`buf` re-read.)
 *
 * GTFS reference (pickup_type / drop_off_type):
 * https://gtfs.org/documentation/schedule/reference/#stop_timestxt
 */

import type { PtbPatternBand, PtbStopTime } from "./loader.js";
// The single 0x13-slab byte-span formula, shared with loader.ts's
// decodePatternBand length cross-check. Leaf module (no imports) → no cycle even
// though loader.ts imports THIS module's bandToFlatStopTimes value.
import {
  deltaBytesForFlags,
  patternTripTimesSpan,
  TRIP_TIMES_FLAG_I32_DELTAS,
} from "./patternBandLayout.js";

const DEP_SECS_NOT_SERVED = 0xffffffff;

/** `0x10 Patterns.flags` bit0 — the pattern is all-regular ⇒ it contributes NO
 *  `0x12 PatternSemantics` bytes. Mirrors `pattern_emit::FLAG_ALL_REGULAR` /
 *  `reader::PATTERN_FLAG_ALL_REGULAR` (Rust). */
const PATTERN_FLAG_ALL_REGULAR = 0b0000_0001;

/** The flat `0xFA StopTimeBoarding` default byte: `pickup_type 0` · `drop_off_type
 *  0` · `continuous_pickup 1` (no) · `continuous_drop_off 1` (no) = `0x50`. The
 *  reader defaults every stop_time to this when `0xFA` is absent. */
const BOARDING_DEFAULT = 0x50;

/**
 * Expand a packed `0x12 PatternSemantics` byte (`pickup_type[1:0]` ·
 * `drop_off_type[3:2]` · `timepoint[4]`) into the flat `0xFA StopTimeBoarding`
 * packing (`pickup_type[1:0]` · `drop_off_type[3:2]` · `continuous_pickup[5:4]` ·
 * `continuous_drop_off[7:6]`). Keeps ONLY `0x12`'s pickup/drop-off nibble
 * (`& 0x0F`, dropping the timepoint bit the `0xFA` column never carried) and
 * OR-s in the continuous-default bits (`0x50`). For `SEMANTICS_REGULAR` (`0x00`)
 * this yields exactly `BOARDING_DEFAULT` (`0x50`). Mirrors the inverse of Rust
 * `pattern_emit::pattern_semantics_bytes` (`b & 0x0F`).
 */
function expandSemanticsToBoarding(semByte: number): number {
  return (semByte & 0x0f) | BOARDING_DEFAULT;
}

export function bandToFlatStopTimes(
  band: PtbPatternBand,
  buf: Uint8Array,
  numTrips: number,
): { stopTimes: PtbStopTime[]; tripStarts: Uint32Array; boarding: Uint8Array | undefined } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The i32-delta variant (bit1) IS decoded — its 4-byte width rides in
  // `deltaBytes` and only widens the dep/dwell stride. A ragged 0x13 (bit0), or
  // any unknown bit, is the deferred intercity/Paris on-ramp; decodePatternBand
  // already fails closed on it, but re-assert here so this decoder is safe in
  // isolation (it would mis-read the slab otherwise). `deltaBytes` is resolved
  // from the SAME flag→width mapping the loader's length gate uses.
  if ((band.tripTimesEntryFlags & ~TRIP_TIMES_FLAG_I32_DELTAS) !== 0) {
    throw new Error(
      `bandToFlatStopTimes: 0x13 TripTimes ragged variant unsupported (entryFlags=0x${band.tripTimesEntryFlags.toString(16)})`,
    );
  }
  const deltaBytes = deltaBytesForFlags(band.tripTimesEntryFlags);
  // Read ONE dep/dwell delta (signed) at byte offset `off`, region width-aware.
  // Mirrors Rust `rd_delta`: 2 → i16 LE, 4 → i32 LE.
  const readDelta =
    deltaBytes === 4
      ? (off: number): number => view.getInt32(off, true)
      : (off: number): number => view.getInt16(off, true);

  const { patterns, patternStops, patternTripsOffsets, patternTripsValues, tripMeta } = band;
  const tt = band.tripTimes; // { offset, length } of the 0x13 region inside `buf`

  // Per-pattern byte offset within 0x13 (the slab is contiguous per pattern, in
  // pattern-ordinal order). Span = patternTripTimesSpan(T, S) per pattern — the
  // SAME formula loader.ts's decodePatternBand uses for the 0x13-length check, so
  // the two cannot drift (single source: patternBandLayout.ts).
  const patternByteOff: number[] = new Array(band.numPatterns);
  {
    let acc = tt.offset;
    for (let p = 0; p < band.numPatterns; p++) {
      patternByteOff[p] = acc;
      const t = patternTripsOffsets[p + 1]! - patternTripsOffsets[p]!;
      const s = patterns[p]!.stopCount;
      acc += patternTripTimesSpan(t, s, deltaBytes);
    }
  }

  // Per-pattern base ELEMENT offset into the 0x12 PatternSemantics array. `0x12`
  // carries 1 byte/position for NON-all-regular patterns only, concatenated in
  // pattern-ordinal order; an all-regular pattern (or the whole region absent)
  // contributes nothing → base undefined ⇒ every position is the regular default.
  // Mirrors Rust `Reader::band_semantics_base` (Σ stopCount over EARLIER
  // non-all-regular patterns). `undefined` patternSemantics ⇒ every pattern
  // all-regular ⇒ no bases (every position regular).
  const semantics = band.patternSemantics; // Uint8Array | undefined (0x12)
  const semanticsBase: (number | undefined)[] = new Array(band.numPatterns);
  {
    let acc = 0;
    for (let p = 0; p < band.numPatterns; p++) {
      const allRegular = (patterns[p]!.flags & PATTERN_FLAG_ALL_REGULAR) !== 0;
      if (semantics === undefined || allRegular) {
        semanticsBase[p] = undefined; // contributes no bytes
      } else {
        semanticsBase[p] = acc;
        acc += patterns[p]!.stopCount;
      }
    }
  }

  // Each trip's pattern comes from 0x14 TripMeta.pattern_idx (u32 @ t*24+0) — the
  // same backref the Rust index-build reads (`trip_pattern_idx`). Its row index
  // WITHIN the pattern's slab is its position in the 0x46 PatternTrips slice for
  // that pattern (the slab's T rows and the 0x46 slice share Pin-4 order). The
  // loader cross-checks 0x14 ⟷ 0x46 set-identity at decode, so these agree.
  const TRIP_META_RECORD_BYTES = 24;
  const tripPattern = new Uint32Array(numTrips);
  for (let t = 0; t < numTrips; t++) {
    tripPattern[t] = view.getUint32(tripMeta.offset + t * TRIP_META_RECORD_BYTES, true);
  }
  const tripSlabRow = new Uint32Array(numTrips);
  for (let p = 0; p < band.numPatterns; p++) {
    const lo = patternTripsOffsets[p]!;
    const hi = patternTripsOffsets[p + 1]!;
    for (let j = lo; j < hi; j++) {
      tripSlabRow[patternTripsValues[j]!] = j - lo;
    }
  }

  const stopTimes: PtbStopTime[] = [];
  const tripStarts = new Uint32Array(numTrips + 1);
  // Flat boarding column, 1:1 with stopTimes rows (= the 0xFA index space). Filled
  // per row; collapsed to `undefined` below when every byte is the default 0x50
  // (mirrors the 0xFA producer's omit-when-all-default + loadPtb's boarding===undefined).
  const boarding: number[] = [];
  let anyNonDefaultBoarding = false;

  for (let trip = 0; trip < numTrips; trip++) {
    tripStarts[trip] = stopTimes.length;
    const p = tripPattern[trip]!;
    const rec = patterns[p]!;
    const stopCount = rec.stopCount;
    const stopsOff = rec.stopsOff; // ELEMENT index into 0x11
    const j = tripSlabRow[trip]!; // this trip's row within the pattern slab
    const T = patternTripsOffsets[p + 1]! - patternTripsOffsets[p]!;
    const bitsPerTrip = Math.ceil(stopCount / 8);
    const base = patternByteOff[p]!;
    const semBase = semanticsBase[p]; // 0x12 base for pattern p (undefined ⇒ regular)

    // Section offsets within this pattern's slab (trip-major; see region 0x13). Each
    // dep/dwell element is `deltaBytes` wide (2 = i16, 4 = i32 — region-level).
    // Mirrors Rust `trip_times_subarrays(T, S, deltaBytes)`:
    //   [base .. )            trip_first_dep[T] u32
    //   [depBase .. )         dep_deltas[T][S]  (deltaBytes B each)
    //   [dwellBase .. )       dwell_deltas[T][S] (deltaBytes B each)
    //   [servedBase .. )      served_bits[T][ceil(S/8)]
    const depBase = base + T * 4;
    const dwellBase = depBase + T * stopCount * deltaBytes;
    const servedBase = dwellBase + T * stopCount * deltaBytes;

    const firstDep = view.getUint32(base + j * 4, true);
    const depRow = depBase + j * stopCount * deltaBytes;
    const dwellRow = dwellBase + j * stopCount * deltaBytes;
    const servedRow = servedBase + j * bitsPerTrip;

    for (let pos = 0; pos < stopCount; pos++) {
      const stopIdx = patternStops[stopsOff + pos]!;
      const servedByte = view.getUint8(servedRow + (pos >> 3));
      const served = ((servedByte >> (pos & 7)) & 1) === 1;
      let depSecs: number;
      let arrDiff: number;
      if (served) {
        // trip_first_dep + dep_delta (signed, deltaBytes-wide); the encoder
        // guarantees this is within u32 (the cursor's real dep_secs).
        // dep_delta[first-served]=0. Element stride is deltaBytes (2=i16, 4=i32).
        depSecs = (firstDep + readDelta(depRow + pos * deltaBytes)) >>> 0;
        arrDiff = readDelta(dwellRow + pos * deltaBytes);
      } else {
        depSecs = DEP_SECS_NOT_SERVED;
        arrDiff = 0;
      }
      // 0x12 → flat 0xFA boarding for this canonical position. Per-position and
      // SAME for every trip of the pattern (locked-layout invariant). semBase
      // undefined ⇒ all-regular pattern (or 0x12 absent) ⇒ regular default 0x50.
      const semByte = semBase === undefined ? 0x00 : (semantics![semBase + pos] ?? 0x00);
      const boardingByte = expandSemanticsToBoarding(semByte);
      if (boardingByte !== BOARDING_DEFAULT) anyNonDefaultBoarding = true;
      boarding.push(boardingByte);
      // stopSeq = canonical position (see the PatternStopSeq caveat above). Only
      // its ORDER is read downstream, so the canonical position is sufficient.
      stopTimes.push({ depSecs, arrDiff, stopIdx, stopSeq: pos });
    }
  }
  tripStarts[numTrips] = stopTimes.length;

  return {
    stopTimes,
    tripStarts,
    // Omit-when-all-default: an all-0x50 column ⇒ undefined, byte-identical in
    // shape to the carry-bearing load whose 0xFA region is likewise absent.
    boarding: anyNonDefaultBoarding ? Uint8Array.from(boarding) : undefined,
  };
}
