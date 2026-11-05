//! Minimal read-side decoder for the schedule-tile wire format — the
//! `Deserialize` counterpart the rtTile 3b RT-overlay route needs to
//! extract trip membership from a `.br` tile body. Write side (full shape,
//! `Serialize`-only): `crates/pt-producer/src/schedule_tiles/wire.rs`'s
//! `WireScheduleTile`.
//!
//! Deliberately partial: only `stringTable`, `trips[].tripIdIx`, and
//! `stops{}.{tripIxs,departureSecs}` are modeled — everything this route
//! needs to resolve "which trip ids touch this tile" (union `trip_ixs`
//! across all `stops` values, dedupe, resolve each via
//! `trips[ix].trip_id_ix` → `string_table[that_ix]`).
//! `routes`/`calendar`/`v`/`bundleHash`/`cityId`/`tileSize` are never read
//! by this route, so they're omitted entirely — `serde_json` ignores
//! unknown JSON fields by default, no `#[serde(deny_unknown_fields)]` here,
//! so a full real tile still decodes fine against this narrower shape.
//!
//! `departureSecs` IS modeled despite never being read for trip-id
//! resolution: `decodeScheduleTileFromText` (Node,
//! `packages/shared/src/transit/scheduleTileCodec.ts`) requires it present
//! per stop AND requires `tripIxs.length === departureSecs.length`,
//! rejecting the tile otherwise. Without that check here, a corrupt tile
//! (missing `departureSecs`, or a length mismatch) that Node's decoder
//! rejects with a 503 would silently decode "successfully" on this side and
//! get served/cached as a valid 200 — a parity gap, not a cosmetic one.
//! [`ScheduleTileTripMembership`]'s custom `Deserialize` impl enforces the
//! same two checks Node does.
//!
//! Field renames mirror `WireScheduleTile`/`WireTripRow`/`WireStopColumns`
//! exactly (verified against that file directly, not guessed) — this is
//! decoding real producer-written bytes, not a shape we control.

use indexmap::IndexMap;
use serde::{de::Error as _, Deserialize, Deserializer};

#[derive(Deserialize, Debug)]
struct TripRef {
    #[serde(rename = "tripIdIx")]
    trip_id_ix: u32,
}

#[derive(Deserialize, Debug)]
struct StopRef {
    #[serde(rename = "tripIxs")]
    trip_ixs: Vec<u32>,
    #[serde(rename = "departureSecs")]
    departure_secs: Vec<u32>,
}

/// Raw deserialize target — `ScheduleTileTripMembership` wraps this with a
/// post-parse validation pass (see the module doc) rather than deriving
/// `Deserialize` directly, so a parallel-array-length mismatch fails to
/// decode instead of silently producing a `ScheduleTileTripMembership` that
/// looks valid.
#[derive(Deserialize, Debug)]
struct RawScheduleTileTripMembership {
    #[serde(rename = "stringTable")]
    string_table: Vec<String>,
    trips: Vec<TripRef>,
    stops: IndexMap<String, StopRef>,
}

#[derive(Debug)]
pub struct ScheduleTileTripMembership {
    string_table: Vec<String>,
    trips: Vec<TripRef>,
    stops: IndexMap<String, StopRef>,
}

impl<'de> Deserialize<'de> for ScheduleTileTripMembership {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawScheduleTileTripMembership::deserialize(deserializer)?;
        for (stop_id, cols) in &raw.stops {
            if cols.trip_ixs.len() != cols.departure_secs.len() {
                return Err(D::Error::custom(format!(
                    "stops[\"{stop_id}\"] parallel arrays have mismatched lengths \
                     (tripIxs: {}, departureSecs: {})",
                    cols.trip_ixs.len(),
                    cols.departure_secs.len()
                )));
            }
        }
        Ok(Self {
            string_table: raw.string_table,
            trips: raw.trips,
            stops: raw.stops,
        })
    }
}

