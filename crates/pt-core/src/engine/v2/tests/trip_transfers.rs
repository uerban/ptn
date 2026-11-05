//! Unreduced trip-transfer preprocessing against the brute-force oracle's own
//! boarding enumeration (`Oracle::transfers_from`), which the profile and
//! earliest-arrival differentials above already validate end to end.

use super::*;
use crate::engine::temporal_probe::trip_based::{
    build_event_index, build_transfer_index, reduce_transfer_index, IncomingTransfer,
    LazyLookupConfig, LazyLookupError, LazyLookupMode, LazyPredecessors, StopEvent, TransferIndex,
    TransferIndexConfig, TransferIndexError, TransferKind,
};

mod derived_fast;

/// `(trip, date ordinal, served stop_times ordinal, event seconds)`.
type Key = (u32, usize, usize, i64);
type EdgeKey = (Key, Key, u64, OKind);

fn okind(kind: TransferKind) -> OKind {
    match kind {
        TransferKind::SameStop => OKind::SameStop,
        TransferKind::Footpath => OKind::Footpath,
        TransferKind::Synthetic => OKind::Synthetic,
        TransferKind::Linked => OKind::Linked,
        TransferKind::InSeat => OKind::InSeat,
        TransferKind::Derived => OKind::Derived,
    }
}

fn served(index: &Index, ev: &StopEvent) -> usize {
    let trip = index.routes[ev.route_idx as usize]
        .trips
        .iter()
        .find(|t| t.trip_idx == ev.trip_idx)
        .unwrap();
    (0..ev.position as usize)
        .filter(|&p| trip.pos_to_row[p] != -1)
        .count()
}

fn config(covered: core::ops::Range<i64>, mobility: Mobility) -> TransferIndexConfig {
    let mut config = TransferIndexConfig::new(QDATE, covered);
    config.mobility = mobility;
    config
}

fn build(net: &Net, mode: PatternMode, config: &TransferIndexConfig) -> (Index, TransferIndex) {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, mode).unwrap();
    let table = net.ptft_table();
    let out = build_transfer_index(&reader, &index, table.as_ref(), config)
        .unwrap_or_else(|e| panic!("{mode:?}: {e:?}"));
    let catalogue = build_event_index(&reader, &index, table.as_ref(), config).unwrap();
    assert_eq!(catalogue.events(), out.events());
    assert_eq!(catalogue.binding(), out.binding());
    let mut sources = Vec::new();
    for stop in 0..reader.num_stops() {
        let rows = catalogue.arrivals_at_stop(stop as u32);
        assert!(rows.windows(2).all(|w| {
            catalogue.events()[w[0] as usize].arrival_secs
                <= catalogue.events()[w[1] as usize].arrival_secs
        }));
        for &row in rows {
            let e = catalogue.events()[row as usize];
            assert!(e.is_source());
            assert_eq!(
                index.routes[e.route_idx as usize].stop_ids[e.position as usize],
                stop as u32
            );
            sources.push(row);
        }
    }
    sources.sort_unstable();
    assert_eq!(
        sources,
        catalogue
            .events()
            .iter()
            .enumerate()
            .filter(|(_, e)| e.is_source())
            .map(|(i, _)| i as u32)
            .collect::<Vec<_>>()
    );
    let d = catalogue.diagnostics();
    assert_eq!(d.arrival_sources, sources.len());
    assert!(d.peak_build_bytes >= d.index_bytes);
    let mut query = query(0, 1, config.covered.start, 8);
    query.mobility = config.mobility;
    query.excluded_modes = config.excluded_modes.clone();
    query.walk_speed_mm_s = config.walk_speed_mm_s;
    query.min_transfer_secs = config.min_transfer_secs;
    for mode in [
        LazyLookupMode::ScanAll,
        LazyLookupMode::StopIndexed,
        LazyLookupMode::PlainFast,
        LazyLookupMode::PlainCached,
        LazyLookupMode::PlainCachedPacked,
    ] {
        let mut lazy = LazyPredecessors::new(
            &reader,
            &index,
            &catalogue,
            table.as_ref(),
            &query,
            LazyLookupConfig {
                mode,
                max_work: 100_000_000,
            },
        )
        .unwrap();
        for target in 0..catalogue.events().len() {
            let mut expected = Vec::new();
            for source in 0..out.events().len() {
                for e in out.transfers_from(source as u32) {
                    if e.target as usize == target {
                        expected.push(IncomingTransfer {
                            source: source as u32,
                            walk_secs: e.walk_secs,
                            elapsed_secs: e.elapsed_secs,
                            kind: e.kind,
                        });
                    }
                }
            }
            expected.sort_unstable_by_key(|e| (e.source, e.kind, e.walk_secs));
            assert_eq!(
                lazy.incoming(target as u32).unwrap(),
                expected,
                "lazy {mode:?} target {target}"
            );
            if matches!(
                mode,
                LazyLookupMode::PlainCached | LazyLookupMode::PlainCachedPacked
            ) {
                // Different stop bounds, exact arrival ties, unreachable rows,
                // replacement, then a repeat. Filter the unreduced oracle's
                // edges directly, not another optimized predecessor lookup.
                for phase in [0, 1, 2, 1, 1] {
                    let bounds: Vec<_> = (0..reader.num_stops())
                        .map(|s| match phase {
                            0 => i64::MIN,
                            1 => catalogue
                                .arrivals_at_stop(s as u32)
                                .first()
                                .map_or(config.covered.start, |&e| {
                                    catalogue.events()[e as usize].arrival_secs
                                }),
                            _ => i64::MAX,
                        })
                        .collect();
                    let bounded: Vec<_> = expected
                        .iter()
                        .copied()
                        .filter(|edge| {
                            let event = catalogue.events()[edge.source as usize];
                            let stop = index.routes[event.route_idx as usize].stop_ids
                                [event.position as usize];
                            event.arrival_secs >= bounds[stop as usize]
                        })
                        .collect();
                    assert_eq!(
                        lazy.incoming_bounded_for_test(target as u32, &bounds)
                            .unwrap(),
                        bounded,
                        "cached oracle target {target} phase {phase}"
                    );
                }
            }
        }
    }
    (index, out)
}

