//! Correctness-only native movement emission. No new boarding or GTFS rules.
use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn row(
    owner: &DeadlineSession,
    preference: Option<DeadlinePreference>,
    suffix: DeadlineSuffixPruning,
    checked: bool,
    tuple: usize,
    date: &str,
    traversal: DeadlineTraversal,
    timetable: bool,
) -> Result<Value, String> {
    let failed = |stage: &str, e: DeadlineError| json!({"tupleIndex":tuple,"date":date,"status":"failed","stage":stage,"error":format!("{e:?}")});
    let baseline = match owned_outcome(owner, preference, suffix, checked, &mut |_| {}) {
        Ok(r) => r,
        Err(e) => return Ok(failed("preflight", e)),
    };
    let result = if let Some(p) = preference {
        let r = if checked {
            owner.run_preference_journey_checked_with_phases(p, suffix, |_| {})
        } else {
            owner.run_preference_journey(p, suffix)
        };
        r.map(|r| {
            let mut winners = DeadlinePortfolioWinners::default();
            let mut slots = [None; 4];
            let slot = DeadlinePreference::ALL
                .iter()
                .position(|s| *s == p)
                .unwrap();
            winners.by_preference[slot] = r.search.winner;
            if r.journey.is_some() {
                slots[slot] = Some(0);
            }
            (
                Outcome {
                    winners,
                    profile: None,
                    diagnostics: r.search.diagnostics,
                    frontiers: r.search.frontiers,
                    selection: r.search.selection,
                },
                r.journey.into_iter().collect::<Vec<_>>(),
                slots,
                r.projection,
            )
        })
    } else {
        let r = if checked {
            owner.run_portfolio_journeys_checked_with_phases(suffix, |_| {})
        } else {
            owner.run_portfolio_journeys(suffix)
        };
        r.map(|r| {
            (
                Outcome {
                    winners: r.search.winners,
                    profile: None,
                    diagnostics: r.search.diagnostics,
                    frontiers: r.search.frontiers,
                    selection: r.search.selection,
                },
                r.journeys,
                r.by_preference,
                r.projection,
            )
        })
    };
    let (actual, journeys, slots, d) = match result {
        Ok(r) => r,
        Err(e) => return Ok(failed("journey", e)),
    };
    if actual != baseline {
        return Err("journey audit search/winner/work drift".into());
    }
    let mut row = outcome_fields(&actual, "portfolio", preference, traversal, timetable);
    row["tupleIndex"] = json!(tuple);
    row["date"] = json!(date);
    row["status"] = json!("completed");
    row["journeys"] = Value::Array(
        journeys
            .iter()
            .map(|j| movement(owner.reader(), j))
            .collect::<Result<_, _>>()?,
    );
    row["journeyByPreference"] = Value::Object(
        DeadlinePreference::ALL
            .into_iter()
            .zip(slots)
            .filter(|(s, _)| preference.is_none_or(|p| p == *s))
            .map(|(s, i)| (s.name().into(), json!(i)))
            .collect(),
    );
    row["projection"] = json!({"stopWork":d.stop_work,"lookupWork":d.lookup_work,
        "aggregateStopWork":d.aggregate_stop_work,"aggregateLookupWork":d.aggregate_lookup_work,
        "uniqueJourneys":d.unique_journeys,"coreOutputBytes":d.output_bytes});
    Ok(row)
}

