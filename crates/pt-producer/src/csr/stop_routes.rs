use crate::error::{Error, Result};
use crate::pass1::{TripAttrs, TripStopTriple};

/// Build the stop→routes CSR. For each stop, the neighbor range holds the
/// sorted, de-duplicated set of route indices whose **canonical (longest) trip**
/// stops there.
///
/// CANONICAL, NOT all-trips-union (multi-pattern correctness). The RAPTOR engines
/// model each route by its canonical stop sequence = the route's LONGEST trip
/// (most stop_times rows), ties broken by the first trip in route_trips order
/// (== lowest trip_idx, since `build_route_trips_csr` buckets trips in trip_idx
/// order). They board/alight ONLY along that sequence, so a stop served only by a
/// shorter variant trip is NOT boardable on that route. This CSR therefore lists a
/// route at a stop iff the stop is on the route's canonical trip — matching each
/// engine's `routesAtStop` (TS `raptorIndex.ts` hydrate; Rust `pt-core`
/// `Index::build` Pin 2). The engine-regression gate asserts this CSR equals the
/// TS `routesAtStop` VALUE-ARRAY (order included), so an all-trips union (the old
/// behaviour) diverges by 1621 stops on a multi-pattern feed like Oslo and the
/// gate cannot pass. (Single-pattern feeds: canonical == all-trips, so the bytes
/// are unchanged — committed fixtures and the per-PR gate are unaffected.)
///
/// `Vec<u32>` + `sort_unstable` + `dedup` is used instead of `BTreeSet`:
/// the BTreeSet allocator pressure (a node allocation per insert) was flagged
/// in review as a per-stop hotspot that would dominate the RSS measurement
/// for cities with high stop counts. The flat-vec approach allocates once per
/// stop and lets sort-dedup do the rest in-place.
pub fn build_stop_routes_csr(
    trip_stop_triples: &[TripStopTriple],
    trips_attrs: &[TripAttrs],
    num_stops: usize,
) -> Result<(Vec<u32>, Vec<u32>)> {
    let num_trips = trips_attrs.len();

    // Pass 1: per-trip stop_times row count (one triple == one row).
    let mut trip_len = vec![0u32; num_trips];
    for &(trip_idx, _, _) in trip_stop_triples {
        let t = trip_idx as usize;
        if t >= num_trips {
            return Err(Error::Config(format!(
                "stop_routes_csr: trip_idx {t} out of bounds (num_trips={num_trips})"
            )));
        }
        trip_len[t] += 1;
    }

    // Pass 2: per route, choose the canonical trip = longest (strict `>`, so the
    // FIRST/lowest trip_idx wins ties — first-in-route_trips order). num_routes is
    // derived from the max route_idx (every route here has >= 1 trip).
    let num_routes = trips_attrs
        .iter()
        .map(|a| a.route_idx as usize + 1)
        .max()
        .unwrap_or(0);
    let mut best_len = vec![0u32; num_routes];
    let mut canonical_trip: Vec<u32> = vec![u32::MAX; num_routes];
    for (t, attrs) in trips_attrs.iter().enumerate() {
        let r = attrs.route_idx as usize;
        if trip_len[t] > best_len[r] {
            best_len[r] = trip_len[t];
            canonical_trip[r] = t as u32;
        }
    }

    // Pass 3: emit a (stop, route) entry only for stops on the route's canonical
    // trip. Per-stop dedup collapses canonical repeats (loop/lasso routes) to a
    // set, matching the TS `new Set(stopIds)` fold.
    let mut per_stop: Vec<Vec<u32>> = vec![Vec::new(); num_stops];
    for &(trip_idx, stop_idx, _) in trip_stop_triples {
        let s = stop_idx as usize;
        if s >= num_stops {
            return Err(Error::Config(format!(
                "stop_routes_csr: stop_idx {s} out of bounds (num_stops={num_stops})"
            )));
        }
        let r = trips_attrs[trip_idx as usize].route_idx as usize;
        if canonical_trip[r] == trip_idx {
            per_stop[s].push(r as u32);
        }
    }
    for v in &mut per_stop {
        v.sort_unstable();
        v.dedup();
    }
    let mut offsets = vec![0u32; num_stops + 1];
    for s in 0..num_stops {
        offsets[s + 1] = offsets[s] + per_stop[s].len() as u32;
    }
    let total = offsets[num_stops] as usize;
    let mut neighbors = Vec::with_capacity(total);
    for v in per_stop {
        neighbors.extend(v);
    }
    Ok((offsets, neighbors))
}
