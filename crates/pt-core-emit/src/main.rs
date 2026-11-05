//! `pt-core-emit` — the std I/O boundary for the P2 differential harness.
//!
//! Decodes a `.ptb` (and optional PTFT `transfers.bin`), runs `pt_core::plan`
//! over a JSON query vector, and prints the projected `Itinerary[]` as canonical
//! JSON. Kept a SEPARATE std crate so `pt-core` itself stays `no_std` (Cargo
//! feature unification can never pull std into the library through this bin).
//!
//! Subcommands:
//!   plan <ptb-path> [transfers-path] [--pattern-mode off|unbounded|covering-merge]
//!                                      — query JSON on stdin, itineraries on stdout
//!   service-active <ptb-path> <date>   — active-service id SET (sorted JSON strings)
//!   gen-fixtures <out-dir>             — emit the committed custom `.ptb` fixtures
//!   emit-tiny-service-pool <out-tiny-service-pool.ptb>
//!                                      — emit the current PTB v1 ServiceBitfieldPool fixture
//!   emit-tiny-v1 <out-tiny-v1.ptb>     — emit the committed CARRY-LESS current PTB v1 pattern-band fixture
//!   bench <ptb-path> [transfers-path] [--query-tuples <path>] [--iterations N] [--warmup N]
//!                                      — per-query plan() micro-bench (JSON to stdout)
//!   bench-trip-transfers <ptb-path> [transfers-path] --date <YYYYMMDD> --window-start <secs>
//!                        --window-end <secs> --pattern-mode <mode> [--reduce] [--max-events/--max-edges/--max-bytes N]
//!                                      — trip-transfer size and build time (temporal-experiment)
//!   pattern-routes-at-stop <ptb-path> [--pattern-mode off|unbounded|covering-merge]
//!                                      — derived per-pattern routes_at_stop as JSON
//!                                        (ascending stop order; for the Phase-3 gate)
//! pattern-stats <ptb-path> — cardinality census: GTFS-route vs
//!                                        pattern-route count + routes_at_stop CSR
//!                                        sum/max for Off vs Unbounded (single JSON object)
//!   band-stats <ptb-path>              — Reader-only pattern-band cardinality census
//!                                        for cold-load diagnosis; does NOT build
//!                                        an Index
//!
//! JSON output is hand-rolled for byte stability. The optional `bench
//! --query-tuples` input is deserialized only in the std CLI crate.

mod bench;
mod gen_fixtures;

use std::io::Read;
use std::num::NonZeroU32;
use std::process::ExitCode;

use pt_core::engine::consts::{MAX_MIN_TRANSFER_SECS, MAX_WALK_SPEED_MM_S, MIN_WALK_SPEED_MM_S};
use pt_core::{
    plan, project, Index, Mobility, ProjectedLeg, Query, Reader, ScanState, StopWalk, Transfers,
};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str);
    let result = match cmd {
        Some("plan") => cmd_plan(&args[2..]),
        Some("service-active") => cmd_service_active(&args[2..]),
        Some("gen-fixtures") => match args.get(2) {
            Some(out_dir) => gen_fixtures::run(out_dir),
            None => Err("gen-fixtures: missing <out-dir>".to_string()),
        },
        Some("bench") => bench::run(&args[2..]),
        #[cfg(feature = "temporal-experiment")]
        Some("bench-range-ref") => bench::run_ref(&args[2..]),
        #[cfg(feature = "temporal-experiment")]
        Some("bench-direct-profile") => bench::run_direct(&args[2..]),
        #[cfg(feature = "temporal-experiment")]
        Some("bench-temporal-profile") => bench::run_profile(&args[2..]),
        #[cfg(feature = "temporal-experiment")]
        Some("bench-trip-transfers") => bench::run_trip_transfers(&args[2..]),
        #[cfg(feature = "temporal-experiment")]
        Some("bench-trip-deadline") => bench::run_deadline(&args[2..]),
        #[cfg(feature = "temporal-experiment")]
        Some("bench-trip-incumbent-ceiling") => bench::run_incumbent_ceiling(&args[2..]),
        #[cfg(feature = "temporal-experiment")]
        Some("bench-trip-portfolio") => bench::run_portfolio(&args[2..]),
        #[cfg(feature = "temporal-experiment")]
        Some("bench-trip-winner-ceiling") => bench::run_winner_ceiling(&args[2..]),
        Some("emit-tiny-service-pool") => cmd_emit_tiny_service_pool(&args[2..]),
        Some("emit-tiny-v1") => cmd_emit_tiny_v1(&args[2..]),
        Some("emit-frequencies-parity") => cmd_emit_frequencies_parity(&args[2..]),
        Some("pattern-routes-at-stop") => cmd_pattern_routes_at_stop(&args[2..]),
        Some("pattern-stats") => cmd_pattern_stats(&args[2..]),
        Some("band-stats") => cmd_band_stats(&args[2..]),
        _ => {
            eprintln!(
                concat!(
                    "usage:\n",
                    "  pt-core-emit plan <ptb-path> [transfers-path] [--pattern-mode off|unbounded|covering-merge]   (query JSON on stdin)\n",
                    "  pt-core-emit service-active <ptb-path> <date>\n",
                    "  pt-core-emit gen-fixtures <out-dir>\n",
                    "  pt-core-emit emit-tiny-service-pool <out-tiny-service-pool.ptb>\n",
                    "  pt-core-emit emit-tiny-v1 <out-tiny-v1.ptb>\n",
                    "  pt-core-emit bench <ptb-path> [transfers-path] [--query-tuples <path>] [--iterations N] [--warmup N] [--pattern-mode off|unbounded|covering-merge]\n",
                    "  pt-core-emit bench-range-ref <ptb-path> --query-tuples <path> --window-start <secs> --window-end <secs> --max-events <N> --iterations <N> --warmup <N> --pattern-mode covering-merge  (requires temporal-experiment feature)\n",
                    "  pt-core-emit bench-direct-profile <ptb-path> --query-tuples <path> --window-start <secs> --window-end <secs> --objective r3|m4 --iterations <N> --warmup <N> --pattern-mode covering-merge  (requires temporal-experiment feature)\n",
                    "  pt-core-emit bench-temporal-profile <ptb-path> [transfers-path] --query-tuples <path> --window-start <secs> --window-end <secs> --objective r3|m4 --iterations <N> --warmup <N> --engine label|round|compare --max-labels <N> --max-rounds <N> --max-entry-events <N> --max-bag-width <N> --max-board-candidates <N> --pattern-mode covering-merge  (requires temporal-experiment feature)\n",
                    "  pt-core-emit bench-trip-transfers <ptb-path> [transfers-path] --date <YYYYMMDD> --window-start <secs> --window-end <secs> --pattern-mode off|unbounded|covering-merge [--reduce|--events-only] [--mobility default|wheelchair|bicycle] [--exclude-modes <route_type,...>] [--max-events <N>] [--max-edges <N>] [--max-bytes <N>]  (requires temporal-experiment feature)\n",
                    "  pt-core-emit bench-trip-deadline <ptb-path> [transfers-path] --query-tuples PATH --window-start SECS --window-end SECS --arrival-deadline SECS [--engine graph|lazy-all|lazy-indexed|lazy-fast|lazy-cached|compare] [--prefix-bound off|on] [--point-bound off|on] [--traversal fifo|arrival-first|guided] [--witness-comparison materialized|streaming] [--frontier-storage tree|event-indexed] [--static-bound off|on] [--walking-bound off|on] [--forward-seeds off|on|raptor|raptor-guided] [--objective r3|m4] [--iterations N] [--warmup N] [--max-rounds N]  (requires temporal-experiment feature)\n",
                    "  pt-core-emit bench-trip-incumbent-ceiling <ptb-path> [transfers-path] --query-tuples PATH --window-start SECS --window-end SECS --arrival-deadline SECS [--objective r3|m4] [--pattern-mode off|unbounded|covering-merge] [--max-rounds N]  (native theoretical diagnostic, requires temporal-experiment)\n",
                    "  pt-core-emit bench-trip-winner-ceiling <ptb-path> [transfers-path] --query-tuples PATH --window-start SECS --window-end SECS --arrival-deadline SECS [--query-kind portfolio|latest-departure|fastest|least-walking|fewest-transfers] [--witness-comparison materialized|materialized-date-memo] [--pattern-mode off|unbounded|covering-merge] [--iterations N] [--warmup N]  (native winner headroom diagnostic, independent per-pass caps; requires temporal-experiment)\n",
                    "  pt-core-emit bench-trip-portfolio <ptb-path> [transfers-path] --query-tuples PATH --window-start SECS --window-end SECS --arrival-deadline SECS [--query-kind profile|portfolio|latest-departure|fastest|least-walking|fewest-transfers] [--prefix-certificate duration|timetable] [--prefix-setup rebuild|prepared] [--owner-lifecycle shared|fresh|requests] [--catalogue-setup fresh|reuse] [--request-order input|date-interleaved] [--traversal arrival-first|departure-first|departure-warmup64|origin-prefix-warmup] [--suffix-bound off|on|before-pairs|row-prefix|row-ceiling] [--frontier-storage tree|event-indexed] [--witness-comparison materialized|materialized-date-memo] [--validation checked|owned-checked|owned-session] [--pattern-mode off|unbounded|covering-merge] [--iterations N] [--warmup N] [--max-rounds N]  (native-only fixed-selector experiment, requires temporal-experiment)\n",
                    "    bench-trip-portfolio: [--setup-profile off|phases] adds diagnostic setup markers with --owner-lifecycle fresh; profiler-on times are not latency qualification; [--owner-binding recompute|retained] opts into immutable owner digests for ordinary owned-session shared/fresh winner queries\n",
                    "  pt-core-emit pattern-routes-at-stop <ptb-path> [--pattern-mode off|unbounded|covering-merge]\n",
                    "  pt-core-emit pattern-stats <ptb-path>\n",
                    "  pt-core-emit band-stats <ptb-path>"
                )
            );
            return ExitCode::FAILURE;
        }
    };
    match result {
        Ok(out) => {
            println!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("pt-core-emit: {e}");
            ExitCode::FAILURE
        }
    }
}

