//! `GET /api/<city>/scheduled-departures-for-stop` — the C2c correctness keystone (loopback-only;
//! the public listeners 404 this route — see `router::resolve`). Transport-agnostic: NO `tiny_http`
//! import (boundary, asserted by `tests/boundaries.rs`).
//!
//! ## Contract (frozen `contractVersion: 1`)
//!
//! Query: `?stopId=&from=&to=&maxResults=`.
//!   - `stopId` required (else 400).
//!   - `from` required unix secs (else 400).
//!   - `to` optional unix secs, default `from + 3600`, treated as EXCLUSIVE.
//!   - `maxResults` optional, default 100.
//!   - The window `[from, to)` is bounded: `to - from > 6h` → 400. The loopback
//!     worker pool has NO timeout watchdog, so this clamp (plus `maxResults` and
//!     the bounded candidate-date range) keeps the handler provably bounded.
//!
//! Status codes: 400 bad-arg / window>6h; 404 unknown stop; 412 generation
//! mismatch (`If-Generation-Match`); 503 sidecar/tz unavailable; 200 otherwise.
//!
//! ## Service-day projection + the −1-day candidate window
//!
//! A GTFS departure is keyed by `(service_date, secs_of_service_day)`, and
//! `secs_of_service_day` may exceed 86400 (overnight trips, e.g. `25:30:00`
//! departs on the PRIOR civil date but lands after the next local midnight). So
//! the candidate service dates run from `localDate(from) − 1 day` through
//! `localDate(to)` inclusive — the −1 covers an overnight departure whose civil
//! instant falls inside `[from, to)` but whose service date is the day before.
//! Each candidate `(service_date, dep_secs)` is projected to a unix instant via
//! [`crate::domain::time_domain::service_day_to_unix`] (DST-correct) and kept
//! only if it lands in `[from, to)`.
//!
//! GTFS reference (times > 24h, loop/lasso): a loop/lasso trip visiting one stop
//! twice yields two `stop_times` rows with distinct absolute indices — both
//! surface here (NEVER dedup by tripId).
//! <https://gtfs.org/documentation/schedule/reference/#stop_timestxt>

use crate::app::response::Resp;
use crate::bundle::Generation;
use crate::domain::mode::route_type_to_mode;
use crate::domain::time_domain::service_day_to_unix;
use crate::ops::ServerCtx;
use jiff::{civil::Date, Timestamp, ToSpan};
use pt_shared::sidecar::DeparturesIdx;
use serde::Serialize;
use std::collections::HashMap;

/// Frozen response `contractVersion`.
const CONTRACT_VERSION: u32 = 1;
/// Sentinel `dep_secs` for "no departure_time" (non-timepoint stop) — skip.
const MISSING_DEP_SECS: u32 = 0xFFFF_FFFF;
/// Absent `direction_id` sentinel (mirrors loadFromPtb) → emit `null`.
const DIRECTION_ABSENT: u8 = 0xFF;
/// Hard upper bound on the request window (`to - from`) for the LOOPBACK C2c
/// route. The loopback pool has no watchdog, so this bounds the candidate scan.
///
/// Passed in per-caller rather than read directly, because the public
/// `departures-for-stop` route needs a different bound — see that module. The
/// value here is unchanged, which is what keeps the frozen `contractVersion: 1`
/// behaviour byte-identical.
const MAX_WINDOW_SECS: i64 = 6 * 3600;
/// Default window when `to` is omitted: `from + 1h`.
const DEFAULT_WINDOW_SECS: i64 = 3600;
/// Default `maxResults`.
const DEFAULT_MAX_RESULTS: usize = 100;
/// Rows between cooperative-abort checks in the candidate scan. Power of two
/// so the modulo is a mask; large enough that the relaxed atomic load is
/// amortised away, small enough that abort latency stays well under a
/// request-timeout tick.
const SCAN_ABORT_CHECK_INTERVAL: u64 = 1024;

