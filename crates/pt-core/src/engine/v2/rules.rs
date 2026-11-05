//! PTB v2 explicit transfer rules: the ordinary `TransferRuleIndex` (types
//! 0-3), the `LinkedTripIndex` (types 4/5) and the single global resolver that
//! selects one maximally specific explicit row per concrete transition.
//!
//! GTFS `transfers.txt`: <https://gtfs.org/documentation/schedule/reference/#transferstxt>.
//! Specificity, most specific first: both trips; source trip + target route or
//! source route + target trip; one trip; both routes; one route; stops only. A
//! station `from_stop_id`/`to_stop_id` applies to every child stop for types
//! 0-3; within the winning tier an exact platform match outranks an inherited
//! station match (a partial order on `(from_exact, to_exact)`). Remaining ties
//! violate a GTFS SHOULD, not a MUST: the lowest PTB row ordinal wins and the
//! resolution reports a conflict.
//!
//! Types 4 and 5 live in a separate index but compete in the same resolver:
//! they apply only at the vehicle boundary (the source trip's final
//! `stop_times` row and the target trip's first row), always rank in tier 1
//! (both trips are mandatory) and treat an omitted stop as an exact match at
//! that boundary.

use alloc::vec::Vec;
use hashbrown::HashMap;
use rustc_hash::FxBuildHasher;

use crate::engine::types::EngineError;
use crate::Reader;

type FxHashMap<K, V> = HashMap<K, V, FxBuildHasher>;

/// One retained ordinary (type 0-3) row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OrdinaryRule {
    pub row: u32,
    pub from_stop: u32,
    pub to_stop: u32,
    pub from_route: Option<u32>,
    pub to_route: Option<u32>,
    pub from_trip: Option<u32>,
    pub to_trip: Option<u32>,
    pub min_secs: Option<u32>,
    pub transfer_type: u8,
}

/// One retained linked (type 4/5) row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LinkedRule {
    pub row: u32,
    pub from_trip: u32,
    pub to_trip: u32,
    pub from_stop: Option<u32>,
    pub to_stop: Option<u32>,
    pub min_secs: Option<u32>,
    pub transfer_type: u8,
    /// False when either trip is a frequency template: GTFS does not define
    /// which concrete repeated vehicles pair, so the row ranks in resolution
    /// but never yields a linked candidate.
    pub pairing_available: bool,
}

/// The resolver's verdict for one concrete transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Selected {
    /// No explicit row applies: the default global floor governs.
    None,
    /// Index into [`RuleIndex::ordinary`].
    Ordinary(u32),
    /// Index into [`RuleIndex::linked`].
    Linked(u32),
}

/// One concrete transition the resolver evaluates.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Transition {
    /// Actual source (alight) stop and target (board) stop.
    pub from_stop: u32,
    pub to_stop: u32,
    pub from_trip: u32,
    pub from_route: u32,
    pub to_trip: u32,
    pub to_route: u32,
    /// True only when the source position is the source trip's terminal row
    /// and the target position is the target trip's initial row; linked rows
    /// are considered only then.
    pub at_boundary: bool,
}

/// The ordinary and linked explicit-rule indices plus the station relation.
#[derive(Debug, Default)]
pub(crate) struct RuleIndex {
    pub ordinary: Vec<OrdinaryRule>,
    pub linked: Vec<LinkedRule>,
    /// `(from_stop, to_stop)` as written (stop or station) -> ordinary rows.
    by_stops: FxHashMap<(u32, u32), Vec<u32>>,
    /// Written `from_stop` -> ordinary rows with a present minimum and a type
    /// other than 3 (the only rows that can create a synthetic edge).
    pub(crate) synthetic_from: FxHashMap<u32, Vec<u32>>,
    /// `(from_trip, to_trip)` -> linked rows.
    linked_by_pair: FxHashMap<(u32, u32), Vec<u32>>,
    /// `from_trip` -> distinct linked target trips, ascending.
    pub(crate) linked_targets: FxHashMap<u32, Vec<u32>>,
    /// Station -> child stops, for stations named by an ordinary `to_stop`.
    pub(crate) children: FxHashMap<u32, Vec<u32>>,
    /// Per-trip: the trip is `from_trip` of some ordinary or linked row.
    pub(crate) trip_has_from_rules: Vec<bool>,
    /// Per-route: the route is `from_route` of some ordinary row.
    pub(crate) route_has_from_rules: Vec<bool>,
    /// Per-stop parent station (dense copy of the `0x40` column).
    parent: Vec<u32>,
}

