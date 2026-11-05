//! Query-independent PTB v2 indices, built once by [`crate::Index::build`]:
//! per-trip boundary facts, the explicit [`RuleIndex`], the date-gated
//! `DerivedBlockIndex`, and the encoded event range that bounds candidate
//! service dates.

use alloc::vec::Vec;
use hashbrown::HashMap;
use rustc_hash::FxBuildHasher;
use sha2::{Digest, Sha256};

use super::rules::RuleIndex;
use crate::engine::index::Index;
use crate::engine::scan::{alight_secs_at, dep_secs_at};
use crate::engine::types::EngineError;
use crate::v2::BlockDerivationCommitment;
use crate::Reader;

type FxHashMap<K, V> = HashMap<K, V, FxBuildHasher>;

/// Maximum layover (elapsed seconds) between consecutive same-block trips for
/// an inferred in-seat continuation. Matches the v1 producer heuristic.
pub(crate) const DERIVED_MAX_LAYOVER_SECS: i64 = 120;

const NONE: u32 = u32::MAX;

/// Where one reader trip lives in the routing index, plus its boundary rows.
#[derive(Debug, Clone, Copy)]
pub(crate) struct TripInfo {
    /// `Index.routes` slot and the trip's slot in that route (`NONE` when the
    /// trip is not routable, e.g. fewer than two stop times).
    pub route: u32,
    pub slot: u32,
    /// GTFS route ordinal.
    pub reader_route: u32,
    /// First and last canonical positions the trip serves: its initial and
    /// terminal `stop_times` rows (the vehicle boundary).
    pub first_pos: u32,
    pub last_pos: u32,
    pub is_frequency: bool,
}

/// One frequency occurrence window of a template trip, in template seconds.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FreqWindow {
    pub start: i64,
    pub end: i64,
    pub headway: i64,
    pub exact: bool,
}

/// The v2 index bundle.
#[derive(Debug)]
pub struct V2Index {
    pub(crate) trips: Vec<TripInfo>,
    /// Template first served departure (GTFS seconds) per trip.
    pub(crate) first_dep: Vec<i64>,
    /// Frequency windows per trip (empty for scheduled trips).
    pub(crate) freq: FxHashMap<u32, Vec<FreqWindow>>,
    pub(crate) rules: RuleIndex,
    /// `(source_trip, date_ordinal)` -> same-date inferred in-seat targets.
    pub(crate) derived: FxHashMap<(u32, u32), Vec<u32>>,
    /// The recomputed `0x19` commitment (also the producer's metadata value).
    pub(crate) derived_commitment: BlockDerivationCommitment,
    /// Trips whose concrete instance (service date) matters for future
    /// behaviour: scheduled sources of a pairing-available linked row or of a
    /// derived continuation.
    pub(crate) instance_level: Vec<bool>,
    /// Smallest and largest encoded event seconds across scheduled times and
    /// every frequency shift (checked arithmetic).
    pub(crate) min_event_secs: i64,
    pub(crate) max_event_secs: i64,
    /// Per `Index.routes` slot: `(uniform, spread)`. `uniform` = every trip has
    /// identical served positions and pickup/drop-off flags; `spread` bounds how
    /// far two trips' relative offsets can differ (used to stop the boarding
    /// scan once later departures are provably dominated).
    pub(crate) route_shape: Vec<(bool, i64)>,
    /// Per trip: its shape group within its `Index.routes` slot. A group is
    /// the trips of the pattern with identical served positions and
    /// pickup/drop-off flags (the whole pattern when it is uniform).
    pub(crate) trip_group: Vec<u32>,
    /// Per `Index.routes` slot, per shape group: the group's spread, as
    /// `route_shape`'s but over the group's trips only.
    pub(crate) group_spread: Vec<Vec<i64>>,
    /// Per stop: the `(pattern, position)` pairs serving it, patterns in
    /// `Index.routes_at_stop` order and positions ascending within one.
    pub(crate) stop_positions: StopPositions,
    /// Per `Index.routes` slot: the dense id of its position 0; position `p`
    /// of pattern `r` is `position_base[r] + p`.
    pub(crate) position_base: Vec<u32>,
    pub(crate) num_positions: u32,
}

/// Per stop, its `(pattern, position)` pairs ([`V2Index::stop_positions`]).
type StopPositions = FxHashMap<u32, Vec<(u32, u32)>>;

