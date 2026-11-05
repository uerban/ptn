//! `gen-fixtures <out-dir>` — emit the committed custom `.ptb` fixtures the
//! engine-regression gate routes and pins against the committed goldens
//! (`crates/pt-core/tests/raptor_behavior.rs` natively,
//! `crates/pt-wasm/tests/plan_golden.mjs` through the production binding).
//!
//! Every fixture is a current PTB v1 bundle assembled here in the std emit
//! crate (the pt-core testkit is `#[cfg(test)]` and not callable from a
//! binary). The emitted bytes are committed under the frontend test fixtures dir so CI feeds
//! the SAME bytes to the Rust `plan` path and the TS `loadPtb → ptbToBundleWire`
//! adapter — the gate is meaningless otherwise.
//!
//! Fixtures emitted (mirror the / traps that tiny.ptb cannot express):
//!   - `equal-alight-tie.ptb`  — 2 routes E→P / E→Q, equal alightSecs, 0 transfers
//! (the Pareto-tie array-order pin; mirrors reconstruct.rs
//!     `equal_alight_preserves_array_order_through_stable_sort`).
//!   - `express-skip.ptb`      — 1 route, EXPRESS trip skips a middle stop via the
//!     `-1` sentinel, a later LOCAL trip serves it (alt-trip fallback fires).
//!   - `terminal-dwell.ptb`    — 1 route with NONZERO `arr_diff` (dwell) at the
//!     alight stop; alight time = dep + arr_diff must match the engine and its wasm binding.
//!   - `footpath.ptb` + `footpath-transfers.bin` — 1 route to s1, plus a PTFT
//!     transfer table with footpath edges s1→s2 (raw 60 → FLOOR at
//!     `RAPTOR_MIN_TRANSFER_SECS` = 120) and s1→s3 (raw 200 → wheelchair RESCALE
//! 200→313). The footpath-relaxation profile, now CI-gated (was
//!     Vilnius-deferred): both the floor and the wheelchair-rescale are asserted
//!     Rust==TS over the SAME bytes. PTFT byte layout re-implemented here (mirror
//!     of `crates/pt-core/src/engine/testkit.rs::build_ptft`).
//!   - `converging-routes.ptb` — 2 routes converging on a shared stop at EQUAL
//!     arrival (the route-list ORDER tie; pairs with the value-array routesAtStop
//!     precondition).
//!   - `overnight.ptb`         — single trip departing >86400 (within-service-day).
//!   - `express-skip-dwell.ptb`— express-skip alt-trip fallback whose alt alights
//!     at a stop with NONZERO dwell (alt-path dwell subtraction).
//!   - `circular-loop.ptb`     — `[T,X,Y,T]` loop; terminal T alights at position 3.
//!   - `lasso.ptb`             — Vilnius 6G lasso `[T,S,N,L,P,N,S,T]`; stem stops
//!     repeat. Board the stem, alight at the apex (empty under the pre-fix
//!     last-write-wins alignment, valid after the per-trip cursor fix).
//!   - `transfer-floor.ptb` / `transfer-floor-miss.ptb` — non-footpath 120s board
//!     floor at a NON-entry transfer stop (feasible hit / 119s-gap miss twins).
//!   - `transfer-scoped-route.ptb` — S3 ROUTE-scoped (R0→R1) type-1 apply over
//!     the below-floor topology (floor 0 → feasible); the route→route rung of the
//!     specificity ladder, the only S3 apply path the trip-scoped fixtures missed.
//!   - `transfer-scoped-trip-beats-route.ptb` — S3 trip>route specificity: a
//!     route→route type-1 (feasible) AND a more-specific trip→trip type-3 (forbid)
//!     on the same board; the trip rule wins → EMPTY.
//!   - `maxrounds.ptb`         — 2-leg topology queried with maxRounds 1 (empty) / 2.
//!
//! Every builder has a `#[cfg(test)] mod tests` round-trip self-test (build bytes
//! → `Reader`/`Transfers::from_bytes` → assert counts + key fields) so a
//! structurally-wrong fixture fails loudly instead of letting the engine-regression
//! gate pass vacuously on bytes the engine and its wasm binding mis-decode the same way.

use std::path::Path;

fn align(n: usize, a: usize) -> usize {
    n.div_ceil(a) * a
}

fn intern(s: &str, pool: &mut Vec<String>) -> u32 {
    if let Some(p) = pool.iter().position(|x| x == s) {
        return p as u32;
    }
    pool.push(String::from(s));
    (pool.len() - 1) as u32
}

/// The tagged carry `regionId` for a `Region`, panicking if `r` is not a carry.
fn carry_id(r: pt_core::header::Region) -> u16 {
    pt_core::header::CARRY_REGIONS
        .iter()
        .find(|(_, rr)| *rr == r)
        .map(|(id, _)| *id)
        .expect("carry id for region")
}

/// Write the 24-B tagged region table into `buf` starting at offset 32:
/// per entry (regionId u16 @+0, entryFlags u16 @+2, reserved u32 @+4, offset u64 @+8,
/// length u64 @+16), terminated by a regionId-0 entry. Shared by every builder
/// here so the wire format lives in one place. `entries`:
/// (region_id, offset, length). entryFlags @[2..4] + reserved @[4..8] stay zero; the
/// trailing 24-B entry stays zero ⇒ regionId 0 terminates the table.
///
/// The `region_id` is arbitrary, so a windowDays-horizon fixture CAN include a
/// `0x01 WindowMeta` entry (`region_ids::WINDOW_META`) by appending it to the
/// `entries` slice — placed LAST (after the carries), matching the producer's
/// `current_emit.rs` table order. The DEFAULT committed fixtures emit no `0x01` (they
/// build at the 90-day window), so this slice carries only the SoA + carry ids.
fn write_region_table(buf: &mut [u8], entries: &[(u16, usize, usize)]) {
    for (i, (region_id, off, len)) in entries.iter().enumerate() {
        let e = 32 + i * 24;
        buf[e..e + 2].copy_from_slice(&region_id.to_le_bytes());
        // entryFlags @[2..4] + reserved @[4..8] stay zero.
        buf[e + 8..e + 16].copy_from_slice(&(*off as u64).to_le_bytes());
        buf[e + 16..e + 24].copy_from_slice(&(*len as u64).to_le_bytes());
    }
    // The next 24 B entry stays zero → regionId 0 terminates the table.
}

/// Scan the tagged region table (24 B entries at offset 32, regionId-0
/// terminated) for `region_id`, returning its `(offset, length)`. Panics if
/// absent — only the band builder uses this (to find the StopTimes carry for
/// the express-skip sentinel poke), and a missing StopTimes is a builder bug.
fn tagged_region(buf: &[u8], region_id: u16) -> (usize, usize) {
    let mut e = 32;
    loop {
        let id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
        if id == 0 {
            panic!("region 0x{region_id:02X} not found in tagged table");
        }
        if id == region_id {
            let off = u64::from_le_bytes(buf[e + 8..e + 16].try_into().unwrap()) as usize;
            let len = u64::from_le_bytes(buf[e + 16..e + 24].try_into().unwrap()) as usize;
            return (off, len);
        }
        e += 24;
    }
}

/// Set one trip's `bikes_allowed` value in both current metadata sources. The
/// scalar reader still reads the retained `0xF2 TripsIntern` record at byte 18,
/// while pattern-band consumers read `0x14 TripMeta` at byte 22. Keep those
/// mirrors synchronized. GTFS defines `0` as unspecified, `1` as allowed, and
/// `2` as not allowed:
/// https://gtfs.org/documentation/schedule/reference/#tripstxt
fn set_current_trip_bikes_allowed(
    buf: &mut [u8],
    trip_idx: usize,
    bikes_allowed: u8,
) -> Result<(), String> {
    const TRIP_RECORD_STRIDE: usize = 24;

    if bikes_allowed > 2 {
        return Err(format!(
            "trip metadata: invalid GTFS bikes_allowed value {bikes_allowed}"
        ));
    }
    let record_off = trip_idx
        .checked_mul(TRIP_RECORD_STRIDE)
        .ok_or_else(|| "trip metadata: trip index overflow".to_string())?;

    let fields = [
        (
            carry_id(pt_core::header::Region::TripsIntern),
            18usize,
            "0xF2 TripsIntern",
        ),
        (pt_core::region_ids::TRIP_META, 22usize, "0x14 TripMeta"),
    ];
    for (region_id, field_off, name) in fields {
        let (region_off, region_len) = tagged_region(buf, region_id);
        if record_off + TRIP_RECORD_STRIDE > region_len {
            return Err(format!(
                "{name}: trip index {trip_idx} outside {} records",
                region_len / TRIP_RECORD_STRIDE
            ));
        }
        buf[region_off + record_off + field_off] = bikes_allowed;
    }
    Ok(())
}

/// Append an unsigned LEB128 varint to `out`. PTB and PTFT share this encoding.
fn push_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            break;
        }
        out.push(b | 0x80);
    }
}

/// Build a PTFT (pedestrian-transfer) binary buffer. Byte-for-byte mirror of
/// `crates/pt-core/src/engine/testkit.rs::build_ptft` and the spec in
/// `packages/shared/src/transfers/wire.ts`: magic `PTFT`, version `1`, varint
/// `stop_count`, then per stop `{ id_len, id_bytes, edge_count,
/// (neighbor_idx, walk_secs)* }`.
///
/// `stops[i]` is the transfer-table stop id at ordinal `i`; `edges[i]` is its
/// adjacency as `(neighbor_ordinal, raw_walk_secs)`. The wire contract says
/// per-stop edges are sorted by `walk_secs` ascending — callers must pass them
/// pre-sorted (the consumer trusts but does not require it). Edges are written
/// verbatim; no validation here (the fixture controls the bytes).
fn build_ptft(stops: &[&str], edges: &[&[(u32, u32)]]) -> Vec<u8> {
    assert_eq!(stops.len(), edges.len(), "one edge list per stop");
    let mut b: Vec<u8> = vec![0x50, 0x54, 0x46, 0x54, 0x01]; // "PTFT", v1
    push_varint(&mut b, stops.len() as u64);
    for (i, id) in stops.iter().enumerate() {
        let bytes = id.as_bytes();
        push_varint(&mut b, bytes.len() as u64);
        b.extend_from_slice(bytes);
        let adj = edges[i];
        push_varint(&mut b, adj.len() as u64);
        for &(nbr, walk) in adj {
            push_varint(&mut b, nbr as u64);
            push_varint(&mut b, walk as u64);
        }
    }
    b
}

/// A single GTFS `transfers.txt` rule in the 32 B PTB record's field order;
/// `u32::MAX` marks an absent optional scope / min-transfer-time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
type TransferRow = (u32, u32, u32, u32, u32, u32, u32, u8);

/// Replace the empty tagged Transfers carry in a current-layout bundle with
/// `rows`. Current pattern-band builders retain this metadata carry after
/// stripping the flat timetable, so only its existing table entry is updated;
/// no duplicate region id is introduced.
fn with_current_transfers(mut buf: Vec<u8>, rows: &[TransferRow]) -> Result<Vec<u8>, String> {
    const PAGE: usize = 4096;
    const TRANSFER_RECORD_BYTES: usize = 32;

    let mut body = vec![0u8; rows.len() * TRANSFER_RECORD_BYTES];
    for (i, &(fs, ts, fr, tr, ft, tt, min_secs, transfer_type)) in rows.iter().enumerate() {
        let o = i * TRANSFER_RECORD_BYTES;
        body[o..o + 4].copy_from_slice(&fs.to_le_bytes());
        body[o + 4..o + 8].copy_from_slice(&ts.to_le_bytes());
        body[o + 8..o + 12].copy_from_slice(&fr.to_le_bytes());
        body[o + 12..o + 16].copy_from_slice(&tr.to_le_bytes());
        body[o + 16..o + 20].copy_from_slice(&ft.to_le_bytes());
        body[o + 20..o + 24].copy_from_slice(&tt.to_le_bytes());
        body[o + 24..o + 28].copy_from_slice(&min_secs.to_le_bytes());
        body[o + 28] = transfer_type;
    }

    let transfers_id = carry_id(pt_core::header::Region::Transfers);
    let mut entry = 32usize;
    loop {
        let id = u16::from_le_bytes(buf[entry..entry + 2].try_into().unwrap());
        if id == 0 {
            return Err("current Transfers carry missing from tagged table".into());
        }
        if id == transfers_id {
            break;
        }
        entry += 24;
    }
    let old_len = u64::from_le_bytes(buf[entry + 16..entry + 24].try_into().unwrap());
    if old_len != 0 {
        return Err(format!(
            "current Transfers carry must be empty before replacement, got {old_len} bytes"
        ));
    }

    let off = align(buf.len(), PAGE);
    let total = align(off + body.len(), PAGE);
    buf.resize(total, 0);
    buf[off..off + body.len()].copy_from_slice(&body);
    buf[entry + 8..entry + 16].copy_from_slice(&(off as u64).to_le_bytes());
    buf[entry + 16..entry + 24].copy_from_slice(&(body.len() as u64).to_le_bytes());
    Ok(buf)
}

// ── Fixture topologies ───────────────────────────────────────────────────────

/// `equal-alight-tie.ptb` — two current-v1 BUS patterns from shared entry s0
/// to distinct exits s1 (P) and s2 (Q), both reached at alightSecs 600 with no
/// transfers. Both itineraries survive dedup; the stable sort by alightSecs
/// preserves insertion order.
fn equal_alight_tie() -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [
        SoaRoute {
            id: "R0",
            agency: "A0",
            short: "0",
            long: "P",
            color: "",
            text_color: "",
            route_type: 3,
        },
        SoaRoute {
            id: "R1",
            agency: "A0",
            short: "1",
            long: "Q",
            color: "",
            text_color: "",
            route_type: 3,
        },
    ];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 0), (2, 1, 600)], // route 0: s0 -> s1 (P)
        &[(1, 0, 0), (2, 2, 600)], // route 1: s0 -> s2 (Q)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let mut buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("equal-alight-tie build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `express-skip.ptb` — two current-v1 trips on route R. T0 LOCAL serves
/// `[s0,s1,s2]`; earlier T1 EXPRESS serves `[s0,s2]` and skips s1. Off mode
/// exercises the route-level fallback to LOCAL, while the pattern modes retain
/// the two distinct stop signatures. Query s0→s1 alights from T0 at 25500.
fn express_skip() -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Express skip",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25300), (2, 1, 25500), (3, 2, 26100)], // T0 LOCAL
        &[(1, 0, 25200), (3, 2, 26000)],                // T1 EXPRESS; skips s1
    ];
    let boarding = [0x50u8; 5];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("express-skip build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `terminal-dwell.ptb` — one current-v1 BUS pattern with a nonzero arrival
/// delta at the alight stop. Arrival time is `dep_secs + arr_diff`: the trip
/// serves s0@25200 and departs s1@25800 with `arr_diff = -120`, so it arrives at
/// s1 at 25680. Query entry s0 → exit s1.
fn terminal_dwell() -> Vec<u8> {
    let stops = band_cohort_stops(2);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Terminal dwell",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25800)]];
    let boarding = [0x50u8; 2];
    let dwell_rows = [(1usize, -120i16)];
    let mut buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        None,
        &[],
        &boarding,
        &dwell_rows,
    )
    .expect("terminal-dwell build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `footpath.ptb` — one current-v1 BUS pattern serves s0@25200 → s1@25500.
/// Stops s2 and s3 exist but have no transit pattern, so they are reachable only
/// through the paired pedestrian table from [`footpath_transfers`].
fn footpath_ptb() -> Vec<u8> {
    let stops = band_cohort_stops(4);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Footpath feeder",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500)]];
    let boarding = [0x50u8; 2];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("footpath build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `footpath-transfers.bin` — PTFT table over s0..s3 with two footpath edges
/// FROM s1 (the transit-reached stop). The s1→s2 edge has raw 60s and exercises
/// the FLOOR at RAPTOR_MIN_TRANSFER_SECS (60 < 120 ⇒ effective 120; arrive s2 =
/// 25500 + 120 = 25620). The s1→s3 edge has raw 200s and exercises the
/// WHEELCHAIR RESCALE (200 → 313 under wheelchair, arrive s3 = 25500 + 313 =
/// 25813; default profile 200, arrive 25700).
///
/// Edges per stop are sorted by walk_secs ascending per the wire contract (60
/// before 200). Ordinals: s0=0, s1=1, s2=2, s3=3 (match the .ptb stop ids).
fn footpath_transfers() -> Vec<u8> {
    build_ptft(
        &["s0", "s1", "s2", "s3"],
        &[
            &[],                  // s0: no outgoing footpaths
            &[(2, 60), (3, 200)], // s1 -> s2 (floor), s1 -> s3 (rescale)
            &[],                  // s2: none
            &[],                  // s3: none
        ],
    )
}

/// `converging-routes.ptb` — two current-v1 BUS patterns from shared entry s0
/// converge on s1 at the same arrival (600), then diverge to s2 and s3. The
/// alight update uses strict `<`, so the first pattern at s1 wins the tie. The
/// `PatternsAtStop` slice is deliberately `[0, 1]`, making R0/T0 the observable
/// parent for a query that exits at s1.
fn converging_routes() -> Vec<u8> {
    let stops = band_cohort_stops(4);
    let routes = [
        SoaRoute {
            id: "R0",
            agency: "A0",
            short: "0",
            long: "Via s2",
            color: "",
            text_color: "",
            route_type: 3,
        },
        SoaRoute {
            id: "R1",
            agency: "A0",
            short: "1",
            long: "Via s3",
            color: "",
            text_color: "",
            route_type: 3,
        },
    ];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 100), (2, 1, 600), (3, 2, 1100)],
        &[(1, 0, 200), (2, 1, 600), (3, 3, 1100)],
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 6];
    let mut buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("converging-routes build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `overnight.ptb` — one current-v1 BUS pattern departing after 86400
/// (`91800 = 25:30` within the same service day). A query at 91700 boards the
/// trip and exercises departure comparison and reconstruction across the
/// service-day boundary.
fn overnight() -> Vec<u8> {
    let stops = band_cohort_stops(2);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Overnight",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 91800), (2, 1, 92400)]];
    let boarding = [0x50u8; 2];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("overnight build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `express-skip-dwell.ptb` — express-skip alt-trip fallback where the alt trip
/// alights at a stop with nonzero dwell (`arr_diff = -420`):
///   trip 0 EXPRESS: s0@28800, SKIPS s1, s2@30600 (boarded first; departs earliest)
///   trip 1 LOCAL:   s0@29400, s1 dep@30300 arr_diff -420 (7-min dwell), s2@31200
/// Query s0 → s1: board EXPRESS at s0, it skips s1, alt-trip fallback finds LOCAL
/// and alights s1 = 30300 + (-420) = 29880. The alt-path's dwell subtraction is
/// the golden-gated point (`express-skip.ptb` has zero dwell on its alt).
fn express_skip_dwell() -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Express skip dwell",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 28800), (3, 2, 30600)], // T0 EXPRESS; skips s1
        &[(1, 0, 29400), (2, 1, 30300), (3, 2, 31200)], // T1 LOCAL; row 3 dwells
    ];
    let boarding = [0x50u8; 5];
    let dwell_rows = [(3usize, -420i16)];
    let mut buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        None,
        &[],
        &boarding,
        &dwell_rows,
    )
    .expect("express-skip-dwell build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `overnight-prev-day.ptb` — one current-v1 BUS trip s0@86500 (24:01:40) ->
/// s1@86800 whose service is active every Monday, following GTFS `calendar.txt`'s
/// weekly service model:
/// https://gtfs.org/documentation/schedule/reference/#calendartxt
/// The 20260501 Friday anchor makes Monday offsets 3,10,17,… active and the
/// 20260505 Tuesday query date inactive. An early-morning query at second 100
/// therefore routes only by scanning the previous service day (20260504) and
/// translating the >24h trip to board@100/alight@400. A late-night query stays
/// empty.
fn overnight_prev_day() -> Vec<u8> {
    let mut bm = [0u8; 12];
    let mut off = 3usize; // first Monday
    while off < 90 {
        bm[off / 8] |= 1 << (off % 8);
        off += 7;
    }
    let pool: [&[u8]; 1] = [&bm];
    let s2b = [0u32];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &s2b,
        window_days: pt_core::WINDOW_DEFAULT_DAYS,
    };
    let stops = band_cohort_stops(2);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Overnight previous day",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 86500), (2, 1, 86800)]];
    let boarding = [0x50u8; 2];
    let mut buf = build_pattern_band_ptb_with_boarding_and_service(
        &stops,
        &routes,
        trips,
        None,
        &[],
        &boarding,
        &[],
        &spec,
    )
    .expect("overnight-prev-day build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `bikes-skip.ptb` — one current-v1 BUS pattern s0→s1, with its sole trip's
/// `0x14 TripMeta.bikes_allowed` set to GTFS value 2 ("not allowed"). Under
/// `Mobility::Bicycle` the board loop skips the only O→D path and returns no
/// plan; under `Mobility::Default` it routes s0→s1. This result-changing pair
/// exercises the BOARD scan site.
fn bikes_skip_fixture() -> Vec<u8> {
    let stops = band_cohort_stops(2);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Bikes skip",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500)]];
    let boarding = [0x50u8; 2];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("bikes-skip build");
    set_current_trip_bikes_allowed(&mut buf, 0, 2).expect("bikes-skip trip metadata");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `bikes-express-skip.ptb` — express-skip CANDIDATE-loop coverage. Mirrors the
/// `express_skip()` topology (boarded EXPRESS trip skips middle stop s1, the
/// alt-trip fallback serves it) but adds a SECOND local trip so the bikes-blind
/// and bicycle results DIFFER. Three reader trips, all on route 0 over s0,s1,s2;
/// the caller passes trips in departure order, and the index's stable dep-sort
/// at canonical position 0 preserves it, so the scan order is:
///   route.trips[0] = EXPRESS      (reader trip 0): s0@25200, SKIPS s1, s2@26000
///   route.trips[1] = LOCAL_NOBIKE (reader trip 1): s0@25300, s1@25500, s2@26100
///   route.trips[2] = LOCAL_BIKE   (reader trip 2): s0@25400, s1@25700, s2@26300
/// Reader trip 1 (LOCAL_NOBIKE) has current `0x14 TripMeta.bikes_allowed = 2`.
///
/// Query entry s0 → exit s1: the board loop boards EXPRESS (earliest at s0); it
/// skips s1 (`-1` sentinel) → the express-skip candidate loop runs.
///   - Default: the FIRST candidate (LOCAL_NOBIKE) serves s1, sets alt_trip, and
///     the loop `break`s (the one-candidate quirk). Alights s1 @25500.
///   - Bicycle: the first candidate is `continue`d (`is_bicycle &&
///     cand.bikes_allowed == 2`); the loop falls through to LOCAL_BIKE, which
///     alights s1 @25700.
///
/// Both yield a non-empty plan, but a DIFFERENT alight time / trip — exercising
/// the CANDIDATE scan site (not the board site, which `bikes-skip.ptb` covers).
///
fn bikes_express_skip_fixture() -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Bikes express skip",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (3, 2, 26000)], // T0 EXPRESS, skips s1, departs earliest
        &[(1, 0, 25300), (2, 1, 25500), (3, 2, 26100)], // T1 LOCAL_NOBIKE
        &[(1, 0, 25400), (2, 1, 25700), (3, 2, 26300)], // T2 LOCAL_BIKE
    ];
    let boarding = [0x50u8; 8];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("bikes-express-skip build");
    // The bicycle candidate scan skips T1 and falls through to T2.
    set_current_trip_bikes_allowed(&mut buf, 1, 2).expect("bikes-express-skip trip metadata");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `mode-ferry-only.ptb` (A5) — extended-type FERRY (`route_type` 1008, "Water
/// Service") is the only O→D path s0→s1. `route_type_to_mode(1008)` → `Ferry`, so
/// excluding FERRY yields zero itineraries while an unconstrained query yields
/// one. Built as a current PTB v1 carry-less pattern-band bundle (the
/// carry-less cohort's shared `band_cohort_stops` +
/// `build_pattern_band_ptb_with_boarding`). The FERRY `route_type` lives on the
/// `SoaRoute`. The dense all-regular (`0x50`) boarding column is supplied only
/// to get the stable `T0` trip id the self-test pins; it survives carry removal
/// only as the (in this case omitted, all-regular) `0x12 PatternSemantics`
/// region. `s2` is present in the id space but intentionally unserved.
fn mode_ferry_only() -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Ferry",
        color: "",
        text_color: "",
        route_type: 1008, // extended type: Water Service (Ferry)
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25800)]];
    let boarding = [0x50u8, 0x50];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("mode-ferry-only build");
    // Preserve the corpus query date (the band cohort's shared builder anchors
    // at 20260601; the pinned mode/* tuples query 20260505), same technique as
    // `current_boarding_fixture`.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `mode-other-bucket.ptb` (A5) — the OTHER bucket. Route 0 is air (`route_type`
/// 1100) serving s0→s1; route 1 is taxi (`route_type` 1500) serving s0→s2. Both
/// `route_type_to_mode(1100)` and `route_type_to_mode(1500)` → `Other`, so a query
/// reaching both s1 and s2 collapses to zero itineraries under an OTHER exclusion
/// (the exclusion is by the derived mode, not the raw int), while a BUS exclusion
/// leaves both. Built as a current PTB v1 carry-less pattern-band bundle via the
/// same shared cohort builder as `mode_ferry_only`; the per-trip `trip_routes` map
/// assigns trip 0 → route 0 (air) and trip 1 → route 1 (taxi), mirroring
/// `converging_multipattern_band`'s two-route shape.
fn mode_other_bucket() -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [
        SoaRoute {
            id: "R0",
            agency: "A0",
            short: "1",
            long: "Air",
            color: "",
            text_color: "",
            route_type: 1100, // extended type: Air Service
        },
        SoaRoute {
            id: "R1",
            agency: "A0",
            short: "2",
            long: "Taxi",
            color: "",
            text_color: "",
            route_type: 1500, // extended type: Taxi Service
        },
    ];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25800)], // route 0: air  -> s1
        &[(1, 0, 25200), (2, 2, 25800)], // route 1: taxi -> s2
    ];
    let trip_routes: &[u32] = &[0, 1]; // route-major: trip 0 -> R0, trip 1 -> R1
    let boarding = [0x50u8; 4];
    let mut buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("mode-other-bucket build");
    // Preserve the corpus query date (see `mode_ferry_only`).
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `circular-loop.ptb` — one current-v1 circular BUS trip `[T,X,Y,T]`, following
/// the GTFS loop model in which a round trip starts and ends at the same stop:
/// https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
/// The terminal T repeats at position 3: stop ordinals `[0,1,2,0]`, departures
/// `[0,600,1200,1800]`. A query boards X (`s1`) and alights T (`s0`), which must
/// reconstruct the position-3 occurrence at 1800 rather than position 0.
fn circular_loop() -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Circular loop",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 0), (2, 1, 600), (3, 2, 1200), (4, 0, 1800)]];
    let boarding = [0x50u8; 4];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("circular-loop build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `lasso.ptb` — one current-v1 BUS trip over a lasso: stem out `(T,S,N)`, loop
/// apex `(L,P)`, then stem back `(N,S,T)`. GTFS permits this as one `trip_id`
/// whose `stop_times` repeats stops:
/// https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
/// Stop ordinals are `[0,1,2,3,4,2,1,0]`; T, S, and N therefore occur twice.
/// The corpus query boards outbound S at position 1 and alights P at position 4.
fn lasso() -> Vec<u8> {
    let stops = band_cohort_stops(5);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Lasso",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[
        (1, 0, 0),
        (2, 1, 60),
        (3, 2, 120),
        (4, 3, 180),
        (5, 4, 240),
        (6, 2, 300),
        (7, 1, 360),
        (8, 0, 420),
    ]];
    let boarding = [0x50u8; 8];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("lasso build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-floor.ptb` — a 2-leg transfer itinerary whose transfer gap at a
/// NON-entry stop straddles RAPTOR_MIN_TRANSFER_SECS (120s). TWO routes:
///   R0: s0@25200 -> s1@25500       (leg 1, arrives s1 @25500)
///   R1: s1@25620 -> s2@26000       (leg 2; departs s1 only 120s after R0 arrives)
/// Query s0 -> s2 (non-entry transfer at s1). The board floor at s1 is
/// `arrival(25500) + RAPTOR_MIN_TRANSFER_SECS(120) = 25620`; R1 departs s1 at
/// EXACTLY 25620 so the transfer is feasible (>= floor). This gates the NON-
/// footpath 120s board floor (only the footpath floor was gated before). The
/// planner must include the transfer (non-empty, 1 transfer).
fn transfer_floor() -> Vec<u8> {
    transfer_floor_with_departure(25620)
}

/// `transfer-floor-miss.ptb` — same shape as `transfer-floor.ptb` but R1 departs
/// s1 just BELOW the floor (25619 = arrival 25500 + 119 < 120) so the transfer is
/// INFEASIBLE → no s0→s2 itinerary. The negative twin of `transfer-floor.ptb`:
/// proves the 120s floor actually bites (a gap of 119s is rejected). The result
/// must be empty.
fn transfer_floor_miss() -> Vec<u8> {
    transfer_floor_with_departure(25619)
}

fn transfer_floor_with_departure(second_leg_departure: u32) -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let first_leg = [(1, 0, 25200), (2, 1, 25500)];
    let second_leg = [(1, 1, second_leg_departure), (2, 2, 26000)];
    let trips: &[&[(u16, u32, u32)]] = &[&first_leg, &second_leg];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let mut buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-floor build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `maxrounds.ptb` — a topology requiring TWO rounds: R0 (s0->s1), R1 (s1->s2),
/// with a generous transfer gap so the connection is feasible WITHOUT a round
/// limit. With maxRounds=1 only direct (1-leg) trips run, so s0->s2 (which needs
/// the s1 transfer in round 2) yields []; with maxRounds=2 it succeeds. The same
/// .ptb is queried with several round limits.
fn maxrounds() -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1
        &[(1, 1, 26000), (2, 2, 26300)], // R1: s1 -> s2 (gap 500s, well above floor)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let mut buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("maxrounds build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `three-leg.ptb` + `three-leg-transfers.bin` — a ≥2-transfer (3 transit-leg)
/// Pareto-optimal itinerary with a PTFT footpath BETWEEN the first two transit
/// legs, so reconstruction depth (3 rounds) AND cross-walk `source_round`
/// propagation are exercised in the engine-regression gate (the committed tuples
/// otherwise top out at 2 legs / 1 transfer, leaving multi-leg reconstruction
/// and `source_round` across a walk unit-test-only).
///
/// Topology (5 stops s0..s4, 3 routes, one trip per route; departure 0):
///   R0: s0@100 -> s1@600                    (leg 1; board ENTRY s0, no floor)
///   PTFT footpath s1 -> s2 raw 300 (>=120, no floor) => arrive s2 @900,
///       source_round(s2) = lastParentRound(s1) = 1
///   R1: s2@1100 -> s3@1700                   (leg 2; board s2 in round 2, the
///       non-entry floor is arrival(900)+120 = 1020; 1100 >= 1020 feasible)
///   R2: s3@1900 -> s4@2500                   (leg 3; board s3 in round 3, the
///       non-entry floor is arrival(1700)+120 = 1820; 1900 >= 1820 feasible)
///
/// Round trace: R1 round 1 reaches s1@600 then walks s1->s2@900; round 2 boards
/// s2 -> s3@1700; round 3 boards s3 -> s4@2500. Query s0 -> s4 yields ONE
/// itinerary with legs [transit R0, walk s1->s2, transit R1, transit R2],
/// 3 transit legs => transfers = 2. The walk's `source_round` (1) drives the
/// reconstruct.rs Walk arm to rewind to round 1 for the s0->s1 transit leg.
fn three_leg() -> Vec<u8> {
    let stops = band_cohort_stops(5);
    let routes = [
        band_cohort_route(0),
        band_cohort_route(1),
        band_cohort_route(2),
    ];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 100), (2, 1, 600)],   // R0: s0 -> s1 (board entry s0)
        &[(1, 2, 1100), (2, 3, 1700)], // R1: s2 -> s3 (board s2 in round 2)
        &[(1, 3, 1900), (2, 4, 2500)], // R2: s3 -> s4 (board s3 in round 3)
    ];
    let trip_routes: &[u32] = &[0, 1, 2];
    let boarding = [0x50u8; 6];
    let mut buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("three-leg build");
    // Keep the corpus query date inside this fixture's service window.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `three-leg-transfers.bin` — PTFT table over s0..s4 with ONE footpath edge
/// s1 -> s2 (raw 300s; >= RAPTOR_MIN_TRANSFER_SECS so applied verbatim, no
/// floor). This is the bridge between transit leg 1 (ends s1) and transit leg 2
/// (starts s2): the only way to reach s2 is the walk, forcing the round-1
/// footpath relaxation to feed round 2's boarding. Edges per stop are written
/// in the same ordinal order as the .ptb stop ids (s0=0..s4=4).
fn three_leg_transfers() -> Vec<u8> {
    build_ptft(
        &["s0", "s1", "s2", "s3", "s4"],
        &[
            &[],         // s0: no outgoing footpaths
            &[(2, 300)], // s1 -> s2 (300s, no floor; bridges leg 1 to leg 2)
            &[],         // s2: none
            &[],         // s3: none
            &[],         // s4: none
        ],
    )
}