#[test]
fn packed_lookup_keeps_full_records_work_and_every_cap_with_rule_fallback() {
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        for ruled in [false, true] {
            let mut net = Net::new(5, 4);
            for route in 0..3 {
                for i in 0..32 {
                    net.trip(route, &[(0, 800 + i), (route + 1, 1000 + i)]);
                }
            }
            net.trip(3, &[(3, 1400), (4, 1500)]);
            // The zero-cost distinct-stop movement must remain a Footpath,
            // not be reconstructed as SameStop merely because walking is zero.
            net.ptft = vec![(1, 3, 90), (1, 3, 120), (2, 3, 0)];
            if ruled {
                net.transfers
                    .push((3, 3, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 0));
            }
            let reader = Reader::from_bytes(net.bytes()).unwrap();
            let index = Index::build(&reader, mode).unwrap();
            let table = net.ptft_table();
            let events = build_event_index(
                &reader,
                &index,
                table.as_ref(),
                &config(700..1600, Mobility::Default),
            )
            .unwrap();
            let target = events
                .events()
                .iter()
                .position(|e| e.departure_secs == 1400)
                .unwrap() as u32;
            let q = query(0, 4, 700, 4);
            let execute = |lookup, limit| {
                let mut lazy = LazyPredecessors::new(
                    &reader,
                    &index,
                    &events,
                    table.as_ref(),
                    &q,
                    LazyLookupConfig {
                        mode: lookup,
                        max_work: limit,
                    },
                )?;
                let rows = lazy.incoming_row_certified_for_test(
                    target,
                    Some(&[i64::MIN; 5]),
                    |arrival| arrival < 1004,
                )?;
                Ok::<_, LazyLookupError>((rows, lazy.diagnostics()))
            };
            let (base, diagnostics) = execute(LazyLookupMode::PlainCached, 100_000).unwrap();
            let (packed, mut packed_diagnostics) =
                execute(LazyLookupMode::PlainCachedPacked, 100_000).unwrap();
            assert_eq!(base, packed);
            assert!(base.len() >= 64);
            assert!(base
                .iter()
                .any(|e| e.kind == TransferKind::Footpath && e.walk_secs == 0));
            assert_eq!(packed_diagnostics.packed_sort_calls > 0, !ruled);
            assert_eq!(packed_diagnostics.packed_sort_peak_bytes > 0, !ruled);
            packed_diagnostics.packed_sort_calls = 0;
            packed_diagnostics.packed_sort_peak_bytes = 0;
            assert_eq!(packed_diagnostics, diagnostics);
            // Covers constructor, physical-index, cache/binary-cut and pair
            // boundaries. A failed lookup never returns a partially sorted list.
            for cap in 1..=diagnostics.work + 1 {
                match (
                    execute(LazyLookupMode::PlainCached, cap),
                    execute(LazyLookupMode::PlainCachedPacked, cap),
                ) {
                    (Err(a), Err(b)) => assert_eq!(a, b, "{mode:?} ruled={ruled} cap={cap}"),
                    (Ok((a, _)), Ok((b, _))) => assert_eq!(a, b),
                    other => {
                        panic!("completion drift at {mode:?} ruled={ruled} cap={cap}: {other:?}")
                    }
                }
            }
        }
    }
}

