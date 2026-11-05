//! PTB v2 engine tests: targeted semantics plus a differential check against
//! an exhaustive search oracle.
//!
//! The oracle below shares only the low-level time/boarding decode
//! (`dep_secs_at`, `alight_secs_at`, `pickup_forbidden_at`,
//! `drop_off_forbidden_at`) with production. It re-implements, by brute force
//! and without any dominance or class merging, the GTFS transfer resolver
//! straight from the `0xF8` rows, concrete instance expansion, linked-trip
//! date binding and block derivation, and enumerates every journey of at
//! most `max_rounds` rides. Production must return exactly the oracle's
//! Pareto set over `(arrival including egress, passenger transfers)`.

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use super::scan::{plan_v2, plan_v2_with};
use super::time::{resolve_time, ROUTING_HORIZON_SECS};
use crate::engine::index::Index;
use crate::engine::patterns::PatternMode;
use crate::engine::scan::{
    alight_secs_at, dep_secs_at, drop_off_forbidden_at, pickup_forbidden_at,
};
use crate::engine::testkit::{
    build_ptft, build_v2_ptb, utc_origins, FrequencyRow, ServicePoolSpec, SoaRoute, SoaStop,
    StopRoutes, TransferRow, V1Feed, V1Trip, V2Feed,
};
use crate::engine::types::{EngineError, Itinerary, LegKind, Mobility, Query, StopWalk};
use crate::transfers::Transfers;
use crate::Reader;

const START: u32 = 20261001;
const DAYS: u16 = 8;
const QDATE: u32 = 20261004; // ordinal 3
const ABSENT: u32 = u32::MAX;

#[cfg(feature = "temporal-experiment")]
mod deadline;
#[cfg(feature = "temporal-experiment")]
mod temporal;
#[cfg(feature = "temporal-experiment")]
mod trip_profiles;
#[cfg(feature = "temporal-experiment")]
mod trip_transfers;

#[derive(Clone)]
struct TripSpec {
    route: u32,
    service: u32,
    /// `(stop, dep_secs, arr_diff)`.
    rows: Vec<(u32, u32, i16)>,
    block: Option<&'static str>,
    wheelchair: u8,
}

#[derive(Clone)]
struct Net {
    parents: Vec<Option<u32>>,
    n_routes: u32,
    /// One bitmask byte (8 days) per service.
    services: Vec<u8>,
    trips: Vec<TripSpec>,
    transfers: Vec<TransferRow>,
    freqs: Vec<FrequencyRow>,
    quarantine: Vec<u32>,
    derive: bool,
    /// Directed PTFT edges `(from, to, raw_secs)`.
    ptft: Vec<(u32, u32, u32)>,
    strip: bool,
    origins: Option<Vec<i64>>,
    /// Packed `0xFA` bytes, one per stop_time in trip/row order; empty = regular.
    boarding: Vec<u8>,
}

impl Net {
    fn new(n_stops: usize, n_routes: u32) -> Self {
        Net {
            parents: vec![None; n_stops],
            n_routes,
            services: vec![0xFF],
            trips: Vec::new(),
            transfers: Vec::new(),
            freqs: Vec::new(),
            quarantine: Vec::new(),
            derive: false,
            ptft: Vec::new(),
            strip: false,
            origins: None,
            boarding: Vec::new(),
        }
    }

    fn trip(&mut self, route: u32, rows: &[(u32, u32)]) -> u32 {
        self.trips.push(TripSpec {
            route,
            service: 0,
            rows: rows.iter().map(|&(s, t)| (s, t, 0)).collect(),
            block: None,
            wheelchair: 0,
        });
        (self.trips.len() - 1) as u32
    }

    fn ids(&self) -> Vec<String> {
        (0..self.parents.len())
            .map(|i| alloc::format!("s{i}"))
            .collect()
    }

    fn bytes(&self) -> Vec<u8> {
        let ids = self.ids();
        let stops: Vec<SoaStop<'_>> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| SoaStop {
                id,
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: self.parents[i],
                wheelchair: 0,
            })
            .collect();
        let rids: Vec<String> = (0..self.n_routes).map(|i| alloc::format!("R{i}")).collect();
        let routes: Vec<SoaRoute<'_>> = rids
            .iter()
            .map(|id| SoaRoute {
                id,
                agency: "",
                short: "",
                long: "",
                color: "",
                text_color: "",
                route_type: 3,
            })
            .collect();
        let tids: Vec<String> = (0..self.trips.len())
            .map(|i| alloc::format!("T{i}"))
            .collect();
        let rows: Vec<Vec<(u16, u32, u32)>> = self
            .trips
            .iter()
            .map(|t| {
                t.rows
                    .iter()
                    .enumerate()
                    .map(|(i, &(s, d, _))| (i as u16 + 1, s, d))
                    .collect()
            })
            .collect();
        let diffs: Vec<Vec<i16>> = self
            .trips
            .iter()
            .map(|t| t.rows.iter().map(|r| r.2).collect())
            .collect();
        let trips: Vec<V1Trip<'_>> = self
            .trips
            .iter()
            .enumerate()
            .map(|(i, t)| V1Trip {
                id: &tids[i],
                route: t.route,
                service: t.service,
                wheelchair: t.wheelchair,
                rows: &rows[i],
                arr_diffs: &diffs[i],
                ..V1Trip::default()
            })
            .collect();
        let pool_bytes: Vec<[u8; 1]> = self.services.iter().map(|&b| [b]).collect();
        let pool: Vec<&[u8]> = pool_bytes.iter().map(|b| b.as_slice()).collect();
        let s2b: Vec<u32> = (0..self.services.len() as u32).collect();
        let origins = self
            .origins
            .clone()
            .unwrap_or_else(|| utc_origins(START, DAYS as usize, 0));
        let blocks: Vec<Option<&str>> = self.trips.iter().map(|t| t.block).collect();
        build_v2_ptb(&V2Feed {
            base: V1Feed {
                stops: &stops,
                routes: &routes,
                trips: &trips,
                stop_routes: StopRoutes::Served,
                feed_start_date: START,
                city_tz_offset_seconds: 0,
                services: ServicePoolSpec {
                    window_days: DAYS,
                    pool: &pool,
                    service_to_bitfield: &s2b,
                },
                transfers: &self.transfers,
                boarding: &self.boarding,
                stop_index: false,
            },
            origins: &origins,
            blocks: &blocks,
            feed_rank: 0,
            derive_block_inseat: self.derive,
            frequencies: &self.freqs,
            quarantined_frequency_trips: &self.quarantine,
            strip_carry: self.strip,
        })
    }

    fn ptft_table(&self) -> Option<Transfers> {
        if self.ptft.is_empty() {
            return None;
        }
        let ids = self.ids();
        let strs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
        let edges: Vec<Vec<(u32, u32)>> = (0..ids.len() as u32)
            .map(|s| {
                self.ptft
                    .iter()
                    .filter(|e| e.0 == s)
                    .map(|e| (e.1, e.2))
                    .collect()
            })
            .collect();
        let refs: Vec<&[(u32, u32)]> = edges.iter().map(|e| e.as_slice()).collect();
        Some(Transfers::from_bytes(build_ptft(&strs, &refs)).unwrap())
    }
}

fn query(from: u32, to: u32, dep: i64, rounds: u32) -> Query {
    Query {
        excluded_routes: Default::default(),
        entry_stops: vec![StopWalk {
            stop: from,
            walk_secs: 0,
        }],
        exit_stops: vec![StopWalk {
            stop: to,
            walk_secs: 0,
        }],
        departure_secs: dep,
        date: QDATE,
        max_rounds: Some(rounds),
        mobility: Mobility::Default,
        excluded_modes: vec![],
        walk_speed_mm_s: None,
        min_transfer_secs: None,
    }
}

fn run(net: &Net, mode: PatternMode, q: &Query) -> Result<Vec<Itinerary>, EngineError> {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let index = Index::build(&reader, mode)?;
    let tr = net.ptft_table();
    plan_v2(&reader, &index, tr.as_ref(), q, None)
}

fn frontier(its: &[Itinerary]) -> Vec<(i64, u32)> {
    let mut v: Vec<(i64, u32)> = its.iter().map(|i| (i.alight_secs, i.transfers)).collect();
    v.sort_unstable();
    v
}

// ---------------------------------------------------------------------------
// Targeted semantics
// ---------------------------------------------------------------------------

#[test]
fn reader_and_time_resolution_round_trip() {
    let mut n = Net::new(2, 1);
    n.trip(0, &[(0, 36000), (1, 36600)]);
    let reader = Reader::from_bytes(n.bytes()).unwrap();
    assert!(reader.is_v2());
    let o3 = utc_origins(START, DAYS as usize, 0)[3];
    let r = resolve_time(&reader, o3 + 100).unwrap();
    assert_eq!(r.service_date, QDATE);
    assert_eq!(r.date_ordinal, 3);
    assert_eq!(r.departure_secs, 100);
    assert_eq!(
        resolve_time(&reader, o3 + 8 * 86400),
        Err(EngineError::UnsupportedServiceDate)
    );
}

