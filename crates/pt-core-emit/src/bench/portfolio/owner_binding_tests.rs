use super::{tests::fixture_run, *};

fn stable(mut q: Value) -> Value {
    for k in [
        "firstLifecycle",
        "warmupLifecycles",
        "rawLifecycleSamples",
        "rawSamplesMs",
        "p50Ms",
        "p95Ms",
        "eventBuildMs",
        "firstCallMs",
        "preparationPlusFirstCallMs",
        "prepareP50Ms",
        "prepareP95Ms",
        "rawPrepareSamplesMs",
        "rawSearchSamplesMs",
        "searchP50Ms",
        "searchP95Ms",
        "sessionPreparationMs",
    ] {
        q.as_object_mut().unwrap().remove(k);
    }
    if let Some(prefix) = q.get_mut("prefixSetup") {
        prefix.as_object_mut().unwrap().remove("retirementMs");
        prefix
            .as_object_mut()
            .unwrap()
            .remove("preparationFirstCallAndRetirementMs");
    }
    q
}

#[test]
fn owner_binding_cli_keeps_canonical_work_errors_and_reports_owner_costs_in_all_modes() {
    for mode in ["off", "unbounded", "covering-merge"] {
        for lifecycle in ["shared", "fresh"] {
            for (certificate, prefix) in [
                ("duration", "rebuild"),
                ("timetable", "rebuild"),
                ("timetable", "prepared"),
            ] {
                for goal in ["latest-departure", "portfolio"] {
                    let mut args = vec![
                        "--pattern-mode",
                        mode,
                        "--owner-lifecycle",
                        lifecycle,
                        "--validation",
                        "owned-session",
                        "--prefix-certificate",
                        certificate,
                        "--prefix-setup",
                        prefix,
                        "--query-kind",
                        goal,
                        "--suffix-bound",
                        "row-prefix",
                        "--frontier-storage",
                        "event-indexed",
                        "--iterations",
                        "2",
                        "--warmup",
                        "1",
                    ];
                    let off = fixture_run(&args);
                    assert!(off.get("ownerBinding").is_none());
                    args.extend(["--owner-binding", "retained"]);
                    let on = fixture_run(&args);
                    assert_eq!(on["ownerBinding"], "immutable-owner-v1");
                    assert!(
                        on["ownerStorageBytes"].as_u64().unwrap()
                            > on["bindingSlotBytes"].as_u64().unwrap()
                    );
                    assert_eq!(
                        stable(off["queries"][0].clone()),
                        stable(on["queries"][0].clone())
                    );
                    if lifecycle == "fresh" {
                        let q = &on["queries"][0];
                        for p in std::iter::once(&q["firstLifecycle"])
                            .chain(q["warmupLifecycles"].as_array().unwrap())
                            .chain(q["rawLifecycleSamples"].as_array().unwrap())
                        {
                            assert_eq!(p["ownerBinding"]["ownerBytes"], on["ownerStorageBytes"]);
                            assert_eq!(p["ownerBinding"]["slotBytes"], on["bindingSlotBytes"]);
                            assert!(
                                p["ownerBinding"]["populatedDigestBytes"].as_u64().unwrap() > 0
                            );
                            assert_eq!(p["ownerBinding"]["heapBytes"], 0);
                            assert_eq!(p["ownerBinding"]["hashConstructions"], 1);
                            assert!(p["constructorMs"].as_f64().unwrap() > 0.0);
                        }
                        args.extend(["--setup-profile", "phases"]);
                        let profiled = fixture_run(&args);
                        let markers = profiled["queries"][0]["firstLifecycle"]["setupProfile"]
                            ["markers"]
                            .as_array()
                            .unwrap();
                        assert!(markers
                            .iter()
                            .any(|m| m["phase"] == "ImmutableBindingReused"));
                        for name in ["PtbHashed", "TransfersHashed", "LayoutHashed"] {
                            assert!(!markers.iter().any(|m| m["phase"] == name));
                        }
                    }
                    for cap in ["--max-stop-scans", "--max-lookup-work", "--max-states"] {
                        let mut capped = args.clone();
                        capped.extend([cap, "1"]);
                        let on = fixture_run(&capped);
                        capped.extend(["--owner-binding", "recompute"]);
                        let off = fixture_run(&capped);
                        assert_eq!(on["queries"][0], off["queries"][0]);
                        assert_eq!(on["queries"][0]["status"], "failed");
                    }
                }
            }
        }
    }
}

#[test]
fn owner_binding_cli_rejects_wrong_policy_before_io() {
    for (lifecycle, validation, kind, binding) in [
        ("shared", "owned-session", "portfolio", "bad"),
        ("requests", "owned-session", "portfolio", "retained"),
        ("shared", "checked", "portfolio", "retained"),
        ("shared", "owned-session", "profile", "retained"),
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
            "--validation",
            validation,
            "--owner-lifecycle",
            lifecycle,
            "--query-kind",
            kind,
            "--owner-binding",
            binding,
        ]
        .map(String::from);
        let e = run(&args).unwrap_err();
        assert!(
            e.contains("owner-binding") || e.contains("validation"),
            "{e}"
        );
    }
}