#[test]
fn source_boundary_cache_reuses_only_exact_stop_bounds_and_charges_every_operation() {
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let mut net = Net::new(3, 2);
        for i in 0..32 {
            net.trip(0, &[(0, 800 + i), (1, 1000 + i)]);
        }
        net.trip(1, &[(1, 1300), (2, 1400)]);
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let index = Index::build(&reader, mode).unwrap();
        let events =
            build_event_index(&reader, &index, None, &config(700..1500, Mobility::Default))
                .unwrap();
        let target = events
            .events()
            .iter()
            .position(|e| e.departure_secs == 1300)
            .unwrap() as u32;
        let q = query(0, 2, 700, 4);
        let new = |max_work| {
            LazyPredecessors::new(
                &reader,
                &index,
                &events,
                None,
                &q,
                LazyLookupConfig {
                    mode: LazyLookupMode::PlainCached,
                    max_work,
                },
            )
            .unwrap()
        };
        let mut lazy = new(100_000);
        let unbounded = lazy.incoming(target).unwrap();
        assert_eq!(lazy.diagnostics().source_bound_cache_bytes, 0);
        let bounds = [i64::MIN, 1010, i64::MAX];
        let first = lazy.incoming_bounded_for_test(target, &bounds).unwrap();
        assert_eq!(first.len(), 22); // inclusive equal-time boundary
        let a = lazy.diagnostics();
        let second = lazy.incoming_bounded_for_test(target, &bounds).unwrap();
        let b = lazy.diagnostics();
        assert_eq!(first, second);
        assert_eq!(b.source_bound_cache_hits - a.source_bound_cache_hits, 1);
        assert_eq!(b.source_bound_cache_misses, a.source_bound_cache_misses);
        assert_eq!(b.source_bound_cache_rows, reader.num_stops());
        assert!(b.source_bound_cache_bytes > 0);
        // Suffix-dependent rejection must not poison the boundary cache or the
        // next exact public lookup of the same target.
        let before = lazy.diagnostics();
        let mut checked = 0;
        let rejected = lazy
            .incoming_certified_for_test(target, Some(&bounds), |_| {
                checked += 1;
                false
            })
            .unwrap();
        let after = lazy.diagnostics();
        assert!(rejected.is_empty());
        assert_eq!(checked, first.len());
        assert_eq!(after.pair_checks, before.pair_checks);
        assert_eq!(
            after.event_probes - before.event_probes,
            b.event_probes - a.event_probes
        );
        assert_eq!(
            lazy.incoming_bounded_for_test(target, &bounds).unwrap(),
            first
        );
        assert_eq!(lazy.incoming(target).unwrap(), unbounded);
        let before = lazy.diagnostics();
        let cut = lazy
            .incoming_row_certified_for_test(target, Some(&bounds), |arrival| arrival < 1020)
            .unwrap();
        let after = lazy.diagnostics();
        assert_eq!(cut.len(), 12); // Equal arrival survives the strict cut.
        assert!(cut
            .iter()
            .all(|e| events.events()[e.source as usize].arrival_secs >= 1020));
        assert_eq!(
            after.certified_source_rows_skipped - before.certified_source_rows_skipped,
            10
        );
        assert_eq!(before.pair_checks + 12, after.pair_checks);
        assert!(after.row_bound_checks > before.row_bound_checks);
        assert_eq!(
            after.source_bound_cache_misses,
            before.source_bound_cache_misses
        );
        assert_eq!(
            lazy.incoming_bounded_for_test(target, &bounds).unwrap(),
            first
        );
        assert!(lazy
            .incoming_row_certified_for_test(target, Some(&bounds), |_| true)
            .unwrap()
            .is_empty());
        assert_eq!(
            lazy.incoming_bounded_for_test(target, &bounds).unwrap(),
            first
        );
        assert_eq!(
            lazy.incoming_row_certified_for_test(target, Some(&bounds), |_| false)
                .unwrap(),
            first
        );
        assert_eq!(lazy.incoming(target).unwrap(), unbounded);
        // Exhaust *inside* the binary cut: charge precedes every inspection.
        let mut measured = new(100_000);
        let mut comparisons = 0;
        measured
            .incoming_row_certified_for_test(target, None, |_| {
                comparisons += 1;
                true
            })
            .unwrap();
        let charged = measured.diagnostics();
        assert_eq!(comparisons, charged.row_bound_checks);
        assert!(comparisons > 1);
        let mut capped = new(charged.work - 1);
        let mut inspected = 0;
        assert!(
            matches!(capped.incoming_row_certified_for_test(target, None, |_| { inspected += 1; true }),
            Err(LazyLookupError::WorkExhausted { limit, attempted }) if limit == charged.work - 1 && attempted == charged.work)
        );
        assert_eq!(inspected, comparisons - 1);
        assert_eq!(capped.diagnostics().row_bound_checks, inspected);
        assert_eq!(capped.diagnostics().pair_checks, 0);
        for bound in [1011, i64::MAX, i64::MIN, 1010] {
            let result = lazy
                .incoming_bounded_for_test(target, &[0, bound, 0])
                .unwrap();
            let expected: Vec<_> = unbounded
                .iter()
                .copied()
                .filter(|edge| events.events()[edge.source as usize].arrival_secs >= bound)
                .collect();
            assert_eq!(result, expected, "cache replacement {bound}");
        }
        let d = lazy.diagnostics();
        assert_eq!(
            d.source_bound_cache_probes,
            d.source_bound_cache_hits + d.source_bound_cache_misses
        );
        assert_eq!(
            d.work,
            d.event_probes
                + d.pair_checks
                + d.instance_probes
                + d.walking_index_edges
                + d.rule_candidate_edges
                + d.source_bound_cache_rows
                + d.source_bound_cache_probes
                + d.source_bound_cache_misses
        );
        let mut one = new(100_000);
        one.incoming_bounded_for_test(target, &bounds).unwrap();
        let limit = one.diagnostics().work - 1;
        let mut capped = new(limit);
        assert!(matches!(capped.incoming_bounded_for_test(target, &bounds),
            Err(LazyLookupError::WorkExhausted { limit: l, attempted }) if l == limit && attempted == limit + 1));
        let mut tiny = new(1);
        assert_eq!(
            tiny.incoming_bounded_for_test(target, &bounds),
            Err(LazyLookupError::WorkExhausted {
                limit: 1,
                attempted: 2
            })
        );
        assert_eq!(tiny.diagnostics().source_bound_cache_bytes, 0);
        assert_eq!(tiny.diagnostics().source_bound_cache_misses, 0);
    }
}

