//! `GET /api/<city>/stops/all` — byte-shape-identical to the Node backend's `getStopsAll`
//! (`packages/backend/src/routes/stops.ts` → `GtfsStore.getAllStops`, `store.ts:282-325`).
//!
//! The body is the backend's `{ data: StopRecord[], lastUpdated }` envelope.
//! Each stop is composed from FOUR sources, ALL resolved at generation LOAD (the
//! whole body is serialized ONCE in [`build_stops_all_body`] and stored on
//! [`crate::bundle::Generation::stops_all_body`]; the handler serves the cached
//! bytes verbatim — never per-request, mirroring the backend's memoized
//! `allStopsCache`):
//!   1. the mmapped [`pt_core::Reader`] — stop `id`/`name`/`location` + per-route
//!      `shortName`/`mode`,
//!   2. `route-styles.json` (`Generation::route_styles`) — per-route
//!      `{color, textColor, subMode}` (already 6-hex-no-`#`, textColor ∈
//!      {`000000`,`FFFFFF`}, subMode set),
//!   3. `label-anchors.json` (`Generation::label_anchors`) — per-stop anchor
//!      string (KEY OMITTED when the stop has none — never `null`),
//!   4. the at-load `Generation::stop_membership` (`Vec<Vec<u32>>`, all-trips
//!      union in FIRST-SEEN route order) — the per-stop route list.
//!
//! Stop order is `0..num_stops()` = the `.ptb` stop-region order = the backend
//! `iterStops` order. Zero-route stops ARE emitted (`routes: []`).
//!
//! ## Parity invariants (the order-strict `/stops` gate hangs on these)
//! - `color`/`textColor`: 6-hex WITHOUT a leading `#`; `textColor` ∈
//!   {`000000`,`FFFFFF`}.
//! - `subMode`: ALWAYS emitted (the backend does `sm ?? route.mode`) — never skip.
//! - `labelAnchor`: present-with-value when the stop has one, KEY OMITTED when
//!   absent (`#[serde(skip_serializing_if = "Option::is_none")]`) — NEVER `null`.
//! - `location` is nested `{lat, lon}`; there is NO top-level lat/lon and NO
//!   `parentStationId`.

use crate::app::response::{ByteBody, Resp};
use crate::bundle::Generation;
use crate::domain::mode::route_type_to_mode;
use crate::mmap::MmapBytes;
use pt_core::Reader;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// One route entry under a stop. Field order + serde renames are parity-exact
/// with the backend `StopWithRoutes["routes"]` element.
#[derive(Serialize)]
pub struct RouteEntry {
    pub id: String,
    #[serde(rename = "shortName")]
    pub short_name: String,
    /// 6-hex, NO leading `#`.
    pub color: String,
    /// `000000` or `FFFFFF`.
    #[serde(rename = "textColor")]
    pub text_color: String,
    /// Canonical UPPERCASE mode (`route_type_to_mode`).
    pub mode: &'static str,
    /// ALWAYS emitted — the backend does `sm ?? route.mode`, so this is never
    /// absent.
    #[serde(rename = "subMode")]
    pub sub_mode: String,
}

/// Nested `{lat, lon}` location. There is NO top-level lat/lon on the stop.
#[derive(Serialize)]
pub struct Location {
    pub lat: f64,
    pub lon: f64,
}

/// One stop record. Parity-exact with the backend `StopWithRoutes`.
#[derive(Serialize)]
pub struct StopRecord {
    pub id: String,
    pub name: String,
    pub location: Location,
    pub routes: Vec<RouteEntry>,
    /// Present-with-value when the stop has a label anchor; the KEY is OMITTED
    /// when absent (the backend emits `this.labelAnchors.get(id)` = `undefined`
    /// → JSON omits it). NEVER `null`.
    #[serde(rename = "labelAnchor", skip_serializing_if = "Option::is_none")]
    pub label_anchor: Option<String>,
}

/// The `{ data, lastUpdated }` envelope. `lastUpdated` is the bundle's last-
/// update time as an ISO-8601 string (or `null` when unavailable).
#[derive(Serialize)]
struct StopsAllBody {
    data: Vec<StopRecord>,
    #[serde(rename = "lastUpdated")]
    last_updated: Option<String>,
}

/// A precomputed per-route style, parsed once at load from `route-styles.json`.
/// Matches the producer's `route-styles.json` element shape (`color-artifacts-
/// gen.mjs`): `{ "<routeId>": { color, textColor, subMode } }`.
///
/// `pub(crate)` (with `pub(crate)` fields) so [`crate::bundle::Generation`] can
/// hold the parsed `routeId -> RouteStyle` map directly (parsed once at load,
/// shared by the `/stops/all` body build AND the per-request `/stops/nearby`
/// compose — never re-parsed on a blocking worker).
#[derive(serde::Deserialize)]
pub struct RouteStyle {
    pub(crate) color: String,
    #[serde(rename = "textColor")]
    pub(crate) text_color: String,
    #[serde(rename = "subMode")]
    pub(crate) sub_mode: String,
}

/// Spatial-grid cell size in degrees. Replicates the backend's
/// `GtfsStore.SPATIAL_CELL_DEG = 0.005` (`store.ts:152`, ~500m) EXACTLY — the
/// cell-key arithmetic + traversal range must match for `/stops/nearby` order
/// parity.
const SPATIAL_CELL_DEG: f64 = 0.005;

/// Equirectangular distance in meters between two lat/lon points. Ported
/// field-exact from the backend `distanceMeters` (`store.ts:56-67`): NOT
/// haversine. Accurate enough for the short radii `/stops/nearby` uses and —
/// critically — byte-shape-identical to what the backend filter computes, so
/// the strict `> radius` exclusion picks the SAME stops.
fn distance_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let avg_lat = ((lat1 + lat2) / 2.0) * to_rad;
    let dx = (lon2 - lon1) * to_rad * avg_lat.cos() * 6_371_000.0;
    let dy = (lat2 - lat1) * to_rad * 6_371_000.0;
    (dx * dx + dy * dy).sqrt()
}

/// Floor `coord / SPATIAL_CELL_DEG` to a cell index. Uses `f64::floor` (NOT an
/// `as i32` truncation) so NEGATIVE coordinates floor toward -∞, matching JS
/// `Math.floor` (`store.ts:1265`/`335-338`) — a southern/western-hemisphere
/// feed would otherwise mis-bucket and break order parity.
fn cell_of(coord: f64) -> i32 {
    (coord / SPATIAL_CELL_DEG).floor() as i32
}