/// In-memory v1 PTB carrying a populated GTFS `transfers.txt` region:
/// row 0 is a type-3 (not-possible) stop-pair s0→s1 with no scope / min time;
/// row 1 is a type-2 (min-time) rule s1→s0 with `min_transfer_time` 180s. The
/// routing topology (1 route s0→s1) is irrelevant — this fixture exists to
/// round-trip the Transfers region in the engine and its wasm binding and to prove the scan
/// ignores it (it is NOT a engine-regression query tuple). `u32::MAX` = absent.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
#[cfg(test)]
fn transfers_fixture() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(2);
    let routes = [SoaRoute {
        id: "R",
        agency: "",
        short: "",
        long: "",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let bitmask = vec![0xFFu8; pt_core::bytes_per_service(pt_core::WINDOW_DEFAULT_DAYS)];
    let pool: [&[u8]; 1] = [bitmask.as_slice()];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &[0],
        window_days: pt_core::WINDOW_DEFAULT_DAYS,
    };
    let trip: &[(u16, u32, u32)] = &[(1, 0, 100), (2, 1, 200)];
    let buf = build_service_pool_ptb(&stops, &routes, &[trip], None, &spec)
        .expect("transfers fixture base");
    with_current_transfers(
        buf,
        &[
            (0, 1, A, A, A, A, A, 3),   // s0 -> s1, type 3 (not possible)
            (1, 0, A, A, A, A, 180, 2), // s1 -> s0, type 2, min_transfer_time = 180
        ],
    )
    .expect("transfers fixture")
}

/// `transfer-block.ptb` — the `transfer-floor.ptb` 2-leg topology (s0→s1→s2,
/// R1 departs s1 at the 120s floor so the transfer is otherwise feasible) PLUS
/// an UNSCOPED type-3 (s1,s1) `transfers.txt` rule. The type-3 rule forbids the
/// non-entry re-board at s1 in round 2 (`sameStopBoardFloor` forbid path), so
/// the only transfer pair is removed → NO s0→s2 itinerary. The planner returns
/// EMPTY in every PatternMode. (S1 — the same-stop board forbid, pinned by the
/// golden.)
/// `u32::MAX` = absent scope / min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_block() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1
        &[(1, 1, 25620), (2, 2, 26000)], // R1: s1 -> s2 (departs s1 at the floor)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-block build");
    let mut buf = with_current_transfers(
        buf,
        // UNSCOPED type-3 (s1,s1): the round-2 re-board at s1 is forbidden.
        &[(1, 1, A, A, A, A, A, 3)],
    )
    .expect("transfer-block current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-mintime-feasible.ptb` — 2-leg s0→s1→s2 where R1 departs s1 with a
/// 500s gap (25500 → 26000). An UNSCOPED type-2 (s1,s1) rule with
/// `min_transfer_time` 300 RAISES the same-stop board floor to 25800; since R1
/// departs 26000 ≥ 25800 the transfer is FEASIBLE → 1-transfer itinerary,
/// alights s2 @26300. Twin of `transfer-mintime-miss.ptb` (min straddles the
/// gap). The planner applies the per-pair min instead of the global 120s.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_mintime_feasible() -> Vec<u8> {
    transfer_mintime_with_min(300)
}

/// `transfer-mintime-miss.ptb` — same shape as `transfer-mintime-feasible.ptb`
/// but the UNSCOPED type-2 (s1,s1) `min_transfer_time` is 600, RAISING the
/// same-stop board floor to 26100 > R1's 26000 departure → the transfer is
/// INFEASIBLE → no s0→s2 path. The negative twin: proves the per-pair min
/// actually bites upward (a 500s real gap is rejected against a 600s min).
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_mintime_miss() -> Vec<u8> {
    transfer_mintime_with_min(600)
}

fn transfer_mintime_with_min(min_transfer_secs: u32) -> Vec<u8> {
    transfer_mintime_fixture(26000, 26300, min_transfer_secs)
}

fn transfer_mintime_fixture(
    second_leg_departure: u32,
    second_leg_arrival: u32,
    min_transfer_secs: u32,
) -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1 (arrives 25500)
        &[(1, 1, second_leg_departure), (2, 2, second_leg_arrival)], // R1: s1 -> s2
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-mintime build");
    let mut buf = with_current_transfers(buf, &[(1, 1, A, A, A, A, min_transfer_secs, 2)])
        .expect("transfer-mintime current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-mintime-below-floor.ptb` — DOWNWARD override. R1 departs s1 only
/// 30s after R0 arrives (25500 → 25530), a gap BELOW the global 120s floor that
/// would normally block the transfer. An UNSCOPED type-2 (s1,s1) rule with
/// `min_transfer_time` 30 LOWERS the same-stop board floor to 25530, exactly
/// R1's departure → the transfer becomes FEASIBLE → s2 @25830. Proves type-2 can
/// override the global floor downward (not only upward); without the rule this
/// same topology would be empty.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_mintime_below_floor() -> Vec<u8> {
    transfer_mintime_fixture(25530, 25830, 30)
}

