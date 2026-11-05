//! Verbatim port of KDTree2D + buildProjection (snapStops.mjs), plus the
//! stop/skip types shared with edgesnap.rs. The projection feeds edge
//! snapping and must match the JS bit for bit. The kd-tree now only
//! reports a skipped stop's distance to the nearest vertex, which does not
//! depend on tie order; it stays a verbatim port anyway.

use serde::Serialize;

const EARTH_METERS_PER_DEG: f64 = 111_319.49079327357;

pub struct EquirectProjection {
    center_lat: f64,
    center_lon: f64,
    cos_lat: f64,
}

impl EquirectProjection {
    /// Port of buildProjection (snapStops.mjs:160-178) — pass the MEAN of
    /// all graph-node lats/lons as the center, computed by the caller.
    pub fn from_center(center_lat: f64, center_lon: f64) -> Self {
        Self {
            center_lat,
            center_lon,
            cos_lat: (center_lat * std::f64::consts::PI / 180.0).cos(),
        }
    }

    pub fn from_nodes(lats: &[f64], lons: &[f64]) -> Self {
        let n = lats.len().max(1) as f64;
        let sum_lat: f64 = lats.iter().sum();
        let sum_lon: f64 = lons.iter().sum();
        Self::from_center(sum_lat / n, sum_lon / n)
    }

    pub fn project(&self, lat: f64, lon: f64) -> (f64, f64) {
        (
            (lon - self.center_lon) * self.cos_lat * EARTH_METERS_PER_DEG,
            (lat - self.center_lat) * EARTH_METERS_PER_DEG,
        )
    }
}

/// Packed-array kd-tree — verbatim port of KDTree2D (snapStops.mjs:187-273).
pub struct KdTree2D {
    xs: Vec<f64>,
    ys: Vec<f64>,
    indices: Vec<u32>,
}

impl KdTree2D {
    pub fn build(xs: Vec<f64>, ys: Vec<f64>) -> Self {
        assert_eq!(xs.len(), ys.len());
        let n = xs.len();
        let mut indices: Vec<u32> = (0..n as u32).collect();
        let mut t = KdTree2D {
            xs,
            ys,
            indices: Vec::new(),
        };
        t.build_range(&mut indices, 0, n, 0);
        t.indices = indices;
        t
    }

    fn build_range(&self, indices: &mut [u32], lo: usize, hi: usize, depth: usize) {
        if hi - lo <= 1 {
            return;
        }
        let axis = depth & 1;
        let mid = (lo + hi) / 2;
        self.quickselect(indices, lo, hi, mid, axis);
        self.build_range(indices, lo, mid, depth + 1);
        self.build_range(indices, mid + 1, hi, depth + 1);
    }

    fn quickselect(
        &self,
        indices: &mut [u32],
        mut lo: usize,
        mut hi: usize,
        k: usize,
        axis: usize,
    ) {
        while lo < hi - 1 {
            let pivot = self.partition(indices, lo, hi, axis);
            if pivot == k {
                return;
            }
            if pivot < k {
                lo = pivot + 1;
            } else {
                hi = pivot;
            }
        }
    }

    fn partition(&self, indices: &mut [u32], lo: usize, hi: usize, axis: usize) -> usize {
        let values: &[f64] = if axis == 0 { &self.xs } else { &self.ys };
        let last = hi - 1;
        // Median-of-three pivot for runs of >= 3 elements — avoids the
        // O(n^2) worst case on already-sorted input (which the recursive
        // build path produces naturally).
        if hi - lo >= 3 {
            let mid = (lo + hi) / 2;
            if values[indices[mid] as usize] < values[indices[lo] as usize] {
                indices.swap(lo, mid);
            }
            if values[indices[last] as usize] < values[indices[lo] as usize] {
                indices.swap(lo, last);
            }
            if values[indices[last] as usize] < values[indices[mid] as usize] {
                indices.swap(mid, last);
            }
            indices.swap(mid, last);
        }
        let pivot_val = values[indices[last] as usize];
        let mut store = lo;
        for i in lo..last {
            if values[indices[i] as usize] < pivot_val {
                indices.swap(i, store);
                store += 1;
            }
        }
        indices.swap(store, last);
        store
    }

