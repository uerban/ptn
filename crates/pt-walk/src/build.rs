//! Deterministic graph builder: coordinates in, CSR `Graph` out.

use std::collections::{BTreeMap, HashMap};

use crate::format::{pack_attr, Graph, Meta, WayClass, MAX_NODES};

fn e7(x: f64) -> i32 {
    (x * 1e7).round() as i32
}

pub struct GraphBuilder {
    node_ids: HashMap<(i32, i32), u32>,
    lat_e7: Vec<i32>,
    lon_e7: Vec<i32>,
    edges: BTreeMap<(u32, u32), u32>,
    names: Vec<String>,
    name_ids: HashMap<String, u32>,
}

impl Default for GraphBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl GraphBuilder {
    pub fn new() -> Self {
        let mut name_ids = HashMap::new();
        name_ids.insert(String::new(), 0);
        Self {
            node_ids: HashMap::new(),
            lat_e7: Vec::new(),
            lon_e7: Vec::new(),
            edges: BTreeMap::new(),
            names: vec![String::new()],
            name_ids,
        }
    }

    fn node(&mut self, key: (i32, i32)) -> u32 {
        let (lat_e7, lon_e7) = (&mut self.lat_e7, &mut self.lon_e7);
        *self.node_ids.entry(key).or_insert_with(|| {
            debug_assert!(
                lat_e7.len() < MAX_NODES as usize,
                "node count exceeds MAX_NODES"
            );
            let id = lat_e7.len() as u32;
            lat_e7.push(key.0);
            lon_e7.push(key.1);
            id
        })
    }

    fn name_id(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.name_ids.get(name) {
            return id;
        }
        debug_assert!(
            self.names.len() < (1 << 24),
            "name id does not fit in 24 bits"
        );
        let id = self.names.len() as u32;
        self.names.push(name.to_owned());
        self.name_ids.insert(name.to_owned(), id);
        id
    }

    /// Add one line. `coords` are `(lon, lat)` pairs in GeoJSON order.
    pub fn add_line(&mut self, coords: &[(f64, f64)], name: &str, class: WayClass) {
        for w in coords.windows(2) {
            let ka = (e7(w[0].1), e7(w[0].0));
            let kb = (e7(w[1].1), e7(w[1].0));
            if ka == kb {
                continue;
            }
            let a = self.node(ka);
            let b = self.node(kb);
            let key = (a.min(b), a.max(b));
            if !self.edges.contains_key(&key) {
                let nid = self.name_id(name);
                self.edges.insert(key, pack_attr(nid, class));
            }
        }
    }

    pub fn finish(self, meta: Meta) -> Graph {
        let edges: Vec<(u32, u32, u32)> = self
            .edges
            .into_iter()
            .map(|((u, v), a)| (u, v, a))
            .collect();
        Graph::from_edges(self.lat_e7, self.lon_e7, &edges, self.names, meta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{attr_class, attr_name, decode, encode};

    const A: (f64, f64) = (25.280, 54.680);
    const B: (f64, f64) = (25.281, 54.680);
    const C: (f64, f64) = (25.282, 54.680);

    #[test]
    fn dedupes_nodes_and_edges_first_way_wins() {
        let mut b = GraphBuilder::new();
        b.add_line(&[A, B, C], "Main", WayClass::Street);
        b.add_line(&[B, A], "Other", WayClass::Path); // same edge, reversed
        let g = b.finish(Meta::default());
        assert_eq!(g.node_count(), 3);
        assert_eq!(g.edge_count(), 2);
        assert_eq!(g.names, vec!["".to_string(), "Main".to_string()]);
        let h = g.neighbors_of(0).start;
        assert_eq!(attr_name(g.attrs[h]), 1);
        assert_eq!(attr_class(g.attrs[h]), WayClass::Street);
    }

    #[test]
    fn skips_self_loops_and_degenerate_lines() {
        let mut b = GraphBuilder::new();
        b.add_line(&[A, A], "Loop", WayClass::Path);
        b.add_line(&[A], "Point", WayClass::Path);
        b.add_line(&[], "Empty", WayClass::Path);
        let g = b.finish(Meta::default());
        assert_eq!(g.node_count(), 0);
        assert_eq!(g.names, vec![String::new()]);
    }

    #[test]
    fn rounds_to_e7_before_keying() {
        let mut b = GraphBuilder::new();
        b.add_line(&[A, B], "", WayClass::Path);
        b.add_line(&[(25.281_000_000_04, 54.680), C], "", WayClass::Path);
        let g = b.finish(Meta::default());
        assert_eq!(g.node_count(), 3, "B and B+4e-11 are one node");
    }

    #[test]
    fn same_input_gives_same_bytes() {
        let build = || {
            let mut b = GraphBuilder::new();
            b.add_line(&[C, B], "x", WayClass::Steps);
            b.add_line(&[A, B], "y", WayClass::Street);
            encode(&b.finish(Meta {
                city_id: "t".into(),
                ..Meta::default()
            }))
        };
        let bytes = build();
        assert_eq!(bytes, build());
        assert!(decode(&bytes).is_ok());
    }

    #[test]
    fn empty_builder_round_trips() {
        let g = GraphBuilder::new().finish(Meta::default());
        assert_eq!(g.node_count(), 0);
        let w = decode(&encode(&g)).unwrap();
        assert_eq!(
            (w.point_count(), w.segment_count(), w.name_count()),
            (0, 0, 1)
        );
    }
}