#[test]
fn dst_origins_keep_fall_overlap_instants_distinct() {
    // A 25-hour service day (fall back): origin[1] - origin[0] = 90000.
    let mut n = Net::new(2, 1);
    n.trip(0, &[(0, 36000), (1, 36600)]);
    let mut bytes = n.bytes();
    let reader = Reader::from_bytes(bytes.clone()).unwrap();
    let (off, _) =
        crate::engine::testkit::tagged_region(&bytes, crate::region_ids::SERVICE_DAY_ORIGINS);
    let mut origins: Vec<i64> = (0..=DAYS as usize)
        .map(|i| reader.service_day_origin(i).unwrap())
        .collect();
    for o in origins.iter_mut().skip(1) {
        *o += 3600;
    }
    for (i, o) in origins.iter().enumerate() {
        bytes[off + 8 * i..off + 8 * i + 8].copy_from_slice(&o.to_le_bytes());
    }
    let reader = Reader::from_bytes(bytes).unwrap();
    // 24:30 elapsed on day 0 is still day 0 (the extra hour), not day 1.
    let r = resolve_time(&reader, origins[0] + 88200).unwrap();
    assert_eq!((r.date_ordinal, r.departure_secs), (0, 88200));
    let r = resolve_time(&reader, origins[1]).unwrap();
    assert_eq!((r.date_ordinal, r.departure_secs), (1, 0));
}

/// `bytes` with every service-day origin moved by `shift(i, origin)`.
fn with_origins(mut bytes: Vec<u8>, shift: impl Fn(usize, i64) -> i64) -> Vec<u8> {
    let reader = Reader::from_bytes(bytes.clone()).unwrap();
    let (off, _) =
        crate::engine::testkit::tagged_region(&bytes, crate::region_ids::SERVICE_DAY_ORIGINS);
    let origins: Vec<i64> = (0..reader.num_service_day_origins())
        .map(|i| shift(i, reader.service_day_origin(i).unwrap()))
        .collect();
    for (i, o) in origins.iter().enumerate() {
        bytes[off + 8 * i..off + 8 * i + 8].copy_from_slice(&o.to_le_bytes());
    }
    bytes
}

/// H71: the binary search returns the linear scan's range, or its error, at
/// every boundary: each origin plus either event bound, one second either
/// side, and the extremes, so also empty and inverted ranges. With `widths`,
/// each boundary is paired only with itself plus each width (a whole bundle
/// has too many boundaries to pair every two).
pub(super) fn assert_candidate_dates_match_the_scan<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    bounds: &[(i64, i64)],
    widths: Option<&[i64]>,
) -> usize {
    use super::time::{candidate_dates, candidate_dates_by_scan};
    let origins: Vec<i64> = (0..reader.num_service_day_origins())
        .map(|i| reader.service_day_origin(i).unwrap())
        .collect();
    let mut checked = 0;
    for &(min, max) in bounds {
        let mut points = vec![i64::MIN, i64::MIN + 1, -1, 0, 1, i64::MAX - 1, i64::MAX];
        for &o in &origins {
            for e in [min, max] {
                if let Some(at) = o.checked_add(e) {
                    points.extend([at.saturating_sub(1), at, at.saturating_add(1)]);
                }
            }
        }
        points.sort_unstable();
        points.dedup();
        for &from in &points {
            let ends: Vec<i64> = match widths {
                None => points.clone(),
                Some(w) => w.iter().map(|&w| from.saturating_add(w)).collect(),
            };
            for to in ends {
                assert_eq!(
                    candidate_dates(reader, from, to, min, max),
                    candidate_dates_by_scan(reader, from, to, min, max),
                    "from {from} to {to} events {min}..={max}"
                );
                checked += 1;
            }
        }
    }
    checked
}

#[test]
fn candidate_dates_match_the_linear_scan() {
    let mut n = Net::new(2, 1);
    n.trip(0, &[(0, 36000), (1, 36600)]);
    let bounds = [
        (0, 86_400),
        (-3_600, 108_660),
        (14_760, 108_660),
        (0, 0),
        (90_000, 3 * 86_400),
        (0, i64::MAX),
        (i64::MIN, 0),
        (i64::MIN, i64::MAX),
    ];
    let utc = n.bytes();
    // A 25-hour and a 23-hour day, and origins far below zero, where adding
    // `i64::MIN` overflows.
    let dst = with_origins(utc.clone(), |i, o| match i {
        0 => o,
        1 | 2 => o + 3600,
        _ => o,
    });
    let negative = with_origins(utc.clone(), |_, o| o - (1 << 52));
    let mut checked = 0;
    for bytes in [utc, dst, negative] {
        let reader = Reader::from_bytes(bytes).unwrap();
        // Bounds at which only the first, or only the last, origin overflows.
        let first = reader.service_day_origin(0).unwrap();
        let last = reader
            .service_day_origin(reader.num_service_day_origins() - 2)
            .unwrap();
        let mut all = bounds.to_vec();
        if first > 0 {
            all.push((0, i64::MAX - first));
        }
        if last < 0 {
            all.push((i64::MIN - last, 0));
        }
        checked += assert_candidate_dates_match_the_scan(&reader, &all, None);
    }
    assert!(checked > 10_000);
    // An inverted range has no dates.
    let reader = Reader::from_bytes(n.bytes()).unwrap();
    assert_eq!(super::time::candidate_dates(&reader, 1, 0, 0, 0), Ok(0..0));
}

