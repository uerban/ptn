//! Native-only full-M4-plus-selection versus discovered winner search.
//! No oracle winners are injected. Failed queries return no points/timings.
use super::{
    incumbent_ceiling::{counters, point},
    tuple_input,
};
use pt_core::{engine::temporal_probe::trip_based::*, Index, PatternMode, Reader, Transfers};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Instant;

mod journeys;
mod lifecycle;
#[cfg(test)]
mod owner_binding_tests;
mod requests;
#[cfg(test)]
mod requests_tests;
#[cfg(test)]
mod setup_profile_tests;

#[derive(Debug, PartialEq)]
struct Outcome {
    winners: DeadlinePortfolioWinners,
    profile: Option<Vec<pt_core::engine::temporal_probe::r3::R3Point>>,
    diagnostics: DeadlineDiagnostics,
    frontiers: DeadlineFrontierStats,
    selection: DeadlinePortfolioDiagnostics,
}
pub(super) fn winners(
    w: &DeadlinePortfolioWinners,
    preference: Option<DeadlinePreference>,
) -> Value {
    Value::Object(
        DeadlinePreference::ALL
            .into_iter()
            .zip(&w.by_preference)
            .filter(|(s, _)| preference.is_none_or(|p| p == *s))
            .map(|(s, p)| (s.name().into(), p.as_ref().map_or(Value::Null, point)))
            .collect(),
    )
}
pub(super) fn percentile(values: &[f64], p: usize) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[(sorted.len() * p).div_ceil(100).saturating_sub(1)]
}

fn owned_outcome(
    owner: &DeadlineSession,
    preference: Option<DeadlinePreference>,
    suffix: DeadlineSuffixPruning,
    checked: bool,
    observe: &mut dyn FnMut(DeadlinePhase),
) -> Result<Outcome, DeadlineError> {
    if let Some(preference) = preference {
        let r = if checked {
            owner.run_preference_checked_with_phases(preference, suffix, observe)
        } else {
            owner.run_preference_with_phases(preference, suffix, observe)
        }?;
        assert!(r.complete);
        assert_eq!(r.preference, preference);
        let mut winners = DeadlinePortfolioWinners::default();
        let slot = DeadlinePreference::ALL
            .iter()
            .position(|p| *p == preference)
            .unwrap();
        winners.by_preference[slot] = r.winner;
        Ok(Outcome {
            winners,
            profile: None,
            diagnostics: r.diagnostics,
            frontiers: r.frontiers,
            selection: r.selection,
        })
    } else {
        let r = if checked {
            owner.run_portfolio_checked_with_phases(suffix, observe)
        } else {
            owner.run_portfolio_with_phases(suffix, observe)
        }?;
        assert!(r.complete);
        Ok(Outcome {
            winners: r.winners,
            profile: None,
            diagnostics: r.diagnostics,
            frontiers: r.frontiers,
            selection: r.selection,
        })
    }
}

fn outcome_fields(
    expected: &Outcome,
    kind: &str,
    preference: Option<DeadlinePreference>,
    traversal: DeadlineTraversal,
    timetable: bool,
) -> Value {
    let mut row = json!({
        "completionScope":if kind=="profile" {"full-m4-and-selectors"} else if preference.is_some() {"single-selector-only"} else {"fixed-selectors-only"},
        "winners":winners(&expected.winners,preference),"counters":counters(&expected.diagnostics),
        "selection":{"boundChecks":expected.selection.bound_checks,"prunedBoardings":expected.selection.pruned_boardings},
        "suffixSelection":{"boundChecks":expected.selection.suffix_bound_checks,"prunedSuffixes":expected.selection.pruned_suffixes},
        "predecessorSelection":{"boundChecks":expected.selection.predecessor_bound_checks,"prunedPairs":expected.selection.pruned_predecessor_pairs},
        "rowSelection":{"boundChecks":expected.diagnostics.lazy.row_bound_checks,"skippedRows":expected.diagnostics.lazy.certified_source_rows_skipped},
        "cutoffSelection":{"builds":expected.selection.row_ceiling_builds,"selectorsEvaluated":expected.selection.row_ceiling_selectors,"disabled":expected.selection.row_ceiling_disabled},
        "incomingOrdering":{"packedCalls":expected.diagnostics.lazy.packed_sort_calls,"peakAdditionalKeyCapacityBytes":expected.diagnostics.lazy.packed_sort_peak_bytes},
        "frontiers":{"directoryEntries":expected.frontiers.directory_entries,"directoryCapacityBytes":expected.frontiers.directory_capacity_bytes,
            "records":expected.frontiers.records,"recordCapacityBytes":expected.frontiers.record_capacity_bytes,
            "retainedIds":expected.frontiers.retained_ids,"idCapacityBytes":expected.frontiers.id_capacity_bytes}});
    if let Some(points) = &expected.profile {
        row["profilePoints"] = json!(points.iter().map(point).collect::<Vec<_>>());
    }
    if matches!(
        traversal,
        DeadlineTraversal::DepartureWarmup64 | DeadlineTraversal::OriginPrefixWarmup
    ) {
        let w = expected.diagnostics.warmup;
        row["discoveryWarmup"] = json!({
            "preferredScans":w.preferred_scans,"restored":w.restored,
            "pointsAtRestore":w.points_at_restore,"pendingAtRestore":w.pending_at_restore,
            "liveRequeued":w.live_requeued,"additionalQueueCapacityBytes":w.additional_queue_capacity_bytes});
    }
    if traversal == DeadlineTraversal::OriginPrefixWarmup {
        let h = expected.diagnostics.origin_hint;
        row["originHint"] =
            json!({"enabled":h.enabled,"checks":h.checks,"indexBytes":h.index_bytes});
    }
    if timetable {
        let p = expected.diagnostics.prefix.timetable;
        row["timetablePrefix"] = json!({"enabled":p.enabled,
            "eventScans":p.event_scans,"walkingProposals":p.walking_proposals,
            "profileChecks":p.profile_checks,"retainedLabels":p.retained_labels,
            "indexBytes":p.index_bytes,"work":p.work()});
    }
    row
}

pub fn run(args: &[String]) -> Result<String, String> {
    run_inner(args, false)
}

pub fn run_winner_ceiling(args: &[String]) -> Result<String, String> {
    run_inner(args, true)
}

