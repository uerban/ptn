//! Metre-space graph construction for unit tests.

use crate::build::GraphBuilder;
use crate::format::{Meta, WayClass};
use crate::geo::M_PER_DEG;
use crate::graph::WalkGraph;

pub const LAT0: f64 = 54.68;
pub const LON0: f64 = 25.28;

/// Metres east (`x`) / north (`y`) of (LAT0, LON0) → `(lat, lon)`.
pub fn ll(x: f64, y: f64) -> (f64, f64) {
    (
        LAT0 + y / M_PER_DEG,
        LON0 + x / (M_PER_DEG * LAT0.to_radians().cos()),
    )
}

pub type Seg<'a> = ((f64, f64), (f64, f64), &'a str, WayClass);

/// Decoded graph from metre-space segments `(a, b, name, class)`.
pub fn graph(segs: &[Seg<'_>]) -> WalkGraph {
    let mut b = GraphBuilder::new();
    for &(a, c, name, class) in segs {
        let (la, oa) = ll(a.0, a.1);
        let (lc, oc) = ll(c.0, c.1);
        b.add_line(&[(oa, la), (oc, lc)], name, class);
    }
    WalkGraph::from_graph(&b.finish(Meta {
        city_id: "test".into(),
        ..Meta::default()
    }))
    .expect("test graph decodes")
}
