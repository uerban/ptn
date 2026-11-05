//! Measures bounded trip-transfer preprocessing, with optional reduction.

use pt_core::engine::temporal_probe::trip_based::{
    build_event_index, build_transfer_index, reduce_transfer_index, EventIndex, TransferIndex,
    TransferIndexConfig, TransferIndexError, TransferIndexLimits,
};
use pt_core::{Index, Mobility, PatternMode, Reader, Transfers};
use serde_json::{json, Value};
use std::time::Instant;

enum Built {
    Transfers(Result<TransferIndex, TransferIndexError>),
    Events(Result<EventIndex, TransferIndexError>),
}

pub fn run(args: &[String]) -> Result<String, String> {
    let mut ptb = None;
    let mut transfers_path = None;
    let (mut date, mut start, mut end): (Option<u32>, Option<i64>, Option<i64>) =
        (None, None, None);
    let mut pattern = None;
    let mut mobility = Mobility::Default;
    let mut excluded_modes = Vec::new();
    let mut limits = TransferIndexLimits::default();
    let mut reduce = false;
    let mut events_only = false;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--reduce" {
            reduce = true;
            i += 1;
            continue;
        }
        if arg == "--events-only" {
            events_only = true;
            i += 1;
            continue;
        }
        if !arg.starts_with("--") {
            if ptb.is_none() {
                ptb = Some(arg);
            } else if transfers_path.is_none() {
                transfers_path = Some(arg);
            } else {
                return Err(format!("bench-trip-transfers: unexpected positional {arg}"));
            }
            i += 1;
            continue;
        }
        i += 1;
        let value = args
            .get(i)
            .map(String::as_str)
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| format!("bench-trip-transfers: {arg} requires a value"))?;
        match arg {
            "--date" => date = Some(value.parse().map_err(|_| "invalid --date")?),
            "--window-start" => start = Some(value.parse().map_err(|_| "invalid --window-start")?),
            "--window-end" => end = Some(value.parse().map_err(|_| "invalid --window-end")?),
            "--pattern-mode" => pattern = Some(value),
            "--mobility" => {
                mobility = match value {
                    "default" => Mobility::Default,
                    "wheelchair" => Mobility::Wheelchair,
                    "bicycle" => Mobility::Bicycle,
                    _ => return Err(
                        "bench-trip-transfers: --mobility must be default, wheelchair or bicycle"
                            .into(),
                    ),
                }
            }
            "--exclude-modes" => {
                excluded_modes = value
                    .split(',')
                    .map(|m| m.parse::<u16>().map_err(|_| "invalid --exclude-modes"))
                    .collect::<Result<_, _>>()?
            }
            "--max-events" => {
                limits.max_events = value.parse().map_err(|_| "invalid --max-events")?
            }
            "--max-edges" => limits.max_edges = value.parse().map_err(|_| "invalid --max-edges")?,
            "--max-bytes" => limits.max_bytes = value.parse().map_err(|_| "invalid --max-bytes")?,
            _ => return Err(format!("bench-trip-transfers: unknown option {arg}")),
        }
        i += 1;
    }
    let ptb = ptb.ok_or("bench-trip-transfers: missing PTB path")?;
    let date = date.ok_or("bench-trip-transfers: missing --date")?;
    let start = start.ok_or("bench-trip-transfers: missing --window-start")?;
    let end = end.ok_or("bench-trip-transfers: missing --window-end")?;
    if reduce && events_only {
        return Err(
            "bench-trip-transfers: --reduce and --events-only are mutually exclusive".into(),
        );
    }
    if start >= end || [limits.max_events, limits.max_edges, limits.max_bytes].contains(&0) {
        return Err("bench-trip-transfers: invalid window or zero limit".into());
    }
    let mode = match pattern {
        Some("off") => PatternMode::Off,
        Some("unbounded") => PatternMode::Unbounded,
        Some("covering-merge") => PatternMode::CoveringMerge,
        _ => {
            return Err(
                "bench-trip-transfers: --pattern-mode must be off, unbounded or covering-merge"
                    .into(),
            )
        }
    };
    let bytes = std::fs::read(ptb).map_err(|e| format!("read {ptb}: {e}"))?;
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("PTB decode: {e:?}"))?;
    let transfers = transfers_path
        .map(|p| {
            let b = std::fs::read(p).map_err(|e| format!("read {p}: {e}"))?;
            Transfers::from_bytes(&b).map_err(|e| format!("transfers decode: {e:?}"))
        })
        .transpose()?;
    let t = Instant::now();
    let index = Index::build(&reader, mode).map_err(|e| format!("index build: {e:?}"))?;
    let index_ms = t.elapsed().as_secs_f64() * 1000.0;
    let config = TransferIndexConfig {
        mobility,
        excluded_modes,
        limits,
        ..TransferIndexConfig::new(date, start..end)
    };
    let t = Instant::now();
    let built = if events_only {
        Built::Events(build_event_index(
            &reader,
            &index,
            transfers.as_ref(),
            &config,
        ))
    } else {
        Built::Transfers(build_transfer_index(
            &reader,
            &index,
            transfers.as_ref(),
            &config,
        ))
    };
    let build_ms = t.elapsed().as_secs_f64() * 1000.0;
    let mut out = json!({
        "scope": if events_only { "trip-event-catalogue" } else if reduce { "reduced-trip-transfers" } else { "unreduced-trip-transfers" },
        "ptbPath": ptb,
        "transfersPath": transfers_path,
        "date": date,
        "coveredWindow": [start, end],
        "patternMode": pattern,
        "mobility": match mobility {
            Mobility::Default => "default",
            Mobility::Wheelchair => "wheelchair",
            Mobility::Bicycle => "bicycle",
        },
        "excludedModes": config.excluded_modes,
        "limits": {
            "maxEvents": limits.max_events,
            "maxEdges": limits.max_edges,
            "maxBytes": limits.max_bytes,
        },
        "indexBuildMs": index_ms,
        "buildMs": build_ms,
    });
    match built {
        Built::Events(Ok(index)) => {
            let d = index.diagnostics();
            let b = index.binding();
            out["status"] = json!("completed");
            out["binding"] = json!({
                "ptbSha256": hex(&b.ptb_sha256),
                "ptftSha256": b.ptft_sha256.as_ref().map(hex),
                "layoutSha256": hex(&b.layout_sha256),
                "configSha256": hex(&b.config_sha256),
            });
            out["diagnostics"] = json!({
                "events": d.events,
                "arrivalSources": d.arrival_sources,
                "boardingEvents": d.boarding_events,
                "materializedTransferEdges": 0,
                "indexBytes": d.index_bytes,
                "peakBuildBytes": d.peak_build_bytes,
            });
        }
        Built::Transfers(Ok(index)) => {
            let index = if reduce {
                let t = Instant::now();
                let (index, diagnostics) = reduce_transfer_index(index);
                out["reductionMs"] = json!(t.elapsed().as_secs_f64() * 1000.0);
                out["reduction"] = json!({
                    "edgesBefore": diagnostics.edges_before,
                    "edgesAfter": diagnostics.edges_after,
                    "removedEdges": diagnostics.removed_edges,
                    "comparisons": diagnostics.comparisons,
                });
                index
            } else {
                index
            };
            let d = index.diagnostics();
            let b = index.binding();
            out["status"] = json!("completed");
            out["binding"] = json!({
                "ptbSha256": hex(&b.ptb_sha256),
                "ptftSha256": b.ptft_sha256.as_ref().map(hex),
                "layoutSha256": hex(&b.layout_sha256),
                "configSha256": hex(&b.config_sha256),
            });
            out["diagnostics"] = json!({
                "events": d.events,
                "arrivalSources": d.arrival_sources,
                "boardingEvents": d.boarding_events,
                "edges": d.edges,
                "edgesByKind": {
                    "sameStop": d.edges_by_kind[0],
                    "footpath": d.edges_by_kind[1],
                    "synthetic": d.edges_by_kind[2],
                    "linked": d.edges_by_kind[3],
                    "inSeat": d.edges_by_kind[4],
                    "derived": d.edges_by_kind[5],
                },
                "maxOutDegree": d.max_out_degree,
                "indexBytes": d.index_bytes,
                "peakBuildBytes": d.peak_build_bytes,
            });
        }
        Built::Transfers(Err(e)) | Built::Events(Err(e)) => {
            if reduce {
                out["reduction"] = Value::Null;
            }
            out["status"] = json!("failed");
            out["error"] = error(&e);
            out["diagnostics"] = Value::Null;
        }
    }
    serde_json::to_string_pretty(&out).map_err(|e| e.to_string())
}

fn error(e: &TransferIndexError) -> Value {
    let exhausted =
        |kind, limit, attempted| json!({"kind": kind, "limit": limit, "attempted": attempted});
    match e {
        TransferIndexError::EventsExhausted { limit, attempted } => {
            exhausted("events-exhausted", limit, attempted)
        }
        TransferIndexError::EdgesExhausted { limit, attempted } => {
            exhausted("edges-exhausted", limit, attempted)
        }
        TransferIndexError::BytesExhausted { limit, attempted } => {
            exhausted("bytes-exhausted", limit, attempted)
        }
        TransferIndexError::InvalidConfig(reason) => {
            json!({"kind": "invalid-config", "reason": reason})
        }
        TransferIndexError::Engine(e) => json!({"kind": "engine", "reason": format!("{e:?}")}),
    }
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