#[test]
fn event_catalogue_caps_its_csr_and_rejects_stale_bindings() {
    let mut net = Net::new(3, 1);
    net.trip(0, &[(0, 900), (1, 1000), (2, 1100)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let cfg = config(800..1200, Mobility::Default);
    let events = build_event_index(&reader, &index, None, &cfg).unwrap();
    assert!(events.is_bound_to(&reader, &index, None, &cfg));
    assert!(!events.is_bound_to(&reader, &index, None, &config(800..1201, Mobility::Default)));
    assert!(events.arrivals_at_stop(u32::MAX).is_empty());
    let mut capped = cfg.clone();
    capped.limits.max_events = 2;
    assert!(matches!(
        build_event_index(&reader, &index, None, &capped),
        Err(TransferIndexError::EventsExhausted { .. })
    ));
    capped = cfg.clone();
    capped.limits.max_bytes = events.diagnostics().index_bytes - 1;
    assert!(matches!(
        build_event_index(&reader, &index, None, &capped),
        Err(TransferIndexError::BytesExhausted { .. })
    ));
    capped.limits.max_bytes = events.diagnostics().peak_build_bytes;
    assert!(build_event_index(&reader, &index, None, &capped).is_ok());
}

#[test]
fn event_catalogue_scales_linearly_when_transfer_pairs_grow_quadratically() {
    for n in [8usize, 16, 32, 64] {
        let mut net = Net::new(3, 2);
        net.services = vec![0b0000_1000];
        for i in 0..n as u32 {
            net.trip(0, &[(0, 1000 + 2 * i), (1, 1100 + 2 * i)]);
            net.trip(1, &[(1, 1220 + 2 * i), (2, 1300 + 2 * i)]);
        }
        let cfg = config(900..2000, Mobility::Default);
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        for mode in [
            PatternMode::Off,
            PatternMode::Unbounded,
            PatternMode::CoveringMerge,
        ] {
            let (index, table) = build(&net, mode, &cfg);
            assert_eq!(table.diagnostics().events, 4 * n);
            assert_eq!(table.diagnostics().edges, n * (n + 1) / 2);
            let mut event_config = cfg.clone();
            event_config.limits.max_edges = 1; // No pair storage to exhaust.
            let events = build_event_index(&reader, &index, None, &event_config).unwrap();
            assert_eq!(
                events.diagnostics().index_bytes,
                4 * n * core::mem::size_of::<StopEvent>() + 2 * n * 4 + 4 * 4
            );
        }
    }
}

fn index_edges(
    index: &Index,
    out: &TransferIndex,
    covered: &core::ops::Range<i64>,
) -> Vec<EdgeKey> {
    let events = out.events();
    let mut edges = Vec::new();
    let mut kinds = [0usize; 6];
    let mut max_degree = 0;
    for (i, ev) in events.iter().enumerate() {
        let from = out.transfers_from(i as u32);
        max_degree = max_degree.max(from.len());
        if !from.is_empty() {
            assert!(covered.contains(&ev.arrival_secs));
        }
        for e in from {
            let target = &events[e.target as usize];
            if e.kind.spends_transfer() {
                assert!(target.can_board());
            } else {
                assert!(target.is_trip_start());
            }
            assert!(covered.contains(&target.departure_secs));
            assert!(target.departure_secs >= ev.arrival_secs + e.elapsed_secs as i64);
            assert!(e.walk_secs <= e.elapsed_secs);
            kinds[e.kind as usize] += 1;
            edges.push((
                (
                    ev.trip_idx,
                    ev.date_ordinal as usize,
                    served(index, ev),
                    ev.arrival_secs,
                ),
                (
                    target.trip_idx,
                    target.date_ordinal as usize,
                    served(index, target),
                    target.departure_secs,
                ),
                e.walk_secs as u64,
                okind(e.kind),
            ));
        }
    }
    let d = out.diagnostics();
    assert_eq!(d.events, events.len());
    assert_eq!(d.edges, edges.len());
    assert_eq!(d.edges_by_kind, kinds);
    assert_eq!(d.max_out_degree, max_degree);
    assert!(d.peak_build_bytes >= d.index_bytes);
    edges.sort_unstable();
    edges
}

fn oracle_edges(net: &Net, mobility: Mobility, covered: &core::ops::Range<i64>) -> Vec<EdgeKey> {
    let mut q = query(0, 1, covered.start, 8);
    q.mobility = mobility;
    with_oracle(net, &q, |o| {
        o.deadline = covered.end - 1;
        let mut out: Vec<EdgeKey> = Vec::new();
        for j in 0..o.insts.len() {
            let n = o.insts[j].evs.len();
            for k in 1..n {
                let ev = &o.insts[j].evs[k];
                if !covered.contains(&ev.arr) || (!ev.drop && k != n - 1) {
                    continue;
                }
                let source = (o.insts[j].trip, o.insts[j].date, k, ev.arr);
                for e in o.transfers_from(Ride {
                    inst: j,
                    k,
                    stay_only: !ev.drop,
                }) {
                    let t = &o.insts[e.inst];
                    out.push((
                        source,
                        (t.trip, t.date, e.b, t.evs[e.b].dep),
                        e.walk,
                        e.kind,
                    ));
                }
            }
        }
        // The oracle walks every PTFT row; a repeated directed pair is one
        // movement whose shortest walk admits a superset of departures.
        out.sort_unstable();
        out.dedup_by(|later, kept| (later.0, later.1, later.3) == (kept.0, kept.1, kept.3));
        out
    })
}

fn check_case(
    net: &Net,
    mobility: Mobility,
    covered: core::ops::Range<i64>,
    case: &str,
) -> Vec<EdgeKey> {
    let want = oracle_edges(net, mobility, &covered);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let (index, out) = build(net, mode, &config(covered.clone(), mobility));
        assert_eq!(
            index_edges(&index, &out, &covered),
            want,
            "{case} {mode:?} covered={covered:?} {mobility:?}"
        );
    }
    want
}

fn check(net: &Net, mobility: Mobility, covered: core::ops::Range<i64>) -> Vec<EdgeKey> {
    check_case(net, mobility, covered, "fixture")
}

#[test]
fn reduction_replaces_a_later_longer_walk_on_the_same_vehicle() {
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (3, 1500), (4, 1800)]);
    net.ptft.extend([(1, 2, 30), (1, 3, 90)]);
    let cfg = config(0..10000, Mobility::Default);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let (index, out) = build(&net, mode, &cfg);
        let binding = out.binding();
        let events = out.events().to_vec();
        let (out, d) = reduce_transfer_index(out);
        assert_eq!((d.edges_before, d.edges_after, d.removed_edges), (2, 1, 1));
        assert_eq!(out.events(), events);
        assert_eq!(out.binding(), binding);
        let edges = index_edges(&index, &out, &cfg.covered);
        assert_eq!(edges.len(), 1);
        assert_eq!((edges[0].1 .2, edges[0].2), (0, 30));
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        assert!(out.is_bound_to(&reader, &index, net.ptft_table().as_ref(), &cfg));
        let (again, d) = reduce_transfer_index(out);
        assert_eq!(d.removed_edges, 0);
        assert_eq!(index_edges(&index, &again, &cfg.covered), edges);
    }
}

