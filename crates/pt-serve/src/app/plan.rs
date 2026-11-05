//! `POST /api/<city>/plan` — Contract-A boundary translation (no `tiny_http`).
//!
//! Translates string stop-ids → index, calls `pt_core::plan` + `pt_core::project`,
//! serialises the result as camelCase `RaptorItinerary[]` JSON.
//!
//! Error contract: - malformed JSON body → 400 - unknown stopId in entry/exit → 400 - non-numeric
//! date string → 400 - walkSpeedMps / minTransferSecs out of range → 400
//! - EngineError / project
//! error → 500 - no path found → 200 `[]`
//!
//! Epoch protocol (→ wiring): the worker holds an `Option<ScanState>`; this handler reallocates it
//! whenever the cached epoch does not match the active generation's. P3 sets every generation's
//! epoch to `0`, so the first call allocates and subsequent calls reuse — same behaviour as P3's
//! per-worker `ScanState::default()` lifecycle. the reload runner starts bumping the counter, at
//! which point this branch triggers a real reallocation on the first post-swap request a worker
//! sees.

use crate::app::response::Resp;
use crate::bundle::Generation;
use crate::ops::ServerCtx;
use crate::wire::{PlanRequest, WireItinerary};
use pt_core::{Mobility, Query, ScanState, StopWalk};

fn json_response(status: u16, body: String) -> Resp {
    Resp::Json { status, body }
}

/// Map the `mobilityProfile` wire string to a [`Mobility`] variant.
///
/// Accepted values: `"wheelchair"`, `"bicycle"`, absent/anything-else → [`Mobility::Default`].
fn mobility_from_profile(p: Option<&str>) -> Mobility {
    match p {
        Some("wheelchair") => Mobility::Wheelchair,
        Some("bicycle") => Mobility::Bicycle,
        // "default" is not matched by name — it (and any unknown value) falls
        // through to Default. pt-serve is intentionally permissive on unknown
        // profiles (unlike pt-wasm, which validates and errors).
        _ => Mobility::Default,
    }
}

fn json_err(status: u16, msg: &str) -> Resp {
    let body = serde_json::json!({ "error": msg }).to_string();
    json_response(status, body)
}

/// Handle a `POST /api/<city>/plan` request.
///
/// `abort` is the request watchdog's `timed_out` flag: the engine checks it
/// at round boundaries (`pt_core::plan_with_abort`) so a CPU-bound scan
/// frees its worker at the request timeout instead of pinning the pool
/// (only `max_rounds` bounded the work otherwise — head-of-line starvation
/// on the shared accept path). The dispatch layer drops the connection for
/// a timed-out request, so the 503 body below is never written; it exists
/// for direct callers/tests.
pub fn plan(
    body: &[u8],
    gen: &Generation,
    scan_state: &mut Option<ScanState>,
    _ctx: &ServerCtx,
    abort: Option<&std::sync::atomic::AtomicBool>,
) -> Resp {
    // Epoch protocol — reallocate scratch state if this worker last ran against a different
    // generation.
    let cached_epoch = scan_state.as_ref().map(|s| s.epoch);
    if cached_epoch != Some(gen.epoch) {
        *scan_state = Some(ScanState::new_for(&gen.index, gen.epoch));
    }
    let st = scan_state.as_mut().expect("scan_state initialised above");

    // --- Deserialize request ---
    let req: PlanRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return json_err(400, "malformed JSON body"),
    };

    // --- Parse date ---
    let date: u32 = match req.date.parse::<u32>() {
        Ok(d) => d,
        Err(_) => return json_err(400, "invalid date: expected YYYYMMDD"),
    };

    // --- Resolve entry stops: stopId -> index ---
    let mut entry_stops = Vec::with_capacity(req.entry_stops.len());
    for sw in &req.entry_stops {
        match gen.reader.stop_index(&sw.stop_id) {
            Some(idx) => entry_stops.push(StopWalk {
                stop: idx,
                walk_secs: sw.walk_secs,
            }),
            None => {
                return json_err(400, &format!("unknown stopId: {}", sw.stop_id));
            }
        }
    }

    // --- Resolve exit stops: stopId -> index ---
    let mut exit_stops = Vec::with_capacity(req.exit_stops.len());
    for sw in &req.exit_stops {
        match gen.reader.stop_index(&sw.stop_id) {
            Some(idx) => exit_stops.push(StopWalk {
                stop: idx,
                walk_secs: sw.walk_secs,
            }),
            None => {
                return json_err(400, &format!("unknown stopId: {}", sw.stop_id));
            }
        }
    }

    // --- Mobility profile, walking speed, minimum transfer ---
    let mobility = mobility_from_profile(req.mobility_profile.as_deref());
    let (walk_speed_mm_s, min_transfer_secs) =
        match pt_core::engine::consts::parse_walk_params(req.walk_speed_mps, req.min_transfer_secs)
        {
            Ok(v) => v,
            Err(message) => return json_err(400, &message),
        };

    let query = Query {
        excluded_routes: Default::default(),
        entry_stops,
        exit_stops,
        departure_secs: req.departure_secs,
        date,
        max_rounds: req.max_rounds,
        mobility,
        excluded_modes: req.excluded_modes,
        walk_speed_mm_s,
        min_transfer_secs,
    };

    // --- Run engine ---
    let itins = match pt_core::plan_with_abort(
        &gen.reader,
        &gen.index,
        gen.transfers.as_ref(),
        st,
        &query,
        abort,
    ) {
        Ok(i) => i,
        Err(pt_core::EngineError::Aborted) => return json_err(503, "plan timed out"),
        Err(e) => return json_err(500, &format!("engine error: {e:?}")),
    };

    if itins.is_empty() {
        return json_response(200, "[]".to_string());
    }

    let projected = match pt_core::project(&gen.reader, &itins) {
        Ok(p) => p,
        Err(e) => return json_err(500, &format!("projection error: {e:?}")),
    };

    let wire: Vec<WireItinerary> = projected.into_iter().map(WireItinerary::from).collect();
    match serde_json::to_string(&wire) {
        Ok(s) => json_response(200, s),
        Err(e) => json_err(500, &format!("serialization error: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::mobility_from_profile;
    use pt_core::Mobility;

    #[test]
    fn bicycle_profile_maps_to_bicycle() {
        assert_eq!(mobility_from_profile(Some("bicycle")), Mobility::Bicycle);
    }

    #[test]
    fn wheelchair_profile_maps_to_wheelchair() {
        assert_eq!(
            mobility_from_profile(Some("wheelchair")),
            Mobility::Wheelchair
        );
    }

    #[test]
    fn absent_profile_maps_to_default() {
        assert_eq!(mobility_from_profile(None), Mobility::Default);
    }

    #[test]
    fn unknown_profile_maps_to_default() {
        assert_eq!(mobility_from_profile(Some("unknown")), Mobility::Default);
    }
}
