//! Per-cell tile projection — port of buildTileForCell.ts + groupStopsByCell.ts.
//!
//! `route_styles` (from `route-styles.json`) is the producer's stand-in for
//! the live `resolveRouteColor`/`resolveRouteSubMode` resolvers — mirrors
//! `buildResolvers` in packages/backend/scripts/schedule-tile-gen.mjs:39-57,
//! NOT the live-server resolver in store.ts (different semantics: the
//! producer's `resolveRouteSubMode` returns the JSON's `subMode` verbatim,
//! which is `sm ?? r.mode` — i.e. it is rarely `undefined` in real data,
//! unlike the live store's classification-only resolver).

use super::grid::schedule_tile_coord_at;
use super::inputs::TileInputs;
use super::mode::route_type_to_mode;
use super::wire::*;
use indexmap::IndexMap;
use unicode_normalization::UnicodeNormalization;

/// Bucket every stop (by index into `inputs.stops`) into its 6 km cell.
/// First-stop-seen cell order; per-cell stop order = stops order. Port of
/// groupStopsByCell.ts:16-29 (`iterStops` order == PTB Stops-region order,
/// which is `inputs.stops`'s order here — see inputs.rs's `TileStop` doc).
/// Key format `${x}_${y}` (groupStopsByCell.ts:20).
pub fn group_stops_by_cell(inputs: &TileInputs) -> IndexMap<String, Vec<usize>> {
    let mut cells: IndexMap<String, Vec<usize>> = IndexMap::new();
    for (i, stop) in inputs.stops.iter().enumerate() {
        let (x, y) = schedule_tile_coord_at(stop.lat, stop.lon);
        cells.entry(format!("{x}_{y}")).or_default().push(i);
    }
    cells
}

struct Interner {
    table: Vec<String>,
    ix: std::collections::HashMap<String, u32>,
}

impl Interner {
    fn new() -> Self {
        Self {
            table: Vec::new(),
            ix: std::collections::HashMap::new(),
        }
    }

    /// NFC-normalize then intern — mirrors `internString`
    /// (buildTileForCell.ts:41-50).
    fn intern(&mut self, raw: &str) -> u32 {
        let s: String = raw.nfc().collect();
        if let Some(&i) = self.ix.get(&s) {
            return i;
        }
        let i = self.table.len() as u32;
        self.ix.insert(s.clone(), i);
        self.table.push(s);
        i
    }
}

pub fn build_tile_for_cell(
    inputs: &TileInputs,
    cell_stops: &[usize],
    bundle_hash: &str,
    city_id: &str,
    tile_size: u32,
) -> WireScheduleTile {
    let mut strings = Interner::new();
    let mut trip_ix_by_trip: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    let mut trips: Vec<WireTripRow> = Vec::new();
    let mut route_ix_by_route: std::collections::HashMap<u32, u32> =
        std::collections::HashMap::new();
    let mut routes: Vec<WireRouteRow> = Vec::new();
    let mut service_ix_by_service: std::collections::HashMap<u32, u32> =
        std::collections::HashMap::new();
    let mut calendar: Vec<WireCalendarRow> = Vec::new();
    let mut stops: IndexMap<String, WireStopColumns> = IndexMap::new();

    for &si in cell_stops {
        let stop = &inputs.stops[si];
        let (trip_col, dep_col) = &inputs.stop_times[si];
        if trip_col.is_empty() {
            // buildTileForCell.ts:138-144 — empty-columns row, key still
            // present (not omitted).
            stops.insert(
                stop.id.clone(),
                WireStopColumns {
                    trip_ixs: vec![],
                    departure_secs: vec![],
                },
            );
            continue;
        }
        let mut trip_ixs = Vec::with_capacity(trip_col.len());
        let mut departure_secs = Vec::with_capacity(dep_col.len());
        for (i, &canonical_trip_idx) in trip_col.iter().enumerate() {
            let tix = intern_trip(
                inputs,
                canonical_trip_idx,
                &mut strings,
                &mut trip_ix_by_trip,
                &mut trips,
                &mut route_ix_by_route,
                &mut routes,
                &mut service_ix_by_service,
                &mut calendar,
            );
            trip_ixs.push(tix);
            departure_secs.push(dep_col[i]);
        }
        stops.insert(
            stop.id.clone(),
            WireStopColumns {
                trip_ixs,
                departure_secs,
            },
        );
    }

    WireScheduleTile {
        v: 1,
        bundle_hash: bundle_hash.to_string(),
        city_id: city_id.to_string(),
        tile_size,
        string_table: strings.table,
        routes,
        calendar,
        trips,
        stops,
    }
}

