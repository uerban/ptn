//! Pass 3: `departures-idx.bin` CSR transpose (Stage C).
//!
//! Transposes the Pass-1 `(trip_idx, stop_idx, stop_sequence)` triples into a
//! per-stop CSR: `offsets[stop]..offsets[stop+1]` indexes flat `(trip_idx,
//! stopTimeIdx)` entries, where `stopTimeIdx` is the ABSOLUTE StopTimes-region
//! row index of that visit (so C2c reads `dep_secs`/`arr_diff`/`stop_seq` in
//! O(1)). The index is assigned by a per-trip cursor cloned from `trip_starts`
//! — identical to pass2's StopTimes writer (`stop_times_csv.rs`), so the index
//! matches the actual on-disk row. Entries within a stop are sorted ascending
//! by `(trip_idx, stopTimeIdx)` for deterministic bytes. A loop trip that
//! visits a stop twice yields two entries (no dedup). The shared encoder
//! `pt_shared::sidecar::encode_departures_idx` turns `(offsets, entries)` into
//! the final bytes; this module only builds the CSR.

use crate::error::{Error, Result};
use crate::pass1::TripStopTriple;

/// Build the per-stop departures CSR.
///
/// Returns `(offsets, entries)` where `offsets.len() == num_stops + 1` and
/// `entries` is flat `(trip_idx, stopTimeIdx)` pairs (length `2 * total`).
/// `offsets[s]..offsets[s+1]` (in pair units) is stop `s`'s range. `stopTimeIdx`
/// is the ABSOLUTE StopTimes-region row index of the visit, assigned by a
/// per-trip cursor cloned from `trip_starts` — the SAME mechanism pass2's
/// StopTimes writer uses (`stop_times_csv.rs`), so the index matches the
/// on-disk row exactly. Entries within a stop are sorted by `(trip_idx,
/// stopTimeIdx)`.
///
/// An out-of-range `stop_idx`/`trip_idx` is a hard error rather than a
/// saturated index (mirrors `csr/route_trips.rs`); counts are `checked_add`
/// so a pathological feed can't silently wrap the u32 CSR.
pub fn build_departures_idx_csr(
    trip_stop_triples: &[TripStopTriple],
    num_stops: usize,
    trip_starts: &[u32],
) -> Result<(Vec<u32>, Vec<u32>)> {
    // Per-trip write cursor cloned from trip_starts. The Nth triple for trip T
    // (in feed-scan order) lands at StopTimes row trip_starts[T]+N — identical
    // to pass2's write_cursor, so stopTimeIdx is the real row index.
    let mut st_cursor: Vec<u32> = trip_starts.to_vec();
    let mut counts = vec![0u32; num_stops];
    let mut st_idx_of: Vec<u32> = Vec::with_capacity(trip_stop_triples.len());
    for &(trip, stop, _seq) in trip_stop_triples {
        let s = stop as usize;
        if s >= num_stops {
            return Err(Error::Config(format!(
                "departures_idx_csr: stop_idx {s} out of bounds (num_stops={num_stops})"
            )));
        }
        let st = *st_cursor.get(trip as usize).ok_or_else(|| {
            Error::Config(format!("departures_idx_csr: trip_idx {trip} out of bounds"))
        })?;
        st_idx_of.push(st);
        st_cursor[trip as usize] = st + 1;
        counts[s] = counts[s].checked_add(1).ok_or_else(|| {
            Error::Config("departures_idx_csr: per-stop count overflows u32".into())
        })?;
    }
    // Prefix-sum into offsets (pair units), overflow-guarded.
    let mut offsets = vec![0u32; num_stops + 1];
    for s in 0..num_stops {
        offsets[s + 1] = offsets[s]
            .checked_add(counts[s])
            .ok_or_else(|| Error::Config("departures_idx_csr: num_entries overflows u32".into()))?;
    }
    let total = offsets[num_stops] as usize;

    // Cursor-fill (trip_idx, stopTimeIdx) pairs, then sort within each stop's
    // slice for deterministic bytes.
    let mut pairs: Vec<(u32, u32)> = vec![(0, 0); total];
    let mut cursor = offsets.clone();
    for (&(trip, stop, _seq), &st) in trip_stop_triples.iter().zip(&st_idx_of) {
        let s = stop as usize;
        let slot = cursor[s] as usize;
        pairs[slot] = (trip, st);
        cursor[s] += 1;
    }
    for s in 0..num_stops {
        let lo = offsets[s] as usize;
        let hi = offsets[s + 1] as usize;
        pairs[lo..hi].sort_unstable();
    }

    // Flatten pairs -> entries.
    let mut entries = Vec::with_capacity(total * 2);
    for (trip, st) in pairs {
        entries.push(trip);
        entries.push(st);
    }
    Ok((offsets, entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transposes_to_stoptime_indices_sorted_within_stop() {
        // 2 trips. trip0 visits stop1 (its row 0), then stop0 (its row 1);
        // trip1 visits stop0 (its row 0). trip_starts=[0,2,3] → trip0's rows
        // are abs StopTimes idx 0,1; trip1's row is abs idx 2.
        let triples: Vec<TripStopTriple> = vec![(0, 1, 1), (0, 0, 2), (1, 0, 1)];
        let trip_starts = [0u32, 2, 3];
        let (offsets, entries) = build_departures_idx_csr(&triples, 2, &trip_starts).unwrap();
        assert_eq!(offsets, vec![0, 2, 3]);
        // stop0 → (trip0, stIdx1),(trip1, stIdx2) ; stop1 → (trip0, stIdx0)
        assert_eq!(entries, vec![0, 1, 1, 2, 0, 0]);
    }

    #[test]
    fn three_stops_sort_fires() {
        // cursor-fill order differs from sorted order, proving per-slice sort.
        // trip1 (rows at idx start 2) reaches stop0 before trip0 in feed order.
        let triples: Vec<TripStopTriple> = vec![(1, 0, 1), (0, 0, 1), (0, 2, 2)];
        let trip_starts = [0u32, 2, 3]; // trip0: idx0,1 ; trip1: idx2
        let (offsets, entries) = build_departures_idx_csr(&triples, 3, &trip_starts).unwrap();
        assert_eq!(offsets, vec![0, 2, 2, 3]);
        // stop0 sorted by (trip,stIdx): (trip0,idx0),(trip1,idx2) — NOT feed order
        assert_eq!(entries, vec![0, 0, 1, 2, /*stop1 empty*/ 0, 1]);
    }

    #[test]
    fn loop_trip_keeps_duplicate_stop_visits() {
        // trip0 visits stop0 twice — rows at abs StopTimes idx 0 and 1.
        let triples: Vec<TripStopTriple> = vec![(0, 0, 5), (0, 0, 1)];
        let trip_starts = [0u32, 2];
        let (offsets, entries) = build_departures_idx_csr(&triples, 1, &trip_starts).unwrap();
        assert_eq!(offsets, vec![0, 2]);
        assert_eq!(entries, vec![0, 0, 0, 1]); // (trip0,stIdx0),(trip0,stIdx1)
    }

    #[test]
    fn empty_yields_single_zero_offset() {
        let (offsets, entries) = build_departures_idx_csr(&[], 0, &[0u32]).unwrap();
        assert_eq!(offsets, vec![0]);
        assert!(entries.is_empty());
    }

    #[test]
    fn out_of_range_stop_is_hard_error() {
        let triples: Vec<TripStopTriple> = vec![(0, 5, 1)];
        let err = build_departures_idx_csr(&triples, 2, &[0u32, 1]).unwrap_err();
        assert!(format!("{err}").contains("out of bounds"));
    }
}
