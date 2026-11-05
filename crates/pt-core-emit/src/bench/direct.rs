//! Measures direct-transit-only profile kernels. These do NOT route transfers.

use std::time::Instant;

use pt_core::engine::temporal_probe::direct::{profile_direct, DirectObjectives};
use pt_core::{Index, PatternMode, Reader};
use serde_json::json;

use super::tuple_input;

pub fn run(args: &[String]) -> Result<String, String> {
    let mut ptb: Option<&str> = None;
    let mut tuples: Option<&str> = None;
    let mut start: Option<i64> = None;
    let mut end: Option<i64> = None;
    let mut objective: Option<&str> = None;
    let mut pattern: Option<&str> = None;
    let mut iterations: usize = 20;
    let mut warmup: usize = 3;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if !arg.starts_with("--") {
            if ptb.replace(arg).is_some() {
                return Err(format!("bench-direct-profile: unexpected positional {arg}"));
            }
            i += 1;
            continue;
        }
        i += 1;
        let value = args
            .get(i)
            .map(String::as_str)
            .filter(|s| !s.starts_with("--"))
            .ok_or_else(|| format!("bench-direct-profile: {arg} requires a value"))?;
        match arg {
            "--query-tuples" => tuples = Some(value),
            "--window-start" => start = Some(value.parse().map_err(|_| "invalid --window-start")?),
            "--window-end" => end = Some(value.parse().map_err(|_| "invalid --window-end")?),
            "--objective" => objective = Some(value),
            "--pattern-mode" => pattern = Some(value),
            "--iterations" => iterations = value.parse().map_err(|_| "invalid --iterations")?,
            "--warmup" => warmup = value.parse().map_err(|_| "invalid --warmup")?,
            _ => return Err(format!("bench-direct-profile: unknown option {arg}")),
        }
        i += 1;
    }
    let ptb = ptb.ok_or("bench-direct-profile: missing PTB path")?;
    let tuples = tuples.ok_or("bench-direct-profile: missing --query-tuples")?;
    let start = start.ok_or("bench-direct-profile: missing --window-start")?;
    let end = end.ok_or("bench-direct-profile: missing --window-end")?;
    if start >= end || iterations == 0 {
        return Err("bench-direct-profile: invalid window or zero iterations".into());
    }
    if pattern != Some("covering-merge") {
        return Err("bench-direct-profile: --pattern-mode must be covering-merge".into());
    }
    let objective = match objective {
        Some("r3") => DirectObjectives::R3,
        Some("m4") => DirectObjectives::M4,
        _ => return Err("bench-direct-profile: --objective must be r3 or m4".into()),
    };
    let bytes = std::fs::read(ptb).map_err(|e| format!("read {ptb}: {e}"))?;
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("PTB decode: {e:?}"))?;
    let index = Index::build(&reader, PatternMode::CoveringMerge)
        .map_err(|e| format!("index build: {e:?}"))?;
    let inputs = tuple_input::load(tuples, &reader)?;
    let mut rows = Vec::with_capacity(inputs.len());
    for (tuple_index, input) in inputs.into_iter().enumerate() {
        let anchor = start.max(input.query.departure_secs);
        for _ in 0..warmup {
            profile_direct(&reader, &index, &input.query, anchor..end, objective)
                .map_err(|e| format!("tuple/{tuple_index}: {e:?}"))?;
        }
        let mut samples = Vec::with_capacity(iterations);
        let mut profile = Vec::new();
        for _ in 0..iterations {
            let began = Instant::now();
            profile = profile_direct(&reader, &index, &input.query, anchor..end, objective)
                .map_err(|e| format!("tuple/{tuple_index}: {e:?}"))?;
            samples.push(began.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let p50 = samples[(iterations - 1) / 2];
        let p95 = samples[((iterations * 95).div_ceil(100))
            .saturating_sub(1)
            .min(iterations - 1)];
        rows.push(json!({
            "tupleIndex": tuple_index,
            "date": input.provenance.date,
            "eventWindowStart": anchor,
            "profileCount": profile.len(),
            "p50Ms": p50,
            "p95Ms": p95,
            "points": profile.iter().map(|p| json!({
                "departureSecs": p.origin_departure_secs,
                "arrivalSecs": p.destination_arrival_secs,
                "totalWalkSecs": p.total_walk_secs,
                "tripIndex": p.trip_idx,
                "boardPosition": p.board_position,
                "alightPosition": p.alight_position,
            })).collect::<Vec<_>>(),
        }));
    }
    Ok(json!({
        "schemaVersion": 1,
        "scope": "direct-transit-only",
        "objective": match objective { DirectObjectives::R3 => "r3", DirectObjectives::M4 => "m4" },
        "patternMode": "covering-merge",
        "windowStart": start,
        "windowEnd": end,
        "iterations": iterations,
        "warmup": warmup,
        "queryCount": rows.len(),
        "queries": rows,
    })
    .to_string())
}