/// One serialized departure row ( contract). Owned Strings — the response is
/// bounded to `maxResults` rows, so the allocation is bounded.
#[derive(Serialize)]
pub(crate) struct DepartureRow {
    #[serde(rename = "tripId")]
    trip_id: String,
    #[serde(rename = "routeId")]
    route_id: String,
    #[serde(rename = "routeShortName")]
    route_short_name: String,
    #[serde(rename = "routeColor")]
    route_color: String,
    #[serde(rename = "routeTextColor")]
    route_text_color: String,
    mode: &'static str,
    /// No carrier on the binary path — frozen `null`.
    #[serde(rename = "subMode")]
    sub_mode: Option<String>,
    #[serde(rename = "serviceId")]
    service_id: String,
    headsign: String,
    /// `0`/`1`, or `null` when the PTB byte is the `0xFF` absent sentinel.
    #[serde(rename = "directionId")]
    direction_id: Option<u8>,
    #[serde(rename = "stopSequence")]
    stop_sequence: u16,
    #[serde(rename = "scheduledDepartureSecs")]
    scheduled_departure_secs: i64,
    #[serde(rename = "scheduledArrivalSecs")]
    scheduled_arrival_secs: i64,
    #[serde(rename = "wheelchairAccessible")]
    wheelchair_accessible: u8,
}

/// Read-only accessors for the sibling `departures_for_stop` module, which
/// re-projects these rows into the public `Departure` contract. Deliberately
/// narrow: only the fields that contract needs are exposed, so the frozen C2c
/// wire shape stays owned by this module.
impl DepartureRow {
    pub(crate) fn trip_id(&self) -> &str {
        &self.trip_id
    }
    pub(crate) fn route_id(&self) -> &str {
        &self.route_id
    }
    pub(crate) fn route_short_name(&self) -> &str {
        &self.route_short_name
    }
    pub(crate) fn route_color(&self) -> &str {
        &self.route_color
    }
    pub(crate) fn mode(&self) -> &'static str {
        self.mode
    }
    pub(crate) fn headsign(&self) -> &str {
        &self.headsign
    }
    pub(crate) fn scheduled_departure_secs(&self) -> i64 {
        self.scheduled_departure_secs
    }
}

#[derive(Serialize)]
struct DeparturesResponse {
    #[serde(rename = "contractVersion")]
    contract_version: u32,
    #[serde(rename = "stopId")]
    stop_id: String,
    #[serde(rename = "windowStart")]
    window_start: i64,
    #[serde(rename = "windowEnd")]
    window_end: i64,
    #[serde(rename = "generationId")]
    generation_id: String,
    #[serde(rename = "cityTzIana")]
    city_tz_iana: String,
    truncated: bool,
    #[serde(rename = "windowOutsideServiceRange")]
    window_outside_service_range: bool,
    departures: Vec<DepartureRow>,
}

/// A minimal candidate tuple collected before the route join. Carries the
/// service `date` + `dep_secs` + `arr_diff` so the (more expensive) ARRIVAL
/// tz-projection can be deferred until AFTER sort + truncation — it then runs
/// at most `maxResults` times instead of once per in-window survivor. The
/// DEPARTURE projection (`dep`) stays inline because it is the filter key.
struct Candidate {
    trip_idx: u32,
    stop_seq: u16,
    /// Service date the departure is keyed to (for the deferred arrival projection).
    date: Date,
    /// `dep_secs` of this stop_time (for the deferred arrival projection).
    dep_secs: u32,
    /// `arr_diff` of this stop_time (for the deferred arrival projection).
    arr_diff: i16,
    dep: i64,
}

/// Borrowed route style fields, memoized per distinct `route_idx`.
struct RouteStyle<'a> {
    route_id: &'a str,
    route_short_name: &'a str,
    route_color: &'a str,
    route_text_color: &'a str,
    mode: &'static str,
}

fn json_err(status: u16, msg: &str) -> Resp {
    Resp::Json {
        status,
        body: serde_json::json!({ "error": msg }).to_string(),
    }
}