#[test]
fn reduction_keeps_a_later_shorter_walk_for_m4() {
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (3, 1500), (4, 1800)]);
    net.ptft.extend([(1, 2, 90), (1, 3, 30)]);
    let cfg = config(0..10000, Mobility::Default);
    let (index, out) = build(&net, PatternMode::CoveringMerge, &cfg);
    let want = index_edges(&index, &out, &cfg.covered);
    let (out, d) = reduce_transfer_index(out);
    assert_eq!(d.removed_edges, 0);
    assert_eq!(index_edges(&index, &out, &cfg.covered), want);
}

#[test]
fn reduction_keeps_distinct_frequency_instances_of_a_loop() {
    let mut net = Net::new(4, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let looped = net.trip(1, &[(1, 1200), (2, 1300), (1, 1400), (3, 1500)]);
    net.freqs.push((looped, 1200, 1500, 100, 1));
    let cfg = config(0..10000, Mobility::Default);
    let (_, out) = build(&net, PatternMode::CoveringMerge, &cfg);
    let source = out
        .events()
        .iter()
        .position(|e| e.trip_idx == 0 && e.position == 1)
        .unwrap() as u32;
    assert_eq!(out.transfers_from(source).len(), 6);
    let (out, _) = reduce_transfer_index(out);
    let mut shifts: Vec<_> = out
        .transfers_from(source)
        .iter()
        .map(|e| out.events()[e.target as usize].frequency_offset_secs)
        .collect();
    shifts.sort_unstable();
    assert_eq!(shifts, [0, 100, 200]);
}

#[test]
fn unreduced_transfers_match_the_oracle_on_a_random_corpus() {
    const CASES: usize = 400;
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let mut kinds = [0usize; 6];
    let mut nonempty = 0;
    for case in 0..CASES {
        let mut net = random_net(&mut rng);
        if rng.chance(30) {
            // GTFS restrictions may differ across trips of the same route,
            // including trips with identical stop sequences.
            net.boarding = net
                .trips
                .iter()
                .flat_map(|t| t.rows.iter())
                .map(|_| match rng.below(7) {
                    0 => 0x51,
                    1 => 0x54,
                    _ => 0x50,
                })
                .collect();
        }
        let start = 50_000 + rng.below(30_000) as i64;
        let covered = start..start + 10_000 + rng.below(100_000) as i64;
        let mobility = if rng.chance(25) {
            Mobility::Wheelchair
        } else {
            Mobility::Default
        };
        let edges = check_case(&net, mobility, covered, &alloc::format!("case {case}"));
        nonempty += usize::from(!edges.is_empty());
        for e in &edges {
            kinds[e.3 as usize] += 1;
        }
    }
    assert!(nonempty > CASES / 2, "corpus too sparse: {nonempty}");
    assert!(
        kinds.iter().all(|&n| n > 0),
        "edge kinds not all exercised: {kinds:?}"
    );
}

#[test]
fn derived_only_random_corpus_matches_the_oracle_on_the_stop_index() {
    // Block derivation without explicit linked rows keeps the stop index, so
    // `check_case` compares every indexed lookup mode with the unreduced
    // oracle on these networks. Ordinary rules and frequencies stay random.
    const CASES: usize = 1_200;
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut derived_cases = 0;
    let mut derived_edges = 0;
    for case in 0..CASES {
        let mut net = random_net(&mut rng);
        net.derive = true;
        net.transfers.retain(|row| row.7 < 4);
        if rng.chance(30) {
            net.boarding = net
                .trips
                .iter()
                .flat_map(|t| t.rows.iter())
                .map(|_| match rng.below(7) {
                    0 => 0x51,
                    1 => 0x54,
                    _ => 0x50,
                })
                .collect();
        }
        let start = 50_000 + rng.below(30_000) as i64;
        let covered = start..start + 10_000 + rng.below(100_000) as i64;
        let mobility = if rng.chance(25) {
            Mobility::Wheelchair
        } else {
            Mobility::Default
        };
        let edges = check_case(
            &net,
            mobility,
            covered.clone(),
            &alloc::format!("case {case}"),
        );
        let derived = edges.iter().filter(|e| e.3 == OKind::Derived).count();
        if derived > 0 {
            assert!(stop_indexed(&net, mobility, &covered), "case {case}");
            derived_cases += 1;
            derived_edges += derived;
        }
    }
    assert!(
        derived_cases >= 20,
        "derived cases {derived_cases}, edges {derived_edges}"
    );
}

fn stop_indexed(net: &Net, mobility: Mobility, covered: &core::ops::Range<i64>) -> bool {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let table = net.ptft_table();
    let cfg = config(covered.clone(), mobility);
    let catalogue = build_event_index(&reader, &index, table.as_ref(), &cfg).unwrap();
    let mut q = query(0, 1, covered.start, 8);
    q.mobility = mobility;
    LazyPredecessors::new(
        &reader,
        &index,
        &catalogue,
        table.as_ref(),
        &q,
        LazyLookupConfig {
            mode: LazyLookupMode::StopIndexed,
            max_work: 100_000_000,
        },
    )
    .unwrap()
    .diagnostics()
    .stop_indexed
}

#[test]
fn unreduced_transfers_keep_a_later_shorter_walk_to_the_same_vehicle() {
    // Boarding at stop 2 is earlier but walks further than boarding the same
    // vehicle one stop later. Only M4 can prefer the second; both must remain.
    let mut net = Net::new(4, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (3, 1500), (0, 1800)]);
    net.ptft.extend([(1, 2, 90), (1, 3, 30)]);
    let edges = check(&net, Mobility::Default, 0..10_000);
    let to_target: Vec<_> = edges.iter().filter(|e| e.1 .0 == 1).collect();
    assert_eq!(to_target.len(), 2);
    assert_eq!((to_target[0].1 .2, to_target[0].2), (0, 90));
    assert_eq!((to_target[1].1 .2, to_target[1].2), (1, 30));
}

