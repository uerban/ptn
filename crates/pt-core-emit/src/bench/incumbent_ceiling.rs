//! Perfect legal incumbent diagnostic. Not a candidate generator or a speedup.
use super::tuple_input;
use pt_core::engine::temporal_probe::{r3::ProfileObjectives, trip_based::*};
use pt_core::{Index, PatternMode, Reader, Transfers};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn run(args: &[String]) -> Result<String, String> {
    let (mut ptb, mut walks, mut tuples) = (None, None, None);
    let (mut start, mut end, mut deadline) = (None, None, None);
    let (mut objective, mut pattern) = ("m4", "covering-merge");
    let (mut rounds, mut states, mut width, mut scans, mut work) = (
        4u32,
        250_000usize,
        64usize,
        10_000_000usize,
        10_000_000usize,
    );
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
            "--objective" => objective = v,
            "--pattern-mode" => pattern = v,
            "--max-rounds" => rounds = v.parse().map_err(|_| "invalid max-rounds")?,
            "--max-states" => states = v.parse().map_err(|_| "invalid max-states")?,
            "--max-bag-width" => width = v.parse().map_err(|_| "invalid max-bag-width")?,
            "--max-stop-scans" => scans = v.parse().map_err(|_| "invalid max-stop-scans")?,
            "--max-lookup-work" => work = v.parse().map_err(|_| "invalid max-lookup-work")?,
            _ => return Err(format!("unknown ceiling option {a}")),
        }
        i += 1;
    }
    let (ptb, tuples) = (
        ptb.ok_or("missing PTB")?,
        tuples.ok_or("missing query-tuples")?,
    );
    let (start, end, deadline) = (
        start.ok_or("missing window-start")?,
        end.ok_or("missing window-end")?,
        deadline.ok_or("missing arrival-deadline")?,
    );
    if start >= end
        || deadline < end - 1
        || deadline == i64::MAX
        || rounds == 0
        || [states, width, scans, work].contains(&0)
    {
        return Err("invalid ceiling window or limit".into());
    }
    let objectives = match objective {
        "r3" => ProfileObjectives::R3,
        "m4" => ProfileObjectives::M4,
        _ => return Err("objective must be r3 or m4".into()),
    };
    let mode = match pattern {
        "off" => PatternMode::Off,
        "unbounded" => PatternMode::Unbounded,
        "covering-merge" => PatternMode::CoveringMerge,
        _ => return Err("invalid pattern mode".into()),
    };
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
    let index = Index::build(&reader, mode).map_err(|e| format!("index: {e:?}"))?;
    let mut rows = Vec::new();
    for (tuple_index, input) in tuple_input::load(tuples, &reader)?.into_iter().enumerate() {
        let mut query = input.query;
        query.max_rounds = Some(rounds);
        let config = TransferIndexConfig {
            mobility: query.mobility,
            excluded_modes: query.excluded_modes.clone(),
            ..TransferIndexConfig::new(query.date, start..deadline + 1)
        };
        let events = build_event_index(&reader, &index, transfers.as_ref(), &config)
            .map_err(|e| format!("catalogue: {e:?}"))?;
        let mut r = DeadlineRequest::new(&query, start..end, deadline);
        r.pruning = DeadlinePruning::EarliestPrefixAndPoints;
        r.traversal = DeadlineTraversal::ArrivalFirst;
        r.objectives = objectives;
        r.transfers = transfers.as_ref();
        r.max_segments = states;
        r.max_frontier_width = width;
        r.max_stop_scans = scans;
        r.max_lookup_work = work;
        match query_deadline_incumbent_ceiling(&reader, &index, &events, r) {
            Ok(pair) => {
                if !pair.baseline.complete
                    || !pair.ceiling.complete
                    || pair.baseline.points != pair.ceiling.points
                {
                    return Err("ceiling full canonical mismatch".into());
                }
                let b = counters(&pair.baseline.diagnostics);
                let c = counters(&pair.ceiling.diagnostics);
                rows.push(json!({"tupleIndex":tuple_index,"date":input.provenance.date,"status":"completed","ceilingAvailable":true,
                    "pointCount":pair.baseline.points.len(),"points":pair.baseline.points.iter().map(point).collect::<Vec<_>>(),
                    "ceilingPoints":pair.ceiling.points.iter().map(point).collect::<Vec<_>>(),"baseline":b,"ceiling":c,
                    "combinedLookupWork":pair.baseline.diagnostics.lazy.work.checked_add(pair.ceiling.diagnostics.lazy.work).ok_or("combined work overflow")?,
                    "combinedStopWork":b["stopWork"].as_u64().unwrap().checked_add(c["stopWork"].as_u64().unwrap()).ok_or("combined stop work overflow")?,
                    "combinedSegments":pair.baseline.diagnostics.segments_enqueued.checked_add(pair.ceiling.diagnostics.segments_enqueued).ok_or("combined states overflow")?}));
            }
            Err(error) => {
                let (stage, available, e) = match error {
                    DeadlineIncumbentCeilingError::Baseline(e) => ("baseline", false, e),
                    DeadlineIncumbentCeilingError::Ceiling(e) => ("ceiling", true, e),
                };
                rows.push(json!({"tupleIndex":tuple_index,"date":input.provenance.date,"status":"failed","stage":stage,"ceilingAvailable":available,"error":format!("{e:?}")}));
            }
        }
    }
    serde_json::to_string_pretty(&json!({"scope":"perfect-incumbent-headroom-diagnostic","fullProfilePromotion":false,"latencyQualification":false,"deployableOptimization":false,
        "status":if rows.iter().all(|r|r["status"]=="completed") {"completed"} else {"failed"},"objective":objective,"patternMode":pattern,
        "requestedWindow":[start,end],"arrivalDeadline":deadline,"maxRounds":rounds,"maxStates":states,"maxBagWidth":width,"maxStopScans":scans,"maxLookupWork":work,
        "engine":"lazy-fast","traversal":"arrival-first","prefixBound":"on","pointBound":"on","staticBound":"off","walkingBound":"off","forwardSeeds":"off",
        "workScope":"each pass independently capped; source computation reported separately and in combined totals; perfect incumbents are hypothetical free inputs only in repeated-pass counters",
        "ptbSha256":ptb_hash,"transfersSha256":walk_hash,"queryTuplesSha256":format!("{:x}",Sha256::digest(std::fs::read(tuples).map_err(|e|e.to_string())?)),"queries":rows})).map_err(|e|e.to_string())
}

