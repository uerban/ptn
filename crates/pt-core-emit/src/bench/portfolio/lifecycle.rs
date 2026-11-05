//! Native first-query ownership experiment. No owner survives a trial.
//! File I/O, reference setup, validation and JSON projection are not timed.
use super::{outcome_fields, owned_outcome, percentile, Outcome};
use pt_core::{engine::temporal_probe::trip_based::*, PatternMode, Query, Reader, Transfers};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Instant;

pub(super) const TIMING_SCOPE: &str = "native fresh owner per trial; ownerLifetimeMs includes captured input copies, reader/transfers/index construction, fresh session preparation, exactly one first query and full owner destruction; totalMs adds separately timed owned-output destruction after untimed validation/JSON observation; excludes file I/O, reference setup, tuple resolution, process startup and observation interval; not browser/device/cold-process qualification";

pub(super) struct Context<'a> {
    pub ptb: &'a [u8],
    pub walks: Option<&'a [u8]>,
    pub query: &'a Query,
    pub config: &'a DeadlineSessionConfig,
    pub pattern: PatternMode,
    pub preference: Option<DeadlinePreference>,
    pub suffix: DeadlineSuffixPruning,
    pub prefix_cache: bool,
    pub setup_profile: bool,
    pub owner_binding: bool,
    pub timetable: bool,
    pub kind: &'a str,
    pub tuple_index: usize,
    pub date: &'a str,
    pub iterations: usize,
    pub warmup: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Phases {
    input_copy_ms: f64,
    constructor_ms: f64,
    session_preparation_ms: f64,
    first_call_ms: f64,
    query_prepare_ms: f64,
    query_search_ms: f64,
    owner_drop_ms: f64,
    owner_lifetime_ms: f64,
    output_drop_ms: f64,
    total_ms: f64,
    copied_input_bytes: usize,
    owner_constructions: usize,
    catalogue_constructions: usize,
    query_uses: usize,
    cached_prefix_constructions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_profile: Option<SetupProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_binding: Option<OwnerBinding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnerBinding {
    owner_bytes: usize,
    slot_bytes: usize,
    populated_digest_bytes: usize,
    heap_bytes: usize,
    hash_constructions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupMarker {
    phase: String,
    elapsed_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupProfile {
    markers: Vec<SetupMarker>,
    outer_residual_ms: f64,
}

struct Sample {
    outcome: Outcome,
    phases: Phases,
    events: usize,
    catalogue_key: [u8; 32],
}

type Failure = (&'static str, String);

fn one(c: &Context<'_>) -> Result<Sample, Failure> {
    let lifetime = Instant::now();
    let began = Instant::now();
    let bytes = c.ptb.to_vec();
    let walks = c.walks.map(<[u8]>::to_vec);
    let input_copy_ms = began.elapsed().as_secs_f64() * 1000.0;
    let began = Instant::now();
    let reader = Reader::from_bytes(bytes).map_err(|e| ("construct", format!("PTB: {e:?}")))?;
    let transfers = walks
        .as_ref()
        .map(Transfers::from_bytes)
        .transpose()
        .map_err(|e| ("construct", format!("PTFT: {e:?}")))?;
    // PTFT is decoded into owned transfers; include temporary input retirement
    // in construction, rather than retain an artificial extra input buffer.
    drop(walks);
    let construct = if c.owner_binding {
        DeadlineSession::new_with_immutable_binding
    } else {
        DeadlineSession::new
    };
    let mut owner = construct(reader, c.pattern, transfers)
        .map_err(|e| ("construct", format!("owner: {e:?}")))?;
    let constructor_ms = began.elapsed().as_secs_f64() * 1000.0;
    let owner_binding = c.owner_binding.then(|| OwnerBinding {
        owner_bytes: DeadlineSession::owner_storage_bytes(),
        slot_bytes: DeadlineSession::immutable_binding_slot_bytes(),
        populated_digest_bytes: owner.retained_binding_bytes(),
        heap_bytes: 0,
        hash_constructions: 1,
    });
    // Fixed-size stack capture: no diagnostic allocation/formatting between
    // markers. Clock/callback overhead remains in profiler-on attribution.
    let mut captured = [(DeadlineSetupPhase::Started, 0.0); 17];
    let mut captured_len = 0;
    let began = Instant::now();
    let mut observe = |phase| {
        let elapsed_ms = began.elapsed().as_secs_f64() * 1000.0;
        captured[captured_len] = (phase, elapsed_ms);
        captured_len += 1;
    };
    let prepared = if c.setup_profile && c.prefix_cache {
        owner.prepare_with_prefix_cache_and_phases(c.query.clone(), c.config.clone(), &mut observe)
    } else if c.setup_profile {
        owner.prepare_with_phases(c.query.clone(), c.config.clone(), &mut observe)
    } else if c.prefix_cache {
        owner.prepare_with_prefix_cache(c.query.clone(), c.config.clone())
    } else {
        owner.prepare(c.query.clone(), c.config.clone())
    }
    .map_err(|e| ("prepare", format!("{e:?}")))?;
    let session_preparation_ms = began.elapsed().as_secs_f64() * 1000.0;
    assert!(!owner.catalogue_reused());
    let catalogue_key = owner.catalogue_key().expect("fresh prepared catalogue");
    let began = Instant::now();
    let mut query_prepared = None;
    let outcome = owned_outcome(&owner, c.preference, c.suffix, false, &mut |phase| {
        if phase == DeadlinePhase::Prepared {
            query_prepared = Some(began.elapsed());
        }
    })
    .map_err(|e| ("preflight", format!("{e:?}")))?;
    let first_call_ms = began.elapsed().as_secs_f64() * 1000.0;
    let query_prepare_ms = query_prepared
        .expect("successful first query prepared")
        .as_secs_f64()
        * 1000.0;
    let began = Instant::now();
    // Includes catalogue, cached prefix, query/config, index, reader and PTFT.
    // Output is owned and remains valid after this owner has been destroyed.
    drop(owner);
    let owner_drop_ms = began.elapsed().as_secs_f64() * 1000.0;
    let owner_lifetime_ms = lifetime.elapsed().as_secs_f64() * 1000.0;
    // Observation/projection is outside both measured lifecycle intervals.
    let setup_profile = c.setup_profile.then(|| {
        let markers: Vec<_> = captured[..captured_len]
            .iter()
            .map(|(phase, elapsed_ms)| SetupMarker {
                phase: format!("{phase:?}"),
                elapsed_ms: *elapsed_ms,
            })
            .collect();
        let outer_residual_ms = session_preparation_ms
            - (markers.last().expect("completed preparation").elapsed_ms
                - markers.first().expect("started preparation").elapsed_ms);
        SetupProfile {
            markers,
            outer_residual_ms,
        }
    });
    Ok(Sample {
        outcome,
        events: prepared.events,
        catalogue_key,
        phases: Phases {
            input_copy_ms,
            constructor_ms,
            session_preparation_ms,
            first_call_ms,
            query_prepare_ms,
            query_search_ms: first_call_ms - query_prepare_ms,
            owner_drop_ms,
            owner_lifetime_ms,
            output_drop_ms: 0.0,
            total_ms: 0.0,
            copied_input_bytes: c.ptb.len() + c.walks.map_or(0, <[u8]>::len),
            owner_constructions: 1,
            catalogue_constructions: 1,
            query_uses: 1,
            cached_prefix_constructions: usize::from(c.prefix_cache),
            setup_profile,
            owner_binding,
        },
    })
}

fn measured(c: &Context<'_>) -> Result<Value, Failure> {
    let (mut expected, mut first) = (None, None);
    let (mut warmups, mut samples) = (Vec::new(), Vec::new());
    for trial in 0..1 + c.warmup + c.iterations {
        let Sample {
            outcome,
            mut phases,
            events,
            catalogue_key,
        } = one(c)?;
        // Canonical/work observation and comparisons are outside both timed
        // intervals. This JSON is an audit reference, never an engine input.
        let mut fields = outcome_fields(
            &outcome,
            c.kind,
            c.preference,
            c.config.traversal,
            c.timetable,
        );
        fields["events"] = json!(events);
        fields["catalogueKey"] = json!(catalogue_key);
        if expected.as_ref().is_some_and(|e| *e != fields) {
            return Err(("measurement", "fresh-owner result/work drift".into()));
        }
        let began = Instant::now();
        drop(outcome);
        phases.output_drop_ms = began.elapsed().as_secs_f64() * 1000.0;
        phases.total_ms = phases.owner_lifetime_ms + phases.output_drop_ms;
        if trial == 0 {
            expected = Some(fields);
            first = Some(phases);
        } else if trial <= c.warmup {
            warmups.push(phases);
        } else {
            samples.push(phases);
        }
    }
    let totals: Vec<_> = samples.iter().map(|s| s.total_ms).collect();
    let mut row = expected.expect("first successful lifecycle");
    row["tupleIndex"] = json!(c.tuple_index);
    row["date"] = json!(c.date);
    row["status"] = json!("completed");
    row["firstLifecycle"] = json!(first);
    row["warmupLifecycles"] = json!(warmups);
    row["rawLifecycleSamples"] = json!(samples);
    row["rawSamplesMs"] = json!(totals);
    row["p50Ms"] = json!(percentile(&totals, 50));
    row["p95Ms"] = json!(percentile(&totals, 95));
    Ok(row)
}

pub(super) fn row(c: Context<'_>) -> Value {
    match measured(&c) {
        Ok(row) => row,
        Err((stage, error)) => json!({"tupleIndex":c.tuple_index,"date":c.date,
            "status":"failed","stage":stage,"error":error}),
    }
}