    /// Returns (index, dist2); index == -1 when the tree is empty.
    pub fn nearest(&self, qx: f64, qy: f64) -> (i64, f64) {
        if self.indices.is_empty() {
            return (-1, f64::INFINITY);
        }
        let mut best_idx: i64 = -1;
        let mut best_dist2 = f64::INFINITY;
        self.search(
            0,
            self.indices.len(),
            0,
            qx,
            qy,
            &mut best_idx,
            &mut best_dist2,
        );
        (best_idx, best_dist2)
    }

    #[allow(clippy::too_many_arguments)]
    fn search(
        &self,
        lo: usize,
        hi: usize,
        depth: usize,
        qx: f64,
        qy: f64,
        best_idx: &mut i64,
        best_dist2: &mut f64,
    ) {
        if lo >= hi {
            return;
        }
        let axis = depth & 1;
        let mid = (lo + hi) / 2;
        let idx = self.indices[mid] as usize;
        let dx = qx - self.xs[idx];
        let dy = qy - self.ys[idx];
        let d2 = dx * dx + dy * dy;
        if d2 < *best_dist2 {
            *best_dist2 = d2;
            *best_idx = idx as i64;
        }
        let diff = if axis == 0 { dx } else { dy };
        let go_left_first = diff < 0.0;
        if go_left_first {
            self.search(lo, mid, depth + 1, qx, qy, best_idx, best_dist2);
            if diff * diff < *best_dist2 {
                self.search(mid + 1, hi, depth + 1, qx, qy, best_idx, best_dist2);
            }
        } else {
            self.search(mid + 1, hi, depth + 1, qx, qy, best_idx, best_dist2);
            if diff * diff < *best_dist2 {
                self.search(lo, mid, depth + 1, qx, qy, best_idx, best_dist2);
            }
        }
    }
}

pub struct Stop {
    pub id: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedStop {
    pub stop_id: String,
    pub nearest_meters: Option<f64>,
    pub reason: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_finds_closest_point() {
        let xs = vec![0.0, 10.0, 20.0, 30.0];
        let ys = vec![0.0, 0.0, 0.0, 0.0];
        let tree = KdTree2D::build(xs, ys);
        let (idx, dist2) = tree.nearest(9.0, 0.0);
        assert_eq!(idx, 1);
        assert_eq!(dist2, 1.0);
    }

    #[test]
    fn nearest_on_empty_tree_returns_none() {
        let tree = KdTree2D::build(vec![], vec![]);
        let (idx, _) = tree.nearest(0.0, 0.0);
        assert_eq!(idx, -1);
    }

    #[test]
    fn projection_matches_closed_form() {
        // centerLat=0, centerLon=0 (single node at origin) -> cosLat=1,
        // so project(lat,lon) == (lon * EARTH_METERS_PER_DEG, lat * EARTH_METERS_PER_DEG).
        let proj = EquirectProjection::from_center(0.0, 0.0);
        let p = proj.project(1.0, 1.0);
        assert!((p.0 - 111_319.49079327357).abs() < 1e-6);
        assert!((p.1 - 111_319.49079327357).abs() < 1e-6);

        // Non-zero center latitude: cosLat != 1, so this exercises the
        // longitude-compression term. A deleted `* self.cos_lat` in
        // `project()` would make this assertion fail (x would come out
        // as the full unscaled EARTH_METERS_PER_DEG instead).
        let center_lat = 54.68_f64;
        let proj_vilnius = EquirectProjection::from_center(center_lat, 0.0);
        // 1 degree of longitude away, same latitude as center -> y == 0.
        let p_vilnius = proj_vilnius.project(center_lat, 1.0);
        let expected_x = 1.0 * center_lat.to_radians().cos() * EARTH_METERS_PER_DEG;
        assert!((p_vilnius.0 - expected_x).abs() < 1e-6);
        assert!((p_vilnius.1 - 0.0).abs() < 1e-9);
    }
}
