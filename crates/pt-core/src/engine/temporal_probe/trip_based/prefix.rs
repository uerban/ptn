//! Optimistic boarding-ready times for ordinary-transfer reverse-query pruning.
//! Every pass reads a frozen previous row; walking is one directed PTFT
//! movement after a ride, not recursive pedestrian routing.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
//! https://gtfs.org/documentation/schedule/reference/#frequenciestxt

use super::deadline::same_vehicle;
use super::timetable_prefix::TimetablePrefix;
use super::*;
use crate::engine::temporal_probe::v2::{physical_walks, synthetic_destinations};
use crate::engine::v2::rules::ordinary_floor;
use alloc::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PrefixDiagnostics {
    pub enabled: bool,
    pub event_scans: usize,
    pub walking_relaxations: usize,
    pub index_bytes: usize,
    pub pruned_boardings: usize,
    pub pruned_source_rows: usize,
    pub point_pruned_boardings: usize,
    pub walking_enabled: bool,
    pub walking_bytes: usize,
    pub walking_pruned_boardings: usize,
    pub transfer_bound_enabled: bool,
    pub transfer_bound_bytes: usize,
    /// Additional setup; included in the original aggregate stop-work cap.
    pub timetable: TimetablePrefixDiagnostics,
}

impl PrefixDiagnostics {
    pub(super) fn work(&self) -> usize {
        self.event_scans + self.walking_relaxations + self.timetable.work()
    }
    pub(super) fn charge(&self, before: usize, limit: usize) -> Result<(), DeadlineError> {
        let attempted = self
            .work()
            .checked_add(before)
            .and_then(|n| n.checked_add(1))
            .ok_or(EngineError::TimeOverflow)?;
        if attempted > limit {
            return Err(DeadlineError::StopScansExhausted { limit, attempted });
        }
        Ok(())
    }
}

pub(super) struct PrefixBound {
    /// False when derived block continuations exist: a prefix round may then
    /// be an in-seat continuation that spends no passenger transfer.
    transfer_credit: bool,
    transfers: Option<Vec<Vec<u32>>>,
    ready: Vec<Vec<i64>>,
    alight: Vec<Vec<i64>>,
    duration: Option<Vec<Vec<i64>>>,
    walking: Option<Vec<Vec<i64>>>,
    timetable: Option<TimetablePrefix>,
}

// No public cache token or interior mutability. The owned session retains this
// only beside the exact immutable query/config/catalogue that constructed it.
// A failed build retains its error, never a partial bound or diagnostics.
pub(super) struct CachedPrefix(Result<(Option<PrefixBound>, PrefixDiagnostics), DeadlineError>);

pub(super) enum PrefixStorage<'a> {
    Fresh(PrefixBound),
    Prepared(&'a PrefixBound),
}

impl core::ops::Deref for PrefixStorage<'_> {
    type Target = PrefixBound;
    fn deref(&self) -> &Self::Target {
        match self {
            Self::Fresh(p) => p,
            Self::Prepared(p) => p,
        }
    }
}

impl CachedPrefix {
    pub(super) fn build(
        reader: &Reader<Vec<u8>>,
        index: &Index,
        catalogue: &EventIndex,
        request: &DeadlineRequest<'_>,
    ) -> Self {
        Self(
            super::deadline::entry_walks(reader, request).and_then(|entries| {
                // The session rejects static bounds and sampling, so
                // the unchanged optimistic builder's preceding charge is zero.
                PrefixBound::build(reader, index, catalogue, request, &entries, 0)
            }),
        )
    }

    pub(super) fn borrow(
        &self,
    ) -> Result<(Option<PrefixStorage<'_>>, PrefixDiagnostics), DeadlineError> {
        match &self.0 {
            Ok((prefix, diagnostics)) => {
                Ok((prefix.as_ref().map(PrefixStorage::Prepared), *diagnostics))
            }
            Err(error) => Err(error.clone()),
        }
    }

