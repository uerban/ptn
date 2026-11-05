use pt_core::{ProjectedItinerary, ProjectedLeg};
use serde::{Deserialize, Serialize};

/// Inbound plan request — camelCase, mirrors `@pt/shared::RaptorQuery`
/// EXCEPT `excludedModes` (see field note below).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub entry_stops: Vec<StopWalkReq>,
    pub exit_stops: Vec<StopWalkReq>,
    pub departure_secs: i64,
    /// ISO-numeric date string "YYYYMMDD".
    pub date: String,
    #[serde(default)]
    pub max_rounds: Option<u32>,
    /// `"wheelchair"` | `"bicycle"` | absent/anything-else → default.
    #[serde(default)]
    pub mobility_profile: Option<String>,
    /// GTFS `route_type` integers — NOT the Contract-A `TransportMode[]` string
    /// form (`@pt/shared::RaptorQuery.excludedModes` is `["BUS", ...]`). The
    /// `pt_core` engine normalises each incoming `route_type` to its `Mode`
    /// family via `engine::mode::route_type_to_mode` and excludes the whole
    /// family (spec A5 ), so extended types (e.g. 401 → METRO) are covered
    /// by their base-code representative (e.g. 1 → METRO). A string→route_type
    /// translation for the frontend `/plan` cutover is deferred to P4; until
    /// then a client sending the string form gets a 400. The engine-regression
    /// harness carries both forms (`crates/pt-core/tests/raptor_behavior.rs`).
    #[serde(default)]
    pub excluded_modes: Vec<u16>,
    /// Walking speed in m/s for the engine's transfer walks; absent keeps the
    /// mobility's speed (wheelchair 0.8, otherwise 1.25). Out of range → 400.
    #[serde(default)]
    pub walk_speed_mps: Option<f64>,
    /// Minimum transfer in seconds wherever no `transfers.txt` rule sets one;
    /// absent is 120. Above 3600 → 400.
    #[serde(default)]
    pub min_transfer_secs: Option<u32>,
}

/// One stop + walk_secs entry in the inbound request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopWalkReq {
    pub stop_id: String,
    pub walk_secs: u32,
}

/// Wire leg — `#[serde(tag = "type")]` emits `{"type":"walk",...}` /
/// `{"type":"transit",...}` matching `RaptorLeg` in `@pt/shared`.
///
/// `mode` is serialized on **every** leg (structural, not enrichment). `routeShortName` /
/// `routeColor` / `headsign` are deliberately absent (client enrichment).
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WireLeg {
    #[serde(rename = "walk")]
    Walk {
        from_stop_id: String,
        to_stop_id: String,
        depart_secs: i64,
        arrive_secs: i64,
        mode: String,
    },
    #[serde(rename = "transit")]
    Transit {
        from_stop_id: String,
        to_stop_id: String,
        depart_secs: i64,
        arrive_secs: i64,
        route_id: String,
        trip_id: String,
        mode: String,
        board_stop_idx: u32,
        alight_stop_idx: u32,
        intermediate_stops: u32,
    },
}

/// Wire itinerary — camelCase mirror of `RaptorItinerary` in `@pt/shared`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireItinerary {
    pub legs: Vec<WireLeg>,
    pub board_secs: i64,
    pub alight_secs: i64,
    pub transfers: u32,
}

impl From<ProjectedItinerary> for WireItinerary {
    fn from(p: ProjectedItinerary) -> Self {
        let legs = p
            .legs
            .into_iter()
            .map(|leg| match leg {
                ProjectedLeg::Walk(w) => WireLeg::Walk {
                    from_stop_id: w.from_stop_id,
                    to_stop_id: w.to_stop_id,
                    depart_secs: w.depart_secs,
                    arrive_secs: w.arrive_secs,
                    mode: w.mode.to_string(), // always "WALK"
                },
                ProjectedLeg::Transit(t) => WireLeg::Transit {
                    from_stop_id: t.from_stop_id,
                    to_stop_id: t.to_stop_id,
                    depart_secs: t.depart_secs,
                    arrive_secs: t.arrive_secs,
                    route_id: t.route_id,
                    trip_id: t.trip_id,
                    mode: t.mode.to_string(),
                    board_stop_idx: t.board_stop_idx,
                    alight_stop_idx: t.alight_stop_idx,
                    intermediate_stops: t.intermediate_stops,
                },
            })
            .collect();
        WireItinerary {
            legs,
            board_secs: p.board_secs,
            alight_secs: p.alight_secs,
            transfers: p.transfers,
        }
    }
}
