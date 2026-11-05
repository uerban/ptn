//! 6 km schedule-tile grid math. Port of packages/shared/src/poi/tileKey.ts
//! (schedule subset: SCHEDULE_TILE_EDGE_KM = 6, GLOBAL anchor: zero origin,
//! per-row latitude-derived lon scaling). f64 throughout. Coordinates come from
//! the Reader's exact i32@1e7→f64 accessors (matching the TS E7 decoder).
//!
//! Constants are DELIBERATELY duplicated from tileParams.ts rather than
//! shared: this is a byte-parity port pinned against the TS values, and the
//! grid tests cross-check against the built TS module. Do not "deduplicate".

pub const SCHEDULE_TILE_EDGE_KM: f64 = 6.0;
pub const SCHEDULE_TILE_EDGE_METERS: u32 = 6_000;
pub const SCHEDULE_TILE_SIZE_LABEL: &str = "6km";
pub const MAX_SUBDIVISION_DEPTH: usize = 4;

const KM_PER_DEG_LAT: f64 = 111.32;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bbox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
}

fn km_per_deg_lon(lat_deg: f64) -> f64 {
    KM_PER_DEG_LAT * (lat_deg * std::f64::consts::PI / 180.0).cos()
}

fn step_lat_deg() -> f64 {
    SCHEDULE_TILE_EDGE_KM / KM_PER_DEG_LAT
}

/// Port of `scheduleTileCoordAt` (global anchor: minLat=minLon=0, per-row
/// center latitude for the lon step). `Math.floor` ⇒ `f64::floor` (both
/// round toward -inf).
pub fn schedule_tile_coord_at(lat: f64, lon: f64) -> (i32, i32) {
    let step_lat = step_lat_deg();
    let y = (lat / step_lat).floor();
    let ref_lat = (y + 0.5) * step_lat;
    let step_lon = SCHEDULE_TILE_EDGE_KM / km_per_deg_lon(ref_lat);
    let x = (lon / step_lon).floor();
    (x as i32, y as i32)
}

/// Port of `scheduleCellBounds` — inverse of the coord fn on the same
/// per-row projection, so mid-point round-trips exactly.
pub fn schedule_cell_bounds(x: i32, y: i32) -> Bbox {
    let step_lat = step_lat_deg();
    let min_lat = y as f64 * step_lat;
    let max_lat = (y as f64 + 1.0) * step_lat;
    let center_lat = (y as f64 + 0.5) * step_lat;
    let step_lon = SCHEDULE_TILE_EDGE_KM / km_per_deg_lon(center_lat);
    let min_lon = x as f64 * step_lon;
    let max_lon = (x as f64 + 1.0) * step_lon;
    Bbox {
        min_lat,
        max_lat,
        min_lon,
        max_lon,
    }
}

/// Port of `quadrantDigitForPoint` — NORMATIVE tie-break: upper-closed
/// (`>=` goes to the upper child), matching Math.floor's grid convention.
/// {0:SW, 1:SE, 2:NW, 3:NE}.
pub fn quadrant_digit_for_point(bbox: &Bbox, lat: f64, lon: f64) -> u8 {
    let mid_lat = (bbox.min_lat + bbox.max_lat) / 2.0;
    let mid_lon = (bbox.min_lon + bbox.max_lon) / 2.0;
    let north: u8 = if lat >= mid_lat { 2 } else { 0 };
    let east: u8 = if lon >= mid_lon { 1 } else { 0 };
    north + east
}

/// Port of `bisectQuadrant` — an EXACT bisection of the parent bounds. NEVER
/// recompute the child from a child mid-latitude (sub-cells live inside one
/// parent row, so the lon step stays the parent's). Keeps splits
/// bit-deterministic across builds.
pub fn bisect_quadrant(bbox: &Bbox, digit: u8) -> Bbox {
    let mid_lat = (bbox.min_lat + bbox.max_lat) / 2.0;
    let mid_lon = (bbox.min_lon + bbox.max_lon) / 2.0;
    let north = digit & 2 != 0;
    let east = digit & 1 != 0;
    Bbox {
        min_lat: if north { mid_lat } else { bbox.min_lat },
        max_lat: if north { bbox.max_lat } else { mid_lat },
        min_lon: if east { mid_lon } else { bbox.min_lon },
        max_lon: if east { bbox.max_lon } else { mid_lon },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cross-checked against packages/shared/src/poi/tileKey.ts (see step 2).
    #[test]
    fn coord_at_matches_ts() {
        // Vilnius Cathedral ~ (54.685826, 25.287363)
        let c = schedule_tile_coord_at(54.685826, 25.287363);
        assert_eq!(c, (271, 1014));
        // Negative lon (west hemisphere) floors toward -inf.
        let c2 = schedule_tile_coord_at(40.0, -74.0);
        assert!(c2.0 < 0);
    }

    #[test]
    fn cell_bounds_round_trips() {
        let (x, y) = schedule_tile_coord_at(54.685826, 25.287363);
        let b = schedule_cell_bounds(x, y);
        let mid_lat = (b.min_lat + b.max_lat) / 2.0;
        let mid_lon = (b.min_lon + b.max_lon) / 2.0;
        assert_eq!(schedule_tile_coord_at(mid_lat, mid_lon), (x, y));
    }

    #[test]
    fn quadrant_tie_breaks_upper_closed() {
        let b = Bbox {
            min_lat: 0.0,
            max_lat: 2.0,
            min_lon: 0.0,
            max_lon: 2.0,
        };
        assert_eq!(quadrant_digit_for_point(&b, 1.0, 1.0), 3); // on both split planes → NE
        assert_eq!(quadrant_digit_for_point(&b, 0.5, 0.5), 0);
        assert_eq!(quadrant_digit_for_point(&b, 0.5, 1.5), 1);
        assert_eq!(quadrant_digit_for_point(&b, 1.5, 0.5), 2);
    }

    #[test]
    fn bisect_exact_halves() {
        let b = Bbox {
            min_lat: 0.0,
            max_lat: 2.0,
            min_lon: 4.0,
            max_lon: 8.0,
        };
        assert_eq!(
            bisect_quadrant(&b, 3),
            Bbox {
                min_lat: 1.0,
                max_lat: 2.0,
                min_lon: 6.0,
                max_lon: 8.0
            }
        );
        assert_eq!(
            bisect_quadrant(&b, 0),
            Bbox {
                min_lat: 0.0,
                max_lat: 1.0,
                min_lon: 4.0,
                max_lon: 6.0
            }
        );
    }
}
