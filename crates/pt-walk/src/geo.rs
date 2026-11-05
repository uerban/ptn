//! Local equirectangular projection (metres) and planar helpers. City-scale
//! walks are short enough that the projection error is centimetres.

use crate::graph::WalkGraph;

pub const EARTH_RADIUS_M: f64 = 6_371_008.8;
pub const M_PER_DEG: f64 = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;

pub type Xy = (f64, f64);

#[derive(Debug, Clone, Copy)]
pub struct Projection {
    kx: f64,
}

impl Projection {
    pub fn new(mid_lat_deg: f64) -> Self {
        Self {
            kx: M_PER_DEG * mid_lat_deg.to_radians().cos(),
        }
    }

    pub fn for_graph(g: &WalkGraph) -> Self {
        // Over every point, junctions and chain interiors alike.
        let (min, max) = g
            .jlat_e7
            .iter()
            .chain(&g.plat_e7)
            .fold((i32::MAX, i32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
        if min > max {
            return Self::new(0.0);
        }
        Self::new((f64::from(min) + f64::from(max)) / 2.0 / 1e7)
    }

    /// `(lat, lon)` degrees → `(x, y)` metres.
    pub fn project(&self, lat: f64, lon: f64) -> Xy {
        (lon * self.kx, lat * M_PER_DEG)
    }

    /// `(lat_e7, lon_e7)` → `(x, y)` metres. Exactly `project` of the
    /// degree values, so projecting on the fly matches a stored copy bit for
    /// bit.
    pub fn project_e7(&self, (lat_e7, lon_e7): (i32, i32)) -> Xy {
        self.project(f64::from(lat_e7) / 1e7, f64::from(lon_e7) / 1e7)
    }

    /// `(x, y)` metres → `(lat, lon)` degrees.
    pub fn unproject(&self, x: f64, y: f64) -> (f64, f64) {
        (y / M_PER_DEG, x / self.kx)
    }
}

pub fn dist(a: Xy, b: Xy) -> f64 {
    (b.0 - a.0).hypot(b.1 - a.1)
}

/// Compass bearing a → b in degrees, 0 = north, clockwise, in [0, 360).
pub fn bearing_deg(a: Xy, b: Xy) -> f64 {
    let d = (b.0 - a.0).atan2(b.1 - a.1).to_degrees();
    if d < 0.0 {
        d + 360.0
    } else {
        d
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Foot {
    pub point: Xy,
    /// Position along a→b, 0..=1.
    pub t: f64,
    pub dist: f64,
}

pub fn point_to_segment(p: Xy, a: Xy, b: Xy) -> Foot {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
    };
    let point = (a.0 + t * dx, a.1 + t * dy);
    Foot {
        point,
        t,
        dist: dist(p, point),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_round_trips_and_scales_longitude() {
        let p = Projection::new(54.68);
        let (x, y) = p.project(54.68, 25.28);
        let (lat, lon) = p.unproject(x, y);
        assert!((lat - 54.68).abs() < 1e-12 && (lon - 25.28).abs() < 1e-12);
        // 0.001° of longitude at 54.68°N is ~64.3 m, of latitude ~111.2 m.
        let east = dist(p.project(54.68, 25.28), p.project(54.68, 25.281));
        let north = dist(p.project(54.68, 25.28), p.project(54.681, 25.28));
        assert!((east - 64.3).abs() < 0.2, "east {east}");
        assert!((north - 111.2).abs() < 0.2, "north {north}");
    }

    #[test]
    fn bearings_are_clockwise_from_north() {
        let o = (0.0, 0.0);
        assert_eq!(bearing_deg(o, (0.0, 1.0)), 0.0);
        assert_eq!(bearing_deg(o, (1.0, 0.0)), 90.0);
        assert_eq!(bearing_deg(o, (0.0, -1.0)), 180.0);
        assert_eq!(bearing_deg(o, (-1.0, 0.0)), 270.0);
    }

    #[test]
    fn point_to_segment_clamps() {
        let f = point_to_segment((5.0, 3.0), (0.0, 0.0), (10.0, 0.0));
        assert_eq!((f.point, f.t, f.dist), ((5.0, 0.0), 0.5, 3.0));
        let f = point_to_segment((-4.0, 3.0), (0.0, 0.0), (10.0, 0.0));
        assert_eq!((f.point, f.t, f.dist), ((0.0, 0.0), 0.0, 5.0));
        let f = point_to_segment((1.0, 1.0), (2.0, 2.0), (2.0, 2.0));
        assert_eq!(f.t, 0.0);
    }

    #[test]
    fn for_graph_of_an_empty_graph_is_the_equator() {
        let g = crate::build::GraphBuilder::new().finish(Default::default());
        let p = Projection::for_graph(&WalkGraph::from_graph(&g).unwrap());
        let (x, y) = p.project(10.0, 1.0);
        assert!(x.is_finite() && y.is_finite());
        assert_eq!((x, y), Projection::new(0.0).project(10.0, 1.0));
        assert_eq!(p.unproject(x, y), Projection::new(0.0).unproject(x, y));
    }

    #[test]
    fn for_graph_uses_mid_latitude() {
        let g = crate::format::Graph::from_edges(
            vec![540_000_000, 560_000_000],
            vec![0, 0],
            &[(0, 1, 0)],
            vec![String::new()],
            Default::default(),
        );
        let p = Projection::for_graph(&WalkGraph::from_graph(&g).unwrap());
        let expected = Projection::new(55.0);
        assert_eq!(p.project(55.0, 1.0), expected.project(55.0, 1.0));
    }
}