// ── emit-tiny-service-pool ───────────────────────────────────────────────────────────────
//
// Emit the current PTB v1 cross-parity fixture `tiny-service-pool.ptb`: a SoA
// bundle whose `0x15 ServiceBitfieldPool` / `0x16 ServiceToBitfield` pool
// genuinely folds services onto shared bitfields. The deterministic byte
// assembly + the Phase-2 reader read-back self-check live in
// `gen_fixtures::emit_tiny_service_pool`; this handler is just the std I/O boundary. A CI
// regen guard (`git diff --exit-code`) pins the fixture, and the matching
// `tiny-service-pool.projection.json` golden is emitted by pt-core's `emit_projection`
// example (the Rust↔TS cross-parity anchor). The pool GENUINELY folds (count=2 <
// num_services=3) so the cross-parity leg traverses `0x16 → 0x15`.
fn cmd_emit_tiny_service_pool(args: &[String]) -> Result<String, String> {
    let out_path = args.first().ok_or(
        "emit-tiny-service-pool: usage: emit-tiny-service-pool <out-tiny-service-pool.ptb>",
    )?;
    gen_fixtures::emit_tiny_service_pool(out_path)
}

// ── emit-tiny-v1 ───────────────────────────────────────────────────────────────
//
// Emit the committed current PTB v1 cross-parity fixture `tiny-v1.ptb`: a CARRY-LESS current PTB v1
// pattern-band bundle (the additive `0x10`-`0x14`/`0x45`/`0x46` band over a current SoA staging
// carry, then the flat carry `0xF4`/`0xF5`/`0xF6`/`0xFA` STRIPPED via `strip_regions` — the band is
// the sole timetable). Mirrors `emit-tiny-service-pool`: the deterministic byte assembly + the
// Phase-2 reader read-back self-check live in `gen_fixtures::emit_tiny_v1`; this handler is just
// the std I/O boundary. A CI regen guard (`git diff --exit-code`) pins the fixture, and the
// matching `tiny-v1.projection.json` golden is emitted by pt-core's `emit_projection` example (the
// Rust↔TS cross-parity anchor) over the carry-less band-materialized timetable.
fn cmd_emit_tiny_v1(args: &[String]) -> Result<String, String> {
    let out_path = args
        .first()
        .ok_or("emit-tiny-v1: usage: emit-tiny-v1 <out-tiny-v1.ptb>")?;
    gen_fixtures::emit_tiny_v1(out_path)
}

// ── emit-frequencies-parity ────────────────────────────────────────────────────
//
// Emit the committed `frequencies-parity.ptb` cross-language decoder fixture:
// a current PTB v1 service-pool bundle with a `0x17 Frequencies` region carrying 3
// known rows over 2 trips. Both the Rust reader and the TS loader decode these
// bytes; the cross-parity check in `assert-ptb-cross-parity.ts::assertFrequenciesParity`
// asserts they agree on all fields. Deterministic → a CI regen guard
// (`git diff --exit-code`) pins the fixture.
fn cmd_emit_frequencies_parity(args: &[String]) -> Result<String, String> {
    let out_path = args.first().ok_or(
        "emit-frequencies-parity: usage: emit-frequencies-parity <out-frequencies-parity.ptb>",
    )?;
    gen_fixtures::emit_frequencies_parity(out_path)
}

// ── plan ───────────────────────────────────────────────────────────────────

