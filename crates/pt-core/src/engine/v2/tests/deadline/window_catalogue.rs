//! H70: a request catalogue cut in place from a held window catalogue equals
//! the one built fresh: same events, flags, arrival index, diagnostics
//! (including the fresh build's peak bytes), binding and errors. Requests the
//! window cannot stand in for take the fresh path, and the window is never
//! held beside a request catalogue. H83: the copying slice gives the same
//! outcome as the in-place one and leaves its source intact.
use super::*;
use core::ops::Range;
use std::eprintln;

/// Request intervals: the three 4 h scopes, a single second, the whole day,
/// a short test-network window, and two that leave the service day.
const REQUESTS: [Range<i64>; 8] = [
    21_600..36_001,
    43_200..57_600,
    64_800..79_200,
    1_000..1_001,
    0..86_400,
    900..1_314,
    -3_600..3_600,
    100_000..110_000,
];

/// Windows around request `c`, each with whether it contains `c`: the phone
/// shape (15 min either side) and a forward "depart now" margin; with `all`,
/// also `c` itself, the whole 30 h day and two that miss `c` by one second.
fn windows(c: &Range<i64>, all: bool) -> Vec<(Range<i64>, bool)> {
    let mut out = vec![
        (c.start - 900..c.end + 900, true),
        (c.start..c.end + 1_800, true),
    ];
    if all {
        let day = 0..30 * 3_600;
        let inside = day.start <= c.start && c.end <= day.end;
        out.extend([
            (c.clone(), true),
            (day, inside),
            (c.start + 1..c.end + 1_800, false),
            (c.start - 1_800..c.end - 1, false),
        ]);
    }
    out
}

/// Compares one request against the fresh build by the copying slice (H83),
/// then by the in-place one (H70); returns whether a slice was compared.
fn assert_slice_matches<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    cfg: &TransferIndexConfig,
    fresh: &Result<EventIndex, TransferIndexError>,
    window_cfg: &TransferIndexConfig,
    window: EventIndex,
    inside: bool,
) -> bool {
    let before = window.clone();
    let copied = slice_copy_for_test(reader, index, cfg, window_cfg, &window);
    assert!(window == before, "a copying slice leaves its source intact");
    let copy = assert_outcome_matches(reader, fresh, copied, inside);
    let taken = assert_outcome_matches(
        reader,
        fresh,
        take_slice_for_test(reader, index, cfg, window_cfg, window),
        inside,
    );
    assert_eq!(copy, taken);
    taken
}

fn assert_outcome_matches<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    fresh: &Result<EventIndex, TransferIndexError>,
    sliced: Result<Option<EventIndex>, TransferIndexError>,
    inside: bool,
) -> bool {
    match (fresh, sliced) {
        (_, Ok(None)) => {
            assert!(!inside, "a request inside the window must be sliced");
            false
        }
        (Ok(a), Ok(Some(b))) => {
            assert!(inside);
            assert_eq!(a.events(), b.events());
            assert_eq!(a.diagnostics(), b.diagnostics());
            assert_eq!(a.binding(), b.binding());
            assert_eq!(a.covered(), b.covered());
            for stop in 0..=reader.num_stops() as u32 {
                assert_eq!(a.arrivals_at_stop(stop), b.arrivals_at_stop(stop));
            }
            true
        }
        (Err(a), Err(b)) => {
            assert_eq!(a, &b);
            false
        }
        (a, b) => panic!(
            "slicing changes the outcome: fresh ok={} sliced={:?}",
            a.is_ok(),
            b.as_ref().map(|s| s.is_some()).map_err(|e| e.clone())
        ),
    }
}

