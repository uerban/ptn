//! Cross-language fixture generator using Jiff's pinned bundled timezone data.
//! The unchanged fixture originally generated with chrono-tz freezes the
//! service-day→unix DST compatibility contract across this migration.
//!
//! Emits a JSON OBJECT `{ "forward": [...], "inverse": [...] }` to stdout; the
//! committed fixture is produced by:
//!
//! ```sh
//! cargo run -p pt-serve --example gen_tz_fixture \
//!   > packages/shared/tests/__fixtures__/tz-cases.json
//! ```
//!
//! Each FORWARD case is `{label, tz, ymd, secs, dstKind, expectedUnix}` where:
//! - `ymd` is the integer YYYYMMDD service date.
//! - `secs` is the seconds of the service day (may be <0 or exceed 86400).
//! - `dstKind` ∈ {single, none, ambiguous} labels Jiff's unambiguous/gap/fold kind for
//!   the resolved naive local time. Overnight cases land on a different calendar
//!   day, so their kind is computed at the actual naive instant.
//! - `expectedUnix` is the compatibility value from `service_day_to_unix`.
//!
//! Each INVERSE case is `{label, tz, unixSec, expectedServiceDateYmd,
//! expectedSecsOfServiceDay}` — the Jiff decomposition of an absolute instant
//! into the feed-tz civil date + seconds-since-local-midnight. There is no Rust
//! inverse production fn (the inverse is frontend-only); the bundled-tzdb values
//! are the oracle, asserted by the TS leg's `unixToServiceDay` only.
//!
//! Both differential tests (Rust `tests/time_domain.rs`, TS `timeDomain.test.ts`)
//! assert their implementation reproduces the forward `expectedUnix`; the TS leg
//! additionally asserts the inverse decomposition.
//!
//! The 2026 EU DST transitions are 2026-03-29 (spring-forward) and 2026-10-25
//! (fall-back). Paris/Oslo/Warsaw spring gap is local 02:00→03:00 and the fall
//! overlap is 03:00→02:00; Vilnius is one hour east (gap 03:00→04:00, overlap
//! 04:00→03:00). The gap/overlap cases below pick a wall-clock time that truly
//! lands inside the respective gap/overlap window (verified against zdump).

use jiff::{
    civil::Date,
    tz::{AmbiguousOffset, TimeZone},
    SignedDuration, Timestamp,
};
use pt_serve::domain::time_domain::service_day_to_unix;
use pt_shared::tz::{date_from_ymd, resolve_time_zone};

/// One fixture case before resolution. `dst_kind`/`expected_unix` are computed.
struct Case {
    label: &'static str,
    tz: &'static str,
    ymd: u32,
    secs: i64,
}

/// One inverse fixture case: given an absolute instant, the expected feed-tz
/// civil date + seconds-since-local-midnight.
struct InverseCase {
    label: &'static str,
    tz: &'static str,
    unix_sec: i64,
}

/// Decompose YYYYMMDD into a civil `Date`.
fn ymd_to_date(ymd: u32) -> Date {
    date_from_ymd(ymd).expect("fixture ymd is a valid date")
}

/// Label Jiff's ambiguity kind for the civil local time `date + secs` in `tz`.
fn dst_kind(ymd: u32, secs: i64, tz: &TimeZone) -> &'static str {
    let local = ymd_to_date(ymd)
        .at(0, 0, 0, 0)
        .checked_add(SignedDuration::from_secs(secs))
        .unwrap();
    match tz.to_ambiguous_timestamp(local).offset() {
        AmbiguousOffset::Unambiguous { .. } => "single",
        AmbiguousOffset::Fold { .. } => "ambiguous",
        AmbiguousOffset::Gap { .. } => "none",
    }
}

