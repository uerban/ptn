use super::*;

fn fixture(extra: &[&str], walking: bool) -> Value {
    let tuples: Vec<_> = [20261004, 20261004, 20261004, 20261005, 20261005]
        .into_iter()
        .enumerate()
        .map(|(i, d)| {
            json!({"date":d.to_string(),"departureSecs":900,
            "entryStops":[{"stopId":if i==1 {"s1"}else{"s0"},"walkSecs":i}],
            "exitStops":[{"stopId":"s2","walkSecs":i}]})
        })
        .collect();
    tests::fixture_with_tuples(extra, false, walking, Some(json!(tuples)))
}

#[test]
fn winner_requests_keep_all_semantics_and_charge_actual_hits_misses_and_lifetimes() {
    for mode in ["off", "unbounded", "covering-merge"] {
        for date in ["materialized", "materialized-date-memo"] {
            for kind in ["portfolio"]
                .into_iter()
                .chain(DeadlinePreference::ALL.map(|p| p.name()))
            {
                for certificate in ["duration", "timetable"] {
                    let common = [
                        "--query-kind",
                        kind,
                        "--pattern-mode",
                        mode,
                        "--witness-comparison",
                        date,
                        "--prefix-certificate",
                        certificate,
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
                    let normal = fixture(&common, false);
                    for order in ["input", "date-interleaved"] {
                        for reuse in ["fresh", "reuse"] {
                            let extra: Vec<_> = common
                                .into_iter()
                                .chain([
                                    "--owner-lifecycle",
                                    "requests",
                                    "--catalogue-setup",
                                    reuse,
                                    "--request-order",
                                    order,
                                ])
                                .collect();
                            let r = fixture(&extra, false);
                            assert_eq!(r["status"], "completed");
                            assert_eq!(r["ownerLifecycle"], "requests");
                            assert!(r["ownerConstructorMs"].is_null());
                            assert_eq!(r["timingScope"], requests::TIMING_SCOPE);
                            assert_eq!(r["catalogueSetup"], reuse);
                            assert_eq!(r["requestOrder"], order);
                            for (i, q) in r["queries"].as_array().unwrap().iter().enumerate() {
                                for (key, value) in q.as_object().unwrap() {
                                    assert_eq!(value, &normal["queries"][i][key], "{key}");
                                }
                                assert!(q.get("p95Ms").is_none());
                            }
                            let s = &r["requestSweeps"];
                            let expected_order = if order == "input" {
                                json!([0, 1, 2, 3, 4])
                            } else {
                                json!([0, 3, 1, 4, 2])
                            };
                            assert_eq!(s["requestOrder"], expected_order);
                            assert_eq!(s["timingAvailable"], true);
                            assert_eq!(s["warmups"].as_array().unwrap().len(), 1);
                            assert_eq!(s["samples"].as_array().unwrap().len(), 2);
                            for p in std::iter::once(&s["first"])
                                .chain(s["warmups"].as_array().unwrap())
                                .chain(s["samples"].as_array().unwrap())
                            {
                                assert_eq!(p["ownerConstructions"], 1);
                                assert_eq!(p["queryUses"], 5);
                                assert_eq!(p["cachedPrefixConstructions"], 0);
                                let hits = if reuse == "reuse" && order == "input" {
                                    3
                                } else {
                                    0
                                };
                                assert_eq!(p["catalogueHits"], hits);
                                assert_eq!(p["catalogueConstructions"], 5 - hits);
                                assert!(p["copiedInputBytes"].as_u64().unwrap() > 0);
                                let mut total = 0.0;
                                for (j, q) in p["requests"].as_array().unwrap().iter().enumerate() {
                                    assert_eq!(q["tupleIndex"], expected_order[j]);
                                    assert_eq!(
                                        q["catalogueReused"],
                                        hits > 0 && [1, 2, 4].contains(&j)
                                    );
                                    let first = q["firstCallMs"].as_f64().unwrap();
                                    assert!(
                                        (first
                                            - q["queryPrepareMs"].as_f64().unwrap()
                                            - q["querySearchMs"].as_f64().unwrap())
                                        .abs()
                                            < 1e-8
                                    );
                                    total += first + q["sessionPreparationMs"].as_f64().unwrap();
                                }
                                for k in ["inputCopyMs", "constructorMs", "ownerDropMs"] {
                                    total += p[k].as_f64().unwrap();
                                }
                                assert!(p["ownerLifetimeMs"].as_f64().unwrap() + 1e-8 >= total);
                                assert!(
                                    (p["totalMs"].as_f64().unwrap()
                                        - p["ownerLifetimeMs"].as_f64().unwrap()
                                        - p["outputDropMs"].as_f64().unwrap())
                                    .abs()
                                        < 1e-8
                                );
                            }
                            let totals: Vec<_> = s["samples"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|p| p["totalMs"].as_f64().unwrap())
                                .collect();
                            assert_eq!(s["rawSamplesMs"], json!(totals));
                            assert_eq!(s["p95Ms"], json!(percentile(&totals, 95)));
                            assert_eq!(s["p50Ms"], json!(percentile(&totals, 50)));
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn winner_requests_keep_failures_untimed_and_walk_inputs_and_no_hit_answers_owned() {
    for certificate in ["duration", "timetable"] {
        let common = [
            "--validation",
            "owned-session",
            "--prefix-certificate",
            certificate,
            "--suffix-bound",
            "row-prefix",
            "--frontier-storage",
            "event-indexed",
        ];
        for cap in ["--max-stop-scans", "--max-lookup-work", "--max-states"] {
            let base: Vec<_> = common.into_iter().chain([cap, "1"]).collect();
            let normal = fixture(&base, true);
            let args: Vec<_> = base
                .into_iter()
                .chain([
                    "--owner-lifecycle",
                    "requests",
                    "--catalogue-setup",
                    "reuse",
                ])
                .collect();
            let r = fixture(&args, true);
            assert_eq!(r["status"], "failed");
            assert_eq!(r["queries"], normal["queries"]);
            for q in r["queries"].as_array().unwrap() {
                assert_eq!(q.as_object().unwrap().len(), 5);
            }
            assert_eq!(
                r["requestSweeps"],
                json!({"timingAvailable":false,"requestOrder":[0,1,2,3,4],
                "first":null,"warmups":[],"samples":[],"rawSamplesMs":[],"p50Ms":null,"p95Ms":null})
            );
        }
        let args: Vec<_> = common
            .into_iter()
            .chain([
                "--owner-lifecycle",
                "requests",
                "--catalogue-setup",
                "reuse",
                "--arrival-deadline",
                "901",
            ])
            .collect();
        let plain = fixture(&args, false);
        let walks = fixture(&args, true);
        assert!(
            walks["requestSweeps"]["first"]["copiedInputBytes"]
                .as_u64()
                .unwrap()
                > plain["requestSweeps"]["first"]["copiedInputBytes"]
                    .as_u64()
                    .unwrap()
        );
        for r in [plain, walks] {
            assert_eq!(r["status"], "completed");
            for q in r["queries"].as_array().unwrap() {
                assert!(q["winners"]
                    .as_object()
                    .unwrap()
                    .values()
                    .all(Value::is_null));
            }
        }
    }
}

#[test]
fn winner_requests_reject_incompatible_options_before_input_io() {
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
        "requests",
    ];
    for extra in [
        ["--query-kind", "profile"],
        ["--validation", "checked"],
        ["--validation", "owned-checked"],
        ["--catalogue-setup", "unknown"],
        ["--request-order", "unknown"],
        ["--prefix-setup", "prepared"],
    ] {
        let args: Vec<_> = common.into_iter().chain(extra).map(String::from).collect();
        let error = run(&args).unwrap_err();
        assert!(!error.contains("No such file"), "{error}");
    }
    for extra in [
        ["--owner-lifecycle", "shared", "--catalogue-setup", "reuse"],
        [
            "--owner-lifecycle",
            "fresh",
            "--request-order",
            "date-interleaved",
        ],
    ] {
        let args: Vec<_> = common.into_iter().chain(extra).map(String::from).collect();
        assert!(run(&args).unwrap_err().contains("catalogue-setup"));
    }
    assert!(
        run_winner_ceiling(&common.into_iter().map(String::from).collect::<Vec<_>>())
            .unwrap_err()
            .contains("owner-lifecycle")
    );
}
