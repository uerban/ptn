//! `pt-wasm` — thin `wasm-bindgen` wrapper over `pt-core` (P5).
//!
//! All public API lives behind `#[wasm_bindgen]` exports; the engine
//! algorithm is `pt-core` unchanged.

#[cfg(all(feature = "temporal-direct-r3", feature = "temporal-direct-m4"))]
compile_error!("temporal-direct-r3 and temporal-direct-m4 are mutually exclusive");

use std::cell::Cell;

use pt_core::{Index, PatternMode, Reader, ScanState, Transfers};
use wasm_bindgen::prelude::*;

mod address;
pub use address::PtAddressIndex;
mod walk;
pub use walk::PtWalkGraph;

mod error;
mod output;
mod query;
#[cfg(feature = "temporal-deadline")]
mod temporal_deadline;
#[cfg(any(feature = "temporal-direct-r3", feature = "temporal-direct-m4"))]
mod temporal_direct;
use error::ptb_error_to_js;
#[cfg(feature = "temporal-setup-profile")]
pub use temporal_deadline::take_setup_profile;
#[cfg(feature = "temporal-deadline")]
pub use temporal_deadline::TemporalDeadlineProbe;

/// Opaque handle wrapping a `pt-core` reader + index + scan state over an owned PTB byte buffer
/// (copied into wasm linear memory by wasm-bindgen on construction). Reused across queries — decode
/// once, query many (one ScanState per handle, reset per query).
#[wasm_bindgen]
pub struct PtRouter {
    pub(crate) reader: Reader<Vec<u8>>,
    pub(crate) index: Index,
    pub(crate) scan_state: ScanState,
    /// Optional pedestrian-transfer table (PTFT). Set via `set_transfers`;
    /// `plan` threads `self.transfers.as_ref()` into `pt_core::plan` so the
    /// footpath-relaxation pass fires when present. Owns its decoded bytes;
    /// drops with the parent struct (no explicit Drop required).
    pub(crate) transfers: Option<Transfers>,
    /// Set to `true` by `free()`; checked by `isAlive()` so the never-throw
    /// contract survives across the post-free call boundary (the auto-
    /// generated wasm-bindgen drop-free would otherwise have the JS handle
    /// throw "null pointer passed to rust" on subsequent method calls).
    pub(crate) dropped: Cell<bool>,
}

#[wasm_bindgen]
impl PtRouter {
    /// Construct from a `.ptb` byte buffer and an optional pattern-mode string. JS side passes a
    /// `Uint8Array` for `buf`; wasm-bindgen copies into wasm linear memory and we own the
    /// `Vec<u8>`. `mode_str` controls which `PatternMode` the index is built with:
    /// - `"off"` →
    /// `PatternMode::Off` (default / legacy)
    /// - `"unbounded"` → `PatternMode::Unbounded` -
    /// `"covering-merge"` → `PatternMode::CoveringMerge` - any other string → `PatternMode::Off`
    /// (safe fallback) Bad buffer input (corrupt bytes, wrong magic, schema mismatch) returns a
    /// `JsError` — no panic.
    #[wasm_bindgen(constructor)]
    pub fn new(buf: &[u8], mode_str: &str) -> Result<PtRouter, JsError> {
        let mode = match mode_str {
            "unbounded" => PatternMode::Unbounded,
            "covering-merge" => PatternMode::CoveringMerge,
            _ => PatternMode::Off,
        };
        let owned: Vec<u8> = buf.to_vec();
        let reader = Reader::from_bytes(owned).map_err(ptb_error_to_js)?;
        let index = Index::build(&reader, mode)
            .map_err(|e| JsError::new(&format!("pt-core index build failed: {:?}", e)))?;
        let scan_state = ScanState::default();
        Ok(PtRouter {
            reader,
            index,
            scan_state,
            transfers: None,
            dropped: Cell::new(false),
        })
    }

