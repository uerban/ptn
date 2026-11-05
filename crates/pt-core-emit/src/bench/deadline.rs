//! Matched deadline-query ablations. Full profiles and backup policies are not
//! this workload; failed cells contain no partial points or latency percentiles.
use super::tuple_input;
use pt_core::engine::temporal_probe::r3::ProfileObjectives;
use pt_core::engine::temporal_probe::trip_based::*;
use pt_core::{Index, PatternMode, Reader, Transfers};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Instant;

pub fn run(args: &[String]) -> Result<String, String> {
    let (mut ptb, mut walks, mut tuples) = (None, None, None);
    let (mut start, mut end, mut deadline) = (None, None, None);
    let (mut engine, mut objective, mut pattern) = ("lazy-fast", "m4", "covering-merge");
    let mut prefix_bound = "off";
    let mut point_bound = "off";
    let mut traversal = "fifo";
    let mut witness_comparison = "materialized";
    let mut frontier_storage = "tree";
    let mut static_bound = "off";
    let mut walking_bound = "off";
    let mut forward_seeds = "off";
    let (mut iterations, mut warmup, mut rounds) = (5usize, 1usize, 4u32);
    let (mut states, mut width, mut scans, mut work) =
        (250_000usize, 64usize, 10_000_000usize, 10_000_000usize);
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if !arg.starts_with("--") {
            if ptb.is_none() {
                ptb = Some(arg);
            } else if walks.is_none() {
                walks = Some(arg);
            } else {
                return Err(format!("bench-trip-deadline: unexpected positional {arg}"));
            }
            i += 1;
            continue;
        }
        i += 1;
        let v = args
            .get(i)
            .map(String::as_str)
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| format!("bench-trip-deadline: {arg} requires a value"))?;
        match arg {
            "--query-tuples" => tuples = Some(v),
            "--window-start" => start = Some(v.parse::<i64>().map_err(|_| "invalid window-start")?),
            "--window-end" => end = Some(v.parse::<i64>().map_err(|_| "invalid window-end")?),
            "--arrival-deadline" => {
                deadline = Some(v.parse::<i64>().map_err(|_| "invalid arrival-deadline")?)
            }
            "--engine" => engine = v,
            "--objective" => objective = v,
            "--pattern-mode" => pattern = v,
            "--prefix-bound" => prefix_bound = v,
            "--point-bound" => point_bound = v,
            "--traversal" => traversal = v,
            "--witness-comparison" => witness_comparison = v,
            "--frontier-storage" => frontier_storage = v,
            "--static-bound" => static_bound = v,
            "--walking-bound" => walking_bound = v,
            "--forward-seeds" => forward_seeds = v,
            "--iterations" => iterations = v.parse().map_err(|_| "invalid iterations")?,
            "--warmup" => warmup = v.parse().map_err(|_| "invalid warmup")?,
            "--max-rounds" => rounds = v.parse().map_err(|_| "invalid max-rounds")?,
            "--max-states" => states = v.parse().map_err(|_| "invalid max-states")?,
            "--max-bag-width" => width = v.parse().map_err(|_| "invalid max-bag-width")?,
            "--max-stop-scans" => scans = v.parse().map_err(|_| "invalid max-stop-scans")?,
            "--max-lookup-work" => work = v.parse().map_err(|_| "invalid max-lookup-work")?,
            _ => return Err(format!("bench-trip-deadline: unknown option {arg}")),
        }
        i += 1;
    }
    let ptb = ptb.ok_or("missing PTB")?;
    let tuples = tuples.ok_or("missing query-tuples")?;
    let (start, end, deadline) = (
        start.ok_or("missing window-start")?,
        end.ok_or("missing window-end")?,
        deadline.ok_or("missing arrival-deadline")?,
    );
    if start >= end
        || deadline < end - 1
        || deadline == i64::MAX
        || rounds == 0
        || [iterations, states, width, scans, work].contains(&0)
        || iterations > 1000
        || warmup > 1000
    {
        return Err("invalid window/deadline or zero limit".into());
    }
    let objective_kind = match objective {
        "r3" => ProfileObjectives::R3,
        "m4" => ProfileObjectives::M4,
        _ => return Err("objective must be r3 or m4".into()),
    };
    let pruning = match (prefix_bound, point_bound) {
        ("off", "off") => DeadlinePruning::None,
        ("on", "off") => DeadlinePruning::EarliestPrefix,
        ("on", "on") => DeadlinePruning::EarliestPrefixAndPoints,
        _ => {
            return Err("bounds must be off/on and point-bound on requires prefix-bound on".into())
        }
    };
    let traversal_kind = match traversal {
        "fifo" => DeadlineTraversal::Fifo,
        "arrival-first" => DeadlineTraversal::ArrivalFirst,
        "guided" => DeadlineTraversal::Guided,
        _ => return Err("traversal must be fifo, arrival-first or guided".into()),
    };
    let bound_enabled = match static_bound {
        "off" => false,
        "on" => true,
        _ => return Err("static-bound must be off or on".into()),
    };
    let witness_comparison_kind = match witness_comparison {
        "materialized" => DeadlineWitnessComparison::Materialized,
        "streaming" => DeadlineWitnessComparison::Streaming,
        _ => return Err("witness-comparison must be materialized or streaming".into()),
    };
    let frontier_storage_kind = match frontier_storage {
        "tree" => DeadlineFrontierStorage::Tree,
        "event-indexed" => DeadlineFrontierStorage::EventIndexed,
        _ => return Err("frontier-storage must be tree or event-indexed".into()),
    };
    if traversal_kind == DeadlineTraversal::Guided && !bound_enabled {
        return Err("guided traversal requires static-bound on".into());
    }
    let walking_enabled = match walking_bound {
        "off" => false,
        "on" => true,
        _ => return Err("walking-bound must be off or on".into()),
    };
    if walking_enabled && pruning != DeadlinePruning::EarliestPrefixAndPoints {
        return Err("walking-bound on requires prefix-bound and point-bound on".into());
    }
    let forward_enabled = match forward_seeds {
        "off" => false,
        "on" => true,
        "raptor" | "raptor-guided" => false,
        _ => return Err("forward-seeds must be off, on, raptor or raptor-guided".into()),
    };
    let raptor_enabled = matches!(forward_seeds, "raptor" | "raptor-guided");
    if (forward_enabled || raptor_enabled) && pruning != DeadlinePruning::EarliestPrefixAndPoints {
        return Err("forward-seeds on requires prefix-bound and point-bound on".into());
    }
    let mode = match pattern {
        "off" => PatternMode::Off,
        "unbounded" => PatternMode::Unbounded,
        "covering-merge" => PatternMode::CoveringMerge,
        _ => return Err("invalid pattern mode".into()),
    };
    let modes = if engine == "compare" {
        vec!["graph", "lazy-fast"]
    } else {
        vec![engine]
    };
    if modes.iter().any(|e| {
        ![
            "graph",
            "lazy-all",
            "lazy-indexed",
            "lazy-fast",
            "lazy-cached",
        ]
        .contains(e)
    }) {
        return Err("invalid deadline engine".into());
    }
    let bytes = std::fs::read(ptb).map_err(|e| e.to_string())?;
    let ptb_hash = format!("{:x}", Sha256::digest(&bytes));
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("PTB: {e:?}"))?;
    let walk_bytes = walks
        .map(std::fs::read)
        .transpose()
        .map_err(|e| e.to_string())?;
    let walk_hash = walk_bytes
        .as_ref()
        .map(|b| format!("{:x}", Sha256::digest(b)));
    let transfers = walk_bytes
        .as_ref()
        .map(Transfers::from_bytes)
        .transpose()
        .map_err(|e| format!("PTFT: {e:?}"))?;
    let began = Instant::now();
    let index = Index::build(&reader, mode).map_err(|e| format!("index: {e:?}"))?;
    let index_ms = began.elapsed().as_secs_f64() * 1000.0;
    let inputs = tuple_input::load(tuples, &reader)?;
    let mut rows = Vec::new();
    for (tuple_index, mut input) in inputs.into_iter().enumerate() {
        input.query.max_rounds = Some(rounds);
        let config = TransferIndexConfig::new(input.query.date, start..deadline + 1);
        let began = Instant::now();
        let events = build_event_index(&reader, &index, transfers.as_ref(), &config);
        let event_ms = began.elapsed().as_secs_f64() * 1000.0;
        let events = match events {
            Ok(e) => e,
            Err(e) => {
                rows.push(
                    json!({"tupleIndex": tuple_index, "date": input.provenance.date,
                "status": "failed", "stage": "event-build", "error": format!("{e:?}")}),
                );
                continue;
            }
        };
        let began = Instant::now();
        let graph = if modes.contains(&"graph") {
            match build_transfer_index(&reader, &index, transfers.as_ref(), &config) {
                Ok(g) => Some(g),
                Err(e) => {
                    rows.push(
                        json!({"tupleIndex": tuple_index, "date": input.provenance.date,
                        "status": "failed", "stage": "graph-build", "error": format!("{e:?}")}),
                    );
                    continue;
                }
            }
        } else {
            None
        };
        let graph_ms = graph
            .as_ref()
            .map(|_| began.elapsed().as_secs_f64() * 1000.0);
        let execute =
            |engine: &str| {
                let mut request = DeadlineRequest::new(&input.query, start..end, deadline);
                request.objectives = objective_kind;
                request.pruning = pruning;
                request.traversal = traversal_kind;
                request.witness_comparison = witness_comparison_kind;
                request.frontier_storage = frontier_storage_kind;
                request.static_bound = bound_enabled;
                request.walking_bound = walking_enabled;
                request.forward_seeds = forward_enabled;
                request.raptor_seeds = raptor_enabled;
                request.raptor_destination_ordering = forward_seeds == "raptor-guided";
                request.transfers = transfers.as_ref();
                request.max_segments = states;
                request.max_frontier_width = width;
                request.max_stop_scans = scans;
                request.max_lookup_work = work;
                request.lookup = match engine {
                    "graph" => DeadlineLookup::Graph(graph.as_ref().expect("graph prepared")),
                    "lazy-all" => DeadlineLookup::Lazy(LazyLookupMode::ScanAll),
                    "lazy-indexed" => DeadlineLookup::Lazy(LazyLookupMode::StopIndexed),
                    "lazy-cached" => DeadlineLookup::Lazy(LazyLookupMode::PlainCached),
                    _ => DeadlineLookup::Lazy(LazyLookupMode::PlainFast),
                };
                let began = Instant::now();
                let mut prepared = None;
                let mut finished = None;
                let result =
                    query_deadline_with_phases(&reader, &index, &events, request, |phase| {
                        match phase {
                            DeadlinePhase::Prepared => prepared = Some(began.elapsed()),
                            DeadlinePhase::SearchFinished => finished = Some(began.elapsed()),
                        }
                    })?;
                let prepare = prepared.expect("successful query prepared");
                let search = finished.expect("successful query finished") - prepare;
                Ok::<_, DeadlineError>((
                    result,
                    prepare.as_secs_f64() * 1000.0,
                    search.as_secs_f64() * 1000.0,
                ))
            };
        let mut parity = None;
        let mut preflight = Vec::new();
        let mut failed = None;
        for &engine in &modes {
            match execute(engine) {
                Ok((result, _, _)) => {
                    if let Some(points) = &parity {
                        if points != &result.points {
                            failed = Some("graph/lazy canonical mismatch".to_string());
                            break;
                        }
                    } else {
                        parity = Some(result.points.clone());
                    }
                    preflight.push((engine, result));
                }
                Err(e) => {
                    failed = Some(format!("{engine}: {e:?}"));
                    break;
                }
            }
        }
        if let Some(error) = failed {
            rows.push(
                json!({"tupleIndex": tuple_index, "date": input.provenance.date,
                "status": "failed", "stage": "preflight", "error": error}),
            );
            continue;
        }
        let mut measurements = Vec::new();
        for (engine, expected) in preflight {
            let measurement = (|| -> Result<Value, String> {
                for _ in 0..warmup {
                    execute(engine).map_err(|e| format!("{e:?}"))?;
                }
                let mut samples = Vec::with_capacity(iterations);
                let mut prepare_samples = Vec::with_capacity(iterations);
                let mut search_samples = Vec::with_capacity(iterations);
                let mut last = None;
                for _ in 0..iterations {
                    let began = Instant::now();
                    let (result, prepare, search) =
                        execute(engine).map_err(|e| format!("{e:?}"))?;
                    samples.push(began.elapsed().as_secs_f64() * 1000.0);
                    prepare_samples.push(prepare);
                    search_samples.push(search);
                    if !result.complete
                        || result.points != expected.points
                        || result.diagnostics != expected.diagnostics
                        || result.frontiers != expected.frontiers
                    {
                        return Err("timed result drift".into());
                    }
                    last = Some(result);
                }
                let raw_samples = samples.clone();
                let raw_prepare_samples = prepare_samples.clone();
                let raw_search_samples = search_samples.clone();
                samples.sort_by(f64::total_cmp);
                prepare_samples.sort_by(f64::total_cmp);
                search_samples.sort_by(f64::total_cmp);
                let result = last.expect("positive iterations");
                let objectives: Vec<_> = result
                    .points
                    .iter()
                    .map(|p| {
                        (
                            p.origin_departure_secs,
                            p.destination_arrival_secs,
                            p.actual_transfers,
                            (objective_kind == ProfileObjectives::M4).then_some(p.total_walk_secs),
                        )
                    })
                    .collect();
                let d = result.diagnostics;
                let f = result.frontiers;
                let lazy_diagnostics = json!({"work":d.lazy.work, "eventProbes":d.lazy.event_probes,"pairChecks":d.lazy.pair_checks,
                    "instanceProbes":d.lazy.instance_probes,"plainPairChecks":d.lazy.plain_pair_checks,
                    "fallbackPairChecks":d.lazy.fallback_pair_checks,"walkingIndexEdges":d.lazy.walking_index_edges,
                    "ruleCandidateEdges":d.lazy.rule_candidate_edges,
                    "stopIndexed":d.lazy.stop_indexed,"earlySourceRowsSkipped":d.lazy.early_source_rows_skipped,
                    "sourceBoundCacheRows":d.lazy.source_bound_cache_rows,"sourceBoundCacheProbes":d.lazy.source_bound_cache_probes,
                    "sourceBoundCacheHits":d.lazy.source_bound_cache_hits,"sourceBoundCacheMisses":d.lazy.source_bound_cache_misses,
                    "sourceBoundCacheBytes":d.lazy.source_bound_cache_bytes});
                let raptor_diagnostics = json!({"enabled":d.raptor.enabled,"generationStopScans":d.raptor.generation_stop_scans,
                    "generationLookupWork":d.raptor.generation_lookup_work,"generationStates":d.raptor.generation_states,
                    "generationCacheBytes":d.raptor.generation_cache_bytes,
                    "catalogueCacheBuilds":d.raptor.catalogue_cache_builds,"catalogueCacheHits":d.raptor.catalogue_cache_hits,
                    "catalogueEventChecks":d.raptor.catalogue_event_checks,"targetFirstStops":d.raptor.target_first_stops,
                    "orderingAttempted":d.raptor.ordering_attempted,"orderingReady":d.raptor.ordering_ready,
                    "orderingStopScans":d.raptor.ordering_stop_scans,"orderingLookupWork":d.raptor.ordering_lookup_work,
                    "orderingRows":d.raptor.ordering_rows,"orderingEdges":d.raptor.ordering_edges,"orderingBytes":d.raptor.ordering_bytes,
                    "candidates":d.raptor.candidates,"replayed":d.raptor.replayed,"rejected":d.raptor.rejected,
                    "replayTruncations":d.raptor.replay_truncations,"replayStopScans":d.raptor.replay_stop_scans,
                    "replayLookupWork":d.raptor.replay_lookup_work,"replayStates":d.raptor.replay_states});
                let mut measurement = json!({"engine": engine, "status": "completed", "complete": result.complete,
                    "p50Ms": samples[(iterations-1)/2], "p95Ms": samples[(iterations*95).div_ceil(100).saturating_sub(1)],
                    "prepareP50Ms": prepare_samples[(iterations-1)/2],
                    "prepareP95Ms": prepare_samples[(iterations*95).div_ceil(100).saturating_sub(1)],
                    "searchP50Ms": search_samples[(iterations-1)/2],
                    "searchP95Ms": search_samples[(iterations*95).div_ceil(100).saturating_sub(1)],
                    "objectiveSha256": format!("{:x}",Sha256::digest(serde_json::to_vec(&objectives).unwrap())),
                    "pointCount": result.points.len(), "points": result.points.iter().map(|p| json!({
                        "departureSecs": p.origin_departure_secs, "arrivalSecs": p.destination_arrival_secs,
                        "actualTransfers": p.actual_transfers, "totalWalkSecs": p.total_walk_secs,
                        "transitRounds": p.transit_rounds, "serviceDate":p.service_date,"witnessLegs": p.witness.len(),
                        "witness":p.witness.iter().map(|w|json!({"serviceDate":w.service_date,"routeIdx":w.route_idx,
                            "readerRouteIdx":w.reader_route_idx,"tripIdx":w.trip_idx,"boardPosition":w.board_position,
                            "alightPosition":w.alight_position,"boardSecs":w.board_secs,"alightSecs":w.alight_secs,
                            "frequencyOffsetSecs":w.frequency_offset_secs,"frequencyInstance":w.frequency_instance,
                            "inSeat":w.in_seat})).collect::<Vec<_>>() })).collect::<Vec<_>>(),
                    "diagnostics": { "seedEventChecks":d.seed_event_checks, "segmentsEnqueued":d.segments_enqueued,
                        "segmentsScanned":d.segments_scanned, "dominatedSegments":d.dominated_segments,
                        "stopEventsScanned":d.stop_events_scanned, "maxFrontierWidth":d.max_frontier_width,
                        "arenaBytes":d.arena_bytes, "incomingIndexBytes":d.incoming_index_bytes,
                        "graphEdgesPrepared":d.graph_edges_prepared, "graphEdgesScanned":d.graph_edges_scanned,
                        "forward": {"enabled":d.forward.enabled,"selectionChecks":d.forward.selection_checks,"rootCandidates":d.forward.root_candidates,
                            "shots":d.forward.shots,"truncatedShots":d.forward.truncated_shots,"stopScans":d.forward.stop_scans,"stopWork":d.forward.stop_work(),
                            "lookupWork":d.forward.lookup_work,"acceptedStates":d.forward.accepted_states,"incumbents":d.forward.incumbents,
                            "certifiedPrunes":d.forward.certified_prunes,"arenaBytes":d.forward.arena_bytes},
                        "raptor": raptor_diagnostics,
                        "optimistic": {"enabled":d.optimistic.enabled,"work":d.optimistic.work(),
                            "templateRows":d.optimistic.template_rows,"movementChecks":d.optimistic.movement_checks,
                            "distanceWork":d.optimistic.distance_work,"edges":d.optimistic.edges,
                            "graphBytes":d.optimistic.graph_bytes,"potentialBytes":d.optimistic.potential_bytes,
                            "originDurationSecs":d.optimistic.origin_duration_secs,
                            "originPrunedSegments":d.optimistic.origin_pruned_segments,
                            "destinationPrunedSegments":d.optimistic.destination_pruned_segments,
                            "walkingPrunedBoardings":d.optimistic.walking_pruned_boardings},
                        "prefix": {"enabled":d.prefix.enabled,"eventScans":d.prefix.event_scans,
                            "walkingRelaxations":d.prefix.walking_relaxations,"indexBytes":d.prefix.index_bytes,
                            "prunedBoardings":d.prefix.pruned_boardings,"prunedSourceRows":d.prefix.pruned_source_rows,
                            "pointPrunedBoardings":d.prefix.point_pruned_boardings,
                            "walkingEnabled":d.prefix.walking_enabled,"walkingBytes":d.prefix.walking_bytes,
                            "walkingPrunedBoardings":d.prefix.walking_pruned_boardings},
                        "lazy": lazy_diagnostics } });
                measurement["rawSamplesMs"] = json!(raw_samples);
                measurement["rawPrepareSamplesMs"] = json!(raw_prepare_samples);
                measurement["rawSearchSamplesMs"] = json!(raw_search_samples);
                measurement["frontiers"] = json!({"directoryEntries":f.directory_entries,"directoryCapacityBytes":f.directory_capacity_bytes,
                    "records":f.records,"recordCapacityBytes":f.record_capacity_bytes,"retainedIds":f.retained_ids,"idCapacityBytes":f.id_capacity_bytes});
                Ok(measurement)
            })();
            match measurement {
                Ok(m) => measurements.push(m),
                Err(error) => {
                    failed = Some(error);
                    break;
                }
            }
        }
        if let Some(error) = failed {
            rows.push(
                json!({"tupleIndex": tuple_index, "date": input.provenance.date,
                "status":"failed", "stage":"measurement", "error":error}),
            );
            continue;
        }
        let d = events.diagnostics();
        rows.push(json!({"tupleIndex":tuple_index,"date":input.provenance.date,"status":"completed",
            "parity":if engine=="compare" {"unreduced-graph-and-lazy-canonical-equal"} else {"not-checked"},
            "eventBuildMs":event_ms,"graphBuildMs":graph_ms,"eventIndexBytes":d.index_bytes,
            "events":d.events,"catalogueKey":events.binding().config_sha256,
            "graphIndexBytes":graph.as_ref().map(|g|g.diagnostics().index_bytes),
            "measurements":measurements}));
    }
    let failed = rows.iter().any(|r| r["status"] != "completed");
    serde_json::to_string_pretty(&json!({"scope":"deadline-constrained-r3-m4-experiment",
        "status":if failed {"failed"} else {"completed"}, "fullProfilePromotion":false,
        "engine":engine,"objective":objective,"patternMode":pattern,
        "prefixBound":prefix_bound,
        "pointBound":point_bound,
        "traversal":traversal,
        "witnessComparison":witness_comparison,"frontierStorage":frontier_storage,
        "pointerBytes":core::mem::size_of::<usize>(),
        "staticBound":static_bound,
        "walkingBound":walking_bound,
        "forwardSeeds":forward_seeds,
        "requestedWindow":[start,end],"arrivalDeadline":deadline,"maxRounds":rounds,
        "maxStates":states,"maxBagWidth":width,"maxStopScans":scans,"maxLookupWork":work,
        "iterations":iterations,"warmup":warmup,"indexBuildMs":index_ms,
        "timingScope":{"total":"per-call setup, search and teardown; excludes PTB/PTFT decode and event/graph/Index build",
            "prepare":"binding, monotonicity, access, optional prefix bound, incoming-index rebuild and frontier directory initialization",
            "search":"destination seeds, traversal, witnesses, skyline sort and counters",
            "graphIncomingIndexRebuiltPerCall":true},
        "workCapScope":{"graph":"prepared edges and scanned edges each independently capped",
            "lazy":"aggregate sampling trip/instance work, walking-index edges, event probes, pair checks and instance probes",
            "sampling":"selection/scans in stop budget; accepted forward states plus reverse segments in original state budget"},
        "ptbSha256":ptb_hash,"transfersSha256":walk_hash,
        "queryTuplesSha256":format!("{:x}",Sha256::digest(std::fs::read(tuples).map_err(|e|e.to_string())?)),
        "queries":rows})).map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontier_storage_typos_reject_before_loading_artifacts() {
        let args = [
            "missing.ptb",
            "--query-tuples",
            "missing.json",
            "--window-start",
            "0",
            "--window-end",
            "1",
            "--arrival-deadline",
            "1",
            "--frontier-storage",
            "indexed",
        ]
        .map(String::from);
        assert_eq!(
            run(&args),
            Err("frontier-storage must be tree or event-indexed".into())
        );
    }

    #[test]
    fn witness_comparison_typos_reject_before_loading_artifacts() {
        let args = [
            "missing.ptb",
            "--query-tuples",
            "missing.json",
            "--window-start",
            "0",
            "--window-end",
            "1",
            "--arrival-deadline",
            "1",
            "--witness-comparison",
            "stream",
        ]
        .map(String::from);
        assert_eq!(
            run(&args),
            Err("witness-comparison must be materialized or streaming".into())
        );
    }

    #[test]
    fn traversal_typos_are_rejected_before_loading_artifacts() {
        let args = [
            "missing.ptb",
            "--query-tuples",
            "missing.json",
            "--window-start",
            "0",
            "--window-end",
            "1",
            "--arrival-deadline",
            "1",
            "--traversal",
            "beam",
        ]
        .map(String::from);
        assert_eq!(
            run(&args),
            Err("traversal must be fifo, arrival-first or guided".into())
        );
    }
    #[test]
    fn guided_cannot_implicitly_enable_bounds() {
        let args = [
            "missing.ptb",
            "--query-tuples",
            "missing.json",
            "--window-start",
            "0",
            "--window-end",
            "1",
            "--arrival-deadline",
            "1",
            "--traversal",
            "guided",
        ]
        .map(String::from);
        assert_eq!(
            run(&args),
            Err("guided traversal requires static-bound on".into())
        );
    }
    #[test]
    fn walking_typos_and_missing_point_bounds_reject_before_artifact_io() {
        for (value, message) in [
            ("yes", "walking-bound must be off or on"),
            (
                "on",
                "walking-bound on requires prefix-bound and point-bound on",
            ),
        ] {
            let args = [
                "missing.ptb",
                "--query-tuples",
                "missing.json",
                "--window-start",
                "0",
                "--window-end",
                "1",
                "--arrival-deadline",
                "1",
                "--walking-bound",
                value,
            ]
            .map(String::from);
            assert_eq!(run(&args), Err(message.into()));
        }
    }
    #[test]
    fn cached_engine_is_explicit_and_typos_reject_before_artifact_io() {
        for (value, accepted) in [("lazy-cached", true), ("lazy-cache", false)] {
            let args = [
                "missing.ptb",
                "--query-tuples",
                "missing.json",
                "--window-start",
                "0",
                "--window-end",
                "1",
                "--arrival-deadline",
                "1",
                "--engine",
                value,
            ]
            .map(String::from);
            let error = run(&args).unwrap_err();
            if accepted {
                assert_ne!(error, "invalid deadline engine");
            } else {
                assert_eq!(error, "invalid deadline engine");
            }
        }
    }
    #[test]
    fn forward_typos_and_missing_point_bounds_reject_before_artifact_io() {
        for (value, message) in [
            (
                "yes",
                "forward-seeds must be off, on, raptor or raptor-guided",
            ),
            (
                "on",
                "forward-seeds on requires prefix-bound and point-bound on",
            ),
            (
                "raptor",
                "forward-seeds on requires prefix-bound and point-bound on",
            ),
            (
                "raptor-guided",
                "forward-seeds on requires prefix-bound and point-bound on",
            ),
        ] {
            let args = [
                "missing.ptb",
                "--query-tuples",
                "missing.json",
                "--window-start",
                "0",
                "--window-end",
                "1",
                "--arrival-deadline",
                "1",
                "--forward-seeds",
                value,
            ]
            .map(String::from);
            assert_eq!(run(&args), Err(message.into()));
        }
    }
}
