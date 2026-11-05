//! Staged-PTB → tile-build inputs. Rust analog of the loadFromPtb subset the
//! Node tile build consumes (packages/backend/src/gtfs/loadFromPtb.ts):
//! stops in PTB region order, per-stop (trip_idx, dep_secs) pairs in
//! pairSortByB order, trip/route records, and the SYNTHESIZED producer-mode
//! calendar (all-false placeholder + bitmask-expanded "added" dates —
//! loadFromPtb.ts synthServices/synthCalendarDates). Route colors come from
//! route-styles.json (same artifact the color-artifacts step emits), NOT
//! recomputed.

use std::collections::HashMap;
use std::path::Path;

use crate::error::{Error, Result};
use crate::schedule_tiles::pair_sort::pair_sort_by_b;

/// PTB carries a missing-departure sentinel (a stop_time row present for
/// structural reasons — e.g. a non-timepoint stop — but with no scheduled
/// departure). Mirrors `MISSING_DEP_SENTINEL` in
/// packages/backend/src/gtfs/loadFromPtb.ts.
const MISSING_DEP_SENTINEL: u32 = 0xFFFF_FFFF;

pub struct TileStop {
    pub id: String,
    /// f64 degrees, read via `Reader::stop_lat_f64` — NOT the convenience
    /// `Reader::stop()` record: for current SoA bundles that record's `stop_lat`
    /// is a LOSSY f32 narrowed from the canonical `i32@1e7` column, while the
    /// TS loader (loader.ts decodeE7) is f64 end-to-end. The `*_f64` accessors
    /// decode the exact column value, keeping coordinate parity with Node.
    pub lat: f64,
    /// f64 degrees via `Reader::stop_lon_f64` — see `lat` for why.
    pub lon: f64,
}

pub struct TileTrip {
    pub trip_id: String,
    pub route_idx: u32,
    pub service_idx: u32,
    pub headsign: String,
}

pub struct TileRoute {
    pub route_id: String,
    pub short_name: String,
    pub long_name: String,
    /// GTFS route_color hex WITHOUT '#', "" when absent (PTB convention).
    pub route_color: String,
    pub route_type: u16,
}

pub struct TileService {
    /// "svc:<idx>" — serviceIdFor() in loadFromPtb.ts.
    pub service_id: String,
    /// Ascending YYYYMMDD strings expanded from the PTB active-day bitmask.
    pub added: Vec<String>,
}

pub struct RouteStyle {
    /// 6-hex color WITHOUT leading '#' (route-styles.json convention).
    pub color: Option<String>,
    pub sub_mode: Option<String>,
}

pub struct TileInputs {
    /// PTB Stops-region order — THE stop iteration order for the whole build.
    pub stops: Vec<TileStop>,
    pub trips: Vec<TileTrip>,
    pub routes: Vec<TileRoute>,
    pub services: Vec<TileService>,
    /// Per-stop parallel columns (trip_idx, dep_secs), pairSortByB-sorted,
    /// indexed by stop position in `stops`. Rows with dep == 0xFFFFFFFF
    /// (missing-departure sentinel) are skipped, mirroring
    /// buildPtnbStreamedShape.
    pub stop_times: Vec<(Vec<u32>, Vec<u32>)>,
    pub route_styles: HashMap<String, RouteStyle>,
}

/// Expand a per-service PTB active-day bitmask into ascending `YYYYMMDD`
/// strings, one per active day in `[0, window_days)`. Bit `d` of `mask`
/// (byte `d >> 3`, bit `d & 7`, LSB-first — see `pt_core::reader::service_active_bit`,
/// which uses the identical convention as the TS `(byte >> (d & 7)) & 1` in
/// `synthCalendarDates`) set ⇒ `anchor + d days` is pushed.
///
/// Iterating the FULL `window_days` is load-bearing: a hardcoded 90 would
/// silently drop every active day in `90..window_days` for a horizon-extended
/// feed (mirrors the doc-comment warning on `synthCalendarDates` in
/// loadFromPtb.ts).
pub(crate) fn expand_bitmask_dates(
    mask: &[u8],
    window_days: u32,
    anchor: jiff::civil::Date,
) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for d in 0..window_days {
        if pt_core::reader::service_active_bit(mask, d) {
            use jiff::ToSpan;
            let date = anchor
                .checked_add(i64::from(d).days())
                .map_err(|_| Error::Config("service window exceeds supported date range".into()))?;
            out.push(date.strftime("%Y%m%d").to_string());
        }
    }
    Ok(out)
}

/// One `route-styles.json` entry, pre-mapping. `color`/`subMode` are optional
/// (missing key ⇒ `None`); `textColor` is parsed (so an unexpected-shape
/// document still deserializes) but deliberately not carried into
/// [`RouteStyle`] — nothing in the tile build reads it.
#[derive(serde::Deserialize)]
struct RawRouteStyle {
    color: Option<String>,
    #[serde(rename = "textColor")]
    #[allow(dead_code)]
    text_color: Option<String>,
    #[serde(rename = "subMode")]
    sub_mode: Option<String>,
}