    /// Install a decoded PTFT pedestrian-transfer table. Subsequent `plan`
    /// calls thread `Some(&transfers)` into `pt_core::plan`, enabling the
    /// footpath-relaxation pass. Replacing an existing table is supported;
    /// the prior `Transfers` is dropped (and its owned bytes freed) before
    /// the new one is installed.
    ///
    /// Bad input (wrong magic, malformed varints, out-of-range neighbor)
    /// returns a `JsError` — no panic. The error message
    /// includes the underlying `TransfersError` variant for triage.
    #[wasm_bindgen(js_name = setTransfers)]
    pub fn set_transfers(&mut self, buf: &[u8]) -> Result<(), JsError> {
        let transfers = Transfers::from_bytes(buf)
            .map_err(|e| JsError::new(&format!("pt-core transfers decode: {:?}", e)))?;
        self.transfers = Some(transfers);
        Ok(())
    }

    /// Run the engine for `query`. Returns `RaptorItinerary[]` per the
    /// master Contract A. Errors as `JsError` on bad input (unknown
    /// `stopId`, malformed `date`, unknown `mobilityProfile`) or any
    /// pt-core engine fault. NEVER panics.
    #[wasm_bindgen]
    pub fn plan(&mut self, query: JsValue) -> Result<JsValue, JsError> {
        if self.dropped.get() {
            return Err(JsError::new("plan() called on freed PtRouter"));
        }
        let wq = query::deserialize_query(query)?;
        let q = query::build_engine_query(&self.reader, wq)?;
        let itineraries = pt_core::plan(
            &self.reader,
            &self.index,
            // the prior `transfers: None` hard-wire was the only reason `tests/three_way.mjs`
            // SKIPPED the 3 footpath-dependent differential tuples. With `set_transfers(buf)`
            // landed, the host forwards the installed table here; when no table has been installed
            // (a generation without `transfers.bin`) the engine runs with no stop-to-stop walks at
            // all: only same-stop transfers and the origin/destination walks remain.
            self.transfers.as_ref(),
            &mut self.scan_state,
            &q,
        )
        .map_err(|e| JsError::new(&format!("pt-core engine error: {:?}", e)))?;
        output::project(&self.reader, &itineraries)
    }

    /// Experimental single-ride range kernel. No transfer path is searched;
    /// this is a benchmark probe, not an arrive-by route recommendation.
    #[cfg(any(feature = "temporal-direct-r3", feature = "temporal-direct-m4"))]
    #[wasm_bindgen(js_name = temporalDirectObjective)]
    pub fn temporal_direct_objective(&self) -> String {
        if cfg!(feature = "temporal-direct-m4") {
            "m4".into()
        } else {
            "r3".into()
        }
    }

    #[cfg(any(feature = "temporal-direct-r3", feature = "temporal-direct-m4"))]
    #[wasm_bindgen(js_name = planTemporalDirect)]
    pub fn plan_temporal_direct(
        &self,
        query: JsValue,
        window: JsValue,
    ) -> Result<JsValue, JsError> {
        if self.dropped.get() {
            return Err(JsError::new(
                "planTemporalDirect() called on freed PtRouter",
            ));
        }
        let wq = query::deserialize_query(query)?;
        let q = query::build_engine_query(&self.reader, wq)?;
        let bounds = temporal_direct::parse_window(window)?;
        let objective = if cfg!(feature = "temporal-direct-m4") {
            pt_core::engine::temporal_probe::direct::DirectObjectives::M4
        } else {
            pt_core::engine::temporal_probe::direct::DirectObjectives::R3
        };
        let points = pt_core::engine::temporal_probe::direct::profile_direct(
            &self.reader,
            &self.index,
            &q,
            bounds.start_secs.max(q.departure_secs)..bounds.end_secs,
            objective,
        )
        .map_err(|e| JsError::new(&format!("temporal direct kernel: {e:?}")))?;
        temporal_direct::project(&points)
    }

