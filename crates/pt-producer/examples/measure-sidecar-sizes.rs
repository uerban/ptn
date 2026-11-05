//! Predict the size of the v5 departures-idx sidecar against a real GTFS feed, without writing it.
//! Used to size the flat-vs-sharded decision for departures-idx (>100 MB => shard by
//! stop_idx/65536).
//!
//! Run: cargo run -p pt-producer --example measure-sidecar-sizes -- \
//!   --gtfs-path <path-to-zip-or-dir>
//!
//! Shape-size prediction is outside this tool's scope.

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let gtfs_pos = args
        .iter()
        .position(|a| a == "--gtfs-path")
        .ok_or("missing --gtfs-path")?;
    let path = PathBuf::from(&args[gtfs_pos + 1]);

    // Build a Pass1Result via the producer's own pass-1 pipeline. Unzip first
    // if the input is a .zip.
    let extract_root = tempfile::tempdir()?;
    let feed_dir = if path.extension().and_then(|e| e.to_str()) == Some("zip") {
        // extract_all(&[zip], out_dir) creates out_dir/feed-0/ and extracts there.
        let feed_dirs = pt_producer::source::extract_all(&[path.clone()], extract_root.path())?;
        feed_dirs
            .into_iter()
            .next()
            .ok_or("extract_all returned empty list")?
    } else {
        path.clone()
    };

    let p1 = pt_producer::pass1::run_pass1_union(&[feed_dir])?;

    let num_stops = p1.stops.len() as u64;
    let total_st = p1.total_stop_times as u64;
    // departures-idx.bin: 72-byte header + (num_stops+1)*4 offset entries
    // + total_stop_times * 8 value bytes (u32 trip_idx + u32 sequence).
    let depidx_bytes = 72 + (num_stops + 1) * 4 + total_st * 8;

    println!("num_stops:               {num_stops}");
    println!("total_stop_times:        {total_st}");
    println!(
        "departures-idx.bin pred: {depidx_bytes} bytes ({:.1} MB)",
        depidx_bytes as f64 / 1_048_576.0
    );
    println!();
    println!(
        "Use this to decide flat-vs-sharded for departures-idx (>100 MB => shard)."
    );
    Ok(())
}
