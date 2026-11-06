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
    /// Also parse native binaries, validate metadata/timezone and decode tiles.
    #[arg(long)]
    native: bool,
}

fn main() {
    let args = Args::parse();
    let result = if args.native {
        pt_artifacts::transit_native::validate(
            &args.generation,
            !args.without_geometry,
            std::time::SystemTime::now(),
        )
    } else {
        pt_artifacts::transit::inspect(&args.generation, !args.without_geometry)
    };
    match result
        .and_then(|report| serde_json::to_string_pretty(&report).map_err(std::io::Error::other))
    {
        Ok(report) => println!("{report}"),
        Err(error) => {
            eprintln!("pt-pack-inspect: {error}");
            std::process::exit(1);
        }
    }
}