pub(super) fn counters(d: &DeadlineDiagnostics) -> Value {
    json!({"lookupWork":d.lazy.work,"stopWork":d.seed_event_checks+d.stop_events_scanned+d.prefix.event_scans+d.prefix.walking_relaxations+d.prefix.timetable.work()+d.optimistic.work()+d.forward.stop_work(),
        "segments":d.segments_enqueued,"segmentsScanned":d.segments_scanned,"maxFrontierWidth":d.max_frontier_width,
        "seedEventChecks":d.seed_event_checks,"stopEventsScanned":d.stop_events_scanned,"prefixEventScans":d.prefix.event_scans,"prefixWalkingRelaxations":d.prefix.walking_relaxations,
        "prefixEnabled":d.prefix.enabled,"pointPrunedBoardings":d.prefix.point_pruned_boardings,"eventProbes":d.lazy.event_probes,"pairChecks":d.lazy.pair_checks,
        "instanceProbes":d.lazy.instance_probes,"incomingIndexBytes":d.incoming_index_bytes,"arenaBytes":d.arena_bytes})
}

pub(super) fn point(p: &pt_core::engine::temporal_probe::r3::R3Point) -> Value {
    json!({"departureSecs":p.origin_departure_secs,"arrivalSecs":p.destination_arrival_secs,"actualTransfers":p.actual_transfers,"totalWalkSecs":p.total_walk_secs,
        "transitRounds":p.transit_rounds,"serviceDate":p.service_date,"witnessLegs":p.witness.len(),"witness":p.witness.iter().map(|w|json!({"serviceDate":w.service_date,
            "routeIdx":w.route_idx,"readerRouteIdx":w.reader_route_idx,"tripIdx":w.trip_idx,"boardPosition":w.board_position,"alightPosition":w.alight_position,
            "boardSecs":w.board_secs,"alightSecs":w.alight_secs,"frequencyOffsetSecs":w.frequency_offset_secs,"frequencyInstance":w.frequency_instance,"inSeat":w.in_seat})).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_diagnostic_options_reject_before_artifact_io() {
        for (extra, error) in [
            (["--objective", "fare"], "objective must be r3 or m4"),
            (
                ["--forward-seeds", "on"],
                "unknown ceiling option --forward-seeds",
            ),
            (
                ["--max-lookup-work", "0"],
                "invalid ceiling window or limit",
            ),
        ] {
            let a: Vec<_> = [
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
            assert_eq!(run(&a), Err(error.into()));
        }
    }

    fn fixture_run(extra: &[&str]) -> Value {
        use pt_core::engine::testkit::{
            bare_route, bare_stops, build_v2_ptb, utc_origins, ServicePoolSpec, StopRoutes, V1Feed,
            V1Trip, V2Feed,
        };
        let dir = std::env::temp_dir().join(format!(
            "pt-core-ceiling-tests-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
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
        std::fs::write(&bundle, bytes).unwrap();
        std::fs::write(&tuples,br#"{"tuples":[{"entryStops":[{"stopId":"s0","walkSecs":0}],"exitStops":[{"stopId":"s2","walkSecs":0}],"date":"20261004","departureSecs":900}]}"#).unwrap();
        let a: Vec<_> = [
            bundle.to_str().unwrap(),
            "--query-tuples",
            tuples.to_str().unwrap(),
            "--window-start",
            "900",
            "--window-end",
            "901",
            "--arrival-deadline",
            "1400",
        ]
        .into_iter()
        .chain(extra.iter().copied())
        .map(String::from)
        .collect();
        let result = run(&a);
        std::fs::remove_dir_all(&dir).unwrap();
        serde_json::from_str(&result.unwrap()).unwrap()
    }

    #[test]
    fn diagnostic_reports_full_witnesses_and_combined_source_work() {
        for objective in ["r3", "m4"] {
            for mode in ["off", "unbounded", "covering-merge"] {
                let r = fixture_run(&["--objective", objective, "--pattern-mode", mode]);
                assert_eq!(r["status"], "completed");
                assert_eq!(r["deployableOptimization"], false);
                assert_eq!(r["latencyQualification"], false);
                let q = &r["queries"][0];
                assert_eq!(q["points"], q["ceilingPoints"]);
                assert_eq!(q["pointCount"], 1);
                assert_eq!(q["points"][0]["witnessLegs"], 2);
                assert_eq!(q["points"][0]["actualTransfers"], 1);
                assert_eq!(
                    q["combinedLookupWork"].as_u64().unwrap(),
                    q["baseline"]["lookupWork"].as_u64().unwrap()
                        + q["ceiling"]["lookupWork"].as_u64().unwrap()
                );
            }
        }
    }

    #[test]
    fn unavailable_diagnostic_keeps_the_original_cap_and_no_partial_points() {
        let r = fixture_run(&["--max-lookup-work", "1"]);
        assert_eq!(r["status"], "failed");
        let q = &r["queries"][0];
        assert_eq!(q["stage"], "baseline");
        assert_eq!(q["ceilingAvailable"], false);
        assert_eq!(
            q["error"],
            "Lookup(WorkExhausted { limit: 1, attempted: 2 })"
        );
        for key in [
            "points",
            "ceilingPoints",
            "baseline",
            "ceiling",
            "combinedLookupWork",
        ] {
            assert!(q.get(key).is_none());
        }
    }
}
