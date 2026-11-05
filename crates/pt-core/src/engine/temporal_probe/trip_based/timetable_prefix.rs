//! A timetable-compatible, optimistic latest-origin profile, not a legal route.
//! One frozen row per allowed prefix ride; one directed PTFT movement per ride.
//! Concrete occurrence order prevents boarding and alighting at the same event.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
//! https://gtfs.org/documentation/schedule/reference/#transferstxt
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes

use super::deadline::same_vehicle;
use super::*;
use crate::engine::temporal_probe::v2::{physical_walks, synthetic_destinations};
use alloc::boxed::Box;
use alloc::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TimetablePrefixDiagnostics {
    pub enabled: bool,
    pub event_scans: usize,
    pub walking_proposals: usize,
    pub profile_checks: usize,
    pub retained_labels: usize,
    /// Owned persistent storage, not transient builder storage, allocator overhead or RSS.
    pub index_bytes: usize,
}

impl TimetablePrefixDiagnostics {
    /// All added event, movement and profile-normalization checks. Sorting's
    /// internal comparisons are not separate work units, like catalogue sort.
    pub fn work(&self) -> usize {
        self.event_scans + self.walking_proposals + self.profile_checks
    }
}

type Label = (i64, i64); // (ready time, origin departure)
type Row = Box<[Box<[Label]>]>;

// Freeze only after all existing normalization checks. This preserves every
// retained label and releases proposal capacity before building the next row.
// Vec::into_boxed_slice discards excess capacity; allocator overhead/build peak
// remain outside the persistent-payload diagnostic.
fn freeze_profiles(profiles: Vec<Vec<Label>>) -> Row {
    profiles.into_iter().map(Vec::into_boxed_slice).collect()
}

pub(super) struct TimetablePrefix {
    access: Vec<i64>,
    window: Range<i64>,
    rows: Vec<Row>,
}

