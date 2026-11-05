//! `PtWalkGraph` — on-device walking routes over a PTWG v2 artifact.

#[cfg(test)]
use pt_walk::format::FormatError;
#[cfg(test)]
use pt_walk::graph::WalkGraph;
use pt_walk::route::{Profile, WalkIndex};
use pt_walk::steps::steps;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StepWire {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn: Option<&'static str>,
    name: String,
    distance_meters: f64,
    start_index: usize,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteWire {
    /// `[lon, lat]`, GeoJSON order, as the map layer consumes it.
    coords: Vec<[f64; 2]>,
    distance_meters: f64,
    steps: Vec<StepWire>,
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

pub(crate) fn route_wire(
    index: &WalkIndex,
    from: (f64, f64),
    to: (f64, f64),
    profile: Profile,
) -> Option<RouteWire> {
    let path = index.route(from, to, profile)?;
    let graph = index.graph();
    let steps = steps(&path)
        .into_iter()
        .map(|s| StepWire {
            kind: s.kind.as_str(),
            turn: s.turn.map(|t| t.as_str()),
            name: graph.name(s.name_id).to_owned(),
            distance_meters: round1(s.distance_m),
            start_index: s.start_index,
        })
        .collect();
    Some(RouteWire {
        coords: path.points.iter().map(|&(lat, lon)| [lon, lat]).collect(),
        distance_meters: round1(path.distance_m),
        steps,
    })
}

#[wasm_bindgen]
pub struct PtWalkGraph {
    index: WalkIndex,
}

impl PtWalkGraph {
    #[cfg(test)]
    pub(crate) fn from_graph(graph: WalkGraph) -> Result<Self, FormatError> {
        Ok(Self {
            index: WalkIndex::new(graph)?,
        })
    }
}

#[wasm_bindgen]
impl PtWalkGraph {
    /// Decode a raw (already brotli-decoded) PTWG v2 buffer. Bad bytes
    /// (truncated, corrupt, or a graph too large to index) return a
    /// `JsError`, thrown on the JS side.
    #[wasm_bindgen(constructor)]
    pub fn new(buf: &[u8]) -> Result<PtWalkGraph, JsError> {
        let index = WalkIndex::from_bytes(buf)
            .map_err(|e| JsError::new(&format!("walk graph decode: {e}")))?;
        Ok(Self { index })
    }

    #[wasm_bindgen(js_name = cityId)]
    pub fn city_id(&self) -> String {
        self.index.graph().meta().city_id.clone()
    }

    /// Points of the graph (uncontracted nodes).
    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> u32 {
        self.index.graph().point_count() as u32
    }

    /// Junctions of the contracted graph.
    #[wasm_bindgen(js_name = junctionCount)]
    pub fn junction_count(&self) -> u32 {
        self.index.graph().junction_count() as u32
    }

    /// `{ coords, distanceMeters, steps }`, or `null` when there is no
    /// walkable route, including when a coordinate is not finite or out of
    /// range (that is not an error). `profile` is `"default"` or
    /// `"wheelchair"`; any other profile is a `JsError`.
    pub fn route(
        &self,
        from_lat: f64,
        from_lon: f64,
        to_lat: f64,
        to_lon: f64,
        profile: &str,
    ) -> Result<JsValue, JsError> {
        let profile = Profile::parse(profile)
            .ok_or_else(|| JsError::new(&format!("unknown walk profile {profile:?}")))?;
        match route_wire(&self.index, (from_lat, from_lon), (to_lat, to_lon), profile) {
            None => Ok(JsValue::NULL),
            Some(w) => serde_wasm_bindgen::to_value(&w).map_err(|e| JsError::new(&e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pt_walk::build::GraphBuilder;
    use pt_walk::format::{Meta, WayClass};

    fn index() -> WalkIndex {
        let mut b = GraphBuilder::new();
        // L-shape: 64 m east along "Pylimo g.", then 111 m north along "Vilniaus g.".
        b.add_line(
            &[(25.280, 54.680), (25.281, 54.680)],
            "Pylimo g.",
            WayClass::Street,
        );
        b.add_line(
            &[(25.281, 54.680), (25.281, 54.681)],
            "Vilniaus g.",
            WayClass::Street,
        );
        let g = b.finish(Meta {
            city_id: "vilnius".into(),
            ..Meta::default()
        });
        WalkIndex::new(WalkGraph::from_graph(&g).unwrap()).unwrap()
    }

    #[test]
    fn projects_a_route_to_the_wire_shape() {
        // Start ~6 m west of the corner's west end. That keeps the start out of
        // the 60 m attach slack of "Vilniaus g.", so the walk must use both streets.
        let w = route_wire(
            &index(),
            (54.680, 25.2799),
            (54.681, 25.28105),
            Profile::Default,
        )
        .expect("route");
        assert_eq!(w.coords.first(), Some(&[25.2799, 54.680]));
        assert_eq!(w.coords.last(), Some(&[25.28105, 54.681]));
        let kinds: Vec<_> = w.steps.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, vec!["depart", "turn", "arrive"]);
        assert_eq!(w.steps[0].name, "Pylimo g.");
        assert_eq!(w.steps[1].name, "Vilniaus g.");
        assert_eq!(w.steps[1].turn, Some("left"));
        let json = serde_json::to_string(&w.steps[0]).unwrap();
        assert!(
            json.contains("\"distanceMeters\"")
                && json.contains("\"startIndex\":0")
                && !json.contains("turn")
        );
    }

    #[test]
    fn exposes_city_and_counts() {
        let mut b = GraphBuilder::new();
        b.add_line(
            &[(25.280, 54.680), (25.281, 54.680)],
            "Pylimo g.",
            WayClass::Street,
        );
        let g = b.finish(Meta {
            city_id: "vilnius".into(),
            ..Meta::default()
        });
        let h = PtWalkGraph::from_graph(WalkGraph::from_graph(&g).unwrap()).unwrap();
        assert_eq!(h.city_id(), "vilnius");
        assert_eq!(h.node_count(), 2);
        assert_eq!(h.junction_count(), 2);
    }

    #[test]
    fn no_route_is_none() {
        assert_eq!(
            route_wire(&index(), (54.70, 25.30), (54.681, 25.281), Profile::Default),
            None
        );
    }
}