const NO_PARENT: u32 = u32::MAX;

/// Route/trip specificity tier (1 = most specific) from each side's level
/// (2 = trip, 1 = route, 0 = none).
#[inline]
fn tier(from_level: u8, to_level: u8) -> u8 {
    match (from_level, to_level) {
        (2, 2) => 1,
        (2, 1) | (1, 2) => 2,
        (2, 0) | (0, 2) => 3,
        (1, 1) => 4,
        (1, 0) | (0, 1) => 5,
        _ => 6,
    }
}

#[inline]
fn level(route: Option<u32>, trip: Option<u32>) -> u8 {
    if trip.is_some() {
        2
    } else if route.is_some() {
        1
    } else {
        0
    }
}

/// A candidate during resolution: `(tier, from_exact, to_exact, row, which)`.
#[derive(Clone, Copy)]
struct Cand {
    tier: u8,
    from_exact: bool,
    to_exact: bool,
    row: u32,
    sel: Selected,
}

impl RuleIndex {
    /// Build both indices from the validated v2 `0xF8` rows. `trip_is_frequency`
    /// marks frequency templates (linked pairing unavailable).
    pub(crate) fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        trip_is_frequency: &[bool],
    ) -> Result<Self, EngineError> {
        let num_stops = reader.num_stops();
        let mut parent = alloc::vec![NO_PARENT; num_stops];
        for (s, p) in parent.iter_mut().enumerate() {
            if let Some(ps) = reader.stop_parent(s as u32) {
                *p = ps;
            }
        }
        let mut idx = RuleIndex {
            trip_has_from_rules: alloc::vec![false; reader.num_trips()],
            route_has_from_rules: alloc::vec![false; reader.num_routes()],
            parent,
            ..Default::default()
        };
        let mut station_targets: Vec<u32> = Vec::new();
        for i in 0..reader.num_transfers() {
            let r = reader.transfer_v2(i)?;
            if r.transfer_type >= 4 {
                // Validated: both trips present.
                let (Some(ft), Some(tt)) = (r.from_trip, r.to_trip) else {
                    return Err(EngineError::Corrupt("linked transfer row without trips"));
                };
                let pairing_available =
                    !trip_is_frequency.get(ft as usize).copied().unwrap_or(true)
                        && !trip_is_frequency.get(tt as usize).copied().unwrap_or(true);
                let li = idx.linked.len() as u32;
                idx.linked.push(LinkedRule {
                    row: i as u32,
                    from_trip: ft,
                    to_trip: tt,
                    from_stop: r.from_stop,
                    to_stop: r.to_stop,
                    min_secs: r.min_transfer_secs,
                    transfer_type: r.transfer_type,
                    pairing_available,
                });
                idx.linked_by_pair.entry((ft, tt)).or_default().push(li);
                idx.linked_targets.entry(ft).or_default().push(tt);
                if let Some(f) = idx.trip_has_from_rules.get_mut(ft as usize) {
                    *f = true;
                }
                continue;
            }
            let (Some(fs), Some(ts)) = (r.from_stop, r.to_stop) else {
                return Err(EngineError::Corrupt("ordinary transfer row without stops"));
            };
            let oi = idx.ordinary.len() as u32;
            idx.ordinary.push(OrdinaryRule {
                row: i as u32,
                from_stop: fs,
                to_stop: ts,
                from_route: r.from_route,
                to_route: r.to_route,
                from_trip: r.from_trip,
                to_trip: r.to_trip,
                min_secs: r.min_transfer_secs,
                transfer_type: r.transfer_type,
            });
            idx.by_stops.entry((fs, ts)).or_default().push(oi);
            if r.min_transfer_secs.is_some() && r.transfer_type != 3 {
                idx.synthetic_from.entry(fs).or_default().push(oi);
            }
            if let Some(t) = r.from_trip {
                if let Some(f) = idx.trip_has_from_rules.get_mut(t as usize) {
                    *f = true;
                }
            } else if let Some(rt) = r.from_route {
                if let Some(f) = idx.route_has_from_rules.get_mut(rt as usize) {
                    *f = true;
                }
            }
            station_targets.push(ts);
        }
        for v in idx.linked_targets.values_mut() {
            v.sort_unstable();
            v.dedup();
        }
        // Child lists for every station named as a target stop.
        station_targets.sort_unstable();
        station_targets.dedup();
        let is_station_target = |s: u32| station_targets.binary_search(&s).is_ok();
        for s in 0..num_stops as u32 {
            let p = idx.parent[s as usize];
            if p != NO_PARENT && is_station_target(p) {
                idx.children.entry(p).or_default().push(s);
            }
        }
        Ok(idx)
    }

    #[inline]
    pub(crate) fn parent_of(&self, s: u32) -> Option<u32> {
        match self.parent.get(s as usize).copied() {
            Some(p) if p != NO_PARENT => Some(p),
            _ => None,
        }
    }

    /// Whether the from-side scope of `r` admits the arriving trip/route.
    #[inline]
    pub(crate) fn from_side_matches(r: &OrdinaryRule, trip: u32, route: u32) -> bool {
        r.from_trip.is_none_or(|t| t == trip) && r.from_route.is_none_or(|x| x == route)
    }

    /// Select the single maximally specific explicit row for `t`. Returns the
    /// selection and whether a tie was broken by row ordinal (the GTFS SHOULD
    /// conflict the producer also reports).
    pub(crate) fn resolve(&self, t: &Transition) -> (Selected, bool) {
        let mut best: Vec<Cand> = Vec::new();
        let mut best_tier = u8::MAX;
        let consider = |c: Cand, best: &mut Vec<Cand>, best_tier: &mut u8| {
            if c.tier < *best_tier {
                *best_tier = c.tier;
                best.clear();
                best.push(c);
            } else if c.tier == *best_tier {
                best.push(c);
            }
        };
        let froms = [Some(t.from_stop), self.parent_of(t.from_stop)];
        let tos = [Some(t.to_stop), self.parent_of(t.to_stop)];
        for fs in froms.iter().flatten() {
            for ts in tos.iter().flatten() {
                let Some(rows) = self.by_stops.get(&(*fs, *ts)) else {
                    continue;
                };
                for &oi in rows {
                    let r = &self.ordinary[oi as usize];
                    if !Self::from_side_matches(r, t.from_trip, t.from_route) {
                        continue;
                    }
                    if !(r.to_trip.is_none_or(|x| x == t.to_trip)
                        && r.to_route.is_none_or(|x| x == t.to_route))
                    {
                        continue;
                    }
                    consider(
                        Cand {
                            tier: tier(
                                level(r.from_route, r.from_trip),
                                level(r.to_route, r.to_trip),
                            ),
                            from_exact: *fs == t.from_stop,
                            to_exact: *ts == t.to_stop,
                            row: r.row,
                            sel: Selected::Ordinary(oi),
                        },
                        &mut best,
                        &mut best_tier,
                    );
                }
            }
        }
        if t.at_boundary {
            if let Some(rows) = self.linked_by_pair.get(&(t.from_trip, t.to_trip)) {
                for &li in rows {
                    let r = &self.linked[li as usize];
                    // Linked rows use exact boundary IDs; an omitted stop is
                    // resolved to (and therefore exactly matches) the boundary.
                    if r.from_stop.is_some_and(|s| s != t.from_stop)
                        || r.to_stop.is_some_and(|s| s != t.to_stop)
                    {
                        continue;
                    }
                    consider(
                        Cand {
                            tier: 1,
                            from_exact: true,
                            to_exact: true,
                            row: r.row,
                            sel: Selected::Linked(li),
                        },
                        &mut best,
                        &mut best_tier,
                    );
                }
            }
        }
        if best.is_empty() {
            return (Selected::None, false);
        }
        // Stop-exactness partial order: keep the maximal elements.
        let dominated = |a: &Cand, b: &Cand| {
            // b dominates a
            b.from_exact >= a.from_exact
                && b.to_exact >= a.to_exact
                && ((b.from_exact && !a.from_exact) || (b.to_exact && !a.to_exact))
        };
        let mut winner: Option<Cand> = None;
        let mut maximal = 0usize;
        for a in &best {
            if best.iter().any(|b| dominated(a, b)) {
                continue;
            }
            maximal += 1;
            if winner.is_none_or(|w| a.row < w.row) {
                winner = Some(*a);
            }
        }
        // `best` is non-empty, so at least one element is maximal.
        let w = winner.map(|c| c.sel).unwrap_or(Selected::None);
        (w, maximal > 1)
    }

    /// Whether some ordinary row is written for the arrival stop `from_stop` and
    /// boarding stop `to_stop` (or their stations): the only rows
    /// [`Self::resolve`] considers apart from linked ones.
    pub(crate) fn has_ordinary_between(&self, from_stop: u32, to_stop: u32) -> bool {
        let froms = [Some(from_stop), self.parent_of(from_stop)];
        let tos = [Some(to_stop), self.parent_of(to_stop)];
        froms.iter().flatten().any(|fs| {
            tos.iter()
                .flatten()
                .any(|ts| self.by_stops.contains_key(&(*fs, *ts)))
        })
    }

    /// Whether some linked row starts at `from_trip`.
    pub(crate) fn has_linked_from(&self, from_trip: u32) -> bool {
        self.linked_targets.contains_key(&from_trip)
    }

    /// Whether some retained explicit row constraining exactly the pair
    /// `(from_trip, to_trip)` applies at the boundary `(from_stop, to_stop)`.
    /// Used to suppress inferred block continuity.
    pub(crate) fn pair_has_explicit_row_at(
        &self,
        from_trip: u32,
        to_trip: u32,
        from_stop: u32,
        to_stop: u32,
    ) -> bool {
        if let Some(rows) = self.linked_by_pair.get(&(from_trip, to_trip)) {
            if rows.iter().any(|&li| {
                let r = &self.linked[li as usize];
                r.from_stop.is_none_or(|s| s == from_stop) && r.to_stop.is_none_or(|s| s == to_stop)
            }) {
                return true;
            }
        }
        let froms = [Some(from_stop), self.parent_of(from_stop)];
        let tos = [Some(to_stop), self.parent_of(to_stop)];
        for fs in froms.iter().flatten() {
            for ts in tos.iter().flatten() {
                if let Some(rows) = self.by_stops.get(&(*fs, *ts)) {
                    if rows.iter().any(|&oi| {
                        let r = &self.ordinary[oi as usize];
                        r.from_trip == Some(from_trip) && r.to_trip == Some(to_trip)
                    }) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

/// The boarding floor an ordinary rule (or its absence) imposes on a transfer
/// at one stop or after a PTFT edge. `None` = the transfer is forbidden.
///
/// type 3 forbids; type 2 uses its mandatory minimum; type 1 is a timed
/// transfer (floor zero); type 0 and no rule use the global floor `base`
/// (the query's minimum transfer, `Query::min_transfer_floor_secs`). A present
/// minimum raises the base floor on every non-forbidden type.
#[inline]
pub(crate) fn ordinary_floor(rule: Option<&OrdinaryRule>, base: i64) -> Option<i64> {
    let Some(r) = rule else {
        return Some(base);
    };
    let min = r.min_secs.map(|m| m as i64);
    match r.transfer_type {
        3 => None,
        2 => Some(min.unwrap_or(base)),
        1 => Some(min.unwrap_or(0)),
        _ => Some(min.map_or(base, |m| m.max(base))),
    }
}

/// The elapsed duration of a synthetic (no-PTFT) distinct-stop edge under the
/// selected ordinary rule: only a rule with an explicit minimum creates one.
/// Type 0 uses `max(base, min)`; types 1 and 2 use the minimum exactly.
#[inline]
pub(crate) fn synthetic_elapsed(rule: Option<&OrdinaryRule>, base: i64) -> Option<i64> {
    let r = rule?;
    let min = r.min_secs? as i64;
    match r.transfer_type {
        3 => None,
        1 | 2 => Some(min),
        _ => Some(min.max(base)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(row: u32, fs: u32, ts: u32, ty: u8) -> OrdinaryRule {
        OrdinaryRule {
            row,
            from_stop: fs,
            to_stop: ts,
            from_route: None,
            to_route: None,
            from_trip: None,
            to_trip: None,
            min_secs: None,
            transfer_type: ty,
        }
    }

    fn index_with(rules: &[OrdinaryRule], linked: &[LinkedRule], parent: Vec<u32>) -> RuleIndex {
        let mut idx = RuleIndex {
            parent,
            trip_has_from_rules: alloc::vec![false; 16],
            route_has_from_rules: alloc::vec![false; 16],
            ..Default::default()
        };
        for r in rules {
            let oi = idx.ordinary.len() as u32;
            idx.ordinary.push(*r);
            idx.by_stops
                .entry((r.from_stop, r.to_stop))
                .or_default()
                .push(oi);
        }
        for l in linked {
            let li = idx.linked.len() as u32;
            idx.linked.push(*l);
            idx.linked_by_pair
                .entry((l.from_trip, l.to_trip))
                .or_default()
                .push(li);
        }
        idx
    }

    fn tr(fs: u32, ts: u32, boundary: bool) -> Transition {
        Transition {
            from_stop: fs,
            to_stop: ts,
            from_trip: 0,
            from_route: 0,
            to_trip: 1,
            to_route: 1,
            at_boundary: boundary,
        }
    }

    #[test]
    fn tier_table_matches_gtfs_order() {
        assert_eq!(tier(2, 2), 1);
        assert_eq!(tier(2, 1), 2);
        assert_eq!(tier(1, 2), 2);
        assert_eq!(tier(2, 0), 3);
        assert_eq!(tier(0, 2), 3);
        assert_eq!(tier(1, 1), 4);
        assert_eq!(tier(0, 1), 5);
        assert_eq!(tier(0, 0), 6);
    }

    #[test]
    fn station_rule_applies_to_child_and_exact_platform_wins() {
        // Stops 0,1 are children of station 9.
        let parent = alloc::vec![
            9, 9, NO_PARENT, NO_PARENT, NO_PARENT, NO_PARENT, NO_PARENT, NO_PARENT, NO_PARENT,
            NO_PARENT
        ];
        let station = rule(0, 9, 9, 3);
        let platform = rule(1, 0, 1, 2);
        let idx = index_with(
            &[
                station,
                OrdinaryRule {
                    min_secs: Some(60),
                    ..platform
                },
            ],
            &[],
            parent.clone(),
        );
        assert_eq!(
            idx.resolve(&tr(0, 1, false)),
            (Selected::Ordinary(1), false)
        );
        // Only the station row applies to 1 -> 0.
        assert_eq!(
            idx.resolve(&tr(1, 0, false)),
            (Selected::Ordinary(0), false)
        );
        // Incomparable exactness (true,false) vs (false,true): lowest row, conflict.
        let a = rule(5, 0, 9, 0);
        let b = rule(3, 9, 1, 1);
        let idx = index_with(&[a, b], &[], parent);
        assert_eq!(idx.resolve(&tr(0, 1, false)), (Selected::Ordinary(1), true));
    }

    #[test]
    fn route_trip_tier_beats_stop_exactness() {
        let parent = alloc::vec![
            9, 9, NO_PARENT, NO_PARENT, NO_PARENT, NO_PARENT, NO_PARENT, NO_PARENT, NO_PARENT,
            NO_PARENT
        ];
        let exact_stop_only = rule(0, 0, 1, 3);
        let station_trip = OrdinaryRule {
            from_trip: Some(0),
            ..rule(1, 9, 9, 1)
        };
        let idx = index_with(&[exact_stop_only, station_trip], &[], parent);
        assert_eq!(
            idx.resolve(&tr(0, 1, false)),
            (Selected::Ordinary(1), false)
        );
    }

    #[test]
    fn linked_rows_compete_only_at_the_boundary() {
        let parent = alloc::vec![NO_PARENT; 4];
        let ban = rule(0, 0, 1, 3);
        let link = LinkedRule {
            row: 1,
            from_trip: 0,
            to_trip: 1,
            from_stop: None,
            to_stop: None,
            min_secs: None,
            transfer_type: 4,
            pairing_available: true,
        };
        let idx = index_with(&[ban], &[link], parent.clone());
        assert_eq!(idx.resolve(&tr(0, 1, true)), (Selected::Linked(0), false));
        assert_eq!(
            idx.resolve(&tr(0, 1, false)),
            (Selected::Ordinary(0), false)
        );
        // An equally specific trip-trip ordinary row ties: lowest row wins.
        let trip_ban = OrdinaryRule {
            from_trip: Some(0),
            to_trip: Some(1),
            ..rule(0, 0, 1, 3)
        };
        let idx = index_with(&[trip_ban], &[link], parent);
        assert_eq!(idx.resolve(&tr(0, 1, true)), (Selected::Ordinary(0), true));
    }

    #[test]
    fn floors_follow_type_semantics() {
        const B: i64 = crate::engine::consts::RAPTOR_MIN_TRANSFER_SECS;
        let mut r = rule(0, 0, 0, 0);
        assert_eq!(ordinary_floor(None, B), Some(120));
        assert_eq!(ordinary_floor(Some(&r), B), Some(120));
        r.min_secs = Some(300);
        assert_eq!(ordinary_floor(Some(&r), B), Some(300));
        r.min_secs = Some(30);
        assert_eq!(ordinary_floor(Some(&r), B), Some(120));
        r.transfer_type = 1;
        assert_eq!(ordinary_floor(Some(&r), B), Some(30));
        r.min_secs = None;
        assert_eq!(ordinary_floor(Some(&r), B), Some(0));
        r.transfer_type = 2;
        r.min_secs = Some(30);
        assert_eq!(ordinary_floor(Some(&r), B), Some(30));
        assert_eq!(synthetic_elapsed(Some(&r), B), Some(30));
        r.transfer_type = 0;
        assert_eq!(synthetic_elapsed(Some(&r), B), Some(120));
        r.min_secs = None;
        assert_eq!(synthetic_elapsed(Some(&r), B), None);
        r.transfer_type = 3;
        assert_eq!(ordinary_floor(Some(&r), B), None);
    }

    /// A query's minimum transfer replaces the global floor where no rule
    /// sets one and is the base a type-0 minimum raises; a rule with its own
    /// floor keeps it.
    #[test]
    fn floors_take_the_query_minimum_transfer() {
        let mut r = rule(0, 0, 0, 0);
        assert_eq!(ordinary_floor(None, 300), Some(300));
        assert_eq!(ordinary_floor(Some(&r), 300), Some(300));
        r.min_secs = Some(200);
        assert_eq!(ordinary_floor(Some(&r), 300), Some(300));
        assert_eq!(synthetic_elapsed(Some(&r), 300), Some(300));
        r.min_secs = Some(400);
        assert_eq!(ordinary_floor(Some(&r), 300), Some(400));
        r.transfer_type = 1;
        r.min_secs = None;
        assert_eq!(ordinary_floor(Some(&r), 300), Some(0));
        r.transfer_type = 2;
        r.min_secs = Some(30);
        assert_eq!(ordinary_floor(Some(&r), 300), Some(30));
        assert_eq!(synthetic_elapsed(Some(&r), 300), Some(30));
    }
}
