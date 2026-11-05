use super::*;

fn config() -> DeadlineSessionConfig {
    let mut c = DeadlineSessionConfig::new(900..1200, 1314);
    c.lookup = LazyLookupMode::PlainCached;
    c.pruning = DeadlinePruning::EarliestPrefixAndTimetablePoints;
    c.traversal = DeadlineTraversal::ArrivalFirst;
    c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
    c
}

#[test]
fn owner_binding_recomputes_configuration_keeps_caps_and_survives_only_owner_lifetime() {
    let net = lattice(3, 1, false);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let make = |retain| {
            let construct = if retain {
                DeadlineSession::new_with_immutable_binding
            } else {
                DeadlineSession::new
            };
            construct(
                Reader::from_bytes(net.bytes()).unwrap(),
                mode,
                net.ptft_table(),
            )
            .unwrap()
        };
        let (mut control, mut retained) = (make(false), make(true));
        assert_eq!(control.retained_binding_bytes(), 0);
        assert!(retained.retained_binding_bytes() > 0);
        assert!(
            DeadlineSession::immutable_binding_slot_bytes() >= retained.retained_binding_bytes()
        );
        assert!(
            DeadlineSession::owner_storage_bytes()
                > DeadlineSession::immutable_binding_slot_bytes()
        );
        for case in 0..17 {
            let mut q = query(0, 2, 900, 2);
            let mut c = config();
            match case {
                1 => q.date += 1,
                2 => c.window.start += 1,
                3 => c.window.end -= 1,
                4 => c.arrival_deadline += 100,
                5 => q.mobility = Mobility::Wheelchair,
                6 => q.mobility = Mobility::Bicycle,
                7 => q.excluded_modes = vec![3],
                8 => q.excluded_modes = vec![700, 3, 700],
                9 => q.entry_stops[0].walk_secs += 1,
                10 => q.exit_stops[0].walk_secs += 1,
                11 => q.max_rounds = Some(0),
                12 => c.max_lookup_work = 1,
                13 => c.max_stop_scans = 1,
                14 => c.max_segments = 1,
                15 => q.entry_stops[0].stop = u32::MAX,
                16 => c.window.end = c.window.start,
                _ => {}
            }
            for prefix in [false, true] {
                for reuse in [false, true] {
                    if prefix && reuse {
                        continue;
                    }
                    let prepare = |s: &mut DeadlineSession| {
                        if prefix {
                            s.prepare_with_prefix_cache(q.clone(), c.clone())
                        } else if reuse {
                            s.prepare_reusing(q.clone(), c.clone())
                        } else {
                            s.prepare(q.clone(), c.clone())
                        }
                    };
                    assert_eq!(prepare(&mut control), prepare(&mut retained));
                    assert_eq!(control.catalogue_binding(), retained.catalogue_binding());
                    assert_eq!(control.catalogue_key(), retained.catalogue_key());
                    assert_eq!(control.catalogue_reused(), retained.catalogue_reused());
                    for pref in DeadlinePreference::ALL {
                        let a = control.run_preference_with_phases(
                            pref,
                            DeadlineSuffixPruning::RowPrefix,
                            |_| {},
                        );
                        let b = retained.run_preference_with_phases(
                            pref,
                            DeadlineSuffixPruning::RowPrefix,
                            |_| {},
                        );
                        match (a, b) {
                            (Ok(a), Ok(b)) => {
                                assert_eq!(a.winner, b.winner);
                                assert_eq!(a.diagnostics, b.diagnostics);
                                assert_eq!(a.frontiers, b.frontiers);
                                assert_eq!(a.selection, b.selection);
                            }
                            (Err(a), Err(b)) => assert_eq!(a, b),
                            other => panic!("owner binding changes result: {other:?}"),
                        }
                    }
                }
            }
        }
        let bytes = retained.retained_binding_bytes();
        retained.clear();
        assert!(retained.run().is_err());
        assert_eq!(retained.catalogue_binding(), None);
        assert_eq!(retained.retained_binding_bytes(), bytes);
        let mut phases = Vec::new();
        retained
            .prepare_with_phases(query(0, 2, 900, 2), config(), |p| phases.push(p))
            .unwrap();
        assert!(phases.contains(&DeadlineSetupPhase::ImmutableBindingReused));
        for p in [
            DeadlineSetupPhase::PtbHashed,
            DeadlineSetupPhase::TransfersHashed,
            DeadlineSetupPhase::LayoutHashed,
        ] {
            assert!(!phases.contains(&p));
        }
        assert_eq!(phases.last(), Some(&DeadlineSetupPhase::Completed));
        let fresh = make(false);
        assert_eq!(fresh.retained_binding_bytes(), 0);
        assert!(fresh.run().is_err());
    }
}

