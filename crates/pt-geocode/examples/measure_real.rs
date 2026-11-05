//! Throwaway measurement tooling for the FST single-bundle geocode spike.
//! Not part of the crate's tested public behavior — run manually:
//!   cargo run -p pt-geocode --release --example measure_real -- <fixture.json>
//!
//! Fixture is the JSON artifact `{ rows, keys }` produced by
//! `packages/backend/scripts/extract-addr-fixture.ts`.

use std::time::Instant;

use pt_geocode::{AddrIndex, AddrKey, AddrRow};
use serde::Deserialize;

#[derive(Deserialize)]
struct FixtureRow {
    label: String,
    lat: f64,
    lon: f64,
}

#[derive(Deserialize)]
struct FixtureKey {
    key: String,
    #[serde(rename = "rowId")]
    row_id: usize,
}

#[derive(Deserialize)]
struct FixtureArtifact {
    rows: Vec<FixtureRow>,
    keys: Vec<FixtureKey>,
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: measure_real <fixture.json>");
    let raw = std::fs::read_to_string(&path).expect("read fixture");
    let fixture: FixtureArtifact = serde_json::from_str(&raw).expect("parse fixture JSON");

    let row_count = fixture.rows.len();
    let key_count = fixture.keys.len();
    let rows: Vec<AddrRow> = fixture
        .rows
        .into_iter()
        .map(|f| AddrRow {
            label: f.label,
            lat: f.lat,
            lon: f.lon,
        })
        .collect();
    let keys: Vec<AddrKey> = fixture
        .keys
        .into_iter()
        .map(|f| AddrKey {
            key: f.key,
            row_id: f.row_id,
        })
        .collect();

    let build_start = Instant::now();
    let index = AddrIndex::build(&rows, &keys).expect("build should succeed on real data");
    let build_elapsed = build_start.elapsed();

    let size_bytes = index.size_bytes();
    let tiles_at_64kib = size_bytes.div_ceil(64 * 1024);

    println!("display rows:              {row_count}");
    println!("lookup keys:               {key_count}");
    println!(
        "FST size:                  {size_bytes} bytes ({:.2} MB)",
        size_bytes as f64 / 1_000_000.0
    );
    println!("build time:                {build_elapsed:?}");
    println!("equiv. 64KiB tiles:         {tiles_at_64kib} (for comparison only — this is a single bundle)");

    let sample_prefixes = ["gedimino", "pilies", "ozo", "konstitucijos", "a"];
    println!("\nsample prefix queries:");
    for prefix in sample_prefixes {
        let start = Instant::now();
        let matches = index.prefix_search(prefix, 10);
        let elapsed = start.elapsed();
        println!("  {prefix:?}: {} matches in {elapsed:?}", matches.len());
    }
}
