//! CLI entry point for pt-build-transfers. Dijkstra-engine equivalent of
//! `node scripts/build-transfers.mjs --engine=dijkstra`.

use clap::Parser;
use pt_producer::transfers::{run_build, BuildArgs};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(
    name = "pt-build-transfers",
    about = "Build the PTFT pedestrian transfer table (dijkstra engine)"
)]
struct Cli {
    /// City id, used only for default --out-dir / --walking-graph-dir layout.
    #[arg(long)]
    city: String,

    /// JSON array of { id, lat, lon } stops.
    #[arg(long)]
    stops: PathBuf,

    /// Walking-graph variant subdir (default matches the Node CLI).
    #[arg(long, default_value = "pedestrian-only")]
    variant: String,

    /// Drop transfers longer than this many seconds.
    #[arg(long = "max-walk-secs", default_value_t = 900)]
    max_walk_secs: u32,

    /// Keep top-N nearest transfers per stop.
    #[arg(long = "max-degree", default_value_t = 16)]
    max_degree: usize,

    /// Stop→graph snap radius, meters.
    #[arg(long = "max-snap-meters", default_value_t = 200.0)]
    max_snap_meters: f64,

    /// Override the walking-graph directory (default: data/walking-graph/<city>/<variant>).
    #[arg(long = "walking-graph-dir")]
    walking_graph_dir: Option<PathBuf>,

    /// Override the output directory (default: data/transfers/<city>/<variant>).
    #[arg(long = "out-dir")]
    out_dir: Option<PathBuf>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let repo_root = std::env::current_dir().expect("cwd");
    let walking_dir = cli.walking_graph_dir.unwrap_or_else(|| {
        repo_root
            .join("data/walking-graph")
            .join(&cli.city)
            .join(&cli.variant)
    });
    let out_dir = cli.out_dir.unwrap_or_else(|| {
        repo_root
            .join("data/transfers")
            .join(&cli.city)
            .join(&cli.variant)
    });

    let args = BuildArgs {
        walking_geojsonseq_path: walking_dir.join("walking.geojsonseq"),
        stops_path: cli.stops,
        out_dir,
        max_walk_secs: cli.max_walk_secs,
        max_degree: cli.max_degree,
        max_snap_meters: cli.max_snap_meters,
        walk_speed_mps: 1.25, // DEFAULTS.walkSpeedMps in build-transfers.mjs — not a CLI flag there either
    };

    match run_build(&args, &cli.city, &cli.variant) {
        Ok(report) => {
            let p50 = report
                .transfers
                .walk_secs
                .p50
                .map_or_else(|| "null".to_string(), |value| value.to_string());
            eprintln!(
                "[build-transfers] wrote {} edges={} p50={}s",
                args.out_dir.join("transfers.bin").display(),
                report.transfers.edge_count,
                p50,
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("[build-transfers] error: {e}");
            ExitCode::FAILURE
        }
    }
}