#[test]
fn unreduced_transfers_respect_a_trip_scoped_rule_per_vehicle() {
    // Two vehicles of one pattern leave together; transfers.txt forbids only
    // the second, so a per-pattern edge would leak the forbidden vehicle.
    let mut net = Net::new(3, 2);
    let feeder = net.trip(0, &[(0, 900), (1, 1000)]);
    let allowed = net.trip(1, &[(1, 1300), (2, 1600)]);
    let forbidden = net.trip(1, &[(1, 1300), (2, 1600)]);
    net.transfers
        .push((1, 1, ABSENT, ABSENT, feeder, forbidden, ABSENT, 3));
    let edges = check(&net, Mobility::Default, 0..10_000);
    let targets: Vec<u32> = edges.iter().map(|e| e.1 .0).collect();
    assert_eq!(targets, [allowed]);
}

#[test]
fn unreduced_transfers_keep_every_frequency_and_loop_occurrence() {
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let looping = net.trip(1, &[(1, 1200), (2, 1300), (1, 1400), (3, 1500)]);
    net.freqs.push((looping, 1200, 1500, 100, 1));
    let edges = check(&net, Mobility::Default, 0..10_000);
    let mut boards: Vec<(usize, i64)> = edges
        .iter()
        .filter(|e| e.0 .0 == 0 && e.1 .0 == looping)
        .map(|e| (e.1 .2, e.1 .3))
        .collect();
    boards.sort_unstable();
    // Three departures, each boardable at both visits of stop 1.
    assert_eq!(
        boards,
        [
            (0, 1200),
            (0, 1300),
            (0, 1400),
            (2, 1400),
            (2, 1500),
            (2, 1600)
        ]
    );
}

#[test]
fn unreduced_transfers_separate_in_seat_and_passenger_transfers() {
    let mut net = Net::new(3, 3);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    let seat = net.trip(1, &[(1, 1000), (2, 1100)]);
    let reboard = net.trip(2, &[(1, 1200), (2, 1300)]);
    net.transfers
        .push((1, 1, ABSENT, ABSENT, a, seat, ABSENT, 4));
    net.transfers
        .push((1, 1, ABSENT, ABSENT, a, reboard, 150, 5));
    let edges = check(&net, Mobility::Default, 0..10_000);
    let kinds: Vec<_> = edges.iter().map(|e| (e.1 .0, e.3)).collect();
    assert_eq!(kinds, [(seat, OKind::InSeat), (reboard, OKind::Linked)]);
    assert!(!OKind::InSeat.spends_transfer() && OKind::Linked.spends_transfer());
    assert!(!TransferKind::InSeat.spends_transfer() && TransferKind::Linked.spends_transfer());
    assert!(!TransferKind::Derived.spends_transfer());
}

#[test]
fn unreduced_transfers_keep_only_the_in_seat_continuation_without_drop_off() {
    // Trip `a` forbids drop-off at its terminal, so the arrival survives only
    // for its type-4 continuation; the later vehicle and the pickup-forbidden
    // vehicle are not boardable from it.
    let mut net = Net::new(3, 4);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    let seat = net.trip(1, &[(1, 1000), (2, 1100)]);
    net.trip(2, &[(1, 1300), (2, 1400)]);
    net.trip(3, &[(1, 1300), (2, 1400)]);
    net.transfers
        .push((1, 1, ABSENT, ABSENT, a, seat, ABSENT, 4));
    net.boarding = vec![0x50, 0x54, 0x50, 0x50, 0x50, 0x50, 0x51, 0x50];
    let edges = check(&net, Mobility::Default, 0..10_000);
    assert_eq!(edges.len(), 1);
    assert_eq!((edges[0].1 .0, edges[0].3), (seat, OKind::InSeat));
    // With drop-off allowed, the regular vehicle becomes boardable too.
    net.boarding[1] = 0x50;
    let targets: Vec<u32> = check(&net, Mobility::Default, 0..10_000)
        .iter()
        .map(|e| e.1 .0)
        .collect();
    assert_eq!(targets, [seat, 2]);
}