/// Minimal JSON string escaper (labels/tz are ASCII; escape `"` and `\` only).
fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn main() {
    // Cases: per DST zone a spring gap (none) + fall overlap (ambiguous); a
    // Tbilisi no-DST stable case; two overnight cases (25:30, 27:00); a plain
    // winter single; and the subtle "overnight that lands a VALID wall-clock
    // time a few hours after a spring transition" case (the one a naive ±3h
    // offset sample mis-handles — it must resolve `single`, not snap).
    let cases = [
        // --- spring-forward gaps (dstKind = none) ---
        Case {
            label: "Vilnius spring gap 03:30",
            tz: "Europe/Vilnius",
            ymd: 20260329,
            secs: 3 * 3600 + 30 * 60,
        },
        Case {
            label: "Paris spring gap 02:30",
            tz: "Europe/Paris",
            ymd: 20260329,
            secs: 2 * 3600 + 30 * 60,
        },
        Case {
            label: "Oslo spring gap 02:30",
            tz: "Europe/Oslo",
            ymd: 20260329,
            secs: 2 * 3600 + 30 * 60,
        },
        Case {
            label: "Warsaw spring gap 02:30",
            tz: "Europe/Warsaw",
            ymd: 20260329,
            secs: 2 * 3600 + 30 * 60,
        },
        // --- fall-back overlaps (dstKind = ambiguous) ---
        Case {
            label: "Vilnius fall overlap 03:30",
            tz: "Europe/Vilnius",
            ymd: 20261025,
            secs: 3 * 3600 + 30 * 60,
        },
        Case {
            label: "Paris fall overlap 02:30",
            tz: "Europe/Paris",
            ymd: 20261025,
            secs: 2 * 3600 + 30 * 60,
        },
        Case {
            label: "Oslo fall overlap 02:30",
            tz: "Europe/Oslo",
            ymd: 20261025,
            secs: 2 * 3600 + 30 * 60,
        },
        Case {
            label: "Warsaw fall overlap 02:30",
            tz: "Europe/Warsaw",
            ymd: 20261025,
            secs: 2 * 3600 + 30 * 60,
        },
        // --- no-DST stable zone (single) ---
        Case {
            label: "Tbilisi no-DST noon",
            tz: "Asia/Tbilisi",
            ymd: 20260329,
            secs: 12 * 3600,
        },
        // --- overnight cases (> 86400) ---
        Case {
            label: "Paris overnight 25:30",
            tz: "Europe/Paris",
            ymd: 20260115,
            secs: 25 * 3600 + 30 * 60,
        },
        Case {
            label: "Vilnius overnight 27:00",
            tz: "Europe/Vilnius",
            ymd: 20260115,
            secs: 27 * 3600,
        },
        // --- plain winter single ---
        Case {
            label: "Vilnius winter noon",
            tz: "Europe/Vilnius",
            ymd: 20260115,
            secs: 12 * 3600,
        },
        // --- overnight that lands a VALID post-spring-transition wall clock ---
        // service date 2026-03-28 + 27:30:00 = 2026-03-29 03:30 local (valid,
        // post-gap). Must resolve `single`, NOT snap. This is the case the
        // naive ±3h TS sampling got wrong; it pins the fix.
        Case {
            label: "Paris overnight into valid post-spring",
            tz: "Europe/Paris",
            ymd: 20260328,
            secs: 27 * 3600 + 30 * 60,
        },
        // Negative secs = a pre-midnight time filed under the next service day
        // (e.g. -00:30 = 23:30 the previous evening). Exercises the secs<0 path.
        Case {
            label: "Vilnius pre-midnight -00:30",
            tz: "Europe/Vilnius",
            ymd: 20260115,
            secs: -1800,
        },
    ];

    // ---- forward array (unchanged content) ----
    let mut forward = String::from("[\n");
    for (i, c) in cases.iter().enumerate() {
        let tz = resolve_time_zone(c.tz).expect("fixture tz is a valid IANA name");
        let kind = dst_kind(c.ymd, c.secs, &tz);
        let expected =
            service_day_to_unix(ymd_to_date(c.ymd), c.secs, &tz).expect("oracle projection");
        forward.push_str("    {");
        forward.push_str(&format!("\"label\": \"{}\", ", json_escape(c.label)));
        forward.push_str(&format!("\"tz\": \"{}\", ", json_escape(c.tz)));
        forward.push_str(&format!("\"ymd\": {}, ", c.ymd));
        forward.push_str(&format!("\"secs\": {}, ", c.secs));
        forward.push_str(&format!("\"dstKind\": \"{kind}\", "));
        forward.push_str(&format!("\"expectedUnix\": {expected}"));
        forward.push('}');
        if i + 1 < cases.len() {
            forward.push(',');
        }
        forward.push('\n');
    }
    forward.push_str("  ]");

    // ---- inverse array ---- [R-fold #8] ONE fall-back case (both occurrences decompose
    // identically; the later-occurrence non-round-trip is asserted as a unit test in, not a
    // duplicate fixture row). [R-fold #9] gap-exit case added. [R-fold #20] labels prefixed "inv:"
    // so triage logs never collide with forward labels.
    let inverse_cases = [
        InverseCase {
            label: "inv: Vilnius winter noon",
            tz: "Europe/Vilnius",
            unix_sec: 1768471200,
        },
        // 2026-01-15 23:00 UTC = 2026-01-16 01:00 Vilnius (+02:00) → genuinely
        // cross-civil-date (UTC is the 15th, the feed day is the 16th @ 3600s).
        InverseCase {
            label: "inv: Vilnius late-evening (cross-tz civil date)",
            tz: "Europe/Vilnius",
            unix_sec: 1768518000,
        },
        InverseCase {
            label: "inv: Paris overnight tail 01:30",
            tz: "Europe/Paris",
            unix_sec: 1768523400,
        },
        InverseCase {
            label: "inv: Paris post-spring 03:30",
            tz: "Europe/Paris",
            unix_sec: 1774747800,
        },
        InverseCase {
            label: "inv: Vilnius fall-back 03:30 (earlier)",
            tz: "Europe/Vilnius",
            unix_sec: 1792888200,
        },
        // [R-fold #9] spring gap-exit: 2026-03-29 01:00:00 UTC is the instant the
        // Vilnius clock jumps to 04:00 local (+03:00 EEST). Inverse → {20260329, 14400}.
        InverseCase {
            label: "inv: Vilnius spring gap-exit 04:00",
            tz: "Europe/Vilnius",
            unix_sec: 1774746000,
        },
        InverseCase {
            label: "inv: Tbilisi no-DST noon",
            tz: "Asia/Tbilisi",
            unix_sec: 1774771200,
        },
    ];

    let mut inverse = String::from("[\n");
    for (i, c) in inverse_cases.iter().enumerate() {
        let tz = resolve_time_zone(c.tz).expect("inverse fixture tz is a valid IANA name");
        let local = tz.to_datetime(
            Timestamp::from_second(c.unix_sec).expect("inverse fixture instant is representable"),
        );
        let date = local.date();
        let time = local.time();
        let ymd = (date.year() as i64) * 10000 + (date.month() as i64) * 100 + date.day() as i64;
        let secs = (time.hour() as i64) * 3600 + (time.minute() as i64) * 60 + time.second() as i64;
        inverse.push_str("    {");
        inverse.push_str(&format!("\"label\": \"{}\", ", json_escape(c.label)));
        inverse.push_str(&format!("\"tz\": \"{}\", ", json_escape(c.tz)));
        inverse.push_str(&format!("\"unixSec\": {}, ", c.unix_sec));
        inverse.push_str(&format!("\"expectedServiceDateYmd\": {ymd}, "));
        inverse.push_str(&format!("\"expectedSecsOfServiceDay\": {secs}"));
        inverse.push('}');
        if i + 1 < inverse_cases.len() {
            inverse.push(',');
        }
        inverse.push('\n');
    }
    inverse.push_str("  ]");

    print!("{{\n  \"forward\": {forward},\n  \"inverse\": {inverse}\n}}\n");
}