/// Returns (window catalogues built, slices compared).
fn sweep<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    dates: &[u32],
    all: bool,
) -> (usize, usize) {
    let (mut built, mut slices) = (0, 0);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        // A derived-block bundle commits to its producer's pattern mode; other
        // modes fail `Index::build` with `IndexBundleMismatch` and are skipped.
        let index = match Index::build(reader, mode) {
            Ok(index) => index,
            Err(EngineError::IndexBundleMismatch) => continue,
            Err(e) => panic!("index: {e:?}"),
        };
        for &date in dates {
            for mobility in [Mobility::Default, Mobility::Wheelchair] {
                let at = |covered: Range<i64>| TransferIndexConfig {
                    mobility,
                    ..TransferIndexConfig::new(date, covered)
                };
                for c in REQUESTS {
                    let cfg = at(c.clone());
                    let fresh = build_event_index(reader, &index, None, &cfg);
                    for (w, inside) in windows(&c, all) {
                        let window_cfg = at(w);
                        let Ok(window) =
                            build_window_event_index_for_test(reader, &index, &window_cfg)
                        else {
                            continue;
                        };
                        built += 1;
                        let compared = assert_slice_matches(
                            reader,
                            &index,
                            &cfg,
                            &fresh,
                            &window_cfg,
                            window,
                            inside,
                        );
                        slices += usize::from(compared);
                    }
                }
                // Another key or other limits never take the slice.
                let window_cfg = at(20_700..36_901);
                let Ok(window) = build_window_event_index_for_test(reader, &index, &window_cfg)
                else {
                    continue;
                };
                let other = TransferIndexConfig {
                    mobility: match mobility {
                        Mobility::Default => Mobility::Wheelchair,
                        _ => Mobility::Default,
                    },
                    ..TransferIndexConfig::new(date, 21_600..36_001)
                };
                let mut limits = at(21_600..36_001);
                limits.limits.max_edges -= 1;
                let modes = TransferIndexConfig {
                    excluded_modes: vec![3],
                    ..at(21_600..36_001)
                };
                let next_day = TransferIndexConfig {
                    service_date: crate::reader::days_add(date, 1),
                    ..at(21_600..36_001)
                };
                let speed = TransferIndexConfig {
                    walk_speed_mm_s: core::num::NonZeroU32::new(600),
                    ..at(21_600..36_001)
                };
                let floor = TransferIndexConfig {
                    min_transfer_secs: Some(300),
                    ..at(21_600..36_001)
                };
                for cfg in [other, limits, modes, next_day, speed, floor] {
                    let copied = slice_copy_for_test(reader, &index, &cfg, &window_cfg, &window);
                    assert!(copied.unwrap().is_none());
                    let sliced =
                        take_slice_for_test(reader, &index, &cfg, &window_cfg, window.clone());
                    assert!(sliced.unwrap().is_none());
                }
            }
        }
    }
    (built, slices)
}

fn feed_dates<B: AsRef<[u8]> + Send + Sync + 'static>(reader: &Reader<B>) -> Vec<u32> {
    let days = reader.num_service_day_origins().saturating_sub(1);
    (0..days)
        .map(|d| crate::reader::days_add(reader.feed_start_date(), d as i64))
        .collect()
}

#[test]
fn window_slices_keep_test_network_catalogues() {
    for net in [lattice(3, 1, false), lattice(4, 2, true)] {
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let (built, slices) = sweep(&reader, &feed_dates(&reader), true);
        assert!(built > 0 && slices > 0, "built={built} slices={slices}");
    }
}

#[test]
fn window_slices_keep_committed_fixture_catalogues() {
    // tiny-v2 is the committed v2 fixture; the event catalogue needs PTB v2.
    let bytes =
        include_bytes!("../../../../../../../packages/shared/src/ptb/__fixtures__/tiny-v2.ptb");
    let reader = Reader::from_bytes(bytes.to_vec()).unwrap();
    let (built, slices) = sweep(&reader, &feed_dates(&reader), true);
    assert!(built > 0 && slices > 0, "built={built} slices={slices}");
}

#[test]
fn a_failed_window_build_holds_nothing_and_clear_drops_the_window() {
    let net = lattice(3, 1, false);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let mut window_cfg = TransferIndexConfig::new(QDATE, 600..1_500);
    window_cfg.limits.max_events = 1;
    assert!(matches!(
        build_window_event_index_for_test(&reader, &index, &window_cfg),
        Err(TransferIndexError::EventsExhausted { .. })
    ));
    let mut owner = DeadlineSession::new(reader, PatternMode::CoveringMerge, None).unwrap();
    assert!(owner
        .prepare_window(19_000_101, Mobility::Default, vec![], 600..1_500)
        .is_err());
    assert_eq!(owner.window_catalogue_bytes(), 0);
    owner
        .prepare_window(QDATE, Mobility::Default, vec![], 600..1_500)
        .unwrap();
    let one = owner.window_catalogue_bytes();
    assert!(one > 0);
    // A repeated call replaces the held window.
    owner
        .prepare_window(QDATE, Mobility::Default, vec![], 600..1_500)
        .unwrap();
    assert_eq!(owner.window_catalogue_bytes(), one);
    owner.clear();
    assert_eq!(owner.window_catalogue_bytes(), 0);
}

fn session_config() -> DeadlineSessionConfig {
    let mut c = DeadlineSessionConfig::new(900..1200, 1314);
    c.lookup = LazyLookupMode::PlainCached;
    c.pruning = DeadlinePruning::EarliestPrefixAndTimetablePoints;
    c.traversal = DeadlineTraversal::ArrivalFirst;
    c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
    c
}

