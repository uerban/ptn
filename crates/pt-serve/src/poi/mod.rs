//! POI-tile serving support. The TypeScript build emits the authoritative
//! edge/anchor in `manifest.json`; Rust validates and consumes that artifact
//! instead of porting build-time policy derivation into the request plane.

pub mod catalog;

use pt_shared::poi_bundle_wire::PoiEntry;
use pt_shared::poi_tile_grid::{tile_coord_at, TileAnchor};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoiTileBounds {
    pub min_x: i64,
    pub max_x: i64,
    pub min_y: i64,
    pub max_y: i64,
}

impl PoiTileBounds {
    pub fn contains(self, x: i64, y: i64) -> bool {
        (self.min_x..=self.max_x).contains(&x) && (self.min_y..=self.max_y).contains(&y)
    }

    pub fn cell_count(self) -> u64 {
        let width = self.max_x.saturating_sub(self.min_x).saturating_add(1) as u64;
        let height = self.max_y.saturating_sub(self.min_y).saturating_add(1) as u64;
        width.saturating_mul(height)
    }
}

/// Entry indices grouped by POI tile coordinate. Built once when a city is
/// resolved so request misses never scan the full corpus.
#[derive(Debug, PartialEq)]
pub struct PoiTileIndex {
    by_coord: HashMap<String, Vec<usize>>,
    bounds: Option<PoiTileBounds>,
}

impl PoiTileIndex {
    pub fn build(entries: &[PoiEntry], edge_km: f64, anchor: TileAnchor) -> Self {
        let mut by_coord: HashMap<String, Vec<usize>> = HashMap::new();
        let mut bounds: Option<PoiTileBounds> = None;
        for (entry_ix, entry) in entries.iter().enumerate() {
            let coord = tile_coord_at(entry.lat, entry.lon, edge_km, anchor);
            by_coord
                .entry(format!("{}_{}", coord.x, coord.y))
                .or_default()
                .push(entry_ix);
            bounds = Some(match bounds {
                None => PoiTileBounds {
                    min_x: coord.x,
                    max_x: coord.x,
                    min_y: coord.y,
                    max_y: coord.y,
                },
                Some(mut current) => {
                    current.min_x = current.min_x.min(coord.x);
                    current.max_x = current.max_x.max(coord.x);
                    current.min_y = current.min_y.min(coord.y);
                    current.max_y = current.max_y.max(coord.y);
                    current
                }
            });
        }
        Self { by_coord, bounds }
    }

    pub fn bounds(&self) -> Option<PoiTileBounds> {
        self.bounds
    }

    pub fn entry_indices(&self, coords: &str) -> &[usize] {
        self.by_coord.get(coords).map(Vec::as_slice).unwrap_or(&[])
    }
}
