//! Prefix certificate with derived block continuations versus the independent
//! raw/full-M4 reference and canonical witnesses. A continuation spends a
//! round but no passenger transfer, and may leave with no layover.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#tripstxt
//! https://gtfs.org/documentation/schedule/reference/#transferstxt
use super::bounded_warmup::check_policies;
use super::*;

const POLICIES: [(DeadlineTraversal, DeadlinePruning); 4] = [
    (
        DeadlineTraversal::ArrivalFirst,
        DeadlinePruning::EarliestPrefixAndPoints,
    ),
    (
        DeadlineTraversal::ArrivalFirst,
        DeadlinePruning::EarliestPrefixAndTimetablePoints,
    ),
    (
        DeadlineTraversal::DepartureWarmup64,
        DeadlinePruning::EarliestPrefixAndPoints,
    ),
    (
        DeadlineTraversal::OriginPrefixWarmup,
        DeadlinePruning::EarliestPrefixAndPoints,
    ),
];

fn prefix(
    net: &Net,
    q: &Query,
    window: core::ops::Range<i64>,
    deadline: i64,
    pruning: DeadlinePruning,
) -> PrefixDiagnostics {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let walks = net.ptft_table();
    let cfg = TransferIndexConfig {
        mobility: q.mobility,
        excluded_modes: q.excluded_modes.clone(),
        ..TransferIndexConfig::new(q.date, window.start..deadline + 1)
    };
    let events = build_event_index(&reader, &index, walks.as_ref(), &cfg).unwrap();
    let mut r = DeadlineRequest::new(q, window, deadline);
    r.transfers = walks.as_ref();
    r.pruning = pruning;
    query_deadline(&reader, &index, &events, r)
        .unwrap()
        .diagnostics
        .prefix
}

fn derived_pairs(net: &Net) -> usize {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    index.v2.as_deref().unwrap().derived.len()
}

#[test]
fn derived_prefix_keeps_short_layover_block_continuations() {
    // The smallest ordinary floor is 120 s. A block continuation may leave
    // sooner, so a floor-only prefix would reject every boarding of `b`.
    for layover in [0, 1, 60, 119, 120] {
        let mut net = Net::new(3, 2);
        let a = net.trip(0, &[(0, 900), (1, 1000)]);
        let b = net.trip(1, &[(1, 1000 + layover), (2, 1100 + layover)]);
        net.trips[a as usize].block = Some("v1");
        net.trips[b as usize].block = Some("v1");
        net.derive = true;
        assert!(derived_pairs(&net) > 0, "layover {layover}");
        let q = query(0, 2, 900, 2);
        let deadline = 1100 + layover as i64;
        assert!(
            check_policies(&net, &q, 900..901, deadline, &POLICIES),
            "layover {layover}"
        );
        for pruning in [
            DeadlinePruning::EarliestPrefixAndPoints,
            DeadlinePruning::EarliestPrefixAndTimetablePoints,
        ] {
            let d = prefix(&net, &q, 900..901, deadline, pruning);
            assert!(d.enabled, "layover {layover} {pruning:?}");
            assert_eq!(
                d.timetable.enabled,
                pruning == DeadlinePruning::EarliestPrefixAndTimetablePoints
            );
        }
    }
}

#[test]
fn derived_prefix_gives_block_continuations_no_transfer_credit() {
    // `seat` stays on one vehicle (0 transfers) and arrives later; `fast`
    // changes once and arrives earlier. Both are Pareto-optimal. Counting the
    // prefix ride before `b` as a transfer would let `fast` cover `seat`.
    let mut net = Net::new(4, 4);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    let b = net.trip(1, &[(1, 1000), (2, 1300)]);
    net.trip(2, &[(0, 900), (3, 950)]);
    net.trip(3, &[(3, 1100), (2, 1200)]);
    net.trips[a as usize].block = Some("v1");
    net.trips[b as usize].block = Some("v1");
    net.derive = true;
    let q = query(0, 2, 900, 2);
    assert!(check_policies(&net, &q, 900..901, 1300, &POLICIES));
    let raw = expected(&net, &q, &(900..901), ProfileObjectives::M4);
    assert!(raw.iter().any(|p| p.1 == 1300 && p.2 == 0), "{raw:?}");
    assert!(raw.iter().any(|p| p.1 == 1200 && p.2 == 1), "{raw:?}");
    let d = prefix(
        &net,
        &q,
        900..901,
        1300,
        DeadlinePruning::EarliestPrefixAndPoints,
    );
    assert!(d.enabled);
}

#[test]
fn derived_prefix_timetable_labels_cover_the_in_seat_origin() {
    // At stop 1, the earlier `x` arrival gives a timetable label with origin
    // 900. Only the block continuation from `a` carries origin 1000. Without
    // its zero-floor label the latest origin before `b` would be 900, and the
    // direct `y` (950 -> 1250) would wrongly cover `seat` (1000 -> 1300).
    let mut net = Net::new(3, 4);
    let a = net.trip(0, &[(0, 1000), (1, 1100)]);
    let b = net.trip(1, &[(1, 1100), (2, 1300)]);
    net.trip(2, &[(0, 900), (1, 950)]);
    net.trip(3, &[(0, 950), (2, 1250)]);
    net.trips[a as usize].block = Some("v1");
    net.trips[b as usize].block = Some("v1");
    net.derive = true;
    let q = query(0, 2, 900, 2);
    assert!(check_policies(&net, &q, 900..1001, 1300, &POLICIES));
    let raw = expected(&net, &q, &(900..1001), ProfileObjectives::M4);
    assert!(
        raw.iter().any(|p| (p.0, p.1, p.2) == (1000, 1300, 0)),
        "{raw:?}"
    );
    assert!(
        raw.iter().any(|p| (p.0, p.1, p.2) == (950, 1250, 0)),
        "{raw:?}"
    );
    let d = prefix(
        &net,
        &q,
        900..1001,
        1300,
        DeadlinePruning::EarliestPrefixAndTimetablePoints,
    );
    assert!(d.enabled && d.timetable.enabled);
}