/// Form-urldecode a query VALUE: `+` → space, then `%XX` hex escapes → the
/// decoded byte. The decoded bytes are interpreted as UTF-8 with the lossy
/// fallback (a malformed `%XX` sequence is preserved verbatim rather than
/// erroring — the only consumer is `reader.stop_index`, which simply won't
/// match an undecodable id and 404s).
///
/// A caller reaches this listener directly, not through nginx, and is expected
/// to build the URL the way `URL`/`URLSearchParams.set` does — i.e.
/// application/x-www-form-urlencoded: space becomes `+`, and `% & = + # ?` plus
/// non-ASCII are `%`-encoded. pt-serve therefore receives the encoded form and
/// must decode it; otherwise a real GTFS `stop_id` containing a space, a
/// reserved char or non-ASCII (e.g. `"de:08111: 6056"`) would 404 or mis-hit.
fn form_urldecode(s: &str) -> String {
    // `+` is form-encoding for a space; do this first so a literal `%2B` (an
    // actual '+') survives the percent pass below.
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    // Not a valid `%XX` escape — keep the '%' verbatim.
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse a `key=value&...` query string into a flat map (last-wins). Values are
/// form-urldecoded ([`form_urldecode`]): the production caller is the Node
/// loopback client, which form-encodes via `URLSearchParams` (space→`+`,
/// `%XX`-escaped reserved/non-ASCII). `stopId` is an opaque GTFS id that can
/// carry such characters; the three numeric fields are unaffected by decoding
/// (digits don't encode) but are decoded uniformly for simplicity. A leading
/// `?` is tolerated.
fn parse_query(query: &str) -> HashMap<&str, String> {
    let q = query.strip_prefix('?').unwrap_or(query);
    let mut out = HashMap::new();
    for pair in q.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        out.insert(k, form_urldecode(v));
    }
    out
}

/// A civil date's unsigned PTB key; BCE dates cannot belong to a GTFS feed.
fn ymd_of(date: Date) -> Option<u32> {
    let year = u32::try_from(date.year()).ok()?;
    Some(year * 10000 + date.month() as u32 * 100 + date.day() as u32)
}

/// Howard-Hinnant `days_from_civil` for a [`Date`] — days since the unix
/// epoch. Used only to test a candidate date against the bundle's 90-day window
/// anchored at `feed_start_date`.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Decode a YYYYMMDD u32 to `(y, m, d)` ints.
fn decode_ymd(ymd: u32) -> (i64, i64, i64) {
    (
        (ymd / 10000) as i64,
        ((ymd / 100) % 100) as i64,
        (ymd % 100) as i64,
    )
}

/// True iff candidate civil date `date` is OUTSIDE the bundle's service window
/// `[feed_start_date, feed_start_date + window_days)`. A candidate strictly
/// before the anchor, or `>= window_days` past it, is outside. `window_days` is
/// the bundle's runtime window (`Reader::window_days()`) — NOT a fixed 90 — so a
/// horizon-extended feed bounds correctly.
fn date_outside_window(date: Date, feed_start_date: u32, window_days: u16) -> bool {
    let (ay, am, ad) = decode_ymd(feed_start_date);
    let anchor = days_from_civil(ay, am, ad);
    let cand = days_from_civil(date.year() as i64, date.month() as i64, date.day() as i64);
    let delta = cand - anchor;
    delta < 0 || delta >= i64::from(window_days)
}

/// Handle a `GET /api/<city>/scheduled-departures-for-stop` request.
///
/// `query` is the `?...` part of the URL (the `query_of` helper in
/// `http::server` extracts it). `if_generation_match` is the
/// `If-Generation-Match` request header value, if present.
/// The schedule computation shared by the loopback C2c route and the public
/// `departures` route.
///
/// Extracted rather than duplicated: the two routes differ only in what they
/// do with the rows afterwards (C2c serializes them as-is; `departures` layers
/// the live RT overlay on top), and a second copy of the service-day projection
/// would be a correctness liability — this is the endpoint the module doc calls
/// "the C2c correctness keystone".
///
/// `Err` carries the fully-formed error `Resp` to return, so both callers share
/// the status-code contract (400 bad-arg, 404 unknown stop, 412 generation
/// mismatch, 503 sidecar/tz unavailable) without restating it.
pub(crate) struct DeparturesCore {
    pub stop_id: String,
    pub from: i64,
    pub to: i64,
    pub truncated: bool,
    pub window_outside_service_range: bool,
    pub rows: Vec<DepartureRow>,
}

