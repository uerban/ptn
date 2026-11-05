//! Orchestration — port of buildTransfersDijkstra (build-transfers.mjs:189-288).
//! Loads the walking graph once, attaches all stops to nearby edges, runs Dijkstra per source
//! stop, encodes the wire bytes, and writes transfers.bin + report.json in
//! the same directory-and-filename convention as the Node CLI.

use crate::error::{Error, Result};
use crate::transfers::dijkstra::TransferPricer;
use crate::transfers::edgesnap::{snap_stops_to_edges, StopSnap};
use crate::transfers::graph::load_walking_graph;
use crate::transfers::kdtree::{SkippedStop, Stop as SnapStop};
use crate::transfers::wire::encode_checked;
use jiff::{fmt::temporal::DateTimePrinter, Timestamp};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Instant;

pub struct BuildArgs {
    pub walking_geojsonseq_path: PathBuf,
    pub stops_path: PathBuf,
    pub out_dir: PathBuf,
    pub max_walk_secs: u32,
    pub max_degree: usize,
    pub max_snap_meters: f64,
    pub walk_speed_mps: f64,
}

#[derive(Debug, Serialize)]
pub struct BuildReport {
    pub city: String,
    pub variant: String,
    pub engine: &'static str,
    pub inputs: InputsReport,
    pub graph: GraphReport,
    pub snap: SnapReport,
    pub transfers: TransfersReport,
    pub timing_ms: TimingReport,
    pub generated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputsReport {
    pub walking_graph_path: String,
    pub stop_count: usize,
    pub max_walk_secs: u32,
    pub max_degree: usize,
    pub walk_speed_mps: f64,
    pub max_snap_meters: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphReport {
    pub node_count: usize,
    pub edge_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapReport {
    pub snapped_count: usize,
    pub skipped_count: usize,
    pub skipped: Vec<SkippedStop>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransfersReport {
    pub size_bytes: usize,
    pub edge_count: usize,
    pub mean_edges_per_stop: f64,
    pub walk_secs: WalkSecsReport,
}

#[derive(Debug, Serialize)]
pub struct WalkSecsReport {
    pub p50: Option<u32>,
    pub p95: Option<u32>,
    pub p99: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingReport {
    pub load_graph: f64,
    pub snap_stops: f64,
    pub dijkstra: f64,
    pub total: f64,
}

/// One stop to price transfers for: its PTB/GTFS id and WGS84 position.
#[derive(Debug, Clone, Deserialize)]
pub struct StopPoint {
    pub id: String,
    pub lat: f64,
    pub lon: f64,
}

/// Pricing parameters shared by the CLI and the producer's per-generation build.
#[derive(Debug, Clone, Copy)]
pub struct TransferParams {
    pub max_walk_secs: u32,
    pub max_degree: usize,
    pub max_snap_meters: f64,
    pub walk_speed_mps: f64,
}

impl Default for TransferParams {
    /// The CLI defaults (`pt-build-transfers --help`).
    fn default() -> Self {
        Self {
            max_walk_secs: 900,
            max_degree: 16,
            max_snap_meters: 200.0,
            walk_speed_mps: 1.25, // DEFAULTS.walkSpeedMps in build-transfers.mjs
        }
    }
}

/// Build the PTFT bytes for `stops` over the walking graph at
/// `walking_geojsonseq_path` (plain or `.gz`). Returns the wire bytes and
/// the report the CLI writes next to them. Deterministic for equal inputs.
pub fn build_transfers(
    walking_geojsonseq_path: &std::path::Path,
    stops_input: &[StopPoint],
    params: TransferParams,
    city: &str,
    variant: &str,
) -> Result<(Vec<u8>, BuildReport)> {
    let args = params;
    let total_started = Instant::now();
    let load_started = Instant::now();
    let graph = load_walking_graph(walking_geojsonseq_path, args.walk_speed_mps)?;
    let load_ms = elapsed_ms(load_started);

    let snap_stops: Vec<SnapStop> = stops_input
        .iter()
        .map(|s| SnapStop {
            id: s.id.clone(),
            lat: s.lat,
            lon: s.lon,
        })
        .collect();
    let snap_started = Instant::now();
    let (snapped, skipped) = snap_stops_to_edges(&snap_stops, &graph, args.max_snap_meters)?;
    let snap_ms = elapsed_ms(snap_started);

    // Per-stop snaps, None for skipped stops: their wire entries
    // are empty edge lists and they are excluded from other stops' candidates.
    let stop_snaps: Vec<Option<StopSnap>> = stops_input
        .iter()
        .map(|s| snapped.get(&s.id).cloned())
        .collect();

    let mut all_edges: Vec<Vec<(u32, u32)>> = Vec::with_capacity(stops_input.len());
    let mut total_edges = 0usize;
    let mut all_walk_secs: Vec<u32> = Vec::new();
    let dijkstra_started = Instant::now();
    let mut pricer = TransferPricer::new(&graph, &stop_snaps);
    for i in 0..stops_input.len() {
        let out = pricer.transfers_from(i, args.max_walk_secs as f64, args.max_degree);
        total_edges += out.len();
        for &(_, secs) in &out {
            all_walk_secs.push(secs);
        }
        all_edges.push(out);
    }
    let dijkstra_ms = elapsed_ms(dijkstra_started);

    let stop_ids: Vec<String> = stops_input.iter().map(|s| s.id.clone()).collect();
    let bytes = encode_checked(&stop_ids, &all_edges)?;
    let total_ms = elapsed_ms(total_started);

    all_walk_secs.sort_unstable();

    let stop_count = stops_input.len();
    let report = BuildReport {
        city: city.to_string(),
        variant: variant.to_string(),
        engine: "dijkstra",
        inputs: InputsReport {
            walking_graph_path: walking_geojsonseq_path.display().to_string(),
            stop_count,
            max_walk_secs: args.max_walk_secs,
            max_degree: args.max_degree,
            walk_speed_mps: args.walk_speed_mps,
            max_snap_meters: args.max_snap_meters,
        },
        graph: GraphReport {
            node_count: graph.node_count,
            edge_count: graph.edge_count,
        },
        snap: SnapReport {
            snapped_count: snapped.len(),
            skipped_count: skipped.len(),
            skipped,
        },
        transfers: TransfersReport {
            size_bytes: bytes.len(),
            edge_count: total_edges,
            mean_edges_per_stop: if stop_count == 0 {
                0.0
            } else {
                total_edges as f64 / stop_count as f64
            },
            walk_secs: WalkSecsReport {
                p50: percentile(&all_walk_secs, 50.0),
                p95: percentile(&all_walk_secs, 95.0),
                p99: percentile(&all_walk_secs, 99.0),
            },
        },
        timing_ms: TimingReport {
            load_graph: round1(load_ms),
            snap_stops: round1(snap_ms),
            dijkstra: round1(dijkstra_ms),
            total: round1(total_ms),
        },
        generated_at: DateTimePrinter::new()
            .precision(Some(3))
            .timestamp_to_string(&Timestamp::now()),
    };
    Ok((bytes, report))
}

/// CLI path: read `--stops` JSON, build, write `transfers.bin` + `report.json`
/// into `args.out_dir` (the Node CLI's directory-and-filename convention).
pub fn run_build(args: &BuildArgs, city: &str, variant: &str) -> Result<BuildReport> {
    let stops_raw = std::fs::read_to_string(&args.stops_path)
        .map_err(|e| Error::Config(format!("--stops {}: {e}", args.stops_path.display())))?;
    let stops_input: Vec<StopPoint> = serde_json::from_str(&stops_raw)
        .map_err(|e| Error::Config(format!("--stops JSON parse: {e}")))?;
    let params = TransferParams {
        max_walk_secs: args.max_walk_secs,
        max_degree: args.max_degree,
        max_snap_meters: args.max_snap_meters,
        walk_speed_mps: args.walk_speed_mps,
    };
    let (bytes, report) = build_transfers(
        &args.walking_geojsonseq_path,
        &stops_input,
        params,
        city,
        variant,
    )?;
    std::fs::create_dir_all(&args.out_dir)
        .map_err(|e| Error::Config(format!("create_dir_all {}: {e}", args.out_dir.display())))?;
    let bin_path = args.out_dir.join("transfers.bin");
    std::fs::write(&bin_path, &bytes)
        .map_err(|e| Error::Config(format!("write {}: {e}", bin_path.display())))?;
    let report_path = args.out_dir.join("report.json");
    let report_bytes = serde_json::to_vec_pretty(&report)
        .map_err(|e| Error::Config(format!("serialize {}: {e}", report_path.display())))?;
    std::fs::write(&report_path, report_bytes)
        .map_err(|e| Error::Config(format!("write {}: {e}", report_path.display())))?;

    Ok(report)
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// p-th percentile of a value list already sorted ascending, using the
/// floor+clamp indexing from `percentiles()` (build-transfers.mjs:294-302):
/// `idx = floor((p / 100) * len)`, clamped to `len - 1`. `None` on an empty
/// input (mirrors the JS `p{N}: null` case).
fn percentile(sorted: &[u32], p: f64) -> Option<u32> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((p / 100.0) * sorted.len() as f64).floor() as usize;
    Some(sorted[idx.min(sorted.len() - 1)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // JS's JSON.parse rounds every number correctly; serde_json only does
    // with its float_roundtrip feature. Without it a 17-digit coordinate
    // can land one ulp off, and the two builders' snap distances differ.
    #[test]
    fn parses_stop_coordinates_exactly() {
        let text = "54.597695430304796";
        let exact: f64 = text.parse().unwrap();
        let stops: Vec<StopPoint> =
            serde_json::from_str(&format!(r#"[{{"id":"a","lat":{text},"lon":{text}}}]"#)).unwrap();
        assert_eq!(stops[0].lat.to_bits(), exact.to_bits());
        let line = format!(
            r#"{{"type":"Feature","geometry":{{"type":"LineString","coordinates":[[{text},{text}],[25.3,54.6]]}}}}"#
        );
        let feat: serde_json::Value = serde_json::from_str(&line).unwrap();
        let x = feat["geometry"]["coordinates"][0][0].as_f64().unwrap();
        assert_eq!(x.to_bits(), exact.to_bits());
    }

    #[test]
    fn end_to_end_small_graph_produces_report_and_bin() {
        let dir = tempdir();
        let geojsonseq_path = dir.join("walking.geojsonseq");
        let mut f = std::fs::File::create(&geojsonseq_path).unwrap();
        // Straight line of 3 walkable segments, ~10s apart at 1.25 m/s.
        writeln!(f, "\u{1e}{{\"type\":\"Feature\",\"geometry\":{{\"type\":\"LineString\",\"coordinates\":[[25.28,54.68],[25.2801,54.68],[25.2802,54.68],[25.2803,54.68]]}}}}").unwrap();

        let stops_path = dir.join("stops.json");
        std::fs::write(
            &stops_path,
            r#"[
            {"id":"s0","lat":54.68,"lon":25.28},
            {"id":"s1","lat":54.68,"lon":25.2803}
        ]"#,
        )
        .unwrap();

        let out_dir = dir.join("out");
        let args = BuildArgs {
            walking_geojsonseq_path: geojsonseq_path,
            stops_path,
            out_dir: out_dir.clone(),
            max_walk_secs: 900,
            max_degree: 16,
            max_snap_meters: 200.0,
            walk_speed_mps: 1.25,
        };
        let report = run_build(&args, "testcity", "pedestrian-only").unwrap();
        assert_eq!(report.inputs.stop_count, 2);
        assert!(out_dir.join("transfers.bin").exists());
        assert!(out_dir.join("report.json").exists());
        // s0 and s1 should see each other — they're both on the line graph.
        assert!(report.transfers.edge_count >= 2); // s0->s1 and s1->s0

        let report_json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(out_dir.join("report.json")).unwrap()).unwrap();
        assert_eq!(report_json["inputs"]["stopCount"], 2);
        assert_eq!(report_json["graph"]["nodeCount"], 4);
        assert_eq!(report_json["snap"]["skippedCount"], 0);
        assert_eq!(report_json["transfers"]["edgeCount"], 2);
        assert!(report_json["transfers"]["walkSecs"]["p50"].is_number());
        assert!(report_json["timing_ms"]["total"].is_number());
        assert!(report_json["generated_at"].is_string());
    }

    #[test]
    fn rejects_a_snap_radius_that_is_not_positive() {
        let dir = tempdir().join("bad-radius");
        std::fs::create_dir_all(&dir).unwrap();
        let geojsonseq_path = dir.join("walking.geojsonseq");
        std::fs::write(&geojsonseq_path, "\u{1e}{\"type\":\"Feature\",\"geometry\":{\"type\":\"LineString\",\"coordinates\":[[25.28,54.68],[25.2801,54.68]]}}\n").unwrap();
        let stops_path = dir.join("stops.json");
        std::fs::write(&stops_path, r#"[{"id":"s0","lat":54.68,"lon":25.28}]"#).unwrap();
        let args = BuildArgs {
            walking_geojsonseq_path: geojsonseq_path,
            stops_path,
            out_dir: dir.join("out"),
            max_walk_secs: 900,
            max_degree: 16,
            max_snap_meters: 0.0,
            walk_speed_mps: 1.25,
        };
        let err = run_build(&args, "testcity", "pedestrian-only").unwrap_err();
        assert!(err.to_string().contains("max_snap_meters"), "{err}");
    }

    fn tempdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ptn-transfers-build-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn percentile_of_empty_slice_is_none() {
        assert_eq!(percentile(&[], 50.0), None);
    }

    #[test]
    fn percentile_of_single_element_returns_that_element_at_any_p() {
        assert_eq!(percentile(&[42], 50.0), Some(42));
        assert_eq!(percentile(&[42], 95.0), Some(42));
        assert_eq!(percentile(&[42], 99.0), Some(42));
    }

    #[test]
    fn percentile_matches_floor_clamp_formula_on_four_element_list() {
        // sorted = [10, 20, 30, 40], len = 4.
        // idx = floor((p/100) * 4), clamped to len-1=3.
        let sorted = [10u32, 20, 30, 40];
        // p50: floor(0.5*4) = floor(2.0) = 2 -> sorted[2] = 30
        assert_eq!(percentile(&sorted, 50.0), Some(30));
        // p95: floor(0.95*4) = floor(3.8) = 3 -> sorted[3] = 40
        assert_eq!(percentile(&sorted, 95.0), Some(40));
        // p99: floor(0.99*4) = floor(3.96) = 3 -> sorted[3] = 40
        assert_eq!(percentile(&sorted, 99.0), Some(40));
        // p0 exercises the low boundary: floor(0.0*4) = 0 -> sorted[0] = 10
        assert_eq!(percentile(&sorted, 0.0), Some(10));
    }
}