#[test]
fn derived_block_continuations_keep_the_stop_indexed_lookup_exact() {
    // Vehicle `a` ends at stop 1 (drop-off forbidden there) and starts trip
    // `seat` from the same stop; another vehicle leaves stop 1 later. A
    // derived continuation always links a terminal arrival to the next trip's
    // initial stop_time at that same stop, so `build` checks every indexed
    // mode against the unreduced oracle and the index must stay enabled.
    let mut net = Net::new(3, 3);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    let seat = net.trip(1, &[(1, 1060), (2, 1100)]);
    let other = net.trip(2, &[(1, 1300), (2, 1400)]);
    net.trips[a as usize].block = Some("v1");
    net.trips[seat as usize].block = Some("v1");
    net.boarding = vec![0x50, 0x54, 0x50, 0x50, 0x50, 0x50];
    net.derive = true;
    let covered = 0..10_000;
    let edges = check(&net, Mobility::Default, covered.clone());
    let kinds: Vec<_> = edges.iter().map(|e| (e.0 .0, e.1 .0, e.3)).collect();
    assert_eq!(kinds, [(a, seat, OKind::Derived)]);

    let indexed = |net: &Net| -> Vec<bool> {
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let table = net.ptft_table();
        let cfg = config(covered.clone(), Mobility::Default);
        let catalogue = build_event_index(&reader, &index, table.as_ref(), &cfg).unwrap();
        let q = query(0, 2, covered.start, 4);
        [
            LazyLookupMode::StopIndexed,
            LazyLookupMode::PlainFast,
            LazyLookupMode::PlainCached,
            LazyLookupMode::PlainCachedPacked,
        ]
        .into_iter()
        .map(|mode| {
            LazyPredecessors::new(
                &reader,
                &index,
                &catalogue,
                table.as_ref(),
                &q,
                LazyLookupConfig {
                    mode,
                    max_work: 1_000_000,
                },
            )
            .unwrap()
            .diagnostics()
            .stop_indexed
        })
        .collect()
    };
    assert_eq!(indexed(&net), [true; 4]);

    // An explicit linked rule may join two different stops, so linked feeds
    // keep global sources.
    net.transfers
        .push((1, 1, ABSENT, ABSENT, a, other, ABSENT, 4));
    assert_eq!(indexed(&net), [false; 4]);
}

#[test]
fn unreduced_transfers_rescale_wheelchair_walks_and_filter_modes() {
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1500), (0, 1800)]);
    net.ptft.push((1, 2, 100));
    let walk = |m| check(&net, m, 0..10_000)[0].2;
    assert_eq!(walk(Mobility::Default), 100);
    assert_eq!(
        walk(Mobility::Wheelchair),
        crate::engine::consts::rescale_walk_secs(
            100,
            crate::engine::consts::WHEELCHAIR_WALK_SPEED_MM_S
        ) as u64
    );
    let mut cfg = config(0..10_000, Mobility::Default);
    cfg.excluded_modes = vec![3];
    let (_, out) = build(&net, PatternMode::CoveringMerge, &cfg);
    assert_eq!(out.diagnostics().events, 0);
}

#[test]
fn transfer_index_flags_inaccessible_stops_for_wheelchair_users() {
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 900), (1, 1000), (2, 1100)]);
    net.trip(1, &[(1, 1200), (2, 1300)]);
    let mut bytes = net.bytes();
    crate::engine::testkit::set_stop_wheelchair(&mut bytes, 1, 2);
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    for (mobility, edges) in [(Mobility::Default, 1), (Mobility::Wheelchair, 0)] {
        let out =
            build_transfer_index(&reader, &index, None, &config(0..10_000, mobility)).unwrap();
        assert_eq!(out.diagnostics().edges, edges, "{mobility:?}");
        let at_stop_1 = out
            .events()
            .iter()
            .filter(|e| index.routes[e.route_idx as usize].stop_ids[e.position as usize] == 1);
        for ev in at_stop_1 {
            let accessible = mobility == Mobility::Default;
            assert_eq!(ev.can_alight(), accessible);
            assert_eq!(ev.can_board(), accessible);
        }
    }
}

#[test]
fn transfer_index_build_limits_are_typed_and_checked_before_growth() {
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1200), (2, 1300)]);
    net.trip(1, &[(1, 1400), (2, 1500)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let try_build = |cfg: &TransferIndexConfig| build_transfer_index(&reader, &index, None, cfg);
    let full = try_build(&config(0..10_000, Mobility::Default)).unwrap();
    let d = full.diagnostics();
    assert_eq!((d.events, d.edges), (6, 2));
    let mut cfg = config(0..10_000, Mobility::Default);
    cfg.limits.max_events = 5;
    assert_eq!(
        try_build(&cfg).err(),
        Some(TransferIndexError::EventsExhausted {
            limit: 5,
            attempted: 6
        })
    );
    let mut cfg = config(0..10_000, Mobility::Default);
    cfg.limits.max_edges = 1;
    assert_eq!(
        try_build(&cfg).err(),
        Some(TransferIndexError::EdgesExhausted {
            limit: 1,
            attempted: 2
        })
    );
    let mut cfg = config(0..10_000, Mobility::Default);
    cfg.limits.max_bytes = d.index_bytes - 1;
    assert!(matches!(
        try_build(&cfg),
        Err(TransferIndexError::BytesExhausted { limit, .. }) if limit == d.index_bytes - 1
    ));
    cfg.limits.max_bytes = d.peak_build_bytes;
    assert!(try_build(&cfg).is_ok());
    assert_eq!(
        try_build(&config(5..5, Mobility::Default)).err(),
        Some(TransferIndexError::InvalidConfig(
            "covered interval must be non-empty"
        ))
    );
}

#[test]
fn transfer_index_rejects_intervals_without_complete_service_dates() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    // QDATE is ordinal 3 of 8; day -1 and day 8 events are not in the bundle.
    for covered in [-3 * 86_400..-3 * 86_400 + 1_000, 0..5 * 86_400 + 1_000] {
        assert_eq!(
            build_transfer_index(&reader, &index, None, &config(covered, Mobility::Default)).err(),
            Some(TransferIndexError::Engine(EngineError::IncompleteHorizon))
        );
    }
    let mut cfg = config(0..1_000, Mobility::Default);
    cfg.service_date = 20261020;
    assert_eq!(
        build_transfer_index(&reader, &index, None, &cfg).err(),
        Some(TransferIndexError::Engine(
            EngineError::UnsupportedServiceDate
        ))
    );
}

