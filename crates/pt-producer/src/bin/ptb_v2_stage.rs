//! `pt-ptb-v2-stage`: build PTB v2 staging artifacts for review.
//!
//! Writes `bundle.ptb` (v2), `bundle-v1.ptb`, `bundle-v1.ptb.gz` and
//! `ptb-v2-staging.json` into `--out-dir`. It never publishes: no manifest,
//! pointer or generation directory is written, and the regular producer
//! paths do not call it.

use clap::Parser;
use pt_producer::cli::DeriveInseat;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(
    name = "pt-ptb-v2-stage",
    about = "Build unpublished PTB v2 staging artifacts from local GTFS zips"
)]
struct Cli {
    /// Local GTFS zip(s), in component-feed rank order.
    #[arg(long = "gtfs", required = true)]
    gtfs: Vec<PathBuf>,
    /// Feed IANA timezone (agency_timezone), e.g. Europe/Paris.
    #[arg(long)]
    timezone: String,
    /// Operational anchor date YYYYMMDD (default: today, UTC).
    #[arg(long = "anchor-date")]
    anchor_date: Option<u32>,
    /// Block-based in-seat derivation mode; `auto` sets DERIVE_BLOCK_INSEAT.
    #[arg(long, value_enum, default_value_t = DeriveInseat::Auto)]
    derive_inseat: DeriveInseat,
    /// Output directory for the staging artifacts.
    #[arg(long = "out-dir")]
    out_dir: PathBuf,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let mut records = Vec::new();
    for p in &cli.gtfs {
        match pt_producer::download::record_for_local(p) {
            Ok(r) => records.push(r),
            Err(e) => {
                eprintln!("pt-ptb-v2-stage: {}: {e}", p.display());
                return ExitCode::FAILURE;
            }
        }
    }
    let anchor = cli.anchor_date.unwrap_or_else(|| {
        let d = jiff::Timestamp::now()
            .to_zoned(jiff::tz::TimeZone::UTC)
            .date();
        d.year() as u32 * 10000 + d.month() as u32 * 100 + d.day() as u32
    });
    let extract = cli.out_dir.join("extract");
    match pt_producer::ptb_v2::stage(
        records,
        &extract,
        &cli.out_dir,
        anchor,
        &cli.timezone,
        cli.derive_inseat,
    ) {
        Ok(o) => {
            println!("{}", serde_json::to_string_pretty(&o).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("pt-ptb-v2-stage: {e}");
            ExitCode::FAILURE
        }
    }
}
