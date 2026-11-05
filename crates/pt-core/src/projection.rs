//! Canonical projection (serde-free, hand-rolled JSON) for the cross-language
//! parity gate. ONE contract, both sides diff against it: the Rust `project()`
//! writes the canonical JSON, we commit it as `tests/tiny.projection.json`, the
//! Rust integration test asserts `project(tiny) == golden`, and the TS
//! `assert-ptb-cross-parity.ts` asserts its `loadPtb`-derived projection equals
//! the SAME golden file.
//!
//! The string is built BY HAND (not serde) with a fixed field order and fixed
//! key order so the TS side can reproduce it byte-for-byte. Coords are the
//! canonical integer `latE7`/`lonE7` columns (exact, so float text-formatting
//! can never cause a spurious diff).

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use crate::reader::Reader;

/// Pinned projection dates, anchored at `feedStartDate = 20260501`. These are
/// projection constants so the Rust example and the golden file agree without a
/// CLI arg:
///
/// - day 0  (`20260501`) — byte 0, bit 0
/// - day 13 (`20260514`) — byte 1, bit 5 (exercises the `day/8` byte index)
/// - day 80 (`20260720`) — byte 10, bit 0 (exercises a HIGH bitmask byte; the
///   90-day window is 12 bytes, so byte 10 lives well past bytes 0–1)
pub const PINNED_DATES: [u32; 3] = [20260501, 20260514, 20260720];

/// JSON-escape a string (the subset that can appear in GTFS ids/names: quote,
/// backslash, control chars). Mirrors the escaping JSON.stringify applies.
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[inline]
fn jstr(s: &str) -> String {
    format!("\"{}\"", esc(s))
}

/// A comma-joined array of pre-rendered JSON fragments: `[a,b,c]`.
fn arr(items: &[String]) -> String {
    let mut out = String::from("[");
    for (i, it) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(it);
    }
    out.push(']');
    out
}

fn u32_arr(vals: &[u32]) -> String {
    let items: Vec<String> = vals.iter().map(|v| format!("{}", v)).collect();
    arr(&items)
}