/// [`V2Index::stop_positions`], [`V2Index::position_base`] and the position
/// count.
fn stop_positions(index: &Index) -> (StopPositions, Vec<u32>, u32) {
    let mut base = Vec::with_capacity(index.routes.len());
    let mut n = 0u32;
    // Per pattern: (stop, position), sorted.
    let mut at: Vec<Vec<(u32, u32)>> = Vec::with_capacity(index.routes.len());
    for route in &index.routes {
        base.push(n);
        n += route.stop_ids.len() as u32;
        let mut v: Vec<(u32, u32)> = route
            .stop_ids
            .iter()
            .enumerate()
            .map(|(p, &s)| (s, p as u32))
            .collect();
        v.sort_unstable();
        at.push(v);
    }
    let mut out: StopPositions = FxHashMap::default();
    for (&s, rs) in &index.routes_at_stop {
        let mut pairs = Vec::new();
        for &r in rs {
            let Some(v) = at.get(r as usize) else {
                continue;
            };
            let from = v.partition_point(|&(x, _)| x < s);
            for &(x, p) in &v[from..] {
                if x != s {
                    break;
                }
                pairs.push((r, p));
            }
        }
        out.insert(s, pairs);
    }
    (out, base, n)
}

/// The largest range of relative departure or arrival offsets at any
/// position.
fn spread_of(lo_d: &[i64], hi_d: &[i64], lo_a: &[i64], hi_a: &[i64]) -> i64 {
    let mut spread = 0i64;
    for pos in 0..lo_d.len() {
        if lo_d[pos] <= hi_d[pos] {
            spread = spread.max(hi_d[pos] - lo_d[pos]);
        }
        if lo_a[pos] <= hi_a[pos] {
            spread = spread.max(hi_a[pos] - lo_a[pos]);
        }
    }
    spread
}

/// Shape groups of a pattern that is not uniform: assigns each of its routed
/// trips a group in `trip_group` and returns each group's spread.
fn shape_groups<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    route: &crate::engine::index::IndexRoute,
    ri: u32,
    trips: &[TripInfo],
    first_dep: &[i64],
    trip_group: &mut [u32],
) -> Result<Vec<i64>, EngineError> {
    use crate::engine::scan::{drop_off_forbidden_at, pickup_forbidden_at};
    let n = route.stop_ids.len();
    let mut ids: FxHashMap<Vec<u8>, u32> = FxHashMap::default();
    // Per group: lo_d, hi_d, lo_a, hi_a.
    let mut bounds: Vec<[Vec<i64>; 4]> = Vec::new();
    let mut sig: Vec<u8> = Vec::with_capacity(n);
    for (si, rt) in route.trips.iter().enumerate() {
        let t = rt.trip_idx as usize;
        if trips[t].route != ri || trips[t].slot != si as u32 {
            continue;
        }
        sig.clear();
        for pos in 0..n {
            let served = rt.pos_to_row.get(pos).copied().unwrap_or(-1) != -1;
            sig.push(if served {
                1 | (pickup_forbidden_at(reader, rt, pos) as u8) << 1
                    | (drop_off_forbidden_at(reader, rt, pos) as u8) << 2
            } else {
                0
            });
        }
        let next = bounds.len() as u32;
        let g = *ids.entry(sig.clone()).or_insert(next);
        if g == next {
            bounds.push([
                alloc::vec![i64::MAX; n],
                alloc::vec![i64::MIN; n],
                alloc::vec![i64::MAX; n],
                alloc::vec![i64::MIN; n],
            ]);
        }
        trip_group[t] = g;
        let fd = first_dep[t];
        let b = &mut bounds[g as usize];
        for pos in 0..n {
            if sig[pos] == 0 {
                continue;
            }
            let (rd, ra) = (
                dep_secs_at(reader, rt, pos)? - fd,
                alight_secs_at(reader, rt, pos)? - fd,
            );
            b[0][pos] = b[0][pos].min(rd);
            b[1][pos] = b[1][pos].max(rd);
            b[2][pos] = b[2][pos].min(ra);
            b[3][pos] = b[3][pos].max(ra);
        }
    }
    Ok(bounds
        .iter()
        .map(|[lo_d, hi_d, lo_a, hi_a]| spread_of(lo_d, hi_d, lo_a, hi_a))
        .collect())
}

impl V2Index {
    /// The recomputed `0x19 BlockDerivationCommitment`.
    pub fn block_derivation_commitment(&self) -> BlockDerivationCommitment {
        self.derived_commitment
    }

    /// Encoded event range `(min, max)` in GTFS seconds.
    pub fn event_range(&self) -> (i64, i64) {
        (self.min_event_secs, self.max_event_secs)
    }

