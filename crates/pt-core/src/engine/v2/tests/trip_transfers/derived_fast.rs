//! Derived-aware cheap lookup against the independent raw boarding oracle.
//! A block edge belongs only to its concrete terminal/start pair, not every
//! occurrence at the same physical stop. GTFS loop/lasso examples:
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
use super::*;

fn network(layover: u32, restricted: bool) -> Net {
    let mut n = Net::new(4, 4);
    let a = n.trip(0, &[(0, 700), (1, 800), (0, 900), (1, 1000)]);
    let b = n.trip(1, &[(1, 1000 + layover), (2, 1300), (1, 1400), (3, 1600)]);
    n.trip(2, &[(0, 500), (1, 600)]); // ordinary predecessor
    n.trip(3, &[(0, 920), (1, 950)]); // too late unless the floor is met
    n.trips[a as usize].block = Some("fast");
    n.trips[b as usize].block = Some("fast");
    n.derive = true;
    if restricted {
        // Last arrival cannot alight; the continuation's first stop cannot
        // pick up. Both still participate in the derived in-seat edge.
        n.boarding = vec![0x50; 12];
        n.boarding[3] = 0x54;
        n.boarding[4] = 0x51;
    }
    n
}

#[test]
fn derived_plain_fast_keeps_boundary_pairs_and_ordinary_choices_exact() {
    for layover in [0, 1, 60, 119, 120] {
        for restricted in [false, true] {
            let n = network(layover, restricted);
            let edges = check(&n, Mobility::Default, 0..10000);
            assert!(edges.iter().any(|e| e.3 == OKind::Derived));
            for mode in [
                PatternMode::Off,
                PatternMode::Unbounded,
                PatternMode::CoveringMerge,
            ] {
                let reader = Reader::from_bytes(n.bytes()).unwrap();
                let index = Index::build(&reader, mode).unwrap();
                let events =
                    build_event_index(&reader, &index, None, &config(0..10000, Mobility::Default))
                        .unwrap();
                let q = query(0, 3, 0, 4);
                let mut lazy = LazyPredecessors::new(
                    &reader,
                    &index,
                    &events,
                    None,
                    &q,
                    LazyLookupConfig {
                        mode: LazyLookupMode::PlainCached,
                        max_work: 100000,
                    },
                )
                .unwrap();
                for target in 0..events.events().len() {
                    lazy.incoming(target as u32).unwrap();
                }
                let d = lazy.diagnostics();
                assert!(
                    d.plain_pair_checks > 0,
                    "cheap ordinary pairs must stay on: {mode:?}"
                );
                assert!(
                    d.fallback_pair_checks > 0,
                    "derived pairs keep the exact resolver"
                );
            }
        }
    }
}