fn cmd_plan(args: &[String]) -> Result<String, String> {
    // Parse positional args and the optional --pattern-mode flag.
    // Accepted forms:
    //   plan <ptb-path>
    //   plan <ptb-path> <transfers-path>
    //   plan <ptb-path> [<transfers-path>] --pattern-mode off|unbounded|covering-merge
    let mut ptb_path: Option<&str> = None;
    let mut transfers_path: Option<&str> = None;
    let mut pattern_mode = pt_core::PatternMode::Off;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pattern-mode" => {
                i += 1;
                let val = args.get(i).ok_or(
                    "plan: --pattern-mode requires a value (off|unbounded|covering-merge)",
                )?;
                pattern_mode = match val.as_str() {
                    "off" => pt_core::PatternMode::Off,
                    "unbounded" => pt_core::PatternMode::Unbounded,
                    "covering-merge" => pt_core::PatternMode::CoveringMerge,
                    other => return Err(format!("plan: unknown --pattern-mode value '{other}' (expected off|unbounded|covering-merge)")),
                };
            }
            arg if !arg.starts_with('-') => {
                if ptb_path.is_none() {
                    ptb_path = Some(arg);
                } else if transfers_path.is_none() {
                    transfers_path = Some(arg);
                } else {
                    return Err(format!("plan: unexpected positional argument '{arg}'"));
                }
            }
            other => return Err(format!("plan: unknown flag '{other}'")),
        }
        i += 1;
    }

    let ptb_path = ptb_path.ok_or("plan: missing <ptb-path>")?;

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

    let mut stdin = String::new();
    std::io::stdin()
        .read_to_string(&mut stdin)
        .map_err(|e| format!("read stdin: {e}"))?;
    let q = parse_query(&stdin)?;

    // Resolve entry/exit stop ids -> indices via the reader.
    let mut entry_stops = Vec::with_capacity(q.entry.len());
    for sw in &q.entry {
        let idx = reader
            .stop_index(&sw.stop_id)
            .ok_or_else(|| format!("unknown entry stop id: {}", sw.stop_id))?;
        entry_stops.push(StopWalk {
            stop: idx,
            walk_secs: sw.walk_secs,
        });
    }
    let mut exit_stops = Vec::with_capacity(q.exit.len());
    for sw in &q.exit {
        let idx = reader
            .stop_index(&sw.stop_id)
            .ok_or_else(|| format!("unknown exit stop id: {}", sw.stop_id))?;
        exit_stops.push(StopWalk {
            stop: idx,
            walk_secs: sw.walk_secs,
        });
    }

    let query = Query {
        excluded_routes: Default::default(),
        entry_stops,
        exit_stops,
        departure_secs: q.departure_secs,
        date: q.date,
        max_rounds: q.max_rounds,
        mobility: if q.bicycle {
            Mobility::Bicycle
        } else if q.wheelchair {
            Mobility::Wheelchair
        } else {
            Mobility::Default
        },
        excluded_modes: q.excluded_modes,
        walk_speed_mm_s: match q.walk_speed_mm_s {
            None => None,
            Some(v) if (MIN_WALK_SPEED_MM_S..=MAX_WALK_SPEED_MM_S).contains(&v) => {
                NonZeroU32::new(v)
            }
            Some(v) => return Err(format!("query: 'walkSpeedMmS' out of range: {v}")),
        },
        min_transfer_secs: match q.min_transfer_secs {
            Some(v) if v > MAX_MIN_TRANSFER_SECS => {
                return Err(format!("query: 'minTransferSecs' out of range: {v}"))
            }
            v => v,
        },
    };

    let index = Index::build(&reader, pattern_mode).map_err(|e| format!("index build: {e:?}"))?;
    let mut st = ScanState::default();
    let itins = plan(&reader, &index, transfers.as_ref(), &mut st, &query)
        .map_err(|e| format!("plan: {e:?}"))?;
    let projected = project(&reader, &itins).map_err(|e| format!("project: {e:?}"))?;

    Ok(itineraries_to_json(&projected))
}

/// Emit the projected itineraries as a canonical JSON array. Stable key order;
/// stops/routes/trips are strings; secs are integers. The discriminant is
/// emitted as `"type"` (NOT `leg_type`).
fn itineraries_to_json(itins: &[pt_core::ProjectedItinerary]) -> String {
    let mut s = String::from("[");
    for (i, itin) in itins.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"legs\":[");
        for (j, leg) in itin.legs.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            match leg {
                ProjectedLeg::Walk(w) => {
                    s.push_str("{\"type\":\"walk\"");
                    push_str_field(&mut s, "mode", w.mode);
                    push_str_field(&mut s, "fromStopId", &w.from_stop_id);
                    push_str_field(&mut s, "toStopId", &w.to_stop_id);
                    push_int_field(&mut s, "departSecs", w.depart_secs);
                    push_int_field(&mut s, "arriveSecs", w.arrive_secs);
                    s.push('}');
                }
                ProjectedLeg::Transit(t) => {
                    s.push_str("{\"type\":\"transit\"");
                    push_str_field(&mut s, "mode", t.mode);
                    push_str_field(&mut s, "fromStopId", &t.from_stop_id);
                    push_str_field(&mut s, "toStopId", &t.to_stop_id);
                    push_int_field(&mut s, "departSecs", t.depart_secs);
                    push_int_field(&mut s, "arriveSecs", t.arrive_secs);
                    push_str_field(&mut s, "routeId", &t.route_id);
                    push_str_field(&mut s, "tripId", &t.trip_id);
                    push_int_field(&mut s, "boardStopIdx", t.board_stop_idx as i64);
                    push_int_field(&mut s, "alightStopIdx", t.alight_stop_idx as i64);
                    push_int_field(&mut s, "intermediateStops", t.intermediate_stops as i64);
                    if t.approximate {
                        s.push_str(",\"approximate\":true");
                    }
                    s.push('}');
                }
            }
        }
        s.push(']');
        push_int_field(&mut s, "boardSecs", itin.board_secs);
        push_int_field(&mut s, "alightSecs", itin.alight_secs);
        push_int_field(&mut s, "transfers", itin.transfers as i64);
        s.push('}');
    }
    s.push(']');
    s
}

// ── service-active ───────────────────────────────────────────────────────────

fn cmd_service_active(args: &[String]) -> Result<String, String> {
    let ptb_path = args.first().ok_or("service-active: missing <ptb-path>")?;
    let date: u32 = args
        .get(1)
        .ok_or("service-active: missing <date>")?
        .parse()
        .map_err(|_| "service-active: <date> must be YYYYMMDD".to_string())?;

    let bytes = std::fs::read(ptb_path).map_err(|e| format!("read {ptb_path}: {e}"))?;
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("ptb decode: {e:?}"))?;

    // The harness compares against the TS `RaptorIndexService.serviceId` SET. The
    // adapter (ptbToBundleWire.ts) synthesises service ids as the raw service
    // ORDINAL string ("0","1",...) — the .ptb carries no service-id strings, and
    // `serviceIdFor(i)` in loadFromPtb is the same convention. So emit the active
    // service ORDINALS as strings, sorted lexically to match the JS Array#sort the
    // harness applies to its own set.
    let n = reader.num_services();
    let mut active: Vec<String> = Vec::new();
    for s in 0..n {
        if reader.service_active_on(s, date) {
            active.push(s.to_string());
        }
    }
    active.sort();

    let mut out = String::from("[");
    for (i, id) in active.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_json_string(&mut out, id);
    }
    out.push(']');
    Ok(out)
}

// ── pattern-routes-at-stop ────────────────────────────────────────────────────

