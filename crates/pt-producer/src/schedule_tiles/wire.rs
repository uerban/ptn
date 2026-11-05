//! v1 tile wire structs — port of `WireScheduleTileV1`
//! (packages/shared/src/transit/scheduleTileCodec.ts:34) and its
//! `encodeScheduleTile` (same file, lines 55-84). Field order, key omission
//! for absent optionals, and `IndexMap` stop order replicate
//! `JSON.stringify` byte-for-byte — this IS the wire contract, not merely a
//! `serde_json::Value`-equivalent shape. All numbers are integers, so
//! `serde_json`'s compact output matches `JSON.stringify` exactly (no float
//! formatting divergence to worry about).

use indexmap::IndexMap;
use serde::Serialize;

use super::js_key_order::reordered_like_js_object_keys;

#[derive(Serialize)]
pub struct WireRouteRow {
    pub id: String,
    #[serde(rename = "shortName")]
    pub short_name: String,
    #[serde(rename = "longName")]
    pub long_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub mode: String,
    #[serde(rename = "subMode", skip_serializing_if = "Option::is_none")]
    pub sub_mode: Option<String>,
}

#[derive(Serialize)]
pub struct WireCalendarRow {
    #[serde(rename = "serviceId")]
    pub service_id: String,
    pub days: [bool; 7],
    #[serde(rename = "startDate")]
    pub start_date: String,
    #[serde(rename = "endDate")]
    pub end_date: String,
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(Serialize)]
pub struct WireTripRow {
    #[serde(rename = "tripIdIx")]
    pub trip_id_ix: u32,
    #[serde(rename = "routeIx")]
    pub route_ix: u32,
    #[serde(rename = "serviceIx")]
    pub service_ix: u32,
    #[serde(rename = "headsignIx")]
    pub headsign_ix: u32,
}

#[derive(Serialize, Clone)]
pub struct WireStopColumns {
    #[serde(rename = "tripIxs")]
    pub trip_ixs: Vec<u32>,
    #[serde(rename = "departureSecs")]
    pub departure_secs: Vec<u32>,
}

#[derive(Serialize)]
pub struct WireScheduleTile {
    pub v: u32,
    #[serde(rename = "bundleHash")]
    pub bundle_hash: String,
    #[serde(rename = "cityId")]
    pub city_id: String,
    #[serde(rename = "tileSize")]
    pub tile_size: u32,
    #[serde(rename = "stringTable")]
    pub string_table: Vec<String>,
    pub routes: Vec<WireRouteRow>,
    pub calendar: Vec<WireCalendarRow>,
    pub trips: Vec<WireTripRow>,
    /// Insertion order is part of the wire contract (matches
    /// `Object.entries` iteration order over the JS `stops` object, which
    /// for non-numeric-looking string keys is insertion order) — MUST stay
    /// an `IndexMap`, never a `HashMap`/`BTreeMap`. NOTE: plain insertion
    /// order is not the whole story — `stops` is a real JS object
    /// (`const stops: Record<string, TileStopColumns> = {}`), so any
    /// numeric-looking `stop_id` (e.g. `"42"`) is subject to JS
    /// `OrdinaryOwnPropertyKeys` integer-index reordering. `encode_schedule_tile`
    /// applies `js_key_order::reordered_like_js_object_keys` right before
    /// serialization to replicate that — see that module's doc.
    pub stops: IndexMap<String, WireStopColumns>,
}