/// H71 on a real bundle: `PTN_H71_BUNDLE=<absolute path> cargo test
/// --release -p pt-core --lib candidate_dates_match_the_scan_on_a_bundle --
/// --ignored`.
#[test]
#[ignore]
fn candidate_dates_match_the_scan_on_a_bundle() {
    extern crate std;
    let path = std::env::var("PTN_H71_BUNDLE").expect("PTN_H71_BUNDLE");
    let reader = Reader::from_bytes(std::fs::read(path).unwrap()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let (min, max) = index.v2.as_deref().unwrap().event_range();
    let checked = assert_candidate_dates_match_the_scan(
        &reader,
        &[(min, max), (0, 86_400), (min, min), (max, max)],
        Some(&[
            i64::MIN,
            -86_400,
            -1,
            0,
            1,
            3_600,
            14_401,
            36_001,
            86_400,
            172_800,
            i64::MAX,
        ]),
    );
    std::eprintln!(
        "origins={} checked={checked}",
        reader.num_service_day_origins()
    );
}

#[test]
fn origins_outside_the_js_safe_integer_range_are_rejected() {
    // A span wider than i64 would overflow `departure_unix - origin`; the
    // TypeScript reader already rejects anything past 2^53 - 1.
    let mut n = Net::new(2, 1);
    n.trip(0, &[(0, 36000), (1, 36600)]);
    let mut bytes = n.bytes();
    let (off, _) =
        crate::engine::testkit::tagged_region(&bytes, crate::region_ids::SERVICE_DAY_ORIGINS);
    bytes[off..off + 8].copy_from_slice(&(i64::MIN + 1).to_le_bytes());
    assert!(matches!(
        Reader::from_bytes(bytes),
        Err(crate::PtbError::ServiceDayOriginsInvalid {
            reason: "out_of_range"
        })
    ));
}

#[test]
fn guards_reject_dates_without_a_complete_horizon() {
    let mut n = Net::new(2, 1);
    n.trip(0, &[(0, 36000), (1, 36600)]);
    // Day 7: the 48-hour horizon runs past the last origin.
    let mut q = query(0, 1, 0, 2);
    q.date = 20261008;
    assert_eq!(
        run(&n, PatternMode::Off, &q),
        Err(EngineError::IncompleteHorizon)
    );
    q.date = 20261020;
    assert_eq!(
        run(&n, PatternMode::Off, &q),
        Err(EngineError::UnsupportedServiceDate)
    );
}

#[test]
fn previous_service_day_trip_after_midnight_competes_directly() {
    // Trip 0 departs 25:00 (01:00 the next morning); trip 1 departs 01:30.
    let mut n = Net::new(2, 2);
    n.trip(0, &[(0, 90000), (1, 90600)]);
    n.trip(1, &[(0, 5400), (1, 6000)]);
    let out = run(&n, PatternMode::Off, &query(0, 1, 1800, 2)).unwrap();
    assert_eq!(
        frontier(&out),
        vec![(4200, 0)],
        "D-1 25:00 trip arrives 01:10"
    );
    match out[0].legs[0].kind {
        crate::engine::LegKind::Transit { trip_idx, .. } => assert_eq!(trip_idx, 0),
        _ => panic!(),
    }
}

#[test]
fn exact_frequency_instances_are_end_exclusive_and_exact() {
    let mut n = Net::new(2, 1);
    n.services = vec![0b0000_1000];
    n.trip(0, &[(0, 36000), (1, 36300)]);
    // 10:00 to 10:29:59 every 10 min: 10:00, 10:10, 10:20. GTFS requires an
    // exact_times=1 end_time strictly below last departure + headway, so
    // 10:30:00 itself would be an invalid row.
    n.freqs.push((0, 36000, 37799, 600, 1));
    let out = run(&n, PatternMode::Off, &query(0, 1, 37201, 2)).unwrap();
    assert!(out.is_empty(), "no 10:30 departure; got {out:?}");
    let out = run(&n, PatternMode::Off, &query(0, 1, 36001, 2)).unwrap();
    assert_eq!(frontier(&out), vec![(36900, 0)]);
    match out[0].legs[0].kind {
        crate::engine::LegKind::Transit { approximate, .. } => assert!(!approximate),
        _ => panic!(),
    }
    n.freqs[0].4 = 0;
    let out = run(&n, PatternMode::Off, &query(0, 1, 36001, 2)).unwrap();
    match out[0].legs[0].kind {
        crate::engine::LegKind::Transit { approximate, .. } => assert!(approximate),
        _ => panic!(),
    }
}

#[test]
fn a_quarantined_frequency_trip_never_degrades_into_its_scheduled_template() {
    let mut n = Net::new(2, 1);
    n.services = vec![0b0000_1000];
    n.trip(0, &[(0, 36000), (1, 36300)]);
    n.trip(0, &[(0, 39600), (1, 39900)]);
    let reader = Reader::from_bytes(n.bytes()).unwrap();
    assert!(!reader.frequency_trip_quarantined(0));
    let out = run(&n, PatternMode::Off, &query(0, 1, 35000, 2)).unwrap();
    assert_eq!(frontier(&out), vec![(36300, 0)]);

    n.quarantine.push(0);
    let reader = Reader::from_bytes(n.bytes()).unwrap();
    assert!(reader.frequency_trip_quarantined(0));
    assert!(!reader.frequency_trip_quarantined(1));
    let out = run(&n, PatternMode::Off, &query(0, 1, 35000, 2)).unwrap();
    assert_eq!(
        frontier(&out),
        vec![(39900, 0)],
        "trip 0 must stay unroutable"
    );
}

#[test]
fn v2_reader_rejects_frequency_rows_that_break_the_contract() {
    let base = |rows: &[FrequencyRow], quarantine: &[u32]| {
        let mut n = Net::new(2, 1);
        n.trip(0, &[(0, 36000), (1, 36300)]);
        n.trip(0, &[(0, 39600), (1, 39900)]);
        n.freqs = rows.to_vec();
        n.quarantine = quarantine.to_vec();
        Reader::from_bytes(n.bytes()).map(|_| ())
    };
    let reason = |r: Result<(), crate::PtbError>| match r {
        Err(crate::PtbError::FrequencyRowInvalid { reason, .. }) => reason,
        other => panic!("expected FrequencyRowInvalid, got {other:?}"),
    };
    assert!(base(&[(0, 36000, 37799, 600, 1)], &[]).is_ok());
    // `end` is exclusive even for exact_times=1, so an end on a departure is
    // accepted: 36000 + 3 * 600 is not generated.
    assert!(base(&[(0, 36000, 37800, 600, 1)], &[]).is_ok());
    assert_eq!(
        reason(base(
            &[(0, 36000, 37000, 600, 0), (0, 36900, 38000, 600, 0)],
            &[]
        )),
        "overlapping_windows"
    );
    // A following row may start exactly at the prior end.
    assert!(base(&[(0, 36000, 37000, 600, 0), (0, 37000, 38000, 600, 0)], &[]).is_ok());
    assert_eq!(
        reason(base(&[(0, 36000, 36000, 600, 0)], &[])),
        "empty_window"
    );
    assert_eq!(
        reason(base(&[(0, 36000, 37000, 600, 2)], &[])),
        "exact_times"
    );
    assert_eq!(
        reason(base(&[(0, 36000, 37000, 600, 0)], &[0])),
        "quarantine_marker_not_alone"
    );
}

/// Two lines meeting at platforms 1 and 2 of station 4.
fn station_net() -> Net {
    let mut n = Net::new(5, 2);
    // Only the query date runs, so the 48-hour horizon cannot reach the next
    // day's trips.
    n.services = vec![0b0000_1000];
    n.parents[1] = Some(4);
    n.parents[2] = Some(4);
    n.trip(0, &[(0, 36000), (1, 36600)]);
    n.trip(1, &[(2, 36800), (3, 37400)]);
    n.ptft.push((1, 2, 60));
    n
}

#[test]
fn station_rule_applies_to_child_platforms() {
    let mut n = station_net();
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &query(0, 3, 35000, 3)).unwrap()),
        vec![(37400, 1)]
    );
    n.transfers
        .push((4, 4, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3));
    assert!(run(&n, PatternMode::Off, &query(0, 3, 35000, 3))
        .unwrap()
        .is_empty());
    // An exact-platform type-2 row outranks the inherited station ban.
    n.transfers
        .push((1, 2, ABSENT, ABSENT, ABSENT, ABSENT, 150, 2));
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &query(0, 3, 35000, 3)).unwrap()),
        vec![(37400, 1)]
    );
    // ...but a 300 s minimum misses the 36800 departure.
    n.transfers[1].6 = 300;
    assert!(run(&n, PatternMode::Off, &query(0, 3, 35000, 3))
        .unwrap()
        .is_empty());
}

#[test]
fn synthetic_edge_needs_an_explicit_minimum() {
    let mut n = station_net();
    n.ptft.clear();
    assert!(run(&n, PatternMode::Off, &query(0, 3, 35000, 3))
        .unwrap()
        .is_empty());
    // Type 2 with 30 s: the agency value is not raised to the global floor.
    n.transfers
        .push((1, 2, ABSENT, ABSENT, ABSENT, ABSENT, 30, 2));
    n.trips[1].rows[0].1 = 36630;
    n.trips[1].rows[1].1 = 37000;
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &query(0, 3, 35000, 3)).unwrap()),
        vec![(37000, 1)]
    );
    // Type 0 uses max(global, min).
    n.transfers[0].7 = 0;
    assert!(run(&n, PatternMode::Off, &query(0, 3, 35000, 3))
        .unwrap()
        .is_empty());
}

#[test]
fn linked_type4_stays_seated_and_type5_counts_a_transfer() {
    let mut n = Net::new(3, 2);
    n.services = vec![0b0000_1000];
    n.trip(0, &[(0, 36000), (1, 36600)]);
    n.trip(1, &[(1, 36660), (2, 37200)]);
    // Same-stop ordinary transfer misses (60 s < 120 s floor).
    assert!(run(&n, PatternMode::Off, &query(0, 2, 35000, 3))
        .unwrap()
        .is_empty());
    n.transfers
        .push((ABSENT, ABSENT, ABSENT, ABSENT, 0, 1, ABSENT, 4));
    let out = run(&n, PatternMode::Off, &query(0, 2, 35000, 3)).unwrap();
    assert_eq!(frontier(&out), vec![(37200, 0)]);
    assert_eq!(out[0].legs.len(), 2, "two transit legs, no walk");
    // Type 4 consumes a round.
    assert!(run(&n, PatternMode::Off, &query(0, 2, 35000, 1))
        .unwrap()
        .is_empty());
    // Type 5 at one stop needs the global floor: 60 s fails.
    n.transfers[0].7 = 5;
    assert!(run(&n, PatternMode::Off, &query(0, 2, 35000, 3))
        .unwrap()
        .is_empty());
    n.trips[1].rows[0].1 = 36720;
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &query(0, 2, 35000, 3)).unwrap()),
        vec![(37200, 1)]
    );
}

#[test]
fn timed_transfer_without_minimum_has_a_zero_floor() {
    let mut n = Net::new(3, 2);
    n.services = vec![0b0000_1000];
    n.trip(0, &[(0, 36000), (1, 36600)]);
    n.trip(1, &[(1, 36610), (2, 37200)]);
    assert!(run(&n, PatternMode::Off, &query(0, 2, 35000, 3))
        .unwrap()
        .is_empty());
    n.transfers
        .push((1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 1));
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &query(0, 2, 35000, 3)).unwrap()),
        vec![(37200, 1)]
    );
    // A route-scoped type 3 (tier 4) outranks the stop-only timed rule (tier 6).
    n.transfers.push((1, 1, 0, 1, ABSENT, ABSENT, ABSENT, 3));
    assert!(run(&n, PatternMode::Off, &query(0, 2, 35000, 3))
        .unwrap()
        .is_empty());
    // A one-trip type 1 (tier 3) outranks the route pair ban.
    n.transfers
        .push((1, 1, ABSENT, ABSENT, ABSENT, 1, ABSENT, 1));
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &query(0, 2, 35000, 3)).unwrap()),
        vec![(37200, 1)]
    );
}

#[test]
fn linked_binding_never_skips_an_inactive_first_date() {
    // Source 23:00 -> 23:50; target 00:10 belongs to the next date's service.
    let mut n = Net::new(3, 2);
    // Source runs only on ordinal 2 at first; target is inactive on ordinal 3.
    n.services = vec![0b0000_0100, 0b1111_0111];
    n.trip(0, &[(0, 82800), (1, 85800)]);
    let t = n.trip(1, &[(1, 600), (2, 1200)]);
    n.trips[t as usize].service = 1;
    n.transfers
        .push((ABSENT, ABSENT, ABSENT, ABSENT, 0, 1, ABSENT, 4));
    // Query on ordinal 2: target binds ordinal 3 (inactive) -> exhausted.
    let mut q = query(0, 2, 80000, 3);
    q.date = 20261003;
    assert!(run(&n, PatternMode::Off, &q).unwrap().is_empty());
    // Source on ordinal 3: binds ordinal 4 (active).
    n.services[0] = 0b0000_1000;
    q.date = 20261004;
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &q).unwrap()),
        vec![(86400 + 1200, 0)]
    );
}