#[test]
fn requests_with_a_window_catalogue_match_fresh_requests() {
    let net = lattice(4, 2, true);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let reader = || Reader::from_bytes(net.bytes()).unwrap();
        let mut win =
            DeadlineSession::new_with_immutable_binding(reader(), mode, net.ptft_table()).unwrap();
        let mut plain =
            DeadlineSession::new_with_immutable_binding(reader(), mode, net.ptft_table()).unwrap();
        for (wheelchair, prefix) in [(false, false), (false, true), (true, false)] {
            let mut phases = Vec::new();
            win.prepare_window_with_phases(QDATE, Mobility::Default, vec![], 600..1_500, |p| {
                phases.push(p)
            })
            .unwrap();
            assert_eq!(
                phases.last(),
                Some(&DeadlineSetupPhase::WindowCatalogueBuilt)
            );
            assert!(win.window_catalogue_bytes() > 0);
            let mut q = query(0, 2, 900, 2);
            if wheelchair {
                q.mobility = Mobility::Wheelchair;
            }
            let mut phases = Vec::new();
            let (a, b) = if prefix {
                (
                    win.prepare_with_prefix_cache_and_phases(q.clone(), session_config(), |p| {
                        phases.push(p)
                    }),
                    plain.prepare_with_prefix_cache(q, session_config()),
                )
            } else {
                (
                    win.prepare_with_phases(q.clone(), session_config(), |p| phases.push(p)),
                    plain.prepare(q, session_config()),
                )
            };
            assert_eq!(a, b);
            let sliced = phases.contains(&DeadlineSetupPhase::CatalogueSliced);
            assert_eq!(sliced, !wheelchair, "only the held key is sliced");
            assert_eq!(
                phases.contains(&DeadlineSetupPhase::EventsEnumerated),
                wheelchair
            );
            // Taken over or dropped: never held beside the request's catalogue.
            assert_eq!(win.window_catalogue_bytes(), 0);
            assert_eq!(win.catalogue_binding(), plain.catalogue_binding());
            assert_eq!(win.catalogue_key(), plain.catalogue_key());
            let (a, b) = (win.run().unwrap(), plain.run().unwrap());
            assert_eq!(a.points, b.points);
            assert_eq!(a.complete, b.complete);
            assert_eq!(a.diagnostics, b.diagnostics);
            assert_eq!(a.frontiers, b.frontiers);
        }
    }
}

#[test]
fn a_window_is_taken_over_once_and_retires_the_prepared_request() {
    let net = lattice(4, 2, true);
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let mut owner =
        DeadlineSession::new_with_immutable_binding(reader, PatternMode::CoveringMerge, None)
            .unwrap();
    let request = |owner: &mut DeadlineSession| {
        let mut phases = Vec::new();
        owner
            .prepare_with_phases(query(0, 2, 900, 2), session_config(), |p| phases.push(p))
            .unwrap();
        phases.contains(&DeadlineSetupPhase::CatalogueSliced)
    };
    owner
        .prepare_window(QDATE, Mobility::Default, vec![], 600..1_500)
        .unwrap();
    assert!(
        request(&mut owner),
        "the first request takes the window over"
    );
    assert!(
        !request(&mut owner),
        "the window is gone after one take-over"
    );
    assert!(owner.run().is_ok());
    // A new window retires the prepared request and its catalogue.
    owner
        .prepare_window(QDATE, Mobility::Default, vec![], 600..1_500)
        .unwrap();
    assert!(owner.run().is_err());
    assert_eq!(owner.catalogue_key(), None);
    // A request the window cannot serve drops it and builds fresh.
    owner
        .prepare_window(QDATE, Mobility::Default, vec![], 1_000..1_500)
        .unwrap();
    assert!(!request(&mut owner));
    assert_eq!(owner.window_catalogue_bytes(), 0);
    assert!(owner.run().is_ok());
}

/// The H70 gate on a real bundle: `PTN_H70_BUNDLE=<path> cargo test --release
/// ... window_slices_keep_bundle_catalogues -- --ignored`.
#[test]
#[ignore]
fn window_slices_keep_bundle_catalogues() {
    let path = std::env::var("PTN_H70_BUNDLE").expect("PTN_H70_BUNDLE");
    let reader = Reader::from_bytes(std::fs::read(path).unwrap()).unwrap();
    let dates = feed_dates(&reader);
    let (built, slices) = sweep(&reader, &dates, false);
    eprintln!(
        "dates={} windows_built={built} slices_compared={slices}",
        dates.len()
    );
    assert!(slices > 0);
}
