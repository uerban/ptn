//! Query input deserialization + string↔index boundary.
//!
//! the host adapter converts the JS-side query object into a `pt_core::Query` by (a) deserialising
//! via serde-wasm-bindgen, (b) resolving each `stopId` string to its u32 index through the reader's
//! eager `stop_index` map, and (c) parsing `"YYYYMMDD"` into the `u32` the engine consumes. Unknown
//! `stopId` and malformed date surface as `JsError` — never a panic (master ).

use pt_core::{Mobility, Query, Reader, StopWalk};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WasmStopWalk {
    pub stop_id: String,
    pub walk_secs: u32,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WasmQuery {
    pub entry_stops: Vec<WasmStopWalk>,
    pub exit_stops: Vec<WasmStopWalk>,
    /// `"YYYYMMDD"`. Service-day resolution happens INSIDE pt-core via the PTB header's
    /// `feedStartDate` + 90-day service bitmask window (master ).
    pub date: String,
    pub departure_secs: i64,
    pub max_rounds: Option<u32>,
    /// `"default"` | `"wheelchair"` | `"bicycle"`. Defaults to `"default"`.
    pub mobility_profile: Option<String>,
    /// GTFS `route_type` integers — NOT TransportMode strings. The host
    /// adapter performs the TransportMode→route_type coercion at the
    /// boundary before calling `plan()` ( lines 126-130). The engine
    /// normalises each integer to its `Mode` family via
    /// `pt_core::engine::mode::route_type_to_mode` and excludes the whole
    /// family (spec A5 ), so extended types are covered by their base-code
    /// representative.
    pub excluded_modes: Option<Vec<u16>>,
    /// Generic route exclusions, resolved before the engine scans any patterns.
    pub excluded_route_ids: Option<Vec<String>>,
    /// The rider's walking speed in m/s, for the engine's transfer walks.
    /// Absent: the mobility's speed (wheelchair 0.8, otherwise 1.25).
    pub walk_speed_mps: Option<f64>,
    /// The minimum transfer in seconds wherever no GTFS `transfers.txt` rule
    /// sets one. Absent: 120.
    pub min_transfer_secs: Option<u32>,
}

pub fn deserialize_query(value: JsValue) -> Result<WasmQuery, JsError> {
    serde_wasm_bindgen::from_value(value)
        .map_err(|e| JsError::new(&format!("query deserialization failed: {}", e)))
}

/// Parse `"YYYYMMDD"` → `u32`. `Query::date` is `u32` (see
/// `pt_core::engine::types::Query`), NOT i64.
pub fn date_to_yyyymmdd(s: &str) -> Result<u32, JsError> {
    s.parse::<u32>()
        .map_err(|_| JsError::new(&format!("date must be YYYYMMDD, got: {}", s)))
}

/// Resolve `stop_id` string → u32 index via the reader's eager stop-id map
/// (`Reader::stop_index`, reader.rs:302). `None` → JsError (the
/// string↔index boundary fault site, surfaced as a recoverable error
/// instead of a panic).
pub fn resolve_stop_walk<B>(reader: &Reader<B>, ws: &WasmStopWalk) -> Result<StopWalk, JsError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let idx = reader
        .stop_index(&ws.stop_id)
        .ok_or_else(|| JsError::new(&format!("unknown stopId: {}", ws.stop_id)))?;
    Ok(StopWalk {
        stop: idx,
        walk_secs: ws.walk_secs,
    })
}

/// Classify a mobility-profile string. Pure + `JsError`-free so the error arm
/// is natively testable; `mobility_from_profile` wraps the `Err` into a `JsError`.
fn classify_mobility(profile: Option<&str>) -> Result<Mobility, String> {
    match profile {
        Some("wheelchair") => Ok(Mobility::Wheelchair),
        Some("bicycle") => Ok(Mobility::Bicycle),
        Some("default") | None => Ok(Mobility::Default),
        Some(other) => Err(format!("unknown mobilityProfile: {}", other)),
    }
}

/// Parse a `mobilityProfile` string into a [`Mobility`] value.
///
/// Accepted profiles: `"default"` | `"wheelchair"` | `"bicycle"`. `None`
/// defaults to `"default"`.
fn mobility_from_profile(profile: Option<&str>) -> Result<Mobility, JsError> {
    classify_mobility(profile).map_err(|m| JsError::new(&m))
}

/// Build the engine `Query` from the deserialised WasmQuery + reader.
pub fn build_engine_query<B>(reader: &Reader<B>, wq: WasmQuery) -> Result<Query, JsError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let entry_stops = wq
        .entry_stops
        .iter()
        .map(|s| resolve_stop_walk(reader, s))
        .collect::<Result<Vec<_>, _>>()?;
    let exit_stops = wq
        .exit_stops
        .iter()
        .map(|s| resolve_stop_walk(reader, s))
        .collect::<Result<Vec<_>, _>>()?;
    let mobility = mobility_from_profile(wq.mobility_profile.as_deref())?;
    let date = date_to_yyyymmdd(&wq.date)?;
    let (walk_speed_mm_s, min_transfer_secs) =
        pt_core::engine::consts::parse_walk_params(wq.walk_speed_mps, wq.min_transfer_secs)
            .map_err(|m| JsError::new(&m))?;
    let mut excluded_routes = Vec::new();
    for id in wq.excluded_route_ids.unwrap_or_default() {
        let mut resolved = None;
        for i in 0..reader.num_routes() {
            if reader.route_id(i)? == id.as_str() {
                resolved = Some(i as u32);
                break;
            }
        }
        excluded_routes.push(
            resolved.ok_or_else(|| JsError::new(&format!("unknown excluded routeId: {id}")))?,
        );
    }
    excluded_routes.sort_unstable();
    excluded_routes.dedup();
    Ok(Query {
        excluded_routes,
        entry_stops,
        exit_stops,
        departure_secs: wq.departure_secs,
        date,
        max_rounds: wq.max_rounds,
        mobility,
        excluded_modes: wq.excluded_modes.unwrap_or_default(),
        walk_speed_mm_s,
        min_transfer_secs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(profile: Option<&str>) -> Mobility {
        classify_mobility(profile).expect("should be Ok")
    }

    #[test]
    fn bicycle_profile_parses() {
        assert_eq!(ok(Some("bicycle")), Mobility::Bicycle);
    }

    #[test]
    fn wheelchair_profile_parses() {
        assert_eq!(ok(Some("wheelchair")), Mobility::Wheelchair);
    }

    #[test]
    fn default_profile_parses() {
        assert_eq!(ok(Some("default")), Mobility::Default);
    }

    #[test]
    fn none_profile_defaults_to_default() {
        assert_eq!(ok(None), Mobility::Default);
    }

    #[test]
    fn unknown_profile_errors() {
        let err =
            classify_mobility(Some("flying-car")).expect_err("unknown profile should return Err");
        assert_eq!(err, "unknown mobilityProfile: flying-car");
    }
}