/// Build the spatial grid `(cellLat, cellLon) -> [stop_idx]` over
/// `0..num_stops()`, mirroring the backend `buildSpatialGrid`
/// (`store.ts:1261-1271`): iterate stops in stop-region (= `iterStops`) order
/// and push each stop's index onto its cell bucket. The per-bucket order IS the
/// `/stops/nearby` within-cell response order. Built ONCE at load (off the
/// request path) and stored on [`crate::bundle::Generation::spatial_grid`].
pub(crate) fn build_spatial_grid(reader: &Reader<MmapBytes>) -> HashMap<(i32, i32), Vec<u32>> {
    let num_stops = reader.num_stops();
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for stop_idx in 0..num_stops {
        // Use the SAME coordinate accessors the distance filter uses, so the
        // grid cell a stop lands in is consistent with the lat/lon the filter
        // re-reads (a stop with unreadable coords defaults to 0.0 in both —
        // the backend's `getStop` would simply not bucket such a stop, but the
        // PTB reader always yields a coordinate).
        let lat = reader.stop_lat_f64(stop_idx).unwrap_or(0.0);
        let lon = reader.stop_lon_f64(stop_idx).unwrap_or(0.0);
        grid.entry((cell_of(lat), cell_of(lon)))
            .or_default()
            .push(stop_idx as u32);
    }
    grid
}

/// The backend's `contrastTextColor` (`store.ts:81-90`), ported field-exact.
/// Returns `"000000"` for a light color (relative luminance `> 0.179`), else
/// `"FFFFFF"`. Mirrors the backend's `=== "#000000" ? "000000" : "FFFFFF"`
/// branch — a `< 6`-hex input yields white. The `hex` may carry a leading `#`.
fn contrast_text_color(hex: &str) -> &'static str {
    let h = hex.strip_prefix('#').unwrap_or(hex);
    if h.len() < 6 {
        return "FFFFFF";
    }
    let chan = |a: usize| -> Option<f64> {
        u8::from_str_radix(&h[a..a + 2], 16)
            .ok()
            .map(|v| f64::from(v) / 255.0)
    };
    let (r, g, b) = match (chan(0), chan(2), chan(4)) {
        (Some(r), Some(g), Some(b)) => (r, g, b),
        // A malformed (non-hex) channel mirrors `parseInt` → NaN in JS; the
        // backend's luminance comparison `L > 0.179` is then `false` → white.
        _ => return "FFFFFF",
    };
    let to_linear = |c: f64| -> f64 {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let l = 0.2126 * to_linear(r) + 0.7152 * to_linear(g) + 0.0722 * to_linear(b);
    if l > 0.179 {
        "000000"
    } else {
        "FFFFFF"
    }
}

/// Parse `route-styles.json` bytes into a `routeId -> RouteStyle` map. A missing
/// or malformed blob yields an empty map (every route then takes the defensive
/// reader-color fallback — the backend never ships a malformed file).
pub(crate) fn parse_route_styles(bytes: Option<&[u8]>) -> HashMap<String, RouteStyle> {
    bytes
        .and_then(|b| serde_json::from_slice::<HashMap<String, RouteStyle>>(b).ok())
        .unwrap_or_default()
}

/// Parse `label-anchors.json` bytes into a `stopId -> anchor` map. The producer
/// writes a flat object `{ "<stopId>": "<anchor>" }`. A missing/malformed blob
/// yields an empty map (every stop then omits `labelAnchor`).
pub(crate) fn parse_label_anchors(bytes: Option<&[u8]>) -> HashMap<String, String> {
    bytes
        .and_then(|b| serde_json::from_slice::<HashMap<String, String>>(b).ok())
        .unwrap_or_default()
}

/// Resolve `lastUpdated`. The backend's `store.getLastUpdated()` is the bundle's
/// last-update `Date`, JSON-serialized via `Date.prototype.toISOString()` =
/// `YYYY-MM-DDTHH:mm:ss.sssZ`. The closest `Generation` timestamp is
/// `created_at` (the manifest's ISO-8601 build time, format
/// `YYYY-MM-DDTHH:MM:SSZ`). When present + strict-parseable we reshape it to the
/// millis form (`<sec>.000Z`) so the body matches the JS Date shape; otherwise
/// `None` → serialized `null` (the `from_paths` test path leaves `created_at`
/// empty). The parity gate normalizes `lastUpdated` to presence + format, not
/// the exact instant.
fn last_updated_from(created_at: &str) -> Option<String> {
    // Validate the strict 20-char `YYYY-MM-DDTHH:MM:SSZ` grammar before
    // reshaping, reusing the same validator `/ready` parses `created_at` with.
    crate::ops::readiness::parse_rfc3339_utc(created_at)?;
    // Reshape `…SSZ` → `…SS.000Z` (insert millis before the trailing `Z`).
    let without_z = &created_at[..created_at.len() - 1];
    Some(format!("{without_z}.000Z"))
}

/// Build one [`StopRecord`] for `stop_idx`, composing the reader, route-styles, label-anchors, and
/// membership. Factored out so the `/stops/nearby` can reuse the exact compose logic (same parity
/// invariants).
///
/// `route_styles` / `label_anchors` are the parsed maps; passing them in keeps
/// the per-stop build allocation-free of re-parsing.
pub fn build_stop_record(
    gen: &Generation,
    stop_idx: usize,
    route_styles: &HashMap<String, RouteStyle>,
    label_anchors: &HashMap<String, String>,
) -> StopRecord {
    let reader = &gen.reader;
    let id = reader.stop_id(stop_idx).unwrap_or("").to_string();
    let name = reader.stop_name(stop_idx).unwrap_or("").to_string();
    let lat = reader.stop_lat_f64(stop_idx).unwrap_or(0.0);
    let lon = reader.stop_lon_f64(stop_idx).unwrap_or(0.0);

    let membership = gen.stop_membership.get(stop_idx);
    let route_ids = membership.map(|v| v.as_slice()).unwrap_or(&[]);
    let mut routes: Vec<RouteEntry> = Vec::with_capacity(route_ids.len());
    for &ri in route_ids {
        let ri = ri as usize;
        let route_id = reader.route_id(ri).unwrap_or("").to_string();
        let short_name = reader.route_short_name(ri).unwrap_or("").to_string();
        let mode = route_type_to_mode(reader.route_type(ri).unwrap_or(3));

        let (color, text_color, sub_mode) = match route_styles.get(&route_id) {
            // Normal case: route-styles carries every route. Use it verbatim
            // (already 6-hex-no-`#`, textColor 000000/FFFFFF, subMode set).
            Some(style) => (
                style.color.clone(),
                style.text_color.clone(),
                style.sub_mode.clone(),
            ),
            // Defensive fallback (mirrors the backend `store.ts:299,304,306`
            // path when a route is missing from the style map): strip any
            // leading `#` off the reader color, derive textColor via the
            // contrast rule, and use the mode string as subMode.
            None => {
                let raw = reader.route_color(ri).unwrap_or("");
                let color = raw.strip_prefix('#').unwrap_or(raw).to_string();
                let text_color = contrast_text_color(raw).to_string();
                (color, text_color, mode.to_string())
            }
        };

        routes.push(RouteEntry {
            id: route_id,
            short_name,
            color,
            text_color,
            mode,
            sub_mode,
        });
    }

    let label_anchor = label_anchors.get(&id).cloned();

    StopRecord {
        id,
        name,
        location: Location { lat, lon },
        routes,
        label_anchor,
    }
}