/// Emit the DERIVED per-pattern `routes_at_stop` map as JSON, for the Phase-3
/// differential gate.
///
/// Accepted forms:
///   pattern-routes-at-stop <ptb-path>                              (defaults to unbounded)
///   pattern-routes-at-stop <ptb-path> --pattern-mode off|unbounded|covering-merge
///
/// Builds the Index in the selected mode (default `Unbounded`, preserving the
/// existing Phase-3 gate invocation) and prints:
/// ```json
/// { "<stop_idx>": [[pattern_idx, reader_route_idx], ...], ... }
/// ```
/// Keys are in ascending `stop_idx` order (integer string keys, not integers,
/// so the TS harness can parse them as a `Map<string, …>`).  Pattern arrays are
/// in `routes_at_stop` / enumeration order.
fn cmd_pattern_routes_at_stop(args: &[String]) -> Result<String, String> {
    let mut ptb_path: Option<&str> = None;
    let mut pattern_mode = pt_core::PatternMode::Unbounded;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pattern-mode" => {
                i += 1;
                let val = args.get(i).ok_or(
                    "pattern-routes-at-stop: --pattern-mode requires a value (off|unbounded|covering-merge)",
                )?;
                pattern_mode = match val.as_str() {
                    "off" => pt_core::PatternMode::Off,
                    "unbounded" => pt_core::PatternMode::Unbounded,
                    "covering-merge" => pt_core::PatternMode::CoveringMerge,
                    other => {
                        return Err(format!(
                            "pattern-routes-at-stop: unknown --pattern-mode value '{other}' (expected off|unbounded|covering-merge)"
                        ))
                    }
                };
            }
            arg if !arg.starts_with('-') => {
                if ptb_path.is_none() {
                    ptb_path = Some(arg);
                } else {
                    return Err(format!(
                        "pattern-routes-at-stop: unexpected positional argument '{arg}'"
                    ));
                }
            }
            other => return Err(format!("pattern-routes-at-stop: unknown flag '{other}'")),
        }
        i += 1;
    }
    let ptb_path = ptb_path.ok_or("pattern-routes-at-stop: missing <ptb-path>")?;
    let bytes = std::fs::read(ptb_path).map_err(|e| format!("read {ptb_path}: {e}"))?;
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("ptb decode: {e:?}"))?;
    let index = Index::build(&reader, pattern_mode).map_err(|e| format!("index build: {e:?}"))?;

    let derived = index.derived_routes_at_stop();

    let mut out = String::from("{");
    for (i, (stop_idx, pairs)) in derived.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        // Key: stop index as a JSON string.
        out.push('"');
        out.push_str(&stop_idx.to_string());
        out.push_str("\":[");
        for (j, (pidx, rridx)) in pairs.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push('[');
            out.push_str(&pidx.to_string());
            out.push(',');
            out.push_str(&rridx.to_string());
            out.push(']');
        }
        out.push(']');
    }
    out.push('}');
    Ok(out)
}

// ── pattern-stats ─────────────────────────────────────────────────────────────

/// Emit the cardinality census as a single JSON object.
///
/// Builds TWO indexes over the same `.ptb` — one `PatternMode::Off`, one
/// `PatternMode::Unbounded` — and prints the GTFS-route count alongside the
/// pattern-route count and the `routes_at_stop` CSR sum/max for each mode. This
/// MEASURES the pattern fan-out (more pattern-routes than GTFS routes → larger
/// `routes_at_stop` CSR) rather than asserting it.
///
/// Output (stable key order):
/// ```json
/// {
///   "gtfs_routes": <bare GTFS route count>,
///   "pattern_routes": <Unbounded num_pattern_routes()>,
///   "csr_sum_off": <Off routes_at_stop_csr_sum()>,
///   "csr_sum_on": <Unbounded routes_at_stop_csr_sum()>,
///   "max_routes_at_stop_off": <Off max_routes_at_stop()>,
///   "max_routes_at_stop_on": <Unbounded max_routes_at_stop()>
/// }
/// ```
/// On a single-pattern feed `pattern_routes == gtfs_routes` and
/// `csr_sum_on == csr_sum_off` (a useful sanity check). On Oslo the design's
/// census expects `gtfs_routes` 399 → `pattern_routes` 1658 and `csr_sum`
/// 19,255 → 39,502, so the numbers are checkable, not asserted.
fn cmd_pattern_stats(args: &[String]) -> Result<String, String> {
    let ptb_path = args.first().ok_or("pattern-stats: missing <ptb-path>")?;
    let bytes = std::fs::read(ptb_path).map_err(|e| format!("read {ptb_path}: {e}"))?;
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("ptb decode: {e:?}"))?;

    // Bare GTFS route count, straight from the reader (== header.num_routes).
    let gtfs_routes = reader.num_routes();

    let index_off = Index::build(&reader, pt_core::PatternMode::Off)
        .map_err(|e| format!("index build (off): {e:?}"))?;
    let index_on = Index::build(&reader, pt_core::PatternMode::Unbounded)
        .map_err(|e| format!("index build (unbounded): {e:?}"))?;

    let pattern_routes = index_on.num_pattern_routes();
    let csr_sum_off = index_off.routes_at_stop_csr_sum();
    let csr_sum_on = index_on.routes_at_stop_csr_sum();
    let max_routes_at_stop_off = index_off.max_routes_at_stop();
    let max_routes_at_stop_on = index_on.max_routes_at_stop();

    Ok(format!(
        "{{\"gtfs_routes\":{gtfs_routes},\"pattern_routes\":{pattern_routes},\
         \"csr_sum_off\":{csr_sum_off},\"csr_sum_on\":{csr_sum_on},\
         \"max_routes_at_stop_off\":{max_routes_at_stop_off},\
         \"max_routes_at_stop_on\":{max_routes_at_stop_on}}}"
    ))
}

// ── band-stats ───────────────────────────────────────────────────────────────

