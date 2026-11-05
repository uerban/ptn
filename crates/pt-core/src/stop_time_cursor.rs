//! O(1) stop-time reads over a carry-less pattern band.
//!
//! # Why this exists
//!
//! B1.5 made the pattern band the SOLE timetable and dropped the flat `0xF4
//! StopTimes` carry. [`Reader::stop_time`] still answers for every row, but on a
//! carry-less bundle it routes through `band_stop_time`, which re-derives the
//! whole addressing chain on EVERY call:
//!
//! * `pattern_trips(p).iter().position(|t| ..)` — O(k), k = trips in the pattern;
//! * `band_served` / `band_dep_secs` / `band_arr_secs` each call `trip_times(p)`,
//!   and each of those sums the slab spans of patterns `0..p` — several O(p)
//!   prefix walks per row.
//!
//! That is fine for a one-off read and quadratic for a full-table sweep. It is
//! the same cost that made the paris cold load spend 321 s of a 366 s startup
//! inside `build_stop_membership` (fixed in the `/stops` path by deriving
//! membership from `pattern_stops` instead). Two sweeps remain that genuinely
//! need `dep_secs` and so cannot use that trick: the producer's schedule-tile
//! input builder and pt-serve's `/scheduled-departures-for-stop`.
//!
//! [`StopTimeCursor`] is the shared fix. It pays the two O(num_patterns) /
//! O(num_trips) precomputes ONCE, then answers each row with slice math.
//!
//! # Equivalence
//!
//! Every method is defined to return exactly what [`Reader::stop_time`] returns
//! for the same row — on carry-bearing bundles by delegating to it outright, on
//! carry-less ones by decoding the same bytes `band_stop_time` decodes.
//! `cursor_matches_reader_stop_time` asserts that row-for-row over both bundle
//! shapes, and `cursor_is_not_vacuous` proves the assertion can fail.

use alloc::vec::Vec;

use crate::error::{PtbError, Result};
use crate::reader::{BandSlab, Reader, BAND_NOT_SERVED};
use crate::records::StopTime;

/// The per-bundle precompute a carry-less band needs. Absent on a carry-bearing
/// bundle, where `Reader::stop_time` is already an O(1) array index.
struct BandTables {
    /// Pattern `p`'s resolved `0x13 TripTimes` slab, one entry per pattern.
    /// Resolved in a single prefix walk instead of one walk per read.
    slabs: Vec<BandSlab>,
    /// Global trip ordinal → its LOCAL ordinal within its pattern's `0x46
    /// PatternTrips` slice. This is the inverse of the `position()` scan
    /// `band_stop_time` runs per read.
    trip_local: Vec<u32>,
}

/// A reusable O(1) reader for stop-time rows.
///
/// Construct once per bundle (or per sweep) and query as many rows as needed;
/// constructing one per read would be strictly slower than calling
/// [`Reader::stop_time`] directly, since the precompute is the whole point.
///
/// The cursor OWNS its tables and takes the reader per call rather than
/// borrowing it, so it can be stored alongside the reader it describes —
/// pt-serve keeps one on `Generation`, next to `Generation::reader`, which a
/// borrowing cursor could not express. Each entry point re-checks the reader's
/// trip and row counts against the ones the tables were built from, so handing
/// a cursor the wrong reader is an error rather than a silent mis-decode.
pub struct StopTimeCursor {
    /// `num_trips` of the reader this was built from — half the identity check.
    num_trips: usize,
    /// `num_stop_times` of the reader this was built from — the other half.
    num_stop_times: usize,
    /// `None` on a carry-bearing bundle — see [`BandTables`].
    band: Option<BandTables>,
}

