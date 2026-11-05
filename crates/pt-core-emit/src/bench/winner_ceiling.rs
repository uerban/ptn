//! Native-only current-winner perfect-incumbent diagnostic. No caller seeds.
use super::{
    incumbent_ceiling::counters,
    portfolio::{percentile, winners},
};
use pt_core::engine::temporal_probe::trip_based::*;
use serde_json::{json, Value};
use std::time::Instant;

pub(super) struct Context<'a> {
    pub tuple_index: usize,
    pub date: &'a str,
    pub preference: Option<DeadlinePreference>,
    pub events: usize,
    pub catalogue_key: [u8; 32],
    pub session_prepare_ms: f64,
    pub iterations: usize,
    pub warmup: usize,
}

pub(super) fn row(session: &DeadlineSession, c: Context<'_>) -> Result<Value, String> {
    let execute = || {
        let began = Instant::now();
        let mut phases = Vec::new();
        let pair = session.run_winner_incumbent_ceiling_with_phases(
            c.preference,
            DeadlineSuffixPruning::RowPrefix,
            |p| phases.push((p, began.elapsed().as_secs_f64() * 1000.0)),
        )?;
        let total = began.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(
            phases.iter().map(|(p, _)| *p).collect::<Vec<_>>(),
            [
                DeadlineWinnerCeilingPhase::Baseline(DeadlinePhase::Prepared),
                DeadlineWinnerCeilingPhase::Baseline(DeadlinePhase::SearchFinished),
                DeadlineWinnerCeilingPhase::Ceiling(DeadlinePhase::Prepared),
                DeadlineWinnerCeilingPhase::Ceiling(DeadlinePhase::SearchFinished),
            ]
        );
        // source prepare/search, repeated prepare/search, whole pair. Seed
        // extraction is after source finished and before repeated Prepared.
        let times = [
            phases[0].1,
            phases[1].1 - phases[0].1,
            phases[2].1 - phases[1].1,
            phases[3].1 - phases[2].1,
            total,
        ];
        Ok::<_, DeadlineIncumbentCeilingError>((pair, times))
    };
    let measured = (|| {
        let (expected, first) = execute().map_err(failure)?;
        if expected.baseline.winners != expected.ceiling.winners {
            return Err(("canonical", false, "ceiling full canonical mismatch".into()));
        }
        let mut samples = Vec::new();
        for i in 0..c.warmup + c.iterations {
            let (r, times) = execute().map_err(failure)?;
            if r.preference != expected.preference
                || r.initial_points != expected.initial_points
                || r.baseline != expected.baseline
                || r.ceiling != expected.ceiling
            {
                return Err((
                    "repetition",
                    false,
                    "repeated diagnostic result/work drift".into(),
                ));
            }
            if i >= c.warmup {
                samples.push(times);
            }
        }
        Ok((expected, first, samples))
    })();
    let (pair, first, samples) = match measured {
        Ok(value) => value,
        Err((stage, available, error)) if stage == "baseline" || stage == "ceiling" => {
            return Ok(
                json!({"tupleIndex":c.tuple_index,"date":c.date,"status":"failed",
                "stage":stage,"ceilingAvailable":available,"error":error}),
            );
        }
        Err((_, _, error)) => return Err(error),
    };
    let b = counters(&pair.baseline.diagnostics);
    let d = counters(&pair.ceiling.diagnostics);
    let combined_lookup = pair
        .baseline
        .diagnostics
        .lazy
        .work
        .checked_add(pair.ceiling.diagnostics.lazy.work)
        .ok_or("combined work overflow")?;
    let combined_stop = b["stopWork"]
        .as_u64()
        .unwrap()
        .checked_add(d["stopWork"].as_u64().unwrap())
        .ok_or("combined stop work overflow")?;
    let combined_segments = pair
        .baseline
        .diagnostics
        .segments_enqueued
        .checked_add(pair.ceiling.diagnostics.segments_enqueued)
        .ok_or("combined segments overflow")?;
    Ok(
        json!({"tupleIndex":c.tuple_index,"date":c.date,"status":"completed","ceilingAvailable":true,
        "completionScope":if c.preference.is_some(){"single-selector-only"}else{"fixed-selectors-only"},
        "initialPoints":pair.initial_points,"events":c.events,"catalogueKey":c.catalogue_key,
        "baseline":pass(&pair.baseline,c.preference,&samples,0),"ceiling":pass(&pair.ceiling,c.preference,&samples,2),
        "combinedLookupWork":combined_lookup,"combinedStopWork":combined_stop,"combinedSegments":combined_segments,
        "sessionPreparationMs":c.session_prepare_ms,"baselineFirstCallMs":first[0]+first[1],
        "ceilingFirstCallMs":first[2]+first[3],"firstPairMs":first[4],
        "rawPairSamplesMs":samples.iter().map(|s|s[4]).collect::<Vec<_>>()}),
    )
}

fn failure(e: DeadlineIncumbentCeilingError) -> (&'static str, bool, String) {
    match e {
        DeadlineIncumbentCeilingError::Baseline(e) => ("baseline", false, format!("{e:?}")),
        DeadlineIncumbentCeilingError::Ceiling(e) => ("ceiling", true, format!("{e:?}")),
    }
}

fn pass(
    r: &DeadlineWinnerCeilingPass,
    preference: Option<DeadlinePreference>,
    samples: &[[f64; 5]],
    start: usize,
) -> Value {
    let prepares: Vec<_> = samples.iter().map(|s| s[start]).collect();
    let searches: Vec<_> = samples.iter().map(|s| s[start + 1]).collect();
    let totals: Vec<_> = samples.iter().map(|s| s[start] + s[start + 1]).collect();
    json!({"winners":winners(&r.winners,preference),"counters":counters(&r.diagnostics),
        "selection":{"boundChecks":r.selection.bound_checks,"prunedBoardings":r.selection.pruned_boardings},
        "suffixSelection":{"boundChecks":r.selection.suffix_bound_checks,"prunedSuffixes":r.selection.pruned_suffixes},
        "predecessorSelection":{"boundChecks":r.selection.predecessor_bound_checks,"prunedPairs":r.selection.pruned_predecessor_pairs},
        "rowSelection":{"boundChecks":r.diagnostics.lazy.row_bound_checks,"skippedRows":r.diagnostics.lazy.certified_source_rows_skipped},
        "cutoffSelection":{"builds":r.selection.row_ceiling_builds,"selectorsEvaluated":r.selection.row_ceiling_selectors,"disabled":r.selection.row_ceiling_disabled},
        "incomingOrdering":{"packedCalls":r.diagnostics.lazy.packed_sort_calls,"peakAdditionalKeyCapacityBytes":r.diagnostics.lazy.packed_sort_peak_bytes},
        "frontiers":{"directoryEntries":r.frontiers.directory_entries,"directoryCapacityBytes":r.frontiers.directory_capacity_bytes,
            "records":r.frontiers.records,"recordCapacityBytes":r.frontiers.record_capacity_bytes,"retainedIds":r.frontiers.retained_ids,"idCapacityBytes":r.frontiers.id_capacity_bytes},
        "rawSamplesMs":totals,"rawPrepareSamplesMs":prepares,"rawSearchSamplesMs":searches,
        "p50Ms":percentile(&totals,50),"p95Ms":percentile(&totals,95),
        "prepareP50Ms":percentile(&prepares,50),"prepareP95Ms":percentile(&prepares,95),
        "searchP50Ms":percentile(&searches,50),"searchP95Ms":percentile(&searches,95)})
}
