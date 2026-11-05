//! Port of packages/backend/src/gtfs/labelAnchors.ts. Pure geometry — no
//! color-math dependency. See that file's own header for algorithm
//! provenance (repulsion-based preferred direction + hybrid pure-pair/
//! cluster assignment over an internal spatial grid).

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use super::inputs::ColorArtifactStop;

/// Matches labelAnchors.ts's `DIRS` — index basis for angle_to_idx. Order is
/// part of the wire contract and has been verified byte-for-byte against
/// `packages/shared/src/types/store.ts`'s `LabelAnchor` union (which is
/// itself the JS solver's `DIRS` index basis, per that file's own doc
/// comment): `right, top-right, top, top-left, left, bottom-left, bottom,
/// bottom-right`. Confirmed matching — no reordering needed.
const DIRS: [&str; 8] = [
    "right",
    "top-right",
    "top",
    "top-left",
    "left",
    "bottom-left",
    "bottom",
    "bottom-right",
];

const BASE_R: f64 = 0.0012;
const EXTENDED_R: f64 = 0.003;

/// labelAnchors.ts stripTrailingNumber: `s.replace(/\s*\d+$/, "").trim()`.
///
/// The regex only strips a digit run that touches the *literal end* of the
/// string (optionally preceded by whitespace) — trailing whitespace AFTER
/// the digits (e.g. `"Stop 01  "`) prevents the match entirely, since `\d+`
/// must be immediately followed by `$`. So the digit-run search below must
/// run against the ORIGINAL string, not a pre-trimmed one — pre-trimming
/// first would incorrectly strip the number from `"Stop 01  "` (which TS
/// leaves as `"Stop 01"` after its own trailing `.trim()`). The final
/// `.trim()` (both ends, matching TS's `.trim()`) is applied once, after the
/// conditional digit-run strip, so it also cleans up leading whitespace and
/// any strings with no trailing digit run at all.
fn strip_trailing_number(s: &str) -> String {
    let digit_start = s
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_ascii_digit())
        .last()
        .map(|(i, _)| i);
    let without_number = match digit_start {
        Some(i) => s[..i].trim_end(),
        None => s,
    };
    without_number.trim().to_string()
}

struct Pt {
    name: String,
    stripped: String,
    lat: f64,
    lon: f64,
}

fn same_logical_pt(a: &Pt, b: &Pt) -> bool {
    a.name == b.name || (a.stripped == b.stripped && !a.stripped.is_empty())
}

fn pair_radius_pt(a: &Pt, b: &Pt) -> f64 {
    if same_logical_pt(a, b) {
        EXTENDED_R
    } else {
        BASE_R
    }
}

/// labelAnchors.ts geoDist — equirectangular, cos-corrected degrees.
fn geo_dist(a: &Pt, b: &Pt) -> f64 {
    let dlat = a.lat - b.lat;
    let dlon = (a.lon - b.lon) * (a.lat * std::f64::consts::PI / 180.0).cos();
    (dlat * dlat + dlon * dlon).sqrt()
}

fn angle_to_idx(angle: f64) -> usize {
    let normalized = ((angle % 360.0) + 360.0) % 360.0;
    ((normalized / 45.0).round() as i64).rem_euclid(8) as usize
}

// ---- Spatial grid (labelAnchors.ts buildGrid/candidatesOf) ----

struct Grid {
    cells: HashMap<i64, Vec<usize>>,
    cx: Vec<i32>,
    cy: Vec<i32>,
}

const CELL_OFFSET: i64 = 1_000_000;
const CELL_STRIDE: i64 = 4_000_000;
fn cell_key(gx: i32, gy: i32) -> i64 {
    (gx as i64 + CELL_OFFSET) * CELL_STRIDE + (gy as i64 + CELL_OFFSET)
}

fn build_grid(pts: &[Pt]) -> Grid {
    let max_abs_lat = pts.iter().map(|p| p.lat.abs()).fold(0.0_f64, f64::max);
    let cos_ref = (max_abs_lat * std::f64::consts::PI / 180.0).cos();
    let cos_ref = if cos_ref == 0.0 { 1e-6 } else { cos_ref };

    let mut cells: HashMap<i64, Vec<usize>> = HashMap::new();
    let mut cx = Vec::with_capacity(pts.len());
    let mut cy = Vec::with_capacity(pts.len());
    for (i, p) in pts.iter().enumerate() {
        let gx = (p.lat / EXTENDED_R).floor() as i32;
        let gy = ((p.lon * cos_ref) / EXTENDED_R).floor() as i32;
        cx.push(gx);
        cy.push(gy);
        cells.entry(cell_key(gx, gy)).or_default().push(i);
    }
    Grid { cells, cx, cy }
}