/// `transfer-scoped-ignored.ptb` — guards the UNSCOPED-ONLY predicate. The same
/// `transfer-floor.ptb` feasible 2-leg topology PLUS a type-3 (s1,s1) rule that
/// ALSO carries a `from_route` scope (route 0). Because the rule is route-scoped
/// the current routing contract does not index it (`Index::build` keeps only
/// unscoped rows), so the same-stop re-board is NOT forbidden and the behaviour
/// is IDENTICAL to no rule: a 1-transfer itinerary alighting s2 @26000. Applying
/// this scoped rule would flip the result to empty, which the golden rejects.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_scoped_ignored() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1
        &[(1, 1, 25620), (2, 2, 26000)], // R1: s1 -> s2 (departs at the floor)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-scoped-ignored build");
    let mut buf = with_current_transfers(
        buf,
        // SCOPED type-3 (s1,s1) with from_route_idx = 0 → must be IGNORED.
        &[(1, 1, 0, A, A, A, A, 3)],
    )
    .expect("transfer-scoped-ignored current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-type2-no-min.ptb` — an under-specified type-2 rule without the
/// duration that type 2 describes. The `transfer-floor.ptb` feasible 2-leg
/// topology (s0→s1→s2, R1 departs s1 at EXACTLY the global 120s floor = 25620)
/// carries an UNSCOPED type-2 (s1,s1) row whose `min_transfer_time` is ABSENT
/// (`u32::MAX`). `Index::build` drops the incomplete row, so the pair falls
/// through to `RAPTOR_MIN_TRANSFER_SECS`: feasible, 1 transfer, s2 @26000.
/// Applying the absent sentinel as a duration would make s1 unboardable and
/// flip the golden to empty.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_type2_no_min() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1 (arrives 25500)
        &[(1, 1, 25620), (2, 2, 26000)], // R1: s1 -> s2 (departs at the global floor)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-type2-no-min build");
    let mut buf = with_current_transfers(
        buf,
        // UNSCOPED type-2 (s1,s1) with NO min_transfer_time (A = absent) → MUST
        // be dropped → global 120s floor → R1 @25620 feasible → s2 @26000.
        &[(1, 1, A, A, A, A, A, 2)],
    )
    .expect("transfer-type2-no-min current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-footpath-block.ptb` — the footpath type-3 skip-edge path, paired
/// with the committed `footpath-transfers.bin`. The topology has four stops;
/// R0/T0 serves s0@25200 → s1@25500, while s2/s3 have no transit service. The
/// PTFT table's only path to s2 is its raw-60s s1→s2 edge. An UNSCOPED type-3
/// (s1,s2) rule removes that edge during footpath relaxation, leaving s2
/// unreachable and the plan empty. Without the rule, the same query reaches s2
/// @25620 after the 120-second transfer floor.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_footpath_block() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(4);
    let routes = [band_cohort_route(0)];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500)]];
    let trip_routes: &[u32] = &[0];
    let boarding = [0x50u8; 2];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-footpath-block build");
    let mut buf = with_current_transfers(
        buf,
        // UNSCOPED type-3 (s1,s2): removes the footpath edge s1→s2.
        &[(1, 2, A, A, A, A, A, 3)],
    )
    .expect("transfer-footpath-block current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-footpath-mintime.ptb` — the footpath type-2 floor apply path,
/// paired with the committed `footpath-transfers.bin`. The topology has four
/// stops; R0/T0 serves s0@25200 → s1@25500, while s2/s3 have no transit service.
/// The PTFT table's s1→s2 edge has a raw walk of 60s, which normally floors to
/// the global `RAPTOR_MIN_TRANSFER_SECS` (120) → s2 @25620. An UNSCOPED type-2
/// (s1,s2) rule with `min_transfer_time` 300 — above both the raw walk (60) and
/// the global floor (120) — raises the per-pair floor to 300, so the walk leg's
/// effective duration is 300 → s2 @25800. Per the GTFS spec, transfer_type=2
/// requires a minimum amount of time between arrival and departure, and
/// `min_transfer_time` is the number of seconds available for the transfer.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_footpath_mintime() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(4);
    let routes = [band_cohort_route(0)];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500)]];
    let trip_routes: &[u32] = &[0];
    let boarding = [0x50u8; 2];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-footpath-mintime build");
    let mut buf = with_current_transfers(
        buf,
        // UNSCOPED type-2 (s1,s2), min 300 (> raw 60 and > global 120) → s2 @25800.
        &[(1, 2, A, A, A, A, 300, 2)],
    )
    .expect("transfer-footpath-mintime current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-timed-board.ptb` — a type-1 (timed) transfer on the same-stop board
/// path. Three stops s0/s1/s2 on two routes: R0 runs s0 @25200 → s1 @25500 and
/// R1 departs s1 at 25530, a 30s gap that the global 120s floor would otherwise
/// reject. An unscoped type-1 (s1,s1) row is attached. Per the GTFS spec a
/// `transfer_type=1` row marks a timed transfer point: the departing vehicle is
/// expected to wait for the arriving one and allow enough time to transfer. PTN
/// pins that as a per-pair floor of 0, so the round-2 re-board floor at s1 is
/// arrival(25500) + 0 = 25500 ≤ R1's 25530 departure → the connection is
/// feasible and the itinerary alights s2 @25830. Without the row the global
/// floor (25620 > 25530) leaves the same topology with no s0→s2 path.
/// `u32::MAX` = absent scope / min time (a type-1 row carries no min).
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_timed_board() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1 (arrives 25500)
        &[(1, 1, 25530), (2, 2, 25830)], // R1: s1 -> s2 (departs 25530, 30s gap)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-timed-board build");
    let mut buf = with_current_transfers(
        buf,
        // Unscoped type-1 (s1,s1): timed transfer → floor 0 → re-board feasible.
        &[(1, 1, A, A, A, A, A, 1)],
    )
    .expect("transfer-timed-board current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-timed-footpath.ptb` — a type-1 (timed) transfer on a footpath edge,
/// paired with the committed `footpath-transfers.bin`. The topology has four
/// stops; R0/T0 serves s0 @25200 → s1 @25500, while s2/s3 have no transit
/// service. The PTFT table's s1→s2 edge has a raw walk of 60s, which normally
/// floors to the global `RAPTOR_MIN_TRANSFER_SECS` (120) → s2 @25620. Per the
/// GTFS spec, a `transfer_type=1` row marks a timed transfer point whose
/// departing vehicle is expected to wait and allow enough time to transfer. PTN
/// pins the unscoped (s1,s2) row as a per-pair floor of 0, so the effective walk
/// remains 60s and reaches s2 @25560. `u32::MAX` = absent scope / min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_timed_footpath() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(4);
    let routes = [band_cohort_route(0)];
    let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500)]];
    let trip_routes: &[u32] = &[0];
    let boarding = [0x50u8; 2];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-timed-footpath build");
    let mut buf = with_current_transfers(
        buf,
        // Unscoped type-1 (s1,s2): floor 0 keeps the raw 60s walk → s2 @25560.
        &[(1, 2, A, A, A, A, A, 1)],
    )
    .expect("transfer-timed-footpath current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-timed-scoped-ignored.ptb` — a route-scoped type-1 transfer over the
/// same below-floor topology as `transfer-timed-board.ptb`: R0 reaches s1 at
/// 25500 and R1 departs only 30s later at 25530. Per GTFS, `from_route_id`
/// restricts a transfer rule to arriving trips on that route; the raw row uses
/// `from_route_idx=0`. PTN's current timed-transfer floor index accepts only
/// unscoped rows, so this rule does not lower the 120s global floor and the
/// s0→s2 plan remains empty. If the scoped row entered that index, its floor of
/// 0 would make the connection feasible and reach s2 @25830. `u32::MAX` = absent
/// remaining scope fields / min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_timed_scoped_ignored() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1 (arrives 25500)
        &[(1, 1, 25530), (2, 2, 25830)], // R1: s1 -> s2 (departs 25530, 30s gap)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-timed-scoped-ignored build");
    let mut buf = with_current_transfers(
        buf,
        // Route-scoped type-1 (s1,s1), omitted from the unscoped floor index.
        &[(1, 1, 0, A, A, A, A, 1)],
    )
    .expect("transfer-timed-scoped-ignored current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-scoped-block.ptb` — a trip-scoped type-3 rule over a connection
/// that would otherwise be feasible. R0/T0 reaches s1 at 25500 and R1/T1 leaves
/// at the 120s floor, 25620. The `(s1,s1, from_trip=T0, to_trip=T1)` row forbids
/// exactly that continuation, leaving no s0→s2 plan. Per GTFS, type 3 means
/// transfers are not possible at the location, while `from_trip_id` and
/// `to_trip_id` restrict the rule to the named arriving and departing trips.
/// The trip ordinals are T0 = 0 and T1 = 1. `u32::MAX` = absent route scope /
/// min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_scoped_block() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0/T0: s0 -> s1
        &[(1, 1, 25620), (2, 2, 26000)], // R1/T1: s1 -> s2 (at the floor)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-scoped-block build");
    let mut buf = with_current_transfers(
        buf,
        // Trip-scoped type-3 (s1,s1, T0→T1): forbid this continuation.
        // Fields: fromStop, toStop, fromRoute, toRoute, fromTrip, toTrip, min, type.
        &[(1, 1, A, A, 0, 1, A, 3)],
    )
    .expect("transfer-scoped-block current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-scoped-specificity.ptb` — two rules on the same stop pair, where
/// the more specific one decides the connection. R0/T0 reaches s1 at 25500 and
/// R1/T1 leaves s1 only 30s later at 25530, below the 120s global floor, so the
/// s0→s2 plan is empty unless a rule lowers that floor. Two rows sit on
/// (s1,s1): row 0 is an unscoped type-3, which on its own would forbid the
/// re-board; row 1 is a type-1 scoped to `from_trip=T0`, `to_trip=T1`, whose
/// floor is 0. Per GTFS, when several transfers apply to an arriving/departing
/// trip pair the one with the greatest specificity is used, and both trip ids
/// set is the highest specificity — so row 1 governs the T0→T1 re-board and
/// makes it feasible, reaching s2 at 25830 with 1 transfer. The unscoped row
/// still governs any other pair at s1. The trip ordinals are T0 = 0 and T1 = 1.
/// `u32::MAX` = absent route scope / min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_scoped_specificity() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0/T0: s0 -> s1 (arrives 25500)
        &[(1, 1, 25530), (2, 2, 25830)], // R1/T1: s1 -> s2 (departs 25530, 30s gap)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-scoped-specificity build");
    let mut buf = with_current_transfers(
        buf,
        // Fields: fromStop, toStop, fromRoute, toRoute, fromTrip, toTrip, min, type.
        &[
            // Unscoped type-3 (s1,s1): would forbid the re-board on its own.
            (1, 1, A, A, A, A, A, 3),
            // Trip-scoped type-1 (s1,s1, T0→T1): more specific → wins → floor 0.
            (1, 1, A, A, 0, 1, A, 1),
        ],
    )
    .expect("transfer-scoped-specificity current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-inseat.ptb` — a trip-scoped type-4 rule over a connection that is
/// already feasible without it. R0/T0 reaches s1 at 25500 and R1/T1 leaves s1 at
/// 25620, exactly the 120s global floor, so the s0→s2 journey rides both trips
/// either way. The `(s1,s1, from_trip=T0, to_trip=T1)` row marks that
/// continuation as in-seat. Per GTFS, type 4 links two trips operated by the
/// same vehicle and lets passengers remain aboard, while `from_trip_id` and
/// `to_trip_id` restrict the rule to the named arriving and departing trips. In
/// this `pt-core` fixture the plan still emits both transit legs, and the
/// in-seat continuation is excluded from the reported transfer count, so s2 is
/// reached at 26000. The trip ordinals are T0 = 0 and T1 = 1. `u32::MAX` =
/// absent route scope / min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_inseat() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0/T0: s0 -> s1 (arrives 25500)
        &[(1, 1, 25620), (2, 2, 26000)], // R1/T1: s1 -> s2 (at the floor)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-inseat build");
    let mut buf = with_current_transfers(
        buf,
        // Trip-scoped type-4 (s1,s1, T0→T1): in-seat continuation.
        // Fields: fromStop, toStop, fromRoute, toRoute, fromTrip, toTrip, min, type.
        &[(1, 1, A, A, 0, 1, A, 4)],
    )
    .expect("transfer-inseat current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `block-chained-lasso-inseat.ptb` — two trips linked end to end by a
/// trip-scoped type-4 in-seat rule at a turnaround stop. Outbound R0/T0 runs
/// `s0→s1→s2` and reaches the apex s2 at 120; inbound R1/T1 runs `s2→s3→s4` and
/// leaves s2 at 180, only 60s later and below the 120s global floor. The
/// `(s2,s2, from_trip=T0, to_trip=T1)` row links them. Per GTFS, type 4 lets
/// passengers transfer from one trip to the next by staying onboard the same
/// vehicle; linked trips must be operated by the same vehicle, the last stop of
/// `from_trip_id` should be close to the first stop of `to_trip_id`, and both
/// trip ids are required. In this `pt-core` fixture the in-seat rule is the only
/// way to make the 60s apex connection, so the s0→s4 plan emits both transit
/// legs, reaches s4 at 300, and reports 0 transfers. Synthetic analog of
/// Vilnius 6G. The trip ordinals are T0 = 0 and T1 = 1. `u32::MAX` = absent
/// route scope / min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn block_chained_lasso_inseat() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(5);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 0), (2, 1, 60), (3, 2, 120)], // R0/T0: s0 -> s2 (arrives apex s2 @120)
        &[(1, 2, 180), (2, 3, 240), (3, 4, 300)], // R1/T1: s2 -> s4 (departs apex @180)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 6];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("block-chained-lasso-inseat build");
    let mut buf = with_current_transfers(
        buf,
        // Trip-scoped type-4 (s2,s2, T0→T1): in-seat continuation at the apex.
        // Fields: fromStop, toStop, fromRoute, toRoute, fromTrip, toTrip, min, type.
        &[(2, 2, A, A, 0, 1, A, 4)],
    )
    .expect("block-chained-lasso-inseat current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-inseat-forbidden.ptb` — the same feasible-at-floor topology as
/// `transfer-inseat.ptb`, but the trip-scoped rule on `(s1,s1, T0→T1)` is type 5
/// instead of type 4. R0/T0 reaches s1 at 25500 and R1/T1 leaves s1 at 25620,
/// exactly the 120s global floor. Per GTFS, type 5 links two sequential trips
/// but forbids an in-seat continuation: the passenger must alight from the
/// arriving trip and board the departing one. In this `pt-core` fixture that
/// ordinary transfer is still feasible at the global floor, so the plan emits
/// both transit legs and counts the re-board as one transfer, reaching s2 at
/// 26000. The trip ordinals are T0 = 0 and T1 = 1. `u32::MAX` = absent route
/// scope / min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_inseat_forbidden() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0/T0: s0 -> s1 (arrives 25500)
        &[(1, 1, 25620), (2, 2, 26000)], // R1/T1: s1 -> s2 (at the floor)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-inseat-forbidden build");
    let mut buf = with_current_transfers(
        buf,
        // Trip-scoped type-5 (s1,s1, T0→T1): in-seat continuation forbidden.
        // Fields: fromStop, toStop, fromRoute, toRoute, fromTrip, toTrip, min, type.
        &[(1, 1, A, A, 0, 1, A, 5)],
    )
    .expect("transfer-inseat-forbidden current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-scoped-route.ptb` — a route-scoped type-1 rule over a connection
/// that is infeasible without it. R0/T0 reaches s1 at 25500 and R1/T1 leaves s1
/// only 30s later at 25530, below the 120s global floor, so the s0→s2 plan is
/// empty unless a rule lowers that floor. The `(s1,s1, from_route=R0,
/// to_route=R1)` row leaves both trip ids absent. Per GTFS, type 1 is a timed
/// transfer whose departing vehicle waits for the arriving one, and
/// `from_route_id` / `to_route_id` apply the rule to arriving trips on R0 and
/// departing trips on R1 at those stops. In this `pt-core` fixture the matching
/// route-scoped rule lowers the floor to 0, so the plan rides both trips and
/// reaches s2 at 25830 with 1 transfer. The topology mirrors
/// `transfer_scoped_specificity()` with a route scope instead of a trip scope.
/// The route ordinals are R0 = 0 and R1 = 1. `u32::MAX` = absent trip scope /
/// min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_scoped_route() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0/T0: s0 -> s1 (arrives 25500)
        &[(1, 1, 25530), (2, 2, 25830)], // R1/T1: s1 -> s2 (departs 25530, 30s gap)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-scoped-route build");
    let mut buf = with_current_transfers(
        buf,
        // Route-scoped type-1 (s1,s1, R0→R1): timed, per-pair floor 0.
        // Fields: fromStop, toStop, fromRoute, toRoute, fromTrip, toTrip, min, type.
        &[(1, 1, 0, 1, A, A, A, 1)],
    )
    .expect("transfer-scoped-route current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `transfer-scoped-trip-beats-route.ptb` — a trip-scoped rule and a
/// route-scoped rule that both match the same re-board, where the trip-scoped
/// one decides it. R0/T0 reaches s1 at 25500 and R1/T1 leaves s1 at 25620,
/// exactly the 120s global floor, so the s0→s2 journey is feasible without any
/// rule. Two rows sit on (s1,s1): row 0 is a type-1 scoped to
/// `from_route=R0`, `to_route=R1`, which on its own would keep the re-board
/// feasible; row 1 is a type-3 scoped to `from_trip=T0`, `to_trip=T1`, which
/// forbids it. Per GTFS, the transfer with the greatest specificity for an
/// arriving/departing trip pair is chosen, and both trip ids set ranks above
/// both route ids set — so row 1 governs the T0→T1 re-board and the s0→s2 plan
/// is empty. The route ordinals are R0 = 0 and R1 = 1; the trip ordinals are
/// T0 = 0 and T1 = 1. `u32::MAX` = absent scope / min time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn transfer_scoped_trip_beats_route() -> Vec<u8> {
    const A: u32 = u32::MAX;
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500)], // R0/T0: s0 -> s1 (arrives 25500)
        &[(1, 1, 25620), (2, 2, 26000)], // R1/T1: s1 -> s2 (at the floor)
    ];
    let trip_routes: &[u32] = &[0, 1];
    let boarding = [0x50u8; 4];
    let buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("transfer-scoped-trip-beats-route build");
    let mut buf = with_current_transfers(
        buf,
        // Fields: fromStop, toStop, fromRoute, toRoute, fromTrip, toTrip, min, type.
        &[
            // Route-scoped type-1 (s1,s1, R0→R1): would keep the re-board feasible.
            (1, 1, 0, 1, A, A, A, 1),
            // Trip-scoped type-3 (s1,s1, T0→T1): more specific, forbids it.
            (1, 1, A, A, 0, 1, A, 3),
        ],
    )
    .expect("transfer-scoped-trip-beats-route current Transfers region");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

// ── Multi-pattern route fixtures ────────────────────────────────────────────

/// `branch-pattern.ptb` — one route R with two trips that share a trunk and
/// split at position 2:
///   T0 LOCAL:  `s0→s1→s2→s4` (25200..26100)
///   T1 BRANCH: `s0→s1→s3→s4` (28800..29700)
///
/// The current-v1 band stores the two stop sequences as two patterns. Under
/// `PatternMode::Off` the route keeps one canonical pattern (the LOCAL
/// sequence), so the branch-only stop s3 is unreachable and the s0→s3 plan is
/// empty. Under `PatternMode::Unbounded` and `CoveringMerge` each sequence is its
/// own pattern, so s3 is served by the BRANCH pattern and the s0→s3 plan rides
/// T1. Feed date 20260501 keeps the corpus query inside the service window.
fn branch_pattern() -> Vec<u8> {
    let stops = band_cohort_stops(5);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Branch pattern",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)], // T0 LOCAL
        &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)], // T1 BRANCH via s3
    ];
    let boarding = [0x50u8; 8];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("branch-pattern build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `disjoint-dirs.ptb` — one route R with two trips that share no stops, the
/// shape of a route whose two directions use separate stop sequences (the
/// Vilnius-1G topology):
///   T0 OUTBOUND: `s0→s1→s2` (25200..25800)
///   T1 INBOUND:  `s3→s4→s5` (28800..29400)
///
/// The current-v1 band stores the two directions as two patterns. Under
/// `PatternMode::Off` the route keeps one canonical pattern (OUTBOUND), so the
/// inbound stops are unreachable and the s3→s5 plan is empty. Under
/// `PatternMode::Unbounded` and `CoveringMerge` each direction is its own
/// pattern and the s3→s5 plan rides T1. Feed date 20260501 keeps the corpus
/// query inside the service window.
fn disjoint_dirs() -> Vec<u8> {
    let stops = band_cohort_stops(6);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Disjoint directions",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)], // T0 OUTBOUND: s0->s1->s2
        &[(1, 3, 28800), (2, 4, 29100), (3, 5, 29400)], // T1 INBOUND:  s3->s4->s5
    ];
    let boarding = [0x50u8; 6];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("disjoint-dirs build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `converging-multipattern.ptb` — two routes; R0 has two trips with different
/// stop sequences, and R1 has one trip that converges with R0 at s4 at the same
/// arrival time:
///
///   R0/T0: `s0→s1→s4`  (25200, 25500, 25800)
///   R0/T1: `s0→s2→s4`  (25200, 25500, 25800) — different branch stop
///   R1/T2: `s3→s4→s5`  (25200, 25800, 26100) — reaches s4 at 25800
///
/// The current-v1 band stores three patterns: R0's two sequences and R1's one.
/// Under `PatternMode::Unbounded` and `CoveringMerge` s1 and s2 are each served
/// only by their own R0 pattern, and s4 is served by both routes; the
/// equal-time convergence at s4 pins the scan order. Under `PatternMode::Off`
/// R0 keeps only its canonical `s0→s1→s4` pattern. The corpus query s0→s1 rides
/// R0/T0 in every mode. Feed date 20260501 keeps that query inside the service
/// window.
fn converging_multipattern() -> Vec<u8> {
    let stops = band_cohort_stops(6);
    let routes = [band_cohort_route(0), band_cohort_route(1)];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500), (3, 4, 25800)], // R0/T0: s0->s1->s4
        &[(1, 0, 25200), (2, 2, 25500), (3, 4, 25800)], // R0/T1: s0->s2->s4
        &[(1, 3, 25200), (2, 4, 25800), (3, 5, 26100)], // R1/T2: s3->s4->s5
    ];
    let trip_routes: &[u32] = &[0, 0, 1];
    let boarding = [0x50u8; 9];
    let mut buf = build_pattern_band_ptb_with_boarding(
        &stops,
        &routes,
        trips,
        Some(trip_routes),
        &[],
        &boarding,
        &[],
    )
    .expect("converging-multipattern build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `pickup-equivalence.ptb` — one route R with two trips where s2 is the last
/// stop of T0 but a middle stop of T1:
///   T0: `s0→s1→s2`  (25200..25800; s2 is the terminus)
///   T1: `s0→s2→s3`  (28800..29400; s2 is a middle stop)
///
/// Every stop time is regular pickup and drop-off. The current-v1 band stores
/// the two sequences as two patterns. Under `PatternMode::Off` the route keeps
/// one canonical pattern (T0's), so s3 is unreachable and the s0→s3 plan is
/// empty. Under `PatternMode::Unbounded` and `CoveringMerge` T1 is its own
/// pattern, s2 is a boardable middle stop there, and the s0→s3 plan rides T1.
/// Feed date 20260501 keeps the corpus query inside the service window.
fn pickup_equivalence() -> Vec<u8> {
    let stops = band_cohort_stops(4);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Pickup equivalence",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)], // T0: s0->s1->s2 (terminus)
        &[(1, 0, 28800), (2, 2, 29100), (3, 3, 29400)], // T1: s0->s2->s3 (s2 mid)
    ];
    let boarding = [0x50u8; 6];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("pickup-equivalence build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `lasso-multipattern.ptb` — one route R with two lasso trips that share the
/// entry s0, the stem s1, and the exit s3 but turn around at different apexes:
///   T0: `s0→s1→s2→s1→s3`  (25200..26400; apex s2, s1 visited twice)
///   T1: `s0→s1→s4→s1→s3`  (28800..30000; apex s4, s1 visited twice)
///
/// GTFS best practices model a lasso as one trip whose `stop_times` visit a
/// stop twice:
/// https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
/// The current-v1 band stores each trip's repeated-stop sequence as its own
/// pattern. Under `PatternMode::Unbounded` and `CoveringMerge` both apexes are
/// routable. Under `PatternMode::Off` the route keeps only T0's canonical
/// pattern, so the apex s4 is unreachable. Feed date 20260501 keeps the corpus
/// queries inside the service window. The single-trip `lasso.ptb` is a separate
/// fixture.
fn lasso_multipattern() -> Vec<u8> {
    let stops = band_cohort_stops(5);
    let routes = [SoaRoute {
        id: "R",
        agency: "A0",
        short: "1",
        long: "Lasso multipattern",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[
            (1, 0, 25200),
            (2, 1, 25500),
            (3, 2, 25800), // T0 apex s2
            (4, 1, 26100), // s1 again
            (5, 3, 26400), // s3 exit
        ],
        &[
            (1, 0, 28800),
            (2, 1, 29100),
            (3, 4, 29400), // T1 apex s4
            (4, 1, 29700), // s1 again
            (5, 3, 30000), // s3 exit
        ],
    ];
    let boarding = [0x50u8; 10];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("lasso-multipattern build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `covering-merge.ptb` — one route R0 whose six trips exercise the
/// `PatternMode::CoveringMerge` fold. Under `CoveringMerge` a trip whose stop
/// sequence is a contiguous run of a longer trip's sequence folds into the
/// longer pattern and rides its positions with `-1` holes at the positions it
/// does not serve; offsets compose along transitive chains. Three cases share
/// the route, on disjoint stop sets so they never fold across cases:
///
///   FOLD (stops 0..4):
///     T0 short:   `[s1,s2,s3]`        (1000,1300,1600) — folds into T1 at offset 1
///     T1 long:    `[s0,s1,s2,s3,s4]`  (2000..3200) — survives
///   OPPOSITE DIRECTION (same stops):
///     T2 reverse: `[s4,s3,s2,s1,s0]`  (5000..6200) — not a contiguous run of T1,
///                 so it stays a separate pattern
///   TRANSITIVE (stops 5..9):
///     T3 small:   `[s7,s8]`           (1000,1300) — folds into T4 at offset 1
///     T4 medium:  `[s6,s7,s8]`        (1500,1800,2100) — folds into T5 at offset 1
///     T5 long:    `[s5,s6,s7,s8,s9]`  (2500..3700) — survives
///
/// The fold visits trips in this storage order: T3 folds into the still-surviving
/// T4 at offset 1, then T4 folds into T5 at offset 1, so T3's offset in T5
/// composes to 2. A non-composing fold would place T3 at offset 1, where
/// `[s7,s8]` is not a window of T5.
///
/// The current-v1 band stores the six trips as six patterns; the fold happens
/// in `Index::build`. Surviving `CoveringMerge` patterns: `[s0..s4]` (with T0),
/// `[s4..s0]`, and `[s5..s9]` (with T4 at 1 and T3 at 2). Under
/// `PatternMode::Off` the route keeps only T1's canonical `[s0..s4]` pattern.
/// Feed date 20260501 keeps the corpus queries inside the service window.
/// pt-core's `index.rs` fold test reads these committed bytes directly.
fn covering_merge() -> Vec<u8> {
    let stops = band_cohort_stops(10);
    let routes = [SoaRoute {
        id: "R0",
        agency: "A0",
        short: "1",
        long: "Covering merge",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        // FOLD: short [s1,s2,s3] folds into long [s0..s4] at offset 1.
        &[(1, 1, 1000), (2, 2, 1300), (3, 3, 1600)],
        &[
            (1, 0, 2000),
            (2, 1, 2300),
            (3, 2, 2600),
            (4, 3, 2900),
            (5, 4, 3200),
        ],
        // OPPOSITE DIRECTION: reverse [s4,s3,s2,s1,s0], a separate pattern.
        &[
            (1, 4, 5000),
            (2, 3, 5300),
            (3, 2, 5600),
            (4, 1, 5900),
            (5, 0, 6200),
        ],
        // TRANSITIVE: [s7,s8] ⊂ [s6,s7,s8] ⊂ [s5,s6,s7,s8,s9]; offsets compose.
        &[(1, 7, 1000), (2, 8, 1300)],
        &[(1, 6, 1500), (2, 7, 1800), (3, 8, 2100)],
        &[
            (1, 5, 2500),
            (2, 6, 2800),
            (3, 7, 3100),
            (4, 8, 3400),
            (5, 9, 3700),
        ],
    ];
    let boarding = [0x50u8; 23];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], &boarding, &[])
            .expect("covering-merge build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

// ── TypeScript reader fixtures ───────────────────────────────────────────────
//
// Topologies the TypeScript PTB reader tests (shared wire adapter, backend
// loadFromPtb) need and the engine corpus does not otherwise carry. They are
// not engine corpus tuples.

/// `covering-loop.ptb` — one route RL whose covering trip revisits a stop:
///   TC: `X→Y→Z→Y→W`  (28800..29200)
///   TF: `Z→Y→W`      (50000..51200)
/// TF's sequence is a contiguous run of TC's starting at offset 2, so under
/// `PatternMode::CoveringMerge` it folds into TC's pattern at positions 2..4.
/// A from-position-0 cursor would match TF's Y to TC's first Y instead.
fn covering_loop() -> Vec<u8> {
    let stops: Vec<SoaStop<'static>> = ["X", "Y", "Z", "W"]
        .iter()
        .enumerate()
        .map(|(i, id)| SoaStop {
            id,
            name: id,
            lat: 54.60 + i as f64 * 0.01,
            lon: 25.20 + i as f64 * 0.01,
            parent: None,
            wheelchair: 0,
        })
        .collect();
    let routes = [SoaRoute {
        id: "RL",
        agency: "A0",
        short: "L",
        long: "Loop",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[
            (1, 0, 28800), // X
            (2, 1, 28900), // Y (first)
            (3, 2, 29000), // Z
            (4, 1, 29100), // Y (second)
            (5, 3, 29200), // W
        ],
        &[(1, 2, 50000), (2, 1, 50600), (3, 3, 51200)], // Z, Y, W
    ];
    let trip_ids = ["TC".to_string(), "TF".to_string()];
    let mut buf =
        build_pattern_band_ptb_with_trip_ids(&stops, &routes, trips, None, &trip_ids, &[])
            .expect("covering-loop build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `lasso-unserved-occurrence.ptb` — the `lasso.ptb` loop (`s0→s1→s2→s3→s4→
/// s2→s1→s0`, 0..420 s) on route R1 / trip T1, except the OUTBOUND s1 (row 1)
/// is present but not served. A reader must leave that occurrence's slot empty
/// and keep the served return s1 (360 s) on position 6.
/// GTFS lasso reference:
/// https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
fn lasso_unserved_occurrence() -> Vec<u8> {
    let names = ["T", "S", "N", "L", "P"];
    let stops: Vec<SoaStop<'static>> = ["s0", "s1", "s2", "s3", "s4"]
        .iter()
        .enumerate()
        .map(|(i, id)| SoaStop {
            id,
            name: names[i],
            lat: 54.68 + i as f64 * 0.01,
            lon: 25.27 + i as f64 * 0.01,
            parent: None,
            wheelchair: 0,
        })
        .collect();
    let routes = [SoaRoute {
        id: "R1",
        agency: "A0",
        short: "6G",
        long: "Lasso",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[&[
        (1, 0, 0),
        (2, 1, 60), // outbound s1: poked NOT_SERVED below
        (3, 2, 120),
        (4, 3, 180),
        (5, 4, 240),
        (6, 2, 300),
        (7, 1, 360),
        (8, 0, 420),
    ]];
    let trip_ids = ["T1".to_string()];
    let mut buf =
        build_pattern_band_ptb_with_trip_ids(&stops, &routes, trips, None, &trip_ids, &[1])
            .expect("lasso-unserved-occurrence build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `same-pattern-trips.ptb` — one route R0 whose two trips TA (28800..29100)
/// and TB (36000..36300) serve the same stops `s0→s1→s2→s3`, so every pattern
/// mode yields a single pattern.
fn same_pattern_trips() -> Vec<u8> {
    let stops = band_cohort_stops(4);
    let routes = [SoaRoute {
        id: "R0",
        agency: "A0",
        short: "0",
        long: "Route Zero",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 0, 28800), (2, 1, 28900), (3, 2, 29000), (4, 3, 29100)],
        &[(1, 0, 36000), (2, 1, 36100), (3, 2, 36200), (4, 3, 36300)],
    ];
    let trip_ids = ["TA".to_string(), "TB".to_string()];
    let mut buf =
        build_pattern_band_ptb_with_trip_ids(&stops, &routes, trips, None, &trip_ids, &[])
            .expect("same-pattern-trips build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `shared-prefix-ids.ptb` — 50 routes with 6 trips each, every id sharing a
/// long prefix (`vilnius_0000..0049`, `A1-01-1-2512-00000..00299`), the shape
/// of a real feed's ids. A reader that keys on a truncated id collapses them;
/// every route and trip must survive with its own trips attributed to it.
fn shared_prefix_ids() -> Vec<u8> {
    const ROUTES: usize = 50;
    const TRIPS_PER_ROUTE: usize = 6;
    let stops = [
        SoaStop {
            id: "S1",
            name: "One",
            lat: 54.6,
            lon: 25.2,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "S2",
            name: "Two",
            lat: 54.7,
            lon: 25.3,
            parent: None,
            wheelchair: 0,
        },
    ];
    let route_ids: Vec<String> = (0..ROUTES).map(|n| format!("vilnius_{n:04}")).collect();
    let shorts: Vec<String> = (0..ROUTES).map(|n| n.to_string()).collect();
    let longs: Vec<String> = (0..ROUTES).map(|n| format!("Route {n}")).collect();
    let routes: Vec<SoaRoute<'_>> = (0..ROUTES)
        .map(|n| SoaRoute {
            id: &route_ids[n],
            agency: "vilnius_ag",
            short: &shorts[n],
            long: &longs[n],
            color: "",
            text_color: "",
            route_type: 3,
        })
        .collect();
    let n_trips = ROUTES * TRIPS_PER_ROUTE;
    let rows: Vec<[(u16, u32, u32); 2]> = (0..n_trips as u32)
        .map(|i| [(1, 0, 25200 + i * 60), (2, 1, 25500 + i * 60)])
        .collect();
    let trips: Vec<&[(u16, u32, u32)]> = rows.iter().map(|r| r.as_slice()).collect();
    let trip_routes: Vec<u32> = (0..n_trips).map(|i| (i / TRIPS_PER_ROUTE) as u32).collect();
    let trip_ids: Vec<String> = (0..n_trips)
        .map(|i| format!("A1-01-1-2512-{i:05}"))
        .collect();
    let mut buf = build_pattern_band_ptb_with_trip_ids(
        &stops,
        &routes,
        &trips,
        Some(&trip_routes),
        &trip_ids,
        &[],
    )
    .expect("shared-prefix-ids build");
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `window-horizon.ptb` — Step A.9 (C3): the ONLY committed engine corpus fixture
/// whose runtime `windowDays` is NOT the historical 90. It is a current PTB v1
/// SoA bundle carrying a `0x01 WindowMeta` region of `400` (the WINDOW_HARD_CEILING, max
/// stride = `bytes_per_service(400)` = 50 B) so the engine and its wasm binding decode the wide
/// window and walk a 50-byte per-service bitmask. Without this fixture every
/// committed tuple has windowDays = 90, so a mis-wired window (e.g. TS defaults
/// 90 while Rust reads 400) would pass the gate green — nothing would exercise a
/// non-90 stride in the engine and its wasm binding.
///
/// Topology: 2 stops s0/s1, 1 BUS route R0 (route_type 3), 1 trip s0@25200 →
/// s1@25500. feedStartDate anchor 20260601 (a Monday). The service is
/// ALL-ACTIVE across the FULL 400-day window (50 bytes of 0xFF). All-active is a
/// trivially-CLEAN-WEEKLY pattern (every weekday active), so the TS adapter's
/// `deriveDays` weekly reconstruction AGREES with the per-day bitmask on EVERY
/// day of the window — the whole-window active-set precondition HOLDS here
/// (proving wide-stride parity), unlike the deliberately-non-weekly tiny.ptb.
///
/// The paired tuple queries on a service date PAST day 90 (20260909 = offset
/// 100), a day only reachable under the wide window: under a buggy 90-day decode
/// that day is out-of-window/inactive → the engines would diverge (empty vs
/// routed); under the correct 400-day decode BOTH route the s0→s1 trip
/// identically.
///
/// Built via the shared current-layout service-pool builder
/// (`build_service_pool_ptb`) with a one-entry `ServicePoolSpec`: the whole-window
/// mask goes in `pool[0]` and `service_to_bitfield = [0]`, so the single service
/// resolves through the real `0x16 → 0x15` seam (the pool is mandatory). The
/// `window_days` field on the spec still selects the wide
/// `bytes_per_service(window_days)` stride and the trailing `0x01 WindowMeta`
/// entry. Edit this in lockstep with the loader (`loader.ts`) and the reader
/// window decode (`crates/pt-core/src/{header,reader}.rs`) if the WindowMeta wire
/// format or the service-pool region order ever moves.
fn window_horizon() -> Vec<u8> {
    // All-active across the FULL window — a trivially-CLEAN-WEEKLY pattern, so the
    // TS adapter's deriveDays weekly reconstruction AGREES with the per-day bitmask
    // on EVERY day (the whole-window precondition holds, proving wide-stride parity).
    let bitmask = vec![0xFFu8; pt_core::bytes_per_service(WINDOW_HORIZON_WINDOW_DAYS)];
    let pool: [&[u8]; 1] = [bitmask.as_slice()];
    let s2b: [u32; 1] = [0];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &s2b,
        window_days: WINDOW_HORIZON_WINDOW_DAYS,
    };
    let stops = [
        SoaStop {
            id: "s0",
            name: "Origin",
            lat: 54.6872,
            lon: 25.2797,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s1",
            name: "Dest",
            lat: 54.6892,
            lon: 25.2810,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R0",
        agency: "A0",
        short: "0",
        long: "Horizon",
        color: "",
        text_color: "",
        route_type: 3, // BUS
    }];
    build_service_pool_ptb(
        &stops,
        &routes,
        // ONE trip s0@25200 → s1@25500 (the same daytime shape as the other
        // single-trip fixtures so no overnight/edge handling is involved).
        &[&[(1, 0, 25200), (2, 1, 25500)]],
        None,
        &spec,
    )
    .expect("window-horizon service-pool build")
}

/// `window-nonweekly-horizon.ptb` — Step A.11 (per-day-fidelity proof): a wide
/// window whose per-day service bitmask is deliberately NON-WEEKLY and diverges
/// PAST day 90, so the TS wire adapter's weekly `deriveDays` base alone CANNOT
/// reproduce it — only the computed `exceptions[]` (this fix) make the wire
/// per-day-faithful.
///
/// Topology mirrors `window-horizon`: 2 stops s0/s1, 1 BUS route R0, 1 trip
/// s0@25200 → s1@25500. feedStartDate anchor 20260601 (a Monday, so day-offset
/// `n` has weekday `n % 7`, 0=Mon). windowDays = 400 (WINDOW_HARD_CEILING — the
/// 50-byte wide stride).
///
/// Per-day bitmask:
///   - days 0..90  : active Mon–Fri (weekday 0..=4), off Sat/Sun
///   - days 90..400: active Mondays ONLY (weekday == 0)
///
/// The first window-week is fully inside the Mon–Fri block, so `deriveDays`
/// reconstructs the weekly base `[Mon..Fri active, Sat/Sun off]`. That base marks
/// EVERY non-Monday weekday past day 90 active — e.g. offset 92 (20260901, a
/// Tuesday) — but the per-day bitmask marks them INACTIVE. The native pt-core
/// engine reads the bitmask directly (correct: inactive); the lossy weekly-only
/// TS wire INVENTS phantom Tuesday service. With computed exceptions the TS wire
/// emits `exceptions["20260901"]=2` (removed), so the resolved active-set EQUALS
/// the bitmask across the FULL 400-day window and the engine and its wasm binding agree.
///
/// The paired tuple queries 20260901 (offset 92 > 90): native → empty (inactive),
/// faithful TS → empty (exception removes it). Under the un-fixed lossy wire TS
/// would route the trip → a RED golden mismatch. See window_nonweekly_horizon()
/// and the `deriveDays`-faithful note in ptbToBundleWire.ts.
fn window_nonweekly_horizon() -> Vec<u8> {
    let window_days = WINDOW_HORIZON_WINDOW_DAYS;
    let stride = pt_core::bytes_per_service(window_days);
    let mut bitmask = vec![0u8; stride];
    // feedStartDate 20260601 is a Monday, so day-offset n has weekday n % 7
    // (0=Mon). No calendar math needed — the anchor's weekday is pinned.
    for n in 0..window_days as usize {
        let weekday = n % 7; // 0=Mon .. 6=Sun
        let active = if n < 90 {
            weekday <= 4 // Mon–Fri
        } else {
            weekday == 0 // Mondays only past day 90 (the non-weekly divergence)
        };
        if active {
            bitmask[n / 8] |= 1 << (n % 8);
        }
    }
    let pool: [&[u8]; 1] = [bitmask.as_slice()];
    let s2b: [u32; 1] = [0];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &s2b,
        window_days,
    };
    let stops = [
        SoaStop {
            id: "s0",
            name: "Origin",
            lat: 54.6872,
            lon: 25.2797,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s1",
            name: "Dest",
            lat: 54.6892,
            lon: 25.2810,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R0",
        agency: "A0",
        short: "0",
        long: "Horizon NonWeekly",
        color: "",
        text_color: "",
        route_type: 3, // BUS
    }];
    build_service_pool_ptb(
        &stops,
        &routes,
        &[&[(1, 0, 25200), (2, 1, 25500)]],
        None,
        &spec,
    )
    .expect("window-nonweekly-horizon service-pool build")
}

/// The non-90 window the `window-horizon.ptb` fixture carries (the
/// WINDOW_HARD_CEILING — max stride, max divergence-catching power). Kept as a
/// named const so the self-test and the runtime expectation read the same value.
const WINDOW_HORIZON_WINDOW_DAYS: u16 = pt_core::WINDOW_HARD_CEILING;

// ── Logical SoA stop / route inputs ─────────────────────────────────────────
//
// Column order is NORMATIVE from the frozen registry §4: 0x40 =
// id_idx·name_idx·lat_e7·lon_e7·parent_idx u32/i32×N + wheelchair u8×N; 0x41 =
// id·agency·short·long·color·text_color u32×M + route_type u16×M, each region
// 4-aligned. Coords are quantized from f64 via
// `pt_core::coord_quant::encode_{lat,lon}_e7` BEFORE any narrowing.

/// One logical SoA stop (mirror of `testkit::SoaStop`). Coords are the f64 SOURCE.
struct SoaStop<'a> {
    id: &'a str,
    name: &'a str,
    lat: f64,
    lon: f64,
    parent: Option<u32>,
    wheelchair: u8,
}

/// One logical SoA route (mirror of `testkit::SoaRoute`).
struct SoaRoute<'a> {
    id: &'a str,
    agency: &'a str,
    short: &'a str,
    long: &'a str,
    color: &'a str,
    text_color: &'a str,
    route_type: u16,
}

// ── Pattern-band emitter ────────────────────────────────────────────────────
//
// `build_pattern_band_ptb` is the source of every committed pattern-band
// fixture. It assembles a SoA staging carry (SoA `StopTimes` + `0x15`/`0x16`
// ServiceBitfieldPool), appends the pattern-band region bodies
// (`0x10`-`0x14`/`0x45`/`0x46`) produced by
// `pt_core::pattern_emit::encode_pattern_band` over `Index::build(reader,
// PatternMode::Unbounded)`, then strips the staging carry so the band is the
// only timetable in the published bytes.
//
// The band bodies are placed LAST (after the SoA + carry regions) and their
// region-table entries are pushed AFTER the carry entries, so the carry offsets
// the band derive reads never shift.
//
// SHARES the layout: the service-pool carry comes from [`build_service_pool_ptb`]
// and the band bytes from `encode_pattern_band` — NO duplicated band/carry layout
// here, mirroring the testkit's `build_pattern_band_ptb`.
//
// `sentinel_rows` lists global stop_time row indices whose `dep_secs` is poked to
// `DEP_SECS_NOT_SERVED` AFTER the StopTimes body is written — the express-skip
// trap: a present-but-unserved row inside a longer pattern, so the cursor leaves
// that canonical position `-1` (the `0x13` `served_bits` 0-bit / decode hole).
// GTFS lasso/repeated-stop reference (the cursor's repeated-stop case):
// https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
fn build_pattern_band_ptb(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    trip_routes: Option<&[u32]>,
    sentinel_rows: &[usize],
    // (flat_row, arr_diff) dwell pokes into the SoA arr_diff column, applied
    // BEFORE the band derive (arr_diff <= 0; arr = dep + arr_diff). Empty ⇒ zero
    // dwell. Lets a fixture carry a NONZERO i32 dwell delta (overnight-i32).
    dwell_rows: &[(usize, i16)],
) -> Result<Vec<u8>, String> {
    build_pattern_band_ptb_with_boarding(
        stops,
        routes,
        trips,
        trip_routes,
        sentinel_rows,
        &[],
        dwell_rows,
    )
}

/// Like [`build_pattern_band_ptb`] but injects one packed boarding byte per flat
/// stop-time row before the band is encoded. The resulting `0x12
/// PatternSemantics` survives carry removal; the temporary `0xFA` region does not.
fn build_pattern_band_ptb_with_boarding(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    trip_routes: Option<&[u32]>,
    sentinel_rows: &[usize],
    boarding: &[u8],
    dwell_rows: &[(usize, i16)],
) -> Result<Vec<u8>, String> {
    let all_active = vec![0xFFu8; pt_core::bytes_per_service(pt_core::WINDOW_DEFAULT_DAYS)];
    let pool: [&[u8]; 1] = [all_active.as_slice()];
    let s2b: [u32; 1] = [0];
    let spec = ServicePoolSpec {
        window_days: pt_core::WINDOW_DEFAULT_DAYS,
        pool: &pool,
        service_to_bitfield: &s2b,
    };
    build_pattern_band_ptb_with_boarding_and_service(
        stops,
        routes,
        trips,
        trip_routes,
        sentinel_rows,
        boarding,
        dwell_rows,
        &spec,
    )
}

/// The pattern-band builder with an explicit current-v1 service-pool contract.
/// Most fixtures use the all-active wrapper above; service-calendar fixtures use
/// this entry point so the band and the retained `0x15`/`0x16` regions derive
/// from the same mask.
#[allow(clippy::too_many_arguments)]
fn build_pattern_band_ptb_with_boarding_and_service(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    trip_routes: Option<&[u32]>,
    sentinel_rows: &[usize],
    boarding: &[u8],
    dwell_rows: &[(usize, i16)],
    spec: &ServicePoolSpec<'_>,
) -> Result<Vec<u8>, String> {
    build_pattern_band_ptb_full(
        stops,
        routes,
        trips,
        trip_routes,
        None,
        sentinel_rows,
        boarding,
        dwell_rows,
        spec,
    )
}

/// Like [`build_pattern_band_ptb`] (all-active service, all-regular boarding)
/// but with explicit trip ids, one per trip in `trips` order.
fn build_pattern_band_ptb_with_trip_ids(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    trip_routes: Option<&[u32]>,
    trip_ids: &[String],
    sentinel_rows: &[usize],
) -> Result<Vec<u8>, String> {
    let all_active = vec![0xFFu8; pt_core::bytes_per_service(pt_core::WINDOW_DEFAULT_DAYS)];
    let pool: [&[u8]; 1] = [all_active.as_slice()];
    let s2b: [u32; 1] = [0];
    let spec = ServicePoolSpec {
        window_days: pt_core::WINDOW_DEFAULT_DAYS,
        pool: &pool,
        service_to_bitfield: &s2b,
    };
    build_pattern_band_ptb_full(
        stops,
        routes,
        trips,
        trip_routes,
        Some(trip_ids),
        sentinel_rows,
        &[],
        &[],
        &spec,
    )
}

/// The full pattern-band builder. `trip_ids` names each trip; `None` gives
/// `T0..` when a boarding column is present and empty ids otherwise.
#[allow(clippy::too_many_arguments)]
fn build_pattern_band_ptb_full(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    trip_routes: Option<&[u32]>,
    trip_ids: Option<&[String]>,
    sentinel_rows: &[usize],
    boarding: &[u8],
    dwell_rows: &[(usize, i16)],
    spec: &ServicePoolSpec<'_>,
) -> Result<Vec<u8>, String> {
    use pt_core::region_ids::{
        PATTERNS, PATTERNS_AT_STOP, PATTERN_SEMANTICS, PATTERN_STOPS, PATTERN_TRIPS,
        STOP_TIME_BOARDING, TRIP_META, TRIP_TIMES,
    };

    const PAGE: usize = 4096;
    let st_rows: usize = trips.iter().map(|t| t.len()).sum();
    for &row in sentinel_rows {
        if row >= st_rows {
            return Err(format!(
                "pattern-band: sentinel row {row} >= num stop_time rows {st_rows}"
            ));
        }
    }
    for &(row, _) in dwell_rows {
        if row >= st_rows {
            return Err(format!(
                "pattern-band: dwell row {row} >= num stop_time rows {st_rows}"
            ));
        }
    }
    if !boarding.is_empty() && boarding.len() != st_rows {
        return Err(format!(
            "pattern-band: boarding column must be one byte per stop_time row ({} != {st_rows})",
            boarding.len()
        ));
    }

    // 1. Assemble the current staging carry (SoA StopTimes + the explicit
    //    0x15/0x16 ServiceBitfieldPool). `trip_routes` carries the per-trip route
    //    assignment for multi-route topologies (None ⇒ route 0 for every trip).
    let default_trip_ids = (trip_ids.is_none() && !boarding.is_empty()).then(|| {
        (0..trips.len())
            .map(|i| format!("T{i}"))
            .collect::<Vec<_>>()
    });
    let trip_ids = trip_ids.or(default_trip_ids.as_deref());
    let mut buf =
        build_service_pool_ptb_with_trip_ids(stops, routes, trips, trip_routes, trip_ids, spec)?;
    if !boarding.is_empty() {
        buf = append_tagged_region(buf, STOP_TIME_BOARDING, boarding);
    }

    // Poke express-skip sentinels into the SoA dep column (StopTimes_off +
    // 4*row) so the cursor leaves that canonical position -1.
    let (st_off, _st_len) = tagged_region(&buf, 0xF4); // StopTimes carry id
    for &row in sentinel_rows {
        let o = st_off + 4 * row;
        buf[o..o + 4].copy_from_slice(&pt_core::engine::consts::DEP_SECS_NOT_SERVED.to_le_bytes());
    }
    // Poke nonzero dwell into the SoA arr_diff column (StopTimes_off + 8N +
    // 2*row, i16 LE) BEFORE the band derive so encode_pattern_band reads it.
    for &(row, arr_diff) in dwell_rows {
        let o = st_off + 8 * st_rows + 2 * row;
        buf[o..o + 2].copy_from_slice(&arr_diff.to_le_bytes());
    }

    // 2. Build the index over the poked carry and encode the band (shared layout).
    let band = {
        let reader = pt_core::Reader::from_bytes(buf.clone())
            .map_err(|e| format!("pattern-band: service-pool carry decode: {e:?}"))?;
        let index = pt_core::Index::build(&reader, pt_core::PatternMode::Unbounded)
            .map_err(|e| format!("pattern-band: Index::build (Unbounded): {e:?}"))?;
        pt_core::pattern_emit::encode_pattern_band(&reader, &index)
            .map_err(|e| format!("pattern-band: encode_pattern_band: {e:?}"))?
    };

    // 3. Find the current table end (regionId-0 terminator) and append the band
    //    bodies page-aligned after the current buffer (the carry total).
    let mut table_e = 32;
    while u16::from_le_bytes(buf[table_e..table_e + 2].try_into().unwrap()) != 0 {
        table_e += 24;
    }
    let mut cursor = buf.len();

    let mut band_regions: Vec<(u16, &[u8])> = vec![
        (PATTERNS, band.patterns.as_slice()),
        (PATTERN_STOPS, band.pattern_stops.as_slice()),
    ];
    if !band.pattern_semantics.is_empty() {
        band_regions.push((PATTERN_SEMANTICS, band.pattern_semantics.as_slice()));
    }
    band_regions.extend_from_slice(&[
        (TRIP_TIMES, band.trip_times.as_slice()),
        (TRIP_META, band.trip_meta.as_slice()),
        (PATTERNS_AT_STOP, band.patterns_at_stop.as_slice()),
        (PATTERN_TRIPS, band.pattern_trips.as_slice()),
    ]);

    let mut appended: Vec<(u16, usize, usize)> = Vec::with_capacity(band_regions.len());
    for (id, body) in &band_regions {
        let off = cursor;
        let end = off + body.len();
        let new_total = align(end, PAGE);
        buf.resize(new_total, 0);
        buf[off..end].copy_from_slice(body);
        appended.push((*id, off, body.len()));
        cursor = new_total;
    }

    // 4. Push the band table entries after the carry entries (the slot after the
    //    last write stays zero ⇒ regionId 0 still terminates the table). The
    //    `0x13 TripTimes` entry carries `entryFlags` bit1
    //    (`TRIP_TIMES_FLAG_I32_DELTAS`) when the band used the wide i32 layout —
    //    the REGION-level width signal threaded from `encode_pattern_band`.
    //    `strip_regions` (step 6) PRESERVES entryFlags, so the carry-less bundle
    //    keeps the bit set.
    for (id, off, len) in &appended {
        let entry_flags: u16 = if *id == TRIP_TIMES && band.trip_times_i32 {
            pt_core::reader::TRIP_TIMES_FLAG_I32_DELTAS
        } else {
            0
        };
        buf[table_e..table_e + 2].copy_from_slice(&id.to_le_bytes());
        buf[table_e + 2..table_e + 4].copy_from_slice(&entry_flags.to_le_bytes());
        buf[table_e + 8..table_e + 16].copy_from_slice(&(*off as u64).to_le_bytes());
        buf[table_e + 16..table_e + 24].copy_from_slice(&(*len as u64).to_le_bytes());
        table_e += 24;
    }

    // 6. Strip the staging carry (0xF4 StopTimes / 0xF5 TripStarts / 0xF6 Csr /
    //    0xFA StopTimeBoarding) now that the band has been derived from it above.
    //    The band (0x10/0x11/0x13/0x14/0x45/0x46, + 0x12 when present) serves
    //    every PatternMode: Unbounded/CoveringMerge read it directly, and Off's
    //    flat path synthesizes trip starts and the route CSR from it. MUST run
    //    AFTER encode_pattern_band so the band is derived from the still-present
    //    carry, never before.
    let buf = pt_core::strip_regions(buf, &[0xF4, 0xF5, 0xF6, 0xFA])
        .map_err(|e| format!("carry strip: {e:?}"))?;
    Ok(buf)
}

// ── Current ServiceBitfieldPool emitter ───────────────────────────────────────
//
// The current layout stores service masks in a de-duplicated
// `0x15 ServiceBitfieldPool` (`count u32` + `count` distinct
// day-vectors of `S = bytes_per_service(window_days)` bytes each) + a
// `0x16 ServiceToBitfield` index (`num_services × u32`, each entry a pool index).
// This mirrors the testkit layout because the testkit is `#[cfg(test)]` and not
// callable from this binary. Committed fixtures exercise the engine and its wasm
// binding through the same `0x16 → 0x15` resolution path.

/// One distinct pool bitfield + the per-service index, the logical input to
/// [`build_service_pool_ptb`]. `window_days` selects the per-service stride
/// `S = bytes_per_service(window_days)` and whether a trailing `0x01 WindowMeta`
/// entry is emitted (only when `window_days != WINDOW_DEFAULT_DAYS`); at the
/// default 90 the bundle omits WindowMeta.
struct ServicePoolSpec<'a> {
    /// Distinct day-vectors, each EXACTLY `bytes_per_service(window_days)` bytes.
    /// Order is the on-wire pool order; `service_to_bitfield` indexes into it.
    pool: &'a [&'a [u8]],
    /// `service_to_bitfield[s]` = the `pool` index for service `s`. Length is
    /// `num_services`; every entry MUST be `< pool.len()`.
    service_to_bitfield: &'a [u32],
    /// The runtime service window. `WINDOW_DEFAULT_DAYS` (90) ⇒ `S = 12` and NO
    /// `0x01 WindowMeta` entry. A wider window
    /// (e.g. `WINDOW_HARD_CEILING` = 400 ⇒ `S = 50`) emits a trailing
    /// `0x01 WindowMeta` u16 and sizes the pool stride to the wide value, allowing
    /// a large-stride fixture to exercise a high-byte day past the default window.
    window_days: u16,
}

/// Build a staging-shape PTB v1 bundle (flat carry, no band) with caller-supplied
/// service storage: `0x15 ServiceBitfieldPool` (`count u32` + `count × S`
/// distinct bitfields) right after `0xF2 TripsIntern`, then `0x16
/// ServiceToBitfield` (`num_services × u32` pool indices, 4-aligned via page
/// placement).
/// `trips` reference service 0 (the carry topology); `service_bitmask(s)` reads the
/// pool for ANY `s < num_services` via the `0x16` index.
///
/// `trip_routes` is the per-trip GTFS route assignment (length == `num_trips`,
/// each entry `< routes.len()`). `None` ⇒ the single-route default: every trip
/// rides route 0 and every served stop maps to route 0. `Some(map)` ⇒ each
/// trip's `route_idx` comes from `map`; the route→trips CSR groups trips by route
/// (route-major) and the stop→routes CSR lists, per stop, the routes that serve it
/// (route-major, deduped) — the multi-route CSR shape
/// so the band-vs-flat cross-check holds for multi-route topologies (the
/// converging-multipattern sibling). Trips MUST be supplied route-major when
/// `Some` (all of route 0's trips, then route 1's, …) so the CSR `rt_val` stays a
/// contiguous run per route.
fn build_service_pool_ptb(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    trip_routes: Option<&[u32]>,
    spec: &ServicePoolSpec<'_>,
) -> Result<Vec<u8>, String> {
    build_service_pool_ptb_with_trip_ids(stops, routes, trips, trip_routes, None, spec)
}

/// Variant used by fixtures that need stable projected trip ids. `None` keeps
/// the compact empty-id layout used by the existing service-pool cohort.
fn build_service_pool_ptb_with_trip_ids(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    trip_routes: Option<&[u32]>,
    trip_ids: Option<&[String]>,
    spec: &ServicePoolSpec<'_>,
) -> Result<Vec<u8>, String> {
    use pt_core::header::Region;
    use pt_core::region_ids::{
        ROUTES_SOA, SERVICE_BITFIELD_POOL, SERVICE_TO_BITFIELD, STOPS_SOA, WINDOW_META,
    };

    const PAGE: usize = 4096;
    const HEADER: usize = 4096;
    let n = stops.len();
    let m = routes.len();
    let num_trips = trips.len();
    if num_trips < 1 {
        return Err("service-pool: need at least one trip for the carry topology".into());
    }
    if m < 1 {
        return Err("service-pool: need at least one route for the route->trips CSR".into());
    }
    if let Some(ids) = trip_ids {
        if ids.len() != num_trips {
            return Err(format!(
                "service-pool: trip_ids len {} != num_trips {num_trips}",
                ids.len()
            ));
        }
    }
    // Per-trip route assignment: None ⇒ every trip on route 0 (single-route
    // default). Some ⇒ validate length + bounds; the CSR/route_idx honor it.
    let trip_route_of: Vec<u32> = match trip_routes {
        None => vec![0u32; num_trips],
        Some(map) => {
            if map.len() != num_trips {
                return Err(format!(
                    "service-pool: trip_routes len {} != num_trips {num_trips}",
                    map.len()
                ));
            }
            for (t, &r) in map.iter().enumerate() {
                if (r as usize) >= m {
                    return Err(format!(
                        "service-pool: trip_routes[{t}] = {r} >= num_routes {m}"
                    ));
                }
            }
            // Route-major: a route's trips must be contiguous (so rt_val is a run).
            let mut last = 0u32;
            for (t, &r) in map.iter().enumerate() {
                if r < last {
                    return Err(format!(
                        "service-pool: trip_routes must be route-major (non-decreasing); \
                         trip {t} route {r} < prev {last}"
                    ));
                }
                last = r;
            }
            map.to_vec()
        }
    };
    let st_rows: usize = trips.iter().map(|t| t.len()).sum();

    // Service-pool dimensions: S = bytes_per_service(window_days). A trailing
    // `0x01 WindowMeta` entry is emitted ONLY for a non-default window (the M3
    // large-S fixture); at the default 90 no `0x01` is written, so the bundle is
    // byte-identical to a build without WindowMeta. num_services comes from the index.
    let window_days = spec.window_days;
    let emit_window_meta = window_days != pt_core::WINDOW_DEFAULT_DAYS;
    let s_bytes = pt_core::bytes_per_service(window_days);
    let num_services = spec.service_to_bitfield.len() as u32;
    if spec.pool.is_empty() {
        return Err("service-pool: pool must hold at least one distinct bitfield".into());
    }
    for (i, bf) in spec.pool.iter().enumerate() {
        if bf.len() != s_bytes {
            return Err(format!(
                "service-pool: pool[{i}] is {} bytes, expected bytes_per_service({window_days}) = {s_bytes}",
                bf.len()
            ));
        }
    }
    for (s, &idx) in spec.service_to_bitfield.iter().enumerate() {
        if (idx as usize) >= spec.pool.len() {
            return Err(format!(
                "service-pool: service_to_bitfield[{s}] = {idx} >= pool.len() = {}",
                spec.pool.len()
            ));
        }
    }

    // StringPool: index 0 = ""; then stop ids, stop names, route fields (interned).
    let mut pool: Vec<String> = vec![String::new()];
    let stop_id_idx: Vec<u32> = stops.iter().map(|s| intern(s.id, &mut pool)).collect();
    let stop_name_idx: Vec<u32> = stops.iter().map(|s| intern(s.name, &mut pool)).collect();
    let route_id_idx: Vec<u32> = routes.iter().map(|r| intern(r.id, &mut pool)).collect();
    let route_agency_idx: Vec<u32> = routes.iter().map(|r| intern(r.agency, &mut pool)).collect();
    let route_short_idx: Vec<u32> = routes.iter().map(|r| intern(r.short, &mut pool)).collect();
    let route_long_idx: Vec<u32> = routes.iter().map(|r| intern(r.long, &mut pool)).collect();
    let route_color_idx: Vec<u32> = routes.iter().map(|r| intern(r.color, &mut pool)).collect();
    let route_text_idx: Vec<u32> = routes
        .iter()
        .map(|r| intern(r.text_color, &mut pool))
        .collect();
    let trip_id_idx: Vec<u32> = match trip_ids {
        Some(ids) => ids.iter().map(|id| intern(id, &mut pool)).collect(),
        None => vec![0; num_trips],
    };
    let blob: String = pool.concat();
    let pool_len = 4 + (pool.len() + 1) * 4 + blob.len();

    // 0x40 StopsSoA columns (coords quantized f64 → *_e7 BEFORE narrowing).
    let mut lat_e7 = Vec::with_capacity(n);
    for s in stops {
        lat_e7.push(
            pt_core::coord_quant::encode_lat_e7(s.lat)
                .ok_or_else(|| format!("service-pool: lat out of WGS84 range: {}", s.lat))?,
        );
    }
    let mut lon_e7 = Vec::with_capacity(n);
    for s in stops {
        lon_e7.push(
            pt_core::coord_quant::encode_lon_e7(s.lon)
                .ok_or_else(|| format!("service-pool: lon out of WGS84 range: {}", s.lon))?,
        );
    }
    let parent_idx: Vec<u32> = stops.iter().map(|s| s.parent.unwrap_or(u32::MAX)).collect();
    let wheelchair: Vec<u8> = stops.iter().map(|s| s.wheelchair).collect();
    let stops_soa_len = n * (4 * 5) + n;
    let mut stops_soa = Vec::with_capacity(stops_soa_len);
    pt_core::soa_emit::encode_stops_soa_columns(
        &mut stops_soa,
        &stop_id_idx,
        &stop_name_idx,
        &lat_e7,
        &lon_e7,
        &parent_idx,
        &wheelchair,
    );
    debug_assert_eq!(stops_soa.len(), stops_soa_len);

    // 0x41 RoutesSoA columns.
    let route_type: Vec<u16> = routes.iter().map(|r| r.route_type).collect();
    let routes_soa_len = m * (4 * 6) + m * 2;
    let mut routes_soa = Vec::with_capacity(routes_soa_len);
    pt_core::soa_emit::encode_routes_soa_columns(
        &mut routes_soa,
        &route_id_idx,
        &route_agency_idx,
        &route_short_idx,
        &route_long_idx,
        &route_color_idx,
        &route_text_idx,
        &route_type,
    );
    debug_assert_eq!(routes_soa.len(), routes_soa_len);

    // 0x44 StopIndex + the producer assertion (column ↔ index agreement).
    let resolve = |idx: u32| pool.get(idx as usize).map(|s| s.as_str());
    let si_seq: Vec<(u32, u32)> = stop_id_idx
        .iter()
        .enumerate()
        .map(|(i, &idx)| (idx, i as u32))
        .collect();
    let stop_index = pt_core::stop_index::build(&si_seq, resolve);
    {
        let resolve = |idx: u32| pool.get(idx as usize).map(|s| s.as_str());
        for (i, s) in stops.iter().enumerate() {
            match pt_core::stop_index::lookup(&stop_index, s.id, resolve) {
                Some(o) if o as usize == i => {}
                other => {
                    return Err(format!(
                        "service-pool: StopIndex.lookup({}) = {other:?}, expected {i}",
                        s.id
                    ));
                }
            }
        }
    }

    // Carry bodies. Trips: route per `trip_route_of`, service 0; 24 B
    // stride. The trip rides service 0, so its activity comes from
    // `service_to_bitfield[0]`'s pool bitfield — the routing tuple is active only
    // when that bitfield is.
    let trips_len = num_trips * 24;
    let mut trips_body = vec![0u8; trips_len];
    for (t, &route_of_t) in trip_route_of.iter().enumerate() {
        let o = t * 24;
        trips_body[o..o + 4].copy_from_slice(&trip_id_idx[t].to_le_bytes());
        trips_body[o + 8..o + 12].copy_from_slice(&route_of_t.to_le_bytes()); // route_idx
        trips_body[o + 12..o + 16].copy_from_slice(&0u32.to_le_bytes()); // service_idx
    }

    // `0x15 ServiceBitfieldPool` body: `count u32` + `count × S` distinct
    // bitfields (verbatim, in pool order). `0x16 ServiceToBitfield` body:
    // `num_services × u32` pool indices.
    let mut bitfield_pool_body = Vec::with_capacity(4 + spec.pool.len() * s_bytes);
    bitfield_pool_body.extend_from_slice(&(spec.pool.len() as u32).to_le_bytes());
    for bf in spec.pool {
        bitfield_pool_body.extend_from_slice(bf);
    }
    let mut svc_to_bitfield_body = Vec::with_capacity(spec.service_to_bitfield.len() * 4);
    for &idx in spec.service_to_bitfield {
        svc_to_bitfield_body.extend_from_slice(&idx.to_le_bytes());
    }

    // StopTimes use SoA columns (dep_secs u32@4i | stop_idx u32@4N+4i |
    // arr_diff i16@8N+2i | stop_seq u16@10N+2i; tight 12*N).
    let st_len = st_rows * 12;
    let mut st_body = vec![0u8; st_len];
    {
        let nrows = st_rows;
        let mut row = 0usize;
        for t in trips {
            for &(seq, sidx, dep) in *t {
                st_body[4 * row..4 * row + 4].copy_from_slice(&dep.to_le_bytes());
                st_body[4 * nrows + 4 * row..4 * nrows + 4 * row + 4]
                    .copy_from_slice(&sidx.to_le_bytes());
                // arr_diff i16 @ 8N + 2i stays 0.
                st_body[10 * nrows + 2 * row..10 * nrows + 2 * row + 2]
                    .copy_from_slice(&seq.to_le_bytes());
                row += 1;
            }
        }
    }

    // TripStarts: prefix sum of per-trip row counts.
    let ts_len = (num_trips + 1) * 4;
    let mut ts_body = vec![0u8; ts_len];
    {
        let mut acc = 0u32;
        for (i, t) in trips.iter().enumerate() {
            acc += t.len() as u32;
            let o = (i + 1) * 4;
            ts_body[o..o + 4].copy_from_slice(&acc.to_le_bytes());
        }
    }

    // route→trips CSR: rt_off[r] = cumulative trip count before route r (trips are
    // route-major). stop→routes CSR: per stop, the routes serving it (route-major,
    // deduped within route — the multi-route shape). When
    // `trip_routes` is None every trip is on route 0 and every SERVED stop maps to
    // [route 0], so the bytes are identical to the prior single-route layout ONLY
    // when every declared stop is served by some trip — an UNSERVED stop gets an
    // empty stop→routes entry here vs the old unconditional [route 0]. True for all
    // current fixtures (every declared stop is served).
    let mut rt_off = vec![0u32; m + 1];
    for &r in &trip_route_of {
        rt_off[r as usize + 1] += 1;
    }
    for i in 0..m {
        rt_off[i + 1] += rt_off[i];
    }
    // Trips are route-major, so a simple ascending list IS the route-major rt_val.
    let rt_val: Vec<u32> = (0..num_trips as u32).collect();
    let mut routes_per_stop: Vec<Vec<u32>> = vec![Vec::new(); n];
    for (t, trip) in trips.iter().enumerate() {
        let r = trip_route_of[t];
        for &(_seq, stop_idx, _dep) in trip.iter() {
            let v = &mut routes_per_stop[stop_idx as usize];
            if !v.contains(&r) {
                v.push(r);
            }
        }
    }
    let mut sr_offsets = vec![0u32; n + 1];
    let mut sr_values: Vec<u32> = Vec::new();
    for s in 0..n {
        for &r in &routes_per_stop[s] {
            sr_values.push(r);
        }
        sr_offsets[s + 1] = sr_values.len() as u32;
    }
    let csr_len = (rt_off.len() + rt_val.len() + sr_offsets.len() + sr_values.len()) * 4;
    let mut csr_body = Vec::with_capacity(csr_len);
    for v in rt_off.iter().chain(rt_val.iter()) {
        csr_body.extend_from_slice(&v.to_le_bytes());
    }
    for v in sr_offsets.iter().chain(sr_values.iter()) {
        csr_body.extend_from_slice(&v.to_le_bytes());
    }

    // StringPool body.
    let mut pool_body = vec![0u8; pool_len];
    {
        pool_body[0..4].copy_from_slice(&(pool.len() as u32).to_le_bytes());
        let off_base = 4;
        let blob_base = off_base + (pool.len() + 1) * 4;
        let mut cur = 0u32;
        for (i, sstr) in pool.iter().enumerate() {
            pool_body[off_base + i * 4..off_base + i * 4 + 4].copy_from_slice(&cur.to_le_bytes());
            let bytes = sstr.as_bytes();
            pool_body[blob_base + cur as usize..blob_base + cur as usize + bytes.len()]
                .copy_from_slice(bytes);
            cur += bytes.len() as u32;
        }
        pool_body[off_base + pool.len() * 4..off_base + pool.len() * 4 + 4]
            .copy_from_slice(&cur.to_le_bytes());
    }

    // Transfers: empty.
    let transfers_len = 0usize;
    let transfers_body: Vec<u8> = Vec::new();

    // 0x01 WindowMeta body: the runtime window as an LE u16 (only when non-default;
    // placed LAST, matching the current_emit.rs / window-horizon table order).
    let window_body = window_days.to_le_bytes().to_vec();
    let window_len = window_body.len();

    // Lay out page-aligned regions; the `0x15`/`0x16` bodies follow Trips.
    let mut cursor = HEADER;
    let place = |len: usize, cursor: &mut usize| -> (usize, usize) {
        let off = *cursor;
        *cursor = align(*cursor + len, PAGE);
        (off, len)
    };
    let (stops_soa_off, _) = place(stops_soa_len, &mut cursor);
    let (routes_soa_off, _) = place(routes_soa_len, &mut cursor);
    let (stop_index_off, _) = place(stop_index.len(), &mut cursor);
    let (trips_off, _) = place(trips_len, &mut cursor);
    let (bitfield_pool_off, _) = place(bitfield_pool_body.len(), &mut cursor);
    // 4-aligned (M7): page-aligned via `place` ⇒ trivially 4-aligned.
    let (svc_to_bitfield_off, _) = place(svc_to_bitfield_body.len(), &mut cursor);
    let (st_off, _) = place(st_len, &mut cursor);
    let (ts_off, _) = place(ts_len, &mut cursor);
    let (csr_off, _) = place(csr_len, &mut cursor);
    let (pool_off, _) = place(pool_len, &mut cursor);
    let (transfers_off, _) = place(transfers_len, &mut cursor);
    // The WindowMeta region is placed only when emitted; at the default window it
    // is not laid out at all (the bundle stays byte-identical to a no-0x01 build).
    let window_off = if emit_window_meta {
        place(window_len, &mut cursor).0
    } else {
        0
    };
    let total = align(cursor, PAGE);

    let mut buf = vec![0u8; total];

    // Current PTB v1 header prefix.
    buf[0..4].copy_from_slice(&[0x50, 0x54, 0x42, 0x00]); // PTB\0
    buf[4..6].copy_from_slice(&pt_core::PTB_VERSION_V1.to_le_bytes());
    buf[6..8].copy_from_slice(&0u16.to_le_bytes()); // featureFlags
    buf[8..12].copy_from_slice(&(n as u32).to_le_bytes());
    buf[12..16].copy_from_slice(&(m as u32).to_le_bytes());
    buf[16..20].copy_from_slice(&(num_trips as u32).to_le_bytes());
    buf[20..24].copy_from_slice(&20260601u32.to_le_bytes()); // feedStartDate (Monday)
    buf[24..28].copy_from_slice(&num_services.to_le_bytes()); // num_services
    buf[28..32].copy_from_slice(&0i32.to_le_bytes()); // city_tz_offset_seconds (UTC)

    // Tagged region table: the SoA regions + carries, with the `0x15`/`0x16`
    // pool pair after Trips. A
    // trailing `0x01 WindowMeta` entry is appended ONLY for a non-default window
    // (the M3 large-S fixture) — matching the current_emit.rs / window-horizon order.
    let mut entries: Vec<(u16, usize, usize)> = vec![
        (STOPS_SOA, stops_soa_off, stops_soa_len),
        (ROUTES_SOA, routes_soa_off, routes_soa_len),
        (
            pt_core::stop_index::REGION_ID,
            stop_index_off,
            stop_index.len(),
        ),
        (carry_id(Region::TripsIntern), trips_off, trips_len),
        (
            SERVICE_BITFIELD_POOL,
            bitfield_pool_off,
            bitfield_pool_body.len(),
        ),
        (
            SERVICE_TO_BITFIELD,
            svc_to_bitfield_off,
            svc_to_bitfield_body.len(),
        ),
        (carry_id(Region::StopTimes), st_off, st_len),
        (carry_id(Region::TripStarts), ts_off, ts_len),
        (carry_id(Region::Csr), csr_off, csr_len),
        (carry_id(Region::StringPool), pool_off, pool_len),
        (carry_id(Region::Transfers), transfers_off, transfers_len),
    ];
    if emit_window_meta {
        entries.push((WINDOW_META, window_off, window_len));
    }
    write_region_table(&mut buf, &entries);

    // Region bodies.
    buf[stops_soa_off..stops_soa_off + stops_soa_len].copy_from_slice(&stops_soa);
    buf[routes_soa_off..routes_soa_off + routes_soa_len].copy_from_slice(&routes_soa);
    buf[stop_index_off..stop_index_off + stop_index.len()].copy_from_slice(&stop_index);
    buf[trips_off..trips_off + trips_len].copy_from_slice(&trips_body);
    buf[bitfield_pool_off..bitfield_pool_off + bitfield_pool_body.len()]
        .copy_from_slice(&bitfield_pool_body);
    buf[svc_to_bitfield_off..svc_to_bitfield_off + svc_to_bitfield_body.len()]
        .copy_from_slice(&svc_to_bitfield_body);
    buf[st_off..st_off + st_len].copy_from_slice(&st_body);
    buf[ts_off..ts_off + ts_len].copy_from_slice(&ts_body);
    buf[csr_off..csr_off + csr_len].copy_from_slice(&csr_body);
    buf[pool_off..pool_off + pool_len].copy_from_slice(&pool_body);
    buf[transfers_off..transfers_off + transfers_len].copy_from_slice(&transfers_body);
    if emit_window_meta {
        buf[window_off..window_off + window_len].copy_from_slice(&window_body);
    }

    Ok(buf)
}

/// Emit the committed current PTB v1 cross-parity fixture `tiny-service-pool.ptb`: a
/// SoA bundle whose `0x15 ServiceBitfieldPool` + `0x16 ServiceToBitfield` pool
/// genuinely folds services onto shared bitfields. Build deterministic bytes, read them back through
/// `pt_core::Reader` as a structural self-check, write them out. A CI regen guard
/// (`git diff --exit-code`) pins the bytes; the matching `tiny-service-pool.projection.json`
/// golden is emitted by `pt-core`'s `emit_projection` example (the SAME Rust↔TS
/// anchor `assert-ptb-cross-parity.ts` compares against).
///
/// Feed shape — picked so the pool GENUINELY folds (`count < num_services`), so a
/// reader that ignored the `0x16` index and read a flat slot would diverge:
///   - 3 stops (Alpha/Bravo/Charlie, real coords), 1 route (R0 BUS), 2 trips.
///   - 3 services; `service_to_bitfield = [0, 1, 0]` → services 0 and 2 SHARE
///     pool[0]; service 1 maps to pool[1]. `count = 2 < num_services = 3`.
///   - pool[0] = all-active across the default 90-day window (the trips ride
///     service 0, so they route on every query day).
///   - pool[1] = all-active EXCEPT day 49 cleared — DISTINCT from pool[0], and the
///     divergence lands on day 49 = 20260720 (one of the cross-parity PINNED_DATES
///     relative to feed_start_date 20260601), so the projection's `serviceActive`
///     VISIBLY differs there: services 0/2 active, service 1 inactive.
pub fn emit_tiny_service_pool(out_path: &str) -> Result<String, String> {
    use pt_core::Reader;
    let bytes = build_tiny_service_pool()?;

    // Self-check: the emitted current bundle resolves service masks through the
    // pool pair, the same `0x15`/`0x16` seam the engine-regression gate walks.
    let r = Reader::from_bytes(bytes.clone())
        .map_err(|e| format!("emit-tiny-service-pool: emitted bundle decode: {e:?}"))?;
    if r.header().version != pt_core::PTB_VERSION_V1 {
        return Err(format!(
            "emit-tiny-service-pool: emitted bundle is v{}, expected v{}",
            r.header().version,
            pt_core::PTB_VERSION_V1
        ));
    }
    if r.num_services() != 3 {
        return Err(format!(
            "emit-tiny-service-pool: num_services = {}, expected 3",
            r.num_services()
        ));
    }
    if r.service_bitfield_pool_count() != 2 {
        return Err(format!(
            "emit-tiny-service-pool: pool count = {}, expected 2 (genuine fold, count < num_services)",
            r.service_bitfield_pool_count()
        ));
    }
    // Services 0 and 2 SHARE pool[0]; service 1 is the distinct pool[1].
    if r.service_bitmask(0) != r.service_bitmask(2) {
        return Err("emit-tiny-service-pool: services 0 and 2 must share pool[0]".into());
    }
    if r.service_bitmask(0) == r.service_bitmask(1) {
        return Err("emit-tiny-service-pool: service 1 must map to a DISTINCT pool[1]".into());
    }

    std::fs::write(out_path, &bytes)
        .map_err(|e| format!("emit-tiny-service-pool: write {out_path}: {e}"))?;
    Ok(format!(
        "emit-tiny-service-pool: wrote {out_path} ({} bytes, PTB v{} ServiceBitfieldPool: 3 stops, 1 route, 3 services, pool count 2)",
        bytes.len(),
        pt_core::PTB_VERSION_V1,
    ))
}

/// Assemble the genuine-fold current PTB v1 `tiny-service-pool.ptb` bytes.
/// Split out from [`emit_tiny_service_pool`] so the in-crate test can assert the bytes
/// without touching the filesystem.
fn build_tiny_service_pool() -> Result<Vec<u8>, String> {
    let s = pt_core::bytes_per_service(pt_core::WINDOW_DEFAULT_DAYS); // 12
                                                                      // pool[0]: all-active across the window (services 0 and 2 ride this).
    let bf_all = vec![0xFFu8; s];
    // pool[1]: all-active EXCEPT day 49 cleared — DISTINCT from pool[0]. Day 49 is
    // 20260720 (feed_start_date 20260601 + 49d), a cross-parity PINNED_DATE, so the
    // projection's serviceActive visibly diverges there (s0/s2 active, s1 not).
    let bf_not_day49 = {
        let mut v = vec![0xFFu8; s];
        v[49 / 8] &= !(1u8 << (49 % 8)); // clear day 49
        v
    };
    let pool: [&[u8]; 2] = [bf_all.as_slice(), bf_not_day49.as_slice()];
    // s0 -> pool[0], s1 -> pool[1], s2 -> pool[0] (services 0 and 2 share a slot).
    let s2b: [u32; 3] = [0, 1, 0];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &s2b,
        window_days: pt_core::WINDOW_DEFAULT_DAYS, // 90 ⇒ no 0x01 WindowMeta
    };
    let stops = [
        SoaStop {
            id: "S0",
            name: "Alpha",
            lat: 54.69,
            lon: 25.28,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "S1",
            name: "Bravo",
            lat: 54.695,
            lon: 25.285,
            parent: None,
            wheelchair: 1,
        },
        SoaStop {
            id: "S2",
            name: "Charlie",
            lat: 54.70,
            lon: 25.29,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R0",
        agency: "AG",
        short: "0",
        long: "Route Zero",
        color: "FF0000",
        text_color: "FFFFFF",
        route_type: 3, // BUS
    }];
    // Two trips on route 0 riding service 0 (pool[0], all-active) so they route on
    // any query day: S0@25200→S1@25500→S2@25800 and S0@28800→S2@29400.
    build_service_pool_ptb(
        &stops,
        &routes,
        &[
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 2, 29400)],
        ],
        None,
        &spec,
    )
}

/// Emit the committed **current PTB v1** cross-parity fixture `tiny-v1.ptb`: a CARRY-LESS current
/// PTB v1 pattern-band bundle. `build_pattern_band_ptb` assembles a current SoA staging carry,
/// ADDITIVELY appends the `0x10`-`0x14`/`0x45`/`0x46` pattern band (derived via
/// `pt_core::pattern_emit::encode_pattern_band` over `Index::build(.., Unbounded)`), then STRIPS
/// the now-redundant flat carry (`0xF4`/`0xF5`/`0xF6`/`0xFA`) — so the band is the SOLE timetable
/// (B1.5 teardown). Mirrors `emit_tiny_service_pool`: deterministic bytes, a Phase-2 reader
/// read-back self-check (the carry-less band path re-materializes the flat timetable), then write
/// out. A CI regen guard (`git diff --exit-code`) pins the bytes; the matching
/// `tiny-v1.projection.json` golden is emitted by `pt-core`'s `emit_projection` example (the SAME
/// Rust↔TS anchor `assert-ptb-cross-parity.ts` compares against — over the carry-less,
/// band-materialized timetable).
///
/// Feed shape — a single regular BUS route so the band has no `0x12`
/// PatternSemantics (every pattern all-regular ⇒ omitted), exercising the common
/// carry-less path:
///   - 3 stops (S0/S1/S2, real coords), 1 route (R0 BUS), 2 trips on service 0.
///   - 1 all-active service ⇒ `0x15`/`0x16` pool count 1 (NO genuine fold here —
///     the fold case is `tiny-service-pool`; this fixture's job is the carry-less band).
///   - feedStartDate 20260601 (inherited from `build_service_pool_ptb`), so of
///     the PINNED_DATES [20260501, 20260514, 20260720] only 20260720 (day 49) is
///     in-window ⇒ the service is active there, inactive on the two pre-anchor
///     dates. Identical Rust/TS arithmetic, so the projection golden is stable.
pub fn emit_tiny_v1(out_path: &str) -> Result<String, String> {
    use pt_core::Reader;
    let bytes = build_tiny_v1()?;

    // Self-check: the emitted bundle decodes as a carry-less current PTB v1
    // band bundle whose flat timetable re-materializes from the band (the SAME
    // carry-less path the engine-regression gate + projection golden walk). A
    // `0xF4`/`0xF5` still present would mean the teardown strip never ran.
    let r = Reader::from_bytes(bytes.clone())
        .map_err(|e| format!("emit-tiny-v1: emitted bundle decode: {e:?}"))?;
    if r.header().version != 1 {
        return Err(format!(
            "emit-tiny-v1: emitted bundle is v{}, expected v1",
            r.header().version
        ));
    }
    // The flat carry was stripped: the band must be present (else the timetable is
    // gone). `has_boarding()` reads 0xFA — stripped ⇒ false. The band is the sole
    // source: `num_stop_times` re-materializes from it (5 rows over the 2 trips).
    if r.has_boarding() {
        return Err("emit-tiny-v1: 0xFA StopTimeBoarding must be stripped (carry-less)".into());
    }
    if r.num_stop_times() != 5 {
        return Err(format!(
            "emit-tiny-v1: num_stop_times = {}, expected 5 (band-materialized)",
            r.num_stop_times()
        ));
    }
    // Single regular route ⇒ no non-regular pattern ⇒ 0x12 PatternSemantics omitted.
    if r.has_pattern_semantics() {
        return Err(
            "emit-tiny-v1: single regular route must omit 0x12 PatternSemantics (all-regular)"
                .into(),
        );
    }

    std::fs::write(out_path, &bytes).map_err(|e| format!("emit-tiny-v1: write {out_path}: {e}"))?;
    Ok(format!(
        "emit-tiny-v1: wrote {out_path} ({} bytes, CARRY-LESS current PTB v1 pattern band: 3 stops, 1 route, 2 trips, flat carry 0xF4/0xF5/0xF6/0xFA stripped)",
        bytes.len(),
    ))
}

/// Assemble the `tiny-v1.ptb` bytes (the carry-less current PTB v1 cross-parity
/// fixture). Split out from [`emit_tiny_v1`] so the in-crate test can assert the
/// bytes without touching the filesystem. `build_pattern_band_ptb` does the
/// carry strip internally (B1.5-T4).
fn build_tiny_v1() -> Result<Vec<u8>, String> {
    let stops = [
        SoaStop {
            id: "S0",
            name: "Alpha",
            lat: 54.69,
            lon: 25.28,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "S1",
            name: "Bravo",
            lat: 54.695,
            lon: 25.285,
            parent: None,
            wheelchair: 1,
        },
        SoaStop {
            id: "S2",
            name: "Charlie",
            lat: 54.70,
            lon: 25.29,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R0",
        agency: "AG",
        short: "0",
        long: "Route Zero",
        color: "FF0000",
        text_color: "FFFFFF",
        route_type: 3, // BUS
    }];
    // Two trips on route 0 (single all-active service ⇒ pool count 1, no fold):
    // S0@25200→S1@25500→S2@25800 and S0@28800→S2@29400. No sentinel rows (no
    // express-skip holes) ⇒ a clean regular pattern, 0x12 PatternSemantics omitted.
    let buf = build_pattern_band_ptb(
        &stops,
        &routes,
        &[
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 2, 29400)],
        ],
        None,
        &[],
        &[],
    )?;
    Ok(buf)
}

// ── A1 GTFS pickup/drop_off boarding-predicate fixtures (current PTB v1) ──────
//
// Each fixture is a carry-less current-v1 pattern-band bundle. A temporary
// packed boarding column is present while the band is encoded, then only its
// `0x12 PatternSemantics` representation survives carry removal. Packed source
// byte: pickup_type==1 → 0x51, pickup_type==2 → 0x52,
// drop_off_type==1 → 0x54, default → 0x50.

fn current_boarding_fixture(
    num_stops: u32,
    route_id: &str,
    trips: &[&[(u16, u32, u32)]],
    boarding: &[u8],
    label: &str,
) -> Vec<u8> {
    let stops = band_cohort_stops(num_stops);
    let routes = [SoaRoute {
        id: route_id,
        agency: "A0",
        short: "1",
        long: "Boarding",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    let mut buf =
        build_pattern_band_ptb_with_boarding(&stops, &routes, trips, None, &[], boarding, &[])
            .unwrap_or_else(|e| panic!("{label}: {e}"));
    // Preserve the boarding corpus query dates while the general current-band
    // cohort remains anchored at 20260601.
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());
    buf
}

/// `board-forbid.ptb` — route `s0→s1→s2` (one trip, 3 rows); `s1` has
/// `pickup_type==1` (`0x51` at the s1 row). Query `s1→s2` ⇒ EMPTY (can't board
/// s1); query `s0→s2` ⇒ boards s0, alights s2 (the predicate forbids only the s1
/// board, not the whole trip).
fn board_forbid() -> Vec<u8> {
    current_boarding_fixture(
        3,
        "R",
        &[&[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)]],
        &[0x50, 0x51, 0x50],
        "build board-forbid",
    )
}

/// Identical stop sequences with different per-trip restrictions at s1:
/// T0 forbids pickup, T1 is regular, T2 forbids drop-off.
/// Mirrors testkit::build_mixed_boarding_pattern_ptb.
/// GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
fn mixed_boarding() -> Vec<u8> {
    current_boarding_fixture(
        3,
        "R",
        &[
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
            &[(1, 0, 32400), (2, 1, 32700), (3, 2, 33000)],
        ],
        &[0x50, 0x51, 0x50, 0x50, 0x50, 0x50, 0x50, 0x54, 0x50],
        "build mixed-boarding",
    )
}

/// `alight-forbid.ptb` — route `s0→s1→s2`; `s1` has `drop_off_type==1` (`0x54`).
/// Query `s0→s1` ⇒ EMPTY (can't alight s1); query `s0→s2` ⇒ ok.
fn alight_forbid() -> Vec<u8> {
    current_boarding_fixture(
        3,
        "R",
        &[&[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)]],
        &[0x50, 0x54, 0x50],
        "build alight-forbid",
    )
}

/// `pickup-two-three-ok.ptb` — route `s0→s1→s2`; `s1` has `pickup_type==2`
/// (`0x52`, phone-agency). Query `s1→s2` ⇒ NON-empty (only `==1` forbids; 2 and 3
/// stay boardable). Boards s1, alights s2.
fn pickup_two_three_ok() -> Vec<u8> {
    current_boarding_fixture(
        3,
        "R",
        &[&[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)]],
        &[0x50, 0x52, 0x50],
        "build pickup-two-three-ok",
    )
}

/// `covering-merge-boarding.ptb` — the `covering_merge()` topology with `pickup_type==1` on the
/// FOLD short trip T0's `s1` row (global row 0). Under `PatternMode::CoveringMerge` T0 `[s1,s2,s3]`
/// folds into the long T1 `[s0..s4]` at OFFSET 1, so T0's `s1` rides covering position 1 (offset>0)
/// — exercising the `offset+i` fold branch's byte threading. A query `s1→s3` would board the
/// earlier T0 @1000 absent the predicate; the forbidden T0 board forces the later T1 @2300 (the
/// engine and its wasm binding must agree). `s1` is on the long canonical [s0..s4], so OFF reaches
/// it too.
///
/// Trip storage order (route-major, single route R0) → global stop_time rows:
///   T0 [s1,s2,s3]            rows 0,1,2   — s1 @ row 0 (pickup_type==1)
///   T1 [s0,s1,s2,s3,s4]      rows 3..8
///   T2 [s4,s3,s2,s1,s0]      rows 8..13
///   T3 [s7,s8]               rows 13,14
///   T4 [s6,s7,s8]            rows 15,16,17
///   T5 [s5,s6,s7,s8,s9]      rows 18..23
fn covering_merge_boarding() -> Vec<u8> {
    let trips: &[&[(u16, u32, u32)]] = &[
        &[(1, 1, 1000), (2, 2, 1300), (3, 3, 1600)],
        &[
            (1, 0, 2000),
            (2, 1, 2300),
            (3, 2, 2600),
            (4, 3, 2900),
            (5, 4, 3200),
        ],
        &[
            (1, 4, 5000),
            (2, 3, 5300),
            (3, 2, 5600),
            (4, 1, 5900),
            (5, 0, 6200),
        ],
        &[(1, 7, 1000), (2, 8, 1300)],
        &[(1, 6, 1500), (2, 7, 1800), (3, 8, 2100)],
        &[
            (1, 5, 2500),
            (2, 6, 2800),
            (3, 7, 3100),
            (4, 8, 3400),
            (5, 9, 3700),
        ],
    ];
    // 23 stop_time rows total; only row 0 (T0's s1) is forbidden.
    let mut boarding = vec![0x50u8; 23];
    boarding[0] = 0x51;
    current_boarding_fixture(10, "R0", trips, &boarding, "build covering-merge-boarding")
}

/// `lasso-boarding.ptb` — the single-trip `lasso()` topology `[s0,s1,s2,s3,s4,s2,s1,s0]` (rows
/// 0..7) where `s1` appears TWICE: row 1 (outbound, dep 60) and row 6 (return, dep 360).
/// `pickup_type==1` at the OUTBOUND occurrence (row 1) only; the RETURN occurrence (row 6) stays
/// boardable — proving the predicate is per-stop_time, not per-stop. Query `s1→s4` (apex, pos 4 dep
/// 240) ⇒ EMPTY: the only boardable s1 is the return @360, which is AFTER the apex. Query `s1→s0`
/// (terminal, pos 7 dep 420) ⇒ boards the return s1 @360 (pos 6), alights the terminal s0 @420 (pos
/// 7).
fn lasso_boarding() -> Vec<u8> {
    // 8 rows; forbid only the outbound s1 occurrence (row 1).
    let boarding = [0x50u8, 0x51, 0x50, 0x50, 0x50, 0x50, 0x50, 0x50];
    current_boarding_fixture(
        5,
        "R",
        &[&[
            (1, 0, 0),
            (2, 1, 60),
            (3, 2, 120),
            (4, 3, 180),
            (5, 4, 240),
            (6, 2, 300),
            (7, 1, 360),
            (8, 0, 420),
        ]],
        &boarding,
        "build lasso-boarding",
    )
}

/// `service-pool.ptb` — current PTB v1 genuine-fold service-pool fixture.
/// A 2-stop / 1-route / 1-trip SoA bundle whose service-bitmask storage is the
/// `0x15 ServiceBitfieldPool` + `0x16 ServiceToBitfield` pair. The trip s0@25200 → s1@25500
/// rides service 0, so the paired tuple is routable on the query day.
///
/// Pool shape (the dedup must GENUINELY fold, so the engine and its wasm binding traverse `0x16 →
/// 0x15` rather than a degenerate `count == num_services`):
///   - pool[0] = all-active (12 × 0xFF) across the default 90-day window;
///   - pool[1] = day-1-only (a single bit), DISTINCT from pool[0];
///   - 3 services, `service_to_bitfield = [0, 1, 0]` → services 0 and 2 SHARE
///     pool[0]; service 1 maps to pool[1]. So `count = 2 < num_services = 3` — a
///     real fold (one bitfield shared by two services).
fn service_pool() -> Vec<u8> {
    let s = pt_core::bytes_per_service(pt_core::WINDOW_DEFAULT_DAYS); // 12
                                                                      // pool[0]: all-active across the window (the trip's service rides this).
    let bf_all = vec![0xFFu8; s];
    // pool[1]: a distinct, sparse bitfield (day 1 only) — proves dedup folds a
    // genuinely different day-vector, not a duplicate of pool[0].
    let bf_day1 = {
        let mut v = vec![0u8; s];
        v[0] = 0b0000_0010; // day 1 active
        v
    };
    let pool: [&[u8]; 2] = [bf_all.as_slice(), bf_day1.as_slice()];
    // s0 -> pool[0], s1 -> pool[1], s2 -> pool[0] (0 and 2 share a bitfield).
    let s2b: [u32; 3] = [0, 1, 0];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &s2b,
        window_days: pt_core::WINDOW_DEFAULT_DAYS, // 90 ⇒ no 0x01 WindowMeta
    };
    let stops = [
        SoaStop {
            id: "s0",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s1",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R0",
        agency: "",
        short: "",
        long: "",
        color: "",
        text_color: "",
        route_type: 3, // BUS
    }];
    build_service_pool_ptb(
        &stops,
        &routes,
        &[&[(1, 0, 25200), (2, 1, 25500)]],
        None,
        &spec,
    )
    .expect("service-pool build")
}

/// `service-pool-distinct.ptb` — current PTB v1 all-distinct identity fixture.
/// The dual of `service_pool`: 3 services whose bitfields are ALL
/// DISTINCT, so the dedup CANNOT fold and `count == num_services == 3`. This pins
/// the first-seen / off-by-one boundary this fixture isolates — a dedup that
/// emitted `count - 1` (or `count + 1`) pool slots, or wrote the pool in anything
/// other than input order, would diverge here while the genuine-fold fixture
/// (`service_pool`) might still pass. Both engines must traverse `0x16 → 0x15`
/// and recover EACH service's own slot.
///
/// Pool shape (default 90-day window, S = 12, NO `0x01 WindowMeta`):
///   - pool[0] = day-0-only; pool[1] = day-1-only; pool[2] = day-2-only — three
///     DISTINCT day-vectors;
///   - 3 services, `service_to_bitfield = [0, 1, 2]` (identity) → `count = 3 =
///     num_services`, pool == input-order concatenation of the three bitfields.
///
/// The trip rides service 0 (day-0-only). The paired tuple queries day 0
/// (20260601) so service 0 is active and the s0→s1 trip routes; the other two
/// services exist only to exercise the all-distinct pool layout.
fn service_pool_distinct() -> Vec<u8> {
    let s = pt_core::bytes_per_service(pt_core::WINDOW_DEFAULT_DAYS); // 12
    let one_day = |d: usize| {
        let mut v = vec![0u8; s];
        v[d / 8] |= 1 << (d % 8);
        v
    };
    let bf0 = one_day(0); // day 0 only
    let bf1 = one_day(1); // day 1 only
    let bf2 = one_day(2); // day 2 only
    let pool: [&[u8]; 3] = [bf0.as_slice(), bf1.as_slice(), bf2.as_slice()];
    // Identity index ⇒ count == num_services == 3 (no fold).
    let s2b: [u32; 3] = [0, 1, 2];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &s2b,
        window_days: pt_core::WINDOW_DEFAULT_DAYS,
    };
    let stops = [
        SoaStop {
            id: "s0",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s1",
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R0",
        agency: "",
        short: "",
        long: "",
        color: "",
        text_color: "",
        route_type: 3, // BUS
    }];
    build_service_pool_ptb(
        &stops,
        &routes,
        &[&[(1, 0, 25200), (2, 1, 25500)]],
        None,
        &spec,
    )
    .expect("service-pool-distinct build")
}

/// `service-pool-wide.ptb` — current PTB v1 large-stride fixture with a WIDE
/// runtime window (`windowDays =
/// WINDOW_HARD_CEILING = 400` ⇒ `S = bytes_per_service(400) = 50 ≥ 2`, a trailing
/// `0x01 WindowMeta` entry) whose service is active on a HIGH-BYTE day — day 399,
/// the LAST in-window day, which lands in pool byte 49 (`399 / 8 = 49`), bit 7.
/// A byte-vs-element `pool_idx * S` confusion (multiplying by the element count
/// instead of the byte stride, or vice-versa) is INVISIBLE at the default 12-byte
/// stride but mislocates a 50-byte high-byte slot, so this is the fixture that
/// catches it in the engine and its wasm binding.
///
/// Pool shape: a single distinct bitfield active ONLY on day 399 (50 bytes, all
/// zero except `byte[49] = 0b1000_0000`); 1 service, `service_to_bitfield = [0]`
/// (`count = 1`). feedStartDate anchor 20260601 (a Monday). Day 399 is non-weekly
/// (a lone day), so the TS wire's weekly `deriveDays` base is all-off and the day
/// is recovered via a single computed `exceptions["20270705"]=1` — the
/// whole-window (a') precondition still holds across all 400 days.
///
/// The paired tuple queries 20270705 (day-offset 399): under the correct 50-byte
/// stride the engine and its wasm binding find the service active and route the s0→s1 trip; under a
/// buggy stride the high-byte bit is mislocated → divergence (empty vs routed).
fn service_pool_wide() -> Vec<u8> {
    let s = pt_core::bytes_per_service(WINDOW_HORIZON_WINDOW_DAYS); // 50
    let mut bf_day399 = vec![0u8; s];
    bf_day399[399 / 8] |= 1 << (399 % 8); // day 399 → byte 49, bit 7
    let pool: [&[u8]; 1] = [bf_day399.as_slice()];
    let s2b: [u32; 1] = [0];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &s2b,
        window_days: WINDOW_HORIZON_WINDOW_DAYS, // 400 ⇒ 0x01 WindowMeta, S = 50
    };
    let stops = [
        SoaStop {
            id: "s0",
            name: "Origin",
            lat: 54.6872,
            lon: 25.2797,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s1",
            name: "Dest",
            lat: 54.6892,
            lon: 25.2810,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R0",
        agency: "A0",
        short: "0",
        long: "Wide Pool",
        color: "",
        text_color: "",
        route_type: 3, // BUS
    }];
    build_service_pool_ptb(
        &stops,
        &routes,
        &[&[(1, 0, 25200), (2, 1, 25500)]],
        None,
        &spec,
    )
    .expect("service-pool-wide build")
}

/// `pattern-band-tiny.ptb` — the first committed v1/current-layout fixture
/// (B1.1 Task B). A single-route, five-trip feed that exercises every
/// pattern-band trap the cursor-parity cross-check must reproduce:
///   - trip 0 LOCAL:        `s0→s1→s2→s4`  sig [0,1,2,4]  — pattern A
///   - trip 1 BRANCH:       `s0→s1→s3→s4`  sig [0,1,3,4]  — pattern B (2-pattern branch)
///   - trip 2 LASSO:        `s0→s1→s2→s1→s4` sig [0,1,2,1,4] — pattern C (repeated s1)
///   - trip 3 EXPRESS-SKIP: `s0→s1→s2→s4`  sig [0,1,2,4]  — joins pattern A, but its
///     s2 row (global row 15) is dep-sentinel-poked ⇒ the cursor leaves
///     canonical position 2 == -1 (a `0x13` served-bits 0-bit / decode hole).
///   - trip 4 SKIP-POS-0:   `s0→s1→s2→s4`  sig [0,1,2,4]  — joins pattern A, but its
///     s0 row (global row 17) is dep-sentinel-poked ⇒ the cursor leaves canonical
///     position 0 == -1. It boards at s1, so `trip_first_dep` bases on the s1 dep
///     (first SERVED position), and Pin-4's "-1 sorts first" keys it before the
///     pos-0-serving trips 0/3 in pattern A's trip order.
///
/// The pattern band (`0x10`-`0x14`/`0x45`/`0x46`) is the sole timetable for
/// this v1 bundle: the flat `0xF4/0xF5/0xF6/0xFA` carry is stripped, so
/// `Index::build` reads from the band. NOT added to the engine corpus tuples
/// (B1.4) — only the isolated cursor-parity cross-check decodes its band.
///
/// Stop-time row layout (trip-storage order; the sentinel row indices are derived
/// from it): trip 0 rows 0..4, trip 1 rows 4..8, trip 2 rows 8..13, trip 3 rows
/// 13..17, trip 4 rows 17..21. Trip 3's MIDDLE position (s2) is the 3rd of its 4
/// rows ⇒ global row 13 + 2 = 15. Trip 4's FIRST position (s0) is its 1st row ⇒
/// global row 17. The two constants below are the authority.
fn pattern_band_tiny() -> Vec<u8> {
    let stops = [
        SoaStop {
            id: "s0",
            name: "Origin",
            lat: 54.6800,
            lon: 25.2700,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s1",
            name: "Stem",
            lat: 54.6810,
            lon: 25.2710,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s2",
            name: "Apex A",
            lat: 54.6820,
            lon: 25.2720,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s3",
            name: "Branch",
            lat: 54.6830,
            lon: 25.2730,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "s4",
            name: "Exit",
            lat: 54.6840,
            lon: 25.2740,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R0",
        agency: "A0",
        short: "1",
        long: "Pattern Band",
        color: "",
        text_color: "",
        route_type: 3, // BUS
    }];
    // (stop_seq, stop_idx, dep_secs) per trip, in storage order.
    let trips: &[&[(u16, u32, u32)]] = &[
        // trip 0 LOCAL: s0→s1→s2→s4
        &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
        // trip 1 BRANCH: s0→s1→s3→s4 (different middle ⇒ distinct pattern)
        &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
        // trip 2 LASSO: s0→s1→s2→s1→s4 (s1 repeats — repeated-stop pattern)
        &[
            (1, 0, 32400),
            (2, 1, 32700),
            (3, 2, 33000),
            (4, 1, 33300),
            (5, 4, 33600),
        ],
        // trip 3 EXPRESS-SKIP: same sig as trip 0; its s2 row (global row 15) is
        // sentinel-poked below ⇒ canonical position 2 stays -1 (the hole).
        &[(1, 0, 36000), (2, 1, 36300), (3, 2, 36600), (4, 4, 36900)],
        // trip 4 SKIP-POS-0: same sig as trip 0; its s0 row (global row 17) is
        // sentinel-poked below ⇒ canonical position 0 stays -1 (it boards at s1,
        // so trip_first_dep bases on the s1 dep and Pin-4 keys it -1 → sorts first).
        &[(1, 0, 39600), (2, 1, 39900), (3, 2, 40200), (4, 4, 40500)],
    ];
    // Global stop-time rows of the two poked positions. Trip 3's s2 (position 2):
    // trip 0 (4) + trip 1 (4) + trip 2 (5) = 13 rows precede trip 3; trip 3's s2
    // is its 3rd row ⇒ index 15. Trip 4 starts at row 13 + 4 = 17; its s0 is its
    // FIRST row ⇒ index 17.
    const EXPRESS_SKIP_S2_ROW: usize = 15;
    const SKIP_POS0_S0_ROW: usize = 17;
    build_pattern_band_ptb(
        &stops,
        &routes,
        trips,
        None,
        &[EXPRESS_SKIP_S2_ROW, SKIP_POS0_S0_ROW],
        &[],
    )
    .expect("pattern-band-tiny build")
}

// ── Current PTB v1 band helpers ─────────────────────────────────────────────
//
// Shared stop and route helpers for the current-v1 fixtures. The
// `0x10`-`0x14`/`0x45`/`0x46` band is emitted through `build_pattern_band_ptb`:
// `pt_core::pattern_emit::encode_pattern_band` over `Index::build(.., Unbounded)`.
// The builder's window starts on 20260601; fixtures queried on the older
// 20260505 corpus date re-stamp the feed start to 20260501.

/// `s0..s{n-1}` SoaStops for the current band-cohort builders.
/// Only the stop ORDINALS matter to the index; coords are cosmetic.
fn band_cohort_stops(n: u32) -> Vec<SoaStop<'static>> {
    const IDS: [&str; 10] = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
    (0..n as usize)
        .map(|i| SoaStop {
            id: IDS[i],
            name: IDS[i],
            lat: 54.68 + i as f64 * 0.001,
            lon: 25.27 + i as f64 * 0.001,
            parent: None,
            wheelchair: 0,
        })
        .collect()
}

/// One BUS route `R{idx}` for the current band cohort.
fn band_cohort_route(idx: u32) -> SoaRoute<'static> {
    const IDS: [&str; 3] = ["R0", "R1", "R2"];
    SoaRoute {
        id: IDS[idx as usize],
        agency: "A0",
        short: "1",
        long: "Cohort",
        color: "",
        text_color: "",
        route_type: 3, // BUS
    }
}

