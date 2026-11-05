//! Stop→routes membership (all-trips union), built once per generation at load.
//!
//! C2a's `/stops` responses list, per stop, the routes serving it. The backend's
//! `MapView.getActiveRoutesForStop` defines that set as the UNION of routes over
//! EVERY trip's `stop_times` (not the route's canonical/longest trip alone), in
//! `stopRouteTripCounts` FIRST-SEEN order (the order `(stop, route)` pairs are
//! first encountered iterating trips × stop_times), deduped.
//!
//! This is deliberately NOT `pt_core::Reader::stop_routes()` / the RAPTOR
//! `Index.routes_at_stop`: that CSR is CANONICAL-ONLY (a route is listed at a
//! stop iff the stop lies on the route's longest/canonical trip), so it
//! UNDER-reports on multi-pattern feeds — a stop served by a route only via a
//! shorter variant trip is dropped (≈1621 stops diverge on Oslo). See
//! `crates/pt-producer/src/csr/stop_routes.rs` for the canonical-only
//! contract. The `/stops` parity gate is order-strict, hence first-seen (not
//! sorted) insertion order here.
//!
//! Contract boundary: this is the FULL all-trips union with NO trip-count
//! filter. The backend `MapView` additionally drops `(stop, route)` pairs with
//! `count < STOP_ROUTES_MIN_TRIPS` (`index.ts`, default `0`). pt-serve has no
//! access to that backend env, so C2a requires `STOP_ROUTES_MIN_TRIPS=0`
//! (the default) on a flipped city — a nonzero value diverges `routes[]`
//! silently. Documented as a flip precondition in the pt-serve ops runbook

use pt_core::Reader;

/// stop_idx -> route_idx list (FIRST-SEEN order, deduped). All-trips union —
/// matches the backend MapView (`getActiveRoutesForStop`), NOT the canonical-only
/// `Reader::stop_routes()` CSR (which under-reports on multipattern feeds).
///
/// Accessor errors (malformed `trip_route_idx` / `stop_time` record, or an
/// absent `trip_starts` region) are skipped (`continue` / early empty return)
/// rather than `?`-propagated: a single malformed record must not abort the
/// whole at-load membership build (mirrors the `scheduled_departures.rs`
/// `match … Err(_) => continue` convention).
///
/// The `B: … + Send + Sync + 'static` bound is NOT removable: it mirrors
/// `pt_core::Reader`'s impl block (`reader.rs`: `impl<B: AsRef<[u8]> + Send +
/// Sync + 'static> Reader<B>`) — the accessors used below are only callable
/// under that bound.
///
/// Dispatches to [`build_stop_membership_via_patterns`] when the bundle carries
/// a pattern band, and falls back to the `stop_time`-row walk otherwise. Both
/// produce the same union in the same first-seen order; see the two functions'
/// docs for why the pattern path exists.
pub fn build_stop_membership<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
) -> Vec<Vec<u32>> {
    match build_stop_membership_via_patterns(reader) {
        Some(m) => m,
        None => build_stop_membership_via_rows(reader),
    }
}

/// The all-trips union derived from `0x11 PatternStops`.
///
/// `None` when the bundle carries no pattern band (a staging bundle), where the caller
/// must use [`build_stop_membership_via_rows`].
///
/// ## Why this exists
///
/// The union needs only `(trip → route, row → stop_idx)`; it never reads times,
/// dwell or boarding. [`build_stop_membership_via_rows`] nonetheless calls
/// `Reader::stop_time` per row, which materialises a full `StopTime`.
///
/// That was O(1) while bundles carried the flat `0xF4 StopTimes` array. B1.5
/// made the published bundle CARRY-LESS — `0xF4`/`0xF5`/`0xF6`/`0xFA` are dropped and rows are
/// synthesized from the band — so the same call became `band_stop_time`, which
/// costs a `pattern_trips` linear scan plus TWO `trip_times(p)` prefix walks
/// (`reader.rs`), i.e. `O(k + 2p)`. Measured on a real 388k-trip / 6,138-pattern
/// paris feed that was **321 s of an 8.76M-row walk**, ~99.8% of the entire cold
/// load; this path produced a byte-identical union in **0.04 s**.
///
/// Each trip's stop sequence is already stored, in row order and with lasso
/// repeats preserved, as its pattern's `0x11` slice. The ITERATION COUNT is
/// unchanged — still one step per row — but each step is an O(1) slice index
/// instead of `O(k + 2p)`.
///
/// Iterating trips (not patterns) is deliberate: it preserves the FIRST-SEEN
/// `(stop, route)` ordering the `/stops` parity gate depends on. Iterating
/// patterns would be fewer steps but a different order.
pub fn build_stop_membership_via_patterns<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
) -> Option<Vec<Vec<u32>>> {
    if !reader.pattern_band_present() {
        return None;
    }
    let num_stops = reader.num_stops();
    let mut out: Vec<Vec<u32>> = vec![Vec::new(); num_stops];
    let num_trips = reader.num_trips();
    for ti in 0..num_trips {
        // Same skip-the-bad-record convention as the row walk below.
        let ri = match reader.trip_route_idx(ti) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let pidx = match reader.trip_pattern_idx(ti) {
            Some(p) => p as usize,
            None => continue,
        };
        let stops = match reader.pattern_stops(pidx) {
            Some(s) => s,
            None => continue,
        };
        for &s in stops {
            let s = s as usize;
            if s < num_stops && !out[s].contains(&ri) {
                out[s].push(ri);
            }
        }
    }
    Some(out)
}

