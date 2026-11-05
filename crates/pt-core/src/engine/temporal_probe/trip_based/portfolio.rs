//! Fixed experimental selector contract, not full skyline completion or a UI
//! policy. Canonical witnesses retain every concrete GTFS occurrence:
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes

use super::{DeadlineDiagnostics, DeadlineFrontierStats};
use crate::engine::temporal_probe::r3::R3Point;
use core::{cmp::Ordering, ops::Range};

/// Independent pre-allocation ablation for checked winner queries only.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DeadlineSuffixPruning {
    #[default]
    Off,
    /// Pre-allocation only, preserving the original ablation.
    On,
    /// Pre-allocation plus private lazy candidate filtering before pair resolve.
    BeforePairs,
    /// Pre-allocation plus a charged binary cut in sorted source-arrival rows.
    /// No per-candidate certificate; unsorted fallback stays equivalent to On.
    RowPrefix,
    /// Compile the same row predicate once, then compare numeric arrivals.
    RowCeiling,
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct WinnerGoal {
    pub preference: Option<DeadlinePreference>,
    pub suffix_pruning: DeadlineSuffixPruning,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeadlinePreference {
    LatestDeparture,
    Fastest,
    LeastWalking,
    FewestTransfers,
}
impl DeadlinePreference {
    pub const ALL: [Self; 4] = [
        Self::LatestDeparture,
        Self::Fastest,
        Self::LeastWalking,
        Self::FewestTransfers,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::LatestDeparture => "latest-departure",
            Self::Fastest => "fastest",
            Self::LeastWalking => "least-walking",
            Self::FewestTransfers => "fewest-transfers",
        }
    }

    /// Pure projection; global completion requires complete M4 input or the
    /// checked single-preference search, not a partial skyline or R3 profile.
    pub fn from_m4_points(self, points: &[R3Point]) -> Option<R3Point> {
        points.iter().min_by(|a, b| compare(self, a, b)).cloned()
    }
}

type Rank = [i128; 5];
fn rank(
    preference: DeadlinePreference,
    departure: i64,
    arrival: i64,
    transfers: u32,
    walk: u64,
) -> Rank {
    let (d, a, t, w) = (
        -(departure as i128),
        arrival as i128,
        transfers as i128,
        walk as i128,
    );
    match preference {
        DeadlinePreference::LatestDeparture => [d, a, t, w, 0],
        DeadlinePreference::Fastest => [a + d, d, a, t, w],
        DeadlinePreference::LeastWalking => [w, d, a, t, 0],
        DeadlinePreference::FewestTransfers => [t, d, a, w, 0],
    }
}
fn point_rank(preference: DeadlinePreference, p: &R3Point) -> Rank {
    rank(
        preference,
        p.origin_departure_secs,
        p.destination_arrival_secs,
        p.actual_transfers,
        p.total_walk_secs,
    )
}

