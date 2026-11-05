//! Criterion-aware reduction within a concrete vehicle. Different trips,
//! service dates and frequency instances are never substituted.
//!
//! Replacement proof: from the SAME source arrival, an already retained edge
//! boards the SAME vehicle at an occurrence no later than the removed edge,
//! at a departure time no later, with no more physical walking and the same
//! passenger-transfer cost. Both edges are feasible by construction. Stay on
//! that vehicle past the removed boarding occurrence, then follow the original
//! suffix. Every downstream arrival occurrence, vehicle identity and scoped
//! rule is unchanged. One ride and the same passenger-transfer cost are spent,
//! so remaining rounds are equal; origin departure is unchanged and walking
//! cannot increase. An earlier boarding also respects any deadline permitting
//! the removed boarding. Thus the replacement is no worse for both R3 and M4.
//!
//! Pickup/drop-off restrictions at intermediate occurrences do not require
//! alighting; only the replacement boarding and downstream alighting matter.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
//! and https://gtfs.org/documentation/schedule/reference/#transferstxt
//!
//! No claim about reverse reductions, delayed timetables, different vehicles,
//! or implicit later vehicles is made. Binding and generation checks still
//! apply. Reduction is performed after the bounded unreduced build.

use super::{len_bytes, TransferEdge, TransferIndex};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransferReductionDiagnostics {
    pub edges_before: usize,
    pub edges_after: usize,
    pub removed_edges: usize,
    pub comparisons: usize,
}

/// Reduce in place, preserving every event ordinal and the original binding.
/// Two retained candidates per current vehicle (passenger transfer / in-seat)
/// suffice for a conservative linear pass. On nonmonotone times the explicit
/// departure check can retain extra edges; it never removes an unproved edge.
pub fn reduce_transfer_index(
    mut table: TransferIndex,
) -> (TransferIndex, TransferReductionDiagnostics) {
    let edges_before = table.edges.len();
    let mut write = 0;
    let mut comparisons = 0;
    let mut kinds = [0; 6];
    let mut max_degree = 0;
    for source in 0..table.events.len() {
        let (start, end) = (
            table.offsets[source] as usize,
            table.offsets[source + 1] as usize,
        );
        table.offsets[source] = write as u32;
        let row_start = write;
        // For duplicate target occurrences, inspect the least-walking edge
        // first even when the feasible edges have different GTFS edge kinds.
        table.edges[start..end].sort_unstable_by_key(|e| {
            (
                e.target,
                e.kind.spends_transfer(),
                e.walk_secs,
                e.elapsed_secs,
                e.kind,
            )
        });
        let mut vehicle = None;
        let mut best: [Option<TransferEdge>; 2] = [None, None];
        for read in start..end {
            let edge = table.edges[read];
            let target = table.events[edge.target as usize];
            let key = (
                target.trip_idx,
                target.date_ordinal,
                target.frequency_offset_secs,
            );
            if vehicle != Some(key) {
                best = [None, None];
                vehicle = Some(key);
            }
            let class = usize::from(edge.kind.spends_transfer());
            if let Some(earlier) = best[class] {
                comparisons += 1;
                let boarded = table.events[earlier.target as usize];
                if boarded.position <= target.position
                    && boarded.departure_secs <= target.departure_secs
                    && earlier.walk_secs <= edge.walk_secs
                {
                    continue;
                }
            }
            if best[class].is_none_or(|earlier| {
                edge.walk_secs < earlier.walk_secs
                    || (edge.walk_secs == earlier.walk_secs
                        && target.departure_secs
                            < table.events[earlier.target as usize].departure_secs)
            }) {
                best[class] = Some(edge);
            }
            table.edges[write] = edge;
            write += 1;
            kinds[edge.kind as usize] += 1;
        }
        max_degree = max_degree.max(write - row_start);
    }
    table.offsets[table.events.len()] = write as u32;
    table.edges.truncate(write);
    table.edges.shrink_to_fit();
    table.diagnostics.edges = write;
    table.diagnostics.edges_by_kind = kinds;
    table.diagnostics.max_out_degree = max_degree;
    table.diagnostics.index_bytes =
        len_bytes(&table.events) + len_bytes(&table.offsets) + len_bytes(&table.edges);
    let diagnostics = TransferReductionDiagnostics {
        edges_before,
        edges_after: write,
        removed_edges: edges_before - write,
        comparisons,
    };
    (table, diagnostics)
}