/// The all-trips union derived by walking `stop_time` rows.
///
/// Correct for any bundle, band or no band. Retained as the fallback — but note it is the SLOW path on a
/// carry-less bundle; see [`build_stop_membership_via_patterns`].
pub fn build_stop_membership_via_rows<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
) -> Vec<Vec<u32>> {
    let num_stops = reader.num_stops();
    let mut out: Vec<Vec<u32>> = vec![Vec::new(); num_stops];
    let trip_starts = match reader.trip_starts() {
        Ok(t) => t,
        Err(_) => return out,
    };
    let num_trips = reader.num_trips();
    // `trip_starts` is a `(num_trips + 1)` prefix-sum; defend against a short
    // region (a malformed bundle) so the `ti + 1` index below can't panic.
    if trip_starts.len() < num_trips + 1 {
        return out;
    }
    for ti in 0..num_trips {
        let ri = match reader.trip_route_idx(ti) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let lo = trip_starts[ti] as usize;
        let hi = trip_starts[ti + 1] as usize;
        for row in lo..hi {
            let st = match reader.stop_time(row) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let s = st.stop_idx as usize;
            // First-seen order; dedup via `Vec::contains` (avg routes/stop ~1.7,
            // so this is ~1-2 comparisons/row; hub-stop O(routes) is acceptable
            // for a once-per-generation at-load build, off the request path. The
            // ~70-85ms paris estimate used a HashSet; this is the order-preserving
            // equivalent — do NOT switch to a HashSet, which would lose first-seen
            // order, the parity contract).
            if s < num_stops && !out[s].contains(&ri) {
                out[s].push(ri);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use pt_core::engine::testkit::{
        all_active_service, as_strs, bare_route, bare_stops, build_v1_ptb, numbered_ids,
        StopRoutes, V1Feed, V1Trip,
    };
    use pt_core::Reader;

    /// Build a multi-route, multi-trip PTB whose stop→routes CSR is written
    /// CANONICAL-ONLY (a route is listed at a stop iff the stop is on the
    /// route's LONGEST trip), mirroring the production probe CSR
    /// (`csr/stop_routes.rs`). This is a faithful divergence fixture: a stop
    /// served by a route ONLY via a shorter, non-canonical trip is OMITTED from
    /// `Reader::stop_routes()` but MUST appear in the all-trips union.
    ///
    /// `routes[r]` is a slice of trips; each trip is a `(stop_seq, stop_idx,
    /// dep_secs)` row-list. Ids and service follow
    /// `testkit::build_routes_multi_trip_ptb` EXCEPT the stop→routes CSR body,
    /// which here is canonical-only.
    #[allow(clippy::type_complexity)]
    fn build_canonical_csr_multipattern_ptb(
        num_stops: u32,
        routes: &[&[&[(u16, u32, u32)]]],
    ) -> Vec<u8> {
        let num_trips: usize = routes.iter().map(|r| r.len()).sum();
        assert!(!routes.is_empty() && num_trips >= 1);

        // stop→routes CSR — CANONICAL-ONLY: per route, only the LONGEST trip's
        // stops contribute (ties → first/lowest trip index). Deduped, route-major.
        let mut routes_per_stop: Vec<Vec<u32>> = vec![Vec::new(); num_stops as usize];
        for (r_idx, trips) in routes.iter().enumerate() {
            // canonical = the longest trip; first wins on a tie.
            let canonical = trips
                .iter()
                .enumerate()
                .max_by_key(|(i, t)| (t.len(), core::cmp::Reverse(*i)))
                .map(|(_, t)| *t);
            if let Some(canon) = canonical {
                for &(_, sidx, _) in canon.iter() {
                    let v = &mut routes_per_stop[sidx as usize];
                    if !v.contains(&(r_idx as u32)) {
                        v.push(r_idx as u32);
                    }
                }
            }
        }

        let stop_ids = numbered_ids("s", num_stops as usize);
        let stops = bare_stops(&as_strs(&stop_ids));
        let route_ids = numbered_ids("R", routes.len());
        let soa_routes: Vec<_> = route_ids.iter().map(|id| bare_route(id)).collect();
        let trip_ids = numbered_ids("T", num_trips);
        let mut trips: Vec<V1Trip<'_>> = Vec::with_capacity(num_trips);
        for (r, route_trips) in routes.iter().enumerate() {
            for rows in route_trips.iter() {
                let t = trips.len();
                trips.push(V1Trip {
                    id: &trip_ids[t],
                    route: r as u32,
                    rows,
                    ..V1Trip::default()
                });
            }
        }
        build_v1_ptb(&V1Feed {
            stops: &stops,
            routes: &soa_routes,
            trips: &trips,
            stop_routes: StopRoutes::Given(&routes_per_stop),
            feed_start_date: 20260501,
            city_tz_offset_seconds: 0,
            services: all_active_service(),
            transfers: &[],
            boarding: &[],
            stop_index: false,
        })
    }

    /// Multi-pattern feed proving ALL-TRIPS UNION ≠ canonical-only.
    ///
    /// Route 0 (R0): canonical (longest) trip visits s0→s1→s2; a SHORTER variant
    /// trip visits s3 only. So s3 is served by R0 ONLY via the non-canonical
    /// trip — the canonical-only CSR omits R0 at s3; the union must include it.
    /// Route 1 (R1): a single trip visiting s2 (so s2 is served by BOTH R0 and
    /// R1, exercising multi-route-per-stop ordering).
    fn fixture() -> Vec<u8> {
        // R0: trip0 = [s0,s1,s2] (longest = canonical), trip1 = [s3] (shorter).
        let r0_t0: &[(u16, u32, u32)] = &[(1, 0, 25200), (2, 1, 25260), (3, 2, 25320)];
        let r0_t1: &[(u16, u32, u32)] = &[(1, 3, 30000)];
        // R1: trip = [s2].
        let r1_t0: &[(u16, u32, u32)] = &[(1, 2, 40000)];
        let r0: &[&[(u16, u32, u32)]] = &[r0_t0, r0_t1];
        let r1: &[&[(u16, u32, u32)]] = &[r1_t0];
        build_canonical_csr_multipattern_ptb(4, &[r0, r1])
    }

    #[test]
    fn membership_is_all_trips_union_not_canonical_only() {
        let bytes = fixture();
        let reader = Reader::from_bytes(bytes).unwrap();
        let membership = build_stop_membership(&reader);

        // s3 is served by R0 (route 0) ONLY via the shorter, non-canonical trip.
        // The all-trips union MUST include it.
        assert!(
            membership[3].contains(&0),
            "all-trips union must include R0 at s3 (served only by R0's non-canonical trip): {:?}",
            membership[3]
        );

        // Divergence proof: the canonical-only CSR (`Reader::stop_routes`) OMITS
        // R0 at s3 — exactly the under-report the union fixes.
        let canonical_at_s3 = reader.stop_routes(3).unwrap();
        assert!(
            !canonical_at_s3.contains(&0),
            "canonical-only CSR should OMIT R0 at s3 (proving union != canonical): {canonical_at_s3:?}"
        );
        assert_ne!(
            membership[3].as_slice(),
            canonical_at_s3,
            "membership must diverge from the canonical-only CSR at the variant stop"
        );

        // s0/s1/s2 are on R0's canonical trip → present either way.
        assert!(membership[0].contains(&0));
        assert!(membership[1].contains(&0));
        assert!(membership[2].contains(&0));
    }

    #[test]
    fn membership_preserves_first_seen_order() {
        // s2 is visited by R0's canonical trip (route 0, encountered first in the
        // trip×stop_times iteration) BEFORE R1's trip (route 1). First-seen order
        // ⇒ [0, 1], NOT sorted-after-the-fact-but-coincidentally-equal — assert
        // the exact order.
        let bytes = fixture();
        let reader = Reader::from_bytes(bytes).unwrap();
        let membership = build_stop_membership(&reader);
        assert_eq!(
            membership[2].as_slice(),
            &[0u32, 1u32],
            "first-seen order: R0 (trip 0) precedes R1 (trip 2) at s2"
        );
    }

    #[test]
    fn membership_dedupes_route_repeated_across_trips() {
        // R0 visits s0 on BOTH of its trips here; the route must appear ONCE.
        let r0_t0: &[(u16, u32, u32)] = &[(1, 0, 25200), (2, 1, 25260)];
        let r0_t1: &[(u16, u32, u32)] = &[(1, 0, 30000)]; // s0 again on a second trip
        let r0: &[&[(u16, u32, u32)]] = &[r0_t0, r0_t1];
        let bytes = build_canonical_csr_multipattern_ptb(2, &[r0]);
        let reader = Reader::from_bytes(bytes).unwrap();
        let membership = build_stop_membership(&reader);
        assert_eq!(
            membership[0].as_slice(),
            &[0u32],
            "a route serving a stop across multiple trips must be deduped to one entry"
        );
    }

    #[test]
    fn membership_len_matches_num_stops() {
        let bytes = fixture();
        let reader = Reader::from_bytes(bytes).unwrap();
        let membership = build_stop_membership(&reader);
        assert_eq!(membership.len(), reader.num_stops());
    }

    // ── Carry-less (B1.5↔C2a) ────────────────────────────────────────────────
    //
    // On a carry-less bundle the flat `0xF4 StopTimes` is stripped; the band is
    // the sole timetable. `build_stop_membership` calls `reader.stop_time(row)`,
    // which must band-reconstruct (the B1.5-T4a reader fix) — otherwise every row
    // errors, `out[s]` stays empty, and `/stops/all` reports `routes: []` for every
    // stop (the route-parity gate fails with `pt-serve=0`). This regression test
    // builds the SAME band topology carry-bearing AND carry-less and asserts the
    // carry-less membership is NON-EMPTY and EQUALS the carry-bearing all-trips
    // route-union.

    /// `(carry_bearing, carry_less)` readers of a single-route BRANCH topology.
    /// trip 0 [s0,s1,s2,s4]; trip 1 [s0,s1,s3,s4] — s2 and s3 are each on ONE
    /// trip only, so the union at each is route 0 via a non-shared variant.
    fn band_branch_pair() -> (Reader<Vec<u8>>, Reader<Vec<u8>>) {
        use pt_core::engine::testkit::{build_pattern_band_ptb, SoaRoute, SoaStop};
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
        ];
        let full = build_pattern_band_ptb(&stops, &routes, trips, &[]);
        let stripped =
            pt_core::strip_regions(full.clone(), &[0xF4, 0xF5, 0xF6, 0xFA]).expect("strip carry");
        (
            Reader::from_bytes(full).expect("carry-bearing"),
            Reader::from_bytes(stripped).expect("carry-LESS"),
        )
    }

    #[test]
    fn membership_nonempty_over_carry_less_v9_band() {
        let (rf, rs) = band_branch_pair();
        assert!(rs.is_carry_less_band(), "stripped bundle is carry-less");

        let m_full = build_stop_membership(&rf);
        let m_less = build_stop_membership(&rs);

        // Carry-less membership is NON-EMPTY (the regression: a broken `stop_time`
        // left every stop empty → route-parity `pt-serve=0`).
        assert!(
            m_less.iter().any(|r| !r.is_empty()),
            "carry-less membership must be non-empty (band-reconstructed stop_times)"
        );
        // Single route 0 serves every stop touched by its two trips: s0..s4 all.
        for (s, routes) in m_less.iter().enumerate() {
            assert_eq!(
                routes.as_slice(),
                &[0u32],
                "stop s{s} served by R0 via the trip×stops union"
            );
        }
        // And it EQUALS the carry-bearing all-trips union row-for-row.
        assert_eq!(
            m_less, m_full,
            "carry-less membership == carry-bearing all-trips union"
        );
    }

    /// The two derivations MUST agree, element for element and in the same
    /// first-seen order — that equality is the whole correctness argument for
    /// taking the pattern path in `build_stop_membership`.
    ///
    /// This is a real oracle, not a formality: the row walk is what the `/stops`
    /// parity gate was built against, and the pattern path only earns the right
    /// to replace it by reproducing it exactly. Both readers are exercised
    /// because the carry-bearing one resolves `stop_time` from the flat `0xF4`
    /// while the carry-less one band-reconstructs it — the pattern path must
    /// match BOTH.
    ///
    /// Verified at scale outside CI as well: on a real 388k-trip / 6,138-pattern
    /// paris feed the two unions compared byte-equal, with the row walk at
    /// 321.34 s and the pattern path at 0.04 s.
    #[test]
    fn pattern_derivation_matches_the_row_walk() {
        let (rf, rs) = band_branch_pair();

        for (label, reader) in [("carry-bearing", &rf), ("carry-less", &rs)] {
            let via_rows = build_stop_membership_via_rows(reader);
            let via_patterns = build_stop_membership_via_patterns(reader)
                .unwrap_or_else(|| panic!("{label}: band present, pattern path must apply"));
            assert_eq!(
                via_patterns, via_rows,
                "{label}: pattern-derived union must equal the row-walk union exactly"
            );
            // Guard against the degenerate pass where both are empty.
            assert!(
                via_patterns.iter().any(|r| !r.is_empty()),
                "{label}: fixture must produce a non-empty union or this proves nothing"
            );
            // And the public entry point must be taking the pattern path here.
            assert_eq!(
                build_stop_membership(reader),
                via_patterns,
                "{label}: build_stop_membership dispatches to the pattern path on a banded bundle"
            );
        }
    }
}