#[test]
fn short_scheduled_layover_never_wraps_to_the_next_service_day() {
    // Source arrives 10:00; the linked target departs 10:03 on the same date
    // and runs every day, so the next date's 10:03 is a real candidate.
    let mut n = Net::new(3, 2);
    n.trip(0, &[(0, 32400), (1, 36000)]);
    n.trip(1, &[(1, 36180), (2, 37000)]);
    n.transfers
        .push((ABSENT, ABSENT, ABSENT, ABSENT, 0, 1, 300, 4));
    let mut q = query(0, 2, 30000, 3);
    q.date = 20261003;
    // The 180 s scheduled layover misses the 300 s floor: the link is
    // infeasible, not re-dated to 10:03 the next day (a 24 h 3 min wait).
    assert!(run(&n, PatternMode::Off, &q).unwrap().is_empty());
    // A floor the scheduled layover meets connects on the same date.
    n.transfers[0].6 = 120;
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &q).unwrap()),
        vec![(37000, 0)]
    );
}

#[test]
fn missed_same_day_successor_never_wraps_a_day_later() {
    // Target leaves 09:59, one minute before the source arrives at 10:00. The
    // next service date's 09:59 run is ~24 h later, beyond the wait cap.
    let mut n = Net::new(3, 2);
    n.trip(0, &[(0, 32400), (1, 36000)]);
    n.trip(1, &[(1, 35940), (2, 37000)]);
    n.transfers
        .push((ABSENT, ABSENT, ABSENT, ABSENT, 0, 1, ABSENT, 4));
    let mut q = query(0, 2, 30000, 3);
    q.date = 20261003;
    assert!(run(&n, PatternMode::Off, &q).unwrap().is_empty());
}

#[test]
fn midnight_connection_within_the_wait_cap_still_binds() {
    // Source arrives 23:50; the target's 00:10 run on the next date is 20 min later.
    let mut n = Net::new(3, 2);
    n.services = vec![0b0000_0100, 0b1111_0111];
    n.trip(0, &[(0, 82800), (1, 85800)]);
    let t = n.trip(1, &[(1, 600), (2, 1200)]);
    n.trips[t as usize].service = 1;
    n.transfers
        .push((ABSENT, ABSENT, ABSENT, ABSENT, 0, 1, ABSENT, 4));
    let mut q = query(0, 2, 80000, 3);
    q.date = 20261003;
    n.services[0] = 0b0000_1000;
    q.date = 20261004;
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &q).unwrap()),
        vec![(86400 + 1200, 0)]
    );
}

#[test]
fn derived_block_continuity_is_date_gated_and_committed() {
    let mut n = Net::new(3, 2);
    n.services = vec![0xFF, 0b1110_1111]; // service 1 off on ordinal 4
    n.trip(0, &[(0, 36000), (1, 36600)]);
    n.trip(1, &[(1, 36660), (2, 37200)]);
    n.trips[1].service = 1;
    n.trips[0].block = Some("blk");
    n.trips[1].block = Some("blk");
    n.derive = true;
    let reader = Reader::from_bytes(n.bytes()).unwrap();
    let c = reader.block_derivation_commitment().unwrap();
    assert_eq!(c.pair_date_count, 7, "every date but ordinal 4");
    assert_eq!(
        frontier(&run(&n, PatternMode::Off, &query(0, 2, 35000, 3)).unwrap()),
        vec![(37200, 0)]
    );
    // Disabled derivation: no in-seat branch.
    n.derive = false;
    assert!(run(&n, PatternMode::Off, &query(0, 2, 35000, 3))
        .unwrap()
        .is_empty());
    // An explicit type-3 trip pair at the boundary suppresses the pair.
    n.derive = true;
    n.transfers.push((1, 1, ABSENT, ABSENT, 0, 1, ABSENT, 3));
    assert!(run(&n, PatternMode::Off, &query(0, 2, 35000, 3))
        .unwrap()
        .is_empty());
}

#[test]
fn a_later_vehicle_keeps_its_in_seat_continuation_when_an_earlier_one_dominates_it() {
    // Vilnius 6G at Zaliasis tiltas: each inbound trip ends where its vehicle
    // starts the outbound trip. Vehicle 1 reaches the terminal (stop 1) first,
    // so its arrival dominates vehicle 2's there; only vehicle 2 continues
    // in-seat to stop 2. That continuation must survive the domination.
    let mut n = Net::new(4, 3);
    n.trip(0, &[(0, 36000), (1, 36600)]); // T0, vehicle 1 inbound
    n.trip(0, &[(0, 36300), (1, 36900)]); // T1, vehicle 2 inbound
    n.trip(1, &[(1, 36600), (3, 37200)]); // T2, vehicle 1 outbound
    n.trip(2, &[(1, 36900), (2, 37500)]); // T3, vehicle 2 outbound
    n.trips[0].block = Some("v1");
    n.trips[2].block = Some("v1");
    n.trips[1].block = Some("v2");
    n.trips[3].block = Some("v2");
    n.derive = true;
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let out = run(&n, mode, &query(0, 2, 35000, 3)).unwrap();
        assert_eq!(frontier(&out), vec![(37500, 0)], "{mode:?}");
        let trips: Vec<u32> = out[0]
            .legs
            .iter()
            .filter_map(|l| match l.kind {
                LegKind::Transit { trip_idx, .. } => Some(trip_idx),
                LegKind::Walk => None,
            })
            .collect();
        assert_eq!(trips, vec![1, 3], "{mode:?}: stays on vehicle 2");
    }
}

#[test]
fn block_chained_vehicles_keep_the_search_small() {
    // Every trip has a derived in-seat successor, so every trip is
    // instance-level. A search used to keep one label per vehicle instance at
    // every stop across the whole routing horizon: tens of seconds a query on
    // the Vilnius feed. The destination is only reachable in-seat, so no target
    // exists to cut the first round.
    let mut n = Net::new(12, 2);
    let out: Vec<u32> = (0..6).collect(); // s0 -> s5
    let back: Vec<u32> = [5, 6, 7, 8, 9, 10, 11, 0].to_vec(); // s5 -> s0
    let blocks = ["b0", "b1", "b2", "b3", "b4", "b5"];
    for (v, block) in blocks.iter().enumerate() {
        let mut t = 5 * 3600 + v as u32 * 600;
        while t < 23 * 3600 {
            for (route, stops) in [(0u32, &out), (1u32, &back)] {
                let rows: Vec<(u32, u32)> = stops
                    .iter()
                    .enumerate()
                    .map(|(i, &s)| (s, t + 120 * i as u32))
                    .collect();
                t += 120 * (stops.len() as u32 - 1);
                let ti = n.trip(route, &rows) as usize;
                n.trips[ti].block = Some(block);
            }
        }
    }
    n.derive = true;
    let reader = Reader::from_bytes(n.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::CoveringMerge).unwrap();
    let (got, labels) = plan_v2_with(
        &reader,
        &index,
        None,
        &query(1, 8, 8 * 3600, 4),
        None,
        true,
        true,
    )
    .unwrap();
    assert_eq!(frontier(&got), vec![(8 * 3600 + 120 * 4 + 120 * 3, 0)]);
    assert!(labels < 2_000, "search created {labels} labels");
}

#[test]
fn tampered_block_commitment_is_an_index_bundle_mismatch() {
    let mut n = Net::new(3, 2);
    n.trip(0, &[(0, 36000), (1, 36600)]);
    n.trip(1, &[(1, 36660), (2, 37200)]);
    n.trips[0].block = Some("b");
    n.trips[1].block = Some("b");
    n.derive = true;
    let mut bytes = n.bytes();
    let (off, _) = crate::engine::testkit::tagged_region(
        &bytes,
        crate::region_ids::BLOCK_DERIVATION_COMMITMENT,
    );
    bytes[off + 16] ^= 1;
    let reader = Reader::from_bytes(bytes).unwrap();
    assert_eq!(
        Index::build(&reader, PatternMode::Off).err(),
        Some(EngineError::IndexBundleMismatch)
    );
}

#[test]
fn v1_plan_entry_dispatches_v2_bundles() {
    let mut n = Net::new(2, 1);
    n.trip(0, &[(0, 36000), (1, 36600)]);
    let reader = Reader::from_bytes(n.bytes()).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let mut st = crate::engine::ScanState::default();
    let out = crate::engine::plan(&reader, &index, None, &mut st, &query(0, 1, 30000, 2)).unwrap();
    assert_eq!(frontier(&out), vec![(36600, 0)]);
}

// ---------------------------------------------------------------------------
// Exhaustive oracle
// ---------------------------------------------------------------------------

struct Ev {
    stop: u32,
    arr: i64,
    dep: i64,
    pick: bool,
    drop: bool,
}

