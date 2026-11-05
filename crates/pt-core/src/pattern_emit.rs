//! crates/pt-core/src/pattern_emit.rs — B1.1 pattern-band ENCODER (no consumer).
//!
//! Emits the six pattern-major region bodies of the pattern band from a
//! `PatternMode::Unbounded` [`Index`] + the [`Reader`] it was built over:
//!   `0x10 Patterns`, `0x11 PatternStops`, `0x12 PatternSemantics`,
//!   `0x13 TripTimes`, `0x14 TripMeta`, `0x45 PatternsAtStop`, `0x46 PatternTrips`.
//! Each region body is returned as its own `Vec<u8>`; the B1.1-Task-B caller
//! tags/places them in the tagged region table (this module never writes the
//! container table). NO read-path consumes the band until B1.2/B1.3 — this is a
//! pure producer.
//!
//! Region IDs and alignment are defined in `docs/ptb-region-ids.md` §4.
//! All multi-byte fields are little-endian.
//!
//! The encoder is driven from `Index::build(reader, PatternMode::Unbounded)` and
//! REUSES that built index's cursor output (`RouteTrip::pos_to_row`) — it does
//! NOT re-derive the grouping or the per-trip alignment.
//! `served_bits`/deltas come straight from `pos_to_row`, so a later decode
//! reproduces the cursor (the symmetric-gate firewall). The producer-side
//! equality invariant (a) cross-checks the emitted `0x10` enumeration against an
//! INDEPENDENT decode of the flat `0xF4/0xF5/0xF6` carry grouped by Unbounded —
//! NOT a second `group_by_pattern` on the in-memory `sigs` (which would be a
//! tautology).
//!
//! ## Deferred (Decision 6 — consecutive `stop_sequence` ONLY in B1.1)
//! B1.1 handles only the consecutive case (`stop_sequence == position`), so
//! `Patterns.flags.bit2` (seq-override / `PatternStopSeq`) is NEVER set and no
//! sequence-override column is emitted. Lasso/repeated-stop trips still have
//! monotonic `stop_sequence`, so they remain consecutive (bit2 stays 0). A
//! non-consecutive feed needs the RLE column + bit2 set — an ADDITIVE future
//! change (no version bump, gated by bit2).
//!
//! GTFS reference (loop/lasso repeated-stop case the cursor handles):
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes

use alloc::vec;
use alloc::vec::Vec;

use crate::engine::consts::DEP_SECS_NOT_SERVED;
use crate::engine::index::{Index, IndexRoute, RouteTrip};
use crate::engine::patterns::{group_by_pattern_with_boarding, PatternMode};
use crate::engine::EngineError;
use crate::header::Region;
use crate::records::{rd_u32, TRIP_RECORD_BYTES};
use crate::Reader;

/// The GTFS-default `0x12 PatternSemantics` byte: regular pickup (`pickup_type
/// 0`), regular drop-off (`drop_off_type 0`), not a timepoint-only (`timepoint
/// 0`). A pattern whose every position carries this byte is "all-regular" and
/// emits NO `0x12` slice (`Patterns.flags.bit0` set instead).
///
/// Packing (LSB-first, same as `0xFA StopTimeBoarding`'s low nibble):
/// `pickup_type[1:0]` · `drop_off_type[3:2]` · `timepoint[4]` · `[5:7]=0`.
const SEMANTICS_REGULAR: u8 = 0x00;

/// `Patterns.flags.bit0` — the pattern is all-regular ⇒ its `0x12` bytes are
/// omitted.
const FLAG_ALL_REGULAR: u8 = 0b0000_0001;

/// The six (well, seven) pattern-band region bodies, each a free-standing
/// `Vec<u8>` the Task-B caller tags + places. `pattern_semantics` is EMPTY when
/// every pattern is all-regular (omit-when-all-regular, locked-layout region 0x12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternBand {
    /// `0x10 Patterns` — `count u32` + count × 8 B records.
    pub patterns: Vec<u8>,
    /// `0x11 PatternStops` — flat `stop_idx u32` per pattern-position.
    pub pattern_stops: Vec<u8>,
    /// `0x12 PatternSemantics` — 1 byte/position for non-all-regular patterns
    /// only; EMPTY when every pattern is all-regular.
    pub pattern_semantics: Vec<u8>,
    /// `0x13 TripTimes` — per pattern: first-dep / dep-deltas / dwell-deltas /
    /// served-bits.
    pub trip_times: Vec<u8>,
    /// `0x14 TripMeta` — `num_trips` × 24 B, in `trip_idx` order.
    pub trip_meta: Vec<u8>,
    /// `0x45 PatternsAtStop` — CSR `offsets[numStops+1] u32` + values u32.
    pub patterns_at_stop: Vec<u8>,
    /// `0x46 PatternTrips` — CSR `offsets[numPatterns+1] u32` + values u32.
    pub pattern_trips: Vec<u8>,
    /// True when the `0x13 TripTimes` region uses the WIDE (`i32`) delta layout
    /// (some trip's span exceeded the `i16` ±32767 s cap, so the whole region
    /// emitted 4-byte deltas). The Task-B caller MUST set the `0x13` region-table
    /// entry's `entryFlags |= TRIP_TIMES_FLAG_I32_DELTAS` accordingly. `false` ⇒
    /// the BYTE-IDENTICAL `i16` fast path (the common urban case).
    pub trip_times_i32: bool,
}

