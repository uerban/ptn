//! `bench` subcommand — per-query `plan()` micro-benchmark.
//!
//! Design goals:
//! - `Index::build` is called ONCE, outside the timed loop. Build time is reported
//! separately as `index_build_ms`, attributed to *load* not query.
//! - Only `plan(reader, &index,
//! transfers, &mut state, query)` is timed per iteration; `ScanState` is reused across iterations
//! (capacity retained, reset inside `plan`).
//! - Emits median + p95 per-query latency as
//! machine-readable JSON to stdout, so CI can `tee` it to a file and upload as an artifact. -
//! Runnable over the committed `tiny.ptb` (or any `.ptb` + optional `transfers.bin`) so results can
//! be verified locally.
//!
//! Usage:
//!   pt-core-emit bench <ptb-path> [transfers-path] [--iterations N] [--warmup N]
//!                                  [--query-tuples <path>]
//!                                  [--pattern-mode off|unbounded|covering-merge]
//!
//! `--pattern-mode` (default `off`) selects the `PatternMode` passed to
//! `Index::build`. `off` preserves the legacy numbers; `unbounded` measures the
//! trip-pattern fan-out; `covering-merge` adds the contiguous-subsequence fold.
//! The `index_build_ms` + per-query `median_us`/`p95_us` output then covers ON
//! vs OFF with no other change.
//!
//! The query set is embedded: one tuple per profile (default, wheelchair,
//! excludedModes, footpath when a transfers file is provided) over the stops found
//! in the bundle. Stop indices are resolved at startup and tuples whose stop ids
//! are not present are skipped (the committed `tiny.ptb` and `footpath.ptb`
//! fixture stop ids are well-known, so the embedded tuples work out-of-the-box).
//!
//! Output JSON shape (stable, machine-readable):
//! ```json
//! {
//!   "ptb_path":        "<path>",
//!   "transfers_path":  "<path or null>",
//!   "index_build_ms":  <f64>,
//!   "iterations":      <u32>,
//!   "warmup":          <u32>,
//!   "runner_hostname": "<hostname or unknown>",
//!   "queries": [
//!     {
//!       "name":        "<label>",
//!       "median_us":   <f64>,
//!       "p95_us":      <f64>,
//!       "min_us":      <f64>,
//!       "max_us":      <f64>,
//!       "result_len":  <u32>
//!     },
//!     ...
//!   ]
//! }
//! ```
//! Latency is in MICROSECONDS for readability at the expected sub-ms range.

use std::time::Instant;

use pt_core::{plan, Index, Mobility, PatternMode, Query, Reader, ScanState, StopWalk, Transfers};

#[cfg(feature = "temporal-experiment")]
mod deadline;
#[cfg(feature = "temporal-experiment")]
mod direct;
#[cfg(feature = "temporal-experiment")]
mod incumbent_ceiling;
#[cfg(feature = "temporal-experiment")]
mod portfolio;
#[cfg(feature = "temporal-experiment")]
mod profile;
#[cfg(feature = "temporal-experiment")]
mod range_ref;
#[cfg(feature = "temporal-experiment")]
mod trip_transfers;
mod tuple_input;
#[cfg(feature = "temporal-experiment")]
mod winner_ceiling;
#[cfg(feature = "temporal-experiment")]
pub use deadline::run as run_deadline;
#[cfg(feature = "temporal-experiment")]
pub use direct::run as run_direct;
#[cfg(feature = "temporal-experiment")]
pub use incumbent_ceiling::run as run_incumbent_ceiling;
#[cfg(feature = "temporal-experiment")]
pub use portfolio::run as run_portfolio;
#[cfg(feature = "temporal-experiment")]
pub use portfolio::run_winner_ceiling;
#[cfg(feature = "temporal-experiment")]
pub use profile::run as run_profile;
#[cfg(feature = "temporal-experiment")]
pub use range_ref::run as run_ref;
#[cfg(feature = "temporal-experiment")]
pub use trip_transfers::run as run_trip_transfers;

/// Default number of timed iterations per query.
const DEFAULT_ITERATIONS: usize = 500;
/// Default number of warmup iterations (not counted in stats).
const DEFAULT_WARMUP: usize = 50;