pub(crate) fn compute_departures(
    query: &str,
    gen: &Generation,
    ctx: &ServerCtx,
    if_generation_match: Option<&str>,
    max_window_secs: i64,
    abort: Option<&std::sync::atomic::AtomicBool>,
) -> Result<DeparturesCore, Box<Resp>> {
    let params = parse_query(query);

    // --- 1. Parse + validate query params ---
    let stop_id: &str = match params.get("stopId") {
        Some(s) if !s.is_empty() => s.as_str(),
        _ => return Err(Box::new(json_err(400, "stopId is required"))),
    };
    let from: i64 = match params.get("from").and_then(|s| s.parse::<i64>().ok()) {
        Some(f) => f,
        None => return Err(Box::new(json_err(400, "from (unix secs) is required"))),
    };
    let to: i64 = match params.get("to") {
        Some(s) => match s.parse::<i64>().ok() {
            Some(t) => t,
            None => return Err(Box::new(json_err(400, "to must be unix secs"))),
        },
        None => from.saturating_add(DEFAULT_WINDOW_SECS),
    };
    if to <= from {
        return Err(Box::new(json_err(400, "to must be greater than from")));
    }
    if to.saturating_sub(from) > max_window_secs {
        // The bound is the caller's `max_window_secs`, so the message has to be
        // too. It was hardcoded to "6h" — correct for the loopback C2c route
        // that owns that constant, wrong for the public `departures-for-stop`
        // route, which passes 24h and so told a rejected caller a limit four
        // times tighter than the one it enforces.
        //
        // Both callers pass whole hours, so the division is exact. C2c renders
        // 6*3600/3600 = 6 and its body stays byte-identical, which is what
        // keeps the frozen `contractVersion: 1` frozen.
        return Err(Box::new(json_err(
            400,
            &format!("window (to - from) exceeds {}h", max_window_secs / 3600),
        )));
    }
    let max_results: usize = match params.get("maxResults") {
        Some(s) => match s.parse::<usize>().ok() {
            Some(n) => n,
            None => {
                return Err(Box::new(json_err(
                    400,
                    "maxResults must be a non-negative integer",
                )))
            }
        },
        None => DEFAULT_MAX_RESULTS,
    };

    // --- 2. Generation match (412) — checked before the 503/404 gates so a
    // client racing a swap learns the current generationId immediately. ---
    if let Some(want) = if_generation_match {
        if want != gen.generation_id {
            return Err(Box::new(Resp::Json {
                status: 412,
                body: serde_json::json!({ "generationId": gen.generation_id }).to_string(),
            }));
        }
    }

    // --- 3. Sidecar / tz availability (503) ---
    let mmap = match gen.departures_idx_mmap.as_ref() {
        Some(m) => m,
        None => return Err(Box::new(json_err(503, "sidecar_unavailable"))),
    };
    let tz = match gen.city_tz.as_ref() {
        Some(tz) => tz,
        None => return Err(Box::new(json_err(503, "tz_unresolved"))),
    };

    // --- 4. Resolve stop (404) ---
    let stop_idx = match gen.reader.stop_index(stop_id) {
        Some(i) => i,
        None => return Err(Box::new(json_err(404, "unknown_stop"))),
    };

    // --- 5. DPIX view (panic-free; validated once at load) ---
    let dpix = DeparturesIdx::parse_unchecked(&mmap[..]);

    // --- 6. Candidate service dates: localDate(from)-1 .. localDate(to) ---
    // An absolute instant has one local civil date, even during a fold.
    let local_date = |unix: i64| -> Option<Date> {
        Timestamp::from_second(unix)
            .ok()
            .map(|instant| tz.to_datetime(instant).date())
    };
    let from_date = match local_date(from) {
        Some(d) => d,
        None => {
            return Err(Box::new(json_err(
                400,
                "from is not a representable instant",
            )))
        }
    };
    let to_date = match local_date(to) {
        Some(d) => d,
        None => return Err(Box::new(json_err(400, "to is not a representable instant"))),
    };
    // The back-scan to `from_date − 1 day` is complete ONLY because the producer
    // caps overnight `dep_secs` at `h <= 47` (`dep_secs < 2 days`, i.e. a service
    // date's departures land within the next civil day). If that cap ever rises,
    // a departure could surface two-or-more civil days later and this single-day
    // back-scan would miss it — widen the back-scan to match the new cap.
    //
    // Checked civil arithmetic: a `from`
    // near `Date::MIN` that still passed the `local_date` guard above could
    // otherwise panic → 500. An arithmetic error here is a 400 (bad request).
    let first_date = match from_date.checked_sub(1.days()) {
        Ok(d) => d,
        Err(_) => {
            return Err(Box::new(json_err(
                400,
                "from is too close to the date minimum",
            )))
        }
    };

    // Inclusive [first_date, to_date]. The window is ≤6h, so this spans at most
    // 3 civil dates — bounded.
    let mut candidate_dates: Vec<Date> = Vec::new();
    let mut d = first_date;
    while d <= to_date {
        candidate_dates.push(d);
        // Checked civil arithmetic guards against a date-range overflow → 500.
        d = match d.checked_add(1.days()) {
            Ok(next) => next,
            Err(_) => {
                return Err(Box::new(json_err(
                    400,
                    "to is too close to the date maximum",
                )))
            }
        };
    }

    // windowOutsideServiceRange: true iff EVERY candidate date is outside the
    // bundle's runtime service window (`Reader::window_days()`).
    let window_days = gen.reader.window_days();
    let window_outside_service_range = candidate_dates
        .iter()
        .all(|&dt| date_outside_window(dt, gen.feed_start_date, window_days));

    // --- 7. Collect in-window survivors (departure projected + filtered) ---
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut scanned: u64 = 0;
    if !window_outside_service_range {
        for &date in &candidate_dates {
            // Per-date safepoint. Free (at most a handful of iterations) and it
            // aborts BEFORE committing to another full stop-scan, so the abort
            // latency ceiling is one date's scan rather than the whole request.
            if let Some(flag) = abort {
                if flag.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err(Box::new(json_err(503, "request_aborted")));
                }
            }
            let Some(ymd) = ymd_of(date) else { continue };
            for (trip_idx, st_idx) in dpix.entries_iter(stop_idx as usize) {
                // Cooperative abort safepoint. `entries_iter` walks EVERY
                // stop_time row at this stop, once per candidate date, and the
                // `maxResults` truncation happens only after the whole scan —
                // so the cost scales with the busiest stop in the feed rather
                // than with anything the caller asked for. Without this check a
                // wide window against such a stop pins the worker past the
                // request timeout, and `ops::timeout`'s watchdog cannot preempt
                // it (it only sets a flag; see that module). Same contract as
                // `pt_core::plan_with_abort`.
                //
                // Checked every SCAN_ABORT_CHECK_INTERVAL rows so the relaxed
                // atomic load is amortised to nothing on the common path.
                scanned += 1;
                if scanned.is_multiple_of(SCAN_ABORT_CHECK_INTERVAL) {
                    if let Some(flag) = abort {
                        if flag.load(std::sync::atomic::Ordering::Relaxed) {
                            return Err(Box::new(json_err(503, "request_aborted")));
                        }
                    }
                }
                // st_idx is the ABSOLUTE StopTimes row index — read it directly.
                // Through the per-generation cursor when one built: on a
                // carry-less bundle `Reader::stop_time` re-derives the band
                // addressing on EVERY call (an O(k) pattern-trip scan plus
                // several O(p) slab prefix walks), and this loop runs once per
                // candidate row per date. The cursor returns exactly what
                // `stop_time` returns — it is a cost change, not a behaviour
                // change — so the `None` fallback is the same read, slower.
                let st = match gen.stop_time_cursor.as_ref().map_or_else(
                    || gen.reader.stop_time(st_idx as usize),
                    |c| c.stop_time(&gen.reader, st_idx as usize),
                ) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                // Missing departure_time at a non-timepoint stop — skip.
                if st.dep_secs == MISSING_DEP_SECS {
                    continue;
                }
                let svc = match gen.reader.trip_service_idx(trip_idx as usize) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                if !gen.reader.service_active_on(svc, ymd) {
                    continue;
                }
                // DEPARTURE projection stays inline — it is the filter key.
                let dep = match service_day_to_unix(date, i64::from(st.dep_secs), tz) {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                if dep < from || dep >= to {
                    continue;
                }
                // Defer the ARRIVAL projection to the post-truncation join loop
                // (Fix: runs ≤maxResults times, not once per survivor); carry the
                // inputs it needs.
                candidates.push(Candidate {
                    trip_idx,
                    stop_seq: st.stop_seq,
                    date,
                    dep_secs: st.dep_secs,
                    arr_diff: st.arr_diff,
                    dep,
                });
            }
        }
    }

    // --- 8. Sort + truncate BEFORE the route join ---
    // Stable sort by departure instant; ties keep collection order (service
    // date, then DPIX entry order — both deterministic).
    candidates.sort_by_key(|c| c.dep);
    let mut truncated = false;
    if candidates.len() > max_results {
        truncated = true;
        ctx.metrics.inc_scheduled_departures_truncated();
        candidates.truncate(max_results);
    }

    // --- 9. Route join + deferred ARRIVAL projection (memoized per route_idx) ---
    // The arrival tz-projection runs HERE (post-truncation) so it executes at
    // most `maxResults` times, not once per in-window survivor.
    let mut route_cache: HashMap<u32, RouteStyle> = HashMap::new();
    let mut rows: Vec<DepartureRow> = Vec::with_capacity(candidates.len());
    for c in &candidates {
        let trip_i = c.trip_idx as usize;
        // Deferred ARRIVAL projection. `arr_diff` fidelity is limited (data-plane D2): the PTB
        // writes `arr_diff == 0` both when arrival EQUALS departure AND when arrival was
        // feed-blank, and clamps `arr_diff` to ±32767 s (~±9.1 h) — so `scheduledArrivalSecs` MAY
        // equal `scheduledDepartureSecs`, and multi-hour layovers are clamped. The
        // `.unwrap_or(dep)` fallback keeps an unprojectable arrival pinned to the departure instant
        // rather than dropping the row.
        let arr = service_day_to_unix(c.date, i64::from(c.dep_secs) + i64::from(c.arr_diff), tz)
            .unwrap_or(c.dep);
        let route_idx = match gen.reader.trip_route_idx(trip_i) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let style = route_cache.entry(route_idx).or_insert_with(|| {
            let ri = route_idx as usize;
            let route_type = gen.reader.route_type(ri).unwrap_or(3);
            RouteStyle {
                route_id: gen.reader.route_id(ri).unwrap_or(""),
                route_short_name: gen.reader.route_short_name(ri).unwrap_or(""),
                route_color: gen.reader.route_color(ri).unwrap_or(""),
                route_text_color: gen.reader.route_text_color(ri).unwrap_or(""),
                mode: route_type_to_mode(route_type),
            }
        });

        let svc = gen.reader.trip_service_idx(trip_i).unwrap_or(0);
        let dir_byte = gen
            .reader
            .trip_direction_id(trip_i)
            .unwrap_or(DIRECTION_ABSENT);
        let direction_id = if dir_byte == DIRECTION_ABSENT {
            None
        } else {
            Some(dir_byte)
        };
        rows.push(DepartureRow {
            trip_id: gen.reader.trip_id(trip_i).unwrap_or("").to_string(),
            route_id: style.route_id.to_string(),
            route_short_name: style.route_short_name.to_string(),
            route_color: style.route_color.to_string(),
            route_text_color: style.route_text_color.to_string(),
            mode: style.mode,
            sub_mode: None,
            service_id: format!("svc:{svc}"),
            headsign: gen.reader.trip_headsign(trip_i).unwrap_or("").to_string(),
            direction_id,
            stop_sequence: c.stop_seq,
            scheduled_departure_secs: c.dep,
            scheduled_arrival_secs: arr,
            wheelchair_accessible: gen.reader.trip_wheelchair(trip_i).unwrap_or(0),
        });
    }

    Ok(DeparturesCore {
        stop_id: stop_id.to_string(),
        from,
        to,
        truncated,
        window_outside_service_range,
        rows,
    })
}

