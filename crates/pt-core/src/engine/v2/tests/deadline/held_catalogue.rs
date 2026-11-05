//! H83: a session preparing with `CatalogueSource::HeldSlice` keeps the widest
//! catalogue that served one of its requests and cuts later requests' from it
//! by copy. Every prepare and run equals the fresh session's; at most the held
//! catalogue and the request's are kept; fresh, reuse, `prepare_window`,
//! `clear` and a failed prepare drop the held one.
use super::*;
use core::ops::Range;

const DEADLINE: i64 = 1314;

fn config(window: Range<i64>) -> DeadlineSessionConfig {
    let mut c = DeadlineSessionConfig::new(window, DEADLINE);
    c.lookup = LazyLookupMode::PlainCached;
    c.pruning = DeadlinePruning::EarliestPrefixAndTimetablePoints;
    c.traversal = DeadlineTraversal::ArrivalFirst;
    c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
    c
}

fn request(window: &Range<i64>, wheelchair: bool) -> Query {
    let mut q = query(0, 2, window.start, 2);
    if wheelchair {
        q.mobility = Mobility::Wheelchair;
    }
    q
}

fn prepare(
    owner: &mut DeadlineSession,
    window: &Range<i64>,
    wheelchair: bool,
    prefix: bool,
    source: CatalogueSource,
) -> (
    Result<EventIndexDiagnostics, DeadlineSessionPrepareError>,
    Vec<DeadlineSetupPhase>,
) {
    let (q, c) = (request(window, wheelchair), config(window.clone()));
    let mut phases = Vec::new();
    let d = if prefix {
        owner.prepare_with_prefix_cache_from_and_phases(q, c, source, |p| phases.push(p))
    } else {
        owner.prepare_from_with_phases(q, c, source, |p| phases.push(p))
    };
    (d, phases)
}

fn owner(net: &Net, mode: PatternMode) -> DeadlineSession {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    DeadlineSession::new_with_immutable_binding(reader, mode, net.ptft_table()).unwrap()
}

#[test]
fn held_slice_requests_match_fresh_requests() {
    let net = lattice(4, 2, true);
    // (window, wheelchair, how the held-slice session gets the catalogue,
    // whether a catalogue is held afterwards)
    let steps: [(Range<i64>, bool, CatalogueOrigin, bool); 7] = [
        (600..1_315, false, CatalogueOrigin::Built, false),
        (900..901, false, CatalogueOrigin::HeldSlice, true),
        (700..701, false, CatalogueOrigin::HeldSlice, true),
        (700..701, false, CatalogueOrigin::Reused, true),
        (500..501, false, CatalogueOrigin::Built, false),
        (900..901, true, CatalogueOrigin::Built, false),
        (1_000..1_001, true, CatalogueOrigin::HeldSlice, true),
    ];
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        for prefix in [false, true] {
            let (mut held, mut plain) = (owner(&net, mode), owner(&net, mode));
            let mut widest = 0;
            for (i, (window, wheelchair, origin, holds)) in steps.iter().enumerate() {
                let (a, phases) = prepare(
                    &mut held,
                    window,
                    *wheelchair,
                    prefix,
                    CatalogueSource::HeldSlice,
                );
                let (b, _) = prepare(
                    &mut plain,
                    window,
                    *wheelchair,
                    prefix,
                    CatalogueSource::Fresh,
                );
                assert_eq!(a, b, "{mode:?} prefix={prefix} step {i}");
                assert_eq!(held.catalogue_origin(), Some(*origin), "step {i}");
                assert_eq!(
                    phases.contains(&DeadlineSetupPhase::HeldCatalogueSliced),
                    *origin == CatalogueOrigin::HeldSlice,
                    "step {i}"
                );
                assert_eq!(
                    phases.contains(&DeadlineSetupPhase::EventsEnumerated),
                    *origin == CatalogueOrigin::Built,
                    "step {i}"
                );
                if *origin == CatalogueOrigin::Built {
                    widest = a.as_ref().unwrap().index_bytes;
                }
                // The held catalogue is the widest one served so far.
                assert_eq!(
                    held.held_catalogue_bytes(),
                    if *holds { widest } else { 0 },
                    "step {i}"
                );
                if *holds {
                    widest = held.held_catalogue_bytes();
                }
                assert_eq!(held.catalogue_key(), plain.catalogue_key());
                assert_eq!(held.catalogue_binding(), plain.catalogue_binding());
                let (a, b) = (held.run().unwrap(), plain.run().unwrap());
                assert_eq!(a.points, b.points, "step {i}");
                assert_eq!(a.complete, b.complete);
                assert_eq!(a.diagnostics, b.diagnostics);
                assert_eq!(a.frontiers, b.frontiers);
                assert_eq!(plain.held_catalogue_bytes(), 0);
            }
        }
    }
}