pub fn run(args: &[String]) -> Result<String, String> {
    // ── Parse args ────────────────────────────────────────────────────────────
    let mut ptb_path: Option<&str> = None;
    let mut transfers_path: Option<&str> = None;
    let mut iterations = DEFAULT_ITERATIONS;
    let mut warmup = DEFAULT_WARMUP;
    let mut query_tuples_path: Option<&str> = None;
    // Default Off preserves today's numbers. `covering-merge` is now accepted; an unknown mode is a
    // hard error (never a silent default), so a typo can't quietly measure the wrong path.
    let mut pattern_mode = PatternMode::Off;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pattern-mode" => {
                i += 1;
                let val = args.get(i).ok_or(
                    "bench: --pattern-mode requires a value (off|unbounded|covering-merge)",
                )?;
                pattern_mode = match val.as_str() {
                    "off" => PatternMode::Off,
                    "unbounded" => PatternMode::Unbounded,
                    "covering-merge" => PatternMode::CoveringMerge,
                    other => {
                        return Err(format!(
                            "bench: unknown --pattern-mode value '{other}' (expected off|unbounded|covering-merge)"
                        ))
                    }
                };
            }
            "--iterations" => {
                i += 1;
                iterations = args
                    .get(i)
                    .ok_or("bench: --iterations requires a value")?
                    .parse::<usize>()
                    .map_err(|_| "bench: --iterations must be a positive integer")?;
            }
            "--warmup" => {
                i += 1;
                warmup = args
                    .get(i)
                    .ok_or("bench: --warmup requires a value")?
                    .parse::<usize>()
                    .map_err(|_| "bench: --warmup must be a non-negative integer")?;
            }
            "--query-tuples" => {
                i += 1;
                query_tuples_path = Some(
                    args.get(i)
                        .ok_or("bench: --query-tuples requires a file path")?,
                );
            }
            s if !s.starts_with("--") => {
                if ptb_path.is_none() {
                    ptb_path = Some(s);
                } else if transfers_path.is_none() {
                    transfers_path = Some(s);
                }
                // extra positionals ignored
            }
            other => return Err(format!("bench: unknown flag: {other}")),
        }
        i += 1;
    }

    let ptb_path = ptb_path.ok_or("bench: missing <ptb-path>")?;

    // ── Load bundle ──────────────────────────────────────────────────────────
    let bytes = std::fs::read(ptb_path).map_err(|e| format!("read {ptb_path}: {e}"))?;
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("ptb decode: {e:?}"))?;

    let transfers_bytes = match transfers_path {
        Some(p) => Some(std::fs::read(p).map_err(|e| format!("read {p}: {e}"))?),
        None => None,
    };
    let transfers = match &transfers_bytes {
        Some(b) => Some(Transfers::from_bytes(b).map_err(|e| format!("transfers decode: {e:?}"))?),
        None => None,
    };

    // ── Build Index ONCE (attributed to load, not query) ─────────────────────
    let index_start = Instant::now();
    let index = Index::build(&reader, pattern_mode).map_err(|e| format!("index build: {e:?}"))?;
    let index_build_ms = index_start.elapsed().as_secs_f64() * 1000.0;

    // ── Build query set ───────────────────────────────────────────────────────
    // Resolve explicit tuple files strictly. Without one, preserve the embedded
    // synthetic query set and its historical output exactly.
    let (queries, query_tuples_path) = match query_tuples_path {
        Some(path) => {
            let queries = tuple_input::load(path, &reader)?
                .into_iter()
                .enumerate()
                .map(|(idx, tuple)| BenchQuery {
                    name: format!("tuple/{idx}"),
                    query: tuple.query,
                    provenance: Some(tuple.provenance),
                })
                .collect();
            (queries, Some(path))
        }
        None => (build_queries(&reader, transfers.is_some()), None),
    };

    if queries.is_empty() {
        return Err(format!(
            "bench: no bench queries could be resolved against {ptb_path}. \
             The embedded stop ids (S1/S2/S3 from tiny.ptb, or s0/s1/s2/s3 from \
             footpath.ptb) must be present. Pass a compatible .ptb or override \
             the bench queries."
        ));
    }

    // ── Run bench ─────────────────────────────────────────────────────────────
    let mut st = ScanState::default();
    let mut results: Vec<QueryResult> = Vec::with_capacity(queries.len());

    for bq in &queries {
        let samples = run_query(
            &reader,
            &index,
            transfers.as_ref(),
            &mut st,
            &bq.query,
            warmup,
            iterations,
        )?;
        // result_len: run one final iteration to capture the output length
        // (the warmup/timed iterations discard the result for measurement purity).
        // The stop_index-counter delta around this single plan() is the
        // footpath-relaxation lookup count for the query (0 without footpaths).
        let lookups_before = reader.stop_index_lookups();
        let final_result = plan(&reader, &index, transfers.as_ref(), &mut st, &bq.query)
            .map_err(|e| format!("plan final: {e:?}"))?;
        let lookups_per_plan = reader.stop_index_lookups() - lookups_before;
        results.push(QueryResult {
            name: bq.name.clone(),
            samples,
            result_len: final_result.len() as u32,
            provenance: bq.provenance.clone(),
            lookups_per_plan,
        });
    }

    // ── Format JSON output ────────────────────────────────────────────────────
    let hostname = hostname();
    Ok(format_json(
        JsonHeader {
            ptb_path,
            transfers_path,
            index_build_ms,
            iterations: iterations as u32,
            warmup: warmup as u32,
            hostname: &hostname,
            query_tuples_path,
        },
        &results,
    ))
}

