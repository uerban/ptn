//! All-template optimistic time/walking graph, never a legal timetable route.
//! Consecutive served occurrences include loops and express skips. Dwell, wait,
//! flags, calendars, modes, rounds and walking-chain restrictions are relaxed.
//! Every ordinary synthetic candidate is present at zero cost. Linked/block
//! feeds explicitly disable this experiment until their projection is proved.
//! Frequency shifts cancel in within-trip running-time differences. Bounds
//! apply to the frozen scheduled contract, not unbounded live timing changes.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
//! https://gtfs.org/documentation/schedule/reference/#transferstxt
//! https://gtfs.org/documentation/schedule/reference/#frequenciestxt
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes

use super::*;
use crate::engine::temporal_probe::v2::{physical_walks, synthetic_destinations};
use alloc::collections::{BTreeMap, BTreeSet};

const MAX_EDGES: usize = 250_000;
type Edge = (u32, i64, i64); // destination, time, walking
type Graph = Vec<Vec<Edge>>;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct OptimisticDiagnostics {
    pub enabled: bool,
    pub template_rows: usize,
    pub movement_checks: usize,
    pub distance_work: usize,
    pub edges: usize,
    /// Logical forward/reverse adjacency bytes, excludes map/allocator overhead.
    pub graph_bytes: usize,
    pub potential_bytes: usize,
    pub origin_duration_secs: Option<i64>,
    pub origin_pruned_segments: usize,
    pub destination_pruned_segments: usize,
    pub walking_pruned_boardings: usize,
}
impl OptimisticDiagnostics {
    pub fn work(&self) -> usize {
        self.template_rows + self.movement_checks + self.distance_work
    }
    fn charge(&self, before: usize, limit: usize) -> Result<(), DeadlineError> {
        let attempted = before
            .checked_add(self.work())
            .and_then(|n| n.checked_add(1))
            .ok_or(EngineError::TimeOverflow)?;
        if attempted > limit {
            return Err(DeadlineError::StopScansExhausted { limit, attempted });
        }
        Ok(())
    }
}

pub(super) struct OptimisticBounds {
    from_origin: Vec<i64>,
    to_destination: Vec<i64>,
    walking_from_origin: Vec<i64>,
}

fn add_edge(
    edges: &mut BTreeMap<(u32, u32), (i64, i64)>,
    from: u32,
    to: u32,
    time: i64,
    walk: i64,
    limit: usize,
) -> Result<(), DeadlineError> {
    if let Some(cost) = edges.get_mut(&(from, to)) {
        cost.0 = cost.0.min(time);
        cost.1 = cost.1.min(walk);
    } else {
        if edges.len() >= limit {
            return Err(DeadlineError::OptimisticEdgesExhausted {
                limit,
                attempted: edges.len() + 1,
            });
        }
        edges.insert((from, to), (time, walk));
    }
    Ok(())
}

// One frontier entry per stop (decrease-key), rather than an edge-sized heap.
fn distances(
    graph: &Graph,
    starts: &[crate::StopWalk],
    walking: bool,
    diagnostics: &mut OptimisticDiagnostics,
    before: usize,
    limit: usize,
) -> Result<Vec<i64>, DeadlineError> {
    let mut result = alloc::vec![i64::MAX; graph.len()];
    let mut pending = BTreeSet::new();
    for start in starts {
        diagnostics.charge(before, limit)?;
        diagnostics.distance_work += 1;
        let cost = start.walk_secs as i64;
        let old = result[start.stop as usize];
        if cost < old {
            pending.remove(&(old, start.stop));
            result[start.stop as usize] = cost;
            pending.insert((cost, start.stop));
        }
    }
    while let Some((at, stop)) = pending.pop_first() {
        diagnostics.charge(before, limit)?;
        diagnostics.distance_work += 1;
        for &(to, time, walk) in &graph[stop as usize] {
            diagnostics.charge(before, limit)?;
            diagnostics.distance_work += 1;
            let candidate = at
                .checked_add(if walking { walk } else { time })
                .ok_or(EngineError::TimeOverflow)?;
            let old = result[to as usize];
            if candidate < old {
                pending.remove(&(old, to));
                result[to as usize] = candidate;
                pending.insert((candidate, to));
            }
        }
    }
    Ok(result)
}