/// `overnight-i32.ptb` — the current PTB v1 carry-less fixture that forces the
/// REGION-LEVEL `i32`-delta `0x13 TripTimes` variant (entryFlags bit1,
/// `TRIP_TIMES_FLAG_I32_DELTAS`). ONE route R0, one trip whose span exceeds the
/// `i16` ±32767 s (~9.1h) cap: first served dep 36000s (10:00), then 64800s
/// (18:00), then 91800s (25:30, a >24h overnight time) ⇒ dep_delta 55800 >
/// i16::MAX. The whole region therefore emits 4-byte i32 deltas. Like the rest of
/// the current-v1 cohort it is carry-less (the flat 0xF4/0xF5/0xF6/0xFA are stripped after
/// the band is derived). This task only COMMITS the fixture (the band's wide-delta
/// slab + the bit1 entryFlags); it is NOT added to any engine corpus tuple list
/// (a later task wires the tuple).
///
/// NONZERO dwell (`arr_diff`) on pos 1 (-180) and the >9.1h pos 2 (-300) so the
/// i32 DWELL sub-array carries non-zero wide-stride values — an i16 mis-stride of
/// the dwell column (reading at *2 while dep reads at *4) lands on different bytes
/// and mis-reads the arr second; the self-test pins the exact arr via
/// `band_arr_secs` (arr = dep + arr_diff). Without it the dwell sub-array is
/// all-zero and a dwell-stride bug stays uncaught.
///
/// GTFS overnight (>24h `stop_times` time) reference:
/// https://gtfs.org/documentation/schedule/reference/#stop_timestxt
fn overnight_i32() -> Vec<u8> {
    let stops = band_cohort_stops(3);
    let routes = [band_cohort_route(0)];
    let trips: &[&[(u16, u32, u32)]] = &[&[
        (1, 0, 36_000), // 10:00 — first served dep (the delta base); zero dwell
        (2, 1, 64_800), // 18:00 — delta 28800 (i16-OK alone); dwell -180 ⇒ arr 64620
        (3, 2, 91_800), // 25:30 overnight — delta 55800 > i16::MAX ⇒ region i32; dwell -300 ⇒ arr 91500
    ]];
    // Flat rows: 0=pos0, 1=pos1, 2=pos2. Dwell on the mid + the >9.1h long-span.
    build_pattern_band_ptb(&stops, &routes, trips, None, &[], &[(1, -180), (2, -300)])
        .expect("overnight-i32 build")
}

