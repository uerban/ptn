//! Local transit dependency audit; does not build, install or publish data.
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Verify and inventory a local transit pack without running builders")]
struct Args {
    /// Generation directory containing pack.json and generation.json.
    #[arg(long)]
    generation: PathBuf,
    /// Omit shapes from the selection; keep the publisher's pack ID unchanged.
    #[arg(long)]
    without_geometry: bool,
}

fn main() {
    let args = Args::parse();
    match pt_artifacts::transit::inspect(&args.generation, !args.without_geometry)
        .and_then(|report| serde_json::to_string_pretty(&report).map_err(std::io::Error::other))
    {
        Ok(report) => println!("{report}"),
        Err(error) => {
            eprintln!("pt-pack-inspect: {error}");
            std::process::exit(1);
        }
    }
}