    #[cfg(test)]
    pub(super) fn diagnostics(&self) -> Option<PrefixDiagnostics> {
        self.0.as_ref().ok().map(|(_, d)| *d)
    }
}

impl PrefixBound {
    // Induction: ready[r][s] is no later than every legal boarding-ready time
    // at s using <= r prefix rides. Ignoring flags, identity, the window's upper
    // end and the origin horizon only adds possibilities. Thus a suffix of k
    // rides cannot start at (s,t) if ready[R-k][s] > t. No feasible prefix,
    // objective point or canonical witness is removed by this certificate.
    // Ordinary rules are relaxed using their smallest non-forbidden floor and
    // zero-duration synthetic candidates, ignoring scopes. Each real movement
    // remains present and no slower. Explicit linked rules are not covered:
    // they may join different stops without spending a passenger transfer.
    // Derived block continuations are: `Index::build_derived` links a trip's
    // terminal arrival to a same-date trip's first stop_time at the same stop,
    // with a nonnegative layover, and the exact search spends one round on
    // every edge, derived or not. Relaxing that arrival to the same stop with
    // a zero floor keeps every row a lower bound. Because the round spends no
    // passenger transfer, rides then give no transfer credit (see
    // `minimum_transfers`).
    pub(super) fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        index: &Index,
        catalogue: &EventIndex,
        request: &DeadlineRequest<'_>,
        entries: &BTreeMap<u32, Vec<u32>>,
        before: usize,
    ) -> Result<(Option<Self>, PrefixDiagnostics), DeadlineError> {
        let rounds = request
            .query
            .max_rounds
            .unwrap_or(crate::engine::consts::RAPTOR_MAX_ROUNDS);
        let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
        if request.pruning == DeadlinePruning::None
            || rounds == 0
            || rounds > 64
            || !v2.rules.linked.is_empty()
        {
            return Ok((None, PrefixDiagnostics::default()));
        }
        let derived = !v2.derived.is_empty();
        let mut diagnostics = PrefixDiagnostics {
            enabled: true,
            ..PrefixDiagnostics::default()
        };
        let mut access = alloc::vec![i64::MAX; reader.num_stops()];
        for (&stop, values) in entries {
            for &walk in values {
                let at = request
                    .window
                    .start
                    .checked_add(walk as i64)
                    .ok_or(EngineError::TimeOverflow)?;
                access[stop as usize] = access[stop as usize].min(at);
            }
        }
        let mut ready = Vec::with_capacity(rounds as usize);
        let mut duration = matches!(
            request.pruning,
            DeadlinePruning::EarliestPrefixAndPoints
                | DeadlinePruning::EarliestPrefixAndTimetablePoints
        )
        .then(|| {
            let mut rows = Vec::with_capacity(rounds as usize);
            let mut row = alloc::vec![i64::MAX; reader.num_stops()];
            for (&stop, values) in entries {
                row[stop as usize] = values.iter().copied().min().unwrap() as i64;
            }
            rows.push(row);
            rows
        });
        // W[r][s] <= every legal prefix's walking with <= r rides. Frozen
        // previous rows prevent using multiple rides in one pass. Onboard
        // minima survive all later served occurrences of this vehicle, so a
        // loop or a long ride consumes one boarding, not one per stop edge.
        // Time compatibility is relaxed; transfer floors are not walking.
        let mut walking = (request.walking_bound
            && request.objectives == super::super::r3::ProfileObjectives::M4)
            .then(|| {
                let mut rows = Vec::with_capacity(rounds as usize);
                rows.push(duration.as_ref().expect("point pruning required")[0].clone());
                rows
            });
        diagnostics.walking_enabled = walking.is_some();
        // H79: time/permission-relaxed passenger transfer minima. Ordinary
        // movements spend one; an existing derived terminal may stay for zero.
        // Relaxing target identity only adds paths. Explicit linked rules were
        // excluded above. Freeze each previous row: at most one ride per pass.
        let mut transfer_rows = (request.transfer_bound && derived).then(|| {
            let mut row = alloc::vec![u32::MAX; reader.num_stops()];
            for &stop in entries.keys() {
                row[stop as usize] = 0;
            }
            let mut rows = Vec::with_capacity(rounds as usize);
            rows.push(row);
            rows
        });
        diagnostics.transfer_bound_enabled = transfer_rows.is_some();
        ready.push(access);
        let mut alight = Vec::with_capacity(rounds as usize);
        alight.push(alloc::vec![i64::MAX; reader.num_stops()]);
        let base = request.query.min_transfer_floor_secs();
        let floor = v2
            .rules
            .ordinary
            .iter()
            .filter_map(|rule| ordinary_floor(Some(rule), base))
            .fold(
                ordinary_floor(None, base).expect("default transfer floor"),
                i64::min,
            );
        let mut walks: BTreeMap<u32, Vec<(u32, i64)>> = BTreeMap::new();
        for r in 1..rounds as usize {
            let mut arrival = alight[r - 1].clone();
            let mut arrival_duration = duration
                .as_ref()
                .map(|_| alloc::vec![i64::MAX; reader.num_stops()]);
            let mut onboard = false;
            let mut onboard_offset: Option<i64> = None;
            let mut arrival_walking = walking
                .as_ref()
                .map(|_| alloc::vec![i64::MAX; reader.num_stops()]);
            let mut onboard_walk: Option<i64> = None;
            let mut onboard_transfers: Option<u32> = None;
            let mut arrival_transfers = transfer_rows
                .as_ref()
                .map(|_| alloc::vec![u32::MAX; reader.num_stops()]);
            let mut continuation_transfers: BTreeMap<u32, u32> = BTreeMap::new();
            // Derived-source terminal arrivals, (time, elapsed), per stop.
            let mut continuation: BTreeMap<u32, (i64, i64)> = BTreeMap::new();
            for (i, &event) in catalogue.events().iter().enumerate() {
                diagnostics.charge(before, request.max_stop_scans)?;
                diagnostics.event_scans += 1;
                if i == 0 || !same_vehicle(catalogue.events()[i - 1], event) {
                    onboard = false;
                    onboard_offset = None;
                    onboard_walk = None;
                    onboard_transfers = None;
                }
                let stop = index.routes[event.route_idx as usize].stop_ids[event.position as usize];
                // An arrival at this occurrence must follow an earlier boarding,
                // not boarding at its own departure after its arrival/dwell.
                let continues = derived && event.is_source() && continues_in_seat(v2, event);
                // One charged event visit updates every independent cost
                // coordinate. Arrival precedes boarding at this occurrence.
                if event.is_source() {
                    if onboard {
                        arrival[stop as usize] = arrival[stop as usize].min(event.arrival_secs);
                        if continues {
                            let entry = continuation.entry(stop).or_insert((i64::MAX, i64::MAX));
                            entry.0 = entry.0.min(event.arrival_secs);
                        }
                    }
                    if let Some(cost) = onboard_transfers {
                        let arrivals = arrival_transfers.as_mut().unwrap();
                        arrivals[stop as usize] = arrivals[stop as usize].min(cost);
                        if continues {
                            // Share the existing charged derived movement
                            // traversal, including a transfer-only relaxed row.
                            continuation.entry(stop).or_insert((i64::MAX, i64::MAX));
                            let entry = continuation_transfers.entry(stop).or_insert(u32::MAX);
                            *entry = (*entry).min(cost);
                        }
                    }
                    if let (Some(walk), Some(arrivals)) = (onboard_walk, arrival_walking.as_mut()) {
                        arrivals[stop as usize] = arrivals[stop as usize].min(walk);
                    }
                    if let (Some(offset), Some(arrivals)) =
                        (onboard_offset, arrival_duration.as_mut())
                    {
                        let elapsed = event
                            .arrival_secs
                            .checked_add(offset)
                            .ok_or(EngineError::TimeOverflow)?;
                        arrivals[stop as usize] = arrivals[stop as usize].min(elapsed);
                        if continues {
                            let entry = continuation.entry(stop).or_insert((i64::MAX, i64::MAX));
                            entry.1 = entry.1.min(elapsed);
                        }
                    }
                }
                if event.flags & TARGET != 0 {
                    if ready[r - 1][stop as usize] <= event.departure_secs {
                        onboard = true;
                    }
                    if let Some(rows) = &transfer_rows {
                        let cost = rows[r - 1][stop as usize];
                        if cost != u32::MAX {
                            onboard_transfers =
                                Some(onboard_transfers.map_or(cost, |v| v.min(cost)));
                        }
                    }
                    if let Some(rows) = &walking {
                        let before = rows[r - 1][stop as usize];
                        if before != i64::MAX {
                            onboard_walk = Some(onboard_walk.map_or(before, |v| v.min(before)));
                        }
                    }
                    if let Some(rows) = &duration {
                        let before = rows[r - 1][stop as usize];
                        if before != i64::MAX {
                            let offset = before
                                .checked_sub(event.departure_secs)
                                .ok_or(EngineError::TimeOverflow)?;
                            onboard_offset = Some(onboard_offset.map_or(offset, |v| v.min(offset)));
                        }
                    }
                }
            }
            let mut next = ready[r - 1].clone(); // At most r, not exactly r rides.
            let mut next_duration = duration.as_ref().map(|rows| rows[r - 1].clone());
            let mut next_walking = walking.as_ref().map(|rows| rows[r - 1].clone());
            let mut next_transfers = transfer_rows.as_ref().map(|rows| rows[r - 1].clone());
            for (from, &at) in arrival.iter().enumerate() {
                let elapsed = arrival_duration
                    .as_ref()
                    .map_or(i64::MAX, |rows| rows[from]);
                let walked = arrival_walking.as_ref().map_or(i64::MAX, |rows| rows[from]);
                let changed_transfers = arrival_transfers
                    .as_ref()
                    .map_or(u32::MAX, |rows| rows[from]);
                if at == i64::MAX
                    && elapsed == i64::MAX
                    && walked == i64::MAX
                    && changed_transfers == u32::MAX
                {
                    continue;
                }
                let from = from as u32;
                if let alloc::collections::btree_map::Entry::Vacant(entry) = walks.entry(from) {
                    let mut rows = physical_walks(reader, request.query, request.transfers, from)?;
                    rows.push((from, 0));
                    // A candidate is not permission to transfer. The exact
                    // query still resolves the selected rule and physical-walk
                    // precedence; this prepass only needs an optimistic superset.
                    rows.extend(
                        synthetic_destinations(&v2.rules, from, None)
                            .into_iter()
                            .map(|to| (to, 0)),
                    );
                    rows.sort_unstable();
                    rows.dedup_by_key(|row| row.0);
                    entry.insert(rows);
                }
                for &(to, walk) in &walks[&from] {
                    diagnostics.charge(before, request.max_stop_scans)?;
                    diagnostics.walking_relaxations += 1;
                    // The same fetched movement updates all coordinates;
                    // it is charged once above, as for time/duration/walking.
                    if let Some(rows) = next_transfers.as_mut() {
                        if changed_transfers != u32::MAX {
                            let cost = changed_transfers
                                .checked_add(1)
                                .ok_or(EngineError::TimeOverflow)?;
                            rows[to as usize] = rows[to as usize].min(cost);
                        }
                    }
                    if at != i64::MAX {
                        let at = at
                            .checked_add(floor.max(walk))
                            .ok_or(EngineError::TimeOverflow)?;
                        next[to as usize] = next[to as usize].min(at);
                    }
                    if elapsed != i64::MAX {
                        let elapsed = elapsed
                            .checked_add(floor.max(walk))
                            .ok_or(EngineError::TimeOverflow)?;
                        let rows = next_duration.as_mut().expect("duration bound enabled");
                        rows[to as usize] = rows[to as usize].min(elapsed);
                    }
                    if walked != i64::MAX {
                        let cost = walked.checked_add(walk).ok_or(EngineError::TimeOverflow)?;
                        let rows = next_walking.as_mut().expect("walking bound enabled");
                        rows[to as usize] = rows[to as usize].min(cost);
                    }
                }
            }
            // Zero-floor in-seat stay at the shared stop. Walking rows already
            // relax each arrival to its own stop at zero cost.
            for (&stop, &(at, elapsed)) in &continuation {
                diagnostics.charge(before, request.max_stop_scans)?;
                diagnostics.walking_relaxations += 1;
                next[stop as usize] = next[stop as usize].min(at);
                if elapsed != i64::MAX {
                    let rows = next_duration.as_mut().expect("duration bound enabled");
                    rows[stop as usize] = rows[stop as usize].min(elapsed);
                }
                if let (Some(rows), Some(&cost)) =
                    (next_transfers.as_mut(), continuation_transfers.get(&stop))
                {
                    rows[stop as usize] = rows[stop as usize].min(cost);
                }
            }
            if let Some(rows) = transfer_rows.as_mut() {
                rows.push(next_transfers.unwrap());
            }
            ready.push(next);
            alight.push(arrival);
            if let Some(rows) = &mut duration {
                rows.push(next_duration.unwrap());
            }
            if let Some(rows) = &mut walking {
                rows.push(next_walking.unwrap());
            }
        }
        let timetable = if request.pruning == DeadlinePruning::EarliestPrefixAndTimetablePoints {
            Some(TimetablePrefix::build(
                reader,
                index,
                catalogue,
                request,
                &duration.as_ref().expect("point pruning enabled")[0],
                floor,
                &mut walks,
                before,
                &mut diagnostics,
            )?)
        } else {
            None
        };
        diagnostics.walking_bytes = walking.as_ref().map_or(0, |rows| {
            core::mem::size_of_val(rows.as_slice())
                + rows
                    .iter()
                    .map(|r| core::mem::size_of_val(r.as_slice()))
                    .sum::<usize>()
        });
        diagnostics.transfer_bound_bytes = transfer_rows.as_ref().map_or(0, |rows| {
            core::mem::size_of_val(rows.as_slice())
                + rows
                    .iter()
                    .map(|r| core::mem::size_of_val(r.as_slice()))
                    .sum::<usize>()
        });
        diagnostics.index_bytes = core::mem::size_of_val(ready.as_slice())
            + ready
                .iter()
                .map(|r| core::mem::size_of_val(r.as_slice()))
                .sum::<usize>()
            + core::mem::size_of_val(alight.as_slice())
            + alight
                .iter()
                .map(|r| core::mem::size_of_val(r.as_slice()))
                .sum::<usize>()
            + duration.as_ref().map_or(0, |rows| {
                core::mem::size_of_val(rows.as_slice())
                    + rows
                        .iter()
                        .map(|r| core::mem::size_of_val(r.as_slice()))
                        .sum::<usize>()
            })
            + diagnostics.transfer_bound_bytes
            + diagnostics.walking_bytes
            + diagnostics.timetable.index_bytes;
        Ok((
            Some(Self {
                transfer_credit: !derived,
                transfers: transfer_rows,
                ready,
                alight,
                duration,
                walking,
                timetable,
            }),
            diagnostics,
        ))
    }

    pub(super) fn allows(&self, preceding_rides: u32, stop: u32, departure: i64) -> bool {
        self.ready[preceding_rides as usize][stop as usize] <= departure
    }

    /// Lower bounds on physical alighting times using <= r prefix rides.
    /// Immutable during lookup; no real prefix can arrive before these times.
    pub(super) fn earliest_alight(&self, preceding_rides: u32) -> &[i64] {
        &self.alight[preceding_rides as usize]
    }

    pub(super) fn latest_origin(
        &self,
        preceding_rides: u32,
        stop: u32,
        departure: i64,
    ) -> Result<Option<i64>, EngineError> {
        let Some(rows) = &self.duration else {
            return Ok(None);
        };
        let elapsed = rows[preceding_rides as usize][stop as usize];
        if elapsed == i64::MAX {
            return Ok(None);
        }
        let duration_upper = departure
            .checked_sub(elapsed)
            .ok_or(EngineError::TimeOverflow)?;
        let timetable_upper = self
            .timetable
            .as_ref()
            .map(|p| p.latest_origin(preceding_rides, stop, departure))
            .transpose()?
            .flatten();
        // Each is independently optimistic. None does not grant permission to
        // prune; ordinary earliest-ready pruning handles unreachable prefixes.
        Ok(Some(
            timetable_upper.map_or(duration_upper, |at| at.min(duration_upper)),
        ))
    }

    fn minimum_rides(&self, preceding_rides: u32, stop: u32, departure: i64) -> u32 {
        (0..=preceding_rides)
            .find(|&r| self.allows(r, stop, departure))
            .expect("reachability checked")
    }

    /// Lower bound on the passenger transfers a prefix adds before boarding
    /// here. Each prefix ride ends in a transfer unless a derived block
    /// continuation may follow it in-seat. H79 optionally supplies the
    /// independently optimistic, time-relaxed transfer row for that case.
    pub(super) fn minimum_transfers(&self, preceding_rides: u32, stop: u32, departure: i64) -> u32 {
        if self.transfer_credit {
            self.minimum_rides(preceding_rides, stop, departure)
        } else {
            self.transfers
                .as_ref()
                .and_then(|rows| {
                    let cost = rows[preceding_rides as usize][stop as usize];
                    (cost != u32::MAX).then_some(cost)
                })
                .unwrap_or(0)
        }
    }

    pub(super) fn minimum_walking(&self, preceding_rides: u32, stop: u32) -> Option<u64> {
        let rows = self.walking.as_ref()?;
        let cost = rows[preceding_rides as usize][stop as usize];
        (cost != i64::MAX).then_some(cost as u64)
    }
}