/// Encode the pattern band from a `PatternMode::Unbounded` [`Index`] over
/// `reader`. The `index` MUST have been built with [`PatternMode::Unbounded`]
/// (the locked-layout enumeration == the Unbounded grouping) — pass any other
/// mode and the producer-side invariants reject it.
///
/// Returns `Err(EngineError::Corrupt)` (or panics on a build-time invariant) if
/// the index/reader pair violates a locked-layout invariant (a)–(h). These are
/// the ONLY guard against a symmetric mis-build (a decode that round-trips its
/// own wrong bytes), so they are hard, not advisory.
pub fn encode_pattern_band<B>(reader: &Reader<B>, index: &Index) -> Result<PatternBand, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let patterns = &index.routes;
    let num_patterns = patterns.len();
    let num_stops = reader.num_stops();
    let num_trips = reader.num_trips();

    // ── Invariant (a): producer-side equality against an INDEPENDENT flat-carry
    // decode grouped by Unbounded (NOT a second group_by_pattern on the index's
    // captured sigs). Re-derives the enumeration from 0xF4/0xF5/0xF6 from
    // scratch and asserts it equals the index's pattern stop_idx sequences in
    // enumeration order.
    assert_enumeration_matches_flat_carry(reader, patterns)?;

    // ── 0x46 PatternTrips CSR + 0x14 TripMeta pattern_idx backfill.
    // Per pattern, the member trip ordinals in stored (Pin-4 dep-sorted) order.
    let mut pt_offsets: Vec<u32> = Vec::with_capacity(num_patterns + 1);
    let mut pt_values: Vec<u32> = Vec::new();
    pt_offsets.push(0);
    // trip_idx -> pattern ordinal, for 0x14 (every trip belongs to exactly one
    // pattern under Unbounded; the band freezes that mapping).
    let mut trip_pattern: Vec<Option<u32>> = vec![None; num_trips];
    for (pidx, p) in patterns.iter().enumerate() {
        for t in &p.trips {
            pt_values.push(t.trip_idx);
            // (g): every member trip ordinal in range.
            if t.trip_idx as usize >= num_trips {
                return Err(EngineError::Corrupt("0x46 trip ordinal >= num_trips"));
            }
            trip_pattern[t.trip_idx as usize] = Some(pidx as u32);
        }
        pt_offsets.push(pt_values.len() as u32);
    }

    // ── 0x11 PatternStops + 0x10 Patterns + 0x12 PatternSemantics.
    let mut pattern_stops_body: Vec<u8> = Vec::new();
    let mut patterns_body: Vec<u8> = Vec::new();
    patterns_body.extend_from_slice(&(num_patterns as u32).to_le_bytes());
    // 0x12 accumulates only for NON-all-regular patterns; stays empty when every
    // pattern is regular (omit-when-all-regular, invariant (f)).
    let mut semantics_body: Vec<u8> = Vec::new();
    // 0x13 accumulates per pattern, contiguous.
    let mut trip_times_body: Vec<u8> = Vec::new();
    // (f) bookkeeping: did ANY pattern emit a non-regular 0x12 byte?
    let mut any_non_regular = false;

    // ── 0x13 delta-width decision (REGION-level, i32-delta variant). Scan
    // EVERY pattern's trips first: if ANY dep-delta or dwell-delta falls outside
    // i16 range the WHOLE region emits 4-byte i32 deltas (entryFlags bit1);
    // otherwise the BYTE-IDENTICAL i16 fast path. One flag governs the whole
    // region (O(1) random access needs a fixed stride). See the locked-layout
    // region 0x13 decision + the i32-delta design spec.
    let mut region_i32 = false;
    for p in patterns.iter() {
        if pattern_needs_i32_deltas(reader, p)? {
            region_i32 = true;
            break;
        }
    }
    let width = if region_i32 {
        DeltaWidth::I32
    } else {
        DeltaWidth::I16
    };

    let mut stops_off_elems: u32 = 0; // running ELEMENT index into 0x11 (Decision 2)
    for (pidx, p) in patterns.iter().enumerate() {
        let stop_count = p.stop_ids.len();
        // (c): 0x11 non-empty per pattern.
        if stop_count == 0 {
            return Err(EngineError::Corrupt("0x10 pattern has zero stops"));
        }
        if stop_count > u16::MAX as usize {
            return Err(EngineError::Corrupt("0x10 stop_count exceeds u16"));
        }
        // (b): each member trip's pos_to_row length == stop_count. Checked FIRST,
        // before any positional indexing into pos_to_row (`pattern_semantics_bytes`
        // / `encode_trip_times_for_pattern`), so a wrong row count is a clean Err,
        // never a panic.
        for t in &p.trips {
            if t.pos_to_row.len() != stop_count {
                return Err(EngineError::Corrupt(
                    "0x13 trip pos_to_row len != stop_count",
                ));
            }
        }

        // 0x11 column: this pattern's stop_idxs (repeats preserved), and the
        // per-position semantics gathered alongside.
        let semantics = pattern_semantics_bytes(reader, p)?;
        debug_assert_eq!(semantics.len(), stop_count);
        let all_regular = semantics.iter().all(|&b| b == SEMANTICS_REGULAR);
        any_non_regular |= !all_regular;

        for (pos, &sidx) in p.stop_ids.iter().enumerate() {
            // (g): 0x11 ordinal in range.
            if sidx as usize >= num_stops {
                return Err(EngineError::Corrupt("0x11 stop ordinal >= num_stops"));
            }
            pattern_stops_body.extend_from_slice(&sidx.to_le_bytes());
            if !all_regular {
                semantics_body.push(semantics[pos]);
            }
        }

        // (h): per-trip stop_sequence strictly increasing (consecutive case).
        // The band freezes one row order; a non-monotonic sequence would need the
        // bit2 PatternStopSeq column (Decision 6, deferred).
        assert_stop_seq_strictly_increasing(reader, p)?;

        // 0x13 TripTimes for this pattern (drives off pos_to_row). (e): the
        // helper writes `T × S` dep-deltas + `T × S` dwell-deltas + `T ×
        // ceil(S/8)` served bytes where `T == |0x46 slice for this pattern|`
        // (== `p.trips.len()`, asserted below) and `S == stop_count`.
        debug_assert_eq!(
            p.trips.len(),
            (pt_offsets[pidx + 1] - pt_offsets[pidx]) as usize,
            "0x46 slice len must equal pattern trip count (e)"
        );
        encode_trip_times_for_pattern(reader, p, width, &mut trip_times_body)?;

        // 0x10 record: stops_off (ELEMENT index) · stop_count u16 · flags u8 · reserved u8.
        let flags = if all_regular { FLAG_ALL_REGULAR } else { 0 };
        patterns_body.extend_from_slice(&stops_off_elems.to_le_bytes());
        patterns_body.extend_from_slice(&(stop_count as u16).to_le_bytes());
        patterns_body.push(flags);
        patterns_body.push(0); // reserved
        stops_off_elems += stop_count as u32;
    }

    // ── 0x14 TripMeta — num_trips records, 24 B stride, in trip_idx order.
    let trip_meta_body = encode_trip_meta(reader, &trip_pattern, num_patterns)?;

    // ── 0x45 PatternsAtStop CSR — re-derive from the index's routes_at_stop, in
    // ascending stop order, deduped per stop (index.rs already dedups). numStops
    // from the header; a stop with no patterns gets an empty slice.
    let patterns_at_stop_body = encode_patterns_at_stop(index, num_stops)?;

    // ── Final cross-region invariants.
    // (d): 0x46 CSR offsets monotonic + last == values len (0x45's is checked in
    // its encoder). (b) is checked per-pattern at the loop top; (e) is a hard
    // length check inside encode_trip_times_for_pattern.
    assert_csr_monotonic(&pt_offsets, pt_values.len(), "0x46")?;
    // (f): 0x12 present (non-empty) ⟺ ≥1 non-regular byte — omit-when-all-regular
    // BOTH ways. A torn producer that wrote a 0x12 body for an all-regular feed
    // (or dropped it for a non-regular one) is rejected here.
    if semantics_body.is_empty() == any_non_regular {
        return Err(EngineError::Corrupt(
            "0x12 present/absent disagrees with non-regular bytes (f)",
        ));
    }

    // Build the 0x46 body bytes from the offsets+values.
    let mut pattern_trips_body: Vec<u8> =
        Vec::with_capacity((pt_offsets.len() + pt_values.len()) * 4);
    for &o in &pt_offsets {
        pattern_trips_body.extend_from_slice(&o.to_le_bytes());
    }
    for &v in &pt_values {
        pattern_trips_body.extend_from_slice(&v.to_le_bytes());
    }

    Ok(PatternBand {
        patterns: patterns_body,
        pattern_stops: pattern_stops_body,
        pattern_semantics: semantics_body,
        trip_times: trip_times_body,
        trip_meta: trip_meta_body,
        patterns_at_stop: patterns_at_stop_body,
        pattern_trips: pattern_trips_body,
        trip_times_i32: region_i32,
    })
}

/// `0x12` semantics bytes for one pattern, one byte per canonical position.
///
/// A position's pickup/drop-off comes from the pattern's NATIVE trip (a trip
/// that serves every position — offset 0). We read the boarding byte of the
/// first served trip at that position. B1.1 over a regular feed (no `0xFA`)
/// yields `0x00` everywhere ⇒ all-regular ⇒ omitted.
///
/// Packing matches the locked-layout `0x12`: `pickup_type[1:0]` ·
/// `drop_off_type[3:2]` · `timepoint[4]` · `[5:7]=0`. `0xFA`'s byte packs
/// `pickup_type[1:0]` · `drop_off_type[3:2]` · `continuous_pickup[5:4]` ·
/// `continuous_drop_off[7:6]` — we keep only the pickup/drop-off nibble (low 4
/// bits) and force `timepoint=0` (B1.1 has no timepoint source). So a `0xFA`
/// byte `b` maps to `b & 0x0F`.
fn pattern_semantics_bytes<B>(reader: &Reader<B>, p: &IndexRoute) -> Result<Vec<u8>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let stop_count = p.stop_ids.len();
    let mut out = vec![SEMANTICS_REGULAR; stop_count];
    for (pos, slot) in out.iter_mut().enumerate() {
        let mut semantics = None;
        for t in &p.trips {
            let row = t.pos_to_row[pos];
            if row != -1 {
                let byte = reader.boarding_byte(row as usize) & 0x0F;
                if semantics.is_some_and(|old| old != byte) {
                    return Err(EngineError::Corrupt(
                        "pattern members have mixed boarding semantics",
                    ));
                }
                semantics = Some(byte);
            }
        }
        *slot = semantics.unwrap_or(SEMANTICS_REGULAR);
    }
    Ok(out)
}

/// The `0x13 TripTimes` delta width for a whole region (i32-delta variant).
/// REGION-level: one width governs every pattern's deltas so the slab keeps a
/// fixed stride for O(1) random access. `I16` is the BYTE-IDENTICAL fast path
/// (the common urban case, span ≤ ±32767 s); `I32` is the intercity on-ramp
/// (any trip's span exceeds the `i16` cap) — selected by the region-table
/// `entryFlags` bit1 (`TRIP_TIMES_FLAG_I32_DELTAS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeltaWidth {
    I16,
    I32,
}

impl DeltaWidth {
    /// Bytes per delta element (2 for `i16`, 4 for `i32`).
    #[inline]
    fn bytes(self) -> usize {
        match self {
            DeltaWidth::I16 => 2,
            DeltaWidth::I32 => 4,
        }
    }
}