    pub(crate) fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        index: &Index,
        verify: bool,
    ) -> Result<Self, EngineError> {
        let num_trips = reader.num_trips();
        let mut trips = alloc::vec![
            TripInfo {
                route: NONE,
                slot: NONE,
                reader_route: NONE,
                first_pos: 0,
                last_pos: 0,
                is_frequency: false,
            };
            num_trips
        ];
        let mut first_dep = alloc::vec![0i64; num_trips];
        let mut freq: FxHashMap<u32, Vec<FreqWindow>> = FxHashMap::default();
        let mut min_event = i64::MAX;
        let mut max_event = i64::MIN;
        let mut route_shape = Vec::with_capacity(index.routes.len());
        let mut group_spread: Vec<Vec<i64>> = Vec::with_capacity(index.routes.len());
        let mut trip_group = alloc::vec![0u32; num_trips];

        for (ri, route) in index.routes.iter().enumerate() {
            let n = route.stop_ids.len();
            let mut uniform = true;
            let mut lo_d = alloc::vec![i64::MAX; n];
            let mut hi_d = alloc::vec![i64::MIN; n];
            let mut lo_a = alloc::vec![i64::MAX; n];
            let mut hi_a = alloc::vec![i64::MIN; n];
            for (si, rt) in route.trips.iter().enumerate() {
                let t = rt.trip_idx as usize;
                if t >= num_trips {
                    return Err(EngineError::Corrupt("index trip out of range"));
                }
                let mut first = None;
                let mut last = None;
                for pos in 0..n {
                    if rt.pos_to_row.get(pos).copied().unwrap_or(-1) != -1 {
                        first.get_or_insert(pos);
                        last = Some(pos);
                    }
                }
                let (Some(first), Some(last)) = (first, last) else {
                    continue;
                };
                if trips[t].route != NONE {
                    // A trip appears once in the routing index; keep the first.
                    continue;
                }
                if reader.frequency_trip_quarantined(rt.trip_idx) {
                    // Never degrade a quarantined frequency trip into its
                    // scheduled template: it stays unroutable (route NONE).
                    continue;
                }
                let windows: Vec<FreqWindow> = reader
                    .frequencies_for_trip(rt.trip_idx)
                    .map(|f| FreqWindow {
                        start: f.start_secs as i64,
                        end: f.end_secs as i64,
                        headway: f.headway_secs as i64,
                        exact: f.exact_times == 1,
                    })
                    .collect();
                trips[t] = TripInfo {
                    route: ri as u32,
                    slot: si as u32,
                    reader_route: route.reader_route_idx,
                    first_pos: first as u32,
                    last_pos: last as u32,
                    is_frequency: !windows.is_empty(),
                };
                let fd = dep_secs_at(reader, rt, first)?;
                first_dep[t] = fd;
                // Shift range: scheduled = 0; frequency = every first departure
                // `start + n*h < end` minus the template first departure.
                let (min_shift, max_shift) = if windows.is_empty() {
                    (0i64, 0i64)
                } else {
                    let mut lo = i64::MAX;
                    let mut hi = i64::MIN;
                    for w in &windows {
                        if w.headway <= 0 || w.end <= w.start {
                            return Err(EngineError::Corrupt("frequency window"));
                        }
                        let last_n = (w.end - 1 - w.start) / w.headway;
                        let last_dep = w
                            .start
                            .checked_add(
                                last_n
                                    .checked_mul(w.headway)
                                    .ok_or(EngineError::TimeOverflow)?,
                            )
                            .ok_or(EngineError::TimeOverflow)?;
                        lo = lo.min(w.start - fd);
                        hi = hi.max(last_dep - fd);
                    }
                    (lo, hi)
                };
                for pos in first..=last {
                    if rt.pos_to_row.get(pos).copied().unwrap_or(-1) == -1 {
                        continue;
                    }
                    let d = dep_secs_at(reader, rt, pos)?;
                    let a = alight_secs_at(reader, rt, pos)?;
                    min_event = min_event.min(
                        a.min(d)
                            .checked_add(min_shift)
                            .ok_or(EngineError::TimeOverflow)?,
                    );
                    max_event = max_event.max(
                        a.max(d)
                            .checked_add(max_shift)
                            .ok_or(EngineError::TimeOverflow)?,
                    );
                    let (rd, ra) = (d - fd, a - fd);
                    lo_d[pos] = lo_d[pos].min(rd);
                    hi_d[pos] = hi_d[pos].max(rd);
                    lo_a[pos] = lo_a[pos].min(ra);
                    hi_a[pos] = hi_a[pos].max(ra);
                }
                if !windows.is_empty() {
                    freq.insert(rt.trip_idx, windows);
                }
            }
            // Uniform: every trip serves the same positions with the same
            // pickup/drop-off flags.
            if let Some(t0) = route.trips.first() {
                'outer: for rt in &route.trips[1..] {
                    for pos in 0..n {
                        let s0 = t0.pos_to_row.get(pos).copied().unwrap_or(-1) != -1;
                        let s1 = rt.pos_to_row.get(pos).copied().unwrap_or(-1) != -1;
                        if s0 != s1 {
                            uniform = false;
                            break 'outer;
                        }
                        if s0
                            && (crate::engine::scan::pickup_forbidden_at(reader, t0, pos)
                                != crate::engine::scan::pickup_forbidden_at(reader, rt, pos)
                                || crate::engine::scan::drop_off_forbidden_at(reader, t0, pos)
                                    != crate::engine::scan::drop_off_forbidden_at(reader, rt, pos))
                        {
                            uniform = false;
                            break 'outer;
                        }
                    }
                }
            }
            let spread = spread_of(&lo_d, &hi_d, &lo_a, &hi_a);
            route_shape.push((uniform, spread));
            if uniform {
                group_spread.push(alloc::vec![spread]);
            } else {
                group_spread.push(shape_groups(
                    reader,
                    route,
                    ri as u32,
                    &trips,
                    &first_dep,
                    &mut trip_group,
                )?);
            }
        }
        if min_event > max_event {
            min_event = 0;
            max_event = 0;
        }

        let is_freq: Vec<bool> = trips.iter().map(|t| t.is_frequency).collect();
        let (stop_positions, position_base, num_positions) = stop_positions(index);
        let rules = RuleIndex::build(reader, &is_freq)?;

        let mut v2 = V2Index {
            trips,
            first_dep,
            freq,
            rules,
            derived: FxHashMap::default(),
            derived_commitment: BlockDerivationCommitment::EMPTY,
            instance_level: alloc::vec![false; num_trips],
            min_event_secs: min_event,
            max_event_secs: max_event,
            route_shape,
            trip_group,
            group_spread,
            stop_positions,
            position_base,
            num_positions,
        };
        if reader.derive_block_inseat() {
            v2.build_derived(reader, index)?;
        }
        // Verify the bundle's commitment before any query can route.
        let committed = reader
            .block_derivation_commitment()
            .ok_or(EngineError::UnsupportedVersion)?;
        if verify && committed != v2.derived_commitment {
            return Err(EngineError::IndexBundleMismatch);
        }
        // One pass over the linked rows (a per-trip rescan is quadratic in
        // the 0xF8 row count, which a bundle controls).
        let mut paired = alloc::vec![false; num_trips];
        for l in &v2.rules.linked {
            if l.pairing_available {
                if let Some(p) = paired.get_mut(l.from_trip as usize) {
                    *p = true;
                }
            }
        }
        for (t, &p) in paired.iter().enumerate() {
            let ti = v2.trips[t];
            if p && ti.route != NONE && !ti.is_frequency {
                v2.instance_level[t] = true;
            }
        }
        for &(src, _) in v2.derived.keys() {
            v2.instance_level[src as usize] = true;
        }
        Ok(v2)
    }

    /// Date-gated inferred in-seat continuity from source-scoped `block_id`s.
    /// For each routable date: group active scheduled trips by block, sort by
    /// (first departure, trip ordinal), and link consecutive trips whose
    /// terminal stop equals the next trip's initial stop, without overlap and
    /// with a layover of at most [`DERIVED_MAX_LAYOVER_SECS`]. Pairs touching a
    /// frequency template are skipped; a retained explicit row constraining the
    /// exact trip pair at the same boundary suppresses the pair.
    fn build_derived<B: AsRef<[u8]> + Send + Sync + 'static>(
        &mut self,
        reader: &Reader<B>,
        index: &Index,
    ) -> Result<(), EngineError> {
        // Per block: (first_dep, trip, last_arr, first_stop, last_stop, service, freq).
        type Member = (i64, u32, i64, u32, u32, u32, bool);
        let mut blocks: FxHashMap<u32, Vec<Member>> = FxHashMap::default();
        for t in 0..self.trips.len() {
            let ti = self.trips[t];
            if ti.route == NONE {
                continue;
            }
            let b = match reader.trip_block_idx(t) {
                Some(b) if b != u32::MAX => b,
                _ => continue,
            };
            let route = &index.routes[ti.route as usize];
            let rt = &route.trips[ti.slot as usize];
            let fd = dep_secs_at(reader, rt, ti.first_pos as usize)?;
            let la = alight_secs_at(reader, rt, ti.last_pos as usize)?;
            blocks.entry(b).or_default().push((
                fd,
                t as u32,
                la,
                route.stop_ids[ti.first_pos as usize],
                route.stop_ids[ti.last_pos as usize],
                rt.service_idx,
                ti.is_frequency,
            ));
        }
        let mut keys: Vec<u32> = blocks.keys().copied().collect();
        keys.sort_unstable();
        let days = reader.num_service_day_origins().saturating_sub(1);
        // Day `d` is `feed_start_date + d`, so `service_active_on(s, that date)`
        // is the bitmask bit at offset `d` inside the window. Testing the
        // offset directly skips a calendar round trip per member and day.
        let window = u32::from(reader.window_days());
        let masks: Vec<&[u8]> = (0..reader.num_services())
            .map(|s| reader.service_bitmask(s))
            .collect();
        let active_on = |service: u32, day: u32| {
            day < window
                && masks
                    .get(service as usize)
                    .is_some_and(|m| crate::reader::service_active_bit(m, day))
        };
        let mut tuples: Vec<(u32, u32, u32)> = Vec::new();
        let mut active: Vec<Member> = Vec::new();
        for k in &keys {
            // Sorted once: each day's active members are a subsequence, so they
            // stay in (first departure, trip) order, a key unique per trip.
            let members = blocks.get_mut(k).expect("block key");
            members.sort_unstable_by_key(|m| (m.0, m.1));
            let members = &*members;
            for d in 0..days {
                active.clear();
                active.extend(members.iter().copied().filter(|m| active_on(m.5, d as u32)));
                if active.len() < 2 {
                    continue;
                }
                for w in active.windows(2) {
                    let (a, b) = (w[0], w[1]);
                    if a.6 || b.6 {
                        continue; // frequency template: no concrete pairing
                    }
                    if a.4 != b.3 {
                        continue;
                    }
                    let layover = b.0 - a.2;
                    if !(0..=DERIVED_MAX_LAYOVER_SECS).contains(&layover) {
                        continue;
                    }
                    if self.rules.pair_has_explicit_row_at(a.1, b.1, a.4, b.3) {
                        continue;
                    }
                    tuples.push((a.1, d as u32, b.1));
                }
            }
        }
        tuples.sort_unstable();
        tuples.dedup();
        self.derived_commitment = commitment_of(&tuples);
        // Sorted tuples: one key per run of equal (source, date).
        let keys = 1 + tuples
            .windows(2)
            .filter(|w| (w[0].0, w[0].1) != (w[1].0, w[1].1))
            .count();
        self.derived
            .reserve(if tuples.is_empty() { 0 } else { keys });
        for (s, d, t) in tuples {
            self.derived.entry((s, d)).or_default().push(t);
        }
        Ok(())
    }
}

