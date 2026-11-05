//! Measures certified transfer-aware temporal R3/M4 profiles.

use super::tuple_input;
use pt_core::engine::consts::RAPTOR_MAX_ROUNDS;
use pt_core::engine::temporal_probe::r3::{
    profile_m4, profile_r3, ProfileObjectives, R3CoverageScope, R3MultiDateStatus,
    R3PageCompletion, R3ProfilePage, R3PtftStatus, R3Request,
};
use pt_core::engine::temporal_probe::round::{
    profile_round_m4, profile_round_r3, RoundDiagnostics, RoundProfileIndex, RoundProfileRequest,
};
use pt_core::{Index, PatternMode, Query, Reader, Transfers};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ops::Range;
use std::time::Instant;

#[derive(Clone, Copy, PartialEq)]
enum Engine {
    Label,
    Round,
    Compare,
}
impl Engine {
    fn name(self) -> &'static str {
        match self {
            Self::Label => "label",
            Self::Round => "round",
            Self::Compare => "compare",
        }
    }
}

pub fn run(args: &[String]) -> Result<String, String> {
    let mut ptb = None;
    let mut transfers_path = None;
    let mut tuples = None;
    let (mut start, mut end): (Option<i64>, Option<i64>) = (None, None);
    let (mut objective, mut pattern) = (None, None);
    let mut engine = Engine::Label;
    let mut round_scan = "frontier";
    let (mut iterations, mut warmup) = (5usize, 1usize);
    let mut max_labels = None;
    let mut max_rounds = RAPTOR_MAX_ROUNDS;
    let (mut max_entry_events, mut max_bag_width, mut max_board_candidates) =
        (100_000usize, 64usize, 10_000_000usize);
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if !arg.starts_with("--") {
            if ptb.is_none() {
                ptb = Some(arg);
            } else if transfers_path.is_none() {
                transfers_path = Some(arg);
            } else {
                return Err(format!(
                    "bench-temporal-profile: unexpected positional {arg}"
                ));
            }
            i += 1;
            continue;
        }
        i += 1;
        let value = args
            .get(i)
            .map(String::as_str)
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| format!("bench-temporal-profile: {arg} requires a value"))?;
        match arg {
            "--query-tuples" => tuples = Some(value),
            "--window-start" => start = Some(value.parse().map_err(|_| "invalid --window-start")?),
            "--window-end" => end = Some(value.parse().map_err(|_| "invalid --window-end")?),
            "--objective" => objective = Some(value),
            "--pattern-mode" => pattern = Some(value),
            "--engine" => {
                engine = match value {
                    "label" => Engine::Label,
                    "round" => Engine::Round,
                    "compare" => Engine::Compare,
                    _ => {
                        return Err(
                            "bench-temporal-profile: --engine must be label, round or compare"
                                .into(),
                        )
                    }
                }
            }
            "--round-scan" => {
                round_scan = match value {
                    "exact" => "exact",
                    "bounded" => "bounded",
                    "frontier" => "frontier",
                    _ => return Err(
                        "bench-temporal-profile: --round-scan must be exact, bounded or frontier"
                            .into(),
                    ),
                };
            }
            "--iterations" => iterations = value.parse().map_err(|_| "invalid --iterations")?,
            "--warmup" => warmup = value.parse().map_err(|_| "invalid --warmup")?,
            "--max-labels" => max_labels = Some(value.parse().map_err(|_| "invalid --max-labels")?),
            "--max-rounds" => max_rounds = value.parse().map_err(|_| "invalid --max-rounds")?,
            "--max-entry-events" => {
                max_entry_events = value.parse().map_err(|_| "invalid --max-entry-events")?
            }
            "--max-bag-width" => {
                max_bag_width = value.parse().map_err(|_| "invalid --max-bag-width")?
            }
            "--max-board-candidates" => {
                max_board_candidates = value
                    .parse()
                    .map_err(|_| "invalid --max-board-candidates")?
            }
            _ => return Err(format!("bench-temporal-profile: unknown option {arg}")),
        }
        i += 1;
    }
    let ptb = ptb.ok_or("bench-temporal-profile: missing PTB path")?;
    let tuples = tuples.ok_or("bench-temporal-profile: missing --query-tuples")?;
    let start = start.ok_or("bench-temporal-profile: missing --window-start")?;
    let end = end.ok_or("bench-temporal-profile: missing --window-end")?;
    let max_labels = max_labels.unwrap_or(if engine == Engine::Label {
        100_000
    } else {
        250_000
    });
    if max_rounds == 0 {
        return Err("bench-temporal-profile: --max-rounds must be positive".into());
    }
    if start >= end
        || iterations == 0
        || [
            max_labels,
            max_entry_events,
            max_bag_width,
            max_board_candidates,
        ]
        .contains(&0)
    {
        return Err("bench-temporal-profile: invalid window or zero limit".into());
    }
    if pattern != Some("covering-merge") {
        return Err("bench-temporal-profile: --pattern-mode must be covering-merge".into());
    }
    let objective = match objective {
        Some("r3") => ProfileObjectives::R3,
        Some("m4") => ProfileObjectives::M4,
        _ => return Err("bench-temporal-profile: --objective must be r3 or m4".into()),
    };
    let bytes = std::fs::read(ptb).map_err(|e| format!("read {ptb}: {e}"))?;
    let ptb_hash = format!("{:x}", Sha256::digest(&bytes));
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("PTB decode: {e:?}"))?;
    let transfers_bytes = transfers_path
        .map(|p| std::fs::read(p).map_err(|e| format!("read {p}: {e}")))
        .transpose()?;
    let transfers_hash = transfers_bytes
        .as_ref()
        .map(|b| format!("{:x}", Sha256::digest(b)));
    let transfers = transfers_bytes
        .as_ref()
        .map(|b| Transfers::from_bytes(b).map_err(|e| format!("transfers decode: {e:?}")))
        .transpose()?;
    let index = Index::build(&reader, PatternMode::CoveringMerge)
        .map_err(|e| format!("index build: {e:?}"))?;
    let acceleration = if engine == Engine::Label {
        None
    } else {
        Some(
            RoundProfileIndex::build(&reader, &index)
                .map_err(|e| format!("round index build: {e:?}"))?,
        )
    };
    let inputs = tuple_input::load(tuples, &reader)?;
    let mut rows = Vec::with_capacity(inputs.len());
    for (tuple_index, mut input) in inputs.into_iter().enumerate() {
        input.query.max_rounds = Some(max_rounds);
        let anchor = start.max(input.query.departure_secs);
        if anchor >= end {
            return Err(format!(
                "tuple/{tuple_index}: departure {} is outside window {start}..{end}",
                input.query.departure_secs
            ));
        }
        let workload = Workload {
            reader: &reader,
            index: &index,
            acceleration: acceleration.as_ref(),
            transfers: transfers.as_ref(),
            query: &input.query,
            window: anchor..end,
            objective,
            max_labels,
            max_entry_events,
            max_bag_width,
            max_board_candidates,
            round_scan,
        };
        let measure = |choice| {
            workload
                .measure(choice, warmup, iterations)
                .map_err(|e| format!("tuple/{tuple_index}: {e}"))
        };
        if engine == Engine::Compare {
            // Complete both references and verify objective parity before any
            // warmup or timed execution. Neither an error nor partial output is timed.
            let reference = workload
                .execute(Engine::Label)
                .map_err(|e| format!("tuple/{tuple_index}: {e}"))?;
            let candidate = workload
                .execute(Engine::Round)
                .map_err(|e| format!("tuple/{tuple_index}: {e}"))?;
            let expected = objectives(&reference.page);
            if expected != objectives(&candidate.page) {
                return Err(format!(
                    "tuple/{tuple_index}: label/round objective mismatch"
                ));
            }
            let label = measure(Engine::Label)?;
            let round = measure(Engine::Round)?;
            if objectives(&label.output.page) != expected
                || objectives(&round.output.page) != expected
            {
                return Err(format!(
                    "tuple/{tuple_index}: timed profile changed objectives after parity preflight"
                ));
            }
            rows.push(json!({ "tupleIndex": tuple_index, "date": input.provenance.date,
                "objectiveParity": "equal", "label": row(label, Engine::Label, tuple_index, &input.provenance.date),
                "round": row(round, Engine::Round, tuple_index, &input.provenance.date) }));
        } else {
            rows.push(row(
                measure(engine)?,
                engine,
                tuple_index,
                &input.provenance.date,
            ));
        }
    }
    Ok(json!({
        "schemaVersion": 1, "scope": "full-temporal-profile", "engine": engine.name(),
        "roundScan": round_scan,
        "objective": if objective == ProfileObjectives::R3 { "r3" } else { "m4" },
        "ptbPath": ptb, "ptbSha256": ptb_hash, "transfersPath": transfers_path, "transfersSha256": transfers_hash,
        "queryTuplesPath": tuples, "patternMode": "covering-merge", "windowStart": start, "windowEnd": end,
        "iterations": iterations, "warmup": warmup, "maxLabels": max_labels, "maxRounds": max_rounds, "maxEntryEvents": max_entry_events,
        "maxBagWidth": max_bag_width, "maxBoardCandidates": max_board_candidates, "queryCount": rows.len(), "queries": rows,
    }).to_string())
}