#[allow(clippy::too_many_arguments)]
fn intern_trip(
    inputs: &TileInputs,
    trip_idx: u32,
    strings: &mut Interner,
    trip_ix_by_trip: &mut std::collections::HashMap<String, u32>,
    trips: &mut Vec<WireTripRow>,
    route_ix_by_route: &mut std::collections::HashMap<u32, u32>,
    routes: &mut Vec<WireRouteRow>,
    service_ix_by_service: &mut std::collections::HashMap<u32, u32>,
    calendar: &mut Vec<WireCalendarRow>,
) -> u32 {
    let t = &inputs.trips[trip_idx as usize];
    // Cache key is the NFC-normalized trip_id STRING, not the raw PTB trip
    // index — mirrors buildTileForCell.ts:116 exactly. Both this crate's
    // `IdentityInterner<String>` (pass1/identity.rs) and Node's
    // `TripStringTable` (parser.ts) assign trip indices by byte-exact string
    // match with no Unicode normalization, so a feed with two byte-distinct,
    // NFC-equivalent trip_id rows in trips.txt gets two distinct raw indices
    // in BOTH pipelines. Node's tile builder collapses them into one
    // `TileTripRow` at this cache; keying on `trip_idx` here would not, and
    // would silently diverge every downstream trip index once the split
    // point is reached. Keying on the NFC string replicates the collapse.
    let cache_key: String = t.trip_id.nfc().collect();
    if let Some(&ix) = trip_ix_by_trip.get(&cache_key) {
        return ix;
    }

    // Evaluation order mirrors buildTileForCell.ts:123-130 exactly: the trip
    // index is registered in the map BEFORE the row literal is built (line
    // 123-124), then the four fields are computed in JS object-literal
    // source order — tripIdIx (internString) → routeIx (internRoute) →
    // serviceIx (internService) → headsignIx (internString), last. This
    // fixes the shared-string-table order: tripId always precedes headsign.
    let ix = trips.len() as u32;
    trip_ix_by_trip.insert(cache_key, ix);
    let trip_id_ix = strings.intern(&t.trip_id);
    let route_ix = intern_route(inputs, t.route_idx, route_ix_by_route, routes);
    let service_ix = intern_service(inputs, t.service_idx, service_ix_by_service, calendar);
    let headsign_ix = strings.intern(&t.headsign);
    trips.push(WireTripRow {
        trip_id_ix,
        route_ix,
        service_ix,
        headsign_ix,
    });
    ix
}

fn intern_route(
    inputs: &TileInputs,
    route_idx: u32,
    route_ix_by_route: &mut std::collections::HashMap<u32, u32>,
    routes: &mut Vec<WireRouteRow>,
) -> u32 {
    if let Some(&ix) = route_ix_by_route.get(&route_idx) {
        return ix;
    }
    let r = &inputs.routes[route_idx as usize];
    let ix = routes.len() as u32;
    route_ix_by_route.insert(route_idx, ix);

    let style = inputs.route_styles.get(&r.route_id);

    // Mirrors schedule-tile-gen.mjs:51-56 `buildResolvers`, the producer's
    // resolver pair fed into buildTileForCell.ts's `internRoute`
    // (buildTileForCell.ts:69-71):
    //   resolveRouteColor(routeId) = routeStyles[routeId]?.color
    //     ? `#${color}` : undefined   -- truthy check: "" ⇒ undefined, NOT "#"
    //   color = overrideColor ?? (r.color ? `#${r.color}` : undefined)
    // `.filter(|c| !c.is_empty())` reproduces the JS truthy check: an empty
    // string in route-styles.json's `color` field (both palette color and
    // GTFS color absent, per color-artifacts-gen.mjs:63-65) must fall
    // through to the GTFS-color branch below, not literally become "#".
    let override_color = style
        .and_then(|s| s.color.as_deref())
        .filter(|c| !c.is_empty())
        .map(|c| format!("#{c}"));
    let color = override_color.or_else(|| {
        if r.route_color.is_empty() {
            None
        } else {
            Some(format!("#{}", r.route_color))
        }
    });

    // resolveRouteSubMode(routeId) = routeStyles[routeId]?.subMode, returned
    // verbatim (schedule-tile-gen.mjs:55) — no filtering here, unlike color.
    let sub_mode = style.and_then(|s| s.sub_mode.clone());

    routes.push(WireRouteRow {
        id: r.route_id.clone(),
        // buildTileForCell.ts:74-75 — shortName/longName are NFC-normalized
        // directly on the route row, NOT through the shared `internString`
        // table (they are not indices into `stringTable`).
        short_name: r.short_name.nfc().collect(),
        long_name: r.long_name.nfc().collect(),
        color,
        mode: route_type_to_mode(r.route_type).to_string(),
        sub_mode,
    });
    ix
}