/// Reader-only pattern-band census for cold-load diagnosis.
///
/// This deliberately does NOT call `Index::build`: it is safe to run against a
/// bundle suspected of pathological CoveringMerge startup. Besides raw feed
/// cardinalities, it emits counters that approximate the removed pre-optimization
/// repeated-prefix work:
///
/// - `old_slab_prefix_pattern_walk`: `Σ_t pattern_idx(t)` from resolving a
///   `0x13` slab with a `0..p` prefix walk once per trip.
/// - `old_semantics_record_decodes`: `num_trips × num_patterns` from decoding the
///   full `0x10` pattern record vector once per trip in `band_semantics_base`.
/// - `old_semantics_prefix_pattern_walk`: `Σ_t pattern_idx(t)` only for trips on
///   non-all-regular patterns, matching the old semantics-base prefix loop.
/// - `old_local_trip_position_comparisons`: `Σ_p k_p(k_p+1)/2` for the old
///   per-trip `pattern_trips(p).iter().position(...)` local-index lookup.
fn cmd_band_stats(args: &[String]) -> Result<String, String> {
    let ptb_path = args.first().ok_or("band-stats: missing <ptb-path>")?;
    if args.len() > 1 {
        return Err(format!(
            "band-stats: unexpected positional argument '{}'",
            args[1]
        ));
    }
    let bytes = std::fs::read(ptb_path).map_err(|e| format!("read {ptb_path}: {e}"))?;
    let payload_bytes = bytes.len();
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("ptb decode: {e:?}"))?;
    let has_band = reader.pattern_band_present();

    // FAIL LOUDLY on a band-less bundle. Every counter below is derived from the
    // pattern band, so without one they ALL report 0 — and `0` is the exact
    // value that would otherwise be read as "the quadratic-cost diagnosis is
    // wrong, nothing to fix here". That misreading is expensive: it would retire
    // a real root cause on the strength of pointing the tool at the wrong file
    // (a band-less staging bundle). A no-band census is NOT a measurement of zero
    // work; it is no measurement at all, so refuse to emit one.
    if !has_band {
        return Err(format!(
            "band-stats: {ptb_path} carries NO pattern band \
             (pattern_band_present=false), so every band counter would be a \
             meaningless 0. Point this at a band-bearing bundle — e.g. the \
             `bundle.ptb` inside a pt-serve generation directory."
        ));
    }

    let patterns = reader.patterns().unwrap_or_default();
    let num_patterns = patterns.len();

    let mut sum_pattern_stops = 0usize;
    let mut max_pattern_stops = 0usize;
    let mut max_pattern_stops_idx = 0usize;
    let mut all_regular_patterns = 0usize;
    let mut nonregular_patterns = 0usize;
    for (pidx, p) in patterns.iter().enumerate() {
        let stops = p.stop_count as usize;
        sum_pattern_stops += stops;
        if stops > max_pattern_stops {
            max_pattern_stops = stops;
            max_pattern_stops_idx = pidx;
        }
        if p.flags & 1 != 0 {
            all_regular_patterns += 1;
        } else {
            nonregular_patterns += 1;
        }
    }

    let mut max_pattern_trips = 0usize;
    let mut max_pattern_trips_idx = 0usize;
    let mut old_local_trip_position_comparisons = 0u128;
    for pidx in 0..num_patterns {
        let k = reader.pattern_trips(pidx).map(|v| v.len()).unwrap_or(0);
        if k > max_pattern_trips {
            max_pattern_trips = k;
            max_pattern_trips_idx = pidx;
        }
        old_local_trip_position_comparisons += (k as u128) * ((k as u128) + 1) / 2;
    }

    let mut patterns_at_stop_csr_sum = 0usize;
    let mut max_patterns_at_stop = 0usize;
    let mut max_patterns_at_stop_idx = 0usize;
    if has_band {
        for s in 0..reader.num_stops() {
            let k = reader.patterns_at_stop(s).map(|v| v.len()).unwrap_or(0);
            patterns_at_stop_csr_sum += k;
            if k > max_patterns_at_stop {
                max_patterns_at_stop = k;
                max_patterns_at_stop_idx = s;
            }
        }
    }

    let mut max_route_trips = 0usize;
    let mut max_route_trips_idx = 0usize;
    let mut max_route_groups = 0usize;
    let mut max_route_groups_idx = 0usize;
    let mut max_route_groups_trips = 0usize;
    let mut total_route_groups = 0usize;
    let mut routes_with_multiple_groups = 0usize;
    let mut route_trip_group_product_sum = 0u128;
    let mut covering_merge_pair_candidates_sum = 0u128;
    let mut covering_merge_pair_len_work_upper_bound = 0u128;
    let mut old_slab_prefix_pattern_walk = 0u128;
    let mut old_semantics_record_decodes = 0u128;
    let mut old_semantics_prefix_pattern_walk = 0u128;

    if num_patterns > 0 {
        old_semantics_record_decodes = (reader.num_trips() as u128) * (num_patterns as u128);
    }

    for r in 0..reader.num_routes() {
        let trip_idxs = reader
            .route_trips(r)
            .map_err(|e| format!("route_trips({r}): {e:?}"))?;
        if trip_idxs.len() > max_route_trips {
            max_route_trips = trip_idxs.len();
            max_route_trips_idx = r;
        }
        if !has_band {
            continue;
        }

        let mut seen = std::collections::HashSet::<u32>::new();
        let mut route_max_group_stop_count = 0usize;
        for &t in trip_idxs {
            let pidx = reader
                .trip_pattern_idx(t as usize)
                .ok_or_else(|| format!("trip_pattern_idx({t}) missing"))?;
            old_slab_prefix_pattern_walk += pidx as u128;
            if let Some(p) = patterns.get(pidx as usize) {
                if p.flags & 1 == 0 {
                    old_semantics_prefix_pattern_walk += pidx as u128;
                }
                route_max_group_stop_count = route_max_group_stop_count.max(p.stop_count as usize);
            }
            seen.insert(pidx);
        }

        let groups = seen.len();
        total_route_groups += groups;
        if groups > 1 {
            routes_with_multiple_groups += 1;
        }
        route_trip_group_product_sum += (trip_idxs.len() as u128) * (groups as u128);
        covering_merge_pair_candidates_sum += (groups as u128) * (groups as u128);
        covering_merge_pair_len_work_upper_bound +=
            (groups as u128) * (groups as u128) * (route_max_group_stop_count as u128);
        if groups > max_route_groups {
            max_route_groups = groups;
            max_route_groups_idx = r;
            max_route_groups_trips = trip_idxs.len();
        }
    }

    let mut out = String::from("{");
    push_json_string(&mut out, "ptb_path");
    out.push(':');
    push_json_string(&mut out, ptb_path);
    push_usize_field(&mut out, "payload_bytes", payload_bytes);
    push_usize_field(&mut out, "version", reader.header().version as usize);
    push_bool_field(&mut out, "pattern_band_present", has_band);
    push_bool_field(&mut out, "carry_less_band", reader.is_carry_less_band());
    push_opt_bool_field(
        &mut out,
        "trip_times_i32_deltas",
        reader.trip_times_is_i32_deltas(),
    );
    push_usize_field(&mut out, "num_stops", reader.num_stops());
    push_usize_field(&mut out, "num_routes", reader.num_routes());
    push_usize_field(&mut out, "num_trips", reader.num_trips());
    push_usize_field(&mut out, "num_stop_times", reader.num_stop_times());
    push_usize_field(&mut out, "num_transfers", reader.num_transfers());
    push_usize_field(&mut out, "num_patterns", num_patterns);
    push_usize_field(&mut out, "sum_pattern_stops", sum_pattern_stops);
    push_usize_field(&mut out, "all_regular_patterns", all_regular_patterns);
    push_usize_field(&mut out, "nonregular_patterns", nonregular_patterns);
    push_idx_count_obj(
        &mut out,
        "max_pattern_stops",
        "pattern_idx",
        max_pattern_stops_idx,
        "stops",
        max_pattern_stops,
    );
    push_idx_count_obj(
        &mut out,
        "max_pattern_trips",
        "pattern_idx",
        max_pattern_trips_idx,
        "trips",
        max_pattern_trips,
    );
    push_usize_field(
        &mut out,
        "patterns_at_stop_csr_sum",
        patterns_at_stop_csr_sum,
    );
    push_idx_count_obj(
        &mut out,
        "max_patterns_at_stop",
        "stop_idx",
        max_patterns_at_stop_idx,
        "patterns",
        max_patterns_at_stop,
    );
    push_usize_field(&mut out, "total_route_groups", total_route_groups);
    push_usize_field(
        &mut out,
        "routes_with_multiple_groups",
        routes_with_multiple_groups,
    );
    push_idx_count_obj(
        &mut out,
        "max_route_trips",
        "route_idx",
        max_route_trips_idx,
        "trips",
        max_route_trips,
    );
    push_route_groups_obj(
        &mut out,
        max_route_groups_idx,
        max_route_groups,
        max_route_groups_trips,
    );
    push_u128_field(
        &mut out,
        "route_trip_group_product_sum",
        route_trip_group_product_sum,
    );
    push_u128_field(
        &mut out,
        "covering_merge_pair_candidates_sum",
        covering_merge_pair_candidates_sum,
    );
    push_u128_field(
        &mut out,
        "covering_merge_pair_len_work_upper_bound",
        covering_merge_pair_len_work_upper_bound,
    );
    push_u128_field(
        &mut out,
        "old_slab_prefix_pattern_walk",
        old_slab_prefix_pattern_walk,
    );
    push_u128_field(
        &mut out,
        "old_semantics_record_decodes",
        old_semantics_record_decodes,
    );
    push_u128_field(
        &mut out,
        "old_semantics_prefix_pattern_walk",
        old_semantics_prefix_pattern_walk,
    );
    push_u128_field(
        &mut out,
        "old_local_trip_position_comparisons",
        old_local_trip_position_comparisons,
    );
    out.push('}');
    Ok(out)
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

