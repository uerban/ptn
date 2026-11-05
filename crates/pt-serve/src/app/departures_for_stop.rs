//! `GET /api/<city>/departures-for-stop` — the public departures API: the
//! schedule computation shared with the loopback C2c route, plus the live
//! GTFS-RT overlay.
//!
//! ## Why this is a separate route rather than C2c made public
//!
//! C2c (`app::scheduled_departures`) stays loopback-only and keeps its frozen
//! `contractVersion: 1`. Exposing it instead would have meant deleting the CI
//! gates that exist specifically to keep it off the proxy
//! (`.github/workflows/nginx-loopback-isolation.yml` greps `nginx/` for the
//! route string and fails), and its public visibility lives in `router::resolve`
//! as one global branch — so exposing it would expose every city at once.
//!
//! This route name was reserved for exactly this purpose long before this
//! module existed: `packages/frontend/nginx.conf` declares
//! `limit_req_zone … zone=departures_burst … rate=20r/s` with the comment
//! "pre-declared for /departures-for-stop (Plan-C2); no consumer yet", and the
//! C2c plan says outright "Out of scope for C2c: the public
//! `/api/<city>/departures-for-stop` handler".
//!
//! The two routes share `compute_departures`, so the subtle parts — the
//! service-day projection, the −1-day overnight candidate window, the
//! DST-correct instant projection, the no-dedup rule for loop/lasso trips —
//! exist once.
//!
//! ## Response shape
//!
//! `{ data: Departure[], meta: {...} }` with ISO-8601 instants, matching the
//! public `Departure` interface in `packages/shared/src/types/transit.ts` — NOT
//! C2c's bare unix-seconds envelope. The design spec fixed this shape for the
//! public route (`…stage-c-pt-serve-expansion-design.md`: "converts
//! `scheduledDepartureSecs` (unix-secs) into ISO 8601 to match the existing
//! public `Departure` interface", "keeps its current `{ data, meta }`
//! envelope").
//!
//! ## RT overlay semantics
//!
//! Ported from `packages/shared/src/transit/getDeparturesFromTile.ts`, which is
//! what the browser already does, so a client sees the same numbers whichever
//! path served them:
//!
//!   - Lookup is `merged["{tripId}|{ymd}"]` FIRST, then bare `merged[tripId]`.
//!     The dated key wins — an overnight trip running on two service dates has
//!     distinct updates per date, and the bare key cannot disambiguate them.
//!   - `delaySeconds` is emitted whenever an update matched, INCLUDING zero: a
//!     `0` means "tracked, on time", which is different information from
//!     "untracked", and the absent field is what carries the latter.
//!   - `predictedTime` is emitted ONLY when the delay is non-zero, matching the
//!     client. A predicted time equal to the scheduled one carries nothing.
//!   - `cancelled` is emitted only when true; false collapses to absent.
//!
//! ## Window bound
//!
//! `MAX_WINDOW_SECS` here is 24h, not C2c's 6h. C2c's bound exists because "the
//! loopback worker pool has NO timeout watchdog"; the public pool does have one
//! (`--request-timeout-ms`). 6h would also be below what shipped clients ask
//! for — `DepartureSheet.tsx` requests a 24-hour look-ahead and the legacy Node
//! route accepts up to 48h.
//!
//! ## Worker-occupancy bound (this is what makes the route flippable)
//!
//! The per-request scan walks every `stop_time` row at the stop for each
//! candidate service date (`DeparturesIdx::entries_iter`), and `maxResults`
//! truncates only AFTER that scan — so cost scales with the busiest stop in
//! the feed, not with any request parameter. The public pool's watchdog is
//! COOPERATIVE: `ops::timeout` can only set a flag a handler checks, it cannot
//! preempt a worker.
//!
//! So the watchdog flag is threaded into `compute_departures` and checked at
//! two safepoints: once per candidate date (free, and it aborts before
//! committing to another full stop-scan) and every
//! `SCAN_ABORT_CHECK_INTERVAL` rows within one. An aborted request returns
//! 503; the dispatch layer has already dropped the connection by then, so the
//! body is for direct callers and tests. Same contract `app::plan` has with
//! `pt_core::plan_with_abort`, and the reason this route can share a pool with
//! `/plan` without head-of-line starvation.
//!
//! C2c passes `None` — its loopback pool has no watchdog to thread — so its
//! behaviour is unchanged.