/// Write the committed fixtures into `out_dir`.
pub fn run(out_dir: &str) -> Result<String, String> {
    let dir = Path::new(out_dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("create_dir_all {out_dir}: {e}"))?;
    let fixtures: &[(&str, Vec<u8>)] = &[
        ("equal-alight-tie.ptb", equal_alight_tie()),
        ("express-skip.ptb", express_skip()),
        ("terminal-dwell.ptb", terminal_dwell()),
        ("footpath.ptb", footpath_ptb()),
        ("footpath-transfers.bin", footpath_transfers()),
        ("converging-routes.ptb", converging_routes()),
        ("overnight.ptb", overnight()),
        ("overnight-prev-day.ptb", overnight_prev_day()),
        ("express-skip-dwell.ptb", express_skip_dwell()),
        ("circular-loop.ptb", circular_loop()),
        ("lasso.ptb", lasso()),
        ("transfer-floor.ptb", transfer_floor()),
        ("transfer-floor-miss.ptb", transfer_floor_miss()),
        ("maxrounds.ptb", maxrounds()),
        ("three-leg.ptb", three_leg()),
        ("three-leg-transfers.bin", three_leg_transfers()),
        // GTFS transfers.txt, unscoped rules: type 3 (not possible) and type 2
        // (min_transfer_time) on same-stop re-boards.
        ("transfer-block.ptb", transfer_block()),
        ("transfer-mintime-feasible.ptb", transfer_mintime_feasible()),
        ("transfer-mintime-miss.ptb", transfer_mintime_miss()),
        (
            "transfer-mintime-below-floor.ptb",
            transfer_mintime_below_floor(),
        ),
        ("transfer-scoped-ignored.ptb", transfer_scoped_ignored()),
        // Type 2 without min_transfer_time, and the same rules applied to
        // footpath edges (type 3 skips the walk, type 2 sets its floor).
        ("transfer-type2-no-min.ptb", transfer_type2_no_min()),
        ("transfer-footpath-block.ptb", transfer_footpath_block()),
        ("transfer-footpath-mintime.ptb", transfer_footpath_mintime()),
        // Type 1 (timed transfer): per-pair floor 0 on a same-stop re-board and a
        // footpath edge, plus a route-scoped row that the unscoped index ignores.
        ("transfer-timed-board.ptb", transfer_timed_board()),
        ("transfer-timed-footpath.ptb", transfer_timed_footpath()),
        (
            "transfer-timed-scoped-ignored.ptb",
            transfer_timed_scoped_ignored(),
        ),
        // Trip-scoped rules and specificity: the arriving and departing trips
        // select the most specific matching row (both trip ids beat unscoped).
        ("transfer-scoped-block.ptb", transfer_scoped_block()),
        (
            "transfer-scoped-specificity.ptb",
            transfer_scoped_specificity(),
        ),
        // Linked trips: type 4 (stay onboard) reports 0 transfers; type 5 (must
        // alight and re-board) reports 1 on the same topology.
        ("transfer-inseat.ptb", transfer_inseat()),
        ("transfer-inseat-forbidden.ptb", transfer_inseat_forbidden()),
        // Type 4 at a lasso turnaround: outbound T0 [s0,s1,s2] and inbound T1
        // [s2,s3,s4] joined at s2. The 60 s layover is below the 120 s floor, so
        // only the in-seat rule makes the ride feasible, at 0 transfers.
        (
            "block-chained-lasso-inseat.ptb",
            block_chained_lasso_inseat(),
        ),
        // Route-scoped rules: a route→route type 1 applies, and a trip→trip
        // row outranks a route→route row on the same re-board.
        ("transfer-scoped-route.ptb", transfer_scoped_route()),
        (
            "transfer-scoped-trip-beats-route.ptb",
            transfer_scoped_trip_beats_route(),
        ),
        // Multi-pattern routes: each has a stop that only a non-canonical trip
        // serves, so it is unroutable under PatternMode::Off and routable under
        // Unbounded/CoveringMerge.
        ("branch-pattern.ptb", branch_pattern()),
        ("disjoint-dirs.ptb", disjoint_dirs()),
        ("converging-multipattern.ptb", converging_multipattern()),
        ("pickup-equivalence.ptb", pickup_equivalence()),
        ("lasso-multipattern.ptb", lasso_multipattern()),
        // CoveringMerge fold: contiguous-subsequence short trips fold into the
        // covering pattern with `-1` holes, transitive offsets compose, and the
        // reverse direction stays separate.
        ("covering-merge.ptb", covering_merge()),
        // TypeScript reader fixtures (not engine corpus tuples): a covering
        // fold over a repeated stop, a lasso with an unserved occurrence,
        // 50 routes of shared-prefix ids, and two trips on one pattern.
        ("covering-loop.ptb", covering_loop()),
        ("lasso-unserved-occurrence.ptb", lasso_unserved_occurrence()),
        ("shared-prefix-ids.ptb", shared_prefix_ids()),
        ("same-pattern-trips.ptb", same_pattern_trips()),
        // Bicycle mobility: bikes_allowed==2 trip-skip at BOTH scan sites. bikes-skip exercises the
        // BOARD loop (only O→D path forbids bikes → empty under Bicycle, routes under Default);
        // bikes-express-skip exercises the express-skip CANDIDATE loop (alt-trip forbidden → falls
        // through to a bike-allowed trip → non-empty but DIFFERENT result).
        ("bikes-skip.ptb", bikes_skip_fixture()),
        ("bikes-express-skip.ptb", bikes_express_skip_fixture()),
        // A5 route_type→mode: current-v1 extended-type FERRY-only path + the OTHER bucket (air 1100
        // + taxi 1500). The engine-regression gate asserts engine ≡ golden mode-exclusion behaviour
        // on them.
        ("mode-ferry-only.ptb", mode_ferry_only()),
        ("mode-other-bucket.ptb", mode_other_bucket()),
        // A1 GTFS pickup/drop_off boarding predicates in current-v1 carry-less
        // bands. The engine-regression gate feeds these same 0x12 semantics to
        // the native engine and its wasm binding.
        ("board-forbid.ptb", board_forbid()),
        ("mixed-boarding.ptb", mixed_boarding()),
        ("alight-forbid.ptb", alight_forbid()),
        ("pickup-two-three-ok.ptb", pickup_two_three_ok()),
        ("covering-merge-boarding.ptb", covering_merge_boarding()),
        ("lasso-boarding.ptb", lasso_boarding()),
        // Step A.9 (C3): the ONLY non-90 windowDays fixture. A current PTB v1
        // SoA bundle carrying a 0x01 WindowMeta region of 400 (50-byte stride); the paired
        // tuple queries on day-offset 100 (> 90), reachable only under the wide
        // window. Forces the engine and its wasm binding to exercise a non-90 stride identically.
        ("window-horizon.ptb", window_horizon()),
        // Step A.11 (per-day fidelity): a wide window whose per-day bitmask is
        // NON-weekly and diverges past day 90 (Mon–Fri for ~90 days then Mondays
        // only). The weekly deriveDays base CANNOT reproduce it — only the wire's
        // computed exceptions[] make the resolved active-set equal the bitmask.
        // The paired tuple queries offset 92 (a Tuesday > 90, bitmask-inactive but
        // weekly-base-active) — RED under the lossy wire, GREEN with exceptions.
        ("window-nonweekly-horizon.ptb", window_nonweekly_horizon()),
        // Current PTB v1 genuine-fold fixture. Its service-bitmask storage is the
        // de-duplicated `0x15 ServiceBitfieldPool` + `0x16 ServiceToBitfield` pair
        // count=2 distinct bitfields, 3 services, services 0
        // and 2 sharing pool[0] so the dedup GENUINELY folds. Both engines must
        // traverse `0x16 → 0x15` to resolve each service's mask.
        ("service-pool.ptb", service_pool()),
        // All-distinct identity micro-fixture — 3 services, 3
        // DISTINCT bitfields, identity index [0,1,2] ⇒ count == num_services == 3
        // (NO fold), pool == input-order concatenation. Pins the first-seen /
        // off-by-one dedup boundary the genuine-fold fixture can't isolate.
        ("service-pool-distinct.ptb", service_pool_distinct()),
        // Large-stride fixture — windowDays=400 (S = 50, trailing
        // 0x01 WindowMeta), service active ONLY on day 399 (high byte 49, bit 7).
        // Catches a byte-vs-element `pool_idx * S` stride confusion that the
        // default 12-byte stride masks; the paired tuple queries day 399.
        ("service-pool-wide.ptb", service_pool_wide()),
        // B1.1 Task B: the first committed v1/current-layout fixture. A
        // single-route, four-trip feed whose pattern band
        // (`0x10`-`0x14`/`0x45`/`0x46`) is the sole timetable (the flat
        // `0xF4/0xF5/0xF6` carry is stripped). It is NOT in the engine corpus
        // tuples; only the isolated
        // cursor-parity cross-check decodes its `0x13 TripTimes`. Covers a
        // 2-pattern branch, a repeated-stop lasso, and an express-skip -1 hole.
        ("pattern-band-tiny.ptb", pattern_band_tiny()),
        // Current PTB v1 carry-less band cohort. The engine regression runs the
        // same branch, lasso, converging, and covering-merge topologies through
        // Rust and wasm across every PatternMode.
        // Current PTB v1 i32-delta fixture: a single overnight trip whose span
        // exceeds the i16 ±32767 s cap forces the REGION-LEVEL 4-byte i32 deltas
        // (0x13 entryFlags bit1, TRIP_TIMES_FLAG_I32_DELTAS). Carry-less like the
        // rest of the cohort; routed by the engine corpus and projected by the
        // cross-language parity gate.
        ("overnight-i32.ptb", overnight_i32()),
        // current PTB v1 exact_times=0 frequency row keyed by
        // GLOBAL tripIdx=1 across two routes/trips, catching route-local
        // trip-index bugs.
        (
            "frequency-exact0.ptb",
            build_frequency_exact0_ptb().expect("build frequency-exact0 fixture"),
        ),
    ];
    let mut names = Vec::new();
    for (name, bytes) in fixtures {
        let path = dir.join(name);
        std::fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
        names.push((*name).to_string());
    }
    Ok(format!(
        "wrote {} fixtures to {out_dir}: {}",
        names.len(),
        names.join(", ")
    ))
}

// ── A5 Frequencies cross-language decoder fixture ───────────────────────────
//
// A dedicated fixture that carries a `0x17 Frequencies` region so that both the
// Rust reader and the TS loader can independently decode the SAME bytes and be
// asserted to agree. It is NOT wired into the routing-engine corpus fixtures (no
// routing behaviour change); it only covers the Rust/TypeScript wire-decoder seam.

/// Build the `frequencies-parity.ptb` cross-language decoder fixture for the
/// `0x17 Frequencies` region.
///
/// A current PTB v1 service-pool bundle — built via the shared current-layout
/// builder [`build_service_pool_ptb`] (the same pattern `window_horizon` uses)
/// with a `0x17 Frequencies` region appended — carrying 3 known rows over 2
/// trips. Both the Rust reader ([`pt_core::Reader::frequencies_for_trip`]) and
/// the TypeScript wire loader (`decodeFrequencies` in `loader.ts`) decode these
/// bytes; the cross-parity check asserts that the independent decoders agree.
///
/// Wire layout of the `0x17` region body (after the count prefix):
/// - `[0..4]   tripIdx u32 LE`
/// - `[4..8]   startSecs u32 LE`
/// - `[8..12]  endSecs u32 LE`
/// - `[12..14] headwaySecs u16 LE`
/// - `[14]     exactTimes u8`
/// - `[15]     reserved u8`
///
/// Known rows (sorted by tripIdx, then startSecs):
/// - #0: tripIdx=0, startSecs=21600, endSecs=86400,  headwaySecs=600,  exactTimes=0
/// - #1: tripIdx=0, startSecs=86400, endSecs=108000, headwaySecs=1800, exactTimes=1
/// - #2: tripIdx=1, startSecs=36000, endSecs=72000,  headwaySecs=900,  exactTimes=0
///
/// GTFS reference: <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>
fn build_frequencies_parity_ptb() -> Result<Vec<u8>, String> {
    use pt_core::region_ids::FREQUENCIES;

    // 2 stops, 1 route, 2 trips, 1 all-active service over the default 90-day
    // window: a one-entry ServicePoolSpec (pool[0] all-active,
    // service_to_bitfield = [0]) so the single service resolves through the
    // real 0x16 → 0x15 seam.
    let bitmask = vec![0xFFu8; pt_core::bytes_per_service(pt_core::WINDOW_DEFAULT_DAYS)];
    let pool: [&[u8]; 1] = [bitmask.as_slice()];
    let s2b: [u32; 1] = [0];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &s2b,
        window_days: pt_core::WINDOW_DEFAULT_DAYS,
    };
    let stops = [
        SoaStop {
            id: "S0",
            name: "Stop 0",
            lat: 54.6,
            lon: 25.1,
            parent: None,
            wheelchair: 0,
        },
        SoaStop {
            id: "S1",
            name: "Stop 1",
            lat: 54.7,
            lon: 25.2,
            parent: None,
            wheelchair: 0,
        },
    ];
    let routes = [SoaRoute {
        id: "R0",
        agency: "A",
        short: "1",
        long: "Route 1",
        color: "",
        text_color: "",
        route_type: 3,
    }];
    // Trip 0: S0@25200 → S1@25500; Trip 1: S0@28800 → S1@29100.
    let trip0: &[(u16, u32, u32)] = &[(0, 0, 25200), (1, 1, 25500)];
    let trip1: &[(u16, u32, u32)] = &[(0, 0, 28800), (1, 1, 29100)];
    let trips: &[&[(u16, u32, u32)]] = &[trip0, trip1];

    let buf = build_service_pool_ptb(&stops, &routes, trips, None, &spec)?;

    // `0x17 Frequencies` region body: count u32 LE prefix + 3 rows × 16 B each.
    // Rows sorted by tripIdx, then startSecs (GTFS-required ordering invariant).
    const FREQ_ROWS: u32 = 3;
    let freq_len = 4 + FREQ_ROWS as usize * 16;
    let mut freq_body = vec![0u8; freq_len];
    freq_body[0..4].copy_from_slice(&FREQ_ROWS.to_le_bytes());
    // Row 0: tripIdx=0, startSecs=21600, endSecs=86400, headwaySecs=600, exactTimes=0
    let o = 4;
    freq_body[o..o + 4].copy_from_slice(&0u32.to_le_bytes());
    freq_body[o + 4..o + 8].copy_from_slice(&21600u32.to_le_bytes());
    freq_body[o + 8..o + 12].copy_from_slice(&86400u32.to_le_bytes());
    freq_body[o + 12..o + 14].copy_from_slice(&600u16.to_le_bytes());
    freq_body[o + 14] = 0;
    // Row 1: tripIdx=0, startSecs=86400, endSecs=108000, headwaySecs=1800, exactTimes=1
    let o = 4 + 16;
    freq_body[o..o + 4].copy_from_slice(&0u32.to_le_bytes());
    freq_body[o + 4..o + 8].copy_from_slice(&86400u32.to_le_bytes());
    freq_body[o + 8..o + 12].copy_from_slice(&108000u32.to_le_bytes());
    freq_body[o + 12..o + 14].copy_from_slice(&1800u16.to_le_bytes());
    freq_body[o + 14] = 1;
    // Row 2: tripIdx=1, startSecs=36000, endSecs=72000, headwaySecs=900, exactTimes=0
    let o = 4 + 32;
    freq_body[o..o + 4].copy_from_slice(&1u32.to_le_bytes());
    freq_body[o + 4..o + 8].copy_from_slice(&36000u32.to_le_bytes());
    freq_body[o + 8..o + 12].copy_from_slice(&72000u32.to_le_bytes());
    freq_body[o + 12..o + 14].copy_from_slice(&900u16.to_le_bytes());
    freq_body[o + 14] = 0;

    Ok(append_tagged_region(buf, FREQUENCIES, &freq_body))
}

/// Emit the committed `frequencies-parity.ptb` cross-parity fixture.
///
/// Builds the bundle via [`build_frequencies_parity_ptb`], self-checks by
/// decoding through the Rust reader ([`pt_core::Reader::frequencies_for_trip`]),
/// and writes the bytes to `out_path`. The complementary TS assertion lives in
/// `assert-ptb-cross-parity.ts::assertFrequenciesParity`.
pub fn emit_frequencies_parity(out_path: &str) -> Result<String, String> {
    use pt_core::Reader;
    let bytes = build_frequencies_parity_ptb()?;

    let r = Reader::from_bytes(bytes.clone())
        .map_err(|e| format!("emit-frequencies-parity: decode: {e:?}"))?;
    if r.header().version != pt_core::PTB_VERSION_V1 {
        return Err(format!(
            "emit-frequencies-parity: emitted bundle is v{}, expected v{} (current layout)",
            r.header().version,
            pt_core::PTB_VERSION_V1
        ));
    }
    if !r.has_frequencies() {
        return Err("emit-frequencies-parity: has_frequencies() = false, expected true".into());
    }
    let rows0: Vec<_> = r.frequencies_for_trip(0).collect();
    if rows0.len() != 2 {
        return Err(format!(
            "emit-frequencies-parity: trip 0 has {} rows, expected 2",
            rows0.len()
        ));
    }
    let rows1: Vec<_> = r.frequencies_for_trip(1).collect();
    if rows1.len() != 1 {
        return Err(format!(
            "emit-frequencies-parity: trip 1 has {} rows, expected 1",
            rows1.len()
        ));
    }

    std::fs::write(out_path, &bytes)
        .map_err(|e| format!("emit-frequencies-parity: write {out_path}: {e}"))?;
    Ok(format!(
        "emit-frequencies-parity: wrote {out_path} ({} bytes, 3 frequency rows: 2 for trip 0 + 1 for trip 1)",
        bytes.len()
    ))
}

fn append_tagged_region(mut buf: Vec<u8>, region_id: u16, body: &[u8]) -> Vec<u8> {
    const PAGE: usize = 4096;

    let off = align(buf.len(), PAGE);
    let total = align(off + body.len(), PAGE);
    buf.resize(total, 0);
    buf[off..off + body.len()].copy_from_slice(body);

    let mut e = 32;
    loop {
        let id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
        if id == 0 {
            buf[e..e + 2].copy_from_slice(&region_id.to_le_bytes());
            buf[e + 8..e + 16].copy_from_slice(&(off as u64).to_le_bytes());
            buf[e + 16..e + 24].copy_from_slice(&(body.len() as u64).to_le_bytes());
            return buf;
        }
        e += 24;
    }
}