    /// Resolve one absolute departure instant against a PTB v2 bundle's
    /// `0x18 ServiceDayOrigins`. Returns `{ serviceDate: "YYYYMMDD",
    /// timeOriginUnix, departureSecs }`; callers build the plan query from
    /// `serviceDate`/`departureSecs` and render results as
    /// `timeOriginUnix + resultSecs`. `departureUnix` must be an integral
    /// safe-integer number. A v1 bundle has no origins and is an error.
    #[wasm_bindgen(js_name = resolveTime)]
    pub fn resolve_time(&self, departure_unix: f64) -> Result<JsValue, JsError> {
        if self.dropped.get() {
            return Err(JsError::new("resolveTime() called on freed PtRouter"));
        }
        let t = time_wire(&self.reader, departure_unix).map_err(|e| JsError::new(&e))?;
        serde_wasm_bindgen::to_value(&t).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Probe whether the handle is still usable. Returns `false` after `free()`.
    #[wasm_bindgen(js_name = isAlive)]
    pub fn is_alive(&self) -> bool {
        if self.dropped.get() {
            return false;
        }
        self.reader
            .bytes_view()
            .map(|b| !b.is_empty())
            .unwrap_or(false)
    }

    /// Override `.free()` to set the dropped flag WITHOUT invalidating
    /// the JS handle. The actual Rust Drop happens when the JS handle GCs;
    /// until then, subsequent calls to `isAlive()` correctly return `false`
    /// (short-circuited by the flag) and `plan()` returns a `JsError` (also
    /// short-circuited by the flag).
    #[wasm_bindgen(js_name = free)]
    pub fn manual_free(&self) {
        self.dropped.set(true);
    }
}

/// Wire shape of [`PtRouter::resolve_time`]; mirrors the mobile
/// `ptn_router_resolve_time` success JSON.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimeWire {
    service_date: String,
    time_origin_unix: i64,
    departure_secs: i64,
}

/// Largest integer a JS `number` represents exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub(crate) fn time_wire<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    departure_unix: f64,
) -> Result<TimeWire, String> {
    if !departure_unix.is_finite()
        || departure_unix.fract() != 0.0
        || departure_unix.abs() > MAX_SAFE_INTEGER
    {
        return Err(format!(
            "departureUnix must be a safe integer, got {departure_unix}"
        ));
    }
    let t = pt_core::engine::v2::resolve_time(reader, departure_unix as i64)
        .map_err(|e| format!("pt-core time resolution: {e:?}"))?;
    Ok(TimeWire {
        service_date: format!("{:08}", t.service_date),
        time_origin_unix: t.time_origin_unix,
        departure_secs: t.departure_secs,
    })
}

#[cfg(test)]
mod time_tests {
    use super::*;

    /// The producer-staged synthetic v2 bundle the TypeScript reader also pins.
    const TINY_V2: &[u8] =
        include_bytes!("../../../packages/shared/src/ptb/__fixtures__/tiny-v2.ptb");

    #[test]
    fn resolves_an_instant_to_its_service_day_origin() {
        let r = Reader::from_bytes(TINY_V2.to_vec()).unwrap();
        let o = r.service_day_origin(2).unwrap();
        let t = time_wire(&r, (o + 7 * 3600) as f64).unwrap();
        assert_eq!(
            t,
            TimeWire {
                service_date: "20260504".into(),
                time_origin_unix: o,
                departure_secs: 7 * 3600,
            }
        );
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(
            json,
            format!(r#"{{"serviceDate":"20260504","timeOriginUnix":{o},"departureSecs":25200}}"#)
        );
    }

    #[test]
    fn rejects_unsafe_instants_and_out_of_window_times() {
        let r = Reader::from_bytes(TINY_V2.to_vec()).unwrap();
        assert!(time_wire(&r, 1.5).is_err());
        assert!(time_wire(&r, f64::NAN).is_err());
        assert!(time_wire(&r, 2f64.powi(60)).is_err());
        let first = r.service_day_origin(0).unwrap();
        assert!(time_wire(&r, (first - 1) as f64)
            .unwrap_err()
            .contains("UnsupportedServiceDate"));
    }
}