fn intern_service(
    inputs: &TileInputs,
    service_idx: u32,
    service_ix_by_service: &mut std::collections::HashMap<u32, u32>,
    calendar: &mut Vec<WireCalendarRow>,
) -> u32 {
    if let Some(&ix) = service_ix_by_service.get(&service_idx) {
        return ix;
    }
    let s = &inputs.services[service_idx as usize];
    let ix = calendar.len() as u32;
    service_ix_by_service.insert(service_idx, ix);
    calendar.push(WireCalendarRow {
        service_id: s.service_id.clone(),
        days: [false; 7], // producer-mode placeholder (parity )
        start_date: String::new(),
        end_date: String::new(),
        added: s.added.clone(),
        removed: Vec::new(),
    });
    ix
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule_tiles::inputs::*;
    use std::collections::HashMap;

    fn two_stop_inputs() -> TileInputs {
        TileInputs {
            stops: vec![
                TileStop {
                    id: "s1".into(),
                    lat: 54.68,
                    lon: 25.28,
                },
                TileStop {
                    id: "s2".into(),
                    lat: 54.681,
                    lon: 25.281,
                },
            ],
            trips: vec![TileTrip {
                trip_id: "t1".into(),
                route_idx: 0,
                service_idx: 0,
                // NFD "Žirmūnai" (Z + combining caron, u + combining macron)
                // — must NFC-collapse.
                headsign: "Z\u{030C}irmu\u{0304}nai".into(),
            }],
            routes: vec![TileRoute {
                route_id: "r1".into(),
                short_name: "1".into(),
                long_name: "One".into(),
                route_color: "FF0000".into(),
                route_type: 3,
            }],
            services: vec![TileService {
                service_id: "svc:0".into(),
                added: vec!["20260701".into()],
            }],
            stop_times: vec![(vec![0], vec![28800]), (vec![], vec![])],
            route_styles: HashMap::new(),
        }
    }

    #[test]
    fn tile_interns_in_first_reference_order_and_nfc() {
        let inputs = two_stop_inputs();
        let cell_stops: Vec<usize> = vec![0, 1];
        let tile = build_tile_for_cell(&inputs, &cell_stops, "hash", "city", 6000);
        // stringTable: trip id first (interned inside internTrip before headsign)
        assert_eq!(tile.string_table[0], "t1");
        // headsign NFC-collapsed
        assert_eq!(tile.string_table[1], "Žirmūnai");
        // no style override → GTFS color with '#'
        assert_eq!(tile.routes[0].color.as_deref(), Some("#FF0000"));
        assert_eq!(tile.routes[0].mode, "BUS");
        // empty stop gets empty columns, key present
        assert_eq!(tile.stops["s2"].trip_ixs.len(), 0);
        // calendar placeholder shape
        let c = &tile.calendar[0];
        assert_eq!(c.days, [false; 7]);
        assert_eq!(c.start_date, "");
        assert_eq!(c.added, vec!["20260701"]);
        assert!(c.removed.is_empty());
    }

    /// Two distinct trips.txt rows whose trip_id values are byte-distinct
    /// but NFC-equivalent (a real, if unusual, GTFS data-quality artifact —
    /// PTB's `IdentityInterner<String>` assigns them two separate raw trip
    /// indices, same as Node's `TripStringTable`) must still collapse into
    /// ONE `WireTripRow` on the wire, matching buildTileForCell.ts's
    /// NFC-keyed `internTrip` cache. Regression test for the gap where
    /// keying the cache on the raw PTB trip index (rather than the
    /// NFC-normalized trip_id string) would emit two rows instead of one.
    #[test]
    fn distinct_trip_indices_with_nfc_equivalent_trip_ids_collapse_to_one_row() {
        let inputs = TileInputs {
            stops: vec![
                TileStop {
                    id: "s1".into(),
                    lat: 54.68,
                    lon: 25.28,
                },
                TileStop {
                    id: "s2".into(),
                    lat: 54.681,
                    lon: 25.281,
                },
            ],
            trips: vec![
                TileTrip {
                    // NFD: e + combining acute accent
                    trip_id: "e\u{0301}".into(),
                    route_idx: 0,
                    service_idx: 0,
                    headsign: "h".into(),
                },
                TileTrip {
                    // NFC precomposed é — same visible trip id, distinct bytes
                    trip_id: "\u{00e9}".into(),
                    route_idx: 0,
                    service_idx: 0,
                    headsign: "h".into(),
                },
            ],
            routes: vec![TileRoute {
                route_id: "r1".into(),
                short_name: "1".into(),
                long_name: "One".into(),
                route_color: "FF0000".into(),
                route_type: 3,
            }],
            services: vec![TileService {
                service_id: "svc:0".into(),
                added: vec![],
            }],
            stop_times: vec![(vec![0], vec![100]), (vec![1], vec![200])],
            route_styles: HashMap::new(),
        };
        let cell_stops: Vec<usize> = vec![0, 1];
        let tile = build_tile_for_cell(&inputs, &cell_stops, "hash", "city", 6000);
        assert_eq!(
            tile.trips.len(),
            1,
            "NFC-equivalent trip_ids from distinct raw trip indices must collapse to one row"
        );
        assert_eq!(tile.stops["s1"].trip_ixs, vec![0]);
        assert_eq!(
            tile.stops["s2"].trip_ixs,
            vec![0],
            "second stop's trip reference must resolve to the SAME collapsed row"
        );
    }

    #[test]
    fn empty_style_color_falls_back_to_gtfs_color_not_bare_hash() {
        // route-styles.json can carry `color: ""` for a route with neither a
        // sub-mode palette color nor a GTFS route_color
        // (color-artifacts-gen.mjs:63-65: `normalized = entry?.color ?? (r.color
        // ? ... : "")`). schedule-tile-gen.mjs's resolveRouteColor then treats
        // that "" as falsy → undefined (NOT "#"), so buildTileForCell falls
        // through to the GTFS route_color fallback. Here the GTFS color is also
        // absent, so the final color must be omitted (`None`), never `Some("#")`.
        let mut inputs = two_stop_inputs();
        inputs.routes[0].route_color = String::new();
        inputs.route_styles.insert(
            "r1".to_string(),
            RouteStyle {
                color: Some(String::new()),
                sub_mode: None,
            },
        );
        let cell_stops: Vec<usize> = vec![0, 1];
        let tile = build_tile_for_cell(&inputs, &cell_stops, "hash", "city", 6000);
        assert_eq!(tile.routes[0].color, None);
    }

    #[test]
    fn style_sub_mode_passes_through_verbatim() {
        // schedule-tile-gen.mjs:55 `resolveRouteSubMode` returns the JSON's
        // `subMode` field with no fallback logic of its own (unlike color) —
        // even a value equal to the route's own GTFS mode (the producer's
        // `sm ?? r.mode` convention, color-artifacts-gen.mjs:67) must flow
        // straight through to the wire.
        let mut inputs = two_stop_inputs();
        inputs.route_styles.insert(
            "r1".to_string(),
            RouteStyle {
                color: None,
                sub_mode: Some("BUS".to_string()),
            },
        );
        let cell_stops: Vec<usize> = vec![0, 1];
        let tile = build_tile_for_cell(&inputs, &cell_stops, "hash", "city", 6000);
        assert_eq!(tile.routes[0].sub_mode.as_deref(), Some("BUS"));
    }

    #[test]
    fn group_stops_by_cell_first_seen_order() {
        let inputs = two_stop_inputs();
        let cells = group_stops_by_cell(&inputs);
        assert_eq!(cells.len(), 1); // both stops in one 6km cell
        let (key, stops) = cells.first().unwrap();
        assert_eq!(stops, &vec![0usize, 1]);
        assert!(key.contains('_'));
    }
}