/// Encode to the exact UTF-8 JSON byte stream `encodeScheduleTile` (Node)
/// produces. Byte equality with the Node encoder's output IS the spec —
/// see the golden tests below.
pub fn encode_schedule_tile(tile: &WireScheduleTile) -> Vec<u8> {
    // serde_json compact output == JSON.stringify for integer-only payloads:
    // same key order (struct field order / rename), same key omission
    // (skip_serializing_if), same string escaping (\", \\, \t, \n, \uXXXX
    // for other control chars), same non-ASCII passthrough (raw UTF-8, no
    // \uXXXX escaping of e.g. Lithuanian/Cyrillic text).
    //
    // `stops` is a real JS object (buildTileForCell.ts: `const stops:
    // Record<string, TileStopColumns> = {}`), so any numeric-looking
    // stop_id (e.g. "42") enumerates ahead of non-numeric ids per JS
    // OrdinaryOwnPropertyKeys — reorder the keys to match before encoding,
    // rather than serializing `tile.stops` directly. Values are borrowed
    // (not cloned) — see the doc on `reordered_like_js_object_keys`.
    let reordered_stops = reordered_like_js_object_keys(&tile.stops);
    // Field-for-field mirror of `WireScheduleTile`, borrowed rather than
    // owned, existing only so `stops` can point at the reordered map
    // instead of `tile.stops` directly (the public struct's field order and
    // `#[serde(rename)]`s stay the single source of truth for the derive on
    // `WireScheduleTile` itself). If `WireScheduleTile` gains, drops, or
    // reorders a field, this struct must be updated to match — there's no
    // compiler link between the two, only the golden-byte test below.
    #[derive(Serialize)]
    struct EncodeShim<'a> {
        v: u32,
        #[serde(rename = "bundleHash")]
        bundle_hash: &'a str,
        #[serde(rename = "cityId")]
        city_id: &'a str,
        #[serde(rename = "tileSize")]
        tile_size: u32,
        #[serde(rename = "stringTable")]
        string_table: &'a [String],
        routes: &'a [WireRouteRow],
        calendar: &'a [WireCalendarRow],
        trips: &'a [WireTripRow],
        stops: &'a IndexMap<String, &'a WireStopColumns>,
    }
    let shim = EncodeShim {
        v: tile.v,
        bundle_hash: &tile.bundle_hash,
        city_id: &tile.city_id,
        tile_size: tile.tile_size,
        string_table: &tile.string_table,
        routes: &tile.routes,
        calendar: &tile.calendar,
        trips: &tile.trips,
        stops: &reordered_stops,
    };
    serde_json::to_vec(&shim).expect("tile wire serialization is infallible")
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    /// Golden fixture generated from the Node encoder. The test checks byte-for-byte
    /// JSON.stringify parity.
    #[test]
    fn encode_matches_node_golden() {
        let mut stops = IndexMap::new();
        stops.insert(
            "s1".to_string(),
            WireStopColumns {
                trip_ixs: vec![0],
                departure_secs: vec![28800],
            },
        );
        stops.insert(
            "s2".to_string(),
            WireStopColumns {
                trip_ixs: vec![],
                departure_secs: vec![],
            },
        );
        let tile = WireScheduleTile {
            v: 1,
            bundle_hash: "abc123".into(),
            city_id: "testcity".into(),
            tile_size: 6000,
            string_table: vec!["trip:1".into(), "Žirmūnai".into(), "R1 short".into()],
            routes: vec![
                WireRouteRow {
                    id: "r1".into(),
                    short_name: "1".into(),
                    long_name: "Long".into(),
                    color: Some("#AABBCC".into()),
                    mode: "BUS".into(),
                    sub_mode: Some("express".into()),
                },
                WireRouteRow {
                    id: "r2".into(),
                    short_name: "2".into(),
                    long_name: "".into(),
                    color: None,
                    mode: "TRAM".into(),
                    sub_mode: None,
                },
            ],
            calendar: vec![WireCalendarRow {
                service_id: "svc:0".into(),
                days: [false; 7],
                start_date: "".into(),
                end_date: "".into(),
                added: vec!["20260701".into()],
                removed: vec![],
            }],
            trips: vec![WireTripRow {
                trip_id_ix: 0,
                route_ix: 0,
                service_ix: 0,
                headsign_ix: 1,
            }],
            stops,
        };
        let expected = include_bytes!("../../tests/fixtures/wire_golden.json");
        assert_eq!(encode_schedule_tile(&tile), expected.to_vec());
    }

    /// Pins the escape set `serde_json` must match byte-for-byte against
    /// `JSON.stringify`: quote, backslash, tab, newline, and a non-named
    /// control char (0x01, which JSON.stringify renders as `\u0001`, not a
    /// named escape — only 0x08/0x09/0x0A/0x0C/0x0D have named escapes).
    #[test]
    fn encode_matches_node_golden_escapes() {
        let tile = WireScheduleTile {
            v: 1,
            bundle_hash: "abc123".into(),
            city_id: "testcity".into(),
            tile_size: 6000,
            string_table: vec!["a\"b\\c\td\ne\u{1}f".into()],
            routes: vec![],
            calendar: vec![],
            trips: vec![],
            stops: IndexMap::new(),
        };
        let expected = include_bytes!("../../tests/fixtures/wire_golden_escapes.json");
        assert_eq!(encode_schedule_tile(&tile), expected.to_vec());
    }

    /// Numeric-looking stop_ids are valid per GTFS: an `ID` is any UTF-8
    /// sequence, with printable ASCII only a recommendation. Reference:
    /// <https://gtfs.org/documentation/schedule/reference/#field-types>.
    /// They get JS integer-index-key
    /// reordering: `stops` is a real JS object literal
    /// (buildTileForCell.ts's `const stops: Record<string,
    /// TileStopColumns> = {}`), so per ECMAScript's
    /// OrdinaryOwnPropertyKeys, canonical array-index keys ("42", "7")
    /// enumerate first (ascending numeric), ahead of non-numeric keys
    /// ("stopA"), regardless of insertion order. Mirrors the empirical
    /// node repro in js_key_order.rs's module doc.
    #[test]
    fn encode_reorders_numeric_stop_ids_like_js_object_keys() {
        let mut stops = IndexMap::new();
        // Insertion order: stopA, 42, 7 — none numerically ascending.
        stops.insert(
            "stopA".to_string(),
            WireStopColumns {
                trip_ixs: vec![],
                departure_secs: vec![],
            },
        );
        stops.insert(
            "42".to_string(),
            WireStopColumns {
                trip_ixs: vec![1],
                departure_secs: vec![100],
            },
        );
        stops.insert(
            "7".to_string(),
            WireStopColumns {
                trip_ixs: vec![2],
                departure_secs: vec![200],
            },
        );
        let tile = WireScheduleTile {
            v: 1,
            bundle_hash: "abc123".into(),
            city_id: "testcity".into(),
            tile_size: 6000,
            string_table: vec![],
            routes: vec![],
            calendar: vec![],
            trips: vec![],
            stops,
        };
        let body = encode_schedule_tile(&tile);
        // NOTE: intentionally NOT parsed via serde_json::Value here — this
        // crate doesn't enable serde_json's `preserve_order` feature, so
        // Value's object map re-sorts keys alphabetically (BTreeMap),
        // which would silently hide the very reordering bug under test.
        // Check raw byte order instead, like the sibling insertion-order
        // test below.
        let text = String::from_utf8(body).unwrap();
        let pos = |needle: &str| text.find(needle).unwrap();
        assert!(
            pos("\"7\":") < pos("\"42\":") && pos("\"42\":") < pos("\"stopA\":"),
            "numeric keys must sort ascending ahead of non-numeric keys, \
             regardless of insertion order; got: {text}"
        );
    }
}
