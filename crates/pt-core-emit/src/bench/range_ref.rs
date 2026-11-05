//! B1: deliberately expensive reset-per-entry-event measurement control.
//! The legacy scanner drops temporal alternatives; these timings cannot prove
//! arrive-by/profile correctness. A cap is always explicit and reported.

use std::time::Instant;

use pt_core::engine::temporal_probe::reset_reference;
use pt_core::{Index, PatternMode, Reader};
use serde_json::json;

use super::tuple_input;

pub fn run(args: &[String]) -> Result<String, String> {
    let mut ptb_path: Option<&str> = None;
    let mut tuples_path: Option<&str> = None;
    let mut start: Option<i64> = None;
    let mut end: Option<i64> = None;
    let mut max_events: Option<usize> = None;
    let mut iterations: Option<usize> = None;
    let mut warmup: Option<usize> = None;
    let mut mode: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if !arg.starts_with("--") {
            if ptb_path.replace(arg).is_some() {
                return Err(format!("bench-range-ref: unexpected positional {arg}"));
            }
            i += 1;
            continue;
        }
        i += 1;
        let value = args
            .get(i)
            .map(String::as_str)
            .filter(|s| !s.starts_with("--"))
            .ok_or_else(|| format!("bench-range-ref: {arg} requires a value"))?;
        match arg {
            "--query-tuples" => tuples_path = Some(value),
            "--window-start" => start = Some(value.parse().map_err(|_| "invalid --window-start")?),
            "--window-end" => end = Some(value.parse().map_err(|_| "invalid --window-end")?),
            "--max-events" => max_events = Some(value.parse().map_err(|_| "invalid --max-events")?),
            "--iterations" => iterations = Some(value.parse().map_err(|_| "invalid --iterations")?),
            "--warmup" => warmup = Some(value.parse().map_err(|_| "invalid --warmup")?),
            "--pattern-mode" => mode = Some(value),
            _ => return Err(format!("bench-range-ref: unknown option {arg}")),
        }
        i += 1;
    }

    let path = ptb_path.ok_or("bench-range-ref: missing PTB path")?;
    let tuples = tuples_path.ok_or("bench-range-ref: missing --query-tuples")?;
    let start = start.ok_or("bench-range-ref: missing --window-start")?;
    let end = end.ok_or("bench-range-ref: missing --window-end")?;
    if start >= end {
        return Err("bench-range-ref: window start must be before end".into());
    }
    let max_events = max_events.ok_or("bench-range-ref: missing --max-events")?;
    if max_events == 0 {
        return Err("bench-range-ref: --max-events must be positive".into());
    }
    let iterations = iterations.ok_or("bench-range-ref: missing --iterations")?;
    if iterations == 0 {
        return Err("bench-range-ref: --iterations must be positive".into());
    }
    let warmup = warmup.ok_or("bench-range-ref: missing --warmup")?;
    if mode != Some("covering-merge") {
        return Err("bench-range-ref: --pattern-mode must be covering-merge".into());
    }

    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("PTB decode: {e:?}"))?;
    let index = Index::build(&reader, PatternMode::CoveringMerge)
        .map_err(|e| format!("index build: {e:?}"))?;
    let queries = tuple_input::load(tuples, &reader)?;
    let mut rows = Vec::with_capacity(queries.len());

    for (tuple_index, tuple) in queries.into_iter().enumerate() {
        let event_window_start = start.max(tuple.query.departure_secs);
        for _ in 0..warmup {
            reset_reference(
                &reader,
                &index,
                None,
                &tuple.query,
                event_window_start..end,
                max_events,
            )
            .map_err(|e| format!("tuple/{tuple_index}: {e:?}"))?;
        }
        let mut latency_samples = Vec::with_capacity(iterations);
        let mut run = None;
        for _ in 0..iterations {
            let began = Instant::now();
            let iteration = reset_reference(
                &reader,
                &index,
                None,
                &tuple.query,
                event_window_start..end,
                max_events,
            )
            .map_err(|e| format!("tuple/{tuple_index}: {e:?}"))?;
            latency_samples.push(began.elapsed().as_secs_f64() * 1000.0);
            run = Some(iteration);
        }
        latency_samples.sort_by(f64::total_cmp);
        let p50_ms = latency_samples[(iterations - 1) / 2];
        let p95_ms = latency_samples[((iterations * 95).div_ceil(100))
            .saturating_sub(1)
            .min(iterations - 1)];
        let run = run.expect("positive iterations checked above");
        rows.push(json!({
            "tupleIndex": tuple_index,
            "date": tuple.provenance.date,
            "eventWindowStart": event_window_start,
            "totalEvents": run.total_events,
            "examinedEvents": run.examined_events,
            "incomplete": run.incomplete,
            "p50Ms": p50_ms,
            "p95Ms": p95_ms,
            "samples": run.samples.iter().map(|sample| json!({
                "eventOriginReadySecs": sample.event.origin_ready_secs,
                "eventBoardSecs": sample.event.effective_board_secs,
                "firstBoardSecs": sample.first_board_secs,
            })).collect::<Vec<_>>(),
        }));
    }
    Ok(json!({
        "schemaVersion": 1,
        "kind": "reset-per-entry-event-incomplete-reference",
        "ptbPath": path,
        "queryTuplesPath": tuples,
        "patternMode": "covering-merge",
        "windowStart": start,
        "windowEnd": end,
        "maxEvents": max_events,
        "iterations": iterations,
        "warmup": warmup,
        "queryCount": rows.len(),
        "queries": rows,
    })
    .to_string())
}