/// Build the `frequency-exact0.ptb` routing fixture, stamped current PTB v1. It
/// carries two routes/trips (R0/R1, T0/T1); the frequency row belongs to GLOBAL
/// tripIdx=1 so route-local trip-index bugs attach it to trip 0 and produce the
/// wrong route/timing. The bundle keeps the flat timetable carry (no pattern
/// band) and anchors `feedStartDate` at 20260501.
/// GTFS reference: <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>
fn build_frequency_exact0_ptb() -> Result<Vec<u8>, String> {
    use pt_core::region_ids::FREQUENCIES;

    let bitmask = vec![0xFFu8; pt_core::bytes_per_service(pt_core::WINDOW_DEFAULT_DAYS)];
    let pool: [&[u8]; 1] = [bitmask.as_slice()];
    let s2b: [u32; 1] = [0];
    let spec = ServicePoolSpec {
        pool: &pool,
        service_to_bitfield: &s2b,
        window_days: pt_core::WINDOW_DEFAULT_DAYS,
    };
    let stop = |id| SoaStop {
        id,
        name: "",
        lat: 0.0,
        lon: 0.0,
        parent: None,
        wheelchair: 0,
    };
    let route = |id| SoaRoute {
        id,
        agency: "",
        short: "",
        long: "",
        color: "",
        text_color: "",
        route_type: 3,
    };
    let stops = [stop("s0"), stop("s1")];
    let routes = [route("R0"), route("R1")];
    let trip0: &[(u16, u32, u32)] = &[(0, 0, 25200), (1, 1, 26000)];
    let trip1: &[(u16, u32, u32)] = &[(0, 0, 28800), (1, 1, 29100)];
    let trip_ids = ["T0".to_string(), "T1".to_string()];
    let mut buf = build_service_pool_ptb_with_trip_ids(
        &stops,
        &routes,
        &[trip0, trip1],
        Some(&[0, 1]),
        Some(&trip_ids),
        &spec,
    )?;
    buf[20..24].copy_from_slice(&20260501u32.to_le_bytes());

    let mut freq_body = vec![0u8; 4 + 16];
    freq_body[0..4].copy_from_slice(&1u32.to_le_bytes());
    let o = 4;
    freq_body[o..o + 4].copy_from_slice(&1u32.to_le_bytes());
    freq_body[o + 4..o + 8].copy_from_slice(&28800u32.to_le_bytes());
    freq_body[o + 8..o + 12].copy_from_slice(&30600u32.to_le_bytes());
    freq_body[o + 12..o + 14].copy_from_slice(&600u16.to_le_bytes());
    freq_body[o + 14] = 0;

    Ok(append_tagged_region(buf, FREQUENCIES, &freq_body))
}

// ── Self-tests (vacuous-pass guard) ──────────────────────────────────────────
//
// If a builder emits structurally-wrong bytes, the engine and its wasm binding could agree on the
// wrong interpretation and the engine-regression gate would pass vacuously. These
// round-trip every builder's output through the SAME `pt_core::Reader` (and
// `pt_core::Transfers` for the PTFT) the engine-regression harness's Rust side uses,
// and assert the counts + key fields the fixture's trap relies on. A drift in
// the hand-assembled byte layout fails HERE, loudly, before the gate can be
// fooled.
#[cfg(test)]
mod tests {
    use super::*;
    use pt_core::{Reader, Transfers};

    /// Read one trip's (dep_secs, arr_diff) for the StopTimes row at global
    /// `row`, via the reader. The builders concatenate rows in trip order, so
    /// row indices are stable per fixture.
    fn st(reader: &Reader<Vec<u8>>, row: usize) -> (u32, i16) {
        let s = reader.stop_time(row).unwrap();
        (s.dep_secs, s.arr_diff)
    }