fn run_inner(args: &[String], ceiling: bool) -> Result<String, String> {
    let (mut ptb, mut walks, mut tuples, mut start, mut end, mut deadline) =
        (None, None, None, None, None, None);
    let (mut kind, mut pattern) = ("portfolio", "covering-merge");
    let mut traversal = "arrival-first";
    let mut suffix = if ceiling { "row-prefix" } else { "off" };
    let mut frontier = if ceiling { "event-indexed" } else { "tree" };
    let mut validation = if ceiling { "owned-session" } else { "checked" };
    let mut witness = "materialized";
    let mut lookup = "lazy-cached";
    let mut prefix_certificate = "duration";
    let mut prefix_setup = "rebuild";
    let mut owner_lifecycle = "shared";
    let mut catalogue_setup = "fresh";
    let mut request_order = "input";
    let mut setup_profile = "off";
    let mut owner_binding = "recompute";
    let mut journey_audit = "off";
    let (mut iterations, mut warmup, mut rounds) = (1usize, 0usize, 4u32);
    let (mut states, mut width, mut scans, mut work) =
        (250_000usize, 64usize, 10_000_000usize, 10_000_000usize);
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if !a.starts_with("--") {
            if ptb.is_none() {
                ptb = Some(a);
            } else if walks.is_none() {
                walks = Some(a);
            } else {
                return Err("unexpected positional argument".into());
            }
            i += 1;
            continue;
        }
        i += 1;
        let v = args
            .get(i)
            .map(String::as_str)
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| format!("{a} requires a value"))?;
        match a {
            "--query-tuples" => tuples = Some(v),
            "--window-start" => start = Some(v.parse::<i64>().map_err(|_| "invalid window-start")?),
            "--window-end" => end = Some(v.parse::<i64>().map_err(|_| "invalid window-end")?),
            "--arrival-deadline" => {
                deadline = Some(v.parse::<i64>().map_err(|_| "invalid arrival-deadline")?)
            }
            "--query-kind" => kind = v,
            "--traversal" => traversal = v,
            "--suffix-bound" => suffix = v,
            "--frontier-storage" => frontier = v,
            "--validation" => validation = v,
            "--witness-comparison" => witness = v,
            "--lookup" => lookup = v,
            "--prefix-certificate" => prefix_certificate = v,
            "--prefix-setup" => prefix_setup = v,
            "--owner-lifecycle" => owner_lifecycle = v,
            "--catalogue-setup" => catalogue_setup = v,
            "--request-order" => request_order = v,
            "--setup-profile" => setup_profile = v,
            "--owner-binding" => owner_binding = v,
            "--journey-audit" => journey_audit = v,
            "--pattern-mode" => pattern = v,
            "--iterations" => iterations = v.parse().map_err(|_| "invalid iterations")?,
            "--warmup" => warmup = v.parse().map_err(|_| "invalid warmup")?,
            "--max-rounds" => rounds = v.parse().map_err(|_| "invalid max-rounds")?,
            "--max-states" => states = v.parse().map_err(|_| "invalid max-states")?,
            "--max-bag-width" => width = v.parse().map_err(|_| "invalid max-bag-width")?,
            "--max-stop-scans" => scans = v.parse().map_err(|_| "invalid max-stop-scans")?,
            "--max-lookup-work" => work = v.parse().map_err(|_| "invalid max-lookup-work")?,
            _ => return Err(format!("unknown portfolio option {a}")),
        }
        i += 1;
    }
    let (ptb, tuples, start, end, deadline) = (
        ptb.ok_or("missing PTB")?,
        tuples.ok_or("missing query-tuples")?,
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
        return Err("invalid portfolio window or limit".into());
    }
    let preference = DeadlinePreference::ALL
        .into_iter()
        .find(|p| p.name() == kind);
    if !["profile", "portfolio"].contains(&kind) && preference.is_none() {
        return Err("query-kind must be profile, portfolio or a named preference".into());
    }
    let traversal_kind = match traversal {
        "arrival-first" => DeadlineTraversal::ArrivalFirst,
        "departure-first" => DeadlineTraversal::DepartureFirst,
        "departure-warmup64" => DeadlineTraversal::DepartureWarmup64,
        "origin-prefix-warmup" => DeadlineTraversal::OriginPrefixWarmup,
        _ => {
            return Err(
                "traversal must be arrival-first, departure-first, departure-warmup64 or origin-prefix-warmup".into(),
            )
        }
    };
    let suffix_pruning = match suffix {
        "off" => DeadlineSuffixPruning::Off,
        "on" if kind != "profile" => DeadlineSuffixPruning::On,
        "before-pairs" if kind != "profile" => DeadlineSuffixPruning::BeforePairs,
        "row-prefix" if kind != "profile" => DeadlineSuffixPruning::RowPrefix,
        "row-ceiling" if kind != "profile" => DeadlineSuffixPruning::RowCeiling,
        _ => {
            return Err(
                "suffix-bound must be off, on, before-pairs, row-prefix or row-ceiling for a winner query"
                    .into(),
            )
        }
    };
    let mode = match pattern {
        "off" => PatternMode::Off,
        "unbounded" => PatternMode::Unbounded,
        "covering-merge" => PatternMode::CoveringMerge,
        _ => return Err("invalid pattern mode".into()),
    };
    let frontier_storage = match frontier {
        "tree" => DeadlineFrontierStorage::Tree,
        "event-indexed" => DeadlineFrontierStorage::EventIndexed,
        _ => return Err("frontier-storage must be tree or event-indexed".into()),
    };
    if !["checked", "owned-checked", "owned-session"].contains(&validation)
        || kind == "profile" && validation != "checked"
    {
        return Err(
            "validation must be checked, owned-checked or owned-session for winner queries".into(),
        );
    }
    let witness_comparison = match witness {
        "materialized" => DeadlineWitnessComparison::Materialized,
        "materialized-date-memo" => DeadlineWitnessComparison::MaterializedDateMemo,
        _ => {
            return Err("witness-comparison must be materialized or materialized-date-memo".into())
        }
    };
    let lookup_mode = match lookup {
        "lazy-cached" => LazyLookupMode::PlainCached,
        "lazy-cached-packed" => LazyLookupMode::PlainCachedPacked,
        _ => return Err("lookup must be lazy-cached or lazy-cached-packed".into()),
    };
    let pruning = match prefix_certificate {
        "duration" => DeadlinePruning::EarliestPrefixAndPoints,
        "timetable" if !ceiling => DeadlinePruning::EarliestPrefixAndTimetablePoints,
        _ => {
            return Err(
                "prefix-certificate must be duration or timetable (ordinary queries only)".into(),
            )
        }
    };
    if !["rebuild", "prepared"].contains(&prefix_setup)
        || prefix_setup == "prepared"
            && (ceiling
                || kind == "profile"
                || validation != "owned-session"
                || prefix_certificate != "timetable")
    {
        return Err("prefix-setup must be rebuild or prepared (ordinary owned-session timetable winner query only)".into());
    }
    if ceiling
        && (kind == "profile"
            || validation != "owned-session"
            || suffix != "row-prefix"
            || frontier != "event-indexed"
            || traversal != "arrival-first"
            || lookup != "lazy-cached")
    {
        return Err("winner ceiling requires winner query, owned-session, row-prefix, event-indexed, arrival-first and lazy-cached".into());
    }
    if !["shared", "fresh", "requests"].contains(&owner_lifecycle)
        || owner_lifecycle != "shared"
            && (ceiling || kind == "profile" || validation != "owned-session")
    {
        return Err(
            "owner-lifecycle must be shared, fresh or requests (ordinary owned-session winner query only)"
                .into(),
        );
    }
    if !["fresh", "reuse"].contains(&catalogue_setup)
        || !["input", "date-interleaved"].contains(&request_order)
        || owner_lifecycle != "requests" && (catalogue_setup != "fresh" || request_order != "input")
        || owner_lifecycle == "requests" && prefix_setup != "rebuild"
    {
        return Err("catalogue-setup fresh|reuse and request-order input|date-interleaved require requests lifecycle with rebuilding prefixes".into());
    }
    if !["off", "phases"].contains(&setup_profile)
        || setup_profile == "phases" && owner_lifecycle != "fresh"
    {
        return Err("setup-profile must be off or phases (fresh owner lifecycle only)".into());
    }
    if !["recompute", "retained"].contains(&owner_binding)
        || owner_binding == "retained"
            && (ceiling
                || kind == "profile"
                || validation != "owned-session"
                || owner_lifecycle == "requests")
    {
        return Err("owner-binding must be recompute or retained (ordinary owned-session shared/fresh winner query only)".into());
    }
    if !["off", "on"].contains(&journey_audit)
        || journey_audit == "on"
            && (ceiling
                || kind == "profile"
                || validation == "checked"
                || owner_lifecycle != "shared"
                || iterations != 1
                || warmup != 0
                || setup_profile != "off")
    {
        return Err("journey-audit must be off or on (shared owned winner correctness run, iterations1/warmup0 only)".into());
    }
    let bytes = std::fs::read(ptb).map_err(|e| e.to_string())?;
    let ptb_hash = format!("{:x}", Sha256::digest(&bytes));
    let owned_bytes =
        (validation != "checked" && owner_lifecycle == "shared").then(|| bytes.clone());
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
    let index = Index::build(&reader, mode).map_err(|e| format!("index: {e:?}"))?;
    // The parser/reference reader remains outside timing. Both owned ablations
    // construct the same private owner from the captured, hash-bound bytes.
    let began = Instant::now();
    let mut owner = owned_bytes
        .map(|b| {
            let owned_reader = Reader::from_bytes(b).map_err(|e| format!("owned PTB: {e:?}"))?;
            let owned_walks = walk_bytes
                .as_ref()
                .map(Transfers::from_bytes)
                .transpose()
                .map_err(|e| format!("owned PTFT: {e:?}"))?;
            let construct = if owner_binding == "retained" {
                DeadlineSession::new_with_immutable_binding
            } else {
                DeadlineSession::new
            };
            construct(owned_reader, mode, owned_walks).map_err(|e| format!("owner: {e:?}"))
        })
        .transpose()?;
    let owner_constructor_ms = owner
        .as_ref()
        .map(|_| began.elapsed().as_secs_f64() * 1000.0);
    let inputs = tuple_input::load(tuples, &reader)?;
    let mut session_config = DeadlineSessionConfig::new(start..end, deadline);
    session_config.lookup = lookup_mode;
    session_config.pruning = pruning;
    session_config.traversal = traversal_kind;
    session_config.frontier_storage = frontier_storage;
    session_config.witness_comparison = witness_comparison;
    session_config.max_segments = states;
    session_config.max_frontier_width = width;
    session_config.max_stop_scans = scans;
    session_config.max_lookup_work = work;
    let (mut rows, sweeps) = if owner_lifecycle == "requests" {
        let (rows, sweeps) = requests::run(requests::Context {
            ptb: reader.bytes_view().expect("captured PTB bytes"),
            walks: walk_bytes.as_deref(),
            inputs: &inputs,
            config: &session_config,
            pattern: mode,
            preference,
            suffix: suffix_pruning,
            timetable: prefix_certificate == "timetable",
            kind,
            rounds,
            reuse: catalogue_setup == "reuse",
            interleaved: request_order == "date-interleaved",
            iterations,
            warmup,
        })?;
        (rows, Some(sweeps))
    } else {
        (Vec::new(), None)
    };
    let inputs = if sweeps.is_some() { Vec::new() } else { inputs };
    for (tuple_index, input) in inputs.into_iter().enumerate() {
        let mut q = input.query;
        q.max_rounds = Some(rounds);
        let config = TransferIndexConfig {
            mobility: q.mobility,
            excluded_modes: q.excluded_modes.clone(),
            ..TransferIndexConfig::new(q.date, start..deadline + 1)
        };
        let session_config = session_config.clone();
        if owner_lifecycle == "fresh" {
            rows.push(lifecycle::row(lifecycle::Context {
                ptb: reader.bytes_view().expect("captured PTB bytes"),
                walks: walk_bytes.as_deref(),
                query: &q,
                config: &session_config,
                pattern: mode,
                preference,
                suffix: suffix_pruning,
                prefix_cache: prefix_setup == "prepared",
                setup_profile: setup_profile == "phases",
                owner_binding: owner_binding == "retained",
                timetable: prefix_certificate == "timetable",
                kind,
                tuple_index,
                date: &input.provenance.date,
                iterations,
                warmup,
            }));
            continue;
        }
        let began = Instant::now();
        let events = if owner.is_none() {
            Some(
                build_event_index(&reader, &index, transfers.as_ref(), &config)
                    .map_err(|e| format!("catalogue: {e:?}"))?,
            )
        } else {
            None
        };
        let event_ms = began.elapsed().as_secs_f64() * 1000.0;
        let (event_count, catalogue_key, session_prepare_ms) = if let Some(s) = &mut owner {
            let began = Instant::now();
            let d = if prefix_setup == "prepared" {
                s.prepare_with_prefix_cache(q.clone(), session_config)
            } else {
                s.prepare(q.clone(), session_config)
            }
            .map_err(|e| format!("session preparation: {e:?}"))?;
            let ms = began.elapsed().as_secs_f64() * 1000.0;
            assert!(!s.catalogue_reused());
            (d.events, s.catalogue_key().expect("prepared key"), Some(ms))
        } else {
            let e = events.as_ref().expect("checked catalogue");
            (e.events().len(), e.binding().config_sha256, None)
        };
        if journey_audit == "on" {
            rows.push(journeys::row(
                owner.as_ref().expect("audit requires owner"),
                preference,
                suffix_pruning,
                validation == "owned-checked",
                tuple_index,
                &input.provenance.date,
                traversal_kind,
                prefix_certificate == "timetable",
            )?);
            continue;
        }
        if ceiling {
            rows.push(super::winner_ceiling::row(
                owner.as_ref().expect("diagnostic requires immutable owner"),
                super::winner_ceiling::Context {
                    tuple_index,
                    date: &input.provenance.date,
                    preference,
                    events: event_count,
                    catalogue_key,
                    session_prepare_ms: session_prepare_ms.expect("owned preparation"),
                    iterations,
                    warmup,
                },
            )?);
            continue;
        }
        let execute = || -> Result<(Outcome, f64, f64), DeadlineError> {
            let mut request = DeadlineRequest::new(&q, start..end, deadline);
            request.transfers = transfers.as_ref();
            request.pruning = pruning;
            request.traversal = traversal_kind;
            request.frontier_storage = frontier_storage;
            request.witness_comparison = witness_comparison;
            request.lookup = DeadlineLookup::Lazy(lookup_mode);
            request.max_segments = states;
            request.max_frontier_width = width;
            request.max_stop_scans = scans;
            request.max_lookup_work = work;
            let began = Instant::now();
            let mut prepared = None;
            let mut observe = |phase| {
                if phase == DeadlinePhase::Prepared {
                    prepared = Some(began.elapsed());
                }
            };
            let (winners, profile, diagnostics, frontiers, selection) = if let Some(s) = &owner {
                let r = owned_outcome(
                    s,
                    preference,
                    suffix_pruning,
                    validation != "owned-session",
                    &mut observe,
                )?;
                (
                    r.winners,
                    r.profile,
                    r.diagnostics,
                    r.frontiers,
                    r.selection,
                )
            } else if kind == "profile" {
                let r = query_deadline_with_phases(
                    &reader,
                    &index,
                    events.as_ref().expect("checked catalogue"),
                    request,
                    &mut observe,
                )?;
                assert!(r.complete);
                (
                    DeadlinePortfolioWinners::from_m4_points(&r.points),
                    Some(r.points),
                    r.diagnostics,
                    r.frontiers,
                    DeadlinePortfolioDiagnostics::default(),
                )
            } else if let Some(preference) = preference {
                let r = query_deadline_preference_with_suffix_pruning(
                    &reader,
                    &index,
                    events.as_ref().expect("checked catalogue"),
                    request,
                    preference,
                    suffix_pruning,
                    &mut observe,
                )?;
                assert!(r.complete);
                assert_eq!(r.preference, preference);
                let mut winners = DeadlinePortfolioWinners::default();
                let slot = DeadlinePreference::ALL
                    .iter()
                    .position(|p| *p == preference)
                    .unwrap();
                winners.by_preference[slot] = r.winner;
                (winners, None, r.diagnostics, r.frontiers, r.selection)
            } else {
                let r = query_deadline_portfolio_with_suffix_pruning(
                    &reader,
                    &index,
                    events.as_ref().expect("checked catalogue"),
                    request,
                    suffix_pruning,
                    &mut observe,
                )?;
                assert!(r.complete);
                (r.winners, None, r.diagnostics, r.frontiers, r.selection)
            };
            let total = began.elapsed().as_secs_f64() * 1000.0;
            let prepare = prepared.expect("successful query prepared").as_secs_f64() * 1000.0;
            // JSON diagnostics/serialization are outside native query phases.
            Ok((
                Outcome {
                    winners,
                    profile,
                    diagnostics,
                    frontiers,
                    selection,
                },
                prepare,
                total - prepare,
            ))
        };
        let mut measured = (|| -> Result<Value, (String, String)> {
            let first_began = Instant::now();
            let (expected, _, _) = execute().map_err(|e| ("preflight".into(), format!("{e:?}")))?;
            let first_call_ms = first_began.elapsed().as_secs_f64() * 1000.0;
            for _ in 0..warmup {
                let (r, _, _) = execute().map_err(|e| ("warmup".into(), format!("{e:?}")))?;
                if r != expected {
                    return Err(("warmup".into(), "warmup result drift".into()));
                }
            }
            let (mut samples, mut prepares, mut searches) = (Vec::new(), Vec::new(), Vec::new());
            for _ in 0..iterations {
                let began = Instant::now();
                let (r, prepare, search) =
                    execute().map_err(|e| ("measurement".into(), format!("{e:?}")))?;
                samples.push(began.elapsed().as_secs_f64() * 1000.0);
                prepares.push(prepare);
                searches.push(search);
                if r != expected {
                    return Err(("measurement".into(), "timed result drift".into()));
                }
            }
            let mut row = json!({"tupleIndex":tuple_index,"date":input.provenance.date,"status":"completed",
                "events":event_count,"catalogueKey":catalogue_key,"eventBuildMs":session_prepare_ms.unwrap_or(event_ms),
                "rawSamplesMs":samples,"rawPrepareSamplesMs":prepares,"rawSearchSamplesMs":searches,
                "p50Ms":percentile(&samples,50),"p95Ms":percentile(&samples,95),
                "prepareP50Ms":percentile(&prepares,50),"prepareP95Ms":percentile(&prepares,95),
                "searchP50Ms":percentile(&searches,50),"searchP95Ms":percentile(&searches,95)});
            row.as_object_mut().expect("row").extend(
                outcome_fields(
                    &expected,
                    kind,
                    preference,
                    traversal_kind,
                    prefix_certificate == "timetable",
                )
                .as_object()
                .expect("outcome fields")
                .clone(),
            );
            if let Some(ms) = session_prepare_ms {
                row["sessionPreparationMs"] = json!(ms);
                row["firstCallMs"] = json!(first_call_ms);
                row["preparationPlusFirstCallMs"] = json!(ms + first_call_ms);
            }
            if prefix_setup == "prepared" {
                let p = expected.diagnostics.prefix;
                row["prefixSetup"] = json!({"enabled":p.enabled,"constructionAttempts":1,
                    "queryUses":1+warmup+iterations,"nominalStopWork":p.event_scans+p.walking_relaxations+p.timetable.work(),
                    "retainedIndexBytes":p.index_bytes});
            }
            Ok(row)
        })();
        if prefix_setup == "prepared" {
            // Retire this exact slot after all its measured uses. Keep the
            // catalogue's existing lifetime; report prefix/query retirement
            // separately and include it in the conservative first-request sum.
            let began = Instant::now();
            owner
                .as_mut()
                .expect("prefix cache owner")
                .invalidate_request();
            let retirement_ms = began.elapsed().as_secs_f64() * 1000.0;
            if let Ok(row) = &mut measured {
                row["prefixSetup"]["retirementMs"] = json!(retirement_ms);
                row["prefixSetup"]["preparationFirstCallAndRetirementMs"] = json!(
                    row["preparationPlusFirstCallMs"]
                        .as_f64()
                        .expect("first sum")
                        + retirement_ms
                );
            }
        }
        match measured {
            Ok(row)=>rows.push(row),
            Err((stage,error))=>rows.push(json!({"tupleIndex":tuple_index,"date":input.provenance.date,"status":"failed","stage":stage,"error":error})),
        }
    }
    let mut report = json!({"scope":"deadline-portfolio-native-experiment","contract":"lexicographic-filter-winners-v1-no-arrival-floor",
        "queryKind":kind,"objective":"m4","fullProfilePromotion":false,"browserOrPhoneQualification":false,"productPolicySelected":false,
        "status":if rows.iter().all(|r|r["status"]=="completed") {"completed"} else {"failed"},"patternMode":pattern,
        "engine":lookup,"traversal":traversal,"suffixBound":suffix,"prefixBound":"on","pointBound":"on","staticBound":"off","walkingBound":"off","forwardSeeds":"off",
        "witnessComparison":witness,"witnessDateMemoStackBytes":DeadlineWitnessComparison::date_memo_stack_bytes(),"frontierStorage":frontier,"pointerBytes":core::mem::size_of::<usize>(),
        "validationMode":validation,"ownerConstructorMs":owner_constructor_ms,
        "selectors":DeadlinePreference::ALL.into_iter().filter(|p|preference.is_none_or(|s|s==*p)).map(|p|p.name()).collect::<Vec<_>>(),
        "requestedWindow":[start,end],"arrivalDeadline":deadline,"maxRounds":rounds,"maxStates":states,"maxBagWidth":width,"maxStopScans":scans,"maxLookupWork":work,
        "iterations":iterations,"warmup":warmup,"ptbSha256":ptb_hash,"transfersSha256":walk_hash,
        "queryTuplesSha256":format!("{:x}",Sha256::digest(std::fs::read(tuples).map_err(|e|e.to_string())?)),
        "timingScope":"checked native setup/search/selection/internal scratch teardown; excludes city/catalogue build, output drop and JSON diagnostics/serialization",
        "queries":rows});
    if prefix_certificate == "timetable" {
        report["prefixCertificate"] = json!(prefix_certificate);
    }
    if prefix_setup == "prepared" {
        report["prefixSetup"] = json!("prepared-query");
        report["timingScope"] = json!("native setup/search/selection/query scratch teardown; retained prefix construction in sessionPreparationMs, retirement separate and in prefixSetup.preparationFirstCallAndRetirementMs; excludes owner construction/drop, output drop and JSON serialization");
    }
    if owner_lifecycle == "fresh" {
        report["ownerLifecycle"] = json!("fresh");
        report["timingScope"] = json!(lifecycle::TIMING_SCOPE);
    }
    if setup_profile == "phases" {
        report["setupProfile"] = json!("completion-markers-v1");
        report["latencyQualification"] = json!(false);
    }
    if owner_binding == "retained" {
        report["ownerBinding"] = json!("immutable-owner-v1");
        report["ownerStorageBytes"] = json!(DeadlineSession::owner_storage_bytes());
        report["bindingSlotBytes"] = json!(DeadlineSession::immutable_binding_slot_bytes());
        report["bindingStorageScope"] = json!("inline slot included in ownerStorageBytes for both ablations; populated digest bytes are not additional heap; hash construction is included in owner constructor time, retirement in owner drop");
    }
    if let Some(sweeps) = sweeps {
        report["ownerLifecycle"] = json!("requests");
        report["catalogueSetup"] = json!(catalogue_setup);
        report["requestOrder"] = json!(request_order);
        report["requestSweeps"] = sweeps;
        report["timingScope"] = json!(requests::TIMING_SCOPE);
    }
    if ceiling {
        report["scope"] = json!("deadline-winner-incumbent-ceiling-native-diagnostic");
        report["latencyQualification"] = json!(false);
        report["deployableOptimization"] = json!(false);
        report["workScope"] = json!("independent original caps per pass; source discovery and combined work reported separately; repeated-pass headroom assumes its own exact selected winners are supplied for free, not a deployable speedup");
        report["timingScope"] = json!("native diagnostic source and repeated pass setup/search/selection/internal teardown; repeated preparation includes seed extraction; owner/session preparation separate; no physical-device qualification");
    }
    if journey_audit == "on" {
        report["journeyAudit"] = json!("complete-selected-movement-v1");
        report["latencyQualification"] = json!(false);
        report["timingScope"] = json!("correctness only; independent search control plus aggregate-capped complete journey call; no query timing samples");
    }
    serde_json::to_string_pretty(&report).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packed_lookup_is_explicit_and_keeps_winners_and_failures() {
        for mode in ["off", "unbounded", "covering-merge"] {
            for kind in ["portfolio", "latest-departure"] {
                for lookup in ["lazy-cached", "lazy-cached-packed"] {
                    let common = [
                        "--query-kind",
                        kind,
                        "--pattern-mode",
                        mode,
                        "--validation",
                        "owned-session",
                        "--frontier-storage",
                        "event-indexed",
                        "--suffix-bound",
                        "row-prefix",
                        "--witness-comparison",
                        "materialized-date-memo",
                    ];
                    let baseline = fixture_run(&common);
                    let args: Vec<_> = common.into_iter().chain(["--lookup", lookup]).collect();
                    let candidate = fixture_run(&args);
                    assert_eq!(baseline["engine"], "lazy-cached");
                    assert_eq!(candidate["engine"], lookup);
                    for key in [
                        "winners",
                        "counters",
                        "frontiers",
                        "selection",
                        "suffixSelection",
                        "predecessorSelection",
                        "rowSelection",
                        "cutoffSelection",
                        "events",
                        "catalogueKey",
                        "incomingOrdering",
                    ] {
                        assert_eq!(
                            baseline["queries"][0][key], candidate["queries"][0][key],
                            "{kind}/{mode}/{key}"
                        );
                    }
                    assert_eq!(
                        candidate["queries"][0]["incomingOrdering"]["packedCalls"],
                        0
                    ); // Small fixture keeps reference path.
                    let capped: Vec<_> =
                        args.into_iter().chain(["--max-lookup-work", "1"]).collect();
                    let failed = fixture_run(&capped);
                    assert_eq!(failed["status"], "failed");
                    assert_eq!(
                        failed["queries"][0]["error"],
                        "Lookup(WorkExhausted { limit: 1, attempted: 2 })"
                    );
                    assert!(failed["queries"][0].get("incomingOrdering").is_none());
                }
            }
        }
    }

    #[test]
    fn invalid_options_fail_before_artifact_io() {
        for extra in [
            ["--query-kind", "top3"],
            ["--max-lookup-work", "0"],
            ["--iterations", "0"],
            ["--iterations", "1001"],
            ["--warmup", "1001"],
            ["--forward-seeds", "on"],
            ["--now", "0"],
            ["--objective", "r3"],
            ["--traversal", "unknown"],
            ["--suffix-bound", "unknown"],
            ["--frontier-storage", "unknown"],
            ["--validation", "unknown"],
            ["--witness-comparison", "streaming"],
            ["--lookup", "unknown"],
        ] {
            let args: Vec<_> = [
                "missing.ptb",
                "--query-tuples",
                "missing.json",
                "--window-start",
                "0",
                "--window-end",
                "1",
                "--arrival-deadline",
                "1",
            ]
            .into_iter()
            .chain(extra)
            .map(String::from)
            .collect();
            let error = run(&args).unwrap_err();
            assert!(!error.contains("No such file"), "{error}");
        }
        for bound in ["on", "before-pairs", "row-prefix", "row-ceiling"] {
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
                "--query-kind",
                "profile",
                "--suffix-bound",
                bound,
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
            assert!(run(&args).unwrap_err().contains("for a winner query"));
        }
    }
    pub(super) fn fixture_run(extra: &[&str]) -> Value {
        fixture_run_inner(extra, false)
    }
    fn fixture_run_inner(extra: &[&str], ceiling: bool) -> Value {
        fixture_with_walks(extra, ceiling, false)
    }
    fn fixture_with_walks(extra: &[&str], ceiling: bool, walking: bool) -> Value {
        fixture_with_tuples(extra, ceiling, walking, None)
    }
    pub(super) fn fixture_with_tuples(
        extra: &[&str],
        ceiling: bool,
        walking: bool,
        query_rows: Option<Value>,
    ) -> Value {
        use pt_core::engine::testkit::{
            bare_route, bare_stops, build_v2_ptb, utc_origins, ServicePoolSpec, StopRoutes, V1Feed,
            V1Trip, V2Feed,
        };
        use std::sync::atomic::{AtomicU64, Ordering};
        // SystemTime is not a uniqueness source for parallel tests: multiple
        // calls can observe the same clock tick within this process.
        static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "pt-core-portfolio-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        let stops = bare_stops(&["s0", "s1", "s2"]);
        let routes = [bare_route("r0"), bare_route("r1")];
        let trips = [
            V1Trip {
                id: "feeder",
                rows: &[(1, 0, 900), (2, 1, 1000)],
                ..V1Trip::default()
            },
            V1Trip {
                id: "trunk",
                route: 1,
                rows: &[(1, 1, 1200), (2, 2, 1300)],
                ..V1Trip::default()
            },
        ];
        let bytes = build_v2_ptb(&V2Feed {
            base: V1Feed {
                stops: &stops,
                routes: &routes,
                trips: &trips,
                stop_routes: StopRoutes::Served,
                feed_start_date: 20261001,
                city_tz_offset_seconds: 0,
                services: ServicePoolSpec {
                    window_days: 8,
                    pool: &[&[0xff]],
                    service_to_bitfield: &[0],
                },
                transfers: &[],
                boarding: &[],
                stop_index: false,
            },
            origins: &utc_origins(20261001, 8, 0),
            blocks: &[None, None],
            feed_rank: 0,
            derive_block_inseat: false,
            frequencies: &[],
            quarantined_frequency_trips: &[],
            strip_carry: true,
        });
        let bundle = dir.join("v2.ptb");
        let tuples = dir.join("tuples.json");
        let walks = dir.join("transfers.bin");
        if walking {
            std::fs::write(
                &walks,
                pt_core::engine::testkit::build_ptft(
                    &["s0", "s1", "s2"],
                    &[&[(1, 20)], &[(2, 60)], &[]],
                ),
            )
            .unwrap();
        }
        std::fs::write(&bundle, bytes).unwrap();
        let query_rows = query_rows.unwrap_or_else(|| json!([{"entryStops":[{"stopId":"s0","walkSecs":0}],"exitStops":[{"stopId":"s2","walkSecs":0}],"date":"20261004","departureSecs":900}]));
        std::fs::write(
            &tuples,
            serde_json::to_vec(&json!({"tuples":query_rows})).unwrap(),
        )
        .unwrap();
        let args: Vec<_> = [bundle.to_str().unwrap()]
            .into_iter()
            .chain(walking.then(|| walks.to_str().unwrap()))
            .chain([
                "--query-tuples",
                tuples.to_str().unwrap(),
                "--window-start",
                "900",
                "--window-end",
                "901",
                "--arrival-deadline",
                "1400",
            ])
            .chain(extra.iter().copied())
            .map(String::from)
            .collect();
        let result = if ceiling {
            run_winner_ceiling(&args)
        } else {
            run(&args)
        };
        std::fs::remove_dir_all(&dir).unwrap();
        serde_json::from_str(&result.unwrap()).unwrap()
    }

    fn check_lifecycle_phases(p: &Value, cached: bool) {
        assert_eq!(p.as_object().unwrap().len(), 15);
        for key in [
            "inputCopyMs",
            "constructorMs",
            "sessionPreparationMs",
            "firstCallMs",
            "queryPrepareMs",
            "querySearchMs",
            "ownerDropMs",
            "ownerLifetimeMs",
            "outputDropMs",
            "totalMs",
        ] {
            let n = p[key].as_f64().unwrap();
            assert!(n.is_finite() && n >= 0.0, "{key}");
        }
        let n = |key: &str| p[key].as_f64().unwrap();
        assert!(n("ownerLifetimeMs") > 0.0);
        assert!((n("firstCallMs") - n("queryPrepareMs") - n("querySearchMs")).abs() < 1e-8);
        let phase_sum = [
            "inputCopyMs",
            "constructorMs",
            "sessionPreparationMs",
            "firstCallMs",
            "ownerDropMs",
        ]
        .into_iter()
        .map(n)
        .sum::<f64>();
        assert!(phase_sum <= n("ownerLifetimeMs") + 1e-8);
        assert!((n("totalMs") - n("ownerLifetimeMs") - n("outputDropMs")).abs() < 1e-8);
        assert!(p["copiedInputBytes"].as_u64().unwrap() > 0);
        assert_eq!(p["ownerConstructions"], 1);
        assert_eq!(p["catalogueConstructions"], 1);
        assert_eq!(p["queryUses"], 1);
        assert_eq!(p["cachedPrefixConstructions"], usize::from(cached));
    }

    #[test]
    fn fresh_owner_lifecycle_preserves_all_winners_work_and_actual_first_use_phases() {
        for mode in ["off", "unbounded", "covering-merge"] {
            for date in ["materialized", "materialized-date-memo"] {
                for kind in ["portfolio"]
                    .into_iter()
                    .chain(DeadlinePreference::ALL.map(|p| p.name()))
                {
                    for (certificate, setup) in [
                        ("duration", "rebuild"),
                        ("timetable", "rebuild"),
                        ("timetable", "prepared"),
                    ] {
                        let mut args = vec![
                            "--query-kind",
                            kind,
                            "--pattern-mode",
                            mode,
                            "--witness-comparison",
                            date,
                            "--prefix-certificate",
                            certificate,
                            "--prefix-setup",
                            setup,
                            "--validation",
                            "owned-session",
                            "--frontier-storage",
                            "event-indexed",
                            "--suffix-bound",
                            "row-prefix",
                            "--iterations",
                            "2",
                            "--warmup",
                            "1",
                        ];
                        let normal = fixture_run(&args);
                        assert!(normal.get("ownerLifecycle").is_none());
                        args.extend(["--owner-lifecycle", "fresh"]);
                        let fresh = fixture_run(&args);
                        assert_eq!(fresh["ownerLifecycle"], "fresh");
                        assert!(fresh["ownerConstructorMs"].is_null());
                        assert_eq!(fresh["timingScope"], lifecycle::TIMING_SCOPE);
                        let a = &normal["queries"][0];
                        let b = &fresh["queries"][0];
                        assert_eq!(b["status"], "completed");
                        for key in [
                            "tupleIndex",
                            "date",
                            "completionScope",
                            "winners",
                            "counters",
                            "frontiers",
                            "selection",
                            "suffixSelection",
                            "predecessorSelection",
                            "rowSelection",
                            "cutoffSelection",
                            "incomingOrdering",
                            "events",
                            "catalogueKey",
                        ] {
                            assert_eq!(a[key], b[key], "{key}");
                        }
                        assert_eq!(a.get("timetablePrefix"), b.get("timetablePrefix"));
                        check_lifecycle_phases(&b["firstLifecycle"], setup == "prepared");
                        assert_eq!(b["warmupLifecycles"].as_array().unwrap().len(), 1);
                        check_lifecycle_phases(&b["warmupLifecycles"][0], setup == "prepared");
                        let samples = b["rawLifecycleSamples"].as_array().unwrap();
                        assert_eq!(samples.len(), 2);
                        for (i, p) in samples.iter().enumerate() {
                            check_lifecycle_phases(p, setup == "prepared");
                            assert_eq!(p["totalMs"], b["rawSamplesMs"][i]);
                        }
                        assert!(b.get("firstCallMs").is_none());
                        assert!(b.get("prefixSetup").is_none());
                        for cap in ["--max-stop-scans", "--max-lookup-work", "--max-states"] {
                            let mut capped = args.clone();
                            capped.extend([cap, "1"]);
                            let failed = fixture_run(&capped);
                            capped.extend(["--owner-lifecycle", "shared"]);
                            let baseline = fixture_run(&capped);
                            assert_eq!(failed["queries"][0], baseline["queries"][0]);
                            assert_eq!(failed["queries"][0].as_object().unwrap().len(), 5);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn fresh_owner_lifecycle_copies_walking_inputs_and_keeps_no_hit_complete() {
        let args = [
            "--owner-lifecycle",
            "fresh",
            "--validation",
            "owned-session",
            "--prefix-certificate",
            "timetable",
            "--prefix-setup",
            "prepared",
            "--suffix-bound",
            "row-prefix",
            "--frontier-storage",
            "event-indexed",
        ];
        let plain = fixture_run(&args);
        let walks = fixture_with_walks(&args, false, true);
        let p = &plain["queries"][0]["firstLifecycle"];
        let w = &walks["queries"][0]["firstLifecycle"];
        assert!(w["copiedInputBytes"].as_u64().unwrap() > p["copiedInputBytes"].as_u64().unwrap());
        check_lifecycle_phases(w, true);
        assert!(walks["transfersSha256"].is_string());
        let no_hit = fixture_run(
            &args
                .into_iter()
                .chain(["--arrival-deadline", "901"])
                .collect::<Vec<_>>(),
        );
        assert_eq!(no_hit["queries"][0]["status"], "completed");
        assert!(no_hit["queries"][0]["winners"]
            .as_object()
            .unwrap()
            .values()
            .all(Value::is_null));
        check_lifecycle_phases(&no_hit["queries"][0]["firstLifecycle"], true);
    }

    #[test]
    fn fresh_owner_lifecycle_rejects_unsupported_modes_before_input_io() {
        let common = [
            "missing.ptb",
            "--query-tuples",
            "missing.json",
            "--window-start",
            "0",
            "--window-end",
            "1",
            "--arrival-deadline",
            "1",
            "--validation",
            "owned-session",
            "--owner-lifecycle",
            "fresh",
        ];
        for extra in [
            ["--owner-lifecycle", "other"],
            ["--validation", "checked"],
            ["--validation", "owned-checked"],
            ["--query-kind", "profile"],
        ] {
            let args = common
                .into_iter()
                .chain(extra)
                .map(String::from)
                .collect::<Vec<_>>();
            let error = run(&args).unwrap_err();
            assert!(
                error.contains("owner-lifecycle") || error.contains("validation must"),
                "{error}"
            );
        }
        let error = run_winner_ceiling(&common.into_iter().map(String::from).collect::<Vec<_>>())
            .unwrap_err();
        assert!(error.contains("owner-lifecycle"), "{error}");
    }

    #[test]
    fn winner_ceiling_keeps_actual_source_winners_work_and_separate_pass_costs() {
        for mode in ["off", "unbounded", "covering-merge"] {
            for witness in ["materialized", "materialized-date-memo"] {
                for kind in [
                    "portfolio",
                    "latest-departure",
                    "fastest",
                    "least-walking",
                    "fewest-transfers",
                ] {
                    let common = [
                        "--query-kind",
                        kind,
                        "--pattern-mode",
                        mode,
                        "--witness-comparison",
                        witness,
                        "--validation",
                        "owned-session",
                        "--suffix-bound",
                        "row-prefix",
                        "--frontier-storage",
                        "event-indexed",
                        "--iterations",
                        "2",
                        "--warmup",
                        "1",
                    ];
                    let ordinary = fixture_run(&common);
                    let r = fixture_run_inner(&common, true);
                    let q = &r["queries"][0];
                    assert_eq!(
                        r["scope"],
                        "deadline-winner-incumbent-ceiling-native-diagnostic"
                    );
                    assert_eq!(r["latencyQualification"], false);
                    assert_eq!(r["deployableOptimization"], false);
                    assert_eq!(q["status"], "completed");
                    assert_eq!(q["ceilingAvailable"], true);
                    assert_eq!(q["initialPoints"], 1);
                    for k in [
                        "winners",
                        "counters",
                        "frontiers",
                        "selection",
                        "suffixSelection",
                        "predecessorSelection",
                        "rowSelection",
                        "cutoffSelection",
                        "incomingOrdering",
                    ] {
                        assert_eq!(
                            q["baseline"][k], ordinary["queries"][0][k],
                            "{kind}/{mode}/{witness}/{k}"
                        );
                    }
                    assert_eq!(q["baseline"]["winners"], q["ceiling"]["winners"]);
                    for k in ["catalogueKey", "events", "completionScope"] {
                        assert_eq!(q[k], ordinary["queries"][0][k]);
                    }
                    assert_eq!(
                        q["combinedLookupWork"].as_u64().unwrap(),
                        q["baseline"]["counters"]["lookupWork"].as_u64().unwrap()
                            + q["ceiling"]["counters"]["lookupWork"].as_u64().unwrap()
                    );
                    assert_eq!(
                        q["combinedStopWork"].as_u64().unwrap(),
                        q["baseline"]["counters"]["stopWork"].as_u64().unwrap()
                            + q["ceiling"]["counters"]["stopWork"].as_u64().unwrap()
                    );
                    assert_eq!(
                        q["combinedSegments"].as_u64().unwrap(),
                        q["baseline"]["counters"]["segments"].as_u64().unwrap()
                            + q["ceiling"]["counters"]["segments"].as_u64().unwrap()
                    );
                    let sums: Vec<_> = q["rawPairSamplesMs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_f64().unwrap())
                        .collect();
                    assert_eq!(sums.len(), 2);
                    for pass in ["baseline", "ceiling"] {
                        let p = &q[pass];
                        for k in ["rawSamplesMs", "rawPrepareSamplesMs", "rawSearchSamplesMs"] {
                            assert_eq!(p[k].as_array().unwrap().len(), 2);
                        }
                        assert!(p["p95Ms"].as_f64().unwrap() >= p["p50Ms"].as_f64().unwrap());
                    }
                    for (i, pair) in sums.into_iter().enumerate() {
                        assert!(
                            pair >= q["baseline"]["rawSamplesMs"][i].as_f64().unwrap()
                                + q["ceiling"]["rawSamplesMs"][i].as_f64().unwrap()
                        );
                    }
                    assert!(q["sessionPreparationMs"].as_f64().unwrap() > 0.0);
                }
            }
        }
    }

    #[test]
    fn winner_ceiling_keeps_unavailable_limits_without_partial_answers_or_timings() {
        for kind in ["portfolio", "latest-departure"] {
            let r = fixture_run_inner(&["--query-kind", kind, "--max-lookup-work", "1"], true);
            let q = &r["queries"][0];
            assert_eq!(r["status"], "failed");
            assert_eq!(q["status"], "failed");
            assert_eq!(q["stage"], "baseline");
            assert_eq!(q["ceilingAvailable"], false);
            assert_eq!(
                q["error"],
                "Lookup(WorkExhausted { limit: 1, attempted: 2 })"
            );
            let mut keys: Vec<_> = q.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(
                keys,
                [
                    "ceilingAvailable",
                    "date",
                    "error",
                    "stage",
                    "status",
                    "tupleIndex"
                ]
            );
            let empty = fixture_run_inner(&["--query-kind", kind, "--max-rounds", "1"], true);
            let q = &empty["queries"][0];
            assert_eq!(q["status"], "completed");
            assert_eq!(q["initialPoints"], 0);
            assert!(q["baseline"]["winners"]
                .as_object()
                .unwrap()
                .values()
                .all(Value::is_null));
            assert_eq!(q["baseline"]["winners"], q["ceiling"]["winners"]);
            assert_eq!(q["baseline"]["counters"], q["ceiling"]["counters"]);
        }
    }

    #[test]
    fn winner_ceiling_rejects_scope_changes_and_public_seed_input_before_io() {
        for extra in [
            ["--query-kind", "profile"],
            ["--validation", "checked"],
            ["--suffix-bound", "off"],
            ["--frontier-storage", "tree"],
            ["--traversal", "departure-first"],
            ["--lookup", "lazy-cached-packed"],
            ["--initial-points", "points.json"],
            ["--now", "1"],
        ] {
            let args: Vec<_> = [
                "missing.ptb",
                "--query-tuples",
                "missing.json",
                "--window-start",
                "0",
                "--window-end",
                "1",
                "--arrival-deadline",
                "1",
            ]
            .into_iter()
            .chain(extra)
            .map(String::from)
            .collect();
            let error = run_winner_ceiling(&args).unwrap_err();
            assert!(!error.contains("No such file"), "{error}");
        }
    }
    #[test]
    fn matched_modes_keep_full_witnesses_and_distinct_completion_scopes() {
        for mode in ["off", "unbounded", "covering-merge"] {
            let mut expected = None;
            for kind in ["profile", "portfolio"] {
                let r = fixture_run(&[
                    "--query-kind",
                    kind,
                    "--pattern-mode",
                    mode,
                    "--iterations",
                    "2",
                    "--warmup",
                    "1",
                ]);
                assert_eq!(r["status"], "completed");
                assert_eq!(r["fullProfilePromotion"], false);
                let q = &r["queries"][0];
                assert_eq!(
                    q["completionScope"],
                    if kind == "profile" {
                        "full-m4-and-selectors"
                    } else {
                        "fixed-selectors-only"
                    }
                );
                assert_eq!(q.get("profilePoints").is_some(), kind == "profile");
                assert_eq!(q["rawSamplesMs"].as_array().unwrap().len(), 2);
                assert!(q["p95Ms"].as_f64().unwrap() >= q["p50Ms"].as_f64().unwrap());
                assert!(q["counters"]["lookupWork"].as_u64().unwrap() <= 10_000_000);
                for name in DeadlinePreference::ALL.map(|s| s.name()) {
                    assert_eq!(q["winners"][name]["witnessLegs"], 2);
                    assert_eq!(q["winners"][name]["actualTransfers"], 1);
                }
                if let Some(w) = &expected {
                    assert_eq!(&q["winners"], w);
                } else {
                    expected = Some(q["winners"].clone());
                }
            }
        }
    }
    #[test]
    fn date_memo_keeps_exact_winners_work_and_fixed_scratch_in_all_owner_modes() {
        for validation in ["checked", "owned-checked", "owned-session"] {
            for kind in ["portfolio", "latest-departure"] {
                let base = fixture_run(&["--query-kind", kind, "--validation", validation]);
                let memo = fixture_run(&[
                    "--query-kind",
                    kind,
                    "--validation",
                    validation,
                    "--witness-comparison",
                    "materialized-date-memo",
                ]);
                assert_eq!(base["witnessComparison"], "materialized");
                assert_eq!(memo["witnessComparison"], "materialized-date-memo");
                assert_eq!(base["witnessDateMemoStackBytes"], 64);
                assert_eq!(memo["witnessDateMemoStackBytes"], 64);
                for key in [
                    "winners",
                    "counters",
                    "frontiers",
                    "selection",
                    "suffixSelection",
                    "predecessorSelection",
                    "rowSelection",
                    "cutoffSelection",
                    "events",
                    "catalogueKey",
                    "completionScope",
                ] {
                    assert_eq!(base["queries"][0][key], memo["queries"][0][key], "{key}");
                }
            }
        }
    }
    #[test]
    fn failed_query_retains_its_typed_limit_without_partial_results_or_timings() {
        for traversal in [
            "arrival-first",
            "departure-first",
            "departure-warmup64",
            "origin-prefix-warmup",
        ] {
            for kind in ["profile", "portfolio"]
                .into_iter()
                .chain(DeadlinePreference::ALL.map(|p| p.name()))
            {
                let r = fixture_run(&[
                    "--query-kind",
                    kind,
                    "--max-lookup-work",
                    "1",
                    "--traversal",
                    traversal,
                ]);
                assert_eq!(r["status"], "failed");
                let q = &r["queries"][0];
                assert_eq!(q["stage"], "preflight");
                assert_eq!(
                    q["error"],
                    "Lookup(WorkExhausted { limit: 1, attempted: 2 })"
                );
                for key in [
                    "winners",
                    "profilePoints",
                    "counters",
                    "selection",
                    "rawSamplesMs",
                    "p95Ms",
                    "completionScope",
                    "discoveryWarmup",
                    "originHint",
                ] {
                    assert!(q.get(key).is_none());
                }
            }
        }
    }

    #[test]
    fn timetable_certificate_is_explicit_charged_and_never_leaks_failed_partials() {
        for mode in ["off", "unbounded", "covering-merge"] {
            for kind in ["portfolio"]
                .into_iter()
                .chain(DeadlinePreference::ALL.map(|p| p.name()))
            {
                let common = [
                    "--query-kind",
                    kind,
                    "--pattern-mode",
                    mode,
                    "--suffix-bound",
                    "row-prefix",
                    "--validation",
                    "owned-session",
                    "--frontier-storage",
                    "event-indexed",
                ];
                let base = fixture_run(&common);
                assert!(base.get("prefixCertificate").is_none());
                assert!(base["queries"][0].get("timetablePrefix").is_none());
                let mut args = common.to_vec();
                args.extend([
                    "--prefix-certificate",
                    "timetable",
                    "--iterations",
                    "2",
                    "--warmup",
                    "1",
                ]);
                let r = fixture_run(&args);
                assert_eq!(r["prefixCertificate"], "timetable");
                assert_eq!(r["status"], "completed");
                let row = &r["queries"][0];
                assert_eq!(row["winners"], base["queries"][0]["winners"]);
                let p = &row["timetablePrefix"];
                assert_eq!(p["enabled"], true);
                assert!(p["indexBytes"].as_u64().unwrap() > 0);
                let work = p["eventScans"].as_u64().unwrap()
                    + p["walkingProposals"].as_u64().unwrap()
                    + p["profileChecks"].as_u64().unwrap();
                assert_eq!(p["work"], work);
                let c = &row["counters"];
                assert_eq!(
                    c["stopWork"].as_u64().unwrap(),
                    c["seedEventChecks"].as_u64().unwrap()
                        + c["stopEventsScanned"].as_u64().unwrap()
                        + c["prefixEventScans"].as_u64().unwrap()
                        + c["prefixWalkingRelaxations"].as_u64().unwrap()
                        + work
                );
                let cap = (c["stopWork"].as_u64().unwrap() - 1).to_string();
                args.extend(["--max-stop-scans", &cap]);
                let failed = fixture_run(&args);
                let row = &failed["queries"][0];
                assert_eq!(row["status"], "failed");
                assert!(row["error"]
                    .as_str()
                    .unwrap()
                    .contains("StopScansExhausted"));
                assert_eq!(row.as_object().unwrap().len(), 5);
            }
        }
    }

    #[test]
    fn prepared_prefix_reuse_is_explicit_preserves_work_and_includes_retirement() {
        for mode in ["off", "unbounded", "covering-merge"] {
            for kind in ["portfolio"]
                .into_iter()
                .chain(DeadlinePreference::ALL.map(|p| p.name()))
            {
                for date in ["materialized", "materialized-date-memo"] {
                    let mut args = vec![
                        "--query-kind",
                        kind,
                        "--pattern-mode",
                        mode,
                        "--suffix-bound",
                        "row-prefix",
                        "--validation",
                        "owned-session",
                        "--frontier-storage",
                        "event-indexed",
                        "--witness-comparison",
                        date,
                        "--prefix-certificate",
                        "timetable",
                        "--iterations",
                        "2",
                        "--warmup",
                        "1",
                    ];
                    let baseline = fixture_run(&args);
                    assert!(baseline.get("prefixSetup").is_none());
                    assert!(baseline["queries"][0].get("prefixSetup").is_none());
                    args.extend(["--prefix-setup", "prepared"]);
                    let candidate = fixture_run(&args);
                    assert_eq!(candidate["prefixSetup"], "prepared-query");
                    let b = &baseline["queries"][0];
                    let q = &candidate["queries"][0];
                    assert_eq!(q["status"], "completed");
                    for key in [
                        "winners",
                        "counters",
                        "frontiers",
                        "selection",
                        "suffixSelection",
                        "predecessorSelection",
                        "rowSelection",
                        "cutoffSelection",
                        "incomingOrdering",
                        "catalogueKey",
                        "timetablePrefix",
                    ] {
                        assert_eq!(q[key], b[key]);
                    }
                    let p = &q["prefixSetup"];
                    assert_eq!(p["enabled"], true);
                    assert_eq!(p["constructionAttempts"], 1);
                    assert_eq!(p["queryUses"], 4);
                    let work = q["counters"]["prefixEventScans"].as_u64().unwrap()
                        + q["counters"]["prefixWalkingRelaxations"].as_u64().unwrap()
                        + q["timetablePrefix"]["work"].as_u64().unwrap();
                    assert_eq!(p["nominalStopWork"], work);
                    assert!(
                        p["retainedIndexBytes"].as_u64().unwrap()
                            >= q["timetablePrefix"]["indexBytes"].as_u64().unwrap()
                    );
                    let retirement = p["retirementMs"].as_f64().unwrap();
                    assert!(retirement.is_finite() && retirement >= 0.0);
                    assert!(
                        (p["preparationFirstCallAndRetirementMs"].as_f64().unwrap()
                            - q["preparationPlusFirstCallMs"].as_f64().unwrap()
                            - retirement)
                            .abs()
                            < 1e-8
                    );
                    for cap in ["--max-stop-scans", "--max-lookup-work"] {
                        let mut capped = args.clone();
                        capped.extend([cap, "1"]);
                        let failed = fixture_run(&capped);
                        let mut normal = capped.clone();
                        let flag = normal.iter().position(|s| *s == "--prefix-setup").unwrap();
                        normal[flag + 1] = "rebuild";
                        let reference = fixture_run(&normal);
                        assert_eq!(failed["queries"][0], reference["queries"][0]);
                        assert_eq!(failed["queries"][0].as_object().unwrap().len(), 5);
                    }
                }
            }
        }
        for (key, value) in [
            ("--prefix-setup", "other"),
            ("--validation", "checked"),
            ("--prefix-certificate", "duration"),
            ("--query-kind", "profile"),
        ] {
            let mut args = vec![
                "missing.ptb",
                "--query-tuples",
                "missing.json",
                "--window-start",
                "0",
                "--window-end",
                "1",
                "--arrival-deadline",
                "1",
                "--prefix-certificate",
                "timetable",
                "--validation",
                "owned-session",
                "--prefix-setup",
                "prepared",
            ];
            args.extend([key, value]);
            let error = run(&args.into_iter().map(String::from).collect::<Vec<_>>()).unwrap_err();
            assert!(
                error.contains("prefix-setup") || error.contains("validation must"),
                "{error}"
            );
        }
    }

    #[test]
    fn each_single_preference_reports_only_its_own_canonical_winner() {
        for mode in ["off", "unbounded", "covering-merge"] {
            let profile = fixture_run(&["--query-kind", "profile", "--pattern-mode", mode]);
            for preference in DeadlinePreference::ALL {
                for traversal in [
                    "arrival-first",
                    "departure-first",
                    "departure-warmup64",
                    "origin-prefix-warmup",
                ] {
                    let r = fixture_run(&[
                        "--query-kind",
                        preference.name(),
                        "--pattern-mode",
                        mode,
                        "--iterations",
                        "2",
                        "--warmup",
                        "1",
                        "--traversal",
                        traversal,
                    ]);
                    assert_eq!(r["status"], "completed");
                    assert_eq!(r["selectors"], json!([preference.name()]));
                    let q = &r["queries"][0];
                    assert_eq!(q["completionScope"], "single-selector-only");
                    assert!(q.get("profilePoints").is_none());
                    assert_eq!(q["winners"].as_object().unwrap().len(), 1);
                    assert_eq!(
                        q["winners"][preference.name()],
                        profile["queries"][0]["winners"][preference.name()]
                    );
                    assert_eq!(q["rawSamplesMs"].as_array().unwrap().len(), 2);
                    assert_eq!(r["traversal"], traversal);
                    if traversal == "departure-warmup64" {
                        assert_eq!(
                            q["discoveryWarmup"]["preferredScans"],
                            q["counters"]["segmentsScanned"].as_u64().unwrap().min(64)
                        );
                        assert_eq!(
                            q["discoveryWarmup"]["restored"],
                            q["counters"]["segmentsScanned"].as_u64().unwrap() >= 64
                        );
                    } else if traversal == "origin-prefix-warmup" {
                        assert!(q["originHint"]["enabled"].as_bool().unwrap());
                        assert!(q["originHint"]["checks"].as_u64().unwrap() > 0);
                        assert_eq!(q["originHint"]["indexBytes"], q["events"]);
                        assert!(q["discoveryWarmup"]["preferredScans"].as_u64().unwrap() <= 64);
                    } else {
                        assert!(q.get("discoveryWarmup").is_none());
                    }
                }
            }
        }
    }

    #[test]
    fn winner_frontier_composition_preserves_work_and_typed_limits() {
        for mode in ["off", "unbounded", "covering-merge"] {
            for kind in ["portfolio"]
                .into_iter()
                .chain(DeadlinePreference::ALL.map(|p| p.name()))
            {
                let tree = fixture_run(&[
                    "--query-kind",
                    kind,
                    "--pattern-mode",
                    mode,
                    "--suffix-bound",
                    "row-prefix",
                ]);
                let indexed = fixture_run(&[
                    "--query-kind",
                    kind,
                    "--pattern-mode",
                    mode,
                    "--suffix-bound",
                    "row-prefix",
                    "--frontier-storage",
                    "event-indexed",
                    "--iterations",
                    "2",
                    "--warmup",
                    "1",
                ]);
                assert_eq!(tree["frontierStorage"], "tree");
                assert_eq!(indexed["frontierStorage"], "event-indexed");
                assert_eq!(indexed["status"], "completed");
                let a = &tree["queries"][0];
                let b = &indexed["queries"][0];
                for key in [
                    "winners",
                    "counters",
                    "selection",
                    "suffixSelection",
                    "predecessorSelection",
                    "rowSelection",
                    "cutoffSelection",
                    "events",
                    "catalogueKey",
                    "completionScope",
                ] {
                    assert_eq!(a[key], b[key], "{kind}/{mode}/{key}");
                }
                let x = &a["frontiers"];
                let y = &b["frontiers"];
                for key in ["records", "retainedIds", "idCapacityBytes"] {
                    assert_eq!(x[key], y[key]);
                }
                assert_eq!(x["recordCapacityBytes"], Value::Null);
                assert_eq!(y["directoryEntries"], b["events"]);
                let pointer = core::mem::size_of::<usize>() as u64;
                assert_eq!(
                    y["directoryCapacityBytes"].as_u64().unwrap(),
                    b["events"].as_u64().unwrap() * pointer
                );
                assert!(
                    y["recordCapacityBytes"].as_u64().unwrap()
                        >= y["records"].as_u64().unwrap() * 3 * pointer
                );
                for validation in ["owned-checked", "owned-session"] {
                    let owned = fixture_run(&[
                        "--query-kind",
                        kind,
                        "--pattern-mode",
                        mode,
                        "--suffix-bound",
                        "row-prefix",
                        "--frontier-storage",
                        "event-indexed",
                        "--validation",
                        validation,
                        "--iterations",
                        "2",
                        "--warmup",
                        "1",
                    ]);
                    assert_eq!(owned["validationMode"], validation);
                    assert!(owned["ownerConstructorMs"].as_f64().unwrap() > 0.0);
                    let q = &owned["queries"][0];
                    for field in [
                        "winners",
                        "counters",
                        "frontiers",
                        "selection",
                        "suffixSelection",
                        "predecessorSelection",
                        "rowSelection",
                        "cutoffSelection",
                        "events",
                        "catalogueKey",
                    ] {
                        assert_eq!(q[field], b[field]);
                    }
                    assert_eq!(q["eventBuildMs"], q["sessionPreparationMs"]);
                    let prep = q["sessionPreparationMs"].as_f64().unwrap();
                    let first = q["firstCallMs"].as_f64().unwrap();
                    assert!(prep > 0.0 && first > 0.0);
                    let combined = q["preparationPlusFirstCallMs"].as_f64().unwrap();
                    assert!((combined - prep - first).abs() <= 1e-9 * combined.max(1.0));
                    let capped = fixture_run(&[
                        "--query-kind",
                        kind,
                        "--validation",
                        validation,
                        "--suffix-bound",
                        "row-prefix",
                        "--max-lookup-work",
                        "1",
                    ]);
                    assert_eq!(capped["status"], "failed");
                    assert_eq!(capped["queries"][0].as_object().unwrap().len(), 5);
                }
                for cap in ["--max-states", "--max-stop-scans", "--max-lookup-work"] {
                    let capped_tree = fixture_run(&[
                        "--query-kind",
                        kind,
                        "--pattern-mode",
                        mode,
                        "--suffix-bound",
                        "row-prefix",
                        cap,
                        "1",
                    ]);
                    let capped_indexed = fixture_run(&[
                        "--query-kind",
                        kind,
                        "--pattern-mode",
                        mode,
                        "--suffix-bound",
                        "row-prefix",
                        "--frontier-storage",
                        "event-indexed",
                        cap,
                        "1",
                    ]);
                    assert_eq!(capped_tree["queries"], capped_indexed["queries"]);
                    assert_eq!(capped_indexed["status"], "failed");
                    assert_eq!(capped_indexed["queries"][0].as_object().unwrap().len(), 5);
                }
            }
        }
    }

    #[test]
    fn suffix_bound_is_explicit_and_not_a_full_profile_claim() {
        for kind in ["portfolio"]
            .into_iter()
            .chain(DeadlinePreference::ALL.map(|p| p.name()))
        {
            let off = fixture_run(&["--query-kind", kind]);
            let on = fixture_run(&["--query-kind", kind, "--suffix-bound", "on"]);
            assert_eq!(off["suffixBound"], "off");
            assert_eq!(on["suffixBound"], "on");
            let early = fixture_run(&["--query-kind", kind, "--suffix-bound", "before-pairs"]);
            assert_eq!(early["suffixBound"], "before-pairs");
            assert_eq!(early["queries"][0]["winners"], on["queries"][0]["winners"]);
            let row = fixture_run(&["--query-kind", kind, "--suffix-bound", "row-prefix"]);
            assert_eq!(row["suffixBound"], "row-prefix");
            assert_eq!(row["queries"][0]["winners"], on["queries"][0]["winners"]);
            let compiled = fixture_run(&["--query-kind", kind, "--suffix-bound", "row-ceiling"]);
            assert_eq!(compiled["suffixBound"], "row-ceiling");
            for field in ["winners", "selection", "suffixSelection", "frontiers"] {
                assert_eq!(compiled["queries"][0][field], row["queries"][0][field]);
            }
            assert_eq!(
                row["queries"][0]["cutoffSelection"],
                json!({"builds":0,"selectorsEvaluated":0,"disabled":0})
            );
            let compiled_capped = fixture_run(&[
                "--query-kind",
                kind,
                "--suffix-bound",
                "row-ceiling",
                "--max-lookup-work",
                "1",
            ]);
            assert_eq!(compiled_capped["queries"][0]["status"], "failed");
            for field in [
                "winners",
                "cutoffSelection",
                "rowSelection",
                "counters",
                "rawSamplesMs",
            ] {
                assert!(compiled_capped["queries"][0].get(field).is_none());
            }
            assert_eq!(
                on["queries"][0]["rowSelection"],
                json!({"boundChecks":0,"skippedRows":0})
            );
            assert_eq!(
                row["queries"][0]["predecessorSelection"],
                json!({"boundChecks":0,"prunedPairs":0})
            );
            let row_capped = fixture_run(&[
                "--query-kind",
                kind,
                "--suffix-bound",
                "row-prefix",
                "--max-lookup-work",
                "1",
            ]);
            assert_eq!(row_capped["queries"][0]["status"], "failed");
            for field in ["winners", "rowSelection", "counters", "rawSamplesMs"] {
                assert!(row_capped["queries"][0].get(field).is_none());
            }
            let capped = fixture_run(&[
                "--query-kind",
                kind,
                "--suffix-bound",
                "before-pairs",
                "--max-lookup-work",
                "1",
            ]);
            assert_eq!(capped["queries"][0]["status"], "failed");
            assert!(capped["queries"][0].get("winners").is_none());
            assert!(capped["queries"][0].get("predecessorSelection").is_none());
            assert!(capped["queries"][0].get("rawSamplesMs").is_none());
            assert!(
                early["queries"][0]["predecessorSelection"]["boundChecks"]
                    .as_u64()
                    .unwrap()
                    > 0
            );
            assert_eq!(off["queries"][0]["winners"], on["queries"][0]["winners"]);
            assert_eq!(off["queries"][0]["suffixSelection"]["boundChecks"], 0);
            assert!(
                on["queries"][0]["suffixSelection"]["boundChecks"]
                    .as_u64()
                    .unwrap()
                    > 0
            );
        }
    }
}
