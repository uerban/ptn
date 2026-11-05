//! Changed-query sweeps over the existing sealed single-catalogue owner.
//! No catalogue, prefix or result survives a sweep.
use super::{outcome_fields, owned_outcome, percentile, tuple_input::ResolvedTuple, Outcome};
use pt_core::{engine::temporal_probe::trip_based::*, PatternMode, Reader, Transfers};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Instant};

pub(super) const TIMING_SCOPE: &str = "native fresh owner per request sweep; ownerLifetimeMs includes captured input copies, reader/transfers/index construction, every changed-query preparation and first search, and full owner destruction; totalMs adds separately timed owned-output destruction after untimed canonical/work observation; no owner/catalogue survives a sweep; excludes file I/O, reference setup, tuple resolution, process startup and observation interval; not browser/device/cold-process qualification";

pub(super) struct Context<'a> {
    pub ptb: &'a [u8],
    pub walks: Option<&'a [u8]>,
    pub inputs: &'a [ResolvedTuple],
    pub config: &'a DeadlineSessionConfig,
    pub pattern: PatternMode,
    pub preference: Option<DeadlinePreference>,
    pub suffix: DeadlineSuffixPruning,
    pub timetable: bool,
    pub kind: &'a str,
    pub rounds: u32,
    pub reuse: bool,
    pub interleaved: bool,
    pub iterations: usize,
    pub warmup: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestPhase {
    tuple_index: usize,
    catalogue_reused: bool,
    session_preparation_ms: f64,
    first_call_ms: f64,
    query_prepare_ms: f64,
    query_search_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Phases {
    input_copy_ms: f64,
    constructor_ms: f64,
    owner_drop_ms: f64,
    owner_lifetime_ms: f64,
    output_drop_ms: f64,
    total_ms: f64,
    copied_input_bytes: usize,
    owner_constructions: usize,
    catalogue_constructions: usize,
    catalogue_hits: usize,
    query_uses: usize,
    cached_prefix_constructions: usize,
    requests: Vec<RequestPhase>,
}

type Failure = (&'static str, String);
type Answer = Result<(Outcome, usize, [u8; 32]), Failure>;

pub(super) fn order(inputs: &[ResolvedTuple], interleaved: bool) -> Vec<usize> {
    if !interleaved {
        return (0..inputs.len()).collect();
    }
    let mut dates: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
    for (i, input) in inputs.iter().enumerate() {
        dates.entry(input.query.date).or_default().push(i);
    }
    (0..dates.values().map(Vec::len).max().unwrap_or(0))
        .flat_map(|row| dates.values().filter_map(move |v| v.get(row).copied()))
        .collect()
}

fn one(c: &Context<'_>, order: &[usize]) -> Result<(Vec<Answer>, Phases), String> {
    let lifetime = Instant::now();
    let began = Instant::now();
    let bytes = c.ptb.to_vec();
    let walks = c.walks.map(<[u8]>::to_vec);
    let input_copy_ms = began.elapsed().as_secs_f64() * 1000.0;
    let began = Instant::now();
    let reader = Reader::from_bytes(bytes).map_err(|e| format!("PTB: {e:?}"))?;
    let transfers = walks
        .as_ref()
        .map(Transfers::from_bytes)
        .transpose()
        .map_err(|e| format!("PTFT: {e:?}"))?;
    drop(walks);
    let mut owner =
        DeadlineSession::new(reader, c.pattern, transfers).map_err(|e| format!("owner: {e:?}"))?;
    let constructor_ms = began.elapsed().as_secs_f64() * 1000.0;
    let mut answers = Vec::with_capacity(order.len());
    let mut phases = Vec::with_capacity(order.len());
    let mut hits = 0;
    for &tuple_index in order {
        let began = Instant::now();
        let mut query = c.inputs[tuple_index].query.clone();
        query.max_rounds = Some(c.rounds);
        let prepared = if c.reuse {
            owner.prepare_reusing(query, c.config.clone())
        } else {
            owner.prepare(query, c.config.clone())
        };
        let session_preparation_ms = began.elapsed().as_secs_f64() * 1000.0;
        let prepared = match prepared {
            Ok(p) => p,
            Err(e) => {
                answers.push(Err(("prepare", format!("{e:?}"))));
                continue;
            }
        };
        let reused = owner.catalogue_reused();
        hits += usize::from(reused);
        let key = owner.catalogue_key().expect("prepared catalogue");
        let began = Instant::now();
        let mut query_prepared = None;
        let outcome = owned_outcome(&owner, c.preference, c.suffix, false, &mut |phase| {
            if phase == DeadlinePhase::Prepared {
                query_prepared = Some(began.elapsed());
            }
        });
        let first_call_ms = began.elapsed().as_secs_f64() * 1000.0;
        let outcome = match outcome {
            Ok(o) => o,
            Err(e) => {
                answers.push(Err(("preflight", format!("{e:?}"))));
                continue;
            }
        };
        let query_prepare_ms = query_prepared.expect("prepared query").as_secs_f64() * 1000.0;
        phases.push(RequestPhase {
            tuple_index,
            catalogue_reused: reused,
            session_preparation_ms,
            first_call_ms,
            query_prepare_ms,
            query_search_ms: first_call_ms - query_prepare_ms,
        });
        answers.push(Ok((outcome, prepared.events, key)));
    }
    let began = Instant::now();
    drop(owner);
    let owner_drop_ms = began.elapsed().as_secs_f64() * 1000.0;
    let owner_lifetime_ms = lifetime.elapsed().as_secs_f64() * 1000.0;
    Ok((
        answers,
        Phases {
            input_copy_ms,
            constructor_ms,
            owner_drop_ms,
            owner_lifetime_ms,
            output_drop_ms: 0.0,
            total_ms: 0.0,
            copied_input_bytes: c.ptb.len() + c.walks.map_or(0, <[u8]>::len),
            owner_constructions: 1,
            catalogue_constructions: order.len() - hits,
            catalogue_hits: hits,
            query_uses: order.len(),
            cached_prefix_constructions: 0,
            requests: phases,
        },
    ))
}

pub(super) fn run(c: Context<'_>) -> Result<(Vec<Value>, Value), String> {
    let order = order(c.inputs, c.interleaved);
    let (mut expected, mut first) = (None, None);
    let (mut warmups, mut samples) = (Vec::new(), Vec::new());
    for trial in 0..1 + c.warmup + c.iterations {
        let (answers, mut phases) = one(&c, &order)?;
        let mut fields = vec![Value::Null; c.inputs.len()];
        let mut complete = true;
        for (&i, answer) in order.iter().zip(&answers) {
            let mut row = match answer {
                Ok((outcome, events, key)) => {
                    let mut row = outcome_fields(
                        outcome,
                        c.kind,
                        c.preference,
                        c.config.traversal,
                        c.timetable,
                    );
                    row["status"] = json!("completed");
                    row["events"] = json!(events);
                    row["catalogueKey"] = json!(key);
                    row
                }
                Err((stage, error)) => {
                    complete = false;
                    json!({"status":"failed","stage":stage,"error":error})
                }
            };
            row["tupleIndex"] = json!(i);
            row["date"] = json!(c.inputs[i].provenance.date);
            fields[i] = row;
        }
        if expected.as_ref().is_some_and(|e| *e != fields) {
            return Err("request-sweep canonical/work/failure drift".into());
        }
        let began = Instant::now();
        drop(answers);
        phases.output_drop_ms = began.elapsed().as_secs_f64() * 1000.0;
        phases.total_ms = phases.owner_lifetime_ms + phases.output_drop_ms;
        // No partial sweep time: successful cells remain semantic references,
        // failed cells keep typed metadata only. The scout gets no time credit.
        if trial == 0 {
            expected = Some(fields);
            first = complete.then_some(phases);
        } else if complete {
            if trial <= c.warmup {
                warmups.push(phases);
            } else {
                samples.push(phases);
            }
        }
    }
    let totals: Vec<_> = samples.iter().map(|p| p.total_ms).collect();
    let available = first.is_some();
    Ok((
        expected.expect("first request sweep"),
        json!({"timingAvailable":available,"requestOrder":order,
            "first":first,"warmups":warmups,"samples":samples,"rawSamplesMs":totals,
            "p50Ms":available.then(||percentile(&totals,50)),
            "p95Ms":available.then(||percentile(&totals,95))}),
    ))
}