/// Parse the `route-styles.json` artifact (`{ <routeId>: { color?, textColor?,
/// subMode? } }`, written by `color-artifacts-gen.mjs`) into a route-id keyed
/// map. Colors are taken verbatim — this function does NOT recompute them.
pub(crate) fn parse_route_styles(bytes: &[u8]) -> Result<HashMap<String, RouteStyle>> {
    let raw: HashMap<String, RawRouteStyle> = serde_json::from_slice(bytes)
        .map_err(|e| Error::Config(format!("route-styles.json parse error: {e}")))?;
    let mut out = HashMap::with_capacity(raw.len());
    for (route_id, r) in raw {
        out.insert(
            route_id,
            RouteStyle {
                color: r.color,
                sub_mode: r.sub_mode,
            },
        );
    }
    Ok(out)
}

/// `feed_start_date` (u32 `YYYYMMDD`, from `Reader::feed_start_date()`) → the
/// calendar-date anchor `expand_bitmask_dates` expands against.
///
/// `0` is the documented "no dated services" sentinel, NOT a malformed date:
/// both this crate's `sidecars.rs::format_ymd` and the TS `feedStartDateIso`
/// (packages/shared/src/ptb/sidecars.ts) anchor it at `1970-01-01` — mirror
/// them rather than hard-failing a valid (if empty) bundle.
fn feed_start_date_to_naive(feed_start_date: u32) -> Result<jiff::civil::Date> {
    if feed_start_date == 0 {
        // Unwrap is fine: 1970-01-01 is a valid calendar date by construction.
        return Ok(jiff::civil::Date::constant(1970, 1, 1));
    }
    pt_shared::tz::date_from_ymd(feed_start_date).ok_or_else(|| {
        Error::Config(format!(
            "invalid feed_start_date {feed_start_date}: not a valid YYYYMMDD calendar date"
        ))
    })
}