/// Build the full `/stops/all` body bytes ONCE at generation load. Called from
/// [`Generation::new`] after `stop_membership` + the parsed maps are built; the
/// result is stored on `Generation::stops_all_body` and served verbatim by
/// [`stops_all`].
///
/// Uses the at-load-parsed `gen.route_styles_map` / `gen.label_anchors_map`
/// (NOT a local re-parse) — the same maps `/stops/nearby` composes against, so
/// the parse happens exactly once per generation. Output is unchanged from the
/// previous local-parse version (the maps are parsed by the identical
/// [`parse_route_styles`] / [`parse_label_anchors`] in `Generation::new`).
pub fn build_stops_all_body(gen: &Generation) -> Arc<[u8]> {
    let num_stops = gen.reader.num_stops();
    let mut data: Vec<StopRecord> = Vec::with_capacity(num_stops);
    for stop_idx in 0..num_stops {
        data.push(build_stop_record(
            gen,
            stop_idx,
            &gen.route_styles_map,
            &gen.label_anchors_map,
        ));
    }

    let body = StopsAllBody {
        data,
        last_updated: last_updated_from(&gen.created_at),
    };
    // Serialization of an owned, well-typed struct cannot fail; fall back to an
    // empty-envelope body rather than panicking at load.
    let bytes =
        serde_json::to_vec(&body).unwrap_or_else(|_| br#"{"data":[],"lastUpdated":null}"#.to_vec());
    Arc::from(bytes.into_boxed_slice())
}

/// `GET /api/<city>/stops/all` — serve the memoized body verbatim. Cache-Control
/// mirrors the backend (`public, max-age=300`).
///
pub fn stops_all(query: &str, gen: &Generation) -> Resp {
    // Detect `withinHours` presence: strip a leading `?`, then scan key=value
    // pairs. Presence alone is enough — we narrow ALL withinHours to 400.
    let q = query.strip_prefix('?').unwrap_or(query);
    let has_within_hours = q
        .split('&')
        .any(|pair| pair.split_once('=').map(|(k, _)| k).unwrap_or(pair) == "withinHours");
    if has_within_hours {
        return Resp::Json {
            status: 400,
            body: serde_json::json!({
                "error": {
                    "code": "INVALID_PARAMS",
                    "message": "withinHours is not supported"
                }
            })
            .to_string(),
        };
    }
    Resp::CachedBytes {
        status: 200,
        body: ByteBody::Raw(Arc::clone(&gen.stops_all_body)),
        content_type: "application/json",
        cache_control: "public, max-age=300",
        etag: None,
        gzipped: false,
    }
}

/// One scalar query param, raw (NOT urldecoded — the three `/stops/nearby`
/// numeric fields are digits/`.`/`-` that never `%`-escape; matching the
/// backend Fastify querystring parse without pulling in the loopback
/// urldecoder). A leading `?` is stripped; last value wins.
fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    let q = query.strip_prefix('?').unwrap_or(query);
    let mut found = None;
    for pair in q.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            found = Some(v);
        }
    }
    found
}

/// JS `Number(s)` faithful enough for the finite-check: trim (JS `Number`
/// trims surrounding whitespace) then parse as `f64`. A parse failure → `NaN`
/// so the caller's `is_finite()` gate rejects it the same way `Number.isFinite`
/// rejects JS `NaN`/`Infinity`. (JS `Number("")` is `0`, but the blank case is
/// caught earlier by the trim-emptiness check, mirroring the backend's
/// `!lat?.trim()` guard.)
fn js_number(s: &str) -> f64 {
    s.trim().parse::<f64>().unwrap_or(f64::NAN)
}

/// A 400 `{ error: { code, message } }` body — parity-exact with the backend
/// `reply.status(400).send({ error: { code, message } })` shape (`stops.ts`).
fn err_400(code: &str, message: &str) -> Resp {
    Resp::Json {
        status: 400,
        body: serde_json::json!({ "error": { "code": code, "message": message } }).to_string(),
    }
}