// Inclusive D ceiling for best < rank(D, A, T, W). Prefix coordinates before
// the first D-dependent entry can prove all/none. At its equality boundary,
// substitute *both* D-dependent entries for fastest and keep strict numeric
// comparison: a complete rank tie may still improve its canonical witness.
// Solving in i128 avoids premature saturation when D0 is outside i64.
fn selector_departure_ceiling(
    preference: DeadlinePreference,
    best: Rank,
    arrival: i64,
    transfers: u32,
    walk: u64,
) -> Option<i128> {
    let mut boundary = rank(preference, 0, arrival, transfers, walk);
    let first = match preference {
        DeadlinePreference::LatestDeparture | DeadlinePreference::Fastest => 0,
        DeadlinePreference::LeastWalking | DeadlinePreference::FewestTransfers => 1,
    };
    match best[..first].cmp(&boundary[..first]) {
        Ordering::Less => return Some(i64::MAX as i128),
        Ordering::Greater => return None,
        Ordering::Equal => {}
    }
    let departure = boundary[first] - best[first];
    boundary[first] -= departure;
    if preference == DeadlinePreference::Fastest {
        boundary[1] -= departure;
    }
    Some(departure - i128::from(best >= boundary))
}
fn compare(preference: DeadlinePreference, a: &R3Point, b: &R3Point) -> Ordering {
    point_rank(preference, a)
        .cmp(&point_rank(preference, b))
        .then_with(|| a.witness.cmp(&b.witness))
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DeadlinePortfolioWinners {
    /// Fixed order is DeadlinePreference::ALL. Duplicate journeys remain named
    /// under each selector; callers may merge them for presentation.
    pub by_preference: [Option<R3Point>; 4],
}
impl DeadlinePortfolioWinners {
    /// Pure selection. A global guarantee requires a complete M4 input (or the
    /// certified winner search), not an R3 skyline, partial page or sample.
    pub fn from_m4_points(points: &[R3Point]) -> Self {
        Self {
            by_preference: DeadlinePreference::ALL.map(|p| p.from_m4_points(points)),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DeadlinePortfolioDiagnostics {
    /// Bound tests after the unchanged ordinary point certificate did not prune.
    pub bound_checks: usize,
    pub pruned_boardings: usize,
    /// Separate from boarding checks; these do not charge a stop-event scan.
    /// Their CPU time is part of the checked query. Incoming lookup may have
    /// already enumerated the rejected edge and keeps all its work charges.
    pub suffix_bound_checks: usize,
    pub pruned_suffixes: usize,
    /// Candidates examined after a charged event probe, before pair resolution.
    /// Extra CPU is timed; these checks are not saved event probes/stop scans.
    pub predecessor_bound_checks: usize,
    pub pruned_predecessor_pairs: usize,
    /// Once per eligible sorted incoming lookup, not an event inspection.
    /// Compilation CPU is timed; every subsequent binary comparison is still
    /// a charged lazy event probe. No ceiling or filtered row is cached.
    pub row_ceiling_builds: usize,
    pub row_ceiling_selectors: usize,
    pub row_ceiling_disabled: usize,
}

#[derive(Debug)]
pub struct DeadlinePortfolioResult {
    pub winners: DeadlinePortfolioWinners,
    pub window: Range<i64>,
    pub arrival_deadline: i64,
    /// Only the four fixed selectors are complete over this supplied query.
    /// No full skyline, arrival band, fare or recovery completion is implied.
    pub complete: bool,
    pub diagnostics: DeadlineDiagnostics,
    pub frontiers: DeadlineFrontierStats,
    pub selection: DeadlinePortfolioDiagnostics,
}

#[derive(Debug)]
pub struct DeadlinePreferenceResult {
    pub preference: DeadlinePreference,
    pub winner: Option<R3Point>,
    pub window: Range<i64>,
    pub arrival_deadline: i64,
    /// Only this named selector is complete. No guarantee for other selectors,
    /// a skyline, arrival band, fare or missed-transfer recovery is implied.
    pub complete: bool,
    pub diagnostics: DeadlineDiagnostics,
    pub frontiers: DeadlineFrontierStats,
    pub selection: DeadlinePortfolioDiagnostics,
}

#[derive(Default)]
pub(super) struct PortfolioTracker {
    best: [Option<Rank>; 4],
    preference: Option<DeadlinePreference>,
    pub diagnostics: DeadlinePortfolioDiagnostics,
}
impl PortfolioTracker {
    pub fn new(preference: Option<DeadlinePreference>) -> Self {
        Self {
            preference,
            ..Self::default()
        }
    }

    pub fn observe(&mut self, point: &R3Point) {
        for (i, preference) in DeadlinePreference::ALL.into_iter().enumerate() {
            if self.preference.is_some_and(|p| p != preference) {
                continue;
            }
            let candidate = point_rank(preference, point);
            if self.best[i].is_none_or(|best| candidate < best) {
                self.best[i] = Some(candidate);
            }
        }
    }

    // All completions depart <= D, arrive >= A and spend >= T/W. Each
    // lexicographic key is monotone in those four M4 coordinates. Different
    // independently legal incumbents may beat the optimistic key for each
    // requested selector. A one-preference query does not certify the others.
    // Strict numeric rank only: equality can improve its witness.
    // PrefixBound disables itself for linked/block transitions, preserving
    // the existing transfer-count guard. No suffix identity is substituted.
    pub fn certifies(&mut self, departure: i64, arrival: i64, transfers: u32, walk: u64) -> bool {
        self.diagnostics.bound_checks += 1;
        let covered = self.covers_bound(departure, arrival, transfers, walk);
        if covered {
            self.diagnostics.pruned_boardings += 1;
        }
        covered
    }

    pub fn certifies_suffix(
        &mut self,
        departure: i64,
        arrival: i64,
        transfers: u32,
        walk: u64,
    ) -> bool {
        self.diagnostics.suffix_bound_checks += 1;
        let covered = self.covers_bound(departure, arrival, transfers, walk);
        if covered {
            self.diagnostics.pruned_suffixes += 1;
        }
        covered
    }

    pub fn certifies_predecessor(
        &mut self,
        departure: i64,
        arrival: i64,
        transfers: u32,
        walk: u64,
    ) -> bool {
        self.diagnostics.predecessor_bound_checks += 1;
        let covered = self.covers_bound(departure, arrival, transfers, walk);
        if covered {
            self.diagnostics.pruned_predecessor_pairs += 1;
        }
        covered
    }

    pub fn has_incumbents(&self) -> bool {
        DeadlinePreference::ALL
            .into_iter()
            .enumerate()
            .all(|(i, p)| {
                self.preference.is_some_and(|wanted| wanted != p) || self.best[i].is_some()
            })
    }

    pub fn row_ceiling(
        &mut self,
        arrival: i64,
        transfers: u32,
        walk: u64,
        window_last: i64,
    ) -> Option<i64> {
        self.diagnostics.row_ceiling_builds += 1;
        let mut ceiling = i64::MAX as i128;
        let mut impossible = false;
        for (i, preference) in DeadlinePreference::ALL.into_iter().enumerate() {
            if self.preference.is_some_and(|p| p != preference) {
                continue;
            }
            self.diagnostics.row_ceiling_selectors += 1;
            let next = self.best[i].and_then(|best| {
                selector_departure_ceiling(preference, best, arrival, transfers, walk)
            });
            match next {
                Some(next) => ceiling = ceiling.min(next),
                None => {
                    impossible = true;
                    break;
                }
            }
        }
        if impossible || ceiling < i64::MIN as i128 {
            self.diagnostics.row_ceiling_disabled += 1;
            None
        } else if ceiling >= window_last as i128 {
            // min(source.arrival, window.last) is covered for *every* source,
            // including sources after window.last. This is not a clock cutoff.
            Some(i64::MAX)
        } else {
            Some(ceiling as i64) // MIN <= ceiling < window.last <= MAX
        }
    }

    pub fn covers_bound(&self, departure: i64, arrival: i64, transfers: u32, walk: u64) -> bool {
        DeadlinePreference::ALL
            .into_iter()
            .enumerate()
            .all(|(i, preference)| {
                self.preference.is_some_and(|p| p != preference)
                    || self.best[i].is_some_and(|best| {
                        best < rank(preference, departure, arrival, transfers, walk)
                    })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::temporal_probe::r3::R3TransitWitness;
    use alloc::vec;

    fn point(d: i64, a: i64, t: u32, w: u64, trip: u32) -> R3Point {
        R3Point {
            origin_departure_secs: d,
            destination_arrival_secs: a,
            actual_transfers: t,
            total_walk_secs: w,
            transit_rounds: 1,
            service_date: 20261012,
            witness: vec![R3TransitWitness {
                service_date: 20261012,
                route_idx: 0,
                reader_route_idx: 0,
                trip_idx: trip,
                board_position: 0,
                alight_position: 2,
                board_secs: d,
                alight_secs: a,
                frequency_offset_secs: 0,
                frequency_instance: false,
                in_seat: false,
            }],
        }
    }

    #[test]
    fn four_numeric_winners_keep_canonical_ties_and_empty_answers() {
        let points = [
            point(110, 240, 3, 30, 0),
            point(100, 190, 2, 25, 1),
            point(90, 220, 1, 0, 2),
            point(80, 230, 0, 10, 3),
        ];
        let selected = DeadlinePortfolioWinners::from_m4_points(&points);
        for (i, p) in selected.by_preference.iter().enumerate() {
            assert_eq!(p.as_ref(), Some(&points[i]));
        }
        let mut tie = points[1].clone();
        tie.witness[0].trip_idx = 99;
        assert_eq!(
            DeadlinePortfolioWinners::from_m4_points(&[tie, points[1].clone()]).by_preference[1],
            Some(points[1].clone())
        );
        assert_eq!(
            DeadlinePortfolioWinners::from_m4_points(&[]),
            DeadlinePortfolioWinners::default()
        );
    }

    #[test]
    fn independent_incumbents_strictly_certify_where_no_single_point_dominates() {
        let points = [
            point(101, 205, 2, 12, 0),
            point(90, 185, 2, 12, 1),
            point(90, 210, 2, 5, 2),
            point(90, 210, 0, 12, 3),
        ];
        let mut tracker = PortfolioTracker::default();
        assert!(!tracker.certifies(100, 200, 1, 10));
        for p in &points {
            assert!(
                !(p.origin_departure_secs >= 100
                    && p.destination_arrival_secs <= 200
                    && p.actual_transfers <= 1
                    && p.total_walk_secs <= 10)
            );
            tracker.observe(p);
        }
        assert!(tracker.certifies(100, 200, 1, 10));
        for p in &DeadlinePortfolioWinners::from_m4_points(&points).by_preference {
            let p = p.as_ref().unwrap();
            assert!(!tracker.certifies(
                p.origin_departure_secs,
                p.destination_arrival_secs,
                p.actual_transfers,
                p.total_walk_secs
            ));
        }
        assert_eq!(tracker.diagnostics.pruned_boardings, 1);
    }

    #[test]
    fn single_preference_does_not_wait_for_other_incumbents_or_prune_numeric_ties() {
        for preference in DeadlinePreference::ALL {
            let mut tracker = PortfolioTracker::new(Some(preference));
            assert!(!tracker.certifies(100, 200, 1, 10));
            let winner = point(101, 199, 0, 9, 0);
            tracker.observe(&winner);
            assert!(tracker.certifies(100, 200, 1, 10));
            assert!(!tracker.certifies(101, 199, 0, 9));
            assert_eq!(tracker.best.iter().filter(|r| r.is_some()).count(), 1);
            assert_eq!(
                preference.from_m4_points(core::slice::from_ref(&winner)),
                Some(winner)
            );
            assert_eq!(preference.from_m4_points(&[]), None);
        }
        let latest = point(101, 300, 9, 900, 0);
        let mut all = PortfolioTracker::default();
        let mut one = PortfolioTracker::new(Some(DeadlinePreference::LatestDeparture));
        all.observe(&latest);
        one.observe(&latest);
        assert!(!all.certifies(100, 200, 1, 10));
        assert!(one.certifies(100, 200, 1, 10));
    }

    #[test]
    fn ranks_use_wide_time_arithmetic_and_actual_transfers_not_rounds() {
        let p = point(i64::MIN, i64::MAX, 0, u64::MAX, 0);
        assert_eq!(
            point_rank(DeadlinePreference::Fastest, &p)[0],
            (i64::MAX as i128) - (i64::MIN as i128)
        );
        assert_eq!(
            point_rank(DeadlinePreference::LeastWalking, &p)[0],
            u64::MAX as i128
        );
        let mut rounds = p.clone();
        rounds.transit_rounds = 10;
        assert_eq!(
            compare(DeadlinePreference::FewestTransfers, &p, &rounds),
            Ordering::Equal
        );
    }

    #[test]
    fn suffix_checks_are_independent_strict_and_require_every_requested_selector() {
        let p = point(100, 200, 0, 0, 0);
        let mut tracker = PortfolioTracker::default();
        assert!(!tracker.certifies_suffix(99, 201, 1, 1));
        tracker.observe(&p);
        assert!(!tracker.certifies_suffix(100, 200, 0, 0));
        assert!(tracker.certifies_suffix(99, 201, 1, 1));
        assert_eq!(tracker.diagnostics.bound_checks, 0);
        assert_eq!(tracker.diagnostics.pruned_boardings, 0);
        assert_eq!(tracker.diagnostics.suffix_bound_checks, 3);
        assert_eq!(tracker.diagnostics.pruned_suffixes, 1);
        // Later departure alone is not a certificate for the whole portfolio.
        assert!(!tracker.certifies_suffix(99, 100, 0, 0));
        let mut latest = PortfolioTracker::new(Some(DeadlinePreference::LatestDeparture));
        latest.observe(&p);
        assert!(latest.certifies_suffix(99, 100, 0, 0));
        assert!(!latest.certifies_suffix(i64::MAX, i64::MIN, 0, 0));
        assert!(latest.certifies_suffix(i64::MIN, i64::MAX, u32::MAX, u64::MAX));
        assert!(!latest.certifies_predecessor(100, 200, 0, 0));
        assert!(latest.certifies_predecessor(99, 200, 0, 0));
        assert_eq!(latest.diagnostics.predecessor_bound_checks, 2);
        assert_eq!(latest.diagnostics.pruned_predecessor_pairs, 1);
        assert_eq!(latest.diagnostics.bound_checks, 0);
    }

    #[test]
    fn row_bound_coverage_is_monotone_and_keeps_numeric_ties_for_every_selector() {
        for preference in [None].into_iter().chain(DeadlinePreference::ALL.map(Some)) {
            let mut tracker = PortfolioTracker::new(preference);
            assert!(!tracker.has_incumbents());
            assert!(!tracker.covers_bound(99, 200, 0, 0));
            tracker.observe(&point(100, 200, 0, 0, 0));
            assert!(tracker.has_incumbents());
            for arrival in [i64::MIN, 199, 200, 201, i64::MAX] {
                for (transfers, walk) in [(0, 0), (1, 0), (0, 1), (u32::MAX, u64::MAX)] {
                    let mut uncovered = false;
                    for departure in [i64::MIN, -1, 99, 100, 101, i64::MAX] {
                        let covered = tracker.covers_bound(departure, arrival, transfers, walk);
                        assert!(!uncovered || !covered, "true after false: {preference:?}");
                        uncovered |= !covered;
                    }
                }
            }
            assert!(tracker.covers_bound(99, 200, 0, 0));
            assert!(!tracker.covers_bound(100, 200, 0, 0));
            assert_eq!(tracker.diagnostics, DeadlinePortfolioDiagnostics::default());
        }
    }

    fn check_compilation(tracker: &mut PortfolioTracker, a: i64, t: u32, w: u64, last: i64) {
        let ceiling = tracker.row_ceiling(a, t, w, last);
        let mut probes = vec![
            i64::MIN,
            i64::MIN + 1,
            -101,
            -1,
            0,
            99,
            100,
            101,
            199,
            200,
            201,
            last,
            a,
            i64::MAX - 1,
            i64::MAX,
        ];
        if let Some(c) = ceiling {
            probes.push(c);
            probes.extend(c.checked_sub(1));
            probes.extend(c.checked_add(1));
        }
        for source_arrival in probes {
            assert_eq!(ceiling.is_some_and(|c| source_arrival <= c),
                tracker.covers_bound(source_arrival.min(last), a, t, w),
                "compiled {:?} best={:?} suffix=({a},{t},{w}) last={last} source={source_arrival} ceiling={ceiling:?}",
                tracker.preference, tracker.best);
        }
    }

    #[test]
    fn compiled_row_ceiling_matches_full_ranks_at_ties_clipping_and_wide_boundaries() {
        for preference in [None].into_iter().chain(DeadlinePreference::ALL.map(Some)) {
            let mut tracker = PortfolioTracker::new(preference);
            check_compilation(&mut tracker, 200, 1, 10, 1000); // missing incumbents
            tracker.observe(&point(100, 200, 1, 10, 0));
            for a in [i64::MIN, 199, 200, 201, i64::MAX] {
                for t in [0, 1, 2, u32::MAX] {
                    for w in [0, 9, 10, 11, u64::MAX] {
                        for last in [i64::MIN, 99, 100, 101, i64::MAX] {
                            check_compilation(&mut tracker, a, t, w, last);
                        }
                    }
                }
            }
            for p in [
                point(i64::MIN, i64::MAX, u32::MAX, u64::MAX, 0),
                point(i64::MAX, i64::MIN, 0, 0, 0),
            ] {
                let mut wide = PortfolioTracker::new(preference);
                wide.observe(&p);
                for a in [i64::MIN, 0, i64::MAX] {
                    for last in [i64::MIN, 0, i64::MAX] {
                        check_compilation(&mut wide, a, 0, 0, last);
                        check_compilation(&mut wide, a, u32::MAX, u64::MAX, last);
                    }
                }
            }
        }
        let mut partial = PortfolioTracker::default();
        partial.best[0] = Some(point_rank(
            DeadlinePreference::LatestDeparture,
            &point(100, 200, 0, 0, 0),
        ));
        assert_eq!(partial.row_ceiling(201, 1, 1, 1000), None);
        assert_eq!(partial.diagnostics.row_ceiling_disabled, 1);
    }

    #[test]
    fn compiled_row_ceiling_matches_random_independent_incumbents_and_suffixes() {
        let mut seed = 0x147a_a22b_9c10_ff43_u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            seed
        };
        for _ in 0..2000 {
            for preference in [None].into_iter().chain(DeadlinePreference::ALL.map(Some)) {
                let mut tracker = PortfolioTracker::new(preference);
                for i in 0..4 {
                    tracker.observe(&point(
                        next() as i64,
                        next() as i64,
                        next() as u32,
                        next(),
                        i,
                    ));
                }
                for last in [i64::MIN, next() as i64, i64::MAX] {
                    check_compilation(&mut tracker, next() as i64, next() as u32, next(), last);
                }
                let d = tracker.diagnostics;
                assert_eq!(d.row_ceiling_builds, 3);
                assert!(d.row_ceiling_selectors >= 3 && d.row_ceiling_selectors <= 12);
                assert!(d.row_ceiling_disabled <= 3);
                assert_eq!(
                    d.bound_checks + d.suffix_bound_checks + d.predecessor_bound_checks,
                    0
                );
            }
        }
    }
}
