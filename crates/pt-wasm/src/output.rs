//! Itinerary/Leg → serde-wasm-bindgen output matching `@pt/shared`'s
//! `RaptorItinerary[]` tagged-union shape.
//!
//! Field-name pin: the smoke checks the exact camelCase keys, because a
//! silent rename would pass an empty-shape check but break the frontend
//! consumer. The transit leg uses `fromStopId`/`toStopId` (matching
//! `@pt/shared`'s `RaptorTransitLeg`), same as the walk leg.
//!
//! `route_type → mode` delegates to `pt_core::engine::mode` (the Rust
//! source of truth). This serializer produces the string directly without
//! going through pt-core's owned-String `ProjectedTransitLeg` (which lacks
//! `routeShortName`).

use pt_core::{Itinerary, Leg, LegKind, Reader};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmItinerary {
    legs: Vec<WasmLeg>,
    board_secs: i64,
    alight_secs: i64,
    transfers: u32,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WasmLeg {
    #[serde(rename = "walk")]
    Walk(WasmWalkLeg),
    #[serde(rename = "transit")]
    Transit(WasmTransitLeg),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmWalkLeg {
    from_stop_id: String,
    to_stop_id: String,
    depart_secs: i64,
    arrive_secs: i64,
    walk_secs: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmTransitLeg {
    route_id: String,
    route_short_name: String,
    /// Route brand colour (PTB `route_color`, no `#`). Serialized as
    /// `RaptorTransitLeg.routeColor` so route-results badges colour-match
    /// the map / Settings instead of falling back to the parent-mode
    /// default. `None` (field omitted) when the feed supplies no colour —
    /// the badge then resolves the mode colour. The native pt-core
    /// projection omits this field; the three-way parity check compares a
    /// field whitelist that excludes it, so the engines stay in lock-step.
    #[serde(skip_serializing_if = "Option::is_none")]
    route_color: Option<String>,
    mode: String,
    // Aligns with @pt/shared::RaptorTransitLeg, which uses {from,to}StopId
    // on both walk AND transit legs.
    from_stop_id: String,
    to_stop_id: String,
    trip_id: String,
    depart_secs: i64,
    arrive_secs: i64,
    /// Pattern-relative positions into `route.stopIds[]`. Mirrors pt-core's
    /// `ProjectedTransitLeg.board_stop_idx`/`alight_stop_idx`. The frontend's
    /// TransitLegLayer / TransitLegPreviewLayer / useTransitLegGeometry
    /// consume these to slice route polylines for transit-leg shape
    /// rendering; without them shape rendering short-circuits on every
    /// transit leg.
    /// Circular-route caveat: alight position can land at or past
    /// `route.stopIds.length` on routes whose terminal alight is the
    /// origin — the frontend bounds-checks this index before indexing into
    /// `route.stopIds[]`.
    board_stop_idx: u32,
    alight_stop_idx: u32,
    /// Number of intermediate stops skipped between board and alight.
    intermediate_stops: u32,
    /// The scanned pattern's full stop-id sequence, for frontend leg
    /// geometry. Serialized as `patternStopIds`.
    pattern_stop_ids: Vec<String>,
    /// Mirrors `RaptorTransitLeg.approximate`; omitted for exact scheduled legs.
    #[serde(skip_serializing_if = "is_false")]
    approximate: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Project an index-space `Itinerary[]` into the tagged-union `RaptorItinerary[]`
/// JsValue shape the frontend consumes as `@pt/shared`'s type.
pub fn project<B>(reader: &Reader<B>, itineraries: &[Itinerary]) -> Result<JsValue, JsError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let mut out: Vec<WasmItinerary> = Vec::with_capacity(itineraries.len());
    for it in itineraries {
        let mut legs: Vec<WasmLeg> = Vec::with_capacity(it.legs.len());
        for leg in &it.legs {
            legs.push(project_leg(reader, leg)?);
        }
        out.push(WasmItinerary {
            legs,
            board_secs: it.board_secs,
            alight_secs: it.alight_secs,
            transfers: it.transfers,
        });
    }
    serde_wasm_bindgen::to_value(&out)
        .map_err(|e| JsError::new(&format!("itinerary serialization failed: {}", e)))
}

fn project_leg<B>(reader: &Reader<B>, leg: &Leg) -> Result<WasmLeg, JsError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let from_id = stop_id_for_idx(reader, leg.from_stop)?;
    let to_id = stop_id_for_idx(reader, leg.to_stop)?;
    match &leg.kind {
        LegKind::Walk => Ok(WasmLeg::Walk(WasmWalkLeg {
            from_stop_id: from_id,
            to_stop_id: to_id,
            depart_secs: leg.depart_secs,
            arrive_secs: leg.arrive_secs,
            // walk legs have no explicit `walk_secs` in the engine model;
            // derive from depart/arrive (saturating to clamp the i64→u32 cast).
            walk_secs: leg
                .arrive_secs
                .saturating_sub(leg.depart_secs)
                .max(0)
                .min(u32::MAX as i64) as u32,
        })),
        LegKind::Transit {
            route_idx: _,
            reader_route_idx,
            trip_idx,
            route_type,
            board_stop_idx,
            alight_stop_idx,
            intermediate_stops,
            pattern_stop_ids,
            approximate,
        } => {
            // RouteRec/TripRec carry already-decoded owned Strings (records.rs);
            // there is no `*_id_idx` field to feed back through `reader.string()`.
            let route = reader
                .route(*reader_route_idx as usize)
                .map_err(|e| JsError::new(&format!("route lookup: {:?}", e)))?;
            let trip = reader
                .trip(*trip_idx as usize)
                .map_err(|e| JsError::new(&format!("trip lookup: {:?}", e)))?;
            // `from_stop_id` / `to_stop_id` use `leg.from_stop` / `leg.to_stop`
            // — the absolute stop indices the engine already resolved. We do
            // NOT derive them from `board_stop_idx` / `alight_stop_idx`
            // because those are pattern-relative positions, and on circular
            // routes the terminal alight position can land past the canonical
            // pattern length. The pattern positions ARE still surfaced on
            // the wire (board/alight_stop_idx below) — the frontend needs
            // them to slice route polylines for transit-leg shape rendering
            // (TransitLegLayer, TransitLegPreviewLayer, useTransitLegGeometry).
            let board_id = stop_id_for_idx(reader, leg.from_stop)?;
            let alight_id = stop_id_for_idx(reader, leg.to_stop)?;
            let resolved_pattern_stops: Vec<String> = pattern_stop_ids
                .iter()
                .map(|&i| stop_id_for_idx(reader, i))
                .collect::<Result<Vec<String>, JsError>>()?;
            // Empty feed colour -> None (omitted), so the frontend falls back
            // to the mode colour rather than rendering an empty swatch.
            let route_color = if route.route_color.is_empty() {
                None
            } else {
                Some(route.route_color)
            };
            Ok(WasmLeg::Transit(WasmTransitLeg {
                route_id: route.route_id,
                route_short_name: route.short_name,
                route_color,
                mode: pt_core::engine::mode::mode_to_wire_str(
                    pt_core::engine::mode::route_type_to_mode(*route_type),
                )
                .to_string(),
                from_stop_id: board_id,
                to_stop_id: alight_id,
                trip_id: trip.trip_id,
                depart_secs: leg.depart_secs,
                arrive_secs: leg.arrive_secs,
                board_stop_idx: *board_stop_idx,
                alight_stop_idx: *alight_stop_idx,
                intermediate_stops: *intermediate_stops,
                pattern_stop_ids: resolved_pattern_stops,
                approximate: *approximate,
            }))
        }
    }
}

fn stop_id_for_idx<B>(reader: &Reader<B>, idx: u32) -> Result<String, JsError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    reader
        .stop_id(idx as usize)
        .map(|s| s.to_string())
        .map_err(|e| JsError::new(&format!("stop_id idx {}: {:?}", idx, e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wire-shape pin: the frontend's transit-leg shape renderers
    /// (TransitLegLayer, TransitLegPreviewLayer, useTransitLegGeometry,
    /// pages/Search.tsx) read `boardStopIdx` / `alightStopIdx` as
    /// pattern-relative positions into `route.stopIds[]` for slicing the
    /// route polyline. This test fails (won't compile) if the fields are
    /// removed from WasmTransitLeg or renamed away from the
    /// `boardStopIdx`/`alightStopIdx` camelCase contract.
    #[test]
    fn transit_leg_carries_board_and_alight_stop_idx() {
        let leg = WasmLeg::Transit(WasmTransitLeg {
            route_id: "R1".to_string(),
            route_short_name: "1".to_string(),
            route_color: Some("16a34a".to_string()),
            mode: "BUS".to_string(),
            from_stop_id: "S1".to_string(),
            to_stop_id: "S5".to_string(),
            trip_id: "T1".to_string(),
            depart_secs: 0,
            arrive_secs: 600,
            board_stop_idx: 3,
            alight_stop_idx: 7,
            intermediate_stops: 3,
            pattern_stop_ids: Vec::new(), // not under test here
            approximate: false,
        });
        let v = serde_json::to_value(&leg).unwrap();
        assert_eq!(v["type"], "transit");
        assert_eq!(v["boardStopIdx"], 3);
        assert_eq!(v["alightStopIdx"], 7);
    }

    /// Wire-shape pin for route colour: a transit leg with a feed colour
    /// surfaces it as `routeColor` (camelCase, no `#`) so route-results badges
    /// match the map. A leg with no colour omits the key entirely (rather
    /// than emitting `""`), letting the frontend fall back to the mode
    /// colour.
    #[test]
    fn transit_leg_route_color_present_or_omitted() {
        let mk = |color: Option<String>| {
            serde_json::to_value(WasmLeg::Transit(WasmTransitLeg {
                route_id: "R1".to_string(),
                route_short_name: "3G".to_string(),
                route_color: color,
                mode: "BUS".to_string(),
                from_stop_id: "S1".to_string(),
                to_stop_id: "S5".to_string(),
                trip_id: "T1".to_string(),
                depart_secs: 0,
                arrive_secs: 600,
                board_stop_idx: 0,
                alight_stop_idx: 2,
                intermediate_stops: 1,
                pattern_stop_ids: Vec::new(), // not under test here
                approximate: false,
            }))
            .unwrap()
        };

        let with_color = mk(Some("16a34a".to_string()));
        assert_eq!(with_color["routeColor"], "16a34a");

        let no_color = mk(None);
        assert!(no_color.get("routeColor").is_none());
    }

    #[test]
    fn transit_leg_approximate_omitted_unless_true() {
        let mk = |approximate: bool| {
            serde_json::to_value(WasmLeg::Transit(WasmTransitLeg {
                route_id: "R1".to_string(),
                route_short_name: "3G".to_string(),
                route_color: None,
                mode: "BUS".to_string(),
                from_stop_id: "S1".to_string(),
                to_stop_id: "S5".to_string(),
                trip_id: "T1".to_string(),
                depart_secs: 0,
                arrive_secs: 600,
                board_stop_idx: 0,
                alight_stop_idx: 2,
                intermediate_stops: 1,
                pattern_stop_ids: Vec::new(),
                approximate,
            }))
            .unwrap()
        };

        assert!(mk(false).get("approximate").is_none());
        assert_eq!(mk(true)["approximate"], true);
    }
}
