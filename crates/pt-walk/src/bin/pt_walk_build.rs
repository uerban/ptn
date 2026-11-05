//! `pt-walk-build --input <ways.geojsonseq> --city <id> --generated-at <s> --out <file.ptwg> [--source <s>]`
//!
//! Reads an osmium GeoJSONSeq export of walkable ways and writes a raw
//! (uncompressed) PTWG v2 file. Prints one JSON stats line on stdout:
//! `nodes`/`edges` count the uncontracted graph, `junctions`/`chains` what
//! the file stores after degree-2 contraction.

use std::io::{BufRead, BufReader};

use pt_walk::build::GraphBuilder;
use pt_walk::format::{encode, Meta};
use pt_walk::osm::parse_feature;
use pt_walk::route::WalkIndex;

const USAGE: &str =
    "usage: pt-walk-build --input <ways.geojsonseq> --city <id> --generated-at <s> --out <file.ptwg> [--source <s>]";

struct Args {
    input: String,
    city: String,
    generated_at: String,
    out: String,
    source: String,
}

fn valid_city_id(id: &str) -> bool {
    // Same shape nginx/walk-graph-static.inc accepts in the URL.
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn parse_args(mut it: impl Iterator<Item = String>) -> Result<Args, String> {
    let (mut input, mut city, mut generated_at, mut out) = (None, None, None, None);
    let mut source = None;
    while let Some(flag) = it.next() {
        if flag == "--help" || flag == "-h" {
            return Err(USAGE.to_owned());
        }
        let slot = match flag.as_str() {
            "--input" => &mut input,
            "--city" => &mut city,
            "--generated-at" => &mut generated_at,
            "--out" => &mut out,
            "--source" => &mut source,
            other => return Err(format!("unknown flag {other}\n{USAGE}")),
        };
        if slot.is_some() {
            return Err(format!("duplicate flag {flag}\n{USAGE}"));
        }
        match it.next() {
            Some(value) if !value.starts_with("--") => *slot = Some(value),
            _ => return Err(format!("{flag} needs a value\n{USAGE}")),
        }
    }
    let source = source.unwrap_or_else(|| "openstreetmap".to_owned());
    let (Some(input), Some(city), Some(generated_at), Some(out)) = (input, city, generated_at, out)
    else {
        return Err(USAGE.to_owned());
    };
    if !valid_city_id(&city) {
        return Err(format!("invalid city id {city:?}"));
    }
    Ok(Args {
        input,
        city,
        generated_at,
        out,
        source,
    })
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1))?;
    let file = std::fs::File::open(&args.input).map_err(|e| format!("open {}: {e}", args.input))?;
    let mut builder = GraphBuilder::new();
    let mut ways = 0u64;
    for (i, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|e| format!("read {}: {e}", args.input))?;
        if let Some(way) = parse_feature(&line).map_err(|e| format!("line {}: {e}", i + 1))? {
            ways += 1;
            for part in &way.parts {
                builder.add_line(part, &way.name, way.class);
            }
        }
    }
    let graph = builder.finish(Meta {
        city_id: args.city.clone(),
        generated_at: args.generated_at,
        source: args.source,
    });
    if graph.node_count() == 0 {
        return Err("no walkable ways in input".to_owned());
    }
    if graph.node_count() > pt_walk::MAX_ARTIFACT_POINTS {
        return Err(format!(
            "{} points exceed the per-artifact cap of {}; this city needs a tiled graph",
            graph.node_count(),
            pt_walk::MAX_ARTIFACT_POINTS
        ));
    }
    let bytes = encode(&graph);
    // Load the output the way a client will, so limits the decoder or the
    // index enforce (name count, grid size) fail the build, not the device.
    let index = WalkIndex::from_bytes(&bytes).map_err(|e| format!("output does not load: {e}"))?;
    let tmp = format!("{}.tmp", args.out);
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write {tmp}: {e}"))?;
    std::fs::rename(&tmp, &args.out).map_err(|e| {
        std::fs::remove_file(&tmp).ok();
        format!("rename {tmp} to {}: {e}", args.out)
    })?;
    println!(
        "{}",
        serde_json::json!({
            "city": args.city,
            "ways": ways,
            "nodes": graph.node_count(),
            "edges": graph.edge_count(),
            "junctions": index.graph().junction_count(),
            "chains": index.graph().chain_count(),
            "names": graph.names.len(),
            "bytes": bytes.len(),
        })
    );
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("pt-walk-build: {e}");
        std::process::exit(1);
    }
}