/// `GET /api/<city>/stops/nearby?lat=&lon=&radius=` — byte-shape-identical to
/// the backend `getStopsNearby` (`packages/backend/src/routes/stops.ts:9-46`) +
/// `GtfsStore.getNearbyStops` (`store.ts:327-381`).
///
/// Composes per request (parameterized by `lat`/`lon`/`radius`) over the
/// at-load-built `gen.spatial_grid` + the at-load-parsed `gen.route_styles_map`
/// / `gen.label_anchors_map`. Body is `{ data: StopRecord[] }` — **NO
/// `lastUpdated`** (the backend's nearby route omits it, `stops.ts:45`).
///
/// ## Parity invariants
/// - **Errors** (`stops.ts:15-34`, code-exact): missing/blank `lat` or `lon`
///   → 400 `MISSING_PARAMS`; non-finite `lat`/`lon` → 400 `INVALID_PARAMS`;
///   `radius` defaulting to **1000** when absent/blank; non-finite or
///   `<= 0` radius → 400 `INVALID_PARAMS`.
/// - **Distance** = equirectangular ([`distance_meters`]); exclusion is strict
///   `> radius`, so a stop EXACTLY at `radius` is INCLUDED.
/// - **Cell range** mirrors `store.ts:332-338` (radiusLatDeg/cosLat clamp/
///   radiusLonDeg → floored min/max cells). Parity-faithful limitation: a stop
///   exactly at the radius can be missed when the `radius/111320` bound floors
///   just past its cell — IDENTICAL to the backend's arithmetic, so both servers
///   agree (the parity gate stays green). Do NOT "fix" this in isolation, or the
///   result set / order diverges from the backend.
/// - **Traversal** `cy` outer (min..=max), `cx` inner (min..=max); within a
///   bucket, stop-region insertion order. This IS the response order.
/// - **Cache-Control** `public, max-age=300` (`stops.ts:44`).
pub fn stops_nearby(query: &str, gen: &Generation) -> Resp {
    // (1) lat/lon required + finite (mirrors stops.ts:15-27).
    let lat_raw = query_param(query, "lat");
    let lon_raw = query_param(query, "lon");
    if lat_raw.map(str::trim).unwrap_or("").is_empty()
        || lon_raw.map(str::trim).unwrap_or("").is_empty()
    {
        return err_400("MISSING_PARAMS", "lat and lon are required");
    }
    let lat = js_number(lat_raw.unwrap());
    let lon = js_number(lon_raw.unwrap());
    if !lat.is_finite() || !lon.is_finite() {
        return err_400("INVALID_PARAMS", "lat and lon must be valid numbers");
    }

    // (2) radius optional, default 1000; finite + > 0 (mirrors stops.ts:29-34).
    let radius_raw = query_param(query, "radius");
    let radius = match radius_raw.map(str::trim) {
        Some(r) if !r.is_empty() => js_number(r),
        _ => 1000.0,
    };
    if !radius.is_finite() || radius <= 0.0 {
        return err_400("INVALID_PARAMS", "radius must be a positive number");
    }

    // (3) Cell range — replicates store.ts:332-338 EXACTLY.
    let radius_lat_deg = radius / 111_320.0;
    let cos_lat = (lat * std::f64::consts::PI / 180.0).cos().max(0.01);
    let radius_lon_deg = radius / (111_320.0 * cos_lat);
    let min_cell_lat = cell_of(lat - radius_lat_deg);
    let max_cell_lat = cell_of(lat + radius_lat_deg);
    let min_cell_lon = cell_of(lon - radius_lon_deg);
    let max_cell_lon = cell_of(lon + radius_lon_deg);

    // (4) Traverse cy outer / cx inner; within-bucket insertion order; strict
    // `> radius` exclusion (store.ts:341-377). Compose each included stop with
    // the SAME `build_stop_record` /stops/all uses (parity-exact StopRecord).
    let reader = &gen.reader;
    let mut data: Vec<StopRecord> = Vec::new();
    for cy in min_cell_lat..=max_cell_lat {
        for cx in min_cell_lon..=max_cell_lon {
            let Some(bucket) = gen.spatial_grid.get(&(cy, cx)) else {
                continue;
            };
            for &stop_idx in bucket {
                let si = stop_idx as usize;
                let slat = reader.stop_lat_f64(si).unwrap_or(0.0);
                let slon = reader.stop_lon_f64(si).unwrap_or(0.0);
                if distance_meters(lat, lon, slat, slon) > radius {
                    continue;
                }
                data.push(build_stop_record(
                    gen,
                    si,
                    &gen.route_styles_map,
                    &gen.label_anchors_map,
                ));
            }
        }
    }

    // (5) Serialize `{ data }` — NO `lastUpdated` (stops.ts:45).
    let body = serde_json::json!({ "data": data }).to_string();
    Resp::CachedBytes {
        status: 200,
        body: ByteBody::Raw(Arc::from(body.into_bytes().into_boxed_slice())),
        content_type: "application/json",
        cache_control: "public, max-age=300",
        etag: None,
        gzipped: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// One trip spec for [`build_test_ptb`]: `(route_idx, &[(stop_seq, stop_idx,
    /// dep_secs)])`. Aliased to keep the builder/fixture signatures clippy-clean.
    type TripSpec<'a> = (usize, &'a [(u16, u32, u32)]);

    /// Build a PTB with EXPLICIT stop coords/names, EXPLICIT route colors, and
    /// trip topology that yields a controllable all-trips stop membership —
    /// including a STOP WITH ZERO ROUTES. Adapted from the membership-test
    /// builder (`domain/stop_membership.rs`) but writing real stop names/coords +
    /// route colors so the color-fallback path is exercisable.
    ///
    /// `stops`: per-stop `(id, name, lat, lon)`.
    /// `routes`: per-route `(id, short_name, route_type, color, text_color)`.
    /// `trips`: per-trip `(route_idx, &[(stop_seq, stop_idx, dep_secs)])` — these
    ///   drive the all-trips membership union. Trip ids are `T0..`.
    #[allow(clippy::type_complexity)]
    fn build_test_ptb(
        stops: &[(&str, &str, f64, f64)],
        routes: &[(&str, &str, u16, &str, &str)],
        trips: &[TripSpec<'_>],
    ) -> Vec<u8> {
        use pt_core::engine::testkit::{
            all_active_service, build_v1_ptb, numbered_ids, SoaRoute, SoaStop, StopRoutes, V1Feed,
            V1Trip,
        };
        assert!(!stops.is_empty() && !routes.is_empty() && !trips.is_empty());

        // stop→routes CSR — canonical-only (the longest trip per route). The
        // membership union (built by `build_stop_membership` from trip×stop_times)
        // does NOT read this CSR, but `Reader::from_bytes` requires a consistent
        // one. Build it canonical-only to mirror the production probe.
        let mut routes_per_stop: Vec<Vec<u32>> = vec![Vec::new(); stops.len()];
        for r in 0..routes.len() {
            let canonical = trips
                .iter()
                .filter(|(tr, _)| *tr == r)
                .map(|(_, rows)| *rows)
                .max_by_key(|rows| rows.len());
            if let Some(rows) = canonical {
                for &(_, sidx, _) in rows.iter() {
                    let v = &mut routes_per_stop[sidx as usize];
                    if !v.contains(&(r as u32)) {
                        v.push(r as u32);
                    }
                }
            }
        }

        let soa_stops: Vec<SoaStop<'_>> = stops
            .iter()
            .map(|&(id, name, lat, lon)| SoaStop {
                id,
                name,
                lat,
                lon,
                parent: None,
                wheelchair: 0,
            })
            .collect();
        let soa_routes: Vec<SoaRoute<'_>> = routes
            .iter()
            .map(|&(id, short, route_type, color, text_color)| SoaRoute {
                id,
                agency: "",
                short,
                long: "",
                color,
                text_color,
                route_type,
            })
            .collect();
        let trip_ids = numbered_ids("T", trips.len());
        let v1_trips: Vec<V1Trip<'_>> = trips
            .iter()
            .enumerate()
            .map(|(t, &(r, rows))| V1Trip {
                id: &trip_ids[t],
                route: r as u32,
                rows,
                ..V1Trip::default()
            })
            .collect();
        build_v1_ptb(&V1Feed {
            stops: &soa_stops,
            routes: &soa_routes,
            trips: &v1_trips,
            stop_routes: StopRoutes::Given(&routes_per_stop),
            feed_start_date: 20260501,
            city_tz_offset_seconds: 0,
            services: all_active_service(),
            transfers: &[],
            boarding: &[],
            stop_index: false,
        })
    }

    /// A 4-stop / 2-route / 2-trip feed:
    /// - s0,s1,s2 served by R0 (trip on R0 visits all three); s2 also by R1.
    /// - s3 served by NO route (zero-route stop — the `routes: []` case).
    /// - route-styles.json carries ONLY R0 → R1 takes the reader-color fallback.
    /// - label-anchors.json carries an anchor for s0 only.
    struct Fixture {
        _dir: tempfile::TempDir,
        gen: Generation,
    }

    fn build_fixture(route_styles_json: &str, label_anchors_json: &str) -> Fixture {
        let stops = [
            ("S0", "Stop Zero", 54.69, 25.28),
            ("S1", "Stop One", 54.695, 25.285),
            ("S2", "Stop Two", 54.70, 25.29),
            ("S3", "Stop Three", 54.705, 25.295),
        ];
        // R0: type 3 (BUS), color FF0000; R1: type 3, color 00FF00.
        let routes = [
            ("R0", "1", 3u16, "FF0000", "FFFFFF"),
            ("R1", "2", 3u16, "00FF00", "000000"),
        ];
        // trip0 on R0 visits s0,s1,s2; trip1 on R1 visits s2.
        let t0: &[(u16, u32, u32)] = &[(1, 0, 25200), (2, 1, 25260), (3, 2, 25320)];
        let t1: &[(u16, u32, u32)] = &[(1, 2, 40000)];
        let trips: &[TripSpec<'_>] = &[(0, t0), (1, t1)];
        let ptb = build_test_ptb(&stops, &routes, trips);

        let dir = tempfile::TempDir::new().expect("tempdir");
        let ptb_path = dir.path().join("bundle.ptb");
        std::fs::write(&ptb_path, &ptb).unwrap();
        std::fs::write(dir.path().join("route-styles.json"), route_styles_json).unwrap();
        std::fs::write(dir.path().join("label-anchors.json"), label_anchors_json).unwrap();

        let gen = Generation::from_paths(
            &ptb_path,
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("generation loads");
        Fixture { _dir: dir, gen }
    }

    /// route-styles carrying ONLY R0 (R1 missing → fallback path).
    const ROUTE_STYLES: &str =
        r#"{"R0":{"color":"FF0000","textColor":"FFFFFF","subMode":"bus-express"}}"#;
    /// label-anchors with an anchor for s0 only.
    const LABEL_ANCHORS: &str = r#"{"S0":"top-left"}"#;

    fn body_value(json: &[u8]) -> serde_json::Value {
        serde_json::from_slice(json).expect("body parses")
    }

    #[test]
    fn body_parses_as_data_and_last_updated_envelope() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        let v = body_value(&fx.gen.stops_all_body);
        assert!(v.get("data").is_some(), "envelope has data");
        assert!(
            v.get("lastUpdated").is_some(),
            "envelope has lastUpdated key"
        );
        assert_eq!(
            v["data"].as_array().unwrap().len(),
            4,
            "all 4 stops emitted, in 0..num_stops order"
        );
        // Stop order = .ptb stop-region order.
        assert_eq!(v["data"][0]["id"], "S0");
        assert_eq!(v["data"][3]["id"], "S3");
        // location is nested; no top-level lat/lon, no parentStationId.
        assert!(v["data"][0]["location"]["lat"].is_number());
        assert!(v["data"][0]["location"]["lon"].is_number());
        assert!(v["data"][0].get("lat").is_none());
        assert!(v["data"][0].get("parentStationId").is_none());
    }

    #[test]
    fn routes_use_membership_with_route_styles_and_submode_always_present() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        let v = body_value(&fx.gen.stops_all_body);
        // s0 served only by R0 (from route-styles, verbatim).
        let s0_routes = v["data"][0]["routes"].as_array().unwrap();
        assert_eq!(s0_routes.len(), 1);
        assert_eq!(s0_routes[0]["id"], "R0");
        assert_eq!(s0_routes[0]["shortName"], "1");
        assert_eq!(s0_routes[0]["color"], "FF0000");
        assert_eq!(s0_routes[0]["textColor"], "FFFFFF");
        assert_eq!(s0_routes[0]["mode"], "BUS");
        // subMode ALWAYS present — here the route-styles value.
        assert_eq!(s0_routes[0]["subMode"], "bus-express");

        // s2 served by R0 then R1 (first-seen membership order).
        let s2_routes = v["data"][2]["routes"].as_array().unwrap();
        assert_eq!(s2_routes.len(), 2);
        assert_eq!(s2_routes[0]["id"], "R0");
        assert_eq!(s2_routes[1]["id"], "R1");
        // Every route entry carries subMode (never skipped).
        for r in s2_routes {
            assert!(r.get("subMode").is_some(), "subMode always emitted");
        }
    }

    #[test]
    fn label_anchor_present_with_value_and_omitted_when_absent() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        // Assert on the RAW JSON text for the omit-when-absent invariant.
        let raw = std::str::from_utf8(&fx.gen.stops_all_body).unwrap();
        let v = body_value(&fx.gen.stops_all_body);

        // s0 HAS an anchor → present-with-value.
        assert_eq!(v["data"][0]["labelAnchor"], "top-left");
        // s1/s2/s3 have NO anchor → the KEY is omitted (never null).
        assert!(v["data"][1].get("labelAnchor").is_none());
        assert!(v["data"][3].get("labelAnchor").is_none());
        // Hard guard: the raw body must NOT contain a null labelAnchor anywhere.
        assert!(
            !raw.contains(r#""labelAnchor":null"#),
            "labelAnchor must be OMITTED when absent, never serialized as null: {raw}"
        );
    }

    #[test]
    fn zero_route_stop_emits_empty_routes_array() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        let v = body_value(&fx.gen.stops_all_body);
        // s3 is served by no route.
        assert_eq!(v["data"][3]["id"], "S3");
        assert_eq!(
            v["data"][3]["routes"].as_array().unwrap().len(),
            0,
            "zero-route stop emits routes: []"
        );
    }

    #[test]
    fn route_missing_from_route_styles_uses_reader_color_fallback() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        let v = body_value(&fx.gen.stops_all_body);
        // s2's second route R1 is NOT in route-styles → fallback path:
        // color from reader.route_color stripped of '#'; textColor via contrast
        // rule (00FF00 is light → 000000); subMode = mode string.
        let r1 = &v["data"][2]["routes"][1];
        assert_eq!(r1["id"], "R1");
        assert_eq!(r1["color"], "00FF00", "fallback color from reader, no '#'");
        assert_eq!(
            r1["textColor"], "000000",
            "contrast rule: bright green is light → black text"
        );
        assert_eq!(r1["mode"], "BUS");
        assert_eq!(r1["subMode"], "BUS", "fallback subMode = mode string");
    }

    #[test]
    fn last_updated_is_iso8601_string() {
        // `from_paths` leaves `created_at` empty → lastUpdated is null. Drive the
        // pure resolver directly to assert the ISO-8601 reshape on a real stamp.
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        let v = body_value(&fx.gen.stops_all_body);
        assert!(
            v["lastUpdated"].is_null(),
            "from_paths has no manifest createdAt → null"
        );

        // Pure resolver: a valid created_at reshapes to the JS Date toISOString
        // shape `YYYY-MM-DDTHH:mm:ss.sssZ`.
        let s = last_updated_from("2026-05-23T10:00:00Z").expect("parses");
        assert_eq!(s, "2026-05-23T10:00:00.000Z");
        assert_eq!(s.len(), 24);
        // Round-trips through a date parser.
        assert!(
            s.parse::<jiff::Timestamp>().is_ok(),
            "lastUpdated is a valid ISO-8601 instant: {s}"
        );
        // Empty / malformed → None.
        assert!(last_updated_from("").is_none());
        assert!(last_updated_from("not-a-date").is_none());
    }

    #[test]
    fn handler_serves_memoized_bytes_verbatim() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        match stops_all("", &fx.gen) {
            Resp::CachedBytes {
                status,
                body,
                content_type,
                cache_control,
                etag,
                gzipped,
            } => {
                assert_eq!(status, 200);
                assert_eq!(content_type, "application/json");
                assert_eq!(cache_control, "public, max-age=300");
                assert!(etag.is_none());
                assert!(!gzipped);
                // The served body is the SAME Arc as the memoized one (verbatim,
                // not re-serialized per request).
                if let ByteBody::Raw(arc) = body {
                    assert!(Arc::ptr_eq(&arc, &fx.gen.stops_all_body));
                } else {
                    panic!("expected ByteBody::Raw");
                }
            }
            _ => panic!("expected CachedBytes"),
        }
    }


    #[test]
    fn within_hours_param_returns_400_invalid_params() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);

        // ?withinHours=2 — the common caller form.
        match stops_all("withinHours=2", &fx.gen) {
            Resp::Json { status, body } => {
                assert_eq!(status, 400);
                let v: serde_json::Value = serde_json::from_str(&body).expect("body is JSON");
                assert_eq!(v["error"]["code"], "INVALID_PARAMS");
                assert!(
                    v["error"]["message"].as_str().is_some(),
                    "error.message present"
                );
            }
            _ => panic!("expected Json resp for withinHours=2"),
        }

        // Bare ?withinHours (no '=' value) — still detected as present.
        match stops_all("withinHours", &fx.gen) {
            Resp::Json { status, body } => {
                assert_eq!(status, 400);
                let v: serde_json::Value = serde_json::from_str(&body).expect("body is JSON");
                assert_eq!(v["error"]["code"], "INVALID_PARAMS");
            }
            _ => panic!("expected Json resp for bare withinHours"),
        }

        // Leading '?' form (query_of actually strips the '?'; defensive case).
        match stops_all("?withinHours=48", &fx.gen) {
            Resp::Json { status, .. } => assert_eq!(status, 400),
            _ => panic!("expected Json resp for ?withinHours=48"),
        }

        // withinHours as a SECOND ('&'-separated) param — still detected.
        match stops_all("foo=1&withinHours=2", &fx.gen) {
            Resp::Json { status, .. } => assert_eq!(status, 400),
            _ => panic!("expected Json resp for &-separated withinHours"),
        }

        // No query at all — happy path: 200 + same Arc.
        match stops_all("", &fx.gen) {
            Resp::CachedBytes { status, body, .. } => {
                assert_eq!(status, 200);
                if let ByteBody::Raw(arc) = body {
                    assert!(Arc::ptr_eq(&arc, &fx.gen.stops_all_body));
                } else {
                    panic!("expected ByteBody::Raw for empty query");
                }
            }
            _ => panic!("expected CachedBytes for empty query"),
        }
    }

    #[test]
    fn contrast_text_color_matches_backend_threshold() {
        // White bg → black text; black bg → white text.
        assert_eq!(contrast_text_color("FFFFFF"), "000000");
        assert_eq!(contrast_text_color("000000"), "FFFFFF");
        // Leading '#' tolerated.
        assert_eq!(contrast_text_color("#FFFFFF"), "000000");
        // Short / malformed → white (mirrors backend `< 6` and NaN paths).
        assert_eq!(contrast_text_color("FFF"), "FFFFFF");
        assert_eq!(contrast_text_color(""), "FFFFFF");
        // Bright green is light (L≈0.715 > 0.179) → black text; pure blue is
        // dark (L≈0.072 < 0.179) → white text.
        assert_eq!(contrast_text_color("00FF00"), "000000");
        assert_eq!(contrast_text_color("0000FF"), "FFFFFF");
    }

    // Confirms the test PTB builder produces a reader the `from_paths` path
    // accepts and the fixture dir is laid out as the loader expects.
    #[test]
    fn fixture_dir_layout_is_loadable() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        assert_eq!(fx.gen.reader.num_stops(), 4);
        assert!(Path::new(fx._dir.path()).join("bundle.ptb").exists());
    }

    // ───────────────────── /stops/nearby ─────────────────────

    /// Build a generation from arbitrary stop coords (one dummy route+trip so
    /// the PTB builder's `num_routes>=1`/`num_trips>=1` asserts hold; the trip
    /// visits stop 0). Used by the `/stops/nearby` order + distance tests where
    /// only geometry matters.
    fn build_nearby_fixture(stops: &[(&str, &str, f64, f64)]) -> Fixture {
        let routes = [("R0", "1", 3u16, "FF0000", "FFFFFF")];
        let t0: &[(u16, u32, u32)] = &[(1, 0, 25200)];
        let trips: &[TripSpec<'_>] = &[(0, t0)];
        let ptb = build_test_ptb(stops, &routes, trips);

        let dir = tempfile::TempDir::new().expect("tempdir");
        let ptb_path = dir.path().join("bundle.ptb");
        std::fs::write(&ptb_path, &ptb).unwrap();
        // No color/label artifacts needed for the geometry tests.
        let gen = Generation::from_paths(
            &ptb_path,
            None,
            "vilnius".to_string(),
            pt_core::PatternMode::Off,
        )
        .expect("generation loads");
        Fixture { _dir: dir, gen }
    }

    /// Parse a `/stops/nearby` 200 response body into a Vec of stop ids (in
    /// response order). Panics if the resp is not a 200 CachedBytes JSON.
    fn nearby_ids(resp: Resp) -> Vec<String> {
        match resp {
            Resp::CachedBytes {
                status,
                body,
                content_type,
                cache_control,
                etag,
                gzipped,
            } => {
                assert_eq!(status, 200, "expected 200");
                assert_eq!(content_type, "application/json");
                assert_eq!(cache_control, "public, max-age=300");
                assert!(etag.is_none());
                assert!(!gzipped);
                let bytes = match body {
                    ByteBody::Raw(arc) => arc,
                    _ => panic!("expected ByteBody::Raw"),
                };
                let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                v["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s["id"].as_str().unwrap().to_string())
                    .collect()
            }
            _ => panic!("expected 200 CachedBytes"),
        }
    }

    /// (a) strict `>` exclusion with the equirectangular metric: a stop EXACTLY
    /// at `radius` is INCLUDED; a stop just outside is EXCLUDED.
    #[test]
    fn radius_boundary_is_strict_greater_than() {
        // Query at (54.700, 25.300). Due-north stops so dx=0 and the distance
        // is purely the dy term. CRITICAL: PTB stores stop coords as f32, so the
        // handler reads back f32-widened lat/lon — the expected distance MUST be
        // computed from the reader's stored coords (NOT the f64 literals), or a
        // sub-meter f32 round-trip error flips the strict-`>` boundary.
        // NEAR is kept WELL inside the query's own cell (54.702 → cell 10940,
        // same as the 54.700 query) so the radius-derived cell-scan bound
        // (which uses the 111320 m/deg lat approximation) always covers it —
        // otherwise a stop exactly AT the radius can fall in a cell the bound
        // rounds just past, which IS the backend's behavior but isn't what this
        // strict-`>` boundary test is exercising.
        let qlat = 54.700;
        let qlon = 25.300;
        let stops = [
            ("NEAR", "Near", 54.702, 25.300), // ~222 m north
            ("FAR", "Far", 54.704, 25.300),   // ~445 m north
        ];
        let fx = build_nearby_fixture(&stops);
        // Distances against the EXACT stored (f32-widened) coords.
        let r = &fx.gen.reader;
        let d_near = distance_meters(
            qlat,
            qlon,
            r.stop_lat_f64(0).unwrap(),
            r.stop_lon_f64(0).unwrap(),
        );
        let d_far = distance_meters(
            qlat,
            qlon,
            r.stop_lat_f64(1).unwrap(),
            r.stop_lon_f64(1).unwrap(),
        );
        assert!(d_far > d_near);

        // radius EXACTLY at NEAR's distance → NEAR included (strict `>` keeps
        // the equal case), FAR excluded. The radius f64 round-trips exactly
        // through Display→parse, and the handler recomputes the SAME distance
        // from the SAME stored coords → exact equality at the boundary.
        let q = format!("lat={qlat}&lon={qlon}&radius={d_near}");
        let ids = nearby_ids(stops_nearby(&q, &fx.gen));
        assert_eq!(ids, vec!["NEAR".to_string()], "stop at radius is INCLUDED");

        // radius just BELOW NEAR's distance → NEAR excluded too.
        let just_below = d_near - 0.001;
        let q = format!("lat={qlat}&lon={qlon}&radius={just_below}");
        let ids = nearby_ids(stops_nearby(&q, &fx.gen));
        assert!(ids.is_empty(), "stop just outside radius is EXCLUDED");

        // radius between NEAR and FAR → only NEAR.
        let mid = (d_near + d_far) / 2.0;
        let q = format!("lat={qlat}&lon={qlon}&radius={mid}");
        let ids = nearby_ids(stops_nearby(&q, &fx.gen));
        assert_eq!(ids, vec!["NEAR".to_string()]);
    }

    /// (b) response ORDER = grid `cy`-outer / `cx`-inner, within-bucket
    /// insertion order. Stops are inserted in stop-region order s0..s4 chosen so
    /// the grid order REORDERS them; two stops share a cell to prove the
    /// within-bucket order is insertion order.
    #[test]
    fn response_order_is_grid_cy_outer_cx_inner_then_insertion() {
        // cell = 0.005. Query at (54.700, 25.300) → cell (10940, 5060).
        // s0: (54.710, 25.300) cell (10942, 5060)  high cy
        // s1: (54.690, 25.300) cell (10938, 5060)  low cy
        // s2: (54.700, 25.290) cell (10940, 5058)  mid cy, low cx
        // s3: (54.700, 25.310) cell (10940, 5062)  mid cy, high cx
        // s4: (54.700, 25.290) cell (10940, 5058)  SAME cell as s2, inserted after
        let stops = [
            ("s0", "S0", 54.710, 25.300),
            ("s1", "S1", 54.690, 25.300),
            ("s2", "S2", 54.700, 25.290),
            ("s3", "S3", 54.700, 25.310),
            ("s4", "S4", 54.700, 25.290),
        ];
        let fx = build_nearby_fixture(&stops);

        // Radius 2000 m comfortably includes all five + spans all three cy and
        // cx cells.
        let ids = nearby_ids(stops_nearby("lat=54.700&lon=25.300&radius=2000", &fx.gen));
        // Grid traversal: cy 10938 (s1); cy 10940 cx 5058 (s2,s4 insertion) cx
        // 5062 (s3); cy 10942 (s0). Distinct from stop-region order s0..s4.
        assert_eq!(
            ids,
            vec![
                "s1".to_string(),
                "s2".to_string(),
                "s4".to_string(),
                "s3".to_string(),
                "s0".to_string(),
            ],
            "order follows cy-outer/cx-inner grid traversal + within-bucket insertion, NOT stop-region order"
        );
    }

    /// (c) `radius` absent → defaults to 1000 m.
    #[test]
    fn radius_defaults_to_1000_when_absent() {
        // A stop ~900 m away (inside 1000) and one ~1100 m away (outside 1000),
        // both due north so the distance is the pure dy term.
        // dy(0.008 deg) ≈ 890 m; dy(0.010 deg) ≈ 1112 m.
        let qlat = 54.700;
        let in_stop = (qlat + 0.008, 25.300);
        let out_stop = (qlat + 0.010, 25.300);
        assert!(distance_meters(qlat, 25.300, in_stop.0, in_stop.1) < 1000.0);
        assert!(distance_meters(qlat, 25.300, out_stop.0, out_stop.1) > 1000.0);

        let stops = [
            ("IN", "In", in_stop.0, in_stop.1),
            ("OUT", "Out", out_stop.0, out_stop.1),
        ];
        let fx = build_nearby_fixture(&stops);

        // No `radius` param → default 1000.
        let ids = nearby_ids(stops_nearby("lat=54.700&lon=25.300", &fx.gen));
        assert_eq!(ids, vec!["IN".to_string()], "default radius is 1000 m");

        // Blank radius (`radius=`) also falls back to 1000.
        let ids = nearby_ids(stops_nearby("lat=54.700&lon=25.300&radius=", &fx.gen));
        assert_eq!(
            ids,
            vec!["IN".to_string()],
            "blank radius falls back to 1000 m"
        );
    }

    /// Helper: assert a `/stops/nearby` resp is a 400 with the given error code.
    fn assert_400(resp: Resp, expected_code: &str) {
        match resp {
            Resp::Json { status, body } => {
                assert_eq!(status, 400, "expected 400");
                let v: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(v["error"]["code"], expected_code);
                assert!(
                    v["error"]["message"].as_str().is_some(),
                    "error.message present"
                );
            }
            _ => panic!("expected Json 400"),
        }
    }

    /// (d) error parity: missing/blank lat|lon → MISSING_PARAMS; non-finite
    /// lat|lon → INVALID_PARAMS; non-finite / `<=0` radius → INVALID_PARAMS.
    #[test]
    fn error_parity_matches_backend_codes() {
        let stops = [("S0", "Stop", 54.700, 25.300)];
        let fx = build_nearby_fixture(&stops);

        // Missing lat / missing lon / both missing → MISSING_PARAMS.
        assert_400(stops_nearby("lon=25.3", &fx.gen), "MISSING_PARAMS");
        assert_400(stops_nearby("lat=54.7", &fx.gen), "MISSING_PARAMS");
        assert_400(stops_nearby("", &fx.gen), "MISSING_PARAMS");
        // Empty value `lat=` is the blank case (mirrors `!lat?.trim()`). The
        // numeric params are never urldecoded (digits/`.`/`-` don't escape), so
        // the realistic blank form is the empty value, not `%20`.
        assert_400(stops_nearby("lat=&lon=25.3", &fx.gen), "MISSING_PARAMS");
        assert_400(stops_nearby("lat=54.7&lon=", &fx.gen), "MISSING_PARAMS");

        // Non-finite lat / lon → INVALID_PARAMS.
        assert_400(stops_nearby("lat=abc&lon=25.3", &fx.gen), "INVALID_PARAMS");
        assert_400(stops_nearby("lat=54.7&lon=xyz", &fx.gen), "INVALID_PARAMS");

        // Non-finite radius → INVALID_PARAMS.
        assert_400(
            stops_nearby("lat=54.7&lon=25.3&radius=foo", &fx.gen),
            "INVALID_PARAMS",
        );
        // radius == 0 → INVALID_PARAMS (`<= 0`).
        assert_400(
            stops_nearby("lat=54.7&lon=25.3&radius=0", &fx.gen),
            "INVALID_PARAMS",
        );
        // radius < 0 → INVALID_PARAMS.
        assert_400(
            stops_nearby("lat=54.7&lon=25.3&radius=-5", &fx.gen),
            "INVALID_PARAMS",
        );
    }

    /// (e) body is `{ data }` with NO `lastUpdated` key — assert on RAW JSON.
    #[test]
    fn body_is_data_only_no_last_updated() {
        let stops = [("S0", "Stop", 54.700, 25.300)];
        let fx = build_nearby_fixture(&stops);
        let resp = stops_nearby("lat=54.700&lon=25.300&radius=500", &fx.gen);
        let bytes = match resp {
            Resp::CachedBytes { body, .. } => match body {
                ByteBody::Raw(arc) => arc,
                _ => panic!("expected Raw"),
            },
            _ => panic!("expected CachedBytes"),
        };
        let raw = std::str::from_utf8(&bytes).unwrap();
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert!(v.get("data").is_some(), "envelope has data");
        assert!(
            v.get("lastUpdated").is_none(),
            "nearby body must NOT carry lastUpdated"
        );
        // Hard guard on the raw text.
        assert!(
            !raw.contains("lastUpdated"),
            "raw nearby body must not contain lastUpdated: {raw}"
        );
        // The single stop is within 500 m? (54.700,25.300) is the stop itself
        // → distance 0 → included.
        assert_eq!(v["data"].as_array().unwrap().len(), 1);
        assert_eq!(v["data"][0]["id"], "S0");
        // StopRecord shape parity: nested location, no top-level lat/lon.
        assert!(v["data"][0]["location"]["lat"].is_number());
        assert!(v["data"][0].get("lat").is_none());
    }

    /// Guard: `/stops/all` response order == `.ptb` stop-region index order (`0..num_stops()`).
    ///
    /// This is the IN-PROCESS half of the C2a keystone stop-order invariant. The cross-language
    /// half (pt-serve order == backend `getAllStops`/`iterStops` order) is enforced by the
    /// `route-parity-check.mjs` gate.
    ///
    /// If this test ever fails, the `.ptb` stop-region order or the `/all` body-build
    /// order changed. Do NOT sort to fix it — sorting is a frontend-visible contract
    /// change. Instead reproduce the backend's iteration order so both halves agree.
    #[test]
    fn stops_all_order_equals_ptb_stop_region_index_order() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        let gen = &fx.gen;

        // Call the handler and extract the response body bytes.
        let resp = stops_all("", gen);
        let body_bytes = match resp {
            Resp::CachedBytes { body, .. } => match body {
                ByteBody::Raw(arc) => arc,
                _ => panic!("expected ByteBody::Raw"),
            },
            _ => panic!("expected CachedBytes 200"),
        };

        // Parse `data[].id` from the response, in response order.
        let v: serde_json::Value =
            serde_json::from_slice(&body_bytes).expect("body parses as JSON");
        let served_ids: Vec<String> = v["data"]
            .as_array()
            .expect("data is an array")
            .iter()
            .map(|stop| {
                stop["id"]
                    .as_str()
                    .expect("stop.id is a string")
                    .to_string()
            })
            .collect();

        // Build the expected sequence directly from the reader: 0..num_stops() in
        // .ptb stop-region order — the exact iteration `build_stops_all_body` uses.
        let expected_ids: Vec<String> = (0..gen.reader.num_stops())
            .map(|i| {
                gen.reader
                    .stop_id(i)
                    .expect("stop_id readable for every index in 0..num_stops()")
                    .to_string()
            })
            .collect();

        // The fixture has 4 stops (S0..S3). A 1-stop fixture would not distinguish
        // "right order" from "only one element"; 4 stops make the ordering meaningful.
        assert!(
            expected_ids.len() >= 4,
            "fixture must have ≥4 stops for the order assertion to be non-vacuous"
        );

        assert_eq!(
            served_ids, expected_ids,
            "/stops/all response order must equal .ptb stop-region index order (0..num_stops()). \
             Served: {served_ids:?}. Expected: {expected_ids:?}."
        );
    }

    /// The hoisted parse maps + grid do not change the `/stops/all` output —
    /// re-build the standard fixture and re-assert the key invariants the /all
    /// tests cover (regression guard for the parse-hoist refactor).
    #[test]
    fn stops_all_unchanged_after_parse_hoist() {
        let fx = build_fixture(ROUTE_STYLES, LABEL_ANCHORS);
        let v = body_value(&fx.gen.stops_all_body);
        assert_eq!(v["data"].as_array().unwrap().len(), 4);
        assert_eq!(v["data"][0]["id"], "S0");
        // route-styles applied (verbatim), label anchor present.
        assert_eq!(v["data"][0]["routes"][0]["subMode"], "bus-express");
        assert_eq!(v["data"][0]["labelAnchor"], "top-left");
        // The maps were parsed onto the generation (shared with /nearby).
        assert!(fx.gen.route_styles_map.contains_key("R0"));
        assert!(fx.gen.label_anchors_map.contains_key("S0"));
        // The grid bucketed all 4 stops exactly once.
        let total: usize = fx.gen.spatial_grid.values().map(|v| v.len()).sum();
        assert_eq!(total, 4, "every stop bucketed once");
    }
}