struct Output {
    page: R3ProfilePage,
    round: Option<RoundDiagnostics>,
    round_scan: &'static str,
}
struct Measurement {
    output: Output,
    p50: f64,
    p95: f64,
}

struct Workload<'a> {
    reader: &'a Reader<Vec<u8>>,
    index: &'a Index,
    acceleration: Option<&'a RoundProfileIndex<'a>>,
    transfers: Option<&'a Transfers>,
    query: &'a Query,
    window: Range<i64>,
    objective: ProfileObjectives,
    max_labels: usize,
    max_entry_events: usize,
    max_bag_width: usize,
    max_board_candidates: usize,
    round_scan: &'static str,
}

impl Workload<'_> {
    fn execute(&self, engine: Engine) -> Result<Output, String> {
        let output = match engine {
            Engine::Label => {
                let mut req = R3Request::new(self.query, self.window.clone());
                req.transfers = self.transfers;
                req.max_labels = self.max_labels;
                req.max_entry_events = self.max_entry_events;
                let page = match self.objective {
                    ProfileObjectives::R3 => profile_r3(self.reader, self.index, req),
                    ProfileObjectives::M4 => profile_m4(self.reader, self.index, req),
                }
                .map_err(|e| format!("label profile failed: {e:?}"))?;
                Output {
                    page,
                    round: None,
                    round_scan: self.round_scan,
                }
            }
            Engine::Round => {
                let mut req = RoundProfileRequest::new(self.query, self.window.clone());
                req.transfers = self.transfers;
                req.max_accepted_states = self.max_labels;
                req.max_entry_events = self.max_entry_events;
                req.max_bag_width = self.max_bag_width;
                req.max_board_candidates = self.max_board_candidates;
                req.enable_scheduled_bounds = self.round_scan != "exact";
                req.enable_source_frontiers = self.round_scan == "frontier";
                let acceleration = self
                    .acceleration
                    .ok_or("round acceleration index missing")?;
                let result = match self.objective {
                    ProfileObjectives::R3 => {
                        profile_round_r3(self.reader, self.index, acceleration, req)
                    }
                    ProfileObjectives::M4 => {
                        profile_round_m4(self.reader, self.index, acceleration, req)
                    }
                }
                .map_err(|e| format!("round profile failed: {e:?}"))?;
                Output {
                    page: result.page,
                    round: Some(result.diagnostics),
                    round_scan: self.round_scan,
                }
            }
            Engine::Compare => return Err("compare must select two concrete engines".into()),
        };
        if !output.page.window_exhausted || !output.page.page_complete {
            return Err("profile did not certify full window coverage".into());
        }
        Ok(output)
    }

    fn measure(
        &self,
        engine: Engine,
        warmup: usize,
        iterations: usize,
    ) -> Result<Measurement, String> {
        for _ in 0..warmup {
            self.execute(engine)?;
        }
        let mut samples = Vec::with_capacity(iterations);
        let mut output = None;
        for _ in 0..iterations {
            let began = Instant::now();
            output = Some(self.execute(engine)?);
            samples.push(began.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let p50 = samples[(iterations - 1) / 2];
        let rank95 = iterations / 100 * 95 + (iterations % 100 * 95).div_ceil(100);
        let p95 = samples[rank95.saturating_sub(1).min(iterations - 1)];
        Ok(Measurement {
            output: output.expect("positive iterations"),
            p50,
            p95,
        })
    }
}

type Objective = (i64, i64, u32, Option<u64>);
fn objectives(page: &R3ProfilePage) -> Vec<Objective> {
    let mut out: Vec<_> = page
        .points
        .iter()
        .map(|p| {
            (
                p.origin_departure_secs,
                p.destination_arrival_secs,
                p.actual_transfers,
                (page.objectives == ProfileObjectives::M4).then_some(p.total_walk_secs),
            )
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn round_diagnostics(d: RoundDiagnostics) -> Value {
    json!({
        "rounds": d.rounds, "patternScans": d.pattern_scans, "exactFallbackScans": d.exact_fallback_scans,
        "boundedPatternScans": d.bounded_pattern_scans, "boundedBoardSources": d.bounded_board_sources,
        "scheduledTripChecks": d.scheduled_trip_checks,
        "sourceFrontierPatterns": d.source_frontier_patterns,
        "sourceFrontierInputs": d.source_frontier_inputs,
        "sourceFrontierPruned": d.source_frontier_pruned,
        "sourceFrontierSurvivors": d.source_frontier_survivors,
        "sourceFrontierComparisons": d.source_frontier_comparisons,
        "maxSourceFrontierWidth": d.max_source_frontier_width,
        "boardCandidates": d.board_candidates, "sourceRegistrations": d.source_registrations,
        "concreteBoardCandidates": d.board_candidates - d.source_registrations,
        "acceptedStates": d.accepted_states, "dominatedStates": d.dominated_states,
        "maxBagWidth": d.max_bag_width, "continuationCandidates": d.continuation_candidates, "arenaBytes": d.arena_bytes
    })
}

fn row(measurement: Measurement, engine: Engine, tuple_index: usize, date: &str) -> Value {
    let profile = measurement.output.page;
    let hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&objectives(&profile)).expect("objective tuples"))
    );
    json!({
        "tupleIndex": tuple_index, "date": date, "engine": engine.name(), "eventWindowStart": profile.requested_window.start,
        "profileCount": profile.points.len(), "objectiveSha256": hash,
        "objectives": if profile.objectives == ProfileObjectives::R3 { "r3" } else { "m4" },
        "completion": match profile.completion { R3PageCompletion::SurvivorTargetClosed => "survivor-target-closed",
            R3PageCompletion::WindowExhausted => "window-exhausted" },
        "supportedServiceDate": profile.supported_service_date,
        "ptftStatus": match profile.ptft_status { R3PtftStatus::NotSupplied => "not-supplied", R3PtftStatus::Applied => "applied" },
        "multiDateStatus": match profile.multi_date_status {
            R3MultiDateStatus::UnsupportedSingleServiceDateOnly => "unsupported-single-service-date-only",
            R3MultiDateStatus::ServiceDayOrigins => "service-day-origins" },
        "searchStrategy": if engine == Engine::Round {
            format!("round-pattern-{}-v2", measurement.output.round_scan)
        } else {
            match profile.multi_date_status { R3MultiDateStatus::UnsupportedSingleServiceDateOnly => "reusable-label-v1",
                R3MultiDateStatus::ServiceDayOrigins => "bounded-exhaustive-v2" }.to_owned() },
        "requestedWindow": [profile.requested_window.start, profile.requested_window.end],
        "coverageScope": match profile.coverage_scope { R3CoverageScope::SuppliedWindowOnly => "supplied-window-only" },
        "coveredWindow": [profile.covered_window.start, profile.covered_window.end],
        "coveredFrontierSecs": profile.covered_frontier_secs,
        "latestDepartureCertificate": {
            "coveredFromSecs": profile.latest_departure_certificate.covered_from_secs,
            "coveredUntilExclusiveSecs": profile.latest_departure_certificate.covered_until_exclusive_secs,
            "nextUnprocessedOriginReadySecs": profile.latest_departure_certificate.next_unprocessed_origin_ready_secs,
            "equalTimeBoundaryClosed": profile.latest_departure_certificate.equal_time_boundary_closed,
        },
        "pageComplete": profile.page_complete, "windowExhausted": profile.window_exhausted, "dayExhausted": profile.day_exhausted,
        "p50Ms": measurement.p50, "p95Ms": measurement.p95,
        "diagnostics": { "entryEvents": profile.diagnostics.entry_events,
            "enumeratedEntryEvents": profile.diagnostics.enumerated_entry_events,
            "timestampBuckets": profile.diagnostics.timestamp_buckets, "acceptedLabels": profile.diagnostics.accepted_labels,
            "propagatedLabels": profile.diagnostics.propagated_labels, "reusedLabels": profile.diagnostics.reused_labels },
        "roundDiagnostics": measurement.output.round.map(round_diagnostics),
        "points": profile.points.iter().map(|p| json!({ "departureSecs": p.origin_departure_secs,
            "arrivalSecs": p.destination_arrival_secs, "actualTransfers": p.actual_transfers, "transitRounds": p.transit_rounds,
            "totalWalkSecs": p.total_walk_secs, "witnessLegs": p.witness.len() })).collect::<Vec<_>>(),
    })
}