use crate::app::response::Resp;
use crate::app::scheduled_departures::{compute_departures, DepartureRow};
use crate::bundle::Generation;
use crate::ops::ServerCtx;
use jiff::{fmt::temporal::DateTimePrinter, tz::TimeZone, Timestamp};
use serde::Serialize;

/// Public window ceiling — see the module doc. 24h covers `DepartureSheet`'s
/// look-ahead; the legacy Node route allowed up to 48h.
const MAX_WINDOW_SECS: i64 = 24 * 3600;

/// One row of the public `Departure` contract
/// (`packages/shared/src/types/transit.ts`). Optional fields are omitted rather
/// than emitted null so the wire shape matches what the TS interface declares
/// as `?`.
#[derive(Serialize)]
struct WireDeparture {
    #[serde(rename = "routeId")]
    route_id: String,
    #[serde(rename = "routeShortName")]
    route_short_name: String,
    #[serde(rename = "routeColor", skip_serializing_if = "Option::is_none")]
    route_color: Option<String>,
    mode: &'static str,
    #[serde(rename = "subMode", skip_serializing_if = "Option::is_none")]
    sub_mode: Option<String>,
    headsign: String,
    #[serde(rename = "scheduledTime")]
    scheduled_time: String,
    #[serde(rename = "predictedTime", skip_serializing_if = "Option::is_none")]
    predicted_time: Option<String>,
    #[serde(rename = "delaySeconds", skip_serializing_if = "Option::is_none")]
    delay_seconds: Option<i32>,
    #[serde(rename = "tripId")]
    trip_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
}

#[derive(Serialize)]
struct Meta {
    source: &'static str,
    #[serde(rename = "generationId")]
    generation_id: String,
    #[serde(rename = "windowStart")]
    window_start: i64,
    #[serde(rename = "windowEnd")]
    window_end: i64,
    truncated: bool,
    #[serde(rename = "windowOutsideServiceRange")]
    window_outside_service_range: bool,
    /// True when an RT snapshot was present and consulted. False means every
    /// row is schedule-only because no feed is configured — distinguishable
    /// from "consulted, nothing matched", which this flag alone would blur.
    #[serde(rename = "realtimeApplied")]
    realtime_applied: bool,
}

#[derive(Serialize)]
struct Response {
    data: Vec<WireDeparture>,
    meta: Meta,
}

/// Unix seconds → ISO-8601 UTC (`…Z`), matching `new Date(ms).toISOString()`
/// on the client, which is what produced the values this contract mirrors.
fn iso8601(unix_secs: i64) -> String {
    Timestamp::from_second(unix_secs)
        .ok()
        .map(|dt| {
            DateTimePrinter::new()
                .precision(Some(3))
                .timestamp_to_string(&dt)
        })
        .unwrap_or_default()
}

/// `YYYYMMDD` of a unix instant in UTC — the service-date key half of the RT
/// lookup. Mirrors the client's `ymd` derivation.
fn ymd_utc(unix_secs: i64) -> String {
    Timestamp::from_second(unix_secs)
        .ok()
        .map(|dt| dt.to_zoned(TimeZone::UTC).strftime("%Y%m%d").to_string())
        .unwrap_or_default()
}