    #[test]
    fn equal_alight_tie_roundtrips() {
        let r = Reader::from_bytes(equal_alight_tie()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 2, 2));
        assert_eq!(r.stop_id(0).unwrap(), "s0");
        assert_eq!(r.route_id(0).unwrap(), "R0");
        assert_eq!(r.route_id(1).unwrap(), "R1");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        // route 0 row 1 (s1) and route 1 row 3 (s2) both alight @600.
        assert_eq!(st(&r, 1), (600, 0));
        assert_eq!(st(&r, 3), (600, 0));
        // Both patterns serve s0 (the shared entry) in route order [0,1].
        assert_eq!(r.patterns_at_stop(0).unwrap(), &[0u32, 1]);
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(r.pattern_stops(1).unwrap(), &[0u32, 2]);
    }

    #[test]
    fn express_skip_roundtrips() {
        let r = Reader::from_bytes(express_skip()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 1, 2));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        let local = r.trip_pattern_idx(0).unwrap() as usize;
        let express = r.trip_pattern_idx(1).unwrap() as usize;
        assert_ne!(local, express);
        assert_eq!(r.pattern_stops(local).unwrap(), &[0u32, 1, 2]);
        assert_eq!(r.pattern_stops(express).unwrap(), &[0u32, 2]);
        assert_eq!(r.pattern_trips(local).unwrap(), &[0u32]);
        assert_eq!(r.pattern_trips(express).unwrap(), &[1u32]);
        assert_eq!(st(&r, 1), (25500, 0));
    }

    #[test]
    fn bikes_skip_roundtrips() {
        let r = Reader::from_bytes(bikes_skip_fixture()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(r.pattern_trips(0).unwrap(), &[0u32]);
        assert_eq!(st(&r, 1), (25500, 0)); // s1 reached @25500 (the only O→D path)
        assert_eq!(r.trip_bikes_allowed(0).unwrap(), 2);
        assert_eq!(r.trip_meta_raw().unwrap()[22], 2);
    }

    #[test]
    fn bikes_express_skip_roundtrips() {
        let r = Reader::from_bytes(bikes_express_skip_fixture()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 1, 3));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        assert_eq!(r.trip(2).unwrap().trip_id, "T2");
        let express = r.trip_pattern_idx(0).unwrap() as usize;
        let local = r.trip_pattern_idx(1).unwrap() as usize;
        assert_ne!(express, local);
        assert_eq!(r.trip_pattern_idx(2).unwrap() as usize, local);
        assert_eq!(r.pattern_stops(express).unwrap(), &[0u32, 2]);
        assert_eq!(r.pattern_stops(local).unwrap(), &[0u32, 1, 2]);
        assert_eq!(r.pattern_trips(express).unwrap(), &[0u32]);
        assert_eq!(r.pattern_trips(local).unwrap(), &[1u32, 2]);
        // Only T1 (LOCAL_NOBIKE) forbids bikes; EXPRESS and LOCAL_BIKE stay 0.
        assert_eq!(r.trip_bikes_allowed(0).unwrap(), 0);
        assert_eq!(r.trip_bikes_allowed(1).unwrap(), 2);
        assert_eq!(r.trip_bikes_allowed(2).unwrap(), 0);
        assert_eq!(r.trip_meta_raw().unwrap()[24 + 22], 2);
    }

    #[test]
    fn mode_fixtures_roundtrip() {
        // mode-ferry-only: single FERRY route (route_type 1008), built through the
        // current PTB v1 carry-less pattern-band writer.
        let r = Reader::from_bytes(mode_ferry_only()).unwrap();
        assert_eq!(r.header().version, 1, "v1 header");
        assert!(r.pattern_band_present(), "band present");
        assert_carry_less_band(&r);
        assert!(
            !r.has_pattern_semantics(),
            "all-regular boarding must omit 0x12 PatternSemantics"
        );
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 1, 1));
        assert_eq!(r.stop_id(0).unwrap(), "s0");
        assert_eq!(r.stop_id(1).unwrap(), "s1");
        assert_eq!(r.stop_id(2).unwrap(), "s2");
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.route_type(0).unwrap(), 1008);
        assert_eq!(r.trip(0).unwrap().trip_id, "T0", "stable trip id");
        let patterns = r.patterns().expect("band patterns");
        assert_eq!(patterns.len(), 1, "single pattern");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(r.band_dep_secs(0, 0, 0), Some(25200));
        assert_eq!(r.band_dep_secs(0, 0, 1), Some(25800));

        // mode-other-bucket: two routes — air (1100) then taxi (1500), both OTHER —
        // also built through the current PTB v1 carry-less pattern-band writer.
        let r = Reader::from_bytes(mode_other_bucket()).unwrap();
        assert_eq!(r.header().version, 1, "v1 header");
        assert!(r.pattern_band_present(), "band present");
        assert_carry_less_band(&r);
        assert!(
            !r.has_pattern_semantics(),
            "all-regular boarding must omit 0x12 PatternSemantics"
        );
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 2, 2));
        assert_eq!(r.stop_id(0).unwrap(), "s0");
        assert_eq!(r.stop_id(1).unwrap(), "s1");
        assert_eq!(r.stop_id(2).unwrap(), "s2");
        assert_eq!(r.route_id(0).unwrap(), "R0");
        assert_eq!(r.route_id(1).unwrap(), "R1");
        assert_eq!(r.route_type(0).unwrap(), 1100);
        assert_eq!(r.route_type(1).unwrap(), 1500);
        assert_eq!(r.trip(0).unwrap().trip_id, "T0", "stable trip id");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1", "stable trip id");
        let patterns = r.patterns().expect("band patterns");
        assert_eq!(patterns.len(), 2, "two patterns, one per route");
        let p0: Vec<u32> = r.pattern_stops(0).unwrap().to_vec();
        let p1: Vec<u32> = r.pattern_stops(1).unwrap().to_vec();
        let want_r0 = vec![0u32, 1]; // s0->s1 (air)
        let want_r1 = vec![0u32, 2]; // s0->s2 (taxi)
        assert!(
            (p0 == want_r0 && p1 == want_r1) || (p0 == want_r1 && p1 == want_r0),
            "band PatternStops reproduce both route legs; got {p0:?} / {p1:?}"
        );
        let air_pattern: usize = if p0 == want_r0 { 0 } else { 1 };
        let taxi_pattern: usize = 1 - air_pattern;
        assert_eq!(r.band_dep_secs(air_pattern, 0, 0), Some(25200));
        assert_eq!(r.band_dep_secs(air_pattern, 0, 1), Some(25800));
        assert_eq!(r.band_dep_secs(taxi_pattern, 0, 0), Some(25200));
        assert_eq!(r.band_dep_secs(taxi_pattern, 0, 1), Some(25800));
    }

    #[test]
    fn terminal_dwell_roundtrips() {
        let r = Reader::from_bytes(terminal_dwell()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1]);
        // s1 row carries dep 25800 with arr_diff -120 (the dwell).
        assert_eq!(st(&r, 1), (25800, -120));
    }

    #[test]
    fn footpath_ptb_and_transfers_roundtrip() {
        let r = Reader::from_bytes(footpath_ptb()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (4, 1, 1));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(st(&r, 1), (25500, 0)); // s1 reached @25500
                                           // s2/s3 are present but served by no transit pattern.
        assert!(r.patterns_at_stop(2).unwrap().is_empty());
        assert!(r.patterns_at_stop(3).unwrap().is_empty());

        let footpath_bytes = footpath_transfers();
        let t = Transfers::from_bytes(&footpath_bytes).unwrap();
        assert_eq!(t.stop_count(), 4);
        let s1 = t.index_of("s1").unwrap();
        let (nbrs, walks) = t.edges(s1);
        assert_eq!(nbrs, &[2u32, 3]); // s1 -> s2, s1 -> s3
        assert_eq!(walks, &[60u32, 200]); // raw 60 (floor) and 200 (rescale)
    }

    #[test]
    fn converging_routes_roundtrips() {
        let r = Reader::from_bytes(converging_routes()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (4, 2, 2));
        assert_eq!(r.route_id(0).unwrap(), "R0");
        assert_eq!(r.route_id(1).unwrap(), "R1");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        // Both routes reach s1 @600 (route 0 row 1, route 1 row 4).
        assert_eq!(st(&r, 1), (600, 0));
        assert_eq!(st(&r, 4), (600, 0));
        // The ordering trap depends on s1's pattern order being [0, 1].
        assert_eq!(r.patterns_at_stop(1).unwrap(), &[0u32, 1]);
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1, 2]);
        assert_eq!(r.pattern_stops(1).unwrap(), &[0u32, 1, 3]);
    }

    #[test]
    fn overnight_roundtrips() {
        let r = Reader::from_bytes(overnight()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(st(&r, 0), (91800, 0)); // departs after 86400
        assert_eq!(st(&r, 1), (92400, 0));
    }

    #[test]
    fn overnight_prev_day_roundtrips() {
        let r = Reader::from_bytes(overnight_prev_day()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        assert_eq!(r.feed_start_date(), 20260501);
        assert_eq!(r.service_bitfield_pool_count(), 1);
        assert!(r.service_active_on(0, 20260504)); // Monday
        assert!(!r.service_active_on(0, 20260505)); // Tuesday
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(st(&r, 0), (86500, 0));
        assert_eq!(st(&r, 1), (86800, 0));
    }

    #[test]
    fn express_skip_dwell_roundtrips() {
        let r = Reader::from_bytes(express_skip_dwell()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 1, 2));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        let express = r.trip_pattern_idx(0).unwrap() as usize;
        let local = r.trip_pattern_idx(1).unwrap() as usize;
        assert_ne!(local, express);
        assert_eq!(r.pattern_stops(express).unwrap(), &[0u32, 2]);
        assert_eq!(r.pattern_stops(local).unwrap(), &[0u32, 1, 2]);
        assert_eq!(r.pattern_trips(express).unwrap(), &[0u32]);
        assert_eq!(r.pattern_trips(local).unwrap(), &[1u32]);
        assert_eq!(r.band_dep_secs(local, 0, 1), Some(30300));
        assert_eq!(r.band_arr_secs(local, 0, 1), Some(29880));
        assert_eq!(st(&r, 3), (30300, -420));
    }

    #[test]
    fn circular_loop_roundtrips() {
        let r = Reader::from_bytes(circular_loop()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 1, 1));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1, 2, 0]);
        // Four rows over stop_idx 0,1,2,0 — the terminal s0 repeats (row 3).
        assert_eq!(r.stop_time(0).unwrap().stop_idx, 0);
        assert_eq!(r.stop_time(3).unwrap().stop_idx, 0);
        assert_eq!(st(&r, 3), (1800, 0)); // terminal occurrence dep
    }

    #[test]
    fn lasso_roundtrips() {
        let r = Reader::from_bytes(lasso()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (5, 1, 1));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1, 2, 3, 4, 2, 1, 0]);
        // Eight rows over stop_idx 0,1,2,3,4,2,1,0 — the stem stops repeat.
        let idxs: Vec<u32> = (0..8).map(|i| r.stop_time(i).unwrap().stop_idx).collect();
        assert_eq!(idxs, vec![0, 1, 2, 3, 4, 2, 1, 0]);
        assert_eq!(st(&r, 1), (60, 0)); // S outbound (position 1) dep 60
        assert_eq!(st(&r, 6), (360, 0)); // S return (position 6) dep 360
    }

    #[test]
    fn window_horizon_roundtrips_with_wide_stride() {
        // The non-90 windowDays fixture round-trips through the SAME Reader the
        // gate uses, with the WIDE stride decoded. This is the vacuous-pass guard:
        // if the 0x01 WindowMeta byte layout or the bitmask stride drifted, BOTH
        // engines might agree on a wrong window and the gate would pass green.
        let r = Reader::from_bytes(window_horizon()).unwrap();
        assert_eq!(
            r.header().version,
            pt_core::PTB_VERSION_V1,
            "current PTB v1"
        );
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        // windowDays is the non-90 horizon, stride = ceil(400/8) = 50.
        assert_eq!(r.window_days(), WINDOW_HORIZON_WINDOW_DAYS);
        assert_eq!(r.window_days(), 400);
        assert!(r.window_days() > 90, "fixture window must exceed 90");
        assert_eq!(r.bytes_per_service(), 50);
        assert!(
            r.window_meta_present(),
            "0x01 WindowMeta must be present (DECODED, not the absent-default 90)"
        );
        // s0@25200 → s1@25500 (the routable daytime trip).
        assert_eq!(st(&r, 0), (25200, 0));
        assert_eq!(st(&r, 1), (25500, 0));
        // The service is all-active across the FULL 400-day window: day-offset 100
        // (20260909, > 90) resolves ACTIVE under the wide window. Under the OLD
        // fixed-90 window this same day would fall outside the guard → INACTIVE,
        // so this assertion is exactly the wide-stride routability the gate proves.
        assert!(
            r.service_active_on(0, 20260909),
            "day-offset 100 (> 90) must be active under the 400-day window"
        );
        // The pinned-date the tuple queries is the same day-offset-100 date.
        assert!(
            r.service_active_on(0, 20260601),
            "feedStartDate (offset 0) active"
        );
    }

    #[test]
    fn window_nonweekly_horizon_diverges_past_day_90() {
        // The per-day-fidelity fixture: native reads the bitmask directly, so the
        // non-weekly divergence past day 90 is honored. This is the vacuous-pass
        // guard for the RED-first proof — if the bitmask builder regressed to a
        // clean weekly pattern, the >90 divergence (and the golden RED) would
        // vanish silently.
        let r = Reader::from_bytes(window_nonweekly_horizon()).unwrap();
        assert_eq!(
            r.header().version,
            pt_core::PTB_VERSION_V1,
            "current PTB v1"
        );
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        assert_eq!(r.window_days(), 400);
        assert_eq!(r.bytes_per_service(), 50);
        assert!(r.window_meta_present());
        // feedStartDate 20260601 is a Monday (offset 0). Within the first 90 days
        // the bitmask is Mon–Fri:
        assert!(r.service_active_on(0, 20260601), "offset 0 (Mon) active");
        assert!(
            r.service_active_on(0, 20260602),
            "offset 1 (Tue, < 90) active"
        );
        assert!(!r.service_active_on(0, 20260606), "offset 5 (Sat) inactive");
        // Past day 90 the bitmask is Mondays-ONLY — the divergence the weekly base
        // cannot reproduce. 20260831 (offset 91) is a Monday → active; 20260901
        // (offset 92, a Tuesday) is INACTIVE under the bitmask even though a weekly
        // Mon–Fri base would mark it active. This is the day the paired tuple queries.
        assert!(
            r.service_active_on(0, 20260831),
            "offset 91 (Mon, > 90) active"
        );
        assert!(
            !r.service_active_on(0, 20260901),
            "offset 92 (Tue, > 90) MUST be inactive under the Mondays-only tail \
             (the non-weekly divergence the weekly base would invent as active)"
        );
    }

    #[test]
    fn service_pool_roundtrips_via_pool() {
        // The fixture round-trips through the same
        // Reader the engine-regression gate's Rust side uses, and the hand-constructed
        // pool/index resolve correctly. If the `0x15`/`0x16` byte layout drifted,
        // the engine and its wasm binding might agree on a wrong mask and the gate would pass green.
        let r = Reader::from_bytes(service_pool()).unwrap();
        assert_eq!(r.header().version, 1, "current PTB v1");
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        // 3 services, default 90-day window ⇒ 12-byte stride.
        assert_eq!(r.num_services(), 3);
        assert_eq!(r.window_days(), pt_core::WINDOW_DEFAULT_DAYS);
        assert_eq!(r.bytes_per_service(), 12);
        // The dedup pool MUST hold exactly 2 distinct bitfields (count < num_services
        // = a genuine fold, not the degenerate count==num_services). This is what
        // forces the engine and its wasm binding to traverse `0x16 → 0x15` rather than read a flat slot.
        assert_eq!(
            r.service_bitfield_pool_count(),
            2,
            "pool must hold 2 distinct bitfields (count=2 < num_services=3)"
        );

        // The hand-constructed masks resolve through the `0x16` index. Services 0
        // and 2 SHARE pool[0] (all-active 12 × 0xFF); service 1 maps to pool[1]
        // (day-1-only). Byte-for-byte, via `service_bitmask`.
        let bf_all = vec![0xFFu8; 12];
        let bf_day1 = {
            let mut v = vec![0u8; 12];
            v[0] = 0b0000_0010;
            v
        };
        assert_eq!(r.service_bitmask(0), bf_all.as_slice(), "s0 -> pool[0]");
        assert_eq!(r.service_bitmask(1), bf_day1.as_slice(), "s1 -> pool[1]");
        assert_eq!(
            r.service_bitmask(2),
            bf_all.as_slice(),
            "s2 -> pool[0] (shared with s0)"
        );
        // Out-of-range service is `&[]` (panic-free).
        assert_eq!(r.service_bitmask(3), &[] as &[u8]);

        // service_active_on resolves through the pool. The fixture anchors
        // feed_start_date at 20260601 (a Monday, day 0). pool[0] (services 0, 2) is
        // all-active across the window; pool[1] (service 1) is day-1-only.
        assert_eq!(r.feed_start_date(), 20260601);
        // pool[0] services: active on day 0 (20260601) and day 2 (20260603).
        assert!(
            r.service_active_on(0, 20260601),
            "s0 day 0 active (pool[0])"
        );
        assert!(
            r.service_active_on(2, 20260601),
            "s2 day 0 active (pool[0])"
        );
        assert!(
            r.service_active_on(0, 20260603),
            "s0 day 2 active (pool[0])"
        );
        // pool[1] service: ONLY day 1 (20260602) active; day 0 and day 2 inactive.
        assert!(
            !r.service_active_on(1, 20260601),
            "s1 day 0 inactive (pool[1] is day-1-only)"
        );
        assert!(
            r.service_active_on(1, 20260602),
            "s1 day 1 active (pool[1])"
        );
        assert!(
            !r.service_active_on(1, 20260603),
            "s1 day 2 inactive (pool[1] is day-1-only)"
        );
        // The trip rides service 0 (pool[0], all-active) so it is routable on the
        // query day. The s0@25200 → s1@25500 daytime trip decodes via the current
        // SoA StopTimes columns.
        assert_eq!(st(&r, 0), (25200, 0));
        assert_eq!(st(&r, 1), (25500, 0));
        // Keep the distinct-pool bytes referenced (the two masks above pin them).
        let _ = (&bf_all, &bf_day1);
    }

    #[test]
    fn tiny_service_pool_cross_parity_fixture_folds_and_roundtrips() {
        // The committed current PTB v1 fixture must genuinely fold (count=2 <
        // num_services=3), exercising `0x16 → 0x15` rather than a flat slot.
        let r = Reader::from_bytes(build_tiny_service_pool().unwrap()).unwrap();
        assert_eq!(r.header().version, pt_core::PTB_VERSION_V1);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 1, 2));
        assert_eq!(r.num_services(), 3);
        assert_eq!(r.window_days(), pt_core::WINDOW_DEFAULT_DAYS);
        assert_eq!(r.bytes_per_service(), 12);
        // Genuine fold: 2 distinct bitfields for 3 services.
        assert_eq!(
            r.service_bitfield_pool_count(),
            2,
            "tiny-service-pool pool must hold 2 distinct bitfields (count=2 < num_services=3)"
        );
        // Services 0 and 2 SHARE pool[0] (all-active); service 1 is pool[1]
        // (all-active except day 49 cleared) — DISTINCT.
        let bf_all = vec![0xFFu8; 12];
        let bf_not_day49 = {
            let mut v = vec![0xFFu8; 12];
            v[49 / 8] &= !(1u8 << (49 % 8));
            v
        };
        assert_eq!(r.service_bitmask(0), bf_all.as_slice(), "s0 -> pool[0]");
        assert_eq!(
            r.service_bitmask(1),
            bf_not_day49.as_slice(),
            "s1 -> pool[1] (distinct)"
        );
        assert_eq!(
            r.service_bitmask(2),
            bf_all.as_slice(),
            "s2 -> pool[0] (shared with s0)"
        );
        // feed_start_date 20260601 (Monday). The day-49 divergence lands on
        // 20260720, a cross-parity PINNED_DATE: services 0/2 active, service 1 not.
        assert_eq!(r.feed_start_date(), 20260601);
        assert!(
            r.service_active_on(0, 20260720),
            "s0 active day 49 (pool[0])"
        );
        assert!(
            r.service_active_on(2, 20260720),
            "s2 active day 49 (pool[0])"
        );
        assert!(
            !r.service_active_on(1, 20260720),
            "s1 inactive day 49 (pool[1] cleared that day)"
        );
        // The trips ride service 0 (all-active) — routable on any query day.
        // `st` returns (dep_secs, arr_diff); arr_diff is 0 for every assembled row.
        assert_eq!(st(&r, 0), (25200, 0));
        assert_eq!(st(&r, 1), (25500, 0));
    }

    #[test]
    fn service_pool_distinct_is_all_distinct_identity() {
        // 3 DISTINCT bitfields ⇒ count == num_services == 3 (no
        // fold), pool laid out in input order, identity index. A dedup off-by-one
        // (count-1 / count+1) or a non-input-order pool would break HERE.
        let r = Reader::from_bytes(service_pool_distinct()).unwrap();
        assert_eq!(r.header().version, 1, "current PTB v1");
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        assert_eq!(r.num_services(), 3);
        assert_eq!(r.window_days(), pt_core::WINDOW_DEFAULT_DAYS);
        assert_eq!(r.bytes_per_service(), 12);
        // The defining invariant: count EQUALS num_services (no fold).
        assert_eq!(
            r.service_bitfield_pool_count(),
            3,
            "all-distinct ⇒ count == num_services == 3 (no fold)"
        );
        // Each service resolves to its OWN day-d-only slot, in input order.
        for d in 0..3usize {
            let mut want = vec![0u8; 12];
            want[d / 8] |= 1 << (d % 8);
            assert_eq!(
                r.service_bitmask(d as u32),
                want.as_slice(),
                "service {d} -> pool[{d}] (day-{d}-only)"
            );
        }
        // service_active_on resolves through the identity index. Anchor 20260601
        // (Monday, day 0); each service is active only on its own day.
        assert_eq!(r.feed_start_date(), 20260601);
        assert!(r.service_active_on(0, 20260601), "s0 active day 0");
        assert!(!r.service_active_on(0, 20260602), "s0 inactive day 1");
        assert!(r.service_active_on(1, 20260602), "s1 active day 1");
        assert!(r.service_active_on(2, 20260603), "s2 active day 2");
        // The trip rides service 0 (day-0-only), so it routes on day 0.
        assert_eq!(st(&r, 0), (25200, 0));
        assert_eq!(st(&r, 1), (25500, 0));
    }

    #[test]
    fn service_pool_wide_high_byte_day_roundtrips() {
        // windowDays=400 ⇒ 50-byte stride, service active on the
        // HIGH-BYTE day 399 (byte 49, bit 7). A byte-vs-element stride confusion
        // (invisible at the default 12-byte stride) mislocates this slot.
        let r = Reader::from_bytes(service_pool_wide()).unwrap();
        assert_eq!(r.header().version, 1, "current PTB v1");
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        assert_eq!(r.num_services(), 1);
        // The 0x01 WindowMeta entry widens the runtime window to 400 ⇒ S = 50.
        assert_eq!(r.window_days(), WINDOW_HORIZON_WINDOW_DAYS);
        assert_eq!(r.bytes_per_service(), 50);
        assert_eq!(r.service_bitfield_pool_count(), 1);
        // The single pool bitfield is all-zero except the high byte's top bit.
        let mut want = vec![0u8; 50];
        want[49] = 0b1000_0000; // day 399
        assert_eq!(r.service_bitmask(0), want.as_slice(), "day-399-only slot");
        // Day 399 (20270705) active; the surrounding days inactive (lone day).
        assert_eq!(r.feed_start_date(), 20260601);
        assert!(
            r.service_active_on(0, 20270705),
            "day 399 (20270705) active — the high-byte slot"
        );
        assert!(
            !r.service_active_on(0, 20270704),
            "day 398 inactive (only day 399 is set)"
        );
        assert!(!r.service_active_on(0, 20260601), "day 0 inactive");
        // The trip rides service 0, routable on day 399.
        assert_eq!(st(&r, 0), (25200, 0));
        assert_eq!(st(&r, 1), (25500, 0));
    }

    #[test]
    fn transfer_floor_pair_roundtrips() {
        // Feasible twin: R1 departs s1 at exactly the floor (25620).
        let hit = Reader::from_bytes(transfer_floor()).unwrap();
        assert_eq!(hit.header().version, 1);
        assert!(hit.pattern_band_present());
        assert_carry_less_band(&hit);
        assert_eq!(
            (hit.num_stops(), hit.num_routes(), hit.num_trips()),
            (3, 2, 2)
        );
        assert_eq!(hit.route_id(0).unwrap(), "R0");
        assert_eq!(hit.route_id(1).unwrap(), "R1");
        assert_eq!(hit.trip(0).unwrap().trip_id, "T0");
        assert_eq!(hit.trip(1).unwrap().trip_id, "T1");
        assert_eq!(hit.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(hit.pattern_stops(1).unwrap(), &[1u32, 2]);
        assert_eq!(hit.patterns_at_stop(1).unwrap(), &[0u32, 1]);
        assert_eq!(st(&hit, 1), (25500, 0)); // R0 arrives s1 @25500
        assert_eq!(st(&hit, 2), (25620, 0)); // R1 departs s1 @25620 (= 25500 + 120)

        // Infeasible twin: R1 departs s1 one second below the floor (25619).
        let miss = Reader::from_bytes(transfer_floor_miss()).unwrap();
        assert_eq!(miss.header().version, 1);
        assert!(miss.pattern_band_present());
        assert_carry_less_band(&miss);
        assert_eq!(miss.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(miss.pattern_stops(1).unwrap(), &[1u32, 2]);
        assert_eq!(st(&miss, 2), (25619, 0));
    }

    #[test]
    fn maxrounds_roundtrips() {
        let r = Reader::from_bytes(maxrounds()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 2, 2));
        assert_eq!(r.route_id(0).unwrap(), "R0");
        assert_eq!(r.route_id(1).unwrap(), "R1");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(r.pattern_stops(1).unwrap(), &[1u32, 2]);
        assert_eq!(r.patterns_at_stop(1).unwrap(), &[0u32, 1]);
        assert_eq!(st(&r, 1), (25500, 0)); // R0 s0->s1
        assert_eq!(st(&r, 2), (26000, 0)); // R1 s1->s2 (gap 500s)
    }

    #[test]
    fn transfers_fixture_roundtrips() {
        // The Transfers region round-trips through the SAME Reader the gate uses.
        // Carried only — the routing topology (1 route, 2 stops) still decodes.
        let r = Reader::from_bytes(transfers_fixture()).unwrap();
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        assert_eq!(r.num_transfers(), 2);
        let t0 = r.transfer(0).unwrap();
        assert_eq!(
            (t0.from_stop_idx, t0.to_stop_idx, t0.transfer_type),
            (0, 1, 3)
        );
        assert_eq!(t0.min_transfer_secs, u32::MAX); // absent
        assert_eq!(t0.from_route_idx, u32::MAX);
        assert_eq!(t0.from_trip_idx, u32::MAX);
        let t1 = r.transfer(1).unwrap();
        assert_eq!(
            (t1.from_stop_idx, t1.to_stop_idx, t1.transfer_type),
            (1, 0, 2)
        );
        assert_eq!(t1.min_transfer_secs, 180);
        // Out-of-range index errors like the other accessors.
        assert!(r.transfer(2).is_err());
    }

    #[test]
    fn three_leg_and_transfers_roundtrip() {
        let r = Reader::from_bytes(three_leg()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (5, 3, 3));
        assert_eq!(r.route_id(0).unwrap(), "R0");
        assert_eq!(r.route_id(1).unwrap(), "R1");
        assert_eq!(r.route_id(2).unwrap(), "R2");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        assert_eq!(r.trip(2).unwrap().trip_id, "T2");
        // Per-leg boundary times (rows concatenated in route order R0,R1,R2).
        assert_eq!(st(&r, 0), (100, 0)); // R0 s0
        assert_eq!(st(&r, 1), (600, 0)); // R0 s1 (leg 1 alight)
        assert_eq!(st(&r, 2), (1100, 0)); // R1 s2 (leg 2 board; >= 900+120 floor)
        assert_eq!(st(&r, 3), (1700, 0)); // R1 s3 (leg 2 alight)
        assert_eq!(st(&r, 4), (1900, 0)); // R2 s3 (leg 3 board; >= 1700+120 floor)
        assert_eq!(st(&r, 5), (2500, 0)); // R2 s4 (leg 3 alight)
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(r.pattern_stops(1).unwrap(), &[2u32, 3]);
        assert_eq!(r.pattern_stops(2).unwrap(), &[3u32, 4]);
        assert_eq!(r.patterns_at_stop(0).unwrap(), &[0u32]);
        assert_eq!(r.patterns_at_stop(1).unwrap(), &[0u32]);
        assert_eq!(r.patterns_at_stop(2).unwrap(), &[1u32]);
        assert_eq!(r.patterns_at_stop(3).unwrap(), &[1u32, 2]);
        assert_eq!(r.patterns_at_stop(4).unwrap(), &[2u32]);

        // PTFT: the single s1 -> s2 bridge edge (raw 300, no floor).
        let tr_bytes = three_leg_transfers();
        let t = Transfers::from_bytes(&tr_bytes).unwrap();
        assert_eq!(t.stop_count(), 5);
        let s1 = t.index_of("s1").unwrap();
        let (nbrs, walks) = t.edges(s1);
        assert_eq!(nbrs, &[2u32]); // s1 -> s2
        assert_eq!(walks, &[300u32]);
        // No other stop has outgoing edges (the walk is the sole bridge).
        assert!(t.edges(t.index_of("s0").unwrap()).0.is_empty());
        assert!(t.edges(t.index_of("s2").unwrap()).0.is_empty());
    }

    // S1: the unscoped type-3 / type-2 engine corpus fixtures round-trip through
    // the SAME Reader the gate uses (a structurally-wrong fixture fails loudly
    // instead of passing the gate vacuously). The s1 ordinal is 1 in every
    // `s0,s1,s2` topology, so the same-stop pair is (1,1) and the footpath-style
    // pairs are resolved against it.
    #[test]
    fn s1_transfer_apply_fixtures_roundtrip() {
        // transfer-block: ONE unscoped type-3 (s1,s1).
        let b = Reader::from_bytes(transfer_block()).unwrap();
        assert_eq!(b.header().version, 1);
        assert!(b.pattern_band_present());
        assert_carry_less_band(&b);
        assert_eq!((b.num_stops(), b.num_routes(), b.num_trips()), (3, 2, 2));
        assert_eq!(b.num_transfers(), 1);
        assert_eq!(b.route_id(0).unwrap(), "R0");
        assert_eq!(b.route_id(1).unwrap(), "R1");
        assert_eq!(b.trip(0).unwrap().trip_id, "T0");
        assert_eq!(b.trip(1).unwrap().trip_id, "T1");
        assert_eq!(b.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(b.pattern_stops(1).unwrap(), &[1u32, 2]);
        let t = b.transfer(0).unwrap();
        assert_eq!((t.from_stop_idx, t.to_stop_idx, t.transfer_type), (1, 1, 3));
        assert_eq!(t.from_route_idx, u32::MAX); // unscoped
        assert_eq!(t.from_trip_idx, u32::MAX);
        assert_eq!(t.min_transfer_secs, u32::MAX);
        assert_eq!(st(&b, 2), (25620, 0)); // R1 departs s1 at the global floor

        // mintime feasible/miss: type-2 (s1,s1) with min 300 / 600.
        let feas = Reader::from_bytes(transfer_mintime_feasible()).unwrap();
        assert_eq!(feas.header().version, 1);
        assert!(feas.pattern_band_present());
        assert_carry_less_band(&feas);
        assert_eq!(
            (feas.num_stops(), feas.num_routes(), feas.num_trips()),
            (3, 2, 2)
        );
        assert_eq!(feas.num_transfers(), 1);
        assert_eq!(feas.route_id(0).unwrap(), "R0");
        assert_eq!(feas.route_id(1).unwrap(), "R1");
        assert_eq!(feas.trip(0).unwrap().trip_id, "T0");
        assert_eq!(feas.trip(1).unwrap().trip_id, "T1");
        assert_eq!(feas.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(feas.pattern_stops(1).unwrap(), &[1u32, 2]);
        let tf = feas.transfer(0).unwrap();
        assert_eq!(
            (tf.from_stop_idx, tf.to_stop_idx, tf.transfer_type),
            (1, 1, 2)
        );
        assert_eq!(tf.min_transfer_secs, 300);
        assert_eq!(st(&feas, 2), (26000, 0)); // R1 departs s1 @26000 (>= 25800 floor)

        let miss = Reader::from_bytes(transfer_mintime_miss()).unwrap();
        assert_eq!(miss.header().version, 1);
        assert!(miss.pattern_band_present());
        assert_carry_less_band(&miss);
        assert_eq!(miss.num_transfers(), 1);
        assert_eq!(miss.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(miss.pattern_stops(1).unwrap(), &[1u32, 2]);
        assert_eq!(miss.transfer(0).unwrap().min_transfer_secs, 600); // floor 26100 > 26000
        assert_eq!(st(&miss, 2), (26000, 0));

        // below-floor: type-2 min 30 (< 120), R1 departs s1 @25530.
        let below = Reader::from_bytes(transfer_mintime_below_floor()).unwrap();
        assert_eq!(below.header().version, 1);
        assert!(below.pattern_band_present());
        assert_carry_less_band(&below);
        assert_eq!(
            (below.num_stops(), below.num_routes(), below.num_trips()),
            (3, 2, 2)
        );
        assert_eq!(below.num_transfers(), 1);
        assert_eq!(below.route_id(0).unwrap(), "R0");
        assert_eq!(below.route_id(1).unwrap(), "R1");
        assert_eq!(below.trip(0).unwrap().trip_id, "T0");
        assert_eq!(below.trip(1).unwrap().trip_id, "T1");
        assert_eq!(below.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(below.pattern_stops(1).unwrap(), &[1u32, 2]);
        let tb = below.transfer(0).unwrap();
        assert_eq!(
            (tb.from_stop_idx, tb.to_stop_idx, tb.transfer_type),
            (1, 1, 2)
        );
        assert_eq!(tb.min_transfer_secs, 30);
        assert_eq!(st(&below, 2), (25530, 0)); // 30s gap, below the global floor

        // scoped-ignored: type-3 (s1,s1) WITH from_route_idx 0 (must be dropped
        // by the index builders → behaviour == no rule). The Reader still
        // decodes the raw scoped row (it does not apply the unscoped filter).
        let sc = Reader::from_bytes(transfer_scoped_ignored()).unwrap();
        assert_eq!(sc.header().version, 1);
        assert!(sc.pattern_band_present());
        assert_carry_less_band(&sc);
        assert_eq!((sc.num_stops(), sc.num_routes(), sc.num_trips()), (3, 2, 2));
        assert_eq!(sc.num_transfers(), 1);
        assert_eq!(sc.route_id(0).unwrap(), "R0");
        assert_eq!(sc.route_id(1).unwrap(), "R1");
        assert_eq!(sc.trip(0).unwrap().trip_id, "T0");
        assert_eq!(sc.trip(1).unwrap().trip_id, "T1");
        assert_eq!(sc.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(sc.pattern_stops(1).unwrap(), &[1u32, 2]);
        let ts = sc.transfer(0).unwrap();
        assert_eq!(
            (ts.from_stop_idx, ts.to_stop_idx, ts.transfer_type),
            (1, 1, 3)
        );
        assert_eq!(ts.from_route_idx, 0); // SCOPED — the unscoped filter drops it
        assert_eq!(ts.to_route_idx, u32::MAX);
        assert_eq!(ts.from_trip_idx, u32::MAX);
        assert_eq!(ts.to_trip_idx, u32::MAX);
        assert_eq!(ts.min_transfer_secs, u32::MAX);
        assert_eq!(st(&sc, 2), (25620, 0)); // R1 departs s1 at the global floor
    }

    // S1 review follow-ups: the type-2-no-min landmine + the footpath type-3 /
    // type-2 apply fixtures round-trip through the SAME Reader the gate uses.
    #[test]
    fn s1_review_fixtures_roundtrip() {
        // type2-no-min: unscoped type-2 (s1,s1) with NO min (u32::MAX). The
        // Reader decodes the raw row; the index builders' actionable predicate
        // drops it → behaviour == no rule (R1 @25620 = global floor → feasible).
        let nm = Reader::from_bytes(transfer_type2_no_min()).unwrap();
        assert_eq!(nm.header().version, 1);
        assert!(nm.pattern_band_present());
        assert_carry_less_band(&nm);
        assert_eq!((nm.num_stops(), nm.num_routes(), nm.num_trips()), (3, 2, 2));
        assert_eq!(nm.num_transfers(), 1);
        assert_eq!(nm.route_id(0).unwrap(), "R0");
        assert_eq!(nm.route_id(1).unwrap(), "R1");
        assert_eq!(nm.trip(0).unwrap().trip_id, "T0");
        assert_eq!(nm.trip(1).unwrap().trip_id, "T1");
        assert_eq!(nm.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(nm.pattern_stops(1).unwrap(), &[1u32, 2]);
        let t = nm.transfer(0).unwrap();
        assert_eq!((t.from_stop_idx, t.to_stop_idx, t.transfer_type), (1, 1, 2));
        assert_eq!(t.min_transfer_secs, u32::MAX); // ABSENT — the landmine
        assert_eq!(t.from_route_idx, u32::MAX); // unscoped
        assert_eq!(t.to_route_idx, u32::MAX);
        assert_eq!(t.from_trip_idx, u32::MAX);
        assert_eq!(t.to_trip_idx, u32::MAX);
        assert_eq!(st(&nm, 2), (25620, 0)); // R1 departs s1 at exactly the global floor

        // footpath-block: type-3 (s1,s2) over the footpath topology (4 stops,
        // s2/s3 transit-unreachable). The paired footpath-transfers.bin carries
        // the s1→s2 edge the rule removes.
        let fb = Reader::from_bytes(transfer_footpath_block()).unwrap();
        assert_eq!(fb.header().version, 1);
        assert!(fb.pattern_band_present());
        assert_carry_less_band(&fb);
        assert_eq!((fb.num_stops(), fb.num_routes(), fb.num_trips()), (4, 1, 1));
        assert_eq!(fb.num_transfers(), 1);
        assert_eq!(fb.route_id(0).unwrap(), "R0");
        assert_eq!(fb.trip(0).unwrap().trip_id, "T0");
        assert_eq!(fb.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert!(fb.patterns_at_stop(2).unwrap().is_empty()); // s2 transit-unreachable
        assert!(fb.patterns_at_stop(3).unwrap().is_empty()); // s3 transit-unreachable
        let tb = fb.transfer(0).unwrap();
        assert_eq!(
            (tb.from_stop_idx, tb.to_stop_idx, tb.transfer_type),
            (1, 2, 3)
        );
        assert_eq!(tb.from_route_idx, u32::MAX); // unscoped
        assert_eq!(tb.to_route_idx, u32::MAX);
        assert_eq!(tb.from_trip_idx, u32::MAX);
        assert_eq!(tb.to_trip_idx, u32::MAX);
        assert_eq!(tb.min_transfer_secs, u32::MAX);
        assert_eq!(st(&fb, 1), (25500, 0));

        // footpath-mintime: type-2 (s1,s2) min 300 over the footpath topology
        // (4 stops, s2/s3 transit-unreachable). The paired footpath-transfers.bin
        // carries the s1→s2 edge whose floor the rule raises to 300.
        let fm = Reader::from_bytes(transfer_footpath_mintime()).unwrap();
        assert_eq!(fm.header().version, 1);
        assert!(fm.pattern_band_present());
        assert_carry_less_band(&fm);
        assert_eq!((fm.num_stops(), fm.num_routes(), fm.num_trips()), (4, 1, 1));
        assert_eq!(fm.num_transfers(), 1);
        assert_eq!(fm.route_id(0).unwrap(), "R0");
        assert_eq!(fm.trip(0).unwrap().trip_id, "T0");
        assert_eq!(fm.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert!(fm.patterns_at_stop(2).unwrap().is_empty()); // s2 transit-unreachable
        assert!(fm.patterns_at_stop(3).unwrap().is_empty()); // s3 transit-unreachable
        let tm = fm.transfer(0).unwrap();
        assert_eq!(
            (tm.from_stop_idx, tm.to_stop_idx, tm.transfer_type),
            (1, 2, 2)
        );
        assert_eq!(tm.min_transfer_secs, 300);
        assert_eq!(tm.from_route_idx, u32::MAX); // unscoped
        assert_eq!(tm.to_route_idx, u32::MAX);
        assert_eq!(tm.from_trip_idx, u32::MAX);
        assert_eq!(tm.to_trip_idx, u32::MAX);
        assert_eq!(st(&fm, 1), (25500, 0));

        // The committed footpath-transfers.bin (reused by both footpath fixtures)
        // carries the s1→s2 edge the rules act on (raw 60).
        let footpath_bytes = footpath_transfers();
        let tr = Transfers::from_bytes(&footpath_bytes).unwrap();
        let s1 = tr.index_of("s1").unwrap();
        let (nbrs, walks) = tr.edges(s1);
        assert_eq!(nbrs, &[2u32, 3]); // s1 -> s2, s1 -> s3
        assert_eq!(walks, &[60u32, 200]);
    }

    // S2: the type-1 (timed / guaranteed connection) apply fixtures round-trip
    // through the SAME Reader the gate uses. The s1 ordinal is 1 in every
    // `s0,s1,s2` topology, so the same-stop pair is (1,1) and the footpath pair
    // is (1,2). A timed rule carries NO min (min_transfer_secs == u32::MAX).
    #[test]
    fn s2_timed_fixtures_roundtrip() {
        // timed-board: UNSCOPED type-1 (s1,s1) over the below-floor topology
        // (R1 departs s1 @25530, a 30s gap). The floor-0 application makes it
        // feasible; the Reader decodes the raw row.
        let tb = Reader::from_bytes(transfer_timed_board()).unwrap();
        assert_eq!(tb.header().version, 1);
        assert!(tb.pattern_band_present());
        assert_carry_less_band(&tb);
        assert_eq!((tb.num_stops(), tb.num_routes(), tb.num_trips()), (3, 2, 2));
        assert_eq!(tb.num_transfers(), 1);
        assert_eq!(tb.route_id(0).unwrap(), "R0");
        assert_eq!(tb.route_id(1).unwrap(), "R1");
        assert_eq!(tb.trip(0).unwrap().trip_id, "T0");
        assert_eq!(tb.trip(1).unwrap().trip_id, "T1");
        assert_eq!(tb.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(tb.pattern_stops(1).unwrap(), &[1u32, 2]);
        let t = tb.transfer(0).unwrap();
        assert_eq!((t.from_stop_idx, t.to_stop_idx, t.transfer_type), (1, 1, 1));
        assert_eq!(t.min_transfer_secs, u32::MAX); // type 1 carries no min
        assert_eq!(t.from_route_idx, u32::MAX); // unscoped
        assert_eq!(t.to_route_idx, u32::MAX);
        assert_eq!(t.from_trip_idx, u32::MAX);
        assert_eq!(t.to_trip_idx, u32::MAX);
        assert_eq!(st(&tb, 0), (25200, 0)); // R0 s0
        assert_eq!(st(&tb, 1), (25500, 0)); // R0 arrives s1
        assert_eq!(st(&tb, 2), (25530, 0)); // R1 departs s1 (30s gap < global floor)
        assert_eq!(st(&tb, 3), (25830, 0)); // R1 arrives s2

        // timed-footpath: UNSCOPED type-1 (s1,s2) over the footpath topology
        // (4 stops, s2/s3 transit-unreachable). Paired with footpath-transfers.bin.
        let tf = Reader::from_bytes(transfer_timed_footpath()).unwrap();
        assert_eq!(tf.header().version, 1);
        assert!(tf.pattern_band_present());
        assert_carry_less_band(&tf);
        assert_eq!((tf.num_stops(), tf.num_routes(), tf.num_trips()), (4, 1, 1));
        assert_eq!(tf.num_transfers(), 1);
        assert_eq!(tf.route_id(0).unwrap(), "R0");
        assert_eq!(tf.trip(0).unwrap().trip_id, "T0");
        assert_eq!(tf.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert!(tf.patterns_at_stop(2).unwrap().is_empty()); // s2 transit-unreachable
        assert!(tf.patterns_at_stop(3).unwrap().is_empty()); // s3 transit-unreachable
        let ft = tf.transfer(0).unwrap();
        assert_eq!(
            (ft.from_stop_idx, ft.to_stop_idx, ft.transfer_type),
            (1, 2, 1)
        );
        assert_eq!(ft.min_transfer_secs, u32::MAX);
        assert_eq!(ft.from_route_idx, u32::MAX); // unscoped
        assert_eq!(ft.to_route_idx, u32::MAX);
        assert_eq!(ft.from_trip_idx, u32::MAX);
        assert_eq!(ft.to_trip_idx, u32::MAX);
        assert_eq!(st(&tf, 0), (25200, 0));
        assert_eq!(st(&tf, 1), (25500, 0));

        // timed-scoped-ignored: type-1 (s1,s1) WITH from_route_idx 0 (must be
        // dropped → global floor → 30s gap blocked → EMPTY). The Reader still
        // decodes the raw scoped row.
        let sc = Reader::from_bytes(transfer_timed_scoped_ignored()).unwrap();
        assert_eq!(sc.header().version, 1);
        assert!(sc.pattern_band_present());
        assert_carry_less_band(&sc);
        assert_eq!((sc.num_stops(), sc.num_routes(), sc.num_trips()), (3, 2, 2));
        assert_eq!(sc.num_transfers(), 1);
        assert_eq!(sc.route_id(0).unwrap(), "R0");
        assert_eq!(sc.route_id(1).unwrap(), "R1");
        assert_eq!(sc.trip(0).unwrap().trip_id, "T0");
        assert_eq!(sc.trip(1).unwrap().trip_id, "T1");
        assert_eq!(sc.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(sc.pattern_stops(1).unwrap(), &[1u32, 2]);
        let ts = sc.transfer(0).unwrap();
        assert_eq!(
            (ts.from_stop_idx, ts.to_stop_idx, ts.transfer_type),
            (1, 1, 1)
        );
        assert_eq!(ts.from_route_idx, 0); // SCOPED — the unscoped filter drops it
        assert_eq!(ts.to_route_idx, u32::MAX);
        assert_eq!(ts.from_trip_idx, u32::MAX);
        assert_eq!(ts.to_trip_idx, u32::MAX);
        assert_eq!(ts.min_transfer_secs, u32::MAX);
        assert_eq!(st(&sc, 0), (25200, 0)); // R0 s0
        assert_eq!(st(&sc, 1), (25500, 0)); // R0 arrives s1
        assert_eq!(st(&sc, 2), (25530, 0)); // R1 @25530, below the global floor
        assert_eq!(st(&sc, 3), (25830, 0)); // R1 arrives s2
    }

    // S3: the scoped (trip→trip) apply + specificity fixtures round-trip through
    // the SAME Reader the gate uses. Trip ordinals are route ordinals (route r
    // owns trip r): T0 = global trip 0, T1 = global trip 1.
    #[test]
    fn s3_scoped_fixtures_roundtrip() {
        // scoped-block: ONE trip-scoped type-3 (s1,s1, T0→T1).
        let b = Reader::from_bytes(transfer_scoped_block()).unwrap();
        assert_eq!(b.header().version, 1);
        assert!(b.pattern_band_present());
        assert_carry_less_band(&b);
        assert_eq!((b.num_stops(), b.num_routes(), b.num_trips()), (3, 2, 2));
        assert_eq!(b.num_transfers(), 1);
        assert_eq!(b.route_id(0).unwrap(), "R0");
        assert_eq!(b.route_id(1).unwrap(), "R1");
        assert_eq!(b.trip(0).unwrap().trip_id, "T0");
        assert_eq!(b.trip(1).unwrap().trip_id, "T1");
        assert_eq!(b.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(b.pattern_stops(1).unwrap(), &[1u32, 2]);
        let t = b.transfer(0).unwrap();
        assert_eq!((t.from_stop_idx, t.to_stop_idx, t.transfer_type), (1, 1, 3));
        assert_eq!(t.from_route_idx, u32::MAX); // not route-scoped
        assert_eq!(t.to_route_idx, u32::MAX);
        assert_eq!((t.from_trip_idx, t.to_trip_idx), (0, 1)); // T0 → T1
        assert_eq!(t.min_transfer_secs, u32::MAX);
        assert_eq!(st(&b, 0), (25200, 0)); // R0 departs s0
        assert_eq!(st(&b, 1), (25500, 0)); // R0 arrives s1
        assert_eq!(st(&b, 2), (25620, 0)); // R1 departs s1 at the global floor
        assert_eq!(st(&b, 3), (26000, 0)); // R1 arrives s2

        // scoped-specificity: row 0 unscoped type-3, row 1 trip-scoped type-1.
        let s = Reader::from_bytes(transfer_scoped_specificity()).unwrap();
        assert_eq!(s.header().version, 1);
        assert!(s.pattern_band_present());
        assert_carry_less_band(&s);
        assert_eq!((s.num_stops(), s.num_routes(), s.num_trips()), (3, 2, 2));
        assert_eq!(s.num_transfers(), 2);
        assert_eq!(s.route_id(0).unwrap(), "R0");
        assert_eq!(s.route_id(1).unwrap(), "R1");
        assert_eq!(s.trip(0).unwrap().trip_id, "T0");
        assert_eq!(s.trip(1).unwrap().trip_id, "T1");
        assert_eq!(s.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(s.pattern_stops(1).unwrap(), &[1u32, 2]);
        let unscoped = s.transfer(0).unwrap();
        assert_eq!(
            (
                unscoped.from_stop_idx,
                unscoped.to_stop_idx,
                unscoped.transfer_type
            ),
            (1, 1, 3)
        );
        assert_eq!(unscoped.from_route_idx, u32::MAX); // unscoped
        assert_eq!(unscoped.to_route_idx, u32::MAX);
        assert_eq!(unscoped.from_trip_idx, u32::MAX);
        assert_eq!(unscoped.to_trip_idx, u32::MAX);
        assert_eq!(unscoped.min_transfer_secs, u32::MAX);
        let trip = s.transfer(1).unwrap();
        assert_eq!(
            (trip.from_stop_idx, trip.to_stop_idx, trip.transfer_type),
            (1, 1, 1)
        );
        assert_eq!(trip.from_route_idx, u32::MAX); // not route-scoped
        assert_eq!(trip.to_route_idx, u32::MAX);
        assert_eq!((trip.from_trip_idx, trip.to_trip_idx), (0, 1)); // T0 → T1
        assert_eq!(trip.min_transfer_secs, u32::MAX);
        assert_eq!(st(&s, 0), (25200, 0)); // R0 departs s0
        assert_eq!(st(&s, 1), (25500, 0)); // R0 arrives s1
        assert_eq!(st(&s, 2), (25530, 0)); // R1 @25530, below the global floor
        assert_eq!(st(&s, 3), (25830, 0)); // R1 arrives s2
    }

    // S3: the type-4 in-seat + type-5 (in-seat forbidden) fixtures round-trip
    // through the SAME Reader the gate uses. Both are trip-scoped (T0→T1) over
    // the FEASIBLE-AT-FLOOR topology (R1 departs s1 @25620 = arrival + 120s
    // floor), so type-4 reports 0 transfers (in-seat excluded) and type-5
    // reports 1 (no-op) — the one-fewer-transfer contrast.
    #[test]
    fn s3_inseat_fixtures_roundtrip() {
        // inseat: trip-scoped type-4 (s1,s1, T0→T1).
        let i = Reader::from_bytes(transfer_inseat()).unwrap();
        assert_eq!(i.header().version, 1);
        assert!(i.pattern_band_present());
        assert_carry_less_band(&i);
        assert_eq!((i.num_stops(), i.num_routes(), i.num_trips()), (3, 2, 2));
        assert_eq!(i.num_transfers(), 1);
        assert_eq!(i.route_id(0).unwrap(), "R0");
        assert_eq!(i.route_id(1).unwrap(), "R1");
        assert_eq!(i.trip(0).unwrap().trip_id, "T0");
        assert_eq!(i.trip(1).unwrap().trip_id, "T1");
        assert_eq!(i.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(i.pattern_stops(1).unwrap(), &[1u32, 2]);
        let t = i.transfer(0).unwrap();
        assert_eq!((t.from_stop_idx, t.to_stop_idx, t.transfer_type), (1, 1, 4));
        assert_eq!(t.from_route_idx, u32::MAX); // not route-scoped
        assert_eq!(t.to_route_idx, u32::MAX);
        assert_eq!((t.from_trip_idx, t.to_trip_idx), (0, 1)); // T0 → T1
        assert_eq!(t.min_transfer_secs, u32::MAX); // type 4 carries no min
        assert_eq!(st(&i, 0), (25200, 0)); // R0 departs s0
        assert_eq!(st(&i, 1), (25500, 0)); // R0 arrives s1
        assert_eq!(st(&i, 2), (25620, 0)); // R1 departs s1 at the global floor
        assert_eq!(st(&i, 3), (26000, 0)); // R1 arrives s2

        // inseat-forbidden: trip-scoped type-5 (s1,s1, T0→T1).
        let f = Reader::from_bytes(transfer_inseat_forbidden()).unwrap();
        assert_eq!(f.header().version, 1);
        assert!(f.pattern_band_present());
        assert_carry_less_band(&f);
        assert_eq!((f.num_stops(), f.num_routes(), f.num_trips()), (3, 2, 2));
        assert_eq!(f.num_transfers(), 1);
        assert_eq!(f.route_id(0).unwrap(), "R0");
        assert_eq!(f.route_id(1).unwrap(), "R1");
        assert_eq!(f.trip(0).unwrap().trip_id, "T0");
        assert_eq!(f.trip(1).unwrap().trip_id, "T1");
        assert_eq!(f.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(f.pattern_stops(1).unwrap(), &[1u32, 2]);
        let tf = f.transfer(0).unwrap();
        assert_eq!(
            (tf.from_stop_idx, tf.to_stop_idx, tf.transfer_type),
            (1, 1, 5)
        );
        assert_eq!(tf.from_route_idx, u32::MAX); // not route-scoped
        assert_eq!(tf.to_route_idx, u32::MAX);
        assert_eq!((tf.from_trip_idx, tf.to_trip_idx), (0, 1)); // T0 → T1
        assert_eq!(tf.min_transfer_secs, u32::MAX); // type 5 carries no min
        assert_eq!(st(&f, 0), (25200, 0)); // R0 departs s0
        assert_eq!(st(&f, 1), (25500, 0)); // R0 arrives s1
        assert_eq!(st(&f, 2), (25620, 0)); // R1 departs s1 at the global floor
        assert_eq!(st(&f, 3), (26000, 0)); // R1 arrives s2
    }

    // The block-chained lasso in-seat fixture decodes as a current-v1 carry-less
    // pattern band: two routes, one trip each, joined at the apex s2 by a
    // trip-scoped type-4 row.
    #[test]
    fn block_chained_lasso_inseat_roundtrip() {
        let b = Reader::from_bytes(block_chained_lasso_inseat()).unwrap();
        assert_eq!(b.header().version, 1);
        assert!(b.pattern_band_present());
        assert_carry_less_band(&b);
        assert_eq!((b.num_stops(), b.num_routes(), b.num_trips()), (5, 2, 2));
        assert_eq!(b.num_transfers(), 1);
        assert_eq!(b.route_id(0).unwrap(), "R0");
        assert_eq!(b.route_id(1).unwrap(), "R1");
        assert_eq!(b.trip(0).unwrap().trip_id, "T0");
        assert_eq!(b.trip(1).unwrap().trip_id, "T1");
        assert_eq!(b.pattern_stops(0).unwrap(), &[0u32, 1, 2]);
        assert_eq!(b.pattern_stops(1).unwrap(), &[2u32, 3, 4]);
        let t = b.transfer(0).unwrap();
        assert_eq!((t.from_stop_idx, t.to_stop_idx, t.transfer_type), (2, 2, 4));
        assert_eq!((t.from_route_idx, t.to_route_idx), (u32::MAX, u32::MAX)); // not route-scoped
        assert_eq!((t.from_trip_idx, t.to_trip_idx), (0, 1)); // T0 → T1
        assert_eq!(t.min_transfer_secs, u32::MAX); // type 4 carries no min
        assert_eq!(st(&b, 0), (0, 0)); // T0 departs s0
        assert_eq!(st(&b, 1), (60, 0)); // T0 at s1
        assert_eq!(st(&b, 2), (120, 0)); // T0 arrives apex s2
        assert_eq!(st(&b, 3), (180, 0)); // T1 departs apex s2, 60s later
        assert_eq!(st(&b, 4), (240, 0)); // T1 at s3
        assert_eq!(st(&b, 5), (300, 0)); // T1 arrives s4
    }

    // The route-scoped apply and trip-over-route specificity fixtures decode as
    // current-v1 carry-less pattern bands. Route ordinals are R0/R1; each route
    // owns one trip, so T0 = global trip 0 and T1 = global trip 1.
    #[test]
    fn s3_route_scoped_fixtures_roundtrip() {
        // scoped-route: one route-scoped type-1 (s1,s1, R0→R1) over the
        // below-floor topology (R1 departs s1 @25530, a 30s gap < global floor).
        let rt = Reader::from_bytes(transfer_scoped_route()).unwrap();
        assert_eq!(rt.header().version, 1);
        assert!(rt.pattern_band_present());
        assert_carry_less_band(&rt);
        assert_eq!((rt.num_stops(), rt.num_routes(), rt.num_trips()), (3, 2, 2));
        assert_eq!(rt.num_transfers(), 1);
        assert_eq!(rt.route_id(0).unwrap(), "R0");
        assert_eq!(rt.route_id(1).unwrap(), "R1");
        assert_eq!(rt.trip(0).unwrap().trip_id, "T0");
        assert_eq!(rt.trip(1).unwrap().trip_id, "T1");
        assert_eq!(rt.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(rt.pattern_stops(1).unwrap(), &[1u32, 2]);
        let t = rt.transfer(0).unwrap();
        assert_eq!((t.from_stop_idx, t.to_stop_idx, t.transfer_type), (1, 1, 1));
        assert_eq!((t.from_route_idx, t.to_route_idx), (0, 1)); // R0 → R1 (route-scoped)
        assert_eq!((t.from_trip_idx, t.to_trip_idx), (u32::MAX, u32::MAX)); // not trip-scoped
        assert_eq!(t.min_transfer_secs, u32::MAX); // type 1 carries no min
        assert_eq!(st(&rt, 0), (25200, 0)); // R0 departs s0
        assert_eq!(st(&rt, 1), (25500, 0)); // R0 arrives s1
        assert_eq!(st(&rt, 2), (25530, 0)); // R1 @25530, below the global floor
        assert_eq!(st(&rt, 3), (25830, 0)); // R1 arrives s2

        // trip-beats-route: row 0 route-scoped type-1 (R0→R1, would keep feasible),
        // row 1 trip-scoped type-3 (T0→T1, forbid). The trip rule is more specific.
        let tb = Reader::from_bytes(transfer_scoped_trip_beats_route()).unwrap();
        assert_eq!(tb.header().version, 1);
        assert!(tb.pattern_band_present());
        assert_carry_less_band(&tb);
        assert_eq!((tb.num_stops(), tb.num_routes(), tb.num_trips()), (3, 2, 2));
        assert_eq!(tb.num_transfers(), 2);
        assert_eq!(tb.route_id(0).unwrap(), "R0");
        assert_eq!(tb.route_id(1).unwrap(), "R1");
        assert_eq!(tb.trip(0).unwrap().trip_id, "T0");
        assert_eq!(tb.trip(1).unwrap().trip_id, "T1");
        assert_eq!(tb.pattern_stops(0).unwrap(), &[0u32, 1]);
        assert_eq!(tb.pattern_stops(1).unwrap(), &[1u32, 2]);
        let route_rule = tb.transfer(0).unwrap();
        assert_eq!(
            (
                route_rule.from_stop_idx,
                route_rule.to_stop_idx,
                route_rule.transfer_type
            ),
            (1, 1, 1)
        );
        assert_eq!((route_rule.from_route_idx, route_rule.to_route_idx), (0, 1)); // R0 → R1
        assert_eq!(
            (route_rule.from_trip_idx, route_rule.to_trip_idx),
            (u32::MAX, u32::MAX)
        ); // route-scoped, no trip
        assert_eq!(route_rule.min_transfer_secs, u32::MAX); // type 1 carries no min
        let trip_rule = tb.transfer(1).unwrap();
        assert_eq!(
            (
                trip_rule.from_stop_idx,
                trip_rule.to_stop_idx,
                trip_rule.transfer_type
            ),
            (1, 1, 3)
        );
        assert_eq!((trip_rule.from_trip_idx, trip_rule.to_trip_idx), (0, 1)); // T0 → T1
        assert_eq!(
            (trip_rule.from_route_idx, trip_rule.to_route_idx),
            (u32::MAX, u32::MAX)
        ); // trip-scoped, no route
        assert_eq!(trip_rule.min_transfer_secs, u32::MAX); // type 3 carries no min
        assert_eq!(st(&tb, 0), (25200, 0)); // R0 departs s0
        assert_eq!(st(&tb, 1), (25500, 0)); // R0 arrives s1
        assert_eq!(st(&tb, 2), (25620, 0)); // R1 departs s1 at the 120s floor
        assert_eq!(st(&tb, 3), (26000, 0)); // R1 arrives s2
    }

    // ── Phase-3A: multi-pattern fixture self-tests ────────────────────────────

    /// `branch-pattern.ptb` — one route, two trips; branch stop s3 is served only
    /// by the BRANCH trip. The band stores two patterns, and under Unbounded s3 is
    /// served by exactly one of them.
    #[test]
    fn branch_pattern_roundtrips() {
        use pt_core::engine::patterns::PatternMode;
        let r = Reader::from_bytes(branch_pattern()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (5, 1, 2));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        // Band: LOCAL and BRANCH are separate patterns with one trip each.
        assert_eq!(r.patterns().expect("band patterns").len(), 2);
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1, 2, 4]); // LOCAL
        assert_eq!(r.pattern_stops(1).unwrap(), &[0u32, 1, 3, 4]); // BRANCH
        assert_eq!(r.pattern_trips(0).unwrap(), &[0u32]);
        assert_eq!(r.pattern_trips(1).unwrap(), &[1u32]);
        // s3 is on the BRANCH pattern only; the trunk and s4 are on both.
        assert_eq!(r.patterns_at_stop(1).unwrap(), &[0u32, 1]);
        assert_eq!(r.patterns_at_stop(2).unwrap(), &[0u32]);
        assert_eq!(r.patterns_at_stop(3).unwrap(), &[1u32]);
        assert_eq!(r.patterns_at_stop(4).unwrap(), &[0u32, 1]);
        assert_eq!(r.band_dep_secs(0, 0, 0), Some(25_200)); // T0 departs s0
        assert_eq!(r.band_dep_secs(0, 0, 3), Some(26_100)); // T0 at s4
        assert_eq!(r.band_dep_secs(1, 0, 2), Some(29_400)); // T1 at s3
        assert_eq!(r.band_dep_secs(1, 0, 3), Some(29_700)); // T1 at s4
                                                            // Under Unbounded: two patterns; num_pattern_routes == 2.
        let idx = pt_core::engine::index::Index::build(&r, PatternMode::Unbounded).unwrap();
        assert_eq!(
            idx.num_pattern_routes(),
            2,
            "two patterns for branch topology"
        );
        // derived_routes_at_stop: s3 (index 3) must appear with exactly one pattern entry.
        let map = idx.derived_routes_at_stop();
        let s3_pairs = map
            .iter()
            .find(|(s, _)| *s == 3)
            .map(|(_, p)| p.clone())
            .unwrap_or_default();
        assert_eq!(
            s3_pairs.len(),
            1,
            "s3 served by exactly one pattern (branch)"
        );
        // That pattern's reader_route_idx is 0 (single GTFS route).
        assert_eq!(
            s3_pairs[0].1, 0u32,
            "branch pattern's reader_route_idx is 0"
        );
    }

    /// `disjoint-dirs.ptb` — one route, two trips with zero shared stops. The band
    /// stores two patterns, and under Unbounded derived_routes_at_stop shows each
    /// stop in exactly one pattern.
    #[test]
    fn disjoint_dirs_roundtrips() {
        use pt_core::engine::patterns::PatternMode;
        let r = Reader::from_bytes(disjoint_dirs()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (6, 1, 2));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        // Band: OUTBOUND and INBOUND are separate patterns with one trip each,
        // and every stop is on exactly one of them.
        assert_eq!(r.patterns().expect("band patterns").len(), 2);
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1, 2]); // OUTBOUND
        assert_eq!(r.pattern_stops(1).unwrap(), &[3u32, 4, 5]); // INBOUND
        assert_eq!(r.pattern_trips(0).unwrap(), &[0u32]);
        assert_eq!(r.pattern_trips(1).unwrap(), &[1u32]);
        for s in 0..3usize {
            assert_eq!(r.patterns_at_stop(s).unwrap(), &[0u32]);
            assert_eq!(r.patterns_at_stop(s + 3).unwrap(), &[1u32]);
        }
        assert_eq!(r.band_dep_secs(0, 0, 0), Some(25_200)); // T0 departs s0
        assert_eq!(r.band_dep_secs(0, 0, 2), Some(25_800)); // T0 at s2
        assert_eq!(r.band_dep_secs(1, 0, 0), Some(28_800)); // T1 departs s3
        assert_eq!(r.band_dep_secs(1, 0, 2), Some(29_400)); // T1 at s5
                                                            // Under Unbounded: two patterns, no shared stops.
        let idx = pt_core::engine::index::Index::build(&r, PatternMode::Unbounded).unwrap();
        assert_eq!(
            idx.num_pattern_routes(),
            2,
            "two patterns for disjoint topology"
        );
        let map = idx.derived_routes_at_stop();
        // Collect the pattern index for each stop; each stop appears in exactly one pattern.
        for (_, pairs) in &map {
            assert_eq!(pairs.len(), 1, "each stop served by exactly one pattern");
        }
        // The two patterns must cover disjoint stop sets: collect all stops per pattern.
        let p0_stops: std::collections::HashSet<u32> = map
            .iter()
            .filter(|(_, pairs)| pairs[0].0 == 0)
            .map(|(s, _)| *s)
            .collect();
        let p1_stops: std::collections::HashSet<u32> = map
            .iter()
            .filter(|(_, pairs)| pairs[0].0 == 1)
            .map(|(s, _)| *s)
            .collect();
        assert!(
            p0_stops.is_disjoint(&p1_stops),
            "two patterns have 0 shared stops"
        );
    }

    /// `converging-multipattern.ptb` — two GTFS routes; route 0 has two distinct
    /// trip signatures. The band stores three patterns, and under Unbounded route
    /// 0 emits two of them.
    #[test]
    fn converging_multipattern_roundtrips() {
        use pt_core::engine::patterns::PatternMode;
        let r = Reader::from_bytes(converging_multipattern()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (6, 2, 3));
        assert_eq!(r.route_id(0).unwrap(), "R0");
        assert_eq!(r.route_id(1).unwrap(), "R1");
        for t in 0..3usize {
            assert_eq!(r.trip(t).unwrap().trip_id, format!("T{t}"));
        }
        // Band: R0's two branches and R1's converging trip, one trip each.
        assert_eq!(r.patterns().expect("band patterns").len(), 3);
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1, 4]); // R0/T0
        assert_eq!(r.pattern_stops(1).unwrap(), &[0u32, 2, 4]); // R0/T1
        assert_eq!(r.pattern_stops(2).unwrap(), &[3u32, 4, 5]); // R1/T2
        for p in 0..3usize {
            assert_eq!(r.pattern_trips(p).unwrap(), &[p as u32]);
        }
        assert_eq!(r.patterns_at_stop(1).unwrap(), &[0u32]); // s1 only R0/T0
        assert_eq!(r.patterns_at_stop(2).unwrap(), &[1u32]); // s2 only R0/T1
        assert_eq!(r.patterns_at_stop(4).unwrap(), &[0u32, 1, 2]); // s4 both routes
        assert_eq!(r.band_dep_secs(0, 0, 2), Some(25_800)); // T0 at s4
        assert_eq!(r.band_dep_secs(2, 0, 1), Some(25_800)); // T2 at s4, same time
                                                            // Under Unbounded: R0 produces 2 patterns, R1 produces 1 → 3 total.
        let idx = pt_core::engine::index::Index::build(&r, PatternMode::Unbounded).unwrap();
        assert_eq!(
            idx.num_pattern_routes(),
            3,
            "route 0 emits 2 patterns + route 1 emits 1 = 3 total"
        );
        // s1 and s2 are each in exactly one pattern (the two branches of R0).
        let map = idx.derived_routes_at_stop();
        let s1_pairs = map
            .iter()
            .find(|(s, _)| *s == 1)
            .map(|(_, p)| p.clone())
            .unwrap_or_default();
        let s2_pairs = map
            .iter()
            .find(|(s, _)| *s == 2)
            .map(|(_, p)| p.clone())
            .unwrap_or_default();
        assert_eq!(s1_pairs.len(), 1, "s1 served by exactly one pattern");
        assert_eq!(s2_pairs.len(), 1, "s2 served by exactly one pattern");
        // Both s1 and s2 patterns come from GTFS route 0 (reader_route_idx 0).
        assert_eq!(s1_pairs[0].1, 0u32, "s1 pattern reader_route_idx = 0");
        assert_eq!(s2_pairs[0].1, 0u32, "s2 pattern reader_route_idx = 0");
        // s1 and s2 are served by DIFFERENT patterns (the two distinct branch patterns).
        assert_ne!(
            s1_pairs[0].0, s2_pairs[0].0,
            "s1 and s2 in distinct patterns"
        );
        // s4 is the convergence: both GTFS routes serve it.
        let mut s4_routes: Vec<u32> = map
            .iter()
            .find(|(s, _)| *s == 4)
            .map(|(_, p)| p.iter().map(|&(_, rr)| rr).collect())
            .unwrap_or_default();
        s4_routes.sort_unstable();
        s4_routes.dedup();
        assert_eq!(s4_routes, vec![0, 1], "s4 is the R0+R1 convergence");
    }

    /// `pickup-equivalence.ptb` — one route, two trips; s3 (only in trip 1) is
    /// unroutable under Off but routable under Unbounded.
    #[test]
    fn pickup_equivalence_roundtrips() {
        use pt_core::engine::patterns::PatternMode;
        let r = Reader::from_bytes(pickup_equivalence()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (4, 1, 2));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        // Band: s2 ends pattern 0 (T0) and is the middle of pattern 1 (T1).
        assert_eq!(r.patterns().expect("band patterns").len(), 2);
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1, 2]); // T0
        assert_eq!(r.pattern_stops(1).unwrap(), &[0u32, 2, 3]); // T1
        assert_eq!(r.pattern_trips(0).unwrap(), &[0u32]);
        assert_eq!(r.pattern_trips(1).unwrap(), &[1u32]);
        assert_eq!(r.patterns_at_stop(2).unwrap(), &[0u32, 1]);
        assert_eq!(r.patterns_at_stop(3).unwrap(), &[1u32]);
        assert_eq!(r.band_dep_secs(0, 0, 2), Some(25_800)); // T0 ends at s2
        assert_eq!(r.band_dep_secs(1, 0, 1), Some(29_100)); // T1 at s2
        assert_eq!(r.band_dep_secs(1, 0, 2), Some(29_400)); // T1 at s3
                                                            // Under Unbounded: two patterns; s3 appears in exactly one pattern.
        let idx = pt_core::engine::index::Index::build(&r, PatternMode::Unbounded).unwrap();
        assert_eq!(
            idx.num_pattern_routes(),
            2,
            "two patterns for pickup-equivalence"
        );
        let map = idx.derived_routes_at_stop();
        let s3_pairs = map
            .iter()
            .find(|(s, _)| *s == 3)
            .map(|(_, p)| p.clone())
            .unwrap_or_default();
        assert_eq!(s3_pairs.len(), 1, "s3 routable via exactly one pattern");
    }

    /// `lasso-multipattern.ptb` — one route, two trips with different repeated-stem
    /// lasso signatures; per-trip cursor must preserve repeats in both trips.
    #[test]
    fn lasso_multipattern_roundtrips() {
        use pt_core::engine::patterns::PatternMode;
        let r = Reader::from_bytes(lasso_multipattern()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (5, 1, 2));
        assert_eq!(r.route_id(0).unwrap(), "R");
        assert_eq!(r.trip(0).unwrap().trip_id, "T0");
        assert_eq!(r.trip(1).unwrap().trip_id, "T1");
        // Both band patterns keep the repeated s1 (index 1).
        assert_eq!(r.patterns().expect("band patterns").len(), 2);
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1, 2, 1, 3]); // T0, apex s2
        assert_eq!(r.pattern_stops(1).unwrap(), &[0u32, 1, 4, 1, 3]); // T1, apex s4
        assert_eq!(r.pattern_trips(0).unwrap(), &[0u32]);
        assert_eq!(r.pattern_trips(1).unwrap(), &[1u32]);
        assert_eq!(r.patterns_at_stop(2).unwrap(), &[0u32]);
        assert_eq!(r.patterns_at_stop(4).unwrap(), &[1u32]);
        assert_eq!(r.band_dep_secs(0, 0, 1), Some(25_500)); // T0 first s1 visit
        assert_eq!(r.band_dep_secs(0, 0, 3), Some(26_100)); // T0 second s1 visit
        assert_eq!(r.band_dep_secs(1, 0, 2), Some(29_400)); // T1 at apex s4
        assert_eq!(r.band_dep_secs(1, 0, 4), Some(30_000)); // T1 at s3
                                                            // Under Unbounded: two distinct patterns (different apexes s2 vs s4).
        let idx = pt_core::engine::index::Index::build(&r, PatternMode::Unbounded).unwrap();
        assert_eq!(
            idx.num_pattern_routes(),
            2,
            "two patterns (distinct apex s2 vs s4)"
        );
        // s2 appears in exactly one pattern; s4 appears in exactly one pattern;
        // they must be DIFFERENT patterns (the two distinct apexes).
        let map = idx.derived_routes_at_stop();
        let s2_pairs = map
            .iter()
            .find(|(s, _)| *s == 2)
            .map(|(_, p)| p.clone())
            .unwrap_or_default();
        let s4_pairs = map
            .iter()
            .find(|(s, _)| *s == 4)
            .map(|(_, p)| p.clone())
            .unwrap_or_default();
        assert_eq!(s2_pairs.len(), 1, "apex s2 in exactly one pattern");
        assert_eq!(s4_pairs.len(), 1, "apex s4 in exactly one pattern");
        assert_ne!(
            s2_pairs[0].0, s4_pairs[0].0,
            "s2 and s4 in DIFFERENT patterns"
        );
    }

    /// `covering-merge.ptb` — one route, six trips. Under `CoveringMerge` the two
    /// short trips fold into their covering patterns (`-1` holes), transitive
    /// offsets compose, and the reverse trip stays a separate pattern. The
    /// `-1`-hole / composed-offset internals are asserted in pt-core's
    /// `index.rs::covering_merge_fixture_holes_and_reverse_separate` (which can see
    /// the crate-private route internals); here we assert via the PUBLIC API that
    /// exactly 3 patterns survive and the union covers every served stop.
    #[test]
    fn covering_merge_roundtrips() {
        use pt_core::engine::patterns::PatternMode;
        let r = Reader::from_bytes(covering_merge()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert_carry_less_band(&r);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (10, 1, 6));
        assert_eq!(r.route_id(0).unwrap(), "R0");
        for t in 0..6usize {
            assert_eq!(r.trip(t).unwrap().trip_id, format!("T{t}"));
        }
        // The band stores one pattern per trip; the fold happens in Index::build.
        assert_eq!(r.patterns().expect("band patterns").len(), 6);
        let want: [&[u32]; 6] = [
            &[1, 2, 3],
            &[0, 1, 2, 3, 4],
            &[4, 3, 2, 1, 0],
            &[7, 8],
            &[6, 7, 8],
            &[5, 6, 7, 8, 9],
        ];
        for (p, stops) in want.iter().enumerate() {
            assert_eq!(r.pattern_stops(p).unwrap(), *stops);
            assert_eq!(r.pattern_trips(p).unwrap(), &[p as u32]);
        }
        assert_eq!(r.band_dep_secs(0, 0, 0), Some(1_000)); // T0 at s1
        assert_eq!(r.band_dep_secs(1, 0, 4), Some(3_200)); // T1 at s4
        assert_eq!(r.band_dep_secs(2, 0, 0), Some(5_000)); // T2 at s4
        assert_eq!(r.band_dep_secs(3, 0, 1), Some(1_300)); // T3 at s8
        assert_eq!(r.band_dep_secs(5, 0, 4), Some(3_700)); // T5 at s9

        // Under CoveringMerge: 3 surviving patterns (fold-long, reverse, transitive-long).
        let idx = pt_core::engine::index::Index::build(&r, PatternMode::CoveringMerge).unwrap();
        assert_eq!(
            idx.num_pattern_routes(),
            3,
            "fold-long + reverse + transitive-long survive"
        );

        // Every served stop (s0..s9) is covered by at least one surviving pattern
        // (the union / covering invariant — folded short trips ride their covering
        // pattern, so no served stop is dropped by the fold).
        let map = idx.derived_routes_at_stop();
        let covered: Vec<u32> = map.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            covered,
            (0u32..10).collect::<Vec<_>>(),
            "every served stop s0..s9 covered after the fold"
        );
    }

    //
    // B1.5 strips the flat carry (`0xF4 StopTimes` / `0xF5 TripStarts` / `0xF6 Csr`
    // / `0xFA StopTimeBoarding`) from the current-layout fixtures AFTER the band is
    // derived, so the band is the SOLE timetable. These are TEARDOWN-COMPLETENESS asserts:
    //   (a) header version 1 + the band IS present (`pattern_band_present`);
    //   (b) the four carry regions are ABSENT (`region_by_id(0xF4..).is_none()`) —
    //       the proof the strip actually fired and nothing re-emitted them;
    //   (c) the band regions `0x10/0x11/0x13/0x14/0x45/0x46` are present + non-empty
    //       (NOT `0x12 PatternSemantics` — the cohort is all-regular `boarding=&[]`,
    //       so that region is legitimately OMITTED by the all-regular rule); and
    //   (d) the per-fixture topology (branch split, lasso repeats, two-route
    //       convergence, covering-merge fold) is reconstructed from the BAND
    //       accessors (`patterns`, `pattern_stops`, `pattern_trips`,
    //       `trip_pattern_idx`) + `Index::build` — NOT the now-absent carry
    //       (`trip_starts`/`stop_time`/`stop_routes`/`trip`).
    // A structurally-wrong band — or a carry that survived the strip — fails HERE
    // before the engine-regression gate runs the carry-less bytes under
    // Unbounded/CoveringMerge.

    /// Assert the four flat-carry regions are ABSENT and the six band regions are
    /// present + non-empty (`0x12 PatternSemantics` is NOT asserted — the cohort is
    /// all-regular, so it is legitimately omitted). Mirrors the CI region scan in
    /// `.github/workflows/ptb-fixture-parity.yml`.
    fn assert_carry_less_band(r: &Reader<Vec<u8>>) {
        // Flat carry stripped (B1.5 teardown).
        for id in [0xF4u16, 0xF5, 0xF6, 0xFA] {
            assert!(
                r.header().region_by_id(id).is_none(),
                "carry region {id:#x} must be ABSENT in a carry-less current-v1 bundle"
            );
        }
        // Band regions present + non-empty (NOT 0x12 — all-regular cohort omits it).
        for id in [0x10u16, 0x11, 0x13, 0x14, 0x45, 0x46] {
            let e = r
                .header()
                .region_by_id(id)
                .unwrap_or_else(|| panic!("band region {id:#x} must be present"));
            assert!(e.length > 0, "band region {id:#x} must be non-empty");
        }
    }

    /// The TypeScript reader fixtures decode as current-v1 carry-less bands with
    /// the ids and holes the TypeScript tests rely on.
    #[test]
    fn typescript_reader_fixtures_roundtrip() {
        let loop_ = Reader::from_bytes(covering_loop()).unwrap();
        assert_eq!(loop_.header().version, 1);
        assert_carry_less_band(&loop_);
        assert_eq!(loop_.route_id(0).unwrap(), "RL");
        assert_eq!(loop_.trip(0).unwrap().trip_id, "TC");
        assert_eq!(loop_.trip(1).unwrap().trip_id, "TF");
        assert_eq!(loop_.pattern_stops(0).unwrap(), &[0u32, 1, 2, 1, 3]);
        assert_eq!(loop_.pattern_stops(1).unwrap(), &[2u32, 1, 3]);

        let lasso = Reader::from_bytes(lasso_unserved_occurrence()).unwrap();
        assert_eq!(lasso.header().version, 1);
        assert_carry_less_band(&lasso);
        assert_eq!(
            lasso.pattern_stops(0).unwrap(),
            &[0u32, 1, 2, 3, 4, 2, 1, 0]
        );
        assert_eq!(lasso.band_dep_secs(0, 0, 0), Some(0));
        assert_eq!(
            lasso.band_dep_secs(0, 0, 1),
            Some(pt_core::reader::BAND_NOT_SERVED)
        );
        assert_eq!(lasso.band_dep_secs(0, 0, 6), Some(360));

        let ids = Reader::from_bytes(shared_prefix_ids()).unwrap();
        assert_eq!(ids.header().version, 1);
        assert_carry_less_band(&ids);
        assert_eq!(
            (ids.num_stops(), ids.num_routes(), ids.num_trips()),
            (2, 50, 300)
        );
        assert_eq!(ids.route_id(49).unwrap(), "vilnius_0049");
        assert_eq!(ids.trip(299).unwrap().trip_id, "A1-01-1-2512-00299");
        assert_eq!(ids.trip(299).unwrap().route_idx, 49);

        let same = Reader::from_bytes(same_pattern_trips()).unwrap();
        assert_eq!(same.header().version, 1);
        assert_carry_less_band(&same);
        assert_eq!(same.patterns().expect("band patterns").len(), 1);
        assert_eq!(same.pattern_trips(0).unwrap(), &[0u32, 1]);
        assert_eq!(same.trip(1).unwrap().trip_id, "TB");
    }

    /// `overnight-i32` forces the REGION-LEVEL i32-delta `0x13` variant: the
    /// single trip's span (36000→91800 = 55800s) exceeds the i16 ±32767 s cap, so
    /// the `0x13` entryFlags MUST declare bit1 (`TRIP_TIMES_FLAG_I32_DELTAS`), the
    /// fixture stays carry-less, and the band still round-trips the overnight
    /// departure EXACTLY via the wide deltas (`band_dep_secs`). A missing bit1
    /// (wrong stride) would fail the load-time exact-length gate; a truncated
    /// delta would mis-read 91800 — both caught HERE before the gate sees it.
    #[test]
    fn overnight_i32_forces_i32_deltas_and_roundtrips() {
        use pt_core::engine::patterns::PatternMode;
        let r = Reader::from_bytes(overnight_i32()).unwrap();
        assert_eq!(r.header().version, 1, "v1 header");
        assert!(r.pattern_band_present(), "band present");
        assert_carry_less_band(&r);
        assert_eq!(
            r.trip_times_is_i32_deltas(),
            Some(true),
            "0x13 entryFlags bit1 (i32 deltas) set"
        );
        assert_eq!(r.trip_times_is_ragged(), Some(false), "ragged bit0 clear");
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 1, 1));
        // Single pattern [s0,s1,s2], one trip. The band's wide delta reconstructs
        // the overnight departure: trip 0, pos 2 → first_dep 36000 + 55800 = 91800.
        let patterns = r.patterns().expect("band patterns");
        assert_eq!(patterns.len(), 1, "single pattern");
        assert_eq!(r.pattern_stops(0).unwrap(), &[0u32, 1, 2]);
        assert_eq!(r.pattern_trips(0).unwrap().len(), 1);
        assert_eq!(
            r.band_dep_secs(0, 0, 2),
            Some(91_800),
            "pos 2 overnight dep round-trips via the i32 delta"
        );
        assert_eq!(r.band_dep_secs(0, 0, 0), Some(36_000), "pos 0 first dep");
        assert_eq!(r.band_dep_secs(0, 0, 1), Some(64_800), "pos 1 mid dep");
        // NONZERO wide-stride DWELL: arr = dep + arr_diff. Pins the exact arr so an
        // i16 mis-stride of the dwell column (reading at *2 while dep reads at *4)
        // mis-reads it. dwell -300 @ pos 2 (the >9.1h position), -180 @ pos 1.
        assert_eq!(
            r.band_arr_secs(0, 0, 2),
            Some(91_500), // 91800 - 300
            "pos 2 arr round-trips to 91500 via the i32 dwell delta"
        );
        assert_eq!(
            r.band_arr_secs(0, 0, 1),
            Some(64_620), // 64800 - 180
            "pos 1 arr round-trips to 64620 via the i32 dwell delta"
        );
        assert_eq!(
            r.band_arr_secs(0, 0, 0),
            Some(36_000), // zero dwell ⇒ arr == dep
            "pos 0 arr == dep (zero dwell)"
        );
        // The band builds end-to-end (the i32 path is exercised, not stubbed).
        let idx = pt_core::engine::index::Index::build(&r, PatternMode::Unbounded).unwrap();
        assert_eq!(idx.num_pattern_routes(), 1, "single pattern [s0,s1,s2]");
    }

    /// A1 boarding fixtures: each is a current-v1 carry-less band whose `0x12`
    /// bytes preserve the temporary flat boarding column's low-nibble semantics.
    #[test]
    fn boarding_fixtures_roundtrip_pattern_semantics() {
        let mixed = Reader::from_bytes(mixed_boarding()).unwrap();
        assert_eq!(mixed.patterns().unwrap().len(), 3);
        assert!(!mixed.has_boarding(), "flat carry is stripped");
        assert_eq!(mixed.band_pickup_forbidden(0, 1), Some(true));
        assert_eq!(mixed.band_pickup_forbidden(1, 1), Some(false));
        assert_eq!(mixed.band_drop_off_forbidden(2, 1), Some(true));

        // board-forbid: s1 (pattern 0, pos 1) pickup_type==1.
        let r = Reader::from_bytes(board_forbid()).unwrap();
        assert_eq!(r.header().version, 1);
        assert!(r.pattern_band_present());
        assert!(r.has_pattern_semantics());
        assert!(!r.has_boarding(), "flat 0xFA carry is stripped");
        assert_eq!(r.num_stop_times(), 3);
        assert_eq!(r.band_semantics_byte(0, 1), Some(0x01));
        assert_eq!(r.band_pickup_forbidden(0, 1), Some(true));
        assert_eq!(r.band_drop_off_forbidden(0, 1), Some(false));

        // alight-forbid: s1 (pattern 0, pos 1) drop_off_type==1.
        let r = Reader::from_bytes(alight_forbid()).unwrap();
        assert_eq!(r.header().version, 1);
        assert_eq!(r.band_semantics_byte(0, 1), Some(0x04));
        assert_eq!(r.band_drop_off_forbidden(0, 1), Some(true));
        assert_eq!(r.band_pickup_forbidden(0, 1), Some(false));

        // pickup-two-three-ok: pickup_type==2 survives byte-exactly but remains
        // boardable because only type 1 forbids pickup.
        let r = Reader::from_bytes(pickup_two_three_ok()).unwrap();
        assert_eq!(r.header().version, 1);
        assert_eq!(r.band_semantics_byte(0, 1), Some(0x02));
        assert_eq!(r.band_pickup_forbidden(0, 1), Some(false));

        // covering-merge-boarding: short pattern T0's first position is
        // forbidden; the long pattern's s1 stays regular.
        let r = Reader::from_bytes(covering_merge_boarding()).unwrap();
        assert_eq!(r.header().version, 1);
        assert_eq!(r.num_stop_times(), 23);
        assert_eq!(r.band_pickup_forbidden(0, 0), Some(true));
        assert_eq!(r.band_pickup_forbidden(1, 1), Some(false));

        // lasso-boarding: outbound s1 (pos 1) forbidden; return s1 (pos 6)
        // remains boardable, proving semantics are per occurrence.
        let r = Reader::from_bytes(lasso_boarding()).unwrap();
        assert_eq!(r.header().version, 1);
        assert_eq!(r.num_stop_times(), 8);
        assert_eq!(r.band_pickup_forbidden(0, 1), Some(true));
        assert_eq!(r.band_pickup_forbidden(0, 6), Some(false));
    }

    /// BYTE-LINK GUARD.
    ///
    /// The engine-regression gate (`crates/pt-core/tests/raptor_behavior.rs`) feeds
    /// the engine and its wasm binding the COMMITTED `.ptb` bytes under
    /// `packages/frontend/tests/services/__fixtures__/` — the artifact written by
    /// `pt-core-emit gen-fixtures`. If a builder here changes but the committed
    /// bytes are not regenerated, the gate silently keeps testing the old topology.
    ///
    /// This test pins each multi-trip fixture builder's in-memory output to the
    /// committed `.ptb` on disk, byte-for-byte. pt-core's covering-merge fold unit
    /// test (`index.rs::covering_merge_fixture_holes_and_reverse_separate`) reads
    /// the same committed `covering-merge.ptb` directly, so it cannot drift from
    /// this writer. Regenerate with
    /// `cargo build -p pt-core-emit --release && \
    ///  ./target/release/pt-core-emit gen-fixtures packages/frontend/tests/services/__fixtures__`.
    #[test]
    fn gen_fixtures_multitrip_builders_match_committed_ptb() {
        // CARGO_MANIFEST_DIR = <repo>/crates/pt-core-emit → ../../ is the repo root.
        let dir = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/frontend/tests/services/__fixtures__/"
        );
        // The multi-trip-per-route fixtures: covering-merge (the transitive fold)
        // and the four Phase-3A multi-pattern topologies.
        let cases: &[(&str, Vec<u8>)] = &[
            ("covering-merge.ptb", covering_merge()),
            ("branch-pattern.ptb", branch_pattern()),
            ("disjoint-dirs.ptb", disjoint_dirs()),
            ("converging-multipattern.ptb", converging_multipattern()),
            ("lasso-multipattern.ptb", lasso_multipattern()),
        ];
        for (name, built) in cases {
            let path = format!("{dir}{name}");
            let committed = std::fs::read(&path)
                .unwrap_or_else(|e| panic!("read committed fixture {path}: {e}"));
            assert_eq!(
                built.len(),
                committed.len(),
                "{name}: gen_fixtures builder length != committed .ptb length \
                 (stale committed bytes — regenerate with `pt-core-emit gen-fixtures`)"
            );
            assert!(
                *built == committed,
                "{name}: gen_fixtures builder output diverges from the committed .ptb \
                 (the writer changed but the committed bytes were not regenerated, OR \
                 the bytes were edited out-of-band — regenerate with \
                 `pt-core-emit gen-fixtures`)"
            );
        }
    }

    /// Cross-language decoder self-test (A5): build the `frequencies-parity.ptb` bytes,
    /// decode them through `pt_core::Reader::frequencies_for_trip`, and assert the
    /// 3 known rows exactly. The TS side of this parity assertion lives in
    /// `assert-ptb-cross-parity.ts::assertFrequenciesParity`.
    #[test]
    fn frequencies_parity_fixture_round_trip() {
        let bytes = super::build_frequencies_parity_ptb().expect("build_frequencies_parity_ptb");
        let r = pt_core::Reader::from_bytes(bytes).expect("Reader::from_bytes");
        assert_eq!(
            r.header().version,
            pt_core::PTB_VERSION_V1,
            "current PTB v1"
        );
        assert!(r.has_frequencies(), "has_frequencies must be true");

        // Trip 0: 2 rows
        let rows0: Vec<_> = r.frequencies_for_trip(0).collect();
        assert_eq!(rows0.len(), 2, "trip 0 must have 2 frequency rows");
        assert_eq!(rows0[0].trip_idx, 0);
        assert_eq!(rows0[0].start_secs, 21600);
        assert_eq!(rows0[0].end_secs, 86400);
        assert_eq!(rows0[0].headway_secs, 600);
        assert_eq!(rows0[0].exact_times, 0);
        assert_eq!(rows0[1].trip_idx, 0);
        assert_eq!(rows0[1].start_secs, 86400);
        assert_eq!(rows0[1].end_secs, 108000);
        assert_eq!(rows0[1].headway_secs, 1800);
        assert_eq!(rows0[1].exact_times, 1);

        // Trip 1: 1 row
        let rows1: Vec<_> = r.frequencies_for_trip(1).collect();
        assert_eq!(rows1.len(), 1, "trip 1 must have 1 frequency row");
        assert_eq!(rows1[0].trip_idx, 1);
        assert_eq!(rows1[0].start_secs, 36000);
        assert_eq!(rows1[0].end_secs, 72000);
        assert_eq!(rows1[0].headway_secs, 900);
        assert_eq!(rows1[0].exact_times, 0);
    }

    #[test]
    fn frequency_exact0_fixture_round_trip() {
        let bytes = super::build_frequency_exact0_ptb().expect("build_frequency_exact0_ptb");
        let r = pt_core::Reader::from_bytes(bytes).expect("Reader::from_bytes");
        assert_eq!(
            r.header().version,
            pt_core::PTB_VERSION_V1,
            "current PTB v1"
        );
        assert!(r.has_frequencies(), "has_frequencies must be true");

        let rows0: Vec<_> = r.frequencies_for_trip(0).collect();
        assert!(rows0.is_empty(), "trip 0 must have no frequency rows");

        let rows1: Vec<_> = r.frequencies_for_trip(1).collect();
        assert_eq!(rows1.len(), 1, "trip 1 must have one frequency row");
        assert_eq!(rows1[0].trip_idx, 1);
        assert_eq!(rows1[0].start_secs, 28800);
        assert_eq!(rows1[0].end_secs, 30600);
        assert_eq!(rows1[0].headway_secs, 600);
        assert_eq!(rows1[0].exact_times, 0);
    }

    /// Cross-language decoder parity over the COMMITTED bytes (A5): read the shipped
    /// `frequencies-parity.ptb` from disk through the Phase-2 reader and assert
    /// the same 3 `0x17` rows. Unlike `frequencies_parity_fixture_round_trip`
    /// (in-memory only — a hand-edit of the committed file stays green there),
    /// this pins the Rust decode against the file the TS
    /// `assert-ptb-cross-parity.ts::assertFrequenciesParity` ALSO reads, so both
    /// readers decode the SAME committed bytes. The CI regen-guard in
    /// `ptb-fixture-parity.yml` keeps that committed file == the builder output.
    #[test]
    fn committed_frequencies_parity_reads_back() {
        // CARGO_MANIFEST_DIR = <repo>/crates/pt-core-emit → ../../ is the repo root.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared/src/ptb/__fixtures__/frequencies-parity.ptb"
        );
        let bytes = std::fs::read(path)
            .unwrap_or_else(|e| panic!("read committed frequencies-parity.ptb: {e}"));
        let r = pt_core::Reader::from_bytes(bytes).expect("decode frequencies-parity.ptb");
        assert_eq!(
            r.header().version,
            pt_core::PTB_VERSION_V1,
            "current PTB v1"
        );
        assert!(r.has_frequencies(), "committed fixture must carry 0x17");

        // Trip 0: 2 rows
        let rows0: Vec<_> = r.frequencies_for_trip(0).collect();
        assert_eq!(rows0.len(), 2, "trip 0 must have 2 frequency rows");
        assert_eq!(rows0[0].trip_idx, 0);
        assert_eq!(rows0[0].start_secs, 21600);
        assert_eq!(rows0[0].end_secs, 86400);
        assert_eq!(rows0[0].headway_secs, 600);
        assert_eq!(rows0[0].exact_times, 0);
        assert_eq!(rows0[1].trip_idx, 0);
        assert_eq!(rows0[1].start_secs, 86400);
        assert_eq!(rows0[1].end_secs, 108000);
        assert_eq!(rows0[1].headway_secs, 1800);
        assert_eq!(rows0[1].exact_times, 1);

        // Trip 1: 1 row
        let rows1: Vec<_> = r.frequencies_for_trip(1).collect();
        assert_eq!(rows1.len(), 1, "trip 1 must have 1 frequency row");
        assert_eq!(rows1[0].trip_idx, 1);
        assert_eq!(rows1[0].start_secs, 36000);
        assert_eq!(rows1[0].end_secs, 72000);
        assert_eq!(rows1[0].headway_secs, 900);
        assert_eq!(rows1[0].exact_times, 0);
    }
}