impl TimetablePrefix {
    // Induction: every legal prefix with <= r rides is dominated by direct
    // access or one stored label. Ignore rule scopes and the origin horizon,
    // and use the smallest non-forbidden ordinary floor: these only add paths.
    // Carry the maximum compatible origin from *earlier* boardings along each
    // concrete vehicle. Freeze row r-1, so one pass cannot spend two rides.
    // Each legal movement has an optimistic directed movement in the superset.
    // Keeping only no-later / no-earlier labels preserves that projection.
    // Explicit linked rules are excluded by the existing prefix guard. A
    // derived block continuation leaves its terminal at the same stop with a
    // nonnegative layover and spends a round: one zero-floor label there.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        index: &Index,
        catalogue: &EventIndex,
        request: &DeadlineRequest<'_>,
        access: &[i64],
        floor: i64,
        walks: &mut BTreeMap<u32, Vec<(u32, i64)>>,
        before: usize,
        diagnostics: &mut PrefixDiagnostics,
    ) -> Result<Self, DeadlineError> {
        let rounds = request
            .query
            .max_rounds
            .unwrap_or(crate::engine::consts::RAPTOR_MAX_ROUNDS);
        let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
        let rules = &v2.rules;
        let derived = !v2.derived.is_empty();
        let mut result = Self {
            access: access.to_vec(),
            window: request.window.clone(),
            rows: Vec::with_capacity(rounds as usize),
        };
        result
            .rows
            .push(freeze_profiles(alloc::vec![Vec::new(); reader.num_stops()]));
        diagnostics.timetable.enabled = true;
        for r in 1..rounds as usize {
            // Same retained labels as the former Vec clone: at most r rides.
            let mut next: Vec<Vec<Label>> = result.rows[r - 1]
                .iter()
                .map(|profile| profile.to_vec())
                .collect();
            let mut onboard: Option<i64> = None;
            for (i, &event) in catalogue.events().iter().enumerate() {
                diagnostics.charge(before, request.max_stop_scans)?;
                diagnostics.timetable.event_scans += 1;
                if i == 0 || !same_vehicle(catalogue.events()[i - 1], event) {
                    onboard = None;
                }
                let stop = index.routes[event.route_idx as usize].stop_ids[event.position as usize];
                if let Some(origin) = onboard.filter(|_| event.is_source()) {
                    if let alloc::collections::btree_map::Entry::Vacant(entry) = walks.entry(stop) {
                        let mut rows =
                            physical_walks(reader, request.query, request.transfers, stop)?;
                        rows.push((stop, 0));
                        rows.extend(
                            synthetic_destinations(rules, stop, None)
                                .into_iter()
                                .map(|to| (to, 0)),
                        );
                        rows.sort_unstable();
                        rows.dedup_by_key(|row| row.0);
                        entry.insert(rows);
                    }
                    for &(to, walk) in &walks[&stop] {
                        diagnostics.charge(before, request.max_stop_scans)?;
                        diagnostics.timetable.walking_proposals += 1;
                        let ready = event
                            .arrival_secs
                            .checked_add(floor.max(walk))
                            .ok_or(EngineError::TimeOverflow)?;
                        next[to as usize].push((ready, origin));
                    }
                    if derived && super::prefix::continues_in_seat(v2, event) {
                        diagnostics.charge(before, request.max_stop_scans)?;
                        diagnostics.timetable.walking_proposals += 1;
                        next[stop as usize].push((event.arrival_secs, origin));
                    }
                }
                if event.flags & TARGET != 0 {
                    if let Some(origin) =
                        result.latest_origin((r - 1) as u32, stop, event.departure_secs)?
                    {
                        onboard = Some(onboard.map_or(origin, |at| at.max(origin)));
                    }
                }
            }
            for (stop, profile) in next.iter_mut().enumerate() {
                profile.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(&a.1)));
                let mut best: Option<i64> = None;
                let mut retained = 0;
                for i in 0..profile.len() {
                    diagnostics.charge(before, request.max_stop_scans)?;
                    diagnostics.timetable.profile_checks += 1;
                    let (ready, origin) = profile[i];
                    if best.is_some_and(|at| at >= origin)
                        || result
                            .direct(stop as u32, ready)?
                            .is_some_and(|at| at >= origin)
                    {
                        continue;
                    }
                    profile[retained] = (ready, origin);
                    retained += 1;
                    best = Some(origin);
                }
                profile.truncate(retained);
            }
            result.rows.push(freeze_profiles(next));
        }
        diagnostics.timetable.retained_labels = result
            .rows
            .iter()
            .flat_map(|row| row.iter())
            .map(|profile| profile.len())
            .sum();
        diagnostics.timetable.index_bytes = result.access.capacity() * size_of::<i64>()
            + result.rows.capacity() * size_of::<Row>()
            + result
                .rows
                .iter()
                .map(|row| {
                    row.len() * size_of::<Box<[Label]>>()
                        + row
                            .iter()
                            .map(|p| p.len() * size_of::<Label>())
                            .sum::<usize>()
                })
                .sum::<usize>();
        Ok(result)
    }

    fn direct(&self, stop: u32, ready: i64) -> Result<Option<i64>, EngineError> {
        let walk = self.access[stop as usize];
        if walk == i64::MAX {
            return Ok(None);
        }
        let origin = ready
            .checked_sub(walk)
            .ok_or(EngineError::TimeOverflow)?
            .min(self.window.end - 1);
        Ok((origin >= self.window.start).then_some(origin))
    }

    pub(super) fn latest_origin(
        &self,
        rides: u32,
        stop: u32,
        ready: i64,
    ) -> Result<Option<i64>, EngineError> {
        let direct = self.direct(stop, ready)?;
        let profile = &self.rows[rides as usize][stop as usize];
        let until = profile.partition_point(|&(at, _)| at <= ready);
        let transit = until.checked_sub(1).map(|i| profile[i].1);
        Ok(direct.into_iter().chain(transit).max())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timetable_frozen_profiles_preserve_contents_and_every_lookup() {
        let mut loose: Vec<Vec<Label>> = (0..5).map(|_| Vec::with_capacity(8192)).collect();
        loose[1].extend([(100, 50), (120, 70), (120, 90), (170, 100)]);
        loose[3].extend([(-100, -200), (0, -150), (i64::MAX, 100)]);
        let expected: Vec<Vec<Label>> = loose.iter().map(|p| p.to_vec()).collect();
        assert!(loose.iter().all(|p| p.capacity() > p.len()));
        let frozen = freeze_profiles(loose);
        assert_eq!(frozen.len(), expected.len());
        assert_eq!(
            size_of_val(&*frozen),
            expected.len() * size_of::<Box<[Label]>>()
        );
        for (old, new) in expected.iter().zip(frozen.iter()) {
            assert_eq!(old.as_slice(), &**new);
            assert_eq!(size_of_val(&**new), old.len() * size_of::<Label>());
            // A thaw has exactly the old normalized labels, not proposal spare capacity.
            assert_eq!(new.to_vec(), *old);
            for ready in (-205..=205).chain([i64::MIN, i64::MAX]) {
                let lookup = |p: &[Label]| {
                    p.partition_point(|&(at, _)| at <= ready)
                        .checked_sub(1)
                        .map(|i| p[i].1)
                };
                assert_eq!(lookup(old), lookup(new));
            }
        }
    }
}
