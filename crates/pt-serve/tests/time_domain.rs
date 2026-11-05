//! Rust leg of the service-day→unix DST differential gate.
//!
//! Reads the committed cross-language fixture `tz-cases.json` (originally
//! produced with chrono-tz, now regenerated without changes using Jiff) and asserts that
//! `pt_serve::domain::time_domain::service_day_to_unix` reproduces it for every
//! case. The TS leg (`packages/shared/src/time/__tests__/timeDomain.test.ts`)
//! asserts the same fixture against the JS mirror; the CI gate
//! (`.github/workflows/tz-differential.yml`) requires BOTH summary lines and an
//! exact case count.
//!
//! Also asserts that for non-overnight cases (`secs < 86400`) the labelled
//! `dstKind` is the one Jiff actually produces — a stale fixture whose
//! `dstKind` no longer matches the tzdb would fail here rather than silently
//! weakening the gap/overlap coverage.

use jiff::{civil::Date, tz::AmbiguousOffset, SignedDuration};
use pt_serve::domain::time_domain::service_day_to_unix;
use pt_shared::tz::{date_from_ymd, resolve_time_zone};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TzCase {
    label: String,
    tz: String,
    ymd: u32,
    secs: i64,
    dst_kind: String,
    expected_unix: i64,
}

// Deserialize-only: the inverse fixture is consumed by the TS leg
// (`timeDomain.test.ts`). There is NO Rust inverse leg ([R-fold #7]: pt-serve
// has no inverse production fn, so a Rust "inverse leg" would be Jiff
// recomputing Jiff — tautological). The Rust test parses the object only so
// the forward leg keeps working and asserts the inverse array is non-empty;
// the individual fields are never read here, hence `allow(dead_code)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct TzInverseCase {
    label: String,
    tz: String,
    unix_sec: i64,
    expected_service_date_ymd: i64,
    expected_secs_of_service_day: i64,
}

#[derive(Debug, Deserialize)]
struct Fixture {
    forward: Vec<TzCase>,
    inverse: Vec<TzInverseCase>,
}

fn ymd_to_date(ymd: u32) -> Date {
    date_from_ymd(ymd).expect("fixture ymd is a valid date")
}

#[test]
fn tz_differential_rust() {
    let fixture = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/tests/__fixtures__/tz-cases.json"
    ));
    let parsed: Fixture = serde_json::from_str(fixture).expect("parse tz-cases.json");
    let cases = &parsed.forward;
    assert!(!cases.is_empty(), "forward fixture must not be empty");
    assert!(
        !parsed.inverse.is_empty(),
        "inverse fixture must not be empty"
    );

    let mut mismatch = 0usize;
    for c in cases {
        let tz =
            resolve_time_zone(&c.tz).unwrap_or_else(|_| panic!("bad IANA in fixture: {}", c.tz));

        // For non-overnight cases the labelled dstKind must match Jiff's
        // actual classification at the naive local time. (Overnight cases land
        // on a later calendar day, so their kind is computed at the real naive
        // instant and asserted the same way.)
        let local = ymd_to_date(c.ymd)
            .at(0, 0, 0, 0)
            .checked_add(SignedDuration::from_secs(c.secs))
            .unwrap();
        let actual_kind = match tz.to_ambiguous_timestamp(local).offset() {
            AmbiguousOffset::Unambiguous { .. } => "single",
            AmbiguousOffset::Fold { .. } => "ambiguous",
            AmbiguousOffset::Gap { .. } => "none",
        };
        assert_eq!(
            actual_kind, c.dst_kind,
            "dstKind mismatch for '{}': fixture says {}, Jiff says {}",
            c.label, c.dst_kind, actual_kind
        );

        let got = service_day_to_unix(ymd_to_date(c.ymd), c.secs, &tz)
            .unwrap_or_else(|e| panic!("service_day_to_unix errored for '{}': {:?}", c.label, e));
        if got != c.expected_unix {
            eprintln!(
                "MISMATCH '{}': got {}, expected {}",
                c.label, got, c.expected_unix
            );
            mismatch += 1;
        }
    }

    println!(
        "tz-differential-rust: {} cases compared, {} mismatch",
        cases.len(),
        mismatch
    );
    assert_eq!(
        mismatch, 0,
        "Rust disagrees with the chrono-tz oracle fixture"
    );
}