/// `abort` is the request watchdog's `timed_out` flag, threaded into the
/// candidate scan exactly as `app::plan` threads it into the engine. Without
/// it the handler is unbounded in worker-occupancy terms: the scan walks every
/// stop_time row at the stop per candidate service date, so its cost tracks
/// the busiest stop in the feed rather than any request parameter, and
/// `ops::timeout`'s watchdog can only set a flag — it cannot preempt.
pub fn departures_for_stop(
    query: &str,
    gen: &Generation,
    ctx: &ServerCtx,
    if_generation_match: Option<&str>,
    abort: Option<&std::sync::atomic::AtomicBool>,
) -> Resp {
    let core =
        match compute_departures(query, gen, ctx, if_generation_match, MAX_WINDOW_SECS, abort) {
            Ok(c) => c,
            Err(resp) => return *resp,
        };

    // One snapshot for the whole response: an ArcSwap load per row could
    // straddle a poll cycle and emit rows from two different RT generations.
    let rt = ctx.rt.load();
    let realtime_applied = !rt.merged.is_empty();

    let data: Vec<WireDeparture> = core
        .rows
        .iter()
        .filter_map(|row: &DepartureRow| {
            let sched = row.scheduled_departure_secs();
            let trip_id = row.trip_id();

            // Dated key first, then bare — see the module doc.
            let dated_key = format!("{}|{}", trip_id, ymd_utc(sched));
            let update = rt.merged.get(&dated_key).or_else(|| rt.merged.get(trip_id));

            // A DELETED trip "must not be shown to users": off the board, not
            // listed as cancelled. Dropped after the scan's `maxResults` cut,
            // so a board with one can come back a row short.
            if update.is_some_and(|u| u.deleted) {
                return None;
            }

            let (delay_seconds, predicted_time, cancelled) = match update {
                Some(u) => (
                    Some(u.delay_seconds),
                    if u.delay_seconds != 0 {
                        Some(iso8601(sched + i64::from(u.delay_seconds)))
                    } else {
                        None
                    },
                    if u.cancelled { Some(true) } else { None },
                ),
                None => (None, None, None),
            };

            Some(WireDeparture {
                route_id: row.route_id().to_string(),
                route_short_name: row.route_short_name().to_string(),
                route_color: {
                    let c = row.route_color();
                    if c.is_empty() {
                        None
                    } else {
                        Some(c.to_string())
                    }
                },
                mode: row.mode(),
                sub_mode: None,
                headsign: row.headsign().to_string(),
                scheduled_time: iso8601(sched),
                predicted_time,
                delay_seconds,
                trip_id: trip_id.to_string(),
                cancelled,
            })
        })
        .collect();

    let resp = Response {
        data,
        meta: Meta {
            source: "pt-serve",
            generation_id: gen.generation_id.clone(),
            window_start: core.from,
            window_end: core.to,
            truncated: core.truncated,
            window_outside_service_range: core.window_outside_service_range,
            realtime_applied,
        },
    };
    match serde_json::to_string(&resp) {
        Ok(body) => Resp::Json { status: 200, body },
        Err(e) => Resp::Json {
            status: 500,
            body: serde_json::json!({ "error": format!("serialization error: {e}") }).to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire projection must match `new Date(ms).toISOString()`, which is
    /// what produced the values on the client side of this contract.
    #[test]
    fn iso8601_matches_the_js_tostring_shape() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_786_148_839), "2026-08-08T00:27:19.000Z");
    }

    #[test]
    fn ymd_utc_is_the_service_date_key_half() {
        // UTC, deliberately: the key is a service-DATE and must not shift with
        // the reader's local offset. Cross-checked against
        // `datetime.fromtimestamp(t, timezone.utc)`.
        assert_eq!(ymd_utc(1_786_148_839), "20260808");
        assert_eq!(ymd_utc(0), "19700101");
    }

    /// A window wider than C2c's 6h is accepted here. Pinned because the whole
    /// reason this route does not reuse C2c's clamp is that shipped clients ask
    /// for 24h (`DepartureSheet.tsx`), and silently inheriting 6h would 400
    /// them.
    #[test]
    fn public_window_ceiling_covers_the_24h_client() {
        // 24h exactly: DepartureSheet.tsx requests a 24-hour look-ahead, so a
        // smaller ceiling would 400 a shipped client. Pinned as equality —
        // a >= check against a const is tautological and proves nothing.
        assert_eq!(MAX_WINDOW_SECS, 24 * 3600);
    }
}