// ── Query construction ────────────────────────────────────────────────────────

struct BenchQuery {
    name: String,
    query: Query,
    provenance: Option<tuple_input::TupleProvenance>,
}

/// Build the bench query set by probing the reader for known stop ids.
///
/// Stop ids are drawn from the committed synthetic fixtures: `tiny.ptb`
/// (S1/S2/S3) and, when a transfers file is provided, `footpath.ptb`
/// (s0/s1/s2/s3).
///
/// Tuples that cannot be resolved (stop id missing) are skipped. The caller
/// checks that at least one tuple was resolved.
fn build_queries(
    reader: &Reader<impl AsRef<[u8]> + Send + Sync + 'static>,
    has_transfers: bool,
) -> Vec<BenchQuery> {
    let mut out = Vec::new();

    // ── tiny.ptb tuples ───────────────────────────────────────────────────────
    // Topology: S1=0 (BUS routes R1/R2), S2=1, S3=2. Pinned date 20260505.
    push_if_resolved(
        &mut out,
        reader,
        "tiny/default-direct",
        "S1",
        "S3",
        25_000,
        20_260_505,
        Mobility::Default,
        vec![],
    );
    push_if_resolved(
        &mut out,
        reader,
        "tiny/wheelchair-skip",
        "S1",
        "S3",
        25_000,
        20_260_505,
        Mobility::Wheelchair,
        vec![],
    );
    push_if_resolved(
        &mut out,
        reader,
        "tiny/excluded-bus",
        "S1",
        "S3",
        25_000,
        20_260_505,
        Mobility::Default,
        vec![3u16], // BUS excluded → empty result; still times the full scan
    );
    push_if_resolved(
        &mut out,
        reader,
        "tiny/reverse-route",
        "S3",
        "S1",
        30_000,
        20_260_505,
        Mobility::Default,
        vec![],
    );

    // ── Footpath profile (only when a transfers.bin was loaded) ───────────────
    // footpath.ptb: s0→s1 by transit, s1→s2 via footpath. Include a footpath
    // query only when a transfers file was provided (otherwise the tuple
    // degenerates to a no-path query and times nothing useful).
    if has_transfers {
        push_if_resolved(
            &mut out,
            reader,
            "footpath/floor-crossing",
            "s0",
            "s2",
            25_000,
            20_260_505,
            Mobility::Default,
            vec![],
        );
        push_if_resolved(
            &mut out,
            reader,
            "footpath/wheelchair-rescale",
            "s0",
            "s3",
            25_000,
            20_260_505,
            Mobility::Wheelchair,
            vec![],
        );
    }

    out
}

#[allow(clippy::too_many_arguments)]
fn push_if_resolved(
    out: &mut Vec<BenchQuery>,
    reader: &Reader<impl AsRef<[u8]> + Send + Sync + 'static>,
    name: &str,
    entry_id: &str,
    exit_id: &str,
    departure_secs: i64,
    date: u32,
    mobility: Mobility,
    excluded_modes: Vec<u16>,
) {
    let entry = match reader.stop_index(entry_id) {
        Some(i) => i,
        None => return,
    };
    let exit = match reader.stop_index(exit_id) {
        Some(i) => i,
        None => return,
    };
    out.push(BenchQuery {
        name: name.to_string(),
        query: Query {
            excluded_routes: Vec::new(),
            entry_stops: vec![StopWalk {
                stop: entry,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: exit,
                walk_secs: 0,
            }],
            departure_secs,
            date,
            max_rounds: None,
            mobility,
            excluded_modes,
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        },
        provenance: None,
    });
}

// ── Timing loop ───────────────────────────────────────────────────────────────

/// Run `warmup + iterations` calls to `plan()`, returning only the `iterations`
/// timed samples (in microseconds). `ScanState` is reused across calls —
/// `plan()` calls `st.reset()` at entry, retaining capacity. The index is NOT
/// rebuilt; it is passed by reference.
fn run_query(
    reader: &Reader<impl AsRef<[u8]> + Send + Sync + 'static>,
    index: &Index,
    transfers: Option<&Transfers>,
    st: &mut ScanState,
    query: &Query,
    warmup: usize,
    iterations: usize,
) -> Result<Vec<f64>, String> {
    // Warmup: let the CPU branch predictor and instruction cache settle.
    for _ in 0..warmup {
        let _ = plan(reader, index, transfers, st, query)
            .map_err(|e| format!("plan (warmup): {e:?}"))?;
    }

    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let t0 = Instant::now();
        let _ = plan(reader, index, transfers, st, query).map_err(|e| format!("plan: {e:?}"))?;
        samples.push(t0.elapsed().as_secs_f64() * 1_000_000.0); // µs
    }
    Ok(samples)
}