struct OInst {
    trip: u32,
    date: usize,
    route: u32,
    evs: Vec<Ev>,
}

struct Oracle<'a> {
    reader: &'a Reader<Vec<u8>>,
    insts: Vec<OInst>,
    rows: Vec<crate::v2::TransferRowV2>,
    ptft: Vec<(u32, u32, i64)>,
    freq_trip: Vec<bool>,
    trip_route: Vec<u32>,
    first_stop: Vec<u32>,
    first_dep: Vec<i64>,
    trip_service: Vec<u32>,
    shift: Vec<i64>,
    deadline: i64,
    /// The query's minimum transfer where no rule sets one.
    min_transfer: i64,
    exit: u32,
    max_rides: u32,
    derived: Vec<(u32, usize, u32)>,
    out: Vec<(i64, u32)>,
    profile_out: Vec<(i64, i64, u32, u64)>,
    origin_departure: i64,
    total_walk: u64,
    exit_walk: u32,
}

#[derive(Clone, Copy)]
struct Ride {
    inst: usize,
    k: usize,
    stay_only: bool,
}

/// One boarding after an arrival: target instance and served index, physical
/// walking, and how the movement was formed.
#[derive(Clone, Copy)]
struct OEdge {
    inst: usize,
    b: usize,
    walk: u64,
    kind: OKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum OKind {
    SameStop,
    Footpath,
    Synthetic,
    Linked,
    InSeat,
    Derived,
}

impl OKind {
    /// A type-4 or derived in-seat continuation spends a round only.
    fn spends_transfer(self) -> bool {
        !matches!(self, OKind::InSeat | OKind::Derived)
    }
}

impl Oracle<'_> {
    fn parent(&self, s: u32) -> Option<u32> {
        self.reader.stop_parent(s)
    }

    fn covers(&self, written: u32, actual: u32) -> Option<bool> {
        if written == actual {
            Some(true)
        } else if self.parent(actual) == Some(written) {
            Some(false)
        } else {
            None
        }
    }

    /// Brute-force GTFS resolver over every row: returns the winning row.
    #[allow(clippy::too_many_arguments)]
    fn resolve(
        &self,
        a: u32,
        s: u32,
        t: u32,
        r: u32,
        t2: u32,
        r2: u32,
        boundary: bool,
    ) -> Option<usize> {
        let mut cands: Vec<(u8, bool, bool, usize)> = Vec::new();
        for (i, row) in self.rows.iter().enumerate() {
            if row.transfer_type >= 4 {
                if !boundary || row.from_trip != Some(t) || row.to_trip != Some(t2) {
                    continue;
                }
                if row.from_stop.is_some_and(|x| x != a) || row.to_stop.is_some_and(|x| x != s) {
                    continue;
                }
                cands.push((1, true, true, i));
                continue;
            }
            let (Some(fe), Some(te)) = (
                self.covers(row.from_stop.unwrap(), a),
                self.covers(row.to_stop.unwrap(), s),
            ) else {
                continue;
            };
            if row.from_trip.is_some_and(|x| x != t)
                || row.to_trip.is_some_and(|x| x != t2)
                || row.from_route.is_some_and(|x| x != r)
                || row.to_route.is_some_and(|x| x != r2)
            {
                continue;
            }
            let lv = |rt: Option<u32>, tr: Option<u32>| {
                if tr.is_some() {
                    2
                } else if rt.is_some() {
                    1
                } else {
                    0
                }
            };
            let (f, g) = (
                lv(row.from_route, row.from_trip),
                lv(row.to_route, row.to_trip),
            );
            let tier = match (f.max(g), f.min(g)) {
                (2, 2) => 1,
                (2, 1) => 2,
                (2, 0) => 3,
                (1, 1) => 4,
                (1, 0) => 5,
                _ => 6,
            };
            cands.push((tier, fe, te, i));
        }
        let best = cands.iter().map(|c| c.0).min()?;
        let tier: Vec<_> = cands.into_iter().filter(|c| c.0 == best).collect();
        tier.iter()
            .filter(|a| {
                !tier
                    .iter()
                    .any(|b| b.1 >= a.1 && b.2 >= a.2 && ((b.1 && !a.1) || (b.2 && !a.2)))
            })
            .map(|c| c.3)
            .min()
    }

    fn walk(&self, a: u32, s: u32) -> Option<i64> {
        self.ptft
            .iter()
            .filter(|e| e.0 == a && e.1 == s)
            .map(|e| e.2)
            .min()
    }

    fn record(&mut self, arr: i64, transfers: u32) {
        if arr <= self.deadline {
            self.out.push((arr + self.exit_walk as i64, transfers));
            self.profile_out.push((
                self.origin_departure,
                arr + self.exit_walk as i64,
                transfers,
                self.total_walk + self.exit_walk as u64,
            ));
        }
    }

    fn ride(&mut self, inst: usize, b: usize, transfers: u32, rides: u32) {
        let n = self.insts[inst].evs.len();
        for k in b + 1..n {
            let ev = &self.insts[inst].evs[k];
            if ev.arr > self.deadline {
                continue;
            }
            let stay_only = !ev.drop;
            if stay_only && k != n - 1 {
                continue;
            }
            self.after_ride(Ride { inst, k, stay_only }, transfers, rides);
        }
    }

    /// Every instance at `stop` boardable from a non-origin state.
    fn board(
        &self,
        from: Ride,
        stop: u32,
        time: i64,
        walk: Option<i64>,
        synthetic: bool,
        out: &mut Vec<OEdge>,
    ) {
        let src = &self.insts[from.inst];
        let (a, t, r) = (src.evs[from.k].stop, src.trip, src.route);
        let at_terminal = from.k == src.evs.len() - 1;
        for j in 0..self.insts.len() {
            if j == from.inst {
                continue;
            }
            for b in 0..self.insts[j].evs.len() - 1 {
                let ev = &self.insts[j].evs[b];
                if ev.stop != stop || !ev.pick || ev.dep > self.deadline {
                    continue;
                }
                let (t2, r2) = (self.insts[j].trip, self.insts[j].route);
                let w = self.resolve(a, stop, t, r, t2, r2, at_terminal && b == 0);
                let row = w.map(|i| self.rows[i]);
                if row.is_some_and(|x| x.transfer_type >= 4) {
                    continue;
                }
                let min = row.and_then(|x| x.min_transfer_secs).map(|m| m as i64);
                let ty = row.map(|x| x.transfer_type);
                let floor = match ty {
                    Some(3) => continue,
                    Some(2) => min.unwrap(),
                    Some(1) => min.unwrap_or(0),
                    _ => min.map_or(self.min_transfer, |m| m.max(self.min_transfer)),
                };
                let elapsed = if synthetic {
                    match (ty, min) {
                        (Some(1) | Some(2), Some(m)) => m,
                        (Some(0), Some(m)) => m.max(self.min_transfer),
                        _ => continue,
                    }
                } else {
                    walk.map_or(floor, |w| w.max(floor))
                };
                if ev.dep >= time + elapsed {
                    let movement = if synthetic {
                        elapsed
                    } else {
                        walk.unwrap_or(0)
                    } as u64;
                    out.push(OEdge {
                        inst: j,
                        b,
                        walk: movement,
                        kind: if synthetic {
                            OKind::Synthetic
                        } else if walk.is_some() {
                            OKind::Footpath
                        } else {
                            OKind::SameStop
                        },
                    });
                }
            }
        }
    }

    fn ptft_from(&self, stop: u32) -> Vec<(u32, i64)> {
        self.ptft
            .iter()
            .filter(|e| e.0 == stop)
            .map(|e| (e.1, e.2))
            .collect()
    }

    fn after_ride(&mut self, x: Ride, transfers: u32, rides: u32) {
        let ev = &self.insts[x.inst].evs[x.k];
        let (stop, time) = (ev.stop, ev.arr);
        if !x.stay_only && stop == self.exit {
            self.record(time, transfers);
        }
        if !x.stay_only {
            // One PTFT walk (egress is allowed in the last round too).
            for (s, w) in self.ptft_from(stop) {
                if time + w <= self.deadline && s == self.exit {
                    self.total_walk += w as u64;
                    self.record(time + w, transfers);
                    self.total_walk -= w as u64;
                }
            }
        }
        if rides >= self.max_rides {
            return;
        }
        for e in self.transfers_from(x) {
            self.total_walk += e.walk;
            self.ride(
                e.inst,
                e.b,
                transfers + u32::from(e.kind.spends_transfer()),
                rides + 1,
            );
            self.total_walk -= e.walk;
        }
    }