/// Build the canonical projection JSON for a decoded bundle. Fixed field order,
/// fixed key order. No trailing newline (the golden is stored trimmed).
///
/// **Contract:** call only on a `Reader` produced by `Reader::from_bytes` (i.e.
/// already fully validated). It iterates `0..num_*` over accessors that are
/// in-range by construction and `expect()`s them — a panic here means the
/// reader's own invariants were violated, not bad input. This is the parity
/// example/test surface, not a hot path; it is intentionally not `Result`.
pub fn project<B: AsRef<[u8]> + Send + Sync + 'static>(r: &Reader<B>) -> String {
    // Rough pre-size: header scalars + ~80 B/record across the four record kinds
    // + CSR/tripStarts. Avoids a handful of String reallocs on the larger feeds;
    // an over/under-estimate is harmless (just affects realloc count).
    let est = 256
        + r.num_stops() * 96
        + r.num_routes() * 128
        + r.num_trips() * 96
        + r.num_stop_times() * 48
        + (r.num_routes() + r.num_stops() + r.num_trips()) * 8;
    let mut out = String::with_capacity(est);
    out.push('{');

    // Header-level scalars.
    out.push_str(&format!("\"version\":{},", r.header().version));
    out.push_str(&format!("\"feedStartDate\":{},", r.feed_start_date()));
    // cityTzOffsetSeconds in the projection so the cross-language parity gate
    // cross-checks the Rust↔TS decode of the header field (not just `version`).
    out.push_str(&format!(
        "\"cityTzOffsetSeconds\":{},",
        r.header().city_tz_offset_seconds
    ));
    out.push_str(&format!("\"numServices\":{},", r.num_services()));
    out.push_str(&format!("\"numStops\":{},", r.num_stops()));
    out.push_str(&format!("\"numRoutes\":{},", r.num_routes()));
    out.push_str(&format!("\"numTrips\":{},", r.num_trips()));
    out.push_str(&format!("\"numStopTimes\":{},", r.num_stop_times()));

    // Stops: the canonical integer `latE7`/`lonE7` columns. Id/name are
    // borrowed straight from the pool (no full `stop(i)` decode, whose f32
    // `Stop::stop_lat` is lossy).
    let mut stops: Vec<String> = Vec::with_capacity(r.num_stops());
    for i in 0..r.num_stops() {
        let stop_id = r.stop_id(i).expect("stop_id in range");
        let wheelchair = r.stop_wheelchair_boarding(i).expect("wheelchair in range");
        let stop_name = r.stop_name(i).expect("stop_name in range");
        stops.push(format!(
            "{{\"stopId\":{},\"stopName\":{},\"latE7\":{},\"lonE7\":{},\"wheelchairBoarding\":{}}}",
            jstr(stop_id),
            jstr(stop_name),
            r.stop_lat_e7(i).expect("lat_e7 in range"),
            r.stop_lon_e7(i).expect("lon_e7 in range"),
            wheelchair,
        ));
    }
    out.push_str(&format!("\"stops\":{},", arr(&stops)));

    // Routes.
    let mut routes: Vec<String> = Vec::with_capacity(r.num_routes());
    for i in 0..r.num_routes() {
        let rt = r.route(i).expect("route in range");
        routes.push(format!(
            "{{\"routeId\":{},\"agencyId\":{},\"shortName\":{},\"longName\":{},\"routeType\":{},\"routeColor\":{},\"routeTextColor\":{}}}",
            jstr(&rt.route_id), jstr(&rt.agency_id), jstr(&rt.short_name), jstr(&rt.long_name),
            rt.route_type, jstr(&rt.route_color), jstr(&rt.route_text_color),
        ));
    }
    out.push_str(&format!("\"routes\":{},", arr(&routes)));

    // Trips.
    let mut trips: Vec<String> = Vec::with_capacity(r.num_trips());
    for i in 0..r.num_trips() {
        let t = r.trip(i).expect("trip in range");
        trips.push(format!(
            "{{\"tripId\":{},\"headsign\":{},\"routeIdx\":{},\"serviceIdx\":{},\"wheelchairAccessible\":{},\"directionId\":{},\"shapeId\":{}}}",
            jstr(&t.trip_id), jstr(&t.headsign), t.route_idx, t.service_idx,
            t.wheelchair_accessible, t.direction_id, jstr(&t.shape_id),
        ));
    }
    out.push_str(&format!("\"trips\":{},", arr(&trips)));

    // StopTimes (incl. the riskiest stopIdx@6 field).
    //
    // CARRY-LESS (B1.5-T4a): the flat `0xF4 StopTimes` carry is stripped, so
    // `stop_time(i)` would OOB-read its zero-length slot. The band is the SOLE
    // timetable; reconstruct the flat rows from it here, EXACTLY as the TS
    // `bandToFlatStopTimes` does for `loadPtb`'s carry-less path — so this Rust
    // projection and the TS `assert-ptb-cross-parity.ts` projection anchor to the
    // SAME golden. Rows are assembled in trip_idx order (0..num_trips); for each
    // trip its pattern `p = trip_pattern_idx(trip)`, its LOCAL slab row `j` = its
    // position in `pattern_trips(p)`, and one row PER CANONICAL POSITION:
    //   stopIdx = pattern_stops(p)[pos]
    //   depSecs = served ? band_dep_secs(p,j,pos) : 0xFFFFFFFF   (NOT_SERVED hole)
    //   arrDiff = served ? band_arr_secs - band_dep_secs : 0
    //   stopSeq = pos   (canonical position; the band carries no GTFS stop_sequence
    //                    yet — matches TS, which sets stopSeq to the canonical pos)
    // The carry-BEARING path is byte-unchanged (the flat `stop_time(i)` read).
    let sts: Vec<String> = if r.is_carry_less_band() {
        let mut sts: Vec<String> = Vec::with_capacity(r.num_stop_times());
        for trip in 0..r.num_trips() {
            let p = r.trip_pattern_idx(trip).expect("carry-less trip pattern") as usize;
            let pattern_trips = r.pattern_trips(p).expect("carry-less pattern_trips");
            // LOCAL slab row = position of this global trip in pattern_trips(p).
            let j = pattern_trips
                .iter()
                .position(|&gt| gt as usize == trip)
                .expect("trip present in its pattern's PatternTrips slice");
            let stops = r.pattern_stops(p).expect("carry-less pattern_stops");
            for (pos, &stop_idx) in stops.iter().enumerate() {
                let dep = r.band_dep_secs(p, j, pos).expect("band dep in range");
                let (dep_secs, arr_diff) = if dep == crate::reader::BAND_NOT_SERVED {
                    // NOT_SERVED hole: 0xFFFFFFFF dep, 0 arrDiff (mirrors the flat
                    // carry's sentinel + TS bandToFlatStopTimes).
                    (0xFFFF_FFFFu32, 0i64)
                } else {
                    let arr = r.band_arr_secs(p, j, pos).expect("band arr in range");
                    (dep as u32, arr - dep)
                };
                sts.push(format!(
                    "{{\"depSecs\":{},\"arrDiff\":{},\"stopIdx\":{},\"stopSeq\":{}}}",
                    dep_secs, arr_diff, stop_idx, pos,
                ));
            }
        }
        sts
    } else {
        let mut sts: Vec<String> = Vec::with_capacity(r.num_stop_times());
        for i in 0..r.num_stop_times() {
            let st = r.stop_time(i).expect("stop_time in range");
            sts.push(format!(
                "{{\"depSecs\":{},\"arrDiff\":{},\"stopIdx\":{},\"stopSeq\":{}}}",
                st.dep_secs, st.arr_diff, st.stop_idx, st.stop_seq,
            ));
        }
        sts
    };
    out.push_str(&format!("\"stopTimes\":{},", arr(&sts)));

    // tripStarts (zero-copy prefix-sum view).
    out.push_str(&format!(
        "\"tripStarts\":{},",
        u32_arr(r.trip_starts().expect("tripStarts"))
    ));

    // CSR arrays — emit the RAW on-disk u32 arrays via the zero-copy views,
    // exactly the bytes the TS side echoes. Do NOT reconstruct offsets from
    // per-row accessors (a canonical prefix-sum would mask a non-canonical but
    // structurally-valid on-disk layout, defeating the parity gate).
    //
    // CARRY-LESS: the `0xF6 Csr` carry is stripped. The route→trips
    // CSR is synthesized from the surviving trip→route backref (the raw views
    // above return the synth arrays carry-less, matching TS `loadPtb`'s synth).
    // The stop→routes CSR is NOT synthesized — the band's `0x45 PatternsAtStop`
    // drives ON-mode routes_at_stop, and the flat OFF path derives its own from
    // each route's canonical stops. TS leaves it as an all-zero `stopRoutesOffsets` (length
    // numStops+1) + empty `stopRoutesValues`; mirror that here so the projection
    // is byte-identical (the raw Rust views would return `[]` for the stripped
    // offsets, which would diverge from TS's `[0,0,…]`).
    out.push_str(&format!(
        "\"routeTripsOffsets\":{},",
        u32_arr(r.route_trips_offsets().expect("rtOffsets"))
    ));
    out.push_str(&format!(
        "\"routeTripsValues\":{},",
        u32_arr(r.route_trips_values().expect("rtValues"))
    ));
    if r.is_carry_less_band() {
        // All-zero offsets of length numStops+1, empty values (mirrors TS).
        let sr_offsets: Vec<u32> = alloc::vec![0u32; r.num_stops() + 1];
        out.push_str(&format!("\"stopRoutesOffsets\":{},", u32_arr(&sr_offsets)));
        out.push_str("\"stopRoutesValues\":[],");
    } else {
        out.push_str(&format!(
            "\"stopRoutesOffsets\":{},",
            u32_arr(r.stop_routes_offsets().expect("srOffsets"))
        ));
        out.push_str(&format!(
            "\"stopRoutesValues\":{},",
            u32_arr(r.stop_routes_values().expect("srValues"))
        ));
    }

    // serviceActive: map of two pinned dates -> [bool; numServices], fixed order.
    out.push_str("\"serviceActive\":{");
    for (di, &date) in PINNED_DATES.iter().enumerate() {
        if di > 0 {
            out.push(',');
        }
        let mut bits: Vec<String> = Vec::with_capacity(r.num_services() as usize);
        for s in 0..r.num_services() {
            bits.push(if r.service_active_on(s, date) {
                String::from("true")
            } else {
                String::from("false")
            });
        }
        out.push_str(&format!("\"{}\":{}", date, arr(&bits)));
    }
    out.push('}');

    // stopParents — the decoded (childIdx, parentIdx) pairs, sorted by
    // childIdx, so the cross-language parity gate cross-checks the Rust↔TS
    // decode of the dense `parent_idx` column. Built via stop_parent() over the
    // stop range (empty for feeds with no parent_station).
    let mut parents: Vec<String> = Vec::new();
    for i in 0..r.num_stops() as u32 {
        if let Some(p) = r.stop_parent(i) {
            parents.push(format!("{{\"childIdx\":{i},\"parentIdx\":{p}}}"));
        }
    }
    out.push_str(&format!(",\"stopParents\":{}", arr(&parents)));

    out.push('}');
    out
}