/// Recompute the `0x19 BlockDerivationCommitment` a v2 bundle must carry,
/// through the same index builder routing uses but without comparing against
/// the bundle's current value. The producer writes this value into the staged
/// bundle and records it in generation metadata; `Index::build` then rejects
/// any later mismatch.
pub fn recompute_block_commitment<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    mode: crate::engine::patterns::PatternMode,
) -> Result<BlockDerivationCommitment, EngineError> {
    let index = Index::build_with(reader, mode, false)?;
    Ok(index
        .v2
        .as_ref()
        .ok_or(EngineError::UnsupportedVersion)?
        .derived_commitment)
}

/// `0x19` commitment of sorted `(source_trip, date_ordinal, target_trip)`
/// tuples: SHA-256 over their little-endian `u32` concatenation.
pub fn commitment_of(tuples: &[(u32, u32, u32)]) -> BlockDerivationCommitment {
    let mut h = Sha256::new();
    for &(s, d, t) in tuples {
        h.update(s.to_le_bytes());
        h.update(d.to_le_bytes());
        h.update(t.to_le_bytes());
    }
    BlockDerivationCommitment {
        algorithm_version: crate::v2::COMMITMENT_ALGORITHM_V1,
        pair_date_count: tuples.len() as u64,
        tuples_sha256: h.finalize().into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_tuples_commit_to_the_canonical_empty_value() {
        assert_eq!(commitment_of(&[]), BlockDerivationCommitment::EMPTY);
    }
}
