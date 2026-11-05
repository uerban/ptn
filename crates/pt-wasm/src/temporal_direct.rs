//! Experimental JS wire seam for direct-only range benchmark candidates.
//! Neither feature is enabled by the production package build.

use pt_core::engine::temporal_probe::direct::DirectPoint;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectWindow {
    pub start_secs: i64,
    pub end_secs: i64,
}

pub(crate) fn parse_window(value: JsValue) -> Result<DirectWindow, JsError> {
    let window: DirectWindow = serde_wasm_bindgen::from_value(value)
        .map_err(|e| JsError::new(&format!("invalid temporal window: {e}")))?;
    if window.start_secs >= window.end_secs {
        return Err(JsError::new("temporal window start must precede end"));
    }
    Ok(window)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectPointWire {
    departure_secs: i64,
    arrival_secs: i64,
    total_walk_secs: u32,
    actual_transfers: u32,
    service_date: u32,
    trip_idx: u32,
    board_position: u32,
    alight_position: u32,
}

pub(crate) fn project(points: &[DirectPoint]) -> Result<JsValue, JsError> {
    let wire = points
        .iter()
        .map(|point| DirectPointWire {
            departure_secs: point.origin_departure_secs,
            arrival_secs: point.destination_arrival_secs,
            total_walk_secs: point.total_walk_secs,
            actual_transfers: point.actual_transfers,
            service_date: point.service_date,
            trip_idx: point.trip_idx,
            board_position: point.board_position,
            alight_position: point.alight_position,
        })
        .collect::<Vec<_>>();
    serde_wasm_bindgen::to_value(&wire)
        .map_err(|e| JsError::new(&format!("temporal direct output: {e}")))
}
