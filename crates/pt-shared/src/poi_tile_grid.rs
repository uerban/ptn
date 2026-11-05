//! POI-tile grid math — port of `tileCoordAtImpl`/`tileKeyAt`
//! (`packages/shared/src/poi/tileKey.ts:66-85`).
//!
//! Independent axis from schedule/RT tiles (`tile_coord.rs`, 6 km, global
//! origin, quadtree subdivision/leaves): POI tiles use a 12 km edge, a
//! per-city bbox-relative [`TileAnchor`] with a FIXED reference latitude
//! (not the per-row latitude schedule/RT tiles derive their anchor from),
//! and have no subdivision/leaf concept at all — a POI tile is always a
//! bare `<x>_<y>` cell. There is deliberately no `GLOBAL_ANCHOR` sentinel
//! here: pt-serve always has a concrete per-city anchor in hand (computed
//! by the tiling-policy derivation), unlike the TS source which defaults
//! `tileCoordAt`/`tileKeyAt` to the global grid for other (non-POI) axes
//! sharing the same underlying `tileCoordAtImpl`.

use serde::{Deserialize, Serialize};

const KM_PER_DEG_LAT: f64 = 111.32;

fn km_per_deg_lon(lat_deg: f64) -> f64 {
    // Keep JavaScript's exact operation order from
    // `Math.cos((lat * Math.PI) / 180)`: `to_radians()` rounds differently
    // at a few cell boundaries and can change the subsequent floor.
    KM_PER_DEG_LAT * ((lat_deg * std::f64::consts::PI) / 180.0).cos()
}

/// City-anchored grid origin. `ref_lat` is the bbox-CENTER latitude, used
/// ONLY to scale longitude degrees so cells stay ~square; it does NOT
/// shift the latitude axis. Mirrors `TileAnchor` (`tileKey.ts:29`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileAnchor {
    pub min_lat: f64,
    pub min_lon: f64,
    pub ref_lat: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileCoord {
    pub x: i64,
    pub y: i64,
}

/// A city bounding box — port of `Bbox` (`tileKey.ts:15-20`), co-located
/// with `TileAnchor` since `derivePoiTileEdge`'s ladder-scan needs both to
/// compute per-city anchors and whole-bbox fallback edges.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bbox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
}

fn step_lat_deg(edge_km: f64) -> f64 {
    edge_km / KM_PER_DEG_LAT
}

/// lat/lon → cell coordinate on a `edge_km`-wide grid anchored at
/// `anchor`. Port of `tileCoordAtImpl` (`tileKey.ts:66-75`) specialised to
/// the POI axis: `anchor.ref_lat` is always a concrete latitude here (the
/// TS source's `Number.isNaN(anchor.refLat)` per-row branch is the
/// schedule/RT-tile `GLOBAL_ANCHOR` case, which never applies to POI
/// tiles).
pub fn tile_coord_at(lat: f64, lon: f64, edge_km: f64, anchor: TileAnchor) -> TileCoord {
    let step_lat = step_lat_deg(edge_km);
    let y = ((lat - anchor.min_lat) / step_lat).floor();
    let step_lon = edge_km / km_per_deg_lon(anchor.ref_lat);
    let x = ((lon - anchor.min_lon) / step_lon).floor();
    TileCoord {
        x: x as i64,
        y: y as i64,
    }
}

/// `<cityId>/<edgeKm>km/<x>_<y>` — port of `tileKeyAt` (`tileKey.ts:82-85`).
pub fn tile_key_at(city_id: &str, lat: f64, lon: f64, edge_km: f64, anchor: TileAnchor) -> String {
    let TileCoord { x, y } = tile_coord_at(lat, lon, edge_km, anchor);
    format!("{city_id}/{edge_km}km/{x}_{y}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vilnius_anchor() -> TileAnchor {
        // bbox: minLon 25.08, minLat 54.58, maxLon 25.48, maxLat 54.78
        TileAnchor {
            min_lat: 54.58,
            min_lon: 25.08,
            ref_lat: (54.58 + 54.78) / 2.0,
        }
    }

    #[test]
    fn point_at_anchor_origin_is_cell_zero_zero() {
        let anchor = vilnius_anchor();
        let c = tile_coord_at(anchor.min_lat, anchor.min_lon, 12.0, anchor);
        assert_eq!(c, TileCoord { x: 0, y: 0 });
    }

    #[test]
    fn one_lat_step_north_increments_y_only() {
        let anchor = vilnius_anchor();
        let step_lat = step_lat_deg(12.0);
        let c = tile_coord_at(
            anchor.min_lat + step_lat * 1.5,
            anchor.min_lon,
            12.0,
            anchor,
        );
        assert_eq!(c, TileCoord { x: 0, y: 1 });
    }

    #[test]
    fn lon_step_uses_fixed_ref_lat_not_per_row_lat() {
        // Two points at very different latitudes (different y rows) but the
        // same longitude offset from the anchor must resolve to the SAME x,
        // because POI tiles scale longitude off the fixed `anchor.ref_lat`
        // — never the per-row latitude (that's the schedule/RT-tile-only
        // GLOBAL_ANCHOR behavior, deliberately not ported here).
        let anchor = vilnius_anchor();
        let step_lon = 12.0 / km_per_deg_lon(anchor.ref_lat);
        let lon = anchor.min_lon + step_lon * 2.5;

        let near_row = tile_coord_at(anchor.min_lat + 0.01, lon, 12.0, anchor);
        let far_row = tile_coord_at(anchor.min_lat + 5.0, lon, 12.0, anchor);
        assert_eq!(near_row.x, 2);
        assert_eq!(far_row.x, 2);
        assert_ne!(near_row.y, far_row.y);
    }

    #[test]
    fn negative_offsets_floor_toward_negative_infinity() {
        let anchor = vilnius_anchor();
        let c = tile_coord_at(anchor.min_lat - 0.01, anchor.min_lon - 0.01, 12.0, anchor);
        assert_eq!(c, TileCoord { x: -1, y: -1 });
    }

    #[test]
    fn tile_key_at_formats_city_edge_and_coord() {
        let anchor = vilnius_anchor();
        let key = tile_key_at("vilnius", anchor.min_lat, anchor.min_lon, 12.0, anchor);
        assert_eq!(key, "vilnius/12km/0_0");
    }

    #[test]
    fn tile_key_at_matches_manual_coord_computation() {
        let anchor = vilnius_anchor();
        let lat = 54.70;
        let lon = 25.20;
        let coord = tile_coord_at(lat, lon, 12.0, anchor);
        let key = tile_key_at("vilnius", lat, lon, 12.0, anchor);
        assert_eq!(key, format!("vilnius/12km/{}_{}", coord.x, coord.y));
    }

    #[test]
    fn javascript_radian_order_preserves_boundary_floors() {
        let anchor = vilnius_anchor();
        // Generated with `(refLat * Math.PI) / 180` and chosen exactly on
        // longitude-cell boundaries. Multiplying by `PI / 180` first yields
        // the preceding cell for both vectors.
        let vectors = [
            (3.0, 26.431_796_064_336_332, 29),
            (12.0, 26.571_637_036_509_056, 8),
        ];
        for (edge_km, lon, expected_x) in vectors {
            assert_eq!(
                tile_coord_at(anchor.min_lat, lon, edge_km, anchor),
                TileCoord {
                    x: expected_x,
                    y: 0,
                }
            );
        }
    }
}