/// A source event that a derived block continuation may follow in-seat: the
/// trip's terminal stop_time on a date with a derived successor. Frequency
/// templates are never derived, so their instances never match.
pub(super) fn continues_in_seat(v2: &crate::engine::v2::V2Index, event: StopEvent) -> bool {
    v2.trips
        .get(event.trip_idx as usize)
        .is_some_and(|t| t.last_pos == event.position)
        && v2
            .derived
            .contains_key(&(event.trip_idx, event.date_ordinal))
}

#[cfg(test)]
pub(crate) fn origin_uppers_for_test<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    events: &EventIndex,
    request: &DeadlineRequest<'_>,
    probes: &[(u32, u32, i64)],
) -> (Vec<Option<i64>>, PrefixDiagnostics) {
    let mut entries: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for e in &request.query.entry_stops {
        if !inaccessible(reader, request.query, e.stop).unwrap() {
            entries.entry(e.stop).or_default().push(e.walk_secs);
        }
    }
    let (bound, diagnostics) =
        PrefixBound::build(reader, index, events, request, &entries, 0).unwrap();
    let values = probes
        .iter()
        .map(|&(rides, stop, at)| {
            bound.as_ref().and_then(|b| {
                if b.allows(rides, stop, at) {
                    b.latest_origin(rides, stop, at).unwrap()
                } else {
                    None
                }
            })
        })
        .collect();
    (values, diagnostics)
}

#[cfg(test)]
pub(crate) fn transfer_lowers_for_test<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    events: &EventIndex,
    request: &DeadlineRequest<'_>,
    probes: &[(u32, u32, i64)],
) -> Vec<Option<u32>> {
    let entries = super::deadline::entry_walks(reader, request).unwrap();
    let (bound, _) = PrefixBound::build(reader, index, events, request, &entries, 0).unwrap();
    probes
        .iter()
        .map(|&(rides, stop, departure)| {
            bound.as_ref().and_then(|b| {
                b.allows(rides, stop, departure)
                    .then(|| b.minimum_transfers(rides, stop, departure))
            })
        })
        .collect()
}