fn candidates_of(grid: &Grid, i: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let (bx, by) = (grid.cx[i], grid.cy[i]);
    for dx in -1..=1 {
        for dy in -1..=1 {
            if let Some(bucket) = grid.cells.get(&cell_key(bx + dx, by + dy)) {
                for &j in bucket {
                    if j != i {
                        out.push(j);
                    }
                }
            }
        }
    }
    out.sort_unstable();
    out
}

// ---- Phase 1: repulsion-based preferred direction ----

fn compute_preferred(pts: &[Pt], candidates: &[Vec<usize>]) -> Vec<f64> {
    pts.iter()
        .enumerate()
        .map(|(i, s)| {
            let (mut dx, mut dy, mut n) = (0.0_f64, 0.0_f64, 0u32);
            for &j in &candidates[i] {
                let d = geo_dist(s, &pts[j]);
                let r = pair_radius_pt(s, &pts[j]);
                if d > r {
                    continue;
                }
                let w = 1.0 / (d * d + 1e-8);
                dx += (s.lon - pts[j].lon) * w;
                dy += (s.lat - pts[j].lat) * w;
                n += 1;
            }
            if n == 0 {
                0.0
            } else {
                dy.atan2(dx).to_degrees()
            }
        })
        .collect()
}

// ---- Phase 2: hybrid assignment ----

fn pick_best(preferred_idx: usize, taken: &HashSet<usize>) -> usize {
    if !taken.contains(&preferred_idx) {
        return preferred_idx;
    }
    let mut best_idx = preferred_idx;
    let mut best_score = i64::MAX;
    for delta in 1..8i64 {
        for sign in [1i64, -1i64] {
            let idx = (preferred_idx as i64 + delta * sign).rem_euclid(8) as usize;
            if taken.contains(&idx) {
                continue;
            }
            if delta < best_score {
                best_score = delta;
                best_idx = idx;
            }
        }
        if best_score <= delta {
            break;
        }
    }
    best_idx
}

fn hybrid_assign(pts: &[Pt], candidates: &[Vec<usize>], repulsion: &[f64]) -> Vec<usize> {
    let n = pts.len();
    let mut dirs: Vec<Option<usize>> = vec![None; n];

    let neighbors: Vec<Vec<usize>> = (0..n)
        .map(|i| {
            candidates[i]
                .iter()
                .copied()
                .filter(|&j| geo_dist(&pts[i], &pts[j]) < pair_radius_pt(&pts[i], &pts[j]))
                .collect()
        })
        .collect();

    let mut is_pure_pair = vec![false; n];
    for i in 0..n {
        if neighbors[i].len() == 1 {
            let j = neighbors[i][0];
            if neighbors[j].len() == 1 && neighbors[j][0] == i {
                is_pure_pair[i] = true;
                is_pure_pair[j] = true;
            }
        }
    }

    for i in 0..n {
        if !is_pure_pair[i] || dirs[i].is_some() {
            continue;
        }
        let j = neighbors[i][0];
        let away_i = (pts[i].lat - pts[j].lat)
            .atan2(pts[i].lon - pts[j].lon)
            .to_degrees();
        let away_j = (pts[j].lat - pts[i].lat)
            .atan2(pts[j].lon - pts[i].lon)
            .to_degrees();
        dirs[i] = Some(angle_to_idx(away_i));
        dirs[j] = Some(angle_to_idx(away_j));
    }

    let mut edges: Vec<(usize, usize, f64)> = Vec::new();
    for i in 0..n {
        if dirs[i].is_some() {
            continue;
        }
        for &j in &neighbors[i] {
            if j > i && dirs[j].is_none() {
                edges.push((i, j, geo_dist(&pts[i], &pts[j])));
            }
        }
    }
    edges.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap());

    for (i, j) in edges.into_iter().map(|(i, j, _)| (i, j)) {
        if dirs[i].is_some() && dirs[j].is_some() {
            continue;
        }
        if dirs[i].is_none() && dirs[j].is_none() {
            let away_i = (pts[i].lat - pts[j].lat)
                .atan2(pts[i].lon - pts[j].lon)
                .to_degrees();
            let away_j = ((away_i + 180.0) % 360.0) - 180.0;
            let idx_i = angle_to_idx(away_i);
            let idx_j = angle_to_idx(away_j);
            let mut taken_i = HashSet::new();
            let mut taken_j = HashSet::new();
            for &nb in &neighbors[i] {
                if let Some(d) = dirs[nb] {
                    taken_i.insert(d);
                }
            }
            for &nb in &neighbors[j] {
                if let Some(d) = dirs[nb] {
                    taken_j.insert(d);
                }
            }
            let di = pick_best(idx_i, &taken_i);
            dirs[i] = Some(di);
            taken_j.insert(di);
            dirs[j] = Some(pick_best(idx_j, &taken_j));
        } else {
            let (resolved, unresolved) = if dirs[i].is_some() { (i, j) } else { (j, i) };
            let mut taken = HashSet::new();
            for &nb in &neighbors[unresolved] {
                if let Some(d) = dirs[nb] {
                    taken.insert(d);
                }
            }
            let away_angle = (pts[unresolved].lat - pts[resolved].lat)
                .atan2(pts[unresolved].lon - pts[resolved].lon)
                .to_degrees();
            dirs[unresolved] = Some(pick_best(angle_to_idx(away_angle), &taken));
        }
    }

    for (i, d) in dirs.iter_mut().enumerate() {
        if d.is_none() {
            *d = Some(angle_to_idx(repulsion[i]));
        }
    }
    dirs.into_iter().map(|d| d.unwrap()).collect()
}