#[test]
fn owner_binding_matches_generic_and_generic_checks_reject_changed_semantic_inputs() {
    let mut net = Net::new(3, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(1, 1200), (2, 1300)]);
    net.ptft.push((0, 1, 50));
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let walks = net.ptft_table();
        let cfg = TransferIndexConfig::new(QDATE, 900..1315);
        let events = build_event_index(&reader, &index, walks.as_ref(), &cfg).unwrap();
        let mut owner = DeadlineSession::new_with_immutable_binding(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        owner.prepare(query(0, 2, 900, 2), config()).unwrap();
        assert_eq!(owner.catalogue_binding(), Some(events.binding()));
        assert!(events.is_bound_to(&reader, &index, walks.as_ref(), &cfg));
        let mut changed = net.clone();
        changed.trips[0].rows[0].1 += 1;
        let other = Reader::from_bytes(changed.bytes()).unwrap();
        let other_index = Index::build(&other, mode).unwrap();
        assert!(!events.is_bound_to(&other, &other_index, walks.as_ref(), &cfg));
        changed = net.clone();
        changed.ptft[0].2 += 1;
        assert!(!events.is_bound_to(&reader, &index, changed.ptft_table().as_ref(), &cfg));
        let mut layout = Index::build(&reader, mode).unwrap();
        layout.routes[0].trips[0].pos_to_row[0] = -1;
        assert!(!events.is_bound_to(&reader, &layout, walks.as_ref(), &cfg));
        let mut settings = cfg.clone();
        settings.mobility = Mobility::Wheelchair;
        assert!(!events.is_bound_to(&reader, &index, walks.as_ref(), &settings));
    }
}

#[test]
fn owner_construction_markers_are_ordered_and_change_nothing() {
    let net = lattice(3, 1, false);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let reader = || Reader::from_bytes(net.bytes()).unwrap();
        let mut phases = Vec::new();
        let mut observed = DeadlineSession::new_with_immutable_binding_and_phases(
            reader(),
            mode,
            net.ptft_table(),
            |p| phases.push(p),
        )
        .unwrap();
        assert_eq!(
            phases,
            [
                DeadlineSetupPhase::IndexBuilt,
                DeadlineSetupPhase::TripSpansBuilt,
                DeadlineSetupPhase::PtbHashed,
                DeadlineSetupPhase::TransfersHashed,
                DeadlineSetupPhase::LayoutHashed,
            ]
        );
        let mut plain =
            DeadlineSession::new_with_immutable_binding(reader(), mode, net.ptft_table()).unwrap();
        assert_eq!(
            observed.retained_binding_bytes(),
            plain.retained_binding_bytes()
        );
        observed.prepare(query(0, 2, 900, 2), config()).unwrap();
        plain.prepare(query(0, 2, 900, 2), config()).unwrap();
        assert_eq!(observed.catalogue_binding(), plain.catalogue_binding());
        assert_eq!(observed.catalogue_key(), plain.catalogue_key());
        let (a, b) = (observed.run().unwrap(), plain.run().unwrap());
        assert_eq!(a.points, b.points);
        assert_eq!(a.complete, b.complete);
        assert_eq!(a.diagnostics, b.diagnostics);
        assert_eq!(a.frontiers, b.frontiers);
    }
}
