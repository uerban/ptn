//! Schedule-tile coordinate grammar — port of `parseTileCoords` /
//! `leafSuffixSet` / `TILE_COORD_RE` (`packages/shared/src/poi/tileKey.ts:189-219`).
//!
//! Hand-rolled rather than via the `regex` crate: the grammar is a fixed,
//! small state machine (`-?\d{1,6}_-?\d{1,6}(?:-[0-3]){0,MAX_SUBDIVISION_DEPTH}`)
//! and pt-shared otherwise carries no regex dependency — matches the house
//! preference for hand-rolled minimal parsers over a new dependency for a
//! single fixed grammar (same reasoning as the GTFS-RT protobuf decoder).
//!
//! `MAX_SUBDIVISION_DEPTH` is duplicated (not shared) from
//! `crates/pt-producer/src/schedule_tiles/grid.rs::MAX_SUBDIVISION_DEPTH`:
//! pt-shared cannot depend on pt-producer (wrong direction — pt-producer
//! depends on pt-shared, never the reverse), so there is no crate-boundary-
//! respecting way to share this bare `usize` constant. `parses_max_depth_leaf`
//! below pins the duplicated value; keep both in sync by hand if the build
//! side ever changes it.

use crate::schedule_tile_manifest::ScheduleTileSubdivisionPlan;
use std::collections::HashSet;

/// Must equal `crates/pt-producer/src/schedule_tiles/grid.rs::MAX_SUBDIVISION_DEPTH`.
pub const MAX_SUBDIVISION_DEPTH: usize = 4;

/// The `tileSize` URL segment's expected value. Must equal
/// `crates/pt-producer/src/schedule_tiles/grid.rs::SCHEDULE_TILE_SIZE_LABEL`
/// (same cross-crate duplication rationale as `MAX_SUBDIVISION_DEPTH` above).
pub const SCHEDULE_TILE_SIZE_LABEL: &str = "6km";

/// A parsed tile-coord string: `cell_key` is the bare `"<x>_<y>"` cell,
/// `suffix` is the dash-joined quadtree path (`""` for a bare cell, e.g.
/// `"0"` or `"0-3"` for a leaf).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileCoordParts {
    pub cell_key: String,
    pub suffix: String,
}

/// Parse a tile-coord string into its cell key + quadtree suffix. Returns
/// `None` for anything the grammar rejects (malformed numeric parts,
/// over-depth suffix, digit outside `0..=3`, trailing dash).
pub fn parse_tile_coords(coords: &str) -> Option<TileCoordParts> {
    let bytes = coords.as_bytes();
    let mut i = 0;

    if bytes.first() == Some(&b'-') {
        i += 1;
    }
    let x_start = i;
    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    if i - x_start == 0 || i - x_start > 6 {
        return None;
    }
    if bytes.get(i) != Some(&b'_') {
        return None;
    }
    i += 1;
    if bytes.get(i) == Some(&b'-') {
        i += 1;
    }
    let y_start = i;
    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    if i - y_start == 0 || i - y_start > 6 {
        return None;
    }
    let cell_key = &coords[..i];

    let rest = bytes.get(i..).unwrap_or(b"");
    if rest.is_empty() {
        return Some(TileCoordParts {
            cell_key: cell_key.to_string(),
            suffix: String::new(),
        });
    }

    let mut digits: Vec<u8> = Vec::new();
    let mut j = 0;
    while j < rest.len() {
        if rest[j] != b'-' {
            return None;
        }
        j += 1;
        match rest.get(j) {
            Some(d @ b'0'..=b'3') => digits.push(*d - b'0'),
            _ => return None,
        }
        j += 1;
    }
    if digits.is_empty() || digits.len() > MAX_SUBDIVISION_DEPTH {
        return None;
    }
    let suffix = digits
        .iter()
        .map(|d| d.to_string())
        .collect::<Vec<_>>()
        .join("-");
    Some(TileCoordParts {
        cell_key: cell_key.to_string(),
        suffix,
    })
}

/// The one place a plan's leaf-suffix set is derived — mirrors
/// `leafSuffixSet` (`tileKey.ts:217-219`).
pub fn leaf_suffix_set(plan: &ScheduleTileSubdivisionPlan) -> HashSet<&str> {
    plan.leaves.iter().map(|l| l.suffix.as_str()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule_tile_manifest::{ScheduleTileBbox, ScheduleTileLeaf};

    #[test]
    fn constants_pin_producer_values() {
        assert_eq!(MAX_SUBDIVISION_DEPTH, 4);
        assert_eq!(SCHEDULE_TILE_SIZE_LABEL, "6km");
    }

    #[test]
    fn parses_bare_cell() {
        let p = parse_tile_coords("12_34").unwrap();
        assert_eq!(p.cell_key, "12_34");
        assert_eq!(p.suffix, "");
    }

    #[test]
    fn parses_negative_coords() {
        let p = parse_tile_coords("-1_-2").unwrap();
        assert_eq!(p.cell_key, "-1_-2");
        assert_eq!(p.suffix, "");
    }

    #[test]
    fn parses_leaf_suffix() {
        let p = parse_tile_coords("12_34-0-3").unwrap();
        assert_eq!(p.cell_key, "12_34");
        assert_eq!(p.suffix, "0-3");
    }

    #[test]
    fn parses_max_depth_leaf() {
        let p = parse_tile_coords("0_0-0-1-2-3").unwrap();
        assert_eq!(p.suffix, "0-1-2-3");
    }

    #[test]
    fn rejects_digit_out_of_range() {
        assert!(parse_tile_coords("12_34-4").is_none());
    }

    #[test]
    fn rejects_over_max_depth() {
        assert!(parse_tile_coords("0_0-0-1-2-3-0").is_none());
    }

    #[test]
    fn rejects_trailing_dash() {
        assert!(parse_tile_coords("12_34-").is_none());
    }

    #[test]
    fn rejects_missing_y() {
        assert!(parse_tile_coords("12_").is_none());
    }

    #[test]
    fn rejects_oversized_numeric_part() {
        assert!(parse_tile_coords("1234567_1").is_none());
    }

    #[test]
    fn rejects_non_numeric() {
        assert!(parse_tile_coords("abc").is_none());
        assert!(parse_tile_coords("").is_none());
    }

    #[test]
    fn leaf_suffix_set_collects_all_suffixes() {
        let plan = ScheduleTileSubdivisionPlan {
            leaves: vec![
                ScheduleTileLeaf {
                    suffix: "0".to_string(),
                    bbox: ScheduleTileBbox {
                        min_lat: 0.0,
                        max_lat: 1.0,
                        min_lon: 0.0,
                        max_lon: 1.0,
                    },
                    compressed_bytes: 1,
                    oversized: false,
                },
                ScheduleTileLeaf {
                    suffix: "1".to_string(),
                    bbox: ScheduleTileBbox {
                        min_lat: 0.0,
                        max_lat: 1.0,
                        min_lon: 0.0,
                        max_lon: 1.0,
                    },
                    compressed_bytes: 1,
                    oversized: false,
                },
            ],
        };
        let set = leaf_suffix_set(&plan);
        assert_eq!(set, HashSet::from(["0", "1"]));
    }
}