/// Encode the `0x13 TripTimes` body for ONE pattern, appending to `out`, at the
/// region's chosen delta `width`.
///
/// Layout (locked-layout region 0x13 + i32-delta variant), per pattern, contiguous:
///   1. `trip_first_dep[T] u32`   (abs secs at each trip's FIRST SERVED position)
///   2. `dep_deltas[T][S]`        (trip-major; `dep_delta[first-served] = 0`)
///   3. `dwell_deltas[T][S]`      (trip-major; `arr - dep = arr_diff <= 0`)
///   4. `served_bits[T][ceil(S/8)]` (trip-major, LSB-first)
///
/// Delta elements 2 and 3 are `i16` LE (2 B each) when `width == I16` —
/// BYTE-IDENTICAL to the original band layout — or `i32` LE (4 B each) when
/// `width == I32`. `trip_first_dep` stays u32 and `served_bits` is unchanged
/// in both widths.
///
/// `T` = trips in this pattern (Pin-4 order, as stored in `p.trips`); `S` =
/// `stop_count`. Derived ENTIRELY from the cursor's `pos_to_row`:
///   `served_bits[t][p] = pos_to_row[p] != -1`
///   `trip_first_dep[t] = dep_secs(pos_to_row[first served p])`
///   `dep_deltas[t][p]  = dep_secs(pos_to_row[p]) - trip_first_dep[t]` (served; else 0)
///   `dwell_deltas[t][p] = arr_diff(pos_to_row[p])`  (served; else 0)
/// where `arr(t,p) = dep + arr_diff` and `arr_diff <= 0` (scan.rs:340-353).
fn encode_trip_times_for_pattern<B>(
    reader: &Reader<B>,
    p: &IndexRoute,
    width: DeltaWidth,
    out: &mut Vec<u8>,
) -> Result<(), EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let stop_count = p.stop_ids.len();
    let trips = &p.trips;
    let len_before = out.len();

    // (b): each trip's pos_to_row length == stop_count. The caller already checks
    // this at the top of the per-pattern loop (before any positional index), so
    // this is a defensive re-check keeping this helper safe in isolation.
    for t in trips {
        if t.pos_to_row.len() != stop_count {
            return Err(EngineError::Corrupt(
                "0x13 trip pos_to_row len != stop_count",
            ));
        }
    }

    // 1. trip_first_dep[T].
    for t in trips {
        let first_dep = trip_first_dep(reader, t)?;
        out.extend_from_slice(&first_dep.to_le_bytes());
    }

    // 2. dep_deltas[T][S], trip-major, at the region width.
    for t in trips {
        let first_dep = trip_first_dep(reader, t)?;
        let base = if first_dep == DEP_SECS_NOT_SERVED {
            // Unserved-everywhere trip (no served position): base is the
            // NOT_SERVED sentinel; every delta is 0 (masked by served_bits).
            0i64
        } else {
            first_dep as i64
        };
        for &row in &t.pos_to_row {
            let delta: i64 = if row == -1 {
                0
            } else {
                let dep = reader.dep_secs(row as usize)? as i64;
                dep - base
            };
            push_delta(out, delta, width, "dep_delta")?;
        }
    }

    // 3. dwell_deltas[T][S], trip-major. arr - dep = arr_diff (<= 0).
    for t in trips {
        for &row in &t.pos_to_row {
            let dwell: i64 = if row == -1 {
                0
            } else {
                reader.stop_time(row as usize)?.arr_diff as i64
            };
            push_delta(out, dwell, width, "dwell_delta")?;
        }
    }

    // 4. served_bits[T][ceil(S/8)], trip-major, LSB-first.
    let bytes_per_trip = stop_count.div_ceil(8);
    for t in trips {
        let mut bits = vec![0u8; bytes_per_trip];
        for (pos, &row) in t.pos_to_row.iter().enumerate() {
            if row != -1 {
                bits[pos / 8] |= 1 << (pos % 8);
            }
        }
        out.extend_from_slice(&bits);
    }

    // (e): the slice this pattern just wrote is exactly
    //   4*T (first_dep) + W*T*S (dep) + W*T*S (dwell) + T*ceil(S/8) (served)
    // where W = width.bytes(), T == |0x46 slice| (== trips.len()), S ==
    // stop_count. A HARD runtime check (debug_asserts are compiled out in
    // release; the band's integrity must hold in the prod producer too).
    let t = trips.len();
    let w = width.bytes();
    let expect = 4 * t + w * t * stop_count + w * t * stop_count + t * bytes_per_trip;
    if out.len() - len_before != expect {
        return Err(EngineError::Corrupt(
            "0x13 pattern slice length mismatch (e)",
        ));
    }

    Ok(())
}

/// Whether ANY of pattern `p`'s trips has a dep-delta or dwell-delta outside the
/// `i16` ±32767 s cap — the REGION-level i32-delta trigger. Mirrors the
/// `encode_trip_times_for_pattern` delta derivation EXACTLY (same base/sentinel
/// handling) so the width decision and the emitted bytes never disagree.
/// Errors (does NOT silently saturate) on the impossible `> i32` case — see
/// [`delta_needs_i32`].
fn pattern_needs_i32_deltas<B>(reader: &Reader<B>, p: &IndexRoute) -> Result<bool, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    for t in &p.trips {
        if t.pos_to_row.len() != p.stop_ids.len() {
            return Err(EngineError::Corrupt(
                "0x13 trip pos_to_row len != stop_count",
            ));
        }
        let first_dep = trip_first_dep(reader, t)?;
        let base = if first_dep == DEP_SECS_NOT_SERVED {
            0i64
        } else {
            first_dep as i64
        };
        for &row in &t.pos_to_row {
            if row == -1 {
                continue;
            }
            // dep-delta width.
            let dep = reader.dep_secs(row as usize)? as i64;
            if delta_needs_i32(dep - base, "dep_delta")? {
                return Ok(true);
            }
            // dwell-delta width (arr_diff is already i16 in the carry, so it can
            // never overflow i16 — but check for symmetry / future-proofing).
            let dwell = reader.stop_time(row as usize)?.arr_diff as i64;
            if delta_needs_i32(dwell, "dwell_delta")? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `trip_first_dep`: abs dep secs at the trip's FIRST SERVED canonical position.
/// `DEP_SECS_NOT_SERVED` when the trip serves NO position (degenerate; the band
/// still reserves its slot so `T` aligns).
fn trip_first_dep<B>(reader: &Reader<B>, t: &RouteTrip) -> Result<u32, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    for &row in &t.pos_to_row {
        if row != -1 {
            return Ok(reader.dep_secs(row as usize)?);
        }
    }
    Ok(DEP_SECS_NOT_SERVED)
}

/// Encode `0x14 TripMeta` — `num_trips` records, 24 B stride, in `trip_idx`
/// order. `trip_pattern[t]` is trip `t`'s pattern ordinal (`Some` under
/// Unbounded for every trip on a route the index covers).
///
/// Record (locked-layout region 0x14): `pattern_idx u32@0` · `service_idx u32@4` ·
/// `trip_id_ref u32@8` · `shape_idx u32@12` · `block_idx u32@16` ·
/// `direction_id u8@20` · `wheelchair u8@21` · `bikes_allowed u8@22` ·
/// `flags u8@23`. Fields the reader cannot supply (`trip_id_ref` StringPool ref,
/// `shape_idx`, `block_idx`) use their absent sentinels — see the per-field note.
fn encode_trip_meta<B>(
    reader: &Reader<B>,
    trip_pattern: &[Option<u32>],
    num_patterns: usize,
) -> Result<Vec<u8>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let num_trips = reader.num_trips();
    // TripsIntern carry region (24 B records): trip_id pool index @+0.
    let trips_region = reader.region_bytes(Region::TripsIntern)?;
    debug_assert_eq!(trip_pattern.len(), num_trips);
    let mut out = Vec::with_capacity(num_trips * 24);
    for (t, &tp) in trip_pattern.iter().enumerate() {
        // pattern_idx — every Unbounded trip belongs to exactly one pattern. A
        // trip on no covered route (cannot happen for a fully-built index) gets
        // the u32::MAX sentinel.
        let pattern_idx = match tp {
            Some(p) => {
                if p as usize >= num_patterns {
                    return Err(EngineError::Corrupt("0x14 pattern_idx >= num_patterns"));
                }
                p
            }
            None => u32::MAX,
        };
        let service_idx = reader.trip_service_idx(t)?;
        // trip_id_ref: the StringPool ordinal of trips.trip_id. The reader exposes
        // no `trip_id_idx` accessor, so we read the pool index directly from the
        // TripsIntern carry record (+0) — the SAME ref the StringPool region holds
        // (no String alloc, byte-identical provenance).
        let trip_id_ref = rd_u32(trips_region, t * TRIP_RECORD_BYTES)?;
        // shape_idx / block_idx: PTB carries no dense shape/block ORDINAL on the
        // reader surface (shape_id is a StringPool string; block_id is absent
        // entirely). Carry the u32::MAX absent-sentinel — B1.1 freezes the field
        // width; B1.2 consumers treat MAX as "no shape / no block". (Documented
        // layout decision beyond the locked doc — see the return note.)
        let shape_idx = u32::MAX;
        let block_idx = u32::MAX;
        let direction_id = reader.trip_direction_id(t)?;
        let wheelchair = reader.trip_wheelchair(t)?;
        let bikes_allowed = reader.trip_bikes_allowed(t)?;
        // flags: bit0 = frequency-derived, bit1 = exact_times=0. PTB carries no
        // frequencies.txt, so both are 0 in B1.1.
        let flags = 0u8;

        out.extend_from_slice(&pattern_idx.to_le_bytes()); // @0
        out.extend_from_slice(&service_idx.to_le_bytes()); // @4
        out.extend_from_slice(&trip_id_ref.to_le_bytes()); // @8
        out.extend_from_slice(&shape_idx.to_le_bytes()); // @12
        out.extend_from_slice(&block_idx.to_le_bytes()); // @16
        out.push(direction_id); // @20
        out.push(wheelchair); // @21
        out.push(bikes_allowed); // @22
        out.push(flags); // @23
    }
    debug_assert_eq!(out.len(), num_trips * 24);
    Ok(out)
}

/// Encode `0x45 PatternsAtStop` CSR from the index's derived `routes_at_stop`,
/// `numStops` from the header. Ascending stop order; per-stop list is the
/// index's `routes_at_stop` order (already deduped per stop — index.rs:437-445).
fn encode_patterns_at_stop(index: &Index, num_stops: usize) -> Result<Vec<u8>, EngineError> {
    let mut sr_offsets: Vec<u32> = Vec::with_capacity(num_stops + 1);
    let mut sr_values: Vec<u32> = Vec::new();
    let num_patterns = index.routes.len() as u32;
    sr_offsets.push(0);
    for s in 0..num_stops {
        if let Some(list) = index.routes_at_stop.get(&(s as u32)) {
            for &pidx in list {
                if pidx >= num_patterns {
                    return Err(EngineError::Corrupt("0x45 pattern ordinal >= num_patterns"));
                }
                sr_values.push(pidx);
            }
        }
        sr_offsets.push(sr_values.len() as u32);
    }
    assert_csr_monotonic(&sr_offsets, sr_values.len(), "0x45")?;

    let mut out = Vec::with_capacity((sr_offsets.len() + sr_values.len()) * 4);
    for &o in &sr_offsets {
        out.extend_from_slice(&o.to_le_bytes());
    }
    for &v in &sr_values {
        out.extend_from_slice(&v.to_le_bytes());
    }
    Ok(out)
}