#[test]
fn derived_plain_fast_filters_added_rows_and_charges_every_cap_boundary() {
    let n = network(60, true);
    let reader = Reader::from_bytes(n.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let cfg = config(0..10000, Mobility::Default);
    let events = build_event_index(&reader, &index, None, &cfg).unwrap();
    let table = build_transfer_index(&reader, &index, None, &cfg).unwrap();
    let q = query(0, 3, 0, 4);
    let target = events
        .events()
        .iter()
        .position(|e| e.trip_idx == 1 && e.position == 0)
        .unwrap() as u32;
    let expected: Vec<_> = (0..events.events().len())
        .flat_map(|source| {
            table
                .transfers_from(source as u32)
                .iter()
                .filter(move |e| e.target == target)
                .map(move |e| IncomingTransfer {
                    source: source as u32,
                    walk_secs: e.walk_secs,
                    elapsed_secs: e.elapsed_secs,
                    kind: e.kind,
                })
        })
        .collect();
    assert_eq!(expected.len(), 1);
    let execute = |cap, bound, cut| {
        let mut lazy = LazyPredecessors::new(
            &reader,
            &index,
            &events,
            None,
            &q,
            LazyLookupConfig {
                mode: LazyLookupMode::PlainCached,
                max_work: cap,
            },
        )?;
        let out = lazy
            .incoming_row_certified_for_test(target, Some(&[bound; 4]), |arrival| arrival < cut)?;
        Ok::<_, LazyLookupError>((out, lazy.diagnostics()))
    };
    for bound in [i64::MIN, 1000, 1001, i64::MAX] {
        for cut in [i64::MIN, 1000, 1001, i64::MAX] {
            let (out, d) = execute(100000, bound, cut).unwrap();
            let want: Vec<_> = expected
                .iter()
                .copied()
                .filter(|e| {
                    let at = events.events()[e.source as usize].arrival_secs;
                    at >= bound && at >= cut
                })
                .collect();
            assert_eq!(out, want, "bound {bound} cut {cut}");
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
            for cap in 1..=d.work + 1 {
                match execute(cap, bound, cut) {
                    Ok((actual, _)) => {
                        assert!(cap >= d.work);
                        assert_eq!(actual, want);
                    }
                    Err(LazyLookupError::WorkExhausted { limit, attempted }) => {
                        assert_eq!(limit, cap);
                        assert_eq!(attempted, cap + 1);
                        assert!(cap < d.work);
                    }
                    Err(error) => panic!("unexpected error {error:?}"),
                }
            }
        }
    }
}

#[test]
fn derived_plain_fast_keeps_date_gates_frequency_exclusion_and_rule_fallback() {
    let mut n = network(60, true);
    // The continuation is active on query day (ordinal 3), not the next day.
    n.services.push(0b1110_1111);
    n.trips[1].service = 1;
    let edges = check(&n, Mobility::Default, 0..180000);
    assert!(edges.iter().any(|e| e.3 == OKind::Derived));
    assert!(edges
        .iter()
        .filter(|e| e.3 == OKind::Derived)
        .all(|e| e.1 .1 != 4));
    check(&n, Mobility::Wheelchair, 0..180000);
    n.trips[1].wheelchair = 2;
    assert!(!check(&n, Mobility::Wheelchair, 0..180000)
        .iter()
        .any(|e| e.3 == OKind::Derived));
    n.trips[1].wheelchair = 0;
    n.transfers.push((1, 1, ABSENT, ABSENT, 0, 1, ABSENT, 3));
    assert!(!check(&n, Mobility::Default, 0..180000)
        .iter()
        .any(|e| e.3 == OKind::Derived));
    n.transfers.clear();
    n.freqs.push((1, 1060, 1261, 100, 1));
    assert!(!check(&n, Mobility::Default, 0..180000)
        .iter()
        .any(|e| e.3 == OKind::Derived));
}

#[test]
fn derived_plain_fast_generated_networks_match_the_raw_edge_oracle() {
    let mut rng = Rng(0x4445_5249_5646_4153);
    let mut derived = 0;
    for case in 0..240 {
        let mut n = random_net(&mut rng);
        n.transfers.clear();
        n.derive = true;
        // Add a guaranteed derived-only pair with its own route shapes/block;
        // random walks, existing frequencies, services and strip layout remain.
        let t = 70000 + rng.below(5000) as u32;
        let a = n.trip(n.n_routes, &[(0, t), (1, t + 100)]);
        n.n_routes += 1;
        let b = n.trip(
            n.n_routes,
            &[(1, t + 100 + rng.below(121) as u32), (2, t + 500)],
        );
        n.n_routes += 1;
        n.trips[a as usize].block = Some("fast");
        n.trips[b as usize].block = Some("fast");
        let mobility = if rng.chance(30) {
            Mobility::Wheelchair
        } else {
            Mobility::Default
        };
        let edges = check_case(
            &n,
            mobility,
            68000..180000,
            &alloc::format!("derived-fast {case}"),
        );
        derived += usize::from(edges.iter().any(|e| e.3 == OKind::Derived));
    }
    assert_eq!(derived, 240);
}