fn push_str_field(s: &mut String, key: &str, val: &str) {
    s.push(',');
    push_json_string(s, key);
    s.push(':');
    push_json_string(s, val);
}

fn push_int_field(s: &mut String, key: &str, val: i64) {
    s.push(',');
    push_json_string(s, key);
    s.push(':');
    s.push_str(&val.to_string());
}

fn push_usize_field(s: &mut String, key: &str, val: usize) {
    s.push(',');
    push_json_string(s, key);
    s.push(':');
    s.push_str(&val.to_string());
}

fn push_u128_field(s: &mut String, key: &str, val: u128) {
    s.push(',');
    push_json_string(s, key);
    s.push(':');
    s.push_str(&val.to_string());
}

fn push_bool_field(s: &mut String, key: &str, val: bool) {
    s.push(',');
    push_json_string(s, key);
    s.push(':');
    s.push_str(if val { "true" } else { "false" });
}

fn push_opt_bool_field(s: &mut String, key: &str, val: Option<bool>) {
    s.push(',');
    push_json_string(s, key);
    s.push(':');
    match val {
        Some(true) => s.push_str("true"),
        Some(false) => s.push_str("false"),
        None => s.push_str("null"),
    }
}

fn push_idx_count_obj(
    s: &mut String,
    key: &str,
    idx_key: &str,
    idx: usize,
    count_key: &str,
    count: usize,
) {
    s.push(',');
    push_json_string(s, key);
    s.push_str(":{");
    push_json_string(s, idx_key);
    s.push(':');
    s.push_str(&idx.to_string());
    s.push(',');
    push_json_string(s, count_key);
    s.push(':');
    s.push_str(&count.to_string());
    s.push('}');
}

fn push_route_groups_obj(s: &mut String, route_idx: usize, groups: usize, trips: usize) {
    s.push(',');
    push_json_string(s, "max_route_groups");
    s.push_str(":{");
    push_json_string(s, "route_idx");
    s.push(':');
    s.push_str(&route_idx.to_string());
    s.push(',');
    push_json_string(s, "groups");
    s.push(':');
    s.push_str(&groups.to_string());
    s.push(',');
    push_json_string(s, "trips");
    s.push(':');
    s.push_str(&trips.to_string());
    s.push('}');
}

fn push_json_string(s: &mut String, val: &str) {
    s.push('"');
    for c in val.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\t' => s.push_str("\\t"),
            c if (c as u32) < 0x20 => s.push_str(&format!("\\u{:04x}", c as u32)),
            c => s.push(c),
        }
    }
    s.push('"');
}

// ── Minimal query-JSON parser ────────────────────────────────────────────────
//
// Fixed schema, so a tiny hand-rolled parser is enough (no serde dep):
//   {
//     "entry":   [{"stopId": "...", "walkSecs": <int>}, ...],
//     "exit":    [{"stopId": "...", "walkSecs": <int>}, ...],
//     "departureSecs": <int>,
//     "date": <int YYYYMMDD>,
//     "maxRounds": <int|null>,
//     "wheelchair": <bool>,
//     "excludedModes": [<int route_type>, ...]
//   }

struct QStopWalk {
    stop_id: String,
    walk_secs: u32,
}

struct ParsedQuery {
    entry: Vec<QStopWalk>,
    exit: Vec<QStopWalk>,
    departure_secs: i64,
    date: u32,
    max_rounds: Option<u32>,
    wheelchair: bool,
    bicycle: bool,
    excluded_modes: Vec<u16>,
    /// Transfer-walk speed in mm/s (the engine's unit; the schema is
    /// integer-only). Absent: the mobility's speed.
    walk_speed_mm_s: Option<u32>,
    min_transfer_secs: Option<u32>,
}

fn parse_query(json: &str) -> Result<ParsedQuery, String> {
    let v = json::parse(json)?;
    let obj = v.as_object().ok_or("query: top-level must be an object")?;

    let entry = parse_stopwalks(obj.get("entry").ok_or("query: missing 'entry'")?)?;
    let exit = parse_stopwalks(obj.get("exit").ok_or("query: missing 'exit'")?)?;
    let departure_secs = obj
        .get("departureSecs")
        .ok_or("query: missing 'departureSecs'")?
        .as_i64()
        .ok_or("query: 'departureSecs' must be an integer")?;
    let date = obj
        .get("date")
        .ok_or("query: missing 'date'")?
        .as_i64()
        .ok_or("query: 'date' must be an integer")? as u32;
    let max_rounds = match obj.get("maxRounds") {
        Some(json::Value::Null) | None => None,
        Some(j) => Some(
            j.as_i64()
                .ok_or("query: 'maxRounds' must be an integer or null")? as u32,
        ),
    };
    let wheelchair = match obj.get("wheelchair") {
        Some(json::Value::Bool(b)) => *b,
        None | Some(json::Value::Null) => false,
        _ => return Err("query: 'wheelchair' must be a boolean".to_string()),
    };
    let bicycle = match obj.get("bicycle") {
        Some(json::Value::Bool(b)) => *b,
        None | Some(json::Value::Null) => false,
        _ => return Err("query: 'bicycle' must be a boolean".to_string()),
    };
    let excluded_modes = match obj.get("excludedModes") {
        None | Some(json::Value::Null) => Vec::new(),
        Some(json::Value::Array(arr)) => arr
            .iter()
            .map(|j| {
                j.as_i64()
                    .map(|n| n as u16)
                    .ok_or("query: 'excludedModes' entries must be integers".to_string())
            })
            .collect::<Result<Vec<u16>, String>>()?,
        _ => return Err("query: 'excludedModes' must be an array".to_string()),
    };
    let opt_u32 = |key: &str| -> Result<Option<u32>, String> {
        match obj.get(key) {
            None | Some(json::Value::Null) => Ok(None),
            Some(j) => j
                .as_i64()
                .and_then(|n| u32::try_from(n).ok())
                .map(Some)
                .ok_or(format!(
                    "query: '{key}' must be a non-negative integer or null"
                )),
        }
    };
    let walk_speed_mm_s = opt_u32("walkSpeedMmS")?;
    let min_transfer_secs = opt_u32("minTransferSecs")?;

    Ok(ParsedQuery {
        entry,
        exit,
        departure_secs,
        date,
        max_rounds,
        wheelchair,
        bicycle,
        excluded_modes,
        walk_speed_mm_s,
        min_transfer_secs,
    })
}