/// Whether a signed delta `v` falls outside the `i16` ±32767 s cap (~9.1h) — i.e.
/// the REGION must use the wide `i32` layout. The ±32767 s bound was a DELIBERATE
/// FORMAT CONSTRAINT (a fixed-width delta keeps `0x13` O(1)
/// random-access, no varint scan); the i32-delta variant relaxes it for the
/// long-distance / intercity (Paris) on-ramp. PTN's urban target cities keep the
/// BYTE-IDENTICAL `i16` layout (spans ≪ 9h ⇒ `false`).
///
/// Residual guard: a value outside `i32` range is the IMPOSSIBLE case (dep secs
/// are u32; even a full-day overnight span fits `i32` with vast headroom), so it
/// is a hard `Corrupt` (loud — a silent wrap would corrupt every later departure
/// in the trip), NOT a width selection. See the i32-delta design spec.
#[inline]
fn delta_needs_i32(v: i64, what: &'static str) -> Result<bool, EngineError> {
    if v < i32::MIN as i64 || v > i32::MAX as i64 {
        return Err(match what {
            "dep_delta" => EngineError::Corrupt("0x13 dep_delta overflows i32"),
            "dwell_delta" => EngineError::Corrupt("0x13 dwell_delta overflows i32"),
            _ => EngineError::Corrupt("0x13 delta overflows i32"),
        });
    }
    Ok(v < i16::MIN as i64 || v > i16::MAX as i64)
}

/// Append delta `v` to `out` at the region's chosen `width`. The width is
/// REGION-level (decided by a pre-pass over every pattern via
/// [`pattern_needs_i32_deltas`]), so by the time this runs the value is already
/// known to fit: in `I16` mode it MUST be in `i16` range, in `I32` mode in `i32`
/// range. The bounds are re-asserted defensively (a width/decision mismatch is a
/// `Corrupt`, never a silent truncating cast).
#[inline]
fn push_delta(
    out: &mut Vec<u8>,
    v: i64,
    width: DeltaWidth,
    what: &'static str,
) -> Result<(), EngineError> {
    match width {
        DeltaWidth::I16 => {
            if v < i16::MIN as i64 || v > i16::MAX as i64 {
                return Err(match what {
                    "dep_delta" => EngineError::Corrupt("0x13 dep_delta overflows i16"),
                    _ => EngineError::Corrupt("0x13 delta overflows i16"),
                });
            }
            out.extend_from_slice(&(v as i16).to_le_bytes());
        }
        DeltaWidth::I32 => {
            if v < i32::MIN as i64 || v > i32::MAX as i64 {
                return Err(match what {
                    "dep_delta" => EngineError::Corrupt("0x13 dep_delta overflows i32"),
                    _ => EngineError::Corrupt("0x13 delta overflows i32"),
                });
            }
            out.extend_from_slice(&(v as i32).to_le_bytes());
        }
    }
    Ok(())
}

/// Invariant (d): CSR offsets strictly monotonic-nondecreasing, first == 0, last
/// == `values_len`.
fn assert_csr_monotonic(
    offsets: &[u32],
    values_len: usize,
    which: &'static str,
) -> Result<(), EngineError> {
    if offsets.is_empty() || offsets[0] != 0 {
        return Err(match which {
            "0x45" => EngineError::Corrupt("0x45 CSR offsets[0] != 0"),
            _ => EngineError::Corrupt("0x46 CSR offsets[0] != 0"),
        });
    }
    for w in offsets.windows(2) {
        if w[1] < w[0] {
            return Err(match which {
                "0x45" => EngineError::Corrupt("0x45 CSR offsets non-monotonic"),
                _ => EngineError::Corrupt("0x46 CSR offsets non-monotonic"),
            });
        }
    }
    if *offsets.last().unwrap() as usize != values_len {
        return Err(match which {
            "0x45" => EngineError::Corrupt("0x45 CSR last offset != values len"),
            _ => EngineError::Corrupt("0x46 CSR last offset != values len"),
        });
    }
    Ok(())
}

/// Invariant (h): per-trip `stop_sequence` strictly INCREASING in canonical
/// storage order. The band freezes ONE row order (sort by stop_seq); a
/// non-strictly-increasing sequence (a duplicate/decreasing `stop_sequence`)
/// would make that order ambiguous, so it is rejected. We re-read each member
/// trip's rows fresh from the flat carry, sort by stop_seq, and assert strict
/// increase.
///
/// SCOPE — what this does NOT reject (the bit2/`stop_sequence` deferral): B1.1 emits `flags.bit2 == 0` everywhere and
/// carries NO original `stop_sequence` in the band (no `PatternStopSeq` column).
/// A strictly-increasing-but-NON-CONSECUTIVE feed — `stop_sequence` with gaps or
/// a non-zero/1-based start (e.g. 1,2,3,… or 10,20,30,…) — is fully ALLOWED here:
/// real GTFS feeds are routinely 1-indexed and gapped, so rejecting them would
/// break production. The flat `0xF4/0xF5/0xF6` carry remains the AUTHORITATIVE
/// `stop_sequence` source until B1.5, when the `PatternStopSeq` (bit2) column
/// MUST be added to the band BEFORE the flat carry is dropped. Until then only
/// strict monotonicity matters (it disambiguates the frozen row order); the
/// original `stop_sequence` VALUES are not needed by the band. See the
/// optional PatternStopSeq representation.
fn assert_stop_seq_strictly_increasing<B>(
    reader: &Reader<B>,
    p: &IndexRoute,
) -> Result<(), EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let trip_starts = reader.trip_starts()?;
    for t in &p.trips {
        let ti = t.trip_idx as usize;
        let lo = trip_starts[ti] as usize;
        let hi = trip_starts[ti + 1] as usize;
        let mut seqs: Vec<u16> = Vec::with_capacity(hi - lo);
        for row in lo..hi {
            seqs.push(reader.stop_time(row)?.stop_seq);
        }
        seqs.sort_unstable();
        for w in seqs.windows(2) {
            if w[1] <= w[0] {
                return Err(EngineError::Corrupt(
                    "0x13 stop_sequence must be strictly increasing per trip",
                ));
            }
        }
    }
    Ok(())
}