// ── Statistics ────────────────────────────────────────────────────────────────

struct QueryResult {
    name: String,
    samples: Vec<f64>,
    result_len: u32,
    provenance: Option<tuple_input::TupleProvenance>,
    /// `reader.stop_index` calls during ONE `plan()` — the footpath-relaxation
    /// (scan.rs) lookups, the scan-path lookup frequency the build-vs-mmap
    /// tradeoff hinges on. Zero when the feed carries no footpath table.
    lookups_per_plan: u64,
}

fn median(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return 0.0;
    }
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    // Nearest-rank method (same as NumPy default).
    let idx = ((p / 100.0 * sorted.len() as f64).ceil() as usize).saturating_sub(1);
    sorted[idx.min(sorted.len() - 1)]
}

// ── JSON formatting ───────────────────────────────────────────────────────────

fn escape_json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

struct JsonHeader<'a> {
    ptb_path: &'a str,
    transfers_path: Option<&'a str>,
    index_build_ms: f64,
    iterations: u32,
    warmup: u32,
    hostname: &'a str,
    query_tuples_path: Option<&'a str>,
}

fn format_json(header: JsonHeader<'_>, results: &[QueryResult]) -> String {
    let JsonHeader {
        ptb_path,
        transfers_path,
        index_build_ms,
        iterations,
        warmup,
        hostname,
        query_tuples_path,
    } = header;
    let tr_json = match transfers_path {
        Some(p) => escape_json_str(p),
        None => "null".to_string(),
    };

    let mut s = format!(
        "{{\n  \"ptb_path\": {},\n  \"transfers_path\": {},\n  \"index_build_ms\": {:.3},\n  \"iterations\": {},\n  \"warmup\": {},\n  \"runner_hostname\": {},\n",
        escape_json_str(ptb_path),
        tr_json,
        index_build_ms,
        iterations,
        warmup,
        escape_json_str(hostname),
    );
    if let Some(path) = query_tuples_path {
        s.push_str(&format!(
            "  \"query_tuples_path\": {},\n  \"query_count\": {},\n  \"nonempty_result_count\": {},\n",
            escape_json_str(path),
            results.len(),
            results.iter().filter(|result| result.result_len > 0).count(),
        ));
    }
    s.push_str("  \"queries\": [\n");

    for (i, r) in results.iter().enumerate() {
        let mut sorted = r.samples.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = median(&sorted);
        let p95 = percentile(&sorted, 95.0);
        let min = sorted.first().copied().unwrap_or(0.0);
        let max = sorted.last().copied().unwrap_or(0.0);

        s.push_str("    {");
        s.push_str(&format!("\"name\": {}", escape_json_str(&r.name)));
        if let Some(provenance) = &r.provenance {
            s.push_str(", \"entryStops\": ");
            s.push_str(&stop_walks_to_json(&provenance.entry_stops));
            s.push_str(", \"exitStops\": ");
            s.push_str(&stop_walks_to_json(&provenance.exit_stops));
            s.push_str(&format!(
                ", \"date\": {}, \"departureSecs\": {}",
                escape_json_str(&provenance.date),
                provenance.departure_secs,
            ));
        }
        s.push_str(&format!(
            ", \"median_us\": {:.2}, \"p95_us\": {:.2}, \"min_us\": {:.2}, \"max_us\": {:.2}, \"result_len\": {}, \"lookups_per_plan\": {}}}",
            med,
            p95,
            min,
            max,
            r.result_len,
            r.lookups_per_plan,
        ));
        if i + 1 < results.len() {
            s.push(',');
        }
        s.push('\n');
    }

    s.push_str("  ]\n}");
    s
}

fn stop_walks_to_json(stops: &[tuple_input::StopWalkProvenance]) -> String {
    let mut s = String::from("[");
    for (idx, stop) in stops.iter().enumerate() {
        if idx > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"stopId\":{},\"walkSecs\":{}}}",
            escape_json_str(&stop.stop_id),
            stop.walk_secs,
        ));
    }
    s.push(']');
    s
}

// ── Hostname ─────────────────────────────────────────────────────────────────

fn hostname() -> String {
    // POSIX `gethostname` is not in `std`; read /etc/hostname (Linux) or fall
    // back to the `HOSTNAME` env var (set by bash), then "unknown".
    if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
        let trimmed = h.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() {
            return h;
        }
    }
    "unknown".to_string()
}