#[test]
fn a_held_slice_request_takes_a_window_over_as_before() {
    let net = lattice(4, 2, true);
    let mut owner = owner(&net, PatternMode::CoveringMerge);
    owner
        .prepare_window(QDATE, Mobility::Default, vec![], 600..1_500)
        .unwrap();
    let (d, phases) = prepare(
        &mut owner,
        &(600..1_315),
        false,
        true,
        CatalogueSource::HeldSlice,
    );
    d.unwrap();
    assert_eq!(owner.catalogue_origin(), Some(CatalogueOrigin::WindowSlice));
    assert!(phases.contains(&DeadlineSetupPhase::CatalogueSliced));
    assert_eq!(owner.window_catalogue_bytes(), 0);
    let (d, _) = prepare(
        &mut owner,
        &(900..901),
        false,
        true,
        CatalogueSource::HeldSlice,
    );
    d.unwrap();
    assert_eq!(owner.catalogue_origin(), Some(CatalogueOrigin::HeldSlice));
    assert!(owner.held_catalogue_bytes() > 0);
    // A new window drops the held catalogue with everything else.
    owner
        .prepare_window(QDATE, Mobility::Default, vec![], 600..1_500)
        .unwrap();
    assert_eq!(owner.held_catalogue_bytes(), 0);
    assert_eq!(owner.catalogue_key(), None);
}

#[test]
fn fresh_reuse_clear_and_failure_drop_the_held_catalogue() {
    let net = lattice(4, 2, true);
    let mut owner = owner(&net, PatternMode::CoveringMerge);
    let hold = |owner: &mut DeadlineSession| {
        for window in [600..1_315, 900..901] {
            prepare(owner, &window, false, true, CatalogueSource::HeldSlice)
                .0
                .unwrap();
        }
        assert!(owner.held_catalogue_bytes() > 0);
    };
    for source in [CatalogueSource::Fresh, CatalogueSource::Reuse] {
        hold(&mut owner);
        let (d, _) = prepare(&mut owner, &(900..901), false, false, source);
        d.unwrap();
        assert_eq!(owner.held_catalogue_bytes(), 0, "{source:?}");
        assert!(owner.run().is_ok());
    }
    hold(&mut owner);
    owner.clear();
    assert_eq!(owner.held_catalogue_bytes(), 0);
    // An empty window fails the request shape; nothing stays held.
    hold(&mut owner);
    let (d, _) = prepare(
        &mut owner,
        &(900..900),
        false,
        true,
        CatalogueSource::HeldSlice,
    );
    assert!(d.is_err());
    assert_eq!(owner.held_catalogue_bytes(), 0);
    assert_eq!(owner.catalogue_key(), None);
    assert!(owner.run().is_err());
    // A request the held catalogue covers still works afterwards.
    let (d, _) = prepare(
        &mut owner,
        &(900..901),
        false,
        true,
        CatalogueSource::HeldSlice,
    );
    d.unwrap();
    assert_eq!(owner.catalogue_origin(), Some(CatalogueOrigin::Built));
}
