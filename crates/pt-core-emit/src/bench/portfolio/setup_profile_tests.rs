use super::{tests::fixture_run, *};

fn stable(mut row: Value) -> Value {
    for key in [
        "firstLifecycle",
        "warmupLifecycles",
        "rawLifecycleSamples",
        "rawSamplesMs",
        "p50Ms",
        "p95Ms",
    ] {
        row.as_object_mut().unwrap().remove(key);
    }
    row
}

#[test]
fn setup_profile_preserves_canonical_results_work_failures_and_default_shape() {
    for mode in ["off", "unbounded", "covering-merge"] {
        for (certificate, prefix) in [
            ("duration", "rebuild"),
            ("timetable", "rebuild"),
            ("timetable", "prepared"),
        ] {
            for kind in ["latest-departure", "portfolio"] {
                let mut args = vec![
                    "--validation",
                    "owned-session",
                    "--owner-lifecycle",
                    "fresh",
                    "--pattern-mode",
                    mode,
                    "--prefix-certificate",
                    certificate,
                    "--prefix-setup",
                    prefix,
                    "--suffix-bound",
                    "row-prefix",
                    "--frontier-storage",
                    "event-indexed",
                    "--query-kind",
                    kind,
                    "--iterations",
                    "2",
                    "--warmup",
                    "1",
                ];
                let off = fixture_run(&args);
                assert!(off.get("setupProfile").is_none());
                assert!(off["queries"][0]["firstLifecycle"]
                    .get("setupProfile")
                    .is_none());
                args.extend(["--setup-profile", "phases"]);
                let on = fixture_run(&args);
                assert_eq!(on["setupProfile"], "completion-markers-v1");
                assert_eq!(on["latencyQualification"], false);
                assert_eq!(
                    stable(off["queries"][0].clone()),
                    stable(on["queries"][0].clone())
                );
                let row = &on["queries"][0];
                let phases = std::iter::once(&row["firstLifecycle"])
                    .chain(row["warmupLifecycles"].as_array().unwrap())
                    .chain(row["rawLifecycleSamples"].as_array().unwrap());
                for p in phases {
                    let markers = p["setupProfile"]["markers"].as_array().unwrap();
                    assert_eq!(markers.len(), if prefix == "prepared" { 17 } else { 16 });
                    assert_eq!(markers[0]["phase"], "Started");
                    assert_eq!(markers.last().unwrap()["phase"], "Completed");
                    assert_eq!(markers[14]["phase"], "RequestStored");
                    if prefix == "prepared" {
                        assert_eq!(markers[15]["phase"], "PrefixBuilt");
                    }
                    let times: Vec<_> = markers
                        .iter()
                        .map(|m| m["elapsedMs"].as_f64().unwrap())
                        .collect();
                    assert!(times.iter().all(|t| t.is_finite() && *t >= 0.0));
                    assert!(times.windows(2).all(|t| t[0] <= t[1]));
                    let residual = p["setupProfile"]["outerResidualMs"].as_f64().unwrap();
                    assert!(residual >= 0.0);
                    assert!(
                        (times.last().unwrap() - times[0] + residual
                            - p["sessionPreparationMs"].as_f64().unwrap())
                        .abs()
                            < 1e-8
                    );
                }
                for cap in ["--max-stop-scans", "--max-lookup-work", "--max-states"] {
                    let mut capped = args.clone();
                    capped.extend([cap, "1"]);
                    let on = fixture_run(&capped);
                    capped.extend(["--setup-profile", "off"]);
                    let off = fixture_run(&capped);
                    assert_eq!(on["queries"][0], off["queries"][0]);
                    assert_eq!(on["queries"][0]["status"], "failed");
                    assert_eq!(on["queries"][0].as_object().unwrap().len(), 5);
                }
            }
        }
    }
}

#[test]
fn setup_profile_rejects_invalid_or_non_fresh_policy_before_io() {
    for (lifecycle, profile) in [
        ("fresh", "bad"),
        ("shared", "phases"),
        ("requests", "phases"),
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
            "owned-session",
            "--owner-lifecycle",
            lifecycle,
            "--setup-profile",
            profile,
        ]
        .map(String::from);
        assert!(run(&args).unwrap_err().contains("setup-profile"));
    }
}