    /// Every boarding available after arriving at `x`, ignoring the round cap.
    fn transfers_from(&self, x: Ride) -> Vec<OEdge> {
        let inst = &self.insts[x.inst];
        let ev = &inst.evs[x.k];
        let (stop, time) = (ev.stop, ev.arr);
        let terminal = x.k == inst.evs.len() - 1;
        let trip = inst.trip;
        let date = inst.date;
        let route = inst.route;
        let mut out = Vec::new();
        if !x.stay_only {
            self.board(x, stop, time, None, false, &mut out);
            let ptft = self.ptft_from(stop);
            for &(s, w) in &ptft {
                if time + w <= self.deadline {
                    self.board(x, s, time, Some(w), false, &mut out);
                }
            }
            let n_stops = self.reader.num_stops() as u32;
            for s in 0..n_stops {
                if s == stop || ptft.iter().any(|e| e.0 == s) {
                    continue;
                }
                let any = self.rows.iter().any(|row| {
                    row.transfer_type < 3
                        && row.min_transfer_secs.is_some()
                        && self.covers(row.from_stop.unwrap(), stop).is_some()
                        && self.covers(row.to_stop.unwrap(), s).is_some()
                        && row.from_trip.is_none_or(|v| v == trip)
                        && row.from_route.is_none_or(|v| v == route)
                });
                if any {
                    self.board(x, s, time, None, true, &mut out);
                }
            }
        }
        if !terminal || self.freq_trip[trip as usize] {
            return out;
        }
        // Linked continuations.
        let mut targets: Vec<u32> = self
            .rows
            .iter()
            .filter(|r| r.transfer_type >= 4 && r.from_trip == Some(trip))
            .map(|r| r.to_trip.unwrap())
            .collect();
        targets.sort_unstable();
        targets.dedup();
        for t2 in targets {
            let s2 = self.first_stop[t2 as usize];
            let Some(w) = self.resolve(
                stop,
                s2,
                trip,
                route,
                t2,
                self.trip_route[t2 as usize],
                true,
            ) else {
                continue;
            };
            let row = self.rows[w];
            if row.transfer_type < 4 || self.freq_trip[t2 as usize] {
                continue;
            }
            let min = row.min_transfer_secs.map(|m| m as i64);
            let elapsed = if row.transfer_type == 4 {
                min.unwrap_or(0)
            } else {
                if x.stay_only {
                    continue;
                }
                let base = min.map_or(self.min_transfer, |m| m.max(self.min_transfer));
                if s2 == stop {
                    base
                } else if let Some(wk) = self.walk(stop, s2) {
                    base.max(wk)
                } else if min.is_some() {
                    base
                } else {
                    continue;
                }
            };
            // Calendar candidate follows the scheduled successor (the arrival);
            // the layover floor only rejects a too-short scheduled layover.
            let ready = time + elapsed;
            let fd = self.first_dep[t2 as usize];
            let Some(j) = (0..self.shift.len()).find(|&d| self.shift[d] + fd >= time) else {
                continue;
            };
            if self.shift[j] + fd < ready
                || self.shift[j] + fd - time > super::time::MAX_LINK_WAIT_SECS
            {
                continue;
            }
            let Some(ji) = self.insts.iter().position(|i| i.trip == t2 && i.date == j) else {
                continue; // inactive on the sole candidate date
            };
            if self.insts[ji].evs[0].dep > self.deadline {
                continue;
            }
            if row.transfer_type == 5 && !self.insts[ji].evs[0].pick {
                continue;
            }
            let movement = if row.transfer_type == 5 && s2 != stop {
                self.walk(stop, s2).unwrap_or(elapsed) as u64
            } else {
                0
            };
            out.push(OEdge {
                inst: ji,
                b: 0,
                walk: movement,
                kind: if row.transfer_type == 4 {
                    OKind::InSeat
                } else {
                    OKind::Linked
                },
            });
        }
        // Derived continuations (same date).
        let derived: Vec<u32> = self
            .derived
            .iter()
            .filter(|d| d.0 == trip && d.1 == date)
            .map(|d| d.2)
            .collect();
        for t2 in derived {
            if let Some(ji) = self
                .insts
                .iter()
                .position(|i| i.trip == t2 && i.date == date)
            {
                if self.insts[ji].evs[0].dep >= time && self.insts[ji].evs[0].dep <= self.deadline {
                    out.push(OEdge {
                        inst: ji,
                        b: 0,
                        walk: 0,
                        kind: OKind::Derived,
                    });
                }
            }
        }
        out
    }
}

#[allow(clippy::needless_range_loop)]
fn oracle(net: &Net, q: &Query) -> Vec<(i64, u32)> {
    oracle_raw(net, q, None).arrivals
}

struct OracleOutput {
    arrivals: Vec<(i64, u32)>,
    #[cfg_attr(not(feature = "temporal-experiment"), allow(dead_code))]
    profile: Vec<(i64, i64, u32, u64)>,
}

#[allow(clippy::needless_range_loop)]
fn oracle_raw(
    net: &Net,
    q: &Query,
    profile_window: Option<&core::ops::Range<i64>>,
) -> OracleOutput {
    with_oracle(net, q, |o| {
        let deadline = q.departure_secs + ROUTING_HORIZON_SECS;
        let start = q.entry_stops[0].stop;
        let t0 = q.departure_secs + q.entry_stops[0].walk_secs as i64;
        for j in 0..o.insts.len() {
            for b in 0..o.insts[j].evs.len() - 1 {
                let ev = &o.insts[j].evs[b];
                let departure = ev.dep - q.entry_stops[0].walk_secs as i64;
                let eligible = profile_window.map_or(ev.dep >= t0 && ev.dep <= deadline, |w| {
                    w.contains(&departure)
                });
                if ev.stop == start && ev.pick && eligible {
                    o.origin_departure = departure;
                    o.deadline = if profile_window.is_some() {
                        departure + ROUTING_HORIZON_SECS
                    } else {
                        deadline
                    };
                    o.ride(j, b, 0, 1);
                }
            }
        }
        let mut pts = core::mem::take(&mut o.out);
        pts.sort_unstable();
        pts.dedup();
        let pareto: Vec<(i64, u32)> = pts
            .iter()
            .copied()
            .filter(|&(a, t)| {
                !pts.iter()
                    .any(|&(b, u)| b <= a && u <= t && (b, u) != (a, t))
            })
            .collect();
        let _ = &o.trip_service;
        OracleOutput {
            arrivals: pareto,
            profile: core::mem::take(&mut o.profile_out),
        }
    })
}