impl ScheduleTileTripMembership {
    /// Every distinct GTFS trip id touching any stop in this tile — no
    /// first-stop-ownership filtering, matching the tile builder's
    /// touch-any-stop membership set (Node parity, confirmed against the
    /// rtTile fidelity test).
    pub fn trip_ids(&self) -> Vec<String> {
        let mut trip_indices: Vec<u32> = self
            .stops
            .values()
            .flat_map(|s| s.trip_ixs.iter().copied())
            .collect();
        trip_indices.sort_unstable();
        trip_indices.dedup();
        trip_indices
            .into_iter()
            .filter_map(|ix| self.trips.get(ix as usize))
            .filter_map(|t| self.string_table.get(t.trip_id_ix as usize))
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-written literal matching `WireScheduleTile`'s exact field names
    /// (`crates/pt-producer/src/schedule_tiles/wire.rs`) — NOT derived via
    /// pt-producer's own encoder, since pt-producer depends on pt-shared
    /// (adding even a dev-dependency the other way would be a cycle).
    const TILE_JSON: &str = r#"{
        "v": 1,
        "bundleHash": "abc123",
        "cityId": "testcity",
        "tileSize": 6000,
        "stringTable": ["T1", "T2", "T3"],
        "routes": [],
        "calendar": [],
        "trips": [
            {"tripIdIx": 0, "routeIx": 0, "serviceIx": 0, "headsignIx": 0},
            {"tripIdIx": 1, "routeIx": 0, "serviceIx": 0, "headsignIx": 0},
            {"tripIdIx": 2, "routeIx": 0, "serviceIx": 0, "headsignIx": 0}
        ],
        "stops": {
            "s1": {"tripIxs": [0, 1], "departureSecs": [28800, 29000]},
            "s2": {"tripIxs": [1, 2], "departureSecs": [29200, 29400]}
        }
    }"#;

    #[test]
    fn decodes_and_extracts_deduped_trip_ids() {
        let tile: ScheduleTileTripMembership =
            serde_json::from_str(TILE_JSON).expect("decodes real wire shape");
        let mut ids = tile.trip_ids();
        ids.sort();
        // trip index 1 touches both s1 and s2 — must appear exactly once.
        assert_eq!(
            ids,
            vec!["T1".to_string(), "T2".to_string(), "T3".to_string()]
        );
    }

    #[test]
    fn ignores_unknown_fields_not_modeled_here() {
        // routes/calendar/v/bundleHash/cityId/tileSize are present in the
        // real wire format but absent from this struct — must not error.
        let tile: ScheduleTileTripMembership =
            serde_json::from_str(TILE_JSON).expect("unknown fields are ignored");
        assert_eq!(tile.trip_ids().len(), 3);
    }

    #[test]
    fn empty_tile_yields_no_trips() {
        let json = r#"{"stringTable":[],"trips":[],"stops":{}}"#;
        let tile: ScheduleTileTripMembership =
            serde_json::from_str(json).expect("minimal shape decodes");
        assert!(tile.trip_ids().is_empty());
    }

    #[test]
    fn a_trip_touching_two_stops_appears_once() {
        let tile: ScheduleTileTripMembership = serde_json::from_str(TILE_JSON).expect("decodes");
        let ids = tile.trip_ids();
        assert_eq!(ids.iter().filter(|id| *id == "T2").count(), 1);
    }

    /// Parity with `decodeScheduleTileFromText`'s
    /// `columns.tripIxs.length !== columns.departureSecs.length` check — a
    /// stop whose parallel arrays disagree in length must fail to decode
    /// (surfacing as the handler's 503 `TILE_READ_ERROR`), not silently
    /// decode with a truncated/misaligned membership set.
    #[test]
    fn mismatched_parallel_array_lengths_fails_to_decode() {
        let json = r#"{
            "stringTable": ["T1"],
            "trips": [{"tripIdIx": 0, "routeIx": 0, "serviceIx": 0, "headsignIx": 0}],
            "stops": {"s1": {"tripIxs": [0], "departureSecs": []}}
        }"#;
        let result: Result<ScheduleTileTripMembership, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "tripIxs/departureSecs length mismatch must not decode"
        );
    }

    /// Parity with the same codec's `!Array.isArray(columns.departureSecs)`
    /// guard: a stop missing `departureSecs` entirely must fail to decode,
    /// not silently succeed because this crate never reads the field for
    /// trip-id resolution.
    #[test]
    fn missing_departure_secs_fails_to_decode() {
        let json = r#"{
            "stringTable": ["T1"],
            "trips": [{"tripIdIx": 0, "routeIx": 0, "serviceIx": 0, "headsignIx": 0}],
            "stops": {"s1": {"tripIxs": [0]}}
        }"#;
        let result: Result<ScheduleTileTripMembership, _> = serde_json::from_str(json);
        assert!(result.is_err(), "missing departureSecs must not decode");
    }

    #[test]
    fn matching_parallel_array_lengths_across_multiple_stops_decodes() {
        let json = r#"{
            "stringTable": ["T1", "T2"],
            "trips": [
                {"tripIdIx": 0, "routeIx": 0, "serviceIx": 0, "headsignIx": 0},
                {"tripIdIx": 1, "routeIx": 0, "serviceIx": 0, "headsignIx": 0}
            ],
            "stops": {
                "s1": {"tripIxs": [0], "departureSecs": [100]},
                "s2": {"tripIxs": [], "departureSecs": []}
            }
        }"#;
        let tile: ScheduleTileTripMembership =
            serde_json::from_str(json).expect("equal-length parallel arrays decode");
        assert_eq!(tile.trip_ids(), vec!["T1".to_string()]);
    }
}