/// Invariant (a): the emitted `0x10` enumeration MUST equal an INDEPENDENT
/// decode of the flat `0xF4/0xF5/0xF6` carry grouped by Unbounded.
///
/// This walks the reader's flat carry FROM SCRATCH — `route_trips` (0xF6 Csr),
/// `trip_starts` (0xF5 TripStarts), and `stop_time` (0xF4 StopTimes) — re-sorts
/// each trip's rows by `stop_seq`, collects the stop_idx signature, groups by
/// first-appearance per route via `group_by_pattern(.., Unbounded)`, and asserts
/// the resulting pattern `stop_idxs` sequences (in route-then-group enumeration
/// order) equal the index's `routes[i].stop_ids`. The grouping here runs over
/// signatures DERIVED INDEPENDENTLY of the index's internal `sigs`, so this is a
/// real cross-check, not the tautology a second group_by_pattern on the index's
/// own sigs would be.
fn assert_enumeration_matches_flat_carry<B>(
    reader: &Reader<B>,
    patterns: &[IndexRoute],
) -> Result<(), EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let trip_starts = reader.trip_starts()?;
    let num_routes = reader.num_routes();

    // Re-derive the full enumeration independently.
    let mut expected: Vec<Vec<u32>> = Vec::new();
    for r in 0..num_routes {
        let trip_idxs = reader.route_trips(r)?;
        let mut sigs: Vec<Vec<u32>> = Vec::with_capacity(trip_idxs.len());
        let mut boarding: Vec<Vec<u8>> = Vec::with_capacity(trip_idxs.len());
        for &t in trip_idxs {
            let lo = trip_starts[t as usize] as usize;
            let hi = trip_starts[t as usize + 1] as usize;
            let mut keyed: Vec<(u16, u32, u8)> = Vec::with_capacity(hi - lo);
            for row in lo..hi {
                let st = reader.stop_time(row)?;
                keyed.push((st.stop_seq, st.stop_idx, reader.boarding_byte(row) & 0x0F));
            }
            keyed.sort_by_key(|(seq, _, _)| *seq); // stable
            sigs.push(keyed.iter().map(|(_, sidx, _)| *sidx).collect());
            boarding.push(keyed.iter().map(|(_, _, byte)| *byte).collect());
        }
        let groups = group_by_pattern_with_boarding(
            trip_idxs,
            &sigs,
            Some(&boarding),
            PatternMode::Unbounded,
        );
        for g in groups {
            expected.push(g.stop_idxs);
        }
    }

    if expected.len() != patterns.len() {
        return Err(EngineError::Corrupt(
            "0x10 enumeration count != independent flat-carry grouping",
        ));
    }
    for (got, want) in patterns.iter().zip(expected.iter()) {
        if &got.stop_ids != want {
            return Err(EngineError::Corrupt(
                "0x10 enumeration != independent flat-carry grouping",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::testkit::{
        build_n_trip_ptb_with_boarding, build_pattern_band_ptb, build_two_trip_ptb, tagged_region,
        SoaRoute, SoaStop, STOP_TIMES,
    };
    use alloc::vec;

    // ── decode helpers (the symmetric-gate firewall: read the band back) ─────

    fn rd_u32_at(b: &[u8], off: usize) -> u32 {
        u32::from_le_bytes(b[off..off + 4].try_into().unwrap())
    }
    fn rd_u16_at(b: &[u8], off: usize) -> u16 {
        u16::from_le_bytes(b[off..off + 2].try_into().unwrap())
    }
    fn rd_i16_at(b: &[u8], off: usize) -> i16 {
        i16::from_le_bytes(b[off..off + 2].try_into().unwrap())
    }

    /// The REGION-level width selector `delta_needs_i32` at the i16 boundary +
    /// the NEGATIVE branch. `false` ⇒ the value fits i16 (region stays the
    /// BYTE-IDENTICAL 2-byte layout); `true` ⇒ it overflows i16 ⇒ the region
    /// promotes to the 4-byte i32 layout. Pins the exact threshold (the TS twin
    /// must replicate the same boundary on BOTH signs) and confirms the
    /// impossible > i32 case is a loud `Corrupt`, not a silent saturation.
    #[test]
    fn delta_needs_i32_boundary_and_negative() {
        // Positive boundary: i16::MAX stays i16; one past it promotes.
        assert_eq!(
            delta_needs_i32(32_767, "dep_delta"),
            Ok(false),
            "32767 (i16::MAX) fits i16"
        );
        assert_eq!(
            delta_needs_i32(32_768, "dep_delta"),
            Ok(true),
            "32768 overflows i16 ⇒ region i32"
        );
        // Negative boundary (the branch the TS twin also must replicate):
        // i16::MIN stays i16; one below it promotes.
        assert_eq!(
            delta_needs_i32(-32_768, "dep_delta"),
            Ok(false),
            "-32768 (i16::MIN) fits i16"
        );
        assert_eq!(
            delta_needs_i32(-32_769, "dep_delta"),
            Ok(true),
            "-32769 underflows i16 ⇒ region i32"
        );
        // i32 range fits (no Err): i32::MAX / i32::MIN promote to i32 but are NOT
        // the impossible overflow.
        assert_eq!(delta_needs_i32(i32::MAX as i64, "dep_delta"), Ok(true));
        assert_eq!(delta_needs_i32(i32::MIN as i64, "dep_delta"), Ok(true));
        // The IMPOSSIBLE > i32 case is a loud Corrupt (not a silent saturate).
        assert_eq!(
            delta_needs_i32(i32::MAX as i64 + 1, "dep_delta"),
            Err(EngineError::Corrupt("0x13 dep_delta overflows i32")),
        );
        assert_eq!(
            delta_needs_i32(i32::MIN as i64 - 1, "dwell_delta"),
            Err(EngineError::Corrupt("0x13 dwell_delta overflows i32")),
        );
    }

    /// Decoded `0x10` record.
    #[derive(Debug, Clone, Copy)]
    struct PatRec {
        stops_off: u32, // ELEMENT index into 0x11
        stop_count: u16,
        flags: u8,
    }

    fn decode_patterns(body: &[u8]) -> Vec<PatRec> {
        let count = rd_u32_at(body, 0) as usize;
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let o = 4 + i * 8;
            out.push(PatRec {
                stops_off: rd_u32_at(body, o),
                stop_count: rd_u16_at(body, o + 4),
                flags: body[o + 6],
            });
            assert_eq!(body[o + 7], 0, "0x10 reserved byte must be 0");
        }
        out
    }

    /// Decode the `0x11` stop_idx column slice for one pattern (ELEMENT-indexed).
    fn decode_pattern_stops(body: &[u8], rec: &PatRec) -> Vec<u32> {
        let base = rec.stops_off as usize;
        (0..rec.stop_count as usize)
            .map(|i| rd_u32_at(body, (base + i) * 4))
            .collect()
    }

    /// Decode `0x46 PatternTrips` into per-pattern trip-ordinal slices.
    fn decode_pattern_trips(body: &[u8], num_patterns: usize) -> Vec<Vec<u32>> {
        let offsets: Vec<u32> = (0..=num_patterns).map(|i| rd_u32_at(body, i * 4)).collect();
        let val_base = (num_patterns + 1) * 4;
        let mut out = Vec::with_capacity(num_patterns);
        for p in 0..num_patterns {
            let lo = offsets[p] as usize;
            let hi = offsets[p + 1] as usize;
            out.push(
                (lo..hi)
                    .map(|i| rd_u32_at(body, val_base + i * 4))
                    .collect(),
            );
        }
        out
    }

    /// Decode `0x45 PatternsAtStop` into per-stop pattern-ordinal slices.
    fn decode_patterns_at_stop(body: &[u8], num_stops: usize) -> Vec<Vec<u32>> {
        let offsets: Vec<u32> = (0..=num_stops).map(|i| rd_u32_at(body, i * 4)).collect();
        let val_base = (num_stops + 1) * 4;
        (0..num_stops)
            .map(|s| {
                let lo = offsets[s] as usize;
                let hi = offsets[s + 1] as usize;
                (lo..hi)
                    .map(|i| rd_u32_at(body, val_base + i * 4))
                    .collect()
            })
            .collect()
    }

    /// One trip's decoded times for a pattern of `stop_count` positions.
    struct DecodedTripTimes {
        first_dep: u32,
        dep_deltas: Vec<i16>,
        dwell_deltas: Vec<i16>,
        served: Vec<bool>,
    }

    /// Decode the `0x13 TripTimes` slice for ONE pattern. `pattern_byte_off` is
    /// the byte offset of this pattern's slice within `body`; returns the decoded
    /// trips and the byte length consumed (so the caller can advance).
    fn decode_trip_times(
        body: &[u8],
        mut off: usize,
        num_trips: usize,
        stop_count: usize,
    ) -> (Vec<DecodedTripTimes>, usize) {
        let start = off;
        let mut first_deps = Vec::with_capacity(num_trips);
        for _ in 0..num_trips {
            first_deps.push(rd_u32_at(body, off));
            off += 4;
        }
        let mut dep_deltas: Vec<Vec<i16>> = Vec::with_capacity(num_trips);
        for _ in 0..num_trips {
            let mut row = Vec::with_capacity(stop_count);
            for _ in 0..stop_count {
                row.push(rd_i16_at(body, off));
                off += 2;
            }
            dep_deltas.push(row);
        }
        let mut dwell_deltas: Vec<Vec<i16>> = Vec::with_capacity(num_trips);
        for _ in 0..num_trips {
            let mut row = Vec::with_capacity(stop_count);
            for _ in 0..stop_count {
                row.push(rd_i16_at(body, off));
                off += 2;
            }
            dwell_deltas.push(row);
        }
        let bpt = stop_count.div_ceil(8);
        let mut served: Vec<Vec<bool>> = Vec::with_capacity(num_trips);
        for _ in 0..num_trips {
            let bits = &body[off..off + bpt];
            off += bpt;
            let mut row = Vec::with_capacity(stop_count);
            for pos in 0..stop_count {
                row.push((bits[pos / 8] >> (pos % 8)) & 1 == 1);
            }
            served.push(row);
        }
        let trips = (0..num_trips)
            .map(|t| DecodedTripTimes {
                first_dep: first_deps[t],
                dep_deltas: dep_deltas[t].clone(),
                dwell_deltas: dwell_deltas[t].clone(),
                served: served[t].clone(),
            })
            .collect();
        (trips, off - start)
    }

    /// Decode the contract `dep_secs(t,p) = served ? first_dep + dep_delta : NOT_SERVED`
    /// for one (decoded trip, position). Returns the abs dep secs as `i64`
    /// (NOT_SERVED sentinel widened) so callers can compare directly.
    fn decode_dep(d: &DecodedTripTimes, pos: usize) -> i64 {
        if d.served[pos] {
            d.first_dep as i64 + d.dep_deltas[pos] as i64
        } else {
            DEP_SECS_NOT_SERVED as i64
        }
    }

    // ── 1. simple 2-pattern (branch) ─────────────────────────────────────────

    #[test]
    fn branch_two_patterns_enumeration_stops_membership() {
        // LOCAL [s0,s1,s2,s4], BRANCH [s0,s1,s3,s4] → 2 distinct patterns.
        let bytes = build_two_trip_ptb(
            5,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        let band = encode_pattern_band(&r, &idx).unwrap();

        // 0x10 enumeration: 2 patterns == the Unbounded grouping.
        let pats = decode_patterns(&band.patterns);
        assert_eq!(pats.len(), 2);
        // 0x11 ordinals per pattern.
        assert_eq!(
            decode_pattern_stops(&band.pattern_stops, &pats[0]),
            vec![0, 1, 2, 4]
        );
        assert_eq!(
            decode_pattern_stops(&band.pattern_stops, &pats[1]),
            vec![0, 1, 3, 4]
        );
        // stops_off is an ELEMENT index: pattern 0 @0, pattern 1 @4.
        assert_eq!(pats[0].stops_off, 0);
        assert_eq!(pats[1].stops_off, 4);
        // regular feed ⇒ all-regular flag set, 0x12 omitted entirely.
        assert_eq!(pats[0].flags & FLAG_ALL_REGULAR, FLAG_ALL_REGULAR);
        assert!(
            band.pattern_semantics.is_empty(),
            "regular feed ⇒ 0x12 empty"
        );

        // 0x46 membership: each pattern owns exactly its one trip.
        let pt = decode_pattern_trips(&band.pattern_trips, 2);
        assert_eq!(pt[0], vec![0u32]); // LOCAL = trip 0
        assert_eq!(pt[1], vec![1u32]); // BRANCH = trip 1

        // 0x45 PatternsAtStop: branch stop s3 → pattern 1; local stop s2 → pattern 0.
        let pas = decode_patterns_at_stop(&band.patterns_at_stop, 5);
        assert_eq!(pas[3], vec![1u32], "s3 only in BRANCH pattern 1");
        assert_eq!(pas[2], vec![0u32], "s2 only in LOCAL pattern 0");
        assert_eq!(pas[0], vec![0u32, 1], "shared entry s0");
        assert_eq!(pas[4], vec![0u32, 1], "shared exit s4");
    }

    // ── 2. lasso / repeated-stop: served_bits/pos_to_row round-trips ─────────

    #[test]
    fn lasso_repeated_stop_trip_times_roundtrip_cursor() {
        // Canonical (trip 0) loop [s0,s1,s2,s0]: terminal s0 repeats. Trip 1 short
        // [s0] (departs the terminal once). Under Unbounded these are TWO distinct
        // patterns ([0,1,2,0] vs [0]). The DANGEROUS case the locked doc calls out:
        // the band's 0x13 must reproduce the cursor's pos_to_row for the lasso.
        let bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 0, 26100)],
            &[(1, 0, 30000)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        let band = encode_pattern_band(&r, &idx).unwrap();

        let pats = decode_patterns(&band.patterns);
        let pt = decode_pattern_trips(&band.pattern_trips, pats.len());

        // Walk every pattern's 0x13 and assert decode == cursor (the firewall).
        let mut off = 0usize;
        for (pidx, prec) in pats.iter().enumerate() {
            let sc = prec.stop_count as usize;
            let nt = pt[pidx].len();
            let (decoded, consumed) = decode_trip_times(&band.trip_times, off, nt, sc);
            off += consumed;
            for (ti, &trip_ord) in pt[pidx].iter().enumerate() {
                // Find this trip's RouteTrip in the index (same pattern slot).
                let route = &idx.routes[pidx];
                let rt = route
                    .trips
                    .iter()
                    .find(|t| t.trip_idx == trip_ord)
                    .expect("trip in index pattern");
                let d = &decoded[ti];
                // served_bits == (pos_to_row != -1) for every position.
                for pos in 0..sc {
                    assert_eq!(
                        d.served[pos],
                        rt.pos_to_row[pos] != -1,
                        "served bit pos {pos} pattern {pidx} trip {trip_ord}"
                    );
                }
                // Reconstruct dep_secs at each served position and compare to the
                // cursor's pos_to_row's actual departure.
                for pos in 0..sc {
                    if rt.pos_to_row[pos] != -1 {
                        let want_dep = r.dep_secs(rt.pos_to_row[pos] as usize).unwrap() as i64;
                        let got_dep = d.first_dep as i64 + d.dep_deltas[pos] as i64;
                        assert_eq!(
                            got_dep, want_dep,
                            "dep@pos{pos} pattern {pidx} trip {trip_ord}"
                        );
                        // dwell: arr = dep + dwell_delta; arr_diff is the dwell.
                        let want_arr = r.stop_time(rt.pos_to_row[pos] as usize).unwrap().dep_secs
                            as i64
                            + r.stop_time(rt.pos_to_row[pos] as usize).unwrap().arr_diff as i64;
                        let got_arr = got_dep + d.dwell_deltas[pos] as i64;
                        assert_eq!(got_arr, want_arr, "arr@pos{pos}");
                    }
                }
            }
        }
        // Sanity: the loop pattern [0,1,2,0] DID survive with the terminal repeat.
        let loop_pat = pats
            .iter()
            .position(|p| decode_pattern_stops(&band.pattern_stops, p) == vec![0u32, 1, 2, 0])
            .expect("loop pattern present with repeated terminal");
        assert_eq!(pats[loop_pat].stop_count, 4);
    }

    // ── 3. express-skip: served_bits 0-bit + -1 hole reproduced ──────────────

    #[test]
    fn express_skip_served_bit_and_hole() {
        // Scenario #3 (locked doc): a trip that SKIPS a middle position must carry
        // a 0 served-bit there, and decode must reproduce the -1 hole (no dep).
        //
        // Two trips share signature [s0,s1,s2] → ONE pattern. Trip 1's MIDDLE row
        // carries a SENTINEL dep (`DEP_SECS_NOT_SERVED`), so the cursor leaves its
        // pos 1 == -1 (express-skip via a present-but-unserved row, exactly the
        // case `index.rs` documents). The band's served_bits[trip1][1] must be 0,
        // and the decoded dep at pos 1 must be absent while pos 0 and pos 2 decode
        // to trip 1's real departures.
        let mut bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        );
        // Sentinel-poke trip 1's middle dep (global row 4 = trip 0's 3 rows + 1).
        let (st_off, _) = tagged_region(&bytes, STOP_TIMES);
        bytes[st_off + 4 * 4..st_off + 4 * 4 + 4]
            .copy_from_slice(&DEP_SECS_NOT_SERVED.to_le_bytes());
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        let band = encode_pattern_band(&r, &idx).unwrap();

        let pats = decode_patterns(&band.patterns);
        assert_eq!(pats.len(), 1, "shared sig → one pattern");
        let pt = decode_pattern_trips(&band.pattern_trips, 1);
        let (decoded, _) = decode_trip_times(&band.trip_times, 0, pt[0].len(), 3);

        // The trip with the sentinel-dep middle row has served_bits 1,0,1; the -1
        // hole at pos 1 decodes as "not served" (no dep to reconstruct). The
        // other trip serves all three positions.
        let route = &idx.routes[0];
        let mut saw_hole = false;
        for (ti, &trip_ord) in pt[0].iter().enumerate() {
            let rt = route.trips.iter().find(|t| t.trip_idx == trip_ord).unwrap();
            let d = &decoded[ti];
            for pos in 0..3 {
                let served = rt.pos_to_row[pos] != -1;
                assert_eq!(d.served[pos], served, "served pos {pos} trip {trip_ord}");
                if served {
                    // decode reproduces the real departure at served positions.
                    let want = r.dep_secs(rt.pos_to_row[pos] as usize).unwrap() as i64;
                    let got = d.first_dep as i64 + d.dep_deltas[pos] as i64;
                    assert_eq!(got, want, "served dep pos {pos} trip {trip_ord}");
                } else {
                    saw_hole = true;
                }
            }
        }
        assert!(saw_hole, "express-skip produced a -1 hole (0 served-bit)");
    }

    // ── 4. invariants fire ───────────────────────────────────────────────────

    #[test]
    fn invariant_a_fires_on_mismatched_enumeration() {
        // Build a valid index, then HAND-CORRUPT a pattern's stop_ids so the
        // emitted enumeration diverges from the independent flat-carry grouping.
        let bytes = build_two_trip_ptb(
            5,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let mut idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        // Corrupt pattern 0's stop_ids (swap a stop) — now it no longer equals the
        // flat-carry grouping for GTFS route 0.
        idx.routes[0].stop_ids[2] = 99; // was s2 (2); now a phantom stop
        let err = encode_pattern_band(&r, &idx).unwrap_err();
        assert!(
            matches!(err, EngineError::Corrupt(m) if m.contains("0x10 enumeration")),
            "got {err:?}"
        );
    }

    #[test]
    fn invariant_b_fires_on_wrong_row_count() {
        let bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let mut idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        // Truncate a trip's pos_to_row so its length != stop_count (3).
        idx.routes[0].trips[0].pos_to_row.pop();
        let err = encode_pattern_band(&r, &idx).unwrap_err();
        assert!(
            matches!(err, EngineError::Corrupt(m) if m.contains("pos_to_row len")),
            "got {err:?}"
        );
    }

    #[test]
    fn invariant_c_fires_on_empty_pattern() {
        let bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let mut idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        idx.routes[0].stop_ids.clear(); // zero-stop pattern
        idx.routes[0].trips[0].pos_to_row.clear();
        idx.routes[0].trips[1].pos_to_row.clear();
        // Independent flat-carry grouping now mismatches first (a), which also
        // guards a zero-stop pattern. Accept either (a) or (c) as the rejection.
        let err = encode_pattern_band(&r, &idx).unwrap_err();
        assert!(
            matches!(err, EngineError::Corrupt(m) if m.contains("0x10")),
            "got {err:?}"
        );
    }

    #[test]
    fn invariant_d_fires_on_non_monotonic_csr() {
        // 0x45 monotonicity is derived internally, so corrupt the routes_at_stop
        // to produce an out-of-range pattern ordinal (the (g)+(d) family guards
        // the CSR build). A pattern ordinal >= num_patterns must be rejected.
        let bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let mut idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        idx.routes_at_stop.insert(0, vec![999u32]); // out-of-range pattern ordinal
        let err = encode_pattern_band(&r, &idx).unwrap_err();
        assert!(
            matches!(err, EngineError::Corrupt(m) if m.contains("0x45 pattern ordinal")),
            "got {err:?}"
        );
    }

    #[test]
    fn invariant_g_fires_on_out_of_range_trip_ordinal() {
        // (g): every 0x46 trip ordinal must be < num_trips. Corrupt a member
        // trip_idx (which (a)'s stop_ids-only enumeration check does NOT catch, so
        // this isolates the (g) 0x46 guard) to an out-of-range ordinal.
        let bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let mut idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        idx.routes[0].trips[0].trip_idx = 999; // >= num_trips (2)
        let err = encode_pattern_band(&r, &idx).unwrap_err();
        assert!(
            matches!(err, EngineError::Corrupt(m) if m.contains("0x46 trip ordinal")),
            "got {err:?}"
        );
    }

    #[test]
    fn invariant_h_fires_on_non_monotonic_stop_seq() {
        // Two rows with the SAME stop_sequence (1,1) → not strictly increasing.
        // The feed is otherwise a valid single pattern. (h) must reject it (B1.1
        // freezes one row order; non-consecutive needs the deferred bit2 column).
        let bytes = build_two_trip_ptb(
            2,
            &[(1, 0, 25200), (1, 1, 25500)], // duplicate stop_seq 1
            &[(1, 0, 28800), (2, 1, 29100)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        let err = encode_pattern_band(&r, &idx).unwrap_err();
        assert!(
            matches!(err, EngineError::Corrupt(m) if m.contains("stop_sequence")),
            "got {err:?}"
        );
    }

    // ── 5. omit-when-all-regular (both ways) ─────────────────────────────────

    #[test]
    fn all_regular_feed_omits_0x12() {
        let bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        let band = encode_pattern_band(&r, &idx).unwrap();
        let pats = decode_patterns(&band.patterns);
        assert!(
            band.pattern_semantics.is_empty(),
            "regular feed ⇒ 0x12 omitted"
        );
        for p in &pats {
            assert_eq!(p.flags & FLAG_ALL_REGULAR, FLAG_ALL_REGULAR);
        }
    }

    #[test]
    fn pickup_forbidden_feed_emits_0x12() {
        // A single-pattern route whose MIDDLE stop has pickup_type==1 (forbidden).
        // 0xFA byte packing: pickup_type[1:0]=1 → 0x01 (drop-off regular). Both
        // trips share sig [s0,s1,s2] → ONE pattern; 0x12 present with the right byte.
        let trips: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        ];
        // 6 stop_times in trip-storage order; pickup forbidden at the MIDDLE of
        // trip 0 (row 1) and trip 1 (row 4) — the canonical position 1.
        let boarding = vec![0x50, 0x51, 0x50, 0x50, 0x51, 0x50];
        let bytes = build_n_trip_ptb_with_boarding(&["s0", "s1", "s2"], trips, &boarding);
        let r = crate::Reader::from_bytes(bytes).unwrap();
        // The reader maps 0x51 → pickup_forbidden at those rows.
        assert!(r.pickup_forbidden(1));
        let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        let band = encode_pattern_band(&r, &idx).unwrap();

        let pats = decode_patterns(&band.patterns);
        assert_eq!(pats.len(), 1, "shared sig → one pattern");
        // NOT all-regular ⇒ flag clear, 0x12 present (one byte per position).
        assert_eq!(
            pats[0].flags & FLAG_ALL_REGULAR,
            0,
            "pickup-forbidden ⇒ not all-regular"
        );
        assert_eq!(
            band.pattern_semantics.len(),
            3,
            "one 0x12 byte per position"
        );
        // Packing: 0xFA byte 0x51 → low nibble 0x1 (pickup_type 1). Position 1
        // carries pickup_type==1; positions 0,2 are regular 0x00.
        assert_eq!(band.pattern_semantics[0], 0x00);
        assert_eq!(
            band.pattern_semantics[1] & 0b11,
            1,
            "pos 1 pickup_type == 1"
        );
        assert_eq!(band.pattern_semantics[2], 0x00);
    }

    /// Restrictions are per stop_time, even for identical stop sequences.
    /// GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    #[test]
    fn mixed_boarding_restrictions_are_separate_patterns() {
        let fixture =
            Reader::from_bytes(crate::engine::testkit::build_mixed_boarding_pattern_ptb()).unwrap();
        for mode in [
            PatternMode::Off,
            PatternMode::Unbounded,
            PatternMode::CoveringMerge,
        ] {
            Index::build(&fixture, mode).unwrap();
        }
        assert_eq!(fixture.patterns().unwrap().len(), 3);

        let trips: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        ];
        for (first, second) in [(0x50, 0x51), (0x51, 0x50), (0x50, 0x54)] {
            let boarding = [0x50, first, 0x50, 0x50, second, 0x50];
            let bytes = build_n_trip_ptb_with_boarding(&["s0", "s1", "s2"], trips, &boarding);
            let reader = Reader::from_bytes(bytes).unwrap();
            let index = Index::build(&reader, PatternMode::Unbounded).unwrap();
            let band = encode_pattern_band(&reader, &index).unwrap();
            assert_eq!(decode_patterns(&band.patterns).len(), 2);
            let members = decode_pattern_trips(&band.pattern_trips, 2);
            assert_eq!(members, vec![vec![0], vec![1]]);
            let restricted = if first != 0x50 { first } else { second };
            assert_eq!(band.pattern_semantics, [0, restricted & 0x0F, 0]);
        }
    }

    // ── 0x14 TripMeta basic shape ────────────────────────────────────────────

    #[test]
    fn trip_meta_shape_and_pattern_backref() {
        let bytes = build_two_trip_ptb(
            5,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
        let band = encode_pattern_band(&r, &idx).unwrap();

        // 24 B per trip, num_trips records.
        assert_eq!(band.trip_meta.len(), r.num_trips() * 24);
        // Trip 0 → pattern 0 (LOCAL); trip 1 → pattern 1 (BRANCH).
        let pat0 = rd_u32_at(&band.trip_meta, 0);
        let pat1 = rd_u32_at(&band.trip_meta, 24);
        assert_eq!(pat0, 0);
        assert_eq!(pat1, 1);
        // service_idx @+4 == 0; shape_idx @+12 and block_idx @+16 == MAX (absent).
        assert_eq!(rd_u32_at(&band.trip_meta, 4), 0);
        assert_eq!(rd_u32_at(&band.trip_meta, 12), u32::MAX, "shape_idx absent");
        assert_eq!(rd_u32_at(&band.trip_meta, 16), u32::MAX, "block_idx absent");
    }

    // ── THE cursor-parity cross-check (B1.1 Task B key deliverable) ──────────
    //
    // The symmetric differential gate (TS≡Rust) CANNOT catch a band that
    // round-trips its own wrong bytes. This is the INDEPENDENT oracle: decode the
    // emitted `0x13 TripTimes` (trip_first_dep + dep_deltas + dwell_deltas +
    // served_bits) back to per-trip departures and assert they equal the
    // flat-carry-derived `Index::build_flat(.., Unbounded)` cursor output
    // (`pos_to_row` → `dep_secs`) for EVERY trip (B1.5-T2: `build_flat`, since the
    // band path's `pos_to_row` are now served markers) — exhaustively over the
    // branch, lasso
    // (repeated-stop), express-skip (-1 hole), and skip-pos-0 (first-served-dep /
    // Pin-4 "-1 sorts first") traps. It is run over BOTH the testkit
    // `build_pattern_band_ptb` (exercising that mirror so it isn't dead code) AND
    // the committed `pattern-band-tiny.ptb` (the shipped bytes).

    /// The shared B1.1 fixture topology: one route, FIVE trips — a 2-pattern
    /// branch (trips 0/1), a repeated-stop lasso (trip 2), an express-skip
    /// (trip 3, sharing trip 0's signature but with its s2 row sentinel-poked),
    /// and a skip-pos-0 express (trip 4, sharing trip 0's signature but with its
    /// s0 row sentinel-poked ⇒ it boards at s1, so canonical pos 0 is a `-1`
    /// hole and `trip_first_dep` bases on the s1 dep — the Pin-4 "-1 sorts first"
    /// path). MUST match `gen_fixtures.rs::pattern_band_tiny`'s topology
    /// byte-for-byte (so the testkit-built band and the committed `.ptb` band are
    /// the same feed). The sentinel rows are the global stop_time indices of trip
    /// 3's s2 (row 15) and trip 4's s0 (row 17): trips 0/1/2 contribute 4+4+5 = 13
    /// rows, trip 3 contributes 4 (rows 13..17) with its s2 at 13+2 = 15, trip 4
    /// starts at row 17 with its s0 as its FIRST row ⇒ row 17.
    fn pattern_band_tiny_topology() -> (Vec<SoaStop<'static>>, Vec<SoaRoute<'static>>, Vec<usize>) {
        let stops = vec![
            SoaStop {
                id: "s0",
                name: "Origin",
                lat: 54.6800,
                lon: 25.2700,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s1",
                name: "Stem",
                lat: 54.6810,
                lon: 25.2710,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s2",
                name: "Apex A",
                lat: 54.6820,
                lon: 25.2720,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s3",
                name: "Branch",
                lat: 54.6830,
                lon: 25.2730,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s4",
                name: "Exit",
                lat: 54.6840,
                lon: 25.2740,
                parent: None,
                wheelchair: 0,
            },
        ];
        let routes = vec![SoaRoute {
            id: "R0",
            agency: "A0",
            short: "1",
            long: "Pattern Band",
            color: "",
            text_color: "",
            route_type: 3,
        }];
        (stops, routes, vec![15, 17])
    }

    /// The five-trip rows, parallel to `pattern_band_tiny_topology`.
    const PATTERN_BAND_TINY_TRIPS: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)], // LOCAL  [0,1,2,4]
        &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)], // BRANCH [0,1,3,4]
        &[
            (1, 0, 32400),
            (2, 1, 32700),
            (3, 2, 33000),
            (4, 1, 33300),
            (5, 4, 33600),
        ], // LASSO [0,1,2,1,4]
        &[(1, 0, 36000), (2, 1, 36300), (3, 2, 36600), (4, 4, 36900)], // EXPRESS-SKIP (s2 row 15 poked)
        &[(1, 0, 39600), (2, 1, 39900), (3, 2, 40200), (4, 4, 40500)], // SKIP-POS-0 (s0 row 17 poked)
    ];

    /// Exhaustively cross-check a decoded band against the cursor (`reader` +
    /// `idx`) for EVERY pattern and EVERY member trip. Decodes `0x13` per pattern
    /// (driven by the `0x46` membership), reconstructs each trip's served set +
    /// departures + arrivals, and asserts byte-equality with the cursor's
    /// `pos_to_row` → `dep_secs`/`arr`. Returns the number of (pattern, trip,
    /// position) triples checked so the caller can assert non-vacuity, plus three
    /// trap flags (`saw_repeated_stop` / `saw_hole` / `saw_skip_pos0`) so the
    /// caller can assert each trap was actually exercised (non-vacuous coverage).
    fn cross_check_band_against_cursor<B>(
        reader: &crate::Reader<B>,
        idx: &Index,
        patterns_body: &[u8],
        pattern_stops_body: &[u8],
        trip_times_body: &[u8],
        pattern_trips_body: &[u8],
    ) -> (usize, bool, bool, bool)
    where
        B: AsRef<[u8]> + Send + Sync + 'static,
    {
        let pats = decode_patterns(patterns_body);
        assert_eq!(pats.len(), idx.routes.len(), "0x10 count == index patterns");
        let pt = decode_pattern_trips(pattern_trips_body, pats.len());

        let mut checked_positions = 0usize;
        let mut saw_repeated_stop = false; // lasso: a stop_idx appears twice in one pattern
        let mut saw_hole = false; // express-skip: a served-bit 0 inside a pattern
        let mut saw_skip_pos0 = false; // a trip whose served_bits[0]==0 (boards past canonical pos 0)

        let mut off = 0usize;
        for (pidx, prec) in pats.iter().enumerate() {
            let sc = prec.stop_count as usize;
            let nt = pt[pidx].len();
            assert_eq!(
                nt,
                idx.routes[pidx].trips.len(),
                "0x46 slice len == pattern trips"
            );

            // Detect the lasso pattern: a repeated stop_idx in the 0x11 column.
            let stop_seq = decode_pattern_stops(pattern_stops_body, prec);
            for i in 0..stop_seq.len() {
                for j in (i + 1)..stop_seq.len() {
                    if stop_seq[i] == stop_seq[j] {
                        saw_repeated_stop = true;
                    }
                }
            }

            let (decoded, consumed) = decode_trip_times(trip_times_body, off, nt, sc);
            off += consumed;

            for (ti, &trip_ord) in pt[pidx].iter().enumerate() {
                let rt = idx.routes[pidx]
                    .trips
                    .iter()
                    .find(|t| t.trip_idx == trip_ord)
                    .expect("0x46 trip ordinal present in index pattern");
                let d = &decoded[ti];
                assert_eq!(rt.pos_to_row.len(), sc, "cursor row count == stop_count");

                // SKIP-POS-0 trap (Pin-4 "-1 sorts first"): a trip whose first
                // SERVED position is NOT canonical pos 0 ⇒ served_bits[0]==0 and
                // pos-0 decodes to NOT_SERVED. `trip_first_dep` then bases on the
                // first SERVED position, NOT pos 0. Assert the decode contract for
                // pos 0 explicitly (served-position deps are checked in the loop
                // below) so the band freeze covers the first-served-dep path.
                if !d.served[0] {
                    saw_skip_pos0 = true;
                    // Cursor agrees pos 0 is unserved.
                    assert_eq!(
                        rt.pos_to_row[0], -1,
                        "skip-pos-0: cursor pos 0 unserved pattern {pidx} trip {trip_ord}"
                    );
                    // Decode contract: an UNSERVED position decodes to NOT_SERVED
                    // (the served bit, NOT trip_first_dep + delta, gates pos 0).
                    let dep0 = decode_dep(d, 0);
                    assert_eq!(
                        dep0, DEP_SECS_NOT_SERVED as i64,
                        "skip-pos-0: pos 0 decodes to NOT_SERVED pattern {pidx} trip {trip_ord}"
                    );
                    // `trip_first_dep` bases on the FIRST SERVED position, not pos 0.
                    let first_served = (0..sc)
                        .find(|&p| d.served[p])
                        .expect("skip-pos-0 trip still serves SOME position");
                    assert_ne!(first_served, 0, "skip-pos-0 first served position != 0");
                    let want_base = reader
                        .dep_secs(rt.pos_to_row[first_served] as usize)
                        .unwrap();
                    assert_eq!(
                        d.first_dep, want_base,
                        "skip-pos-0: trip_first_dep == first-served dep pattern {pidx} trip {trip_ord}"
                    );
                }

                for pos in 0..sc {
                    let served = rt.pos_to_row[pos] != -1;
                    // served_bits == (pos_to_row != -1).
                    assert_eq!(
                        d.served[pos], served,
                        "served bit pattern {pidx} trip {trip_ord} pos {pos}"
                    );
                    if served {
                        // dep_secs(t,p) = trip_first_dep[t] + dep_deltas[t][p].
                        let want_dep = reader.dep_secs(rt.pos_to_row[pos] as usize).unwrap() as i64;
                        let got_dep = d.first_dep as i64 + d.dep_deltas[pos] as i64;
                        assert_eq!(
                            got_dep, want_dep,
                            "dep pattern {pidx} trip {trip_ord} pos {pos}"
                        );
                        // arr(t,p) = dep + dwell_deltas[t][p]; arr_diff == dwell.
                        let st = reader.stop_time(rt.pos_to_row[pos] as usize).unwrap();
                        let want_arr = st.dep_secs as i64 + st.arr_diff as i64;
                        let got_arr = got_dep + d.dwell_deltas[pos] as i64;
                        assert_eq!(
                            got_arr, want_arr,
                            "arr pattern {pidx} trip {trip_ord} pos {pos}"
                        );
                    } else {
                        saw_hole = true;
                    }
                    checked_positions += 1;
                }
            }
        }
        // The whole 0x13 body must be fully consumed (no trailing pattern).
        assert_eq!(off, trip_times_body.len(), "0x13 fully consumed");
        (
            checked_positions,
            saw_repeated_stop,
            saw_hole,
            saw_skip_pos0,
        )
    }

    #[test]
    fn cursor_parity_cross_check_testkit_band() {
        // Build the band from the testkit mirror (exercises build_pattern_band_ptb)
        // and cross-check its 0x13 decode against the Unbounded cursor for EVERY
        // trip — branch, lasso, express-skip.
        let (stops, routes, sentinels) = pattern_band_tiny_topology();
        let bytes = build_pattern_band_ptb(&stops, &routes, PATTERN_BAND_TINY_TRIPS, &sentinels);
        assert_eq!(
            crate::header::Header::parse(&bytes).unwrap().version,
            1,
            "testkit band fixture is v1 (current layout)"
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        // B1.5-T2: the v1/current-layout reader now band-builds under
        // `Index::build`, whose `pos_to_row` are SERVED MARKERS — the encoder +
        // cursor cross-check need real flat rows, so use `build_flat` (the flat
        // carry is still present).
        let idx = Index::build_flat(&r, PatternMode::Unbounded).unwrap();
        // Re-encode the band from the SAME reader/index (the bytes the fixture
        // carries are byte-identical to this — the encoder is deterministic).
        let band = encode_pattern_band(&r, &idx).unwrap();

        let (checked, saw_lasso, saw_hole, saw_skip_pos0) = cross_check_band_against_cursor(
            &r,
            &idx,
            &band.patterns,
            &band.pattern_stops,
            &band.trip_times,
            &band.pattern_trips,
        );
        assert!(checked > 0, "cross-check must be non-vacuous");
        assert!(saw_lasso, "lasso (repeated-stop) pattern must be present");
        assert!(saw_hole, "express-skip (-1 hole) must be present");
        assert!(
            saw_skip_pos0,
            "skip-pos-0 (first-served-dep / Pin-4 -1-first) trip must be present"
        );
    }

    /// B1.5-T5a teardown-completeness over the SHIPPED committed bytes. Pre-T5a
    /// this cross-checked the committed band's `0x13` against the cursor built over
    /// the SAME bundle's FLAT carry — but T5a strips that carry, so the committed
    /// fixture has no cursor to parity-check against. The cursor-vs-`0x13` parity
    /// itself is unchanged and still proven over a CARRY-BEARING build by
    /// `cursor_parity_cross_check_testkit_band`. Here we instead assert the shipped
    /// artifact is the carry-LESS shape: current PTB v1, band present, and ALL FOUR
    /// flat carries (`0xF4`/`0xF5`/`0xF6`/`0xFA`) ABSENT — the teardown actually
    /// fired and the committed bytes the differential gate feeds are genuinely
    /// carry-less.
    #[test]
    fn committed_fixture_is_carry_less_v1_with_band() {
        let bytes: Vec<u8> = include_bytes!(
            "../../../packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb"
        )
        .to_vec();
        let r = crate::Reader::from_bytes(bytes).expect("committed pattern-band-tiny.ptb decodes");
        assert_eq!(r.header().version, 1, "committed fixture is current PTB v1");
        assert!(
            r.pattern_band_present(),
            "committed fixture carries the band"
        );
        // The four flat carries are gone (B1.5 teardown).
        for id in [0xF4u16, 0xF5, 0xF6, 0xFA] {
            assert!(
                r.header().region_by_id(id).is_none(),
                "carry region {id:#x} must be ABSENT in the carry-less committed fixture"
            );
        }
        // The band still drives a successful band-only build (no flat carry needed).
        // Gated OUT of `pattern-crosscheck`: under that feature `Index::build` ALSO
        // builds the flat path (`build_flat`), which a carry-less bundle cannot
        // satisfy — band-only build over the carry-less committed bytes is the
        // default-feature path; the crosscheck oracle runs over carry-bearing builds.
        #[cfg(not(feature = "pattern-crosscheck"))]
        {
            let idx = Index::build(&r, PatternMode::Unbounded).expect("band-only build");
            assert!(
                idx.routes.len() >= 3,
                "branch + lasso + local patterns present"
            );
        }
    }
}
