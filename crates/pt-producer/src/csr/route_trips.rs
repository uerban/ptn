use crate::error::{Error, Result};
use crate::pass1::TripAttrs;

/// Build the route→trips CSR: `offsets[r]..offsets[r+1]` indexes into
/// `neighbors` to yield every trip whose `TripAttrs::route_idx == r`.
///
/// `offsets.len() == num_routes + 1`; the final entry equals `neighbors.len()`
/// which equals `trips_attrs.len()`. Empty-route entries are represented as
/// zero-length ranges (`offsets[r+1] == offsets[r]`) — a silent skip there
/// would shift every subsequent route's range by one.
///
/// `route_idx >= num_routes` is a hard error rather than a saturated index:
/// the canonical fix is to repair the upstream interner, never to coerce a
/// dangling reference into a valid slot.
///
/// Mirrored by two re-derivers that rebuild this CSR from `0xF2 TripsIntern`
/// when the current bundle omits the temporary `0xF6` region: `pt_core`'s
/// `synthesize_carry_from_band` (`crates/pt-core/src/reader.rs`) and the TS loader
/// synth in `packages/shared/src/ptb/loader.ts`. The **three** MUST stay in sync
/// (same counting-sort, ascending trip ordinal — the value-array order drives plan
/// correctness; no CI gate links them).
pub fn build_route_trips_csr(
    trips_attrs: &[TripAttrs],
    num_routes: usize,
) -> Result<(Vec<u32>, Vec<u32>)> {
    let mut counts = vec![0u32; num_routes];
    for trip in trips_attrs {
        let r = trip.route_idx as usize;
        if r >= num_routes {
            return Err(Error::Config(format!(
                "route_trips_csr: route_idx {r} out of bounds (num_routes={num_routes})"
            )));
        }
        counts[r] += 1;
    }
    let mut offsets = vec![0u32; num_routes + 1];
    for r in 0..num_routes {
        offsets[r + 1] = offsets[r] + counts[r];
    }
    let total = offsets[num_routes] as usize;
    let mut neighbors = vec![0u32; total];
    let mut cursor = offsets.clone();
    for (trip_idx, trip) in trips_attrs.iter().enumerate() {
        let r = trip.route_idx as usize;
        let slot = cursor[r] as usize;
        neighbors[slot] = trip_idx as u32;
        cursor[r] += 1;
    }
    Ok((offsets, neighbors))
}