fn parse_stopwalks(v: &json::Value) -> Result<Vec<QStopWalk>, String> {
    let arr = v.as_array().ok_or("query: entry/exit must be an array")?;
    let mut out = Vec::with_capacity(arr.len());
    for el in arr {
        let o = el
            .as_object()
            .ok_or("query: stop entry must be an object")?;
        let stop_id = o
            .get("stopId")
            .and_then(|j| j.as_str())
            .ok_or("query: stop entry missing string 'stopId'")?
            .to_string();
        let walk_secs = o
            .get("walkSecs")
            .and_then(|j| j.as_i64())
            .ok_or("query: stop entry missing integer 'walkSecs'")? as u32;
        out.push(QStopWalk { stop_id, walk_secs });
    }
    Ok(out)
}

// ── Tiny JSON value model + parser ───────────────────────────────────────────
//
// Just enough to read the fixed query schema: objects, arrays, strings, numbers
// (integers — the schema has no fractionals), booleans, null. No floats, no
// scientific notation handling beyond what `i64::from_str` accepts.

mod json {
    use std::collections::BTreeMap;

    pub enum Value {
        Null,
        Bool(bool),
        Int(i64),
        Str(String),
        Array(Vec<Value>),
        Object(BTreeMap<String, Value>),
    }

    impl Value {
        pub fn as_object(&self) -> Option<&BTreeMap<String, Value>> {
            if let Value::Object(m) = self {
                Some(m)
            } else {
                None
            }
        }
        pub fn as_array(&self) -> Option<&Vec<Value>> {
            if let Value::Array(a) = self {
                Some(a)
            } else {
                None
            }
        }
        pub fn as_str(&self) -> Option<&str> {
            if let Value::Str(s) = self {
                Some(s)
            } else {
                None
            }
        }
        pub fn as_i64(&self) -> Option<i64> {
            if let Value::Int(n) = self {
                Some(*n)
            } else {
                None
            }
        }
    }

    pub fn parse(s: &str) -> Result<Value, String> {
        let bytes = s.as_bytes();
        let mut pos = 0usize;
        skip_ws(bytes, &mut pos);
        let v = parse_value(bytes, &mut pos)?;
        skip_ws(bytes, &mut pos);
        if pos != bytes.len() {
            return Err(format!("json: trailing input at byte {pos}"));
        }
        Ok(v)
    }

    fn skip_ws(b: &[u8], pos: &mut usize) {
        while *pos < b.len() && matches!(b[*pos], b' ' | b'\t' | b'\n' | b'\r') {
            *pos += 1;
        }
    }

    fn parse_value(b: &[u8], pos: &mut usize) -> Result<Value, String> {
        skip_ws(b, pos);
        match b.get(*pos) {
            Some(b'{') => parse_object(b, pos),
            Some(b'[') => parse_array(b, pos),
            Some(b'"') => Ok(Value::Str(parse_string(b, pos)?)),
            Some(b't') | Some(b'f') => parse_bool(b, pos),
            Some(b'n') => parse_null(b, pos),
            Some(c) if *c == b'-' || c.is_ascii_digit() => parse_number(b, pos),
            _ => Err(format!("json: unexpected token at byte {pos}")),
        }
    }

    fn parse_object(b: &[u8], pos: &mut usize) -> Result<Value, String> {
        *pos += 1; // {
        let mut map = BTreeMap::new();
        skip_ws(b, pos);
        if b.get(*pos) == Some(&b'}') {
            *pos += 1;
            return Ok(Value::Object(map));
        }
        loop {
            skip_ws(b, pos);
            let key = parse_string(b, pos)?;
            skip_ws(b, pos);
            if b.get(*pos) != Some(&b':') {
                return Err(format!("json: expected ':' at byte {pos}"));
            }
            *pos += 1;
            let val = parse_value(b, pos)?;
            map.insert(key, val);
            skip_ws(b, pos);
            match b.get(*pos) {
                Some(b',') => {
                    *pos += 1;
                }
                Some(b'}') => {
                    *pos += 1;
                    break;
                }
                _ => return Err(format!("json: expected ',' or '}}' at byte {pos}")),
            }
        }
        Ok(Value::Object(map))
    }

    fn parse_array(b: &[u8], pos: &mut usize) -> Result<Value, String> {
        *pos += 1; // [
        let mut arr = Vec::new();
        skip_ws(b, pos);
        if b.get(*pos) == Some(&b']') {
            *pos += 1;
            return Ok(Value::Array(arr));
        }
        loop {
            let val = parse_value(b, pos)?;
            arr.push(val);
            skip_ws(b, pos);
            match b.get(*pos) {
                Some(b',') => {
                    *pos += 1;
                }
                Some(b']') => {
                    *pos += 1;
                    break;
                }
                _ => return Err(format!("json: expected ',' or ']' at byte {pos}")),
            }
        }
        Ok(Value::Array(arr))
    }