fn movement(reader: &Reader<Vec<u8>>, j: &DeadlineJourney) -> Result<Value, String> {
    let stop = |s: u32| {
        reader
            .stop_id(s as usize)
            .map(str::to_owned)
            .map_err(|e| format!("movement stop: {e:?}"))
    };
    let p = point(&j.point);
    let rides = j.rides.iter().enumerate().map(|(i,r)|Ok(json!({
        "witness":p["witness"][i],"routeType":r.route_type,
        "fromStopId":stop(r.from_stop)?,"toStopId":stop(r.to_stop)?,
        "patternStopIds":r.pattern_stop_ids.iter().map(|s|stop(*s)).collect::<Result<Vec<_>,_>>()?
    }))).collect::<Result<Vec<Value>,String>>()?;
    let connections = j.connections.iter().map(|c|Ok(json!({
        "fromStopId":stop(c.from_stop)?,"toStopId":stop(c.to_stop)?,
        "arrivalSecs":c.arrival_secs,"boardingSecs":c.boarding_secs,
        "walkSecs":c.walk_secs,"minimumElapsedSecs":c.elapsed_secs,
        "kind":match c.kind { TransferKind::SameStop=>"same-stop",TransferKind::Footpath=>"footpath",
            TransferKind::Synthetic=>"synthetic",TransferKind::Linked=>"linked",
            TransferKind::InSeat=>"in-seat",TransferKind::Derived=>"derived" },
        "spendsTransfer":c.kind.spends_transfer()
    }))).collect::<Result<Vec<Value>,String>>()?;
    Ok(
        json!({"point":p,"access":{"stopId":stop(j.access.stop)?,"walkSecs":j.access.walk_secs},
        "rides":rides,"connections":connections,
        "egress":{"fromStopId":stop(j.egress.from_stop)?,"exitStopId":stop(j.egress.exit_stop)?,
            "physicalWalkSecs":j.egress.physical_walk_secs,"callerWalkSecs":j.egress.caller_walk_secs}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_movement_audit_preserves_winners_and_work_without_timing_credit() {
        for mode in ["off", "unbounded", "covering-merge"] {
            for validation in ["owned-checked", "owned-session"] {
                for kind in [
                    "portfolio",
                    "latest-departure",
                    "fastest",
                    "least-walking",
                    "fewest-transfers",
                ] {
                    let common = [
                        "--pattern-mode",
                        mode,
                        "--validation",
                        validation,
                        "--query-kind",
                        kind,
                    ];
                    let before = super::super::tests::fixture_run(&common);
                    let args = common
                        .into_iter()
                        .chain(["--journey-audit", "on"])
                        .collect::<Vec<_>>();
                    let after = super::super::tests::fixture_run(&args);
                    assert_eq!(after["journeyAudit"], "complete-selected-movement-v1");
                    let (a, b) = (&before["queries"][0], &after["queries"][0]);
                    for k in ["winners", "counters", "frontiers", "selection"] {
                        assert_eq!(a[k], b[k]);
                    }
                    assert_eq!(b["journeys"].as_array().unwrap().len(), 1);
                    assert!(b.get("p95Ms").is_none());
                    assert_eq!(b["journeys"][0]["connections"][0]["kind"], "same-stop");
                    let d = &b["projection"];
                    assert_eq!(
                        d["aggregateStopWork"].as_u64().unwrap(),
                        b["counters"]["stopWork"].as_u64().unwrap()
                            + d["stopWork"].as_u64().unwrap()
                    );
                }
            }
        }
    }
    #[test]
    fn audit_failures_have_no_partial_output_or_timing() {
        let args = ["--validation", "owned-session", "--journey-audit", "on"];
        let ok = super::super::tests::fixture_run(&args);
        let cap = ok["queries"][0]["counters"]["lookupWork"]
            .as_u64()
            .unwrap()
            .to_string();
        for (limit, stage) in [("1", "preflight"), (cap.as_str(), "journey")] {
            let extra = args
                .into_iter()
                .chain(["--max-lookup-work", limit])
                .collect::<Vec<_>>();
            let r = super::super::tests::fixture_run(&extra);
            let q = &r["queries"][0];
            assert_eq!(q["status"], "failed");
            assert_eq!(q["stage"], stage);
            assert_eq!(q.as_object().unwrap().len(), 5);
        }
    }
    #[test]
    fn audit_scope_rejects_before_input_io() {
        for extra in [
            vec!["--journey-audit", "bad"],
            vec!["--journey-audit", "on"],
            vec![
                "--journey-audit",
                "on",
                "--validation",
                "owned-session",
                "--iterations",
                "2",
            ],
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
            ]
            .into_iter()
            .chain(extra)
            .map(String::from)
            .collect::<Vec<_>>();
            assert!(run(&args).unwrap_err().contains("journey-audit"));
        }
    }
}