/// Port of labelAnchors.ts's computeLabelAnchors. `stops` MUST be in PTB Stops-region order (input
/// order is the only tie-break basis). Returns an `IndexMap` (not `HashMap`)
/// so insertion order matches the JS `Map`'s insertion order (== PTB stop order) — the
/// `encode_label_anchors` relies on this order directly instead of re-deriving it from a separate
/// stop list.
pub fn compute_label_anchors(stops: &[ColorArtifactStop]) -> IndexMap<String, &'static str> {
    let mut result = IndexMap::new();
    if stops.is_empty() {
        return result;
    }

    let pts: Vec<Pt> = stops
        .iter()
        .map(|s| Pt {
            name: s.name.clone(),
            stripped: strip_trailing_number(&s.name),
            lat: s.lat,
            lon: s.lon,
        })
        .collect();

    let grid = build_grid(&pts);
    let candidates: Vec<Vec<usize>> = (0..pts.len()).map(|i| candidates_of(&grid, i)).collect();
    let repulsion = compute_preferred(&pts, &candidates);
    let dirs = hybrid_assign(&pts, &candidates, &repulsion);

    for (i, stop) in stops.iter().enumerate() {
        result.insert(stop.id.clone(), DIRS[dirs[i]]);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stop(id: &str, name: &str, lat: f64, lon: f64) -> ColorArtifactStop {
        ColorArtifactStop {
            id: id.to_string(),
            name: name.to_string(),
            lat,
            lon,
        }
    }

    // Port of labelAnchors.test.ts's stripTrailingNumber-adjacent regex
    // semantics: trailing whitespace AFTER a digit run blocks the strip.
    #[test]
    fn strip_trailing_number_matches_ts_regex_semantics() {
        assert_eq!(strip_trailing_number("Stop 01"), "Stop");
        assert_eq!(strip_trailing_number("Platform 7"), "Platform");
        assert_eq!(strip_trailing_number("01"), "");
        // Trailing whitespace after the digit run prevents `\d+$` from
        // matching at all in the TS regex; only the final `.trim()` runs.
        assert_eq!(strip_trailing_number("Stop 01  "), "Stop 01");
        // Leading whitespace is removed by the TS `.trim()` regardless of
        // whether a trailing digit run was stripped.
        assert_eq!(strip_trailing_number("  Stop"), "Stop");
        assert_eq!(strip_trailing_number("  Stop 01"), "Stop");
    }

    // Port of labelAnchors.test.ts "anchors a fully isolated stop to the right".
    #[test]
    fn isolated_stop_anchors_right() {
        let stops = vec![stop("a", "Lonely", 50.0, 10.0)];
        let anchors = compute_label_anchors(&stops);
        assert_eq!(anchors.get("a").copied(), Some("right"));
    }

    // Port of labelAnchors.test.ts "gives a same-name cross-street pair
    // opposing anchors" — same-name pair, ~110 m apart (within EXTENDED_R,
    // outside BASE_R), exercising the extended radius.
    #[test]
    fn same_name_pair_uses_extended_radius_and_opposes() {
        let stops = vec![
            stop("a", "Cathedral Sq", 54.685, 25.28),
            stop("b", "Cathedral Sq", 54.686, 25.28),
        ];
        let anchors = compute_label_anchors(&stops);
        assert_eq!(anchors.get("a").copied(), Some("bottom"));
        assert_eq!(anchors.get("b").copied(), Some("top"));
    }

    // Port of labelAnchors.test.ts "pushes a pure pair of unrelated stops
    // apart" — distinct names, ~90 m apart east/west, within BASE_R.
    #[test]
    fn pure_pair_of_unrelated_stops_pushed_apart() {
        let stops = vec![
            stop("a", "Market", 54.685, 25.28),
            stop("b", "Town Hall", 54.685, 25.2812),
        ];
        let anchors = compute_label_anchors(&stops);
        assert_eq!(anchors.get("a").copied(), Some("left"));
        assert_eq!(anchors.get("b").copied(), Some("right"));
    }

    // Port of labelAnchors.test.ts "returns an empty map for no stops".
    #[test]
    fn empty_stops_yields_empty_map() {
        let anchors = compute_label_anchors(&[]);
        assert!(anchors.is_empty());
    }
}