impl StopTimeCursor {
    /// Build a cursor over `reader`.
    ///
    /// Costs O(num_patterns) to resolve the slabs plus O(num_trips) to invert
    /// `0x46`, and nothing at all on a carry-bearing bundle. Fails only when the
    /// bundle claims a carry-less band whose `0x13` cannot be resolved (the
    /// RAGGED variant, or a truncated region) — the same condition that would
    /// make every `Reader::stop_time` call fail.
    pub fn new<B: AsRef<[u8]> + Send + Sync + 'static>(reader: &Reader<B>) -> Result<Self> {
        let num_trips = reader.num_trips();
        let num_stop_times = reader.num_stop_times();
        if !reader.is_carry_less_band() {
            return Ok(Self {
                num_trips,
                num_stop_times,
                band: None,
            });
        }
        let slabs = reader
            .band_trip_times_slabs()
            .ok_or(PtbError::PatternBandInvalid {
                reason: "stop-time cursor: 0x13 slab precompute failed",
            })?;
        // `u32::MAX` is the "not claimed by any pattern" sentinel. The load gate
        // already proves every trip is claimed exactly once, so this loop is a
        // rebuild of a known-total mapping — but it is cheap to notice a bundle
        // that slipped past, and an unnoticed sentinel would decode as trip
        // 4294967295 of some slab rather than fail.
        let mut trip_local = alloc::vec![u32::MAX; num_trips];
        for p in 0..slabs.len() {
            let pat_trips = reader
                .pattern_trips(p)
                .ok_or(PtbError::PatternBandInvalid {
                    reason: "stop-time cursor: 0x46 pattern_trips missing",
                })?;
            for (local_t, &t) in pat_trips.iter().enumerate() {
                if t as usize >= num_trips || local_t > u32::MAX as usize {
                    return Err(PtbError::PatternBandInvalid {
                        reason: "stop-time cursor: 0x46 pattern_trips invalid",
                    });
                }
                trip_local[t as usize] = local_t as u32;
            }
        }
        if trip_local.contains(&u32::MAX) {
            return Err(PtbError::PatternBandInvalid {
                reason: "stop-time cursor: 0x46 pattern_trips omitted at least one trip",
            });
        }
        Ok(Self {
            num_trips,
            num_stop_times,
            band: Some(BandTables { slabs, trip_local }),
        })
    }

    /// Reject a reader that is not the one these tables were built from. A
    /// mismatched pairing would index another bundle's slabs and decode
    /// plausible-looking garbage, so it fails instead.
    #[inline]
    fn check_reader<B: AsRef<[u8]> + Send + Sync + 'static>(
        &self,
        reader: &Reader<B>,
    ) -> Result<()> {
        if reader.num_trips() != self.num_trips || reader.num_stop_times() != self.num_stop_times {
            return Err(PtbError::PatternBandInvalid {
                reason:
                    "stop-time cursor: reader does not match the bundle the cursor was built from",
            });
        }
        Ok(())
    }

    /// Trip `t`'s absolute row range, `trip_starts[t]..trip_starts[t + 1]`.
    #[inline]
    pub fn trip_rows<B: AsRef<[u8]> + Send + Sync + 'static>(
        &self,
        reader: &Reader<B>,
        t: usize,
    ) -> Result<core::ops::Range<usize>> {
        self.check_reader(reader)?;
        let trip_starts = reader.trip_starts()?;
        let lo = *trip_starts
            .get(t)
            .ok_or(PtbError::SliceOutOfBounds { what: "trip index" })? as usize;
        let hi = *trip_starts
            .get(t + 1)
            .ok_or(PtbError::SliceOutOfBounds { what: "trip index" })? as usize;
        Ok(lo..hi)
    }

    /// Stop-time at position `pos` of trip `t` — the O(1) read.
    ///
    /// Equal to `reader.stop_time(trip_starts[t] + pos)` for every in-range
    /// `(t, pos)`. Prefer this over [`Self::stop_time`] when the caller already
    /// knows the trip, which skips even the row→trip search.
    pub fn stop_time_in_trip<B: AsRef<[u8]> + Send + Sync + 'static>(
        &self,
        reader: &Reader<B>,
        t: usize,
        pos: usize,
    ) -> Result<StopTime> {
        let rows = self.trip_rows(reader, t)?;
        if pos >= rows.len() {
            return Err(PtbError::SliceOutOfBounds {
                what: "stop-time cursor: position beyond trip",
            });
        }
        let Some(band) = self.band.as_ref() else {
            // Carry-bearing: the flat row IS the record, and its `stop_seq` is
            // whatever the feed emitted — never re-synthesized from `pos`.
            return reader.stop_time(rows.start + pos);
        };
        let p = reader
            .trip_pattern_idx(t)
            .ok_or(PtbError::PatternBandInvalid {
                reason: "stop-time cursor: trip pattern idx",
            })? as usize;
        let slab = band.slabs.get(p).ok_or(PtbError::PatternBandInvalid {
            reason: "stop-time cursor: pattern idx beyond slab table",
        })?;
        // Sentinel already rejected in `new`; `get` keeps the decode total.
        let j = *band.trip_local.get(t).ok_or(PtbError::PatternBandInvalid {
            reason: "stop-time cursor: trip absent from its pattern",
        })? as usize;
        let stops = reader
            .pattern_stops(p)
            .ok_or(PtbError::PatternBandInvalid {
                reason: "stop-time cursor: pattern_stops",
            })?;
        let stop_idx = *stops.get(pos).ok_or(PtbError::SliceOutOfBounds {
            what: "stop-time cursor: position beyond pattern stops",
        })?;

        let dep = reader.band_dep_at(slab, j, pos);
        let (dep_secs, arr_diff) = if dep == BAND_NOT_SERVED {
            // NOT_SERVED hole — the flat carry's sentinel, byte-for-byte what
            // `band_stop_time` and TS `bandToFlatStopTimes` produce.
            (0xFFFF_FFFFu32, 0i16)
        } else {
            let arr = reader.band_arr_at(slab, j, pos);
            if arr == BAND_NOT_SERVED {
                return Err(PtbError::PatternBandInvalid {
                    reason: "stop-time cursor: band arr",
                });
            }
            // `arr - dep` is the GTFS dwell delta (`<= 0`), which originated as
            // an `i16 arr_diff` before band encoding, so it round-trips.
            let diff = arr - dep;
            (
                dep as u32,
                i16::try_from(diff).map_err(|_| PtbError::PatternBandInvalid {
                    reason: "stop-time cursor: arr_diff out of i16 range",
                })?,
            )
        };

        Ok(StopTime {
            dep_secs,
            arr_diff,
            stop_idx,
            stop_seq: u16::try_from(pos).map_err(|_| PtbError::SliceOutOfBounds {
                what: "stop-time cursor: stop_seq exceeds u16",
            })?,
        })
    }

    /// Stop-time at ABSOLUTE row `i` — equal to `reader.stop_time(i)`.
    ///
    /// O(log num_trips) for the row→trip search, then the O(1) read. A caller
    /// iterating whole trips should use [`Self::stop_time_in_trip`] and skip the
    /// search entirely.
    pub fn stop_time<B: AsRef<[u8]> + Send + Sync + 'static>(
        &self,
        reader: &Reader<B>,
        i: usize,
    ) -> Result<StopTime> {
        self.check_reader(reader)?;
        if self.band.is_none() {
            return reader.stop_time(i);
        }
        if i >= self.num_stop_times {
            return Err(PtbError::SliceOutOfBounds {
                what: "stop_time index",
            });
        }
        let trip_starts = reader.trip_starts()?;
        // `trip_starts` is monotonic with `[0] == 0` and `last() ==
        // num_stop_times` (validated at load), and `i` is in range, so this
        // lands inside `0..num_trips` — the same search `band_stop_time` does.
        let t = trip_starts
            .partition_point(|&start| start as usize <= i)
            .saturating_sub(1);
        let start = *trip_starts.get(t).ok_or(PtbError::CsrInvalid {
            detail: "stop-time cursor: trip start out of range",
        })? as usize;
        self.stop_time_in_trip(reader, t, i - start)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::testkit::{build_pattern_band_ptb_with_dwell, SoaRoute, SoaStop};
    use alloc::vec;

    /// `(carry_bearing, carry_less)` readers over a BRANCH topology with
    /// three trips across two patterns.
    ///
    /// The shape is load-bearing, not incidental:
    ///
    /// * two patterns — trip 0/2 take `[s0,s1,s2,s4]`, trip 1 takes
    ///   `[s0,s1,s3,s4]` — so pattern 1's slab sits at a NONZERO prefix offset.
    ///   With one pattern the batch resolver's running offset is always 0 and a
    ///   broken prefix would still pass;
    /// * two trips in pattern 0, so at least one trip has a nonzero LOCAL
    ///   ordinal — with one trip per pattern `trip_local` is always 0 and the
    ///   inverse table would be untested;
    /// * nonzero dwell rows, so `arr_diff` is not uniformly 0 — otherwise the
    ///   arrival decode could be dropped entirely without failing anything;
    /// * a sentinel row, so the NOT_SERVED hole is decoded at least once.
    fn band_pair() -> (Reader<Vec<u8>>, Reader<Vec<u8>>) {
        const IDS: [&str; 5] = ["s0", "s1", "s2", "s3", "s4"];
        let stops: Vec<SoaStop<'static>> = (0..5)
            .map(|i| SoaStop {
                id: IDS[i],
                name: IDS[i],
                lat: 54.68 + i as f64 * 0.001,
                lon: 25.27 + i as f64 * 0.001,
                parent: None,
                wheelchair: 0,
            })
            .collect();
        let routes = vec![SoaRoute {
            id: "R0",
            agency: "A0",
            short: "1",
            long: "Band",
            color: "",
            text_color: "",
            route_type: 3,
        }];
        let trips: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
            &[(1, 0, 32400), (2, 1, 32700), (3, 2, 33000), (4, 4, 33300)],
        ];
        // Flat rows: trip 0 = 0..4, trip 1 = 4..8, trip 2 = 8..12.
        let dwell: &[(usize, i16)] = &[(1, -30), (6, -60), (9, -15)];
        let full = build_pattern_band_ptb_with_dwell(&stops, &routes, trips, &[10], dwell);
        let stripped =
            crate::strip_regions(full.clone(), &[0xF4, 0xF5, 0xF6, 0xFA]).expect("strip carry");
        (
            Reader::from_bytes(full).expect("carry-bearing"),
            Reader::from_bytes(stripped).expect("carry-LESS"),
        )
    }

    /// COVERAGE GUARD for the fixture itself. `band_pair`'s doc comment claims
    /// the topology reaches four decode branches that a simpler fixture would
    /// leave dark; assert each claim rather than trusting the prose. Without
    /// this, a future edit to the trip table could quietly flatten the fixture
    /// and `cursor_matches_reader_stop_time` would keep passing while covering
    /// less.
    #[test]
    fn fixture_exercises_every_decode_branch() {
        let (_, reader) = band_pair();
        let patterns = reader.patterns().expect("band patterns");
        assert!(
            patterns.len() >= 2,
            "need >= 2 patterns or every slab sits at prefix offset 0 and a \
             broken prefix walk still passes (got {})",
            patterns.len(),
        );
        let cursor = StopTimeCursor::new(&reader).expect("cursor");
        let band = cursor
            .band
            .as_ref()
            .expect("carry-less bundle has band tables");
        assert!(
            band.trip_local.iter().any(|&j| j > 0),
            "need a trip at a nonzero LOCAL ordinal or the trip_local inverse is untested",
        );
        let mut saw_dwell = false;
        let mut saw_not_served = false;
        for i in 0..reader.num_stop_times() {
            let st = cursor.stop_time(&reader, i).expect("row");
            if st.arr_diff != 0 {
                saw_dwell = true;
            }
            if st.dep_secs == 0xFFFF_FFFF {
                saw_not_served = true;
            }
        }
        assert!(
            saw_dwell,
            "need a nonzero arr_diff or the arrival decode could be deleted outright",
        );
        assert!(
            saw_not_served,
            "need a NOT_SERVED hole or the sentinel branch is never taken",
        );
    }

    /// Row-for-row equivalence with `Reader::stop_time`, on BOTH bundle shapes.
    /// The carry-bearing half exercises the delegation branch; the carry-less
    /// half exercises the decode that replaces `band_stop_time`.
    #[test]
    fn cursor_matches_reader_stop_time() {
        let (bearing, less) = band_pair();
        assert!(
            !bearing.is_carry_less_band() && less.is_carry_less_band(),
            "fixture must produce one bundle of EACH shape — two carry-bearing \
             readers would leave the band decode entirely untested",
        );
        for (label, reader) in [("carry-bearing", &bearing), ("carry-less", &less)] {
            let n = reader.num_stop_times();
            assert!(n > 0, "{label}: fixture has no stop-time rows — a cursor that agreed with the reader over zero rows would prove nothing");
            let cursor = StopTimeCursor::new(reader).expect("cursor");
            for i in 0..n {
                let want = reader.stop_time(i).expect("reader row");
                let got = cursor.stop_time(reader, i).expect("cursor row");
                assert_eq!(got, want, "{label}: row {i}");
            }
            // The in-trip entry point must agree with the absolute one, since
            // the two callers being fixed use different ones.
            for t in 0..reader.num_trips() {
                let rows = cursor.trip_rows(reader, t).expect("trip rows");
                for (pos, i) in rows.clone().enumerate() {
                    assert_eq!(
                        cursor.stop_time_in_trip(reader, t, pos).expect("in-trip"),
                        reader.stop_time(i).expect("reader row"),
                        "{label}: trip {t} pos {pos}",
                    );
                }
            }
        }
    }

    /// COVERAGE GUARD. `cursor_matches_reader_stop_time` compares two decoders
    /// over the same bytes; if it could not fail, it would be asserting nothing.
    /// Perturb each field of the cursor's result and confirm the comparison
    /// rejects it.
    #[test]
    fn cursor_is_not_vacuous() {
        let (_, reader) = band_pair();
        let cursor = StopTimeCursor::new(&reader).expect("cursor");
        let want = reader.stop_time(0).expect("reader row");
        let got = cursor.stop_time(&reader, 0).expect("cursor row");
        assert_eq!(got, want);
        for mutate in [
            (|s: &mut StopTime| s.dep_secs = s.dep_secs.wrapping_add(1)) as fn(&mut StopTime),
            |s: &mut StopTime| s.arr_diff = s.arr_diff.wrapping_add(1),
            |s: &mut StopTime| s.stop_idx = s.stop_idx.wrapping_add(1),
            |s: &mut StopTime| s.stop_seq = s.stop_seq.wrapping_add(1),
        ] {
            let mut mutated = got;
            mutate(&mut mutated);
            assert_ne!(mutated, want, "mutating a field must break the comparison");
        }
    }

    /// The cursor takes its reader per call, so a caller can pair it with the
    /// WRONG bundle. That must fail loudly — silently indexing another
    /// bundle's slabs would return well-formed, wrong stop-times, which is the
    /// worst possible outcome for a departures response.
    #[test]
    fn cursor_rejects_a_foreign_reader() {
        let (_, reader) = band_pair();
        let cursor = StopTimeCursor::new(&reader).expect("cursor");
        // A bundle of a different size — one fewer trip.
        let stops: Vec<SoaStop<'static>> = ["s0", "s1"]
            .iter()
            .enumerate()
            .map(|(i, id)| SoaStop {
                id,
                name: id,
                lat: 54.68 + i as f64 * 0.001,
                lon: 25.27 + i as f64 * 0.001,
                parent: None,
                wheelchair: 0,
            })
            .collect();
        let routes = vec![SoaRoute {
            id: "R0",
            agency: "A0",
            short: "1",
            long: "Other",
            color: "",
            text_color: "",
            route_type: 3,
        }];
        let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500)]];
        let other_bytes = build_pattern_band_ptb_with_dwell(&stops, &routes, trips, &[], &[]);
        let other = Reader::from_bytes(
            crate::strip_regions(other_bytes, &[0xF4, 0xF5, 0xF6, 0xFA]).expect("strip"),
        )
        .expect("other reader");
        assert_ne!(
            other.num_trips(),
            reader.num_trips(),
            "the two fixtures must differ or this test cannot detect the mismatch",
        );
        assert!(cursor.stop_time(&other, 0).is_err());
        assert!(cursor.stop_time_in_trip(&other, 0, 0).is_err());
        assert!(cursor.trip_rows(&other, 0).is_err());
    }

    /// Out-of-range reads must fail rather than decode a neighbouring trip's
    /// bytes — both callers derive `pos` from a row index, so an off-by-one has
    /// to surface as an error, not as a plausible-looking row.
    #[test]
    fn cursor_rejects_out_of_range_reads() {
        let (_, reader) = band_pair();
        let cursor = StopTimeCursor::new(&reader).expect("cursor");
        assert!(cursor.stop_time(&reader, reader.num_stop_times()).is_err());
        assert!(cursor
            .stop_time_in_trip(&reader, reader.num_trips(), 0)
            .is_err());
        let span = cursor.trip_rows(&reader, 0).expect("trip rows").len();
        assert!(cursor.stop_time_in_trip(&reader, 0, span).is_err());
    }
}