#[test]
fn derived_prefix_chains_rounds_and_keeps_the_linked_rule_guard() {
    let mut net = Net::new(4, 3);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    let b = net.trip(1, &[(1, 1030), (2, 1100)]);
    let c = net.trip(2, &[(2, 1100), (3, 1200)]);
    for t in [a, b, c] {
        net.trips[t as usize].block = Some("v1");
    }
    net.derive = true;
    // Three rounds ride the whole block; two rounds cannot reach stop 3.
    assert!(check_policies(
        &net,
        &query(0, 3, 900, 3),
        900..901,
        1200,
        &POLICIES
    ));
    assert!(!check_policies(
        &net,
        &query(0, 3, 900, 2),
        900..901,
        1200,
        &POLICIES
    ));
    let pruning = DeadlinePruning::EarliestPrefixAndPoints;
    assert!(prefix(&net, &query(0, 3, 900, 3), 900..901, 1200, pruning).enabled);
    // An explicit linked row may join different stops; the guard stays.
    net.transfers.push((1, 1, ABSENT, ABSENT, a, b, ABSENT, 4));
    assert!(check_policies(
        &net,
        &query(0, 3, 900, 3),
        900..901,
        1200,
        &POLICIES
    ));
    assert!(!prefix(&net, &query(0, 3, 900, 3), 900..901, 1200, pruning).enabled);
}

/// Chain trip `b` to trip `a` within one block, with a 0–150 s layover, on its
/// own route so Off-mode alignment holds.
fn chain(net: &mut Net, rng: &mut Rng) {
    let nt = net.trips.len();
    let a = rng.below(nt as u64) as usize;
    let b = (a + 1 + rng.below(nt as u64 - 1) as usize) % nt;
    if net
        .freqs
        .iter()
        .any(|f| f.0 as usize == a || f.0 as usize == b)
    {
        return;
    }
    let (last_stop, last_t) = net.trips[a].rows.last().map(|r| (r.0, r.1)).unwrap();
    let off = last_t as i64 + rng.below(151) as i64 - net.trips[b].rows[0].1 as i64;
    net.trips[b].rows[0].0 = last_stop;
    for r in net.trips[b].rows.iter_mut() {
        r.1 = (r.1 as i64 + off) as u32;
    }
    let mut used = vec![last_stop];
    for i in 1..net.trips[b].rows.len() {
        let mut s = net.trips[b].rows[i].0;
        while used.contains(&s) {
            s = (s + 1) % 5;
        }
        used.push(s);
        net.trips[b].rows[i].0 = s;
    }
    net.n_routes += 1;
    net.trips[b].route = net.n_routes - 1;
    net.trips[b].service = net.trips[a].service;
    let block = ["P", "Q", "R"][rng.below(3) as usize];
    net.trips[a].block = Some(block);
    net.trips[b].block = Some(block);
}

#[test]
fn derived_prefix_matches_raw_and_canonical_filters_on_generated_networks() {
    let mut rng = Rng(0x4445_5249_5645_4450);
    let (mut derived, mut nonempty) = (0, 0);
    for case in 0..240 {
        let mut net = random_net(&mut rng);
        for _ in 0..1 + rng.below(3) {
            chain(&mut net, &mut rng);
        }
        net.derive = true;
        // Explicit linked rows keep the prefix off; ordinary rules stay random.
        net.transfers.retain(|row| row.7 < 4);
        net.strip = rng.chance(50);
        if rng.chance(30) {
            net.boarding = net
                .trips
                .iter()
                .flat_map(|t| t.rows.iter())
                .map(|_| match rng.below(7) {
                    0 => 0x51,
                    1 => 0x54,
                    2 => 0x55,
                    _ => 0x50,
                })
                .collect();
        }
        let mut q = query(
            rng.below(5) as u32,
            rng.below(5) as u32,
            68000,
            1 + rng.below(4) as u32,
        );
        q.entry_stops[0].walk_secs = rng.below(60) as u32;
        q.exit_stops[0].walk_secs = rng.below(60) as u32;
        if rng.chance(30) {
            q.mobility = Mobility::Wheelchair;
        }
        let found = check_policies(&net, &q, 68000..72000, 78000, &POLICIES);
        if derived_pairs(&net) > 0 {
            derived += 1;
            nonempty += usize::from(found);
            let d = prefix(
                &net,
                &q,
                68000..72000,
                78000,
                DeadlinePruning::EarliestPrefixAndTimetablePoints,
            );
            assert!(d.enabled && d.timetable.enabled, "case {case}");
        }
    }
    assert!(
        derived >= 120 && nonempty >= 30,
        "sparse derived corpus: {derived} derived, {nonempty} nonempty"
    );
}
