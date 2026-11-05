//! CSR walking graph loader — port of loadWalkingGraph (dijkstra.mjs:58).
//! Reads osmium's line-delimited GeoJSON ("geojsonseq") output, treats each
//! LineString/MultiLineString's consecutive coordinate pairs as undirected
//! graph edges weighted by haversine_meters / walkSpeedMps.

use crate::error::{Error, Result};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;

const EARTH_RADIUS_M: f64 = 6_371_008.8;

/// Port of haversineMeters (dijkstra.mjs:39-47).
pub fn haversine_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let to_rad = |d: f64| d * std::f64::consts::PI / 180.0;
    let d_lat = to_rad(lat2 - lat1);
    let d_lon = to_rad(lon2 - lon1);
    let s = (d_lat / 2.0).sin().powi(2)
        + to_rad(lat1).cos() * to_rad(lat2).cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * s.sqrt().min(1.0).asin()
}

/// Port of nodeId (dijkstra.mjs:31-33). The key controls graph-node dedup and
/// therefore topology, so signed zero must match JS: `(-0).toFixed(7)` is
/// `"0.0000000"`, not `"-0.0000000"`.
pub fn node_id(lat: f64, lon: f64) -> String {
    let lat = if lat == 0.0 { 0.0 } else { lat };
    let lon = if lon == 0.0 { 0.0 } else { lon };
    format!("{lat:.7},{lon:.7}")
}

pub struct WalkingGraph {
    pub node_count: usize,
    /// Undirected edge count (each direction counted once).
    pub edge_count: usize,
    pub lats: Vec<f64>,
    pub lons: Vec<f64>,
    /// CSR offsets, length node_count + 1.
    pub offsets: Vec<u32>,
    pub neighbors: Vec<u32>,
    pub weights: Vec<f64>,
    /// Speed the weights were computed at, for straight walks off the graph.
    pub walk_speed_mps: f64,
}

pub fn load_walking_graph(geojsonseq_path: &Path, walk_speed_mps: f64) -> Result<WalkingGraph> {
    if walk_speed_mps.is_nan() || walk_speed_mps <= 0.0 {
        return Err(Error::Config(
            "load_walking_graph: walk_speed_mps must be > 0".into(),
        ));
    }
    let file = std::fs::File::open(geojsonseq_path)
        .map_err(|e| Error::Config(format!("walking graph {}: {e}", geojsonseq_path.display())))?;
    // `.gz` graphs ship in the backend image (osmium GeoJSONSeq is ~5x
    // larger raw); decode on the fly, same lines either way.
    let reader: Box<dyn BufRead> = if geojsonseq_path.extension().is_some_and(|e| e == "gz") {
        Box::new(BufReader::new(flate2::read::GzDecoder::new(file)))
    } else {
        Box::new(BufReader::new(file))
    };

    let mut builder = GraphBuilder {
        id_to_idx: HashMap::new(),
        lats: Vec::new(),
        lons: Vec::new(),
        neighbors: Vec::new(),
        weights: Vec::new(),
        neighbor_sets: Vec::new(),
    };

    for line in reader.lines() {
        let line = line.map_err(|e| Error::Config(format!("walking graph read: {e}")))?;
        // osmium prefixes each Feature with an RS (\x1e) byte.
        let line = line.trim_start_matches('\u{1e}').trim();
        if line.is_empty() {
            continue;
        }
        let feat: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // malformed line — Node silently skips too (dijkstra.mjs:114)
        };
        for coords in extract_polylines(&feat) {
            let mut prev: Option<(u32, f64, f64)> = None;
            for xy in &coords {
                let (Some(lon), Some(lat)) = (
                    xy.get(0).and_then(|v| v.as_f64()),
                    xy.get(1).and_then(|v| v.as_f64()),
                ) else {
                    prev = None;
                    continue;
                };
                let idx = builder.intern(lat, lon);
                if let Some((prev_idx, prev_lat, prev_lon)) = prev {
                    let meters = haversine_meters(prev_lat, prev_lon, lat, lon);
                    builder.add_edge(prev_idx, idx, meters / walk_speed_mps);
                }
                prev = Some((idx, lat, lon));
            }
        }
    }

    let n = builder.lats.len();
    let mut offsets = vec![0u32; n + 1];
    let mut total = 0u32;
    for (offset, neighbors) in offsets.iter_mut().zip(&builder.neighbors) {
        *offset = total;
        total += neighbors.len() as u32;
    }
    offsets[n] = total;
    let mut flat_neighbors = vec![0u32; total as usize];
    let mut flat_weights = vec![0f64; total as usize];
    for ((&offset, neighbors), weights) in
        offsets.iter().zip(&builder.neighbors).zip(&builder.weights)
    {
        let base = offset as usize;
        for (k, (&nb, &wt)) in neighbors.iter().zip(weights.iter()).enumerate() {
            flat_neighbors[base + k] = nb;
            flat_weights[base + k] = wt;
        }
    }

    Ok(WalkingGraph {
        node_count: n,
        edge_count: (total / 2) as usize,
        lats: builder.lats,
        lons: builder.lons,
        offsets,
        neighbors: flat_neighbors,
        weights: flat_weights,
        walk_speed_mps,
    })
}