#[test]
fn transfer_index_is_bound_to_its_bundle_walks_layout_and_configuration() {
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (0, 1300)]);
    net.ptft.push((1, 2, 60));
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let table = net.ptft_table();
    let cfg = config(0..10_000, Mobility::Default);
    let out = build_transfer_index(&reader, &index, table.as_ref(), &cfg).unwrap();
    assert!(out.is_bound_to(&reader, &index, table.as_ref(), &cfg));
    assert!(!out.is_bound_to(&reader, &index, None, &cfg));
    let mut walks = net.clone();
    walks.ptft[0].2 = 61;
    assert!(!out.is_bound_to(&reader, &index, walks.ptft_table().as_ref(), &cfg));
    for changed in [
        config(0..10_001, Mobility::Default),
        config(0..10_000, Mobility::Wheelchair),
        TransferIndexConfig {
            excluded_modes: vec![1],
            ..cfg.clone()
        },
        TransferIndexConfig {
            walk_speed_mm_s: core::num::NonZeroU32::new(600),
            ..cfg.clone()
        },
        TransferIndexConfig {
            min_transfer_secs: Some(300),
            ..cfg.clone()
        },
    ] {
        assert!(!out.is_bound_to(&reader, &index, table.as_ref(), &changed));
    }
    // Explicit defaults have the same effective settings as omitted fields.
    let explicit = TransferIndexConfig {
        walk_speed_mm_s: core::num::NonZeroU32::new(1_250),
        min_transfer_secs: Some(120),
        ..cfg.clone()
    };
    assert!(out.is_bound_to(&reader, &index, table.as_ref(), &explicit));
    // Limits bound the build, not the result.
    let mut limits = cfg.clone();
    limits.limits.max_edges = 1_000;
    assert!(out.is_bound_to(&reader, &index, table.as_ref(), &limits));
    let mut timetable = net.clone();
    timetable.trips[1].rows[0].1 = 1250;
    let other = Reader::from_bytes(timetable.bytes()).unwrap();
    let other_index = Index::build(&other, PatternMode::CoveringMerge).unwrap();
    assert!(!out.is_bound_to(&other, &other_index, table.as_ref(), &cfg));
}

#[test]
fn transfer_binding_distinguishes_folded_occurrences_with_identical_route_and_trip_order() {
    let mut net = Net::new(4, 1);
    net.trip(
        0,
        &[
            (0, 900),
            (1, 1000),
            (2, 1100),
            (1, 1200),
            (0, 1300),
            (3, 1400),
        ],
    );
    net.trip(0, &[(1, 100), (0, 200), (3, 300)]);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let folded = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let off = Index::build(&reader, PatternMode::Off).unwrap();
    assert_eq!(folded.routes.len(), off.routes.len());
    assert_eq!(folded.routes[0].stop_ids, off.routes[0].stop_ids);
    assert_eq!(
        folded.routes[0]
            .trips
            .iter()
            .map(|t| t.trip_idx)
            .collect::<Vec<_>>(),
        off.routes[0]
            .trips
            .iter()
            .map(|t| t.trip_idx)
            .collect::<Vec<_>>()
    );
    let cfg = config(0..200000, Mobility::Default);
    let table = build_transfer_index(&reader, &folded, None, &cfg).unwrap();
    assert!(!table.is_bound_to(&reader, &off, None, &cfg));
    let rebuilt = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    assert!(table.is_bound_to(&reader, &rebuilt, None, &cfg));
    let q = query(1, 3, 100, 1);
    use crate::engine::temporal_probe::trip_based::{
        profile_trip_m4, TripProfileError, TripProfileRequest,
    };
    assert!(matches!(
        profile_trip_m4(&reader, &off, &table, TripProfileRequest::new(&q, 100..101)),
        Err(TripProfileError::BindingMismatch)
    ));
    let (table, _) = reduce_transfer_index(table);
    assert!(!table.is_bound_to(&reader, &off, None, &cfg));
}

#[test]
fn transfer_lookup_uses_the_riders_walk_speed_and_minimum_transfer() {
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (0, 1300)]);
    net.ptft.push((1, 2, 100));
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        for (speed, floor, expected) in [
            (1_250, 120, Some((100, 120))),
            (625, 120, Some((200, 200))),
            (500, 120, None),
            (1_250, 201, None),
            (1_250, 0, Some((100, 100))),
        ] {
            let cfg = TransferIndexConfig {
                walk_speed_mm_s: core::num::NonZeroU32::new(speed),
                min_transfer_secs: Some(floor),
                ..config(800..1400, Mobility::Default)
            };
            // build compares every lazy mode and its bounded cached lookups
            // with the unreduced graph, including complete edge records.
            let (_, out) = build(&net, mode, &cfg);
            let edges: Vec<_> = (0..out.events().len())
                .flat_map(|source| out.transfers_from(source as u32))
                .filter(|edge| edge.kind == TransferKind::Footpath)
                .map(|edge| (edge.walk_secs, edge.elapsed_secs))
                .collect();
            assert_eq!(
                edges,
                expected.into_iter().collect::<Vec<_>>(),
                "{mode:?} speed={speed} floor={floor}"
            );
        }
    }
}