/// The brute-force oracle's expanded instances and rules for `q`'s date,
/// mobility and modes, before any origin is seeded.
#[allow(clippy::needless_range_loop)]
fn with_oracle<R>(net: &Net, q: &Query, f: impl FnOnce(&mut Oracle<'_>) -> R) -> R {
    let bytes = net.bytes();
    let reader = Reader::from_bytes(bytes).unwrap();
    let index = Index::build(&reader, PatternMode::Off).unwrap();
    let days = DAYS as usize;
    let origins: Vec<i64> = (0..=days)
        .map(|i| reader.service_day_origin(i).unwrap())
        .collect();
    let qd =
        (crate::reader::days_from_civil(q.date) - crate::reader::days_from_civil(START)) as usize;
    let shift: Vec<i64> = (0..days).map(|d| origins[d] - origins[qd]).collect();
    let nt = reader.num_trips();
    let mut freq_trip = vec![false; nt];
    let mut trip_route = vec![0u32; nt];
    let mut first_stop = vec![0u32; nt];
    let mut first_dep = vec![0i64; nt];
    let mut trip_service = vec![0u32; nt];
    let mut insts = Vec::new();
    let deadline = q.departure_secs + ROUTING_HORIZON_SECS;
    let mut last_arr = vec![0i64; nt];
    let mut last_stop = vec![0u32; nt];
    for route in &index.routes {
        for rt in &route.trips {
            let t = rt.trip_idx as usize;
            let served: Vec<usize> = (0..route.stop_ids.len())
                .filter(|&p| rt.pos_to_row[p] != -1)
                .collect();
            let fd = dep_secs_at(&reader, rt, served[0]).unwrap();
            trip_route[t] = route.reader_route_idx;
            first_stop[t] = route.stop_ids[served[0]];
            first_dep[t] = fd;
            trip_service[t] = rt.service_idx;
            let lp = *served.last().unwrap();
            last_arr[t] = alight_secs_at(&reader, rt, lp).unwrap();
            last_stop[t] = route.stop_ids[lp];
            let windows: Vec<_> = reader.frequencies_for_trip(rt.trip_idx).collect();
            freq_trip[t] = !windows.is_empty();
            // Keep calendar/block metadata above even when this passenger
            // cannot use the vehicle. Instance enumeration is independent of
            // the optimized scan and applies the query's mobility/mode filters.
            if (matches!(q.mobility, Mobility::Wheelchair) && rt.wheelchair_accessible == 2)
                || (matches!(q.mobility, Mobility::Bicycle) && rt.bikes_allowed == 2)
                || q.excluded_routes.contains(&route.reader_route_idx)
                || q.excluded_modes.iter().any(|&kind| {
                    crate::engine::mode::route_type_to_mode(kind)
                        == crate::engine::mode::route_type_to_mode(route.route_type)
                })
            {
                continue;
            }
            let mut shifts: Vec<i64> = Vec::new();
            if windows.is_empty() {
                shifts.push(0);
            }
            for w in &windows {
                let mut f = w.start_secs as i64;
                while f < w.end_secs as i64 {
                    shifts.push(f - fd);
                    f += w.headway_secs as i64;
                }
            }
            for d in 0..days {
                let ymd = crate::reader::days_add(START, d as i64);
                if !reader.service_active_on(rt.service_idx, ymd) {
                    continue;
                }
                for &sh in &shifts {
                    let evs = served
                        .iter()
                        .map(|&p| Ev {
                            stop: route.stop_ids[p],
                            arr: shift[d] + sh + alight_secs_at(&reader, rt, p).unwrap(),
                            dep: shift[d] + sh + dep_secs_at(&reader, rt, p).unwrap(),
                            pick: !pickup_forbidden_at(&reader, rt, p),
                            drop: !drop_off_forbidden_at(&reader, rt, p),
                        })
                        .collect();
                    insts.push(OInst {
                        trip: rt.trip_idx,
                        date: d,
                        route: route.reader_route_idx,
                        evs,
                    });
                }
            }
        }
    }
    let rows: Vec<_> = (0..reader.num_transfers())
        .map(|i| reader.transfer_v2(i).unwrap())
        .collect();
    let mut ptft = Vec::new();
    for &(a, b, w) in &net.ptft {
        ptft.push((
            a,
            b,
            crate::engine::consts::rescale_walk_secs(w, q.transfer_walk_speed_mm_s()),
        ));
    }
    // Brute-force block derivation.
    let mut derived = Vec::new();
    if net.derive {
        for d in 0..days {
            let ymd = crate::reader::days_add(START, d as i64);
            let mut blocks: Vec<&str> = net.trips.iter().filter_map(|t| t.block).collect();
            blocks.sort_unstable();
            blocks.dedup();
            for blk in blocks {
                let mut m: Vec<u32> = (0..nt as u32)
                    .filter(|&t| {
                        net.trips[t as usize].block == Some(blk)
                            && reader.service_active_on(trip_service[t as usize], ymd)
                    })
                    .collect();
                m.sort_by_key(|&t| (first_dep[t as usize], t));
                for w in m.windows(2) {
                    let (a, b) = (w[0] as usize, w[1] as usize);
                    if freq_trip[a] || freq_trip[b] || last_stop[a] != first_stop[b] {
                        continue;
                    }
                    let lay = first_dep[b] - last_arr[a];
                    if !(0..=120).contains(&lay) {
                        continue;
                    }
                    let covers =
                        |wr: u32, act: u32| wr == act || reader.stop_parent(act) == Some(wr);
                    let suppressed = rows.iter().any(|r| {
                        r.from_trip == Some(a as u32)
                            && r.to_trip == Some(b as u32)
                            && if r.transfer_type >= 4 {
                                r.from_stop.is_none_or(|s| s == last_stop[a])
                                    && r.to_stop.is_none_or(|s| s == first_stop[b])
                            } else {
                                covers(r.from_stop.unwrap(), last_stop[a])
                                    && covers(r.to_stop.unwrap(), first_stop[b])
                            }
                    });
                    if !suppressed {
                        derived.push((a as u32, d, b as u32));
                    }
                }
            }
        }
    }
    let mut o = Oracle {
        reader: &reader,
        insts,
        rows,
        ptft,
        freq_trip,
        trip_route,
        first_stop,
        first_dep,
        trip_service,
        shift,
        deadline,
        min_transfer: q.min_transfer_floor_secs(),
        exit: q.exit_stops[0].stop,
        max_rides: q.max_rounds.unwrap(),
        derived,
        out: Vec::new(),
        profile_out: Vec::new(),
        origin_departure: q.departure_secs,
        total_walk: q.entry_stops[0].walk_secs as u64,
        exit_walk: q.exit_stops[0].walk_secs,
    };
    f(&mut o)
}

/// Deterministic xorshift for the random corpus.
#[test]
fn production_matches_the_oracle_with_short_turn_trips() {
    // Trips of one route that skip a stop make patterns whose trips differ in
    // shape: boarding prunes by shape group there.
    const CASES: usize = 1000;
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let mut nonempty = 0usize;
    for case in 0..CASES {
        let net = random_net_short_turns(&mut rng);
        let from = rng.below(5) as u32;
        let mut to = rng.below(5) as u32;
        if to == from {
            to = (to + 1) % 5;
        }
        let dep = 68_000 + rng.below(8_000) as i64;
        let q = query(from, to, dep, 3);
        let want = oracle(&net, &q);
        for mode in [
            PatternMode::Off,
            PatternMode::Unbounded,
            PatternMode::CoveringMerge,
        ] {
            let got = run(&net, mode, &q).unwrap_or_else(|e| panic!("case {case} {mode:?}: {e:?}"));
            let mut pts: Vec<(i64, u32)> =
                got.iter().map(|i| (i.alight_secs, i.transfers)).collect();
            pts.sort_unstable();
            assert_eq!(pts, want, "case {case} mode {mode:?}");
        }
        nonempty += (!want.is_empty()) as usize;
    }
    assert!(nonempty > 300, "corpus too sparse: {nonempty}");
}

#[test]
fn the_boarding_shortcuts_never_change_an_itinerary() {
    // Indexed boarding, shape-group pruning and the ride memo remove work
    // only: the same itineraries, legs and order as the per-trip search.
    const CASES: usize = 1500;
    let mut rng = Rng(0x6A09_E667_F3BC_C908);
    let mut nonempty = 0usize;
    for case in 0..CASES {
        let net = if case % 2 == 0 {
            random_net(&mut rng)
        } else {
            random_net_short_turns(&mut rng)
        };
        let from = rng.below(5) as u32;
        let mut to = rng.below(5) as u32;
        if to == from {
            to = (to + 1) % 5;
        }
        let dep = 68_000 + rng.below(8_000) as i64;
        let mut q = query(from, to, dep, 3);
        // The rider's minimum transfer and walking speed reach the indexed
        // path's ready time too, not only the per-trip one.
        match case % 3 {
            1 => q.min_transfer_secs = Some(rng.below(301) as u32),
            2 => q.walk_speed_mm_s = core::num::NonZeroU32::new(600 + rng.below(1_200) as u32),
            _ => {}
        }
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let tr = net.ptft_table();
        for mode in [
            PatternMode::Off,
            PatternMode::Unbounded,
            PatternMode::CoveringMerge,
        ] {
            let index = Index::build(&reader, mode).unwrap();
            let fast = plan_v2_with(&reader, &index, tr.as_ref(), &q, None, true, true);
            let plain = plan_v2_with(&reader, &index, tr.as_ref(), &q, None, true, false);
            assert_eq!(
                fast.as_ref().map(|r| &r.0),
                plain.as_ref().map(|r| &r.0),
                "case {case} mode {mode:?}"
            );
            nonempty += fast.map_or(0, |r| (!r.0.is_empty()) as usize);
        }
    }
    assert!(nonempty > 1500, "corpus too sparse: {nonempty}");
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

/// Gives about two queries in three a random minimum transfer or
/// transfer-walk speed, so the experiments are checked under a rider's own
/// settings as well as the defaults.
#[cfg(feature = "temporal-experiment")]
fn vary_walk_settings(rng: &mut Rng, q: &mut Query) {
    match rng.below(3) {
        1 => q.min_transfer_secs = Some(rng.below(301) as u32),
        2 => q.walk_speed_mm_s = core::num::NonZeroU32::new(600 + rng.below(1_200) as u32),
        _ => {}
    }
}

/// [`random_net`] with short turns: a trip of a route other than its first
/// may skip one inner stop, so one pattern holds trips of different shapes.
/// The first trip keeps the whole stop sequence, so every pattern aligns.
fn random_net_short_turns(rng: &mut Rng) -> Net {
    let mut n = random_net(rng);
    let mut seen = vec![false; n.n_routes as usize];
    for t in 0..n.trips.len() {
        let r = n.trips[t].route as usize;
        if !core::mem::replace(&mut seen[r], true) {
            continue;
        }
        let len = n.trips[t].rows.len();
        if len >= 3 && rng.chance(60) {
            let i = 1 + rng.below(len as u64 - 2) as usize;
            n.trips[t].rows.remove(i);
        }
    }
    n
}

fn random_net(rng: &mut Rng) -> Net {
    // Stops 0..5 are platforms; 5 is a station parenting 0 and 1.
    let mut n = Net::new(6, 3);
    n.parents[0] = Some(5);
    n.parents[1] = Some(5);
    n.services = (0..3).map(|_| (rng.next() as u8) | 0b0001_1000).collect();
    for route in 0..3u32 {
        let len = 2 + rng.below(3) as usize;
        let mut seq: Vec<u32> = (0..5).collect();
        for i in 0..5 {
            let j = i + rng.below((5 - i) as u64) as usize;
            seq.swap(i, j);
        }
        seq.truncate(len);
        for _ in 0..(1 + rng.below(3)) {
            let mut t = 70_000 + rng.below(6_000) as u32;
            let mut rows = Vec::new();
            for &s in &seq {
                rows.push((s, t, 0i16));
                t += 60 + rng.below(600) as u32;
            }
            n.trips.push(TripSpec {
                route,
                service: rng.below(3) as u32,
                rows,
                block: match rng.below(3) {
                    0 => Some("A"),
                    1 => Some("B"),
                    _ => None,
                },
                wheelchair: 0,
            });
        }
    }
    let nt = n.trips.len() as u32;
    if rng.chance(40) {
        let t = rng.below(nt as u64) as u32;
        let s = n.trips[t as usize].rows[0].1;
        let headway = 300 + rng.below(600) as u16;
        let exact = rng.below(2) as u8;
        let mut end = s + 600 + rng.below(1800) as u32;
        // GTFS: an exact_times=1 end_time lies strictly below the last
        // departure plus one headway, so it never lands on a departure.
        if exact == 1 && (end - s).is_multiple_of(headway as u32) {
            end += 1;
        }
        n.freqs.push((t, s, end, headway, exact));
    }
    // Make some block layovers meet exactly: chain trip k's start to trip k-1's end.
    if rng.chance(50) && nt >= 2 {
        let a = rng.below(nt as u64 - 1) as usize;
        let (last_stop, last_t) = *n.trips[a].rows.last().map(|r| (r.0, r.1)).as_ref().unwrap();
        let b = a + 1;
        let off = last_t as i64 + rng.below(150) as i64 - n.trips[b].rows[0].1 as i64;
        n.trips[b].rows[0].0 = last_stop;
        for r in n.trips[b].rows.iter_mut() {
            r.1 = (r.1 as i64 + off) as u32;
        }
        // Keep the first stop distinct from the rest of the sequence.
        let first = n.trips[b].rows[0].0;
        let mut used = vec![first];
        for i in 1..n.trips[b].rows.len() {
            let mut s = n.trips[b].rows[i].0;
            while used.contains(&s) {
                s = (s + 1) % 5;
            }
            used.push(s);
            n.trips[b].rows[i].0 = s;
        }
        if n.trips[b].route == n.trips[a].route
            || n.trips
                .iter()
                .filter(|t| t.route == n.trips[b].route)
                .count()
                > 1
        {
            // Give the rewritten trip its own route so Off-mode alignment holds.
            n.n_routes += 1;
            n.trips[b].route = n.n_routes - 1;
        }
    }
    n.derive = rng.chance(50);
    for _ in 0..rng.below(12) {
        let ty = rng.below(6) as u8;
        let ft = rng.below(nt as u64) as u32;
        let mut tt = rng.below(nt as u64) as u32;
        if tt == ft {
            tt = (tt + 1) % nt;
        }
        let min = if ty == 2 || rng.chance(40) {
            30 + rng.below(400) as u32
        } else {
            ABSENT
        };
        if ty >= 4 {
            let fs = if rng.chance(50) {
                ABSENT
            } else {
                n.trips[ft as usize].rows.last().unwrap().0
            };
            let ts = if rng.chance(50) {
                ABSENT
            } else {
                n.trips[tt as usize].rows[0].0
            };
            n.transfers.push((fs, ts, ABSENT, ABSENT, ft, tt, min, ty));
        } else {
            let pick = |rng: &mut Rng| {
                if rng.chance(35) {
                    5
                } else {
                    rng.below(5) as u32
                }
            };
            let fs = pick(rng);
            let ts = pick(rng);
            let (mut fr, mut trr, mut ftp, mut ttp) = (ABSENT, ABSENT, ABSENT, ABSENT);
            match rng.below(4) {
                0 => {}
                1 => {
                    ftp = ft;
                    if rng.chance(50) {
                        ttp = tt;
                    }
                }
                2 => {
                    fr = n.trips[ft as usize].route;
                    if rng.chance(50) {
                        trr = n.trips[tt as usize].route;
                    }
                }
                _ => {
                    ttp = tt;
                    if rng.chance(50) {
                        fr = n.trips[ft as usize].route;
                    }
                }
            }
            n.transfers.push((fs, ts, fr, trr, ftp, ttp, min, ty));
        }
    }
    for _ in 0..rng.below(6) {
        let a = rng.below(5) as u32;
        let b = rng.below(5) as u32;
        if a != b {
            n.ptft.push((a, b, 20 + rng.below(250) as u32));
        }
    }
    n
}

#[test]
fn production_matches_the_exhaustive_oracle_on_a_random_corpus() {
    const CASES: usize = 2000;
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut compared = 0usize;
    let mut nonempty = 0usize;
    let mut multi = 0usize;
    for case in 0..CASES {
        let net = random_net(&mut rng);
        let from = rng.below(5) as u32;
        let mut to = rng.below(5) as u32;
        if to == from {
            to = (to + 1) % 5;
        }
        let dep = 68_000 + rng.below(8_000) as i64;
        let q = query(from, to, dep, 3);
        let want = oracle(&net, &q);
        for mode in [
            PatternMode::Off,
            PatternMode::Unbounded,
            PatternMode::CoveringMerge,
        ] {
            let got = run(&net, mode, &q).unwrap_or_else(|e| panic!("case {case} {mode:?}: {e:?}"));
            let mut pts: Vec<(i64, u32)> =
                got.iter().map(|i| (i.alight_secs, i.transfers)).collect();
            pts.sort_unstable();
            assert_eq!(pts, want, "case {case} mode {mode:?}");
        }
        compared += 1;
        nonempty += (!want.is_empty()) as usize;
        multi += want.iter().any(|p| p.1 > 0) as usize;
    }
    assert_eq!(compared, CASES);
    assert!(nonempty > 700, "corpus too sparse: {nonempty}");
    assert!(multi > 200, "too few transfer journeys: {multi}");
}

/// The same oracle comparison with a rider's walking speed and minimum
/// transfer on each query: transfer walks rescale to the speed, and the
/// minimum replaces the 120 s floor wherever no rule sets its own.
#[test]
fn production_matches_the_oracle_under_query_walk_speed_and_min_transfer() {
    const CASES: usize = 1000;
    const SPEEDS: [u32; 5] = [500, 800, 972, 1250, 2000];
    const MINIMUMS: [u32; 4] = [0, 60, 120, 300];
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let (mut nonempty, mut differs) = (0usize, 0usize);
    for case in 0..CASES {
        let net = random_net(&mut rng);
        let from = rng.below(5) as u32;
        let mut to = rng.below(5) as u32;
        if to == from {
            to = (to + 1) % 5;
        }
        let dep = 68_000 + rng.below(8_000) as i64;
        let base = query(from, to, dep, 3);
        let q = Query {
            walk_speed_mm_s: core::num::NonZeroU32::new(SPEEDS[rng.below(5) as usize]),
            min_transfer_secs: Some(MINIMUMS[rng.below(4) as usize]),
            ..base.clone()
        };
        let want = oracle(&net, &q);
        for mode in [
            PatternMode::Off,
            PatternMode::Unbounded,
            PatternMode::CoveringMerge,
        ] {
            let got = run(&net, mode, &q).unwrap_or_else(|e| panic!("case {case} {mode:?}: {e:?}"));
            let mut pts: Vec<(i64, u32)> =
                got.iter().map(|i| (i.alight_secs, i.transfers)).collect();
            pts.sort_unstable();
            assert_eq!(pts, want, "case {case} mode {mode:?}");
        }
        nonempty += (!want.is_empty()) as usize;
        differs += (want != oracle(&net, &base)) as usize;
    }
    assert!(nonempty > 300, "corpus too sparse: {nonempty}");
    // The parameters must change results, or this test shows nothing.
    assert!(
        differs > 50,
        "too few results changed by the parameters: {differs}"
    );
}

#[test]
fn the_target_cutoff_never_changes_an_itinerary() {
    // The cutoff drops labels a found target dominates. It must remove work
    // only: the same itineraries, legs and order, with and without it.
    const CASES: usize = 2000;
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    let mut nonempty = 0usize;
    for case in 0..CASES {
        let net = random_net(&mut rng);
        let from = rng.below(5) as u32;
        let mut to = rng.below(5) as u32;
        if to == from {
            to = (to + 1) % 5;
        }
        let dep = 68_000 + rng.below(8_000) as i64;
        let q = query(from, to, dep, 3);
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let tr = net.ptft_table();
        for mode in [
            PatternMode::Off,
            PatternMode::Unbounded,
            PatternMode::CoveringMerge,
        ] {
            let index = Index::build(&reader, mode).unwrap();
            let cut = plan_v2_with(&reader, &index, tr.as_ref(), &q, None, true, true).map(|r| r.0);
            let full =
                plan_v2_with(&reader, &index, tr.as_ref(), &q, None, false, true).map(|r| r.0);
            assert_eq!(cut, full, "case {case} mode {mode:?}");
            nonempty += cut.map_or(0, |v| (!v.is_empty()) as usize);
        }
    }
    assert!(nonempty > 2000, "corpus too sparse: {nonempty}");
}

#[test]
fn route_exclusions_keep_a_regular_bus_alternative_in_v2() {
    let mut net = Net::new(2, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 950), (1, 1200)]);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let mut q = query(0, 1, 850, 1);
        assert_eq!(run(&net, mode, &q).unwrap()[0].alight_secs, 1000);
        q.excluded_routes = vec![0];
        assert_eq!(run(&net, mode, &q).unwrap()[0].alight_secs, 1200);
        q.excluded_routes = vec![0, 1];
        assert!(run(&net, mode, &q).unwrap().is_empty());
    }
}