struct GraphBuilder {
    id_to_idx: HashMap<String, u32>,
    lats: Vec<f64>,
    lons: Vec<f64>,
    neighbors: Vec<Vec<u32>>,
    weights: Vec<Vec<f64>>,
    neighbor_sets: Vec<std::collections::HashSet<u32>>,
}

impl GraphBuilder {
    fn intern(&mut self, lat: f64, lon: f64) -> u32 {
        let id = node_id(lat, lon);
        if let Some(&idx) = self.id_to_idx.get(&id) {
            return idx;
        }
        let idx = self.lats.len() as u32;
        self.id_to_idx.insert(id, idx);
        self.lats.push(lat);
        self.lons.push(lon);
        self.neighbors.push(Vec::new());
        self.weights.push(Vec::new());
        self.neighbor_sets.push(std::collections::HashSet::new());
        idx
    }

    fn add_edge(&mut self, a: u32, b: u32, secs: f64) {
        if a == b {
            return;
        }
        if self.neighbor_sets[a as usize].contains(&b) {
            return;
        }
        self.neighbor_sets[a as usize].insert(b);
        self.neighbor_sets[b as usize].insert(a);
        self.neighbors[a as usize].push(b);
        self.weights[a as usize].push(secs);
        self.neighbors[b as usize].push(a);
        self.weights[b as usize].push(secs);
    }
}

/// Port of extractPolylines (dijkstra.mjs:176-181).
fn extract_polylines(feat: &serde_json::Value) -> Vec<Vec<serde_json::Value>> {
    let geom = &feat["geometry"];
    match geom["type"].as_str() {
        Some("LineString") => {
            vec![geom["coordinates"].as_array().cloned().unwrap_or_default()]
        }
        Some("MultiLineString") => geom["coordinates"]
            .as_array()
            .map(|parts| parts.iter().filter_map(|p| p.as_array().cloned()).collect())
            .unwrap_or_default(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn haversine_matches_known_distance() {
        // Vilnius Cathedral to Gediminas Castle, ~700m per common online calculators.
        let d = haversine_meters(54.685826, 25.287363, 54.687940, 25.291300);
        assert!((d - 380.0).abs() < 50.0, "got {d}");
    }

    #[test]
    fn node_id_quantizes_stably() {
        // Internal key only (parity ) — just needs same-input-same-output
        // and enough precision that distinct OSM nodes never collide.
        assert_eq!(
            node_id(54.6858260, 25.2873630),
            node_id(54.6858260, 25.2873630)
        );
        assert_ne!(
            node_id(54.6858260, 25.2873630),
            node_id(54.6858261, 25.2873630)
        );
    }

    #[test]
    fn node_id_normalizes_signed_zero_like_js_to_fixed() {
        assert_eq!(node_id(-0.0, -0.0), node_id(0.0, 0.0));
        assert_eq!(node_id(-0.0, -0.0), "0.0000000,0.0000000");
    }

    #[test]
    fn signed_zero_way_endpoints_share_one_graph_node() {
        let tmp = write_fixture_geojsonseq(&[
            r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-0.001,54.68],[-0.0,54.68]]}}"#,
            r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[0.0,54.68],[0.001,54.68]]}}"#,
        ]);
        let graph = load_walking_graph(&tmp, 1.25).unwrap();
        assert_eq!(graph.node_count, 3);
        assert_eq!(graph.edge_count, 2);
    }

    #[test]
    fn loads_linestring_and_multilinestring_dedupes_shared_endpoints() {
        let tmp = write_fixture_geojsonseq(&[
            r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[25.28,54.68],[25.29,54.69]]}}"#,
            r#"{"type":"Feature","geometry":{"type":"MultiLineString","coordinates":[[[25.29,54.69],[25.30,54.70]]]}}"#,
        ]);
        let graph = load_walking_graph(&tmp, 1.25).unwrap();
        // 3 unique nodes: (54.68,25.28), (54.69,25.29) shared, (54.70,25.30)
        assert_eq!(graph.node_count, 3);
        // 2 undirected edges = 4 CSR entries total.
        assert_eq!(graph.offsets[graph.node_count] as usize, 4);
    }

    fn write_fixture_geojsonseq(lines: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ptn-transfers-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("fixture-{}.geojsonseq", rand_suffix()));
        let mut body = String::new();
        for l in lines {
            body.push('\u{1e}'); // osmium RS prefix — must be stripped on read
            body.push_str(l);
            body.push('\n');
        }
        std::fs::write(&path, body).unwrap();
        path
    }

    fn rand_suffix() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }
}