    fn parse_string(b: &[u8], pos: &mut usize) -> Result<String, String> {
        if b.get(*pos) != Some(&b'"') {
            return Err(format!("json: expected string at byte {pos}"));
        }
        *pos += 1;
        let mut out = String::new();
        loop {
            match b.get(*pos) {
                None => return Err("json: unterminated string".to_string()),
                Some(b'"') => {
                    *pos += 1;
                    break;
                }
                Some(b'\\') => {
                    *pos += 1;
                    match b.get(*pos) {
                        Some(b'"') => out.push('"'),
                        Some(b'\\') => out.push('\\'),
                        Some(b'/') => out.push('/'),
                        Some(b'n') => out.push('\n'),
                        Some(b't') => out.push('\t'),
                        Some(b'r') => out.push('\r'),
                        Some(b'u') => {
                            let hex = b
                                .get(*pos + 1..*pos + 5)
                                .ok_or("json: truncated \\u escape")?;
                            let code = u32::from_str_radix(
                                std::str::from_utf8(hex).map_err(|_| "json: bad \\u escape")?,
                                16,
                            )
                            .map_err(|_| "json: bad \\u escape")?;
                            *pos += 4;
                            // Handle surrogate pairs for non-BMP code points.
                            // A lone low surrogate is always invalid JSON.
                            if (0xDC00..=0xDFFF).contains(&code) {
                                return Err("json: lone low surrogate".to_string());
                            }
                            let scalar = if (0xD800..=0xDBFF).contains(&code) {
                                // High surrogate: require a following \uXXXX low surrogate.
                                *pos += 1; // consume the 'u' we're on; next char check below
                                if b.get(*pos) != Some(&b'\\') || b.get(*pos + 1) != Some(&b'u') {
                                    return Err("json: high surrogate not followed by \\uXXXX low surrogate".to_string());
                                }
                                *pos += 2; // skip '\' and 'u'
                                let lo_hex = b
                                    .get(*pos..*pos + 4)
                                    .ok_or("json: truncated low surrogate \\u escape")?;
                                let lo = u32::from_str_radix(
                                    std::str::from_utf8(lo_hex)
                                        .map_err(|_| "json: bad low surrogate \\u escape")?,
                                    16,
                                )
                                .map_err(|_| "json: bad low surrogate \\u escape")?;
                                if !(0xDC00..=0xDFFF).contains(&lo) {
                                    return Err(
                                        "json: expected low surrogate after high surrogate"
                                            .to_string(),
                                    );
                                }
                                *pos += 3; // point at last hex digit; outer `*pos += 1` handles final advance
                                0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00)
                            } else {
                                code
                            };
                            out.push(char::from_u32(scalar).ok_or("json: bad code point")?);
                        }
                        _ => return Err("json: bad escape".to_string()),
                    }
                    *pos += 1;
                }
                Some(&c) => {
                    // Decode a UTF-8 sequence starting at this byte.
                    let len = utf8_len(c);
                    let slice = b
                        .get(*pos..*pos + len)
                        .ok_or("json: truncated utf-8 in string")?;
                    out.push_str(std::str::from_utf8(slice).map_err(|_| "json: invalid utf-8")?);
                    *pos += len;
                }
            }
        }
        Ok(out)
    }

    fn utf8_len(first: u8) -> usize {
        if first < 0x80 {
            1
        } else if first >> 5 == 0b110 {
            2
        } else if first >> 4 == 0b1110 {
            3
        } else {
            4
        }
    }

    fn parse_number(b: &[u8], pos: &mut usize) -> Result<Value, String> {
        let start = *pos;
        if b.get(*pos) == Some(&b'-') {
            *pos += 1;
        }
        while *pos < b.len() && b[*pos].is_ascii_digit() {
            *pos += 1;
        }
        // Reject fractionals/exponents: the query schema is integer-only.
        if matches!(b.get(*pos), Some(b'.') | Some(b'e') | Some(b'E')) {
            return Err("json: only integer numbers are supported in the query schema".to_string());
        }
        let text = std::str::from_utf8(&b[start..*pos]).map_err(|_| "json: bad number")?;
        let n: i64 = text
            .parse()
            .map_err(|_| format!("json: bad integer '{text}'"))?;
        Ok(Value::Int(n))
    }

    fn parse_bool(b: &[u8], pos: &mut usize) -> Result<Value, String> {
        if b[*pos..].starts_with(b"true") {
            *pos += 4;
            Ok(Value::Bool(true))
        } else if b[*pos..].starts_with(b"false") {
            *pos += 5;
            Ok(Value::Bool(false))
        } else {
            Err(format!("json: bad literal at byte {pos}"))
        }
    }

    fn parse_null(b: &[u8], pos: &mut usize) -> Result<Value, String> {
        if b[*pos..].starts_with(b"null") {
            *pos += 4;
            Ok(Value::Null)
        } else {
            Err(format!("json: bad literal at byte {pos}"))
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{json, parse_query};

    fn parse_str(input: &str) -> Result<String, String> {
        let v = json::parse(input)?;
        v.as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "not a string".to_string())
    }

    // ── Surrogate pair handling ───────────────────────────────────────────────

    /// A surrogate pair encoding U+1F600 (😀): 😀.
    #[test]
    fn surrogate_pair_emoji_roundtrip() {
        let got = parse_str(r#""😀""#).unwrap();
        assert_eq!(got, "\u{1F600}");
    }

    /// A surrogate pair encoding U+10000 (𐀀), the first non-BMP code point.
    #[test]
    fn surrogate_pair_min_non_bmp() {
        let got = parse_str(r#""𐀀""#).unwrap();
        assert_eq!(got, "\u{10000}");
    }

    /// A surrogate pair encoding U+10FFFF (the highest valid code point).
    #[test]
    fn surrogate_pair_max_non_bmp() {
        let got = parse_str(r#""􏿿""#).unwrap();
        assert_eq!(got, "\u{10FFFF}");
    }

    /// A lone high surrogate (no following \uXXXX) must be rejected.
    #[test]
    fn lone_high_surrogate_rejected() {
        let err = parse_str(r#""\uD800""#).unwrap_err();
        assert!(err.contains("high surrogate not followed"), "got: {err}");
    }

    /// A lone low surrogate must be rejected.
    #[test]
    fn lone_low_surrogate_rejected() {
        let err = parse_str(r#""\uDC00""#).unwrap_err();
        assert!(err.contains("lone low surrogate"), "got: {err}");
    }

    /// A high surrogate not followed by a \uXXXX escape must be rejected.
    #[test]
    fn high_surrogate_missing_low_rejected() {
        // "\uD800" followed by literal 'A' (not a \uXXXX escape sequence).
        let err = parse_str(r#""\uD800A""#).unwrap_err();
        assert!(err.contains("high surrogate not followed"), "got: {err}");
    }

    /// A high surrogate followed by a \uXXXX whose value is NOT a low surrogate must be rejected.
    #[test]
    fn high_surrogate_non_surrogate_low_rejected() {
        // \uD800A — 0x0041 = 'A', a BMP scalar, not a low surrogate (0xDC00-0xDFFF).
        let err = parse_str("\"\\uD800\\u0041\"").unwrap_err();
        assert!(err.contains("expected low surrogate"), "got: {err}");
    }

    /// A surrogate pair embedded in a longer string.
    #[test]
    fn surrogate_pair_in_longer_string() {
        let got = parse_str(r#""stop:🚀:end""#).unwrap();
        assert_eq!(got, "stop:\u{1F680}:end");
    }

    // ── Basic string escapes (regression) ───────────────────────────────────

    #[test]
    fn basic_bmp_escape() {
        let got = parse_str(r#""A""#).unwrap(); // U+0041 = 'A'
        assert_eq!(got, "A");
    }

    #[test]
    fn ascii_escape_sequences() {
        let got = parse_str(r#""\n\t\r\\\"\/""#).unwrap();
        assert_eq!(got, "\n\t\r\\\"/");
    }

    #[test]
    fn parsed_query_accepts_bicycle() {
        let q = parse_query(r#"{"entry":[{"stopId":"s0","walkSecs":0}],"exit":[{"stopId":"s1","walkSecs":0}],"departureSecs":28800,"date":20260505,"wheelchair":false,"bicycle":true,"excludedModes":[]}"#).unwrap();
        assert!(q.bicycle);
    }
}