/// Load the tile-build inputs from a staging directory containing a staged
/// `bundle.ptb` (read via the pt-core `Reader` — no new PTB byte parsing here)
/// and a `route-styles.json` sibling (written by the color-artifacts step).
pub fn load_tile_inputs(staging_dir: &Path) -> Result<TileInputs> {
    let ptb_path = staging_dir.join("bundle.ptb");
    let bytes = std::fs::read(&ptb_path)
        .map_err(|e| Error::Config(format!("failed to read {}: {e}", ptb_path.display())))?;
    let reader = pt_core::Reader::from_bytes(bytes)
        .map_err(|e| Error::Config(format!("failed to parse {}: {e}", ptb_path.display())))?;

    // Stops in PTB region order — THE stop iteration order for the whole build.
    let num_stops = reader.num_stops();
    let mut stops = Vec::with_capacity(num_stops);
    for i in 0..num_stops {
        let stop = reader
            .stop(i)
            .map_err(|e| Error::Config(format!("stop {i}: {e}")))?;
        // Coordinates via the EXACT f64 accessors, not `stop.stop_lat as f64`:
        // for current SoA bundles the `Stop` record's f32 lat/lon are a lossy
        // narrowing of the canonical `i32@1e7` columns (see the doc comment on
        // `Reader::stop`); `stop_lat_f64`/`stop_lon_f64` decode the column
        // exactly, matching the TypeScript loader's f64 decode.
        let lat = reader
            .stop_lat_f64(i)
            .map_err(|e| Error::Config(format!("stop {i} lat: {e}")))?;
        let lon = reader
            .stop_lon_f64(i)
            .map_err(|e| Error::Config(format!("stop {i} lon: {e}")))?;
        stops.push(TileStop {
            id: stop.stop_id,
            lat,
            lon,
        });
    }

    // Routes in PTB region order.
    let num_routes = reader.num_routes();
    let mut routes = Vec::with_capacity(num_routes);
    for i in 0..num_routes {
        let route = reader
            .route(i)
            .map_err(|e| Error::Config(format!("route {i}: {e}")))?;
        routes.push(TileRoute {
            route_id: route.route_id,
            short_name: route.short_name,
            long_name: route.long_name,
            route_color: route.route_color,
            route_type: route.route_type,
        });
    }

    // Trips in PTB region order.
    let num_trips = reader.num_trips();
    let mut trips = Vec::with_capacity(num_trips);
    for i in 0..num_trips {
        let trip = reader
            .trip(i)
            .map_err(|e| Error::Config(format!("trip {i}: {e}")))?;
        trips.push(TileTrip {
            trip_id: trip.trip_id,
            route_idx: trip.route_idx,
            service_idx: trip.service_idx,
            headsign: trip.headsign,
        });
    }

    // Per-stop (trip_idx, dep_secs) columns. PTB's StopTimes region is grouped
    // by trip in ascending trip-index order with an explicit `tripStarts[]`
    // prefix-sum, so scanning ti = 0..num_trips and each trip's
    // [tripStarts[ti], tripStarts[ti+1]) row range visits every stop_time row
    // exactly once, trip-ordinal-then-stop_seq order (mirrors
    // buildPtnbStreamedShape's single pass in loadFromPtb.ts).
    //
    // `tripIdIdx == ti` holds here because the Node side interns trip ids in
    // ti order over unique ids (`tripStrings.intern(tripId)` called once per
    // ti, ascending) — so pushing the raw trip ordinal `ti` reproduces the
    // same per-stop column values the TS `U32PairBuilder` accumulates.
    let mut stop_times: Vec<(Vec<u32>, Vec<u32>)> =
        (0..num_stops).map(|_| (Vec::new(), Vec::new())).collect();
    let trip_starts = reader
        .trip_starts()
        .map_err(|e| Error::Config(format!("trip_starts: {e}")))?;
    // Read rows through a cursor rather than `reader.stop_time(row)` directly.
    // In current PTB v1 the temporary `0xF4` region is absent, so each bare
    // `stop_time` re-derives the band addressing from scratch: an O(k) scan of
    // the pattern's trip list plus several O(p) slab prefix walks, per row.
    // Over this full-table sweep that is quadratic — the same cost that made
    // paris spend 321 s of a 366 s cold load in `build_stop_membership`. The
    // cursor pays the two precomputes once and answers each row with slice
    // math; on a carry-bearing bundle it delegates to `stop_time` unchanged.
    let cursor = pt_core::stop_time_cursor::StopTimeCursor::new(&reader)
        .map_err(|e| Error::Config(format!("stop-time cursor: {e}")))?;
    for ti in 0..num_trips {
        let lo = trip_starts[ti] as usize;
        let hi = trip_starts[ti + 1] as usize;
        for (pos, row) in (lo..hi).enumerate() {
            let st = cursor
                .stop_time_in_trip(&reader, ti, pos)
                .map_err(|e| Error::Config(format!("stop_time {row}: {e}")))?;
            // Skip missing-departure sentinel rows — they would otherwise sort
            // to the front and confuse departure lookups (mirrors
            // buildPtnbStreamedShape's stopBuilders push guard).
            if st.dep_secs == MISSING_DEP_SENTINEL {
                continue;
            }
            let stop_idx = st.stop_idx as usize;
            let (trip_idxs, deps) = stop_times.get_mut(stop_idx).ok_or_else(|| {
                Error::Config(format!(
                    "stop_time row {row} references stop_idx={stop_idx} but stops table has only {num_stops} entries"
                ))
            })?;
            trip_idxs.push(ti as u32);
            deps.push(st.dep_secs);
        }
    }
    for (trip_idxs, deps) in stop_times.iter_mut() {
        let len = trip_idxs.len();
        pair_sort_by_b(trip_idxs, deps, 0, len);
    }

    // Producer-mode calendar synth: all-false placeholder services (the
    // per-service weekday/date-range fields carry no signal — see
    // synthServices in loadFromPtb.ts) plus bitmask-expanded "added"
    // calendar_dates rows (synthCalendarDates).
    let feed_start_date = reader.feed_start_date();
    let anchor = feed_start_date_to_naive(feed_start_date)?;
    let window_days = u32::from(reader.window_days());
    let num_services = reader.num_services();
    let mut services = Vec::with_capacity(num_services as usize);
    for i in 0..num_services {
        let mask = reader.service_bitmask(i);
        let added = expand_bitmask_dates(mask, window_days, anchor)?;
        services.push(TileService {
            service_id: format!("svc:{i}"),
            added,
        });
    }

    // route-styles.json — written by the color-artifacts step; colors are
    // consumed verbatim, never recomputed here.
    let styles_path = staging_dir.join("route-styles.json");
    if !styles_path.exists() {
        return Err(Error::Config(format!(
            "route-styles.json not found at {}; the color-artifacts step must run first",
            styles_path.display()
        )));
    }
    let styles_bytes = std::fs::read(&styles_path)
        .map_err(|e| Error::Config(format!("failed to read {}: {e}", styles_path.display())))?;
    let route_styles = parse_route_styles(&styles_bytes)?;

    Ok(TileInputs {
        stops,
        trips,
        routes,
        services,
        stop_times,
        route_styles,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        expand_bitmask_dates, feed_start_date_to_naive, load_tile_inputs, parse_route_styles,
        TileInputs,
    };

    #[test]
    fn feed_start_date_zero_anchors_at_epoch() {
        // 0 = "no dated services" sentinel — mirrors sidecars.rs::format_ymd
        // and the TS feedStartDateIso (packages/shared/src/ptb/sidecars.ts),
        // both of which anchor it at 1970-01-01 instead of erroring.
        assert_eq!(
            feed_start_date_to_naive(0).unwrap(),
            jiff::civil::Date::new(1970, 1, 1).unwrap()
        );
        // A genuinely malformed date still hard-fails.
        assert!(feed_start_date_to_naive(20261301).is_err());
    }

    #[test]
    fn bitmask_expands_full_window_ascending() {
        // windowDays 100, active on days 0, 9, 95 — day 95 proves the loop runs
        // the FULL window (a hardcoded 90 would drop it).
        let mut mask = vec![0u8; 13];
        for d in [0u32, 9, 95] {
            mask[(d >> 3) as usize] |= 1 << (d & 7);
        }
        let added =
            expand_bitmask_dates(&mask, 100, jiff::civil::Date::new(2026, 7, 1).unwrap()).unwrap();
        assert_eq!(added, vec!["20260701", "20260710", "20261004"]);
    }

    #[test]
    fn bitmask_date_overflow_is_an_error_not_a_panic() {
        assert!(expand_bitmask_dates(&[0b11], 2, jiff::civil::Date::MAX).is_err());
    }

    #[test]
    fn route_style_missing_keys_are_none() {
        let json = br#"{"R1": {"textColor": "000000"}}"#;
        let styles = parse_route_styles(json).unwrap();
        let r1 = &styles["R1"];
        assert_eq!(r1.color, None);
        assert_eq!(r1.sub_mode, None);
    }

    #[test]
    fn route_style_present_keys_are_some() {
        let json =
            br#"{"R1": {"color": "ff0000", "textColor": "000000", "subMode": "EXPRESS_BUS"}}"#;
        let styles = parse_route_styles(json).unwrap();
        let r1 = &styles["R1"];
        assert_eq!(r1.color.as_deref(), Some("ff0000"));
        assert_eq!(r1.sub_mode.as_deref(), Some("EXPRESS_BUS"));
    }

    // Smoke-load a real committed differential fixture through
    // load_tile_inputs (bundle.ptb + `{}` route-styles.json in a tempdir) and
    // run the shared sanity assertions. The full loader is integration-covered
    // by a later differential gate; this is just a "does it load, are per-stop
    // columns sorted" check.
    fn smoke_load(fixture: &str) -> TileInputs {
        let fixture_path = format!(
            "{}/../../packages/frontend/tests/services/__fixtures__/{fixture}",
            env!("CARGO_MANIFEST_DIR")
        );
        let bytes =
            std::fs::read(&fixture_path).unwrap_or_else(|e| panic!("{fixture} fixture reads: {e}"));

        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("bundle.ptb"), &bytes).expect("write bundle.ptb");
        std::fs::write(dir.path().join("route-styles.json"), b"{}")
            .expect("write route-styles.json");

        let inputs = load_tile_inputs(dir.path())
            .unwrap_or_else(|e| panic!("{fixture} loads via load_tile_inputs: {e}"));
        assert!(!inputs.stops.is_empty());
        assert!(!inputs.trips.is_empty());
        assert_eq!(inputs.stop_times.len(), inputs.stops.len());
        for (trip_idxs, deps) in &inputs.stop_times {
            assert_eq!(trip_idxs.len(), deps.len());
            assert!(
                deps.windows(2).all(|w| w[0] <= w[1]),
                "per-stop dep column not sorted ({fixture})"
            );
        }
        inputs
    }

    #[test]
    fn loads_three_leg_fixture_with_sorted_stop_time_columns() {
        // Compact committed fixture.
        smoke_load("three-leg.ptb");
    }

    #[test]
    fn loads_current_soa_fixture_with_exact_f64_coords() {
        // example-city.ptb is a current PTB v1 bundle built by the producer —
        // the path where the
        // convenience `Reader::stop()` record is LOSSY f32 and the
        // `stop_lat_f64`/`stop_lon_f64` accessors are required. Cross-check the
        // loaded coords against the exact accessors to pin the loader to the
        // f64 path.
        let inputs = smoke_load("example-city.ptb");

        let fixture_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/frontend/tests/services/__fixtures__/example-city.ptb"
        );
        let bytes = std::fs::read(fixture_path).expect("example-city.ptb fixture reads");
        let reader = pt_core::Reader::from_bytes(bytes).expect("example-city.ptb parses");
        for (i, stop) in inputs.stops.iter().enumerate() {
            assert_eq!(stop.lat, reader.stop_lat_f64(i).unwrap(), "stop {i} lat");
            assert_eq!(stop.lon, reader.stop_lon_f64(i).unwrap(), "stop {i} lon");
        }
    }
}