/// `GET /api/<city>/scheduled-departures-for-stop` (loopback-only).
///
/// Thin wrapper over [`compute_departures`]; the serialized body is unchanged
/// from before that extraction, which the 26 contract tests in
/// `tests/scheduled_departures.rs` are what actually holds.
pub fn scheduled_departures(
    query: &str,
    gen: &Generation,
    ctx: &ServerCtx,
    if_generation_match: Option<&str>,
) -> Resp {
    let core = match compute_departures(query, gen, ctx, if_generation_match, MAX_WINDOW_SECS, None)
    {
        Ok(c) => c,
        Err(resp) => return *resp,
    };
    let resp = DeparturesResponse {
        contract_version: CONTRACT_VERSION,
        stop_id: core.stop_id,
        window_start: core.from,
        window_end: core.to,
        generation_id: gen.generation_id.clone(),
        city_tz_iana: gen.city_tz_iana.clone(),
        truncated: core.truncated,
        window_outside_service_range: core.window_outside_service_range,
        departures: core.rows,
    };
    match serde_json::to_string(&resp) {
        Ok(body) => Resp::Json { status: 200, body },
        Err(e) => json_err(500, &format!("serialization error: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::date_outside_window;
    use jiff::{civil::Date, ToSpan};

    // Anchor used across the bound tests: 2026-05-01 (the deterministic CI
    // anchor). Day offsets below are measured from this date.
    const ANCHOR: u32 = 20260501;

    fn date_at_offset(days: i64) -> Date {
        Date::new(2026, 5, 1)
            .unwrap()
            .checked_add(days.days())
            .unwrap()
    }

    #[test]
    fn default_90_window_bounds_unchanged() {
        // Day 0 (anchor) is inside; day 89 is the last in-window day; day 90 is
        // the first day OUTSIDE; a date before the anchor is outside.
        assert!(!date_outside_window(date_at_offset(0), ANCHOR, 90));
        assert!(!date_outside_window(date_at_offset(89), ANCHOR, 90));
        assert!(date_outside_window(date_at_offset(90), ANCHOR, 90));
        assert!(date_outside_window(date_at_offset(-1), ANCHOR, 90));
    }

    #[test]
    fn extended_400_window_treats_day_300_as_inside() {
        // The retirement's load-bearing case: with a runtime window of 400 days,
        // day offset 300 is INSIDE the window (it would be OUTSIDE under the old
        // fixed 90-day bound). Day 399 is still in; day 400 is the first out.
        assert!(!date_outside_window(date_at_offset(300), ANCHOR, 400));
        assert!(!date_outside_window(date_at_offset(399), ANCHOR, 400));
        assert!(date_outside_window(date_at_offset(400), ANCHOR, 400));
        // Same day-300 candidate is OUTSIDE under the historical 90-day window —
        // proving the bound now follows the runtime value, not a literal 90.
        assert!(date_outside_window(date_at_offset(300), ANCHOR, 90));
    }
}