impl OptimisticBounds {
    pub(super) fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        index: &Index,
        request: &DeadlineRequest<'_>,
        before: usize,
    ) -> Result<(Option<Self>, OptimisticDiagnostics), DeadlineError> {
        let mut d = OptimisticDiagnostics::default();
        if !request.static_bound {
            return Ok((None, d));
        }
        let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
        if !v2.rules.linked.is_empty() || !v2.derived.is_empty() {
            return Ok((None, d));
        }
        d.enabled = true;
        let mut edges = BTreeMap::new();
        for route in &index.routes {
            for trip in &route.trips {
                let info = v2.trips[trip.trip_idx as usize];
                if info.route == u32::MAX {
                    continue;
                }
                let mut previous: Option<(u32, i64)> = None;
                for pos in info.first_pos as usize..=info.last_pos as usize {
                    if trip.pos_to_row[pos] == -1 {
                        continue;
                    }
                    d.charge(before, request.max_stop_scans)?;
                    d.template_rows += 1;
                    let stop = route.stop_ids[pos];
                    let arrival = alight_secs_at(reader, trip, pos)?;
                    let departure = dep_secs_at(reader, trip, pos)?;
                    if let Some((from, at)) = previous {
                        // Nonmonotone concrete events are still rejected by the
                        // query validator. Zero is a conservative graph cost.
                        add_edge(&mut edges, from, stop, (arrival - at).max(0), 0, MAX_EDGES)?;
                    }
                    previous = Some((stop, departure));
                }
            }
        }
        for stop in 0..reader.num_stops() as u32 {
            d.charge(before, request.max_stop_scans)?;
            d.movement_checks += 1;
            for (to, walk) in physical_walks(reader, request.query, request.transfers, stop)? {
                d.charge(before, request.max_stop_scans)?;
                d.movement_checks += 1;
                add_edge(&mut edges, stop, to, walk, walk, MAX_EDGES)?;
            }
            for to in synthetic_destinations(&v2.rules, stop, None) {
                d.charge(before, request.max_stop_scans)?;
                d.movement_checks += 1;
                add_edge(&mut edges, stop, to, 0, 0, MAX_EDGES)?;
            }
        }
        d.edges = edges.len();
        let mut forward = alloc::vec![Vec::new(); reader.num_stops()];
        let mut reverse = alloc::vec![Vec::new(); reader.num_stops()];
        for ((from, to), (time, walk)) in edges {
            d.charge(before, request.max_stop_scans)?;
            d.movement_checks += 1;
            forward[from as usize].push((to, time, walk));
            reverse[to as usize].push((from, time, walk));
        }
        d.graph_bytes =
            size_of::<Vec<Edge>>() * reader.num_stops() * 2 + size_of::<Edge>() * d.edges * 2;
        let from_origin = distances(
            &forward,
            &request.query.entry_stops,
            false,
            &mut d,
            before,
            request.max_stop_scans,
        )?;
        let to_destination = distances(
            &reverse,
            &request.query.exit_stops,
            false,
            &mut d,
            before,
            request.max_stop_scans,
        )?;
        let walking_from_origin = distances(
            &forward,
            &request.query.entry_stops,
            true,
            &mut d,
            before,
            request.max_stop_scans,
        )?;
        for entry in &request.query.entry_stops {
            let distance = to_destination[entry.stop as usize];
            if distance != i64::MAX {
                let total = distance
                    .checked_add(entry.walk_secs as i64)
                    .ok_or(EngineError::TimeOverflow)?;
                d.origin_duration_secs =
                    Some(d.origin_duration_secs.map_or(total, |old| old.min(total)));
            }
        }
        d.potential_bytes = size_of::<i64>() * reader.num_stops() * 3;
        Ok((
            Some(Self {
                from_origin,
                to_destination,
                walking_from_origin,
            }),
            d,
        ))
    }

    pub(super) fn latest_origin(&self, stop: u32, at: i64) -> Result<Option<i64>, EngineError> {
        let distance = self.from_origin[stop as usize];
        if distance == i64::MAX {
            return Ok(None);
        }
        Ok(Some(
            at.checked_sub(distance).ok_or(EngineError::TimeOverflow)?,
        ))
    }
    pub(super) fn can_reach(&self, stop: u32, at: i64, deadline: i64) -> Result<bool, EngineError> {
        let distance = self.to_destination[stop as usize];
        if distance == i64::MAX {
            return Ok(false);
        }
        Ok(at.checked_add(distance).ok_or(EngineError::TimeOverflow)? <= deadline)
    }
    pub(super) fn walking_prefix(&self, stop: u32) -> Option<u64> {
        let distance = self.walking_from_origin[stop as usize];
        (distance != i64::MAX).then_some(distance as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parallel_edges_have_componentwise_minima_and_limits_never_drop_edges() {
        let mut edges = BTreeMap::new();
        add_edge(&mut edges, 0, 1, 30, 0, 1).unwrap();
        add_edge(&mut edges, 0, 1, 10, 10, 1).unwrap();
        assert_eq!(edges[&(0, 1)], (10, 0));
        assert!(matches!(
            add_edge(&mut edges, 1, 2, 10, 0, 1),
            Err(DeadlineError::OptimisticEdgesExhausted {
                limit: 1,
                attempted: 2
            })
        ));
    }
}
