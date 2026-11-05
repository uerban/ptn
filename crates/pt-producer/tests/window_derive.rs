//! Producer-side service horizon → `window_days` derivation.
//!
//! The producer derives `window_days` from the feed's own service horizon
//! (`maxEnd` minus the build anchor `feed_start_date`) using the SAME pure
//! `pt_core::window::derive_window_days` the readers decode against. These
//! tests pin the horizon arithmetic + clamp-event mapping at the producer
//! boundary; the bitmask STRIDE that flows from `window_days` is covered in
//! `tests/bitmask.rs`, and the end-to-end `0x01` emit in `tests/window_emit.rs`.

use pt_core::window::WindowClampEvent;
use pt_producer::service::bitmask::{derive_window, ymd_to_julian};

#[test]
fn leap_year_sanity_366_days() {
    // 2028 is a leap year → 2028-01-01 to 2029-01-01 is 366 days. Guards the
    // shared JDN formula the horizon subtraction relies on.
    assert_eq!(ymd_to_julian(20290101) - ymd_to_julian(20280101), 366);
}

#[test]
fn horizon_deriving_ninety_floors_to_default() {
    // anchor 20260518, maxEnd 20260518 (same day) → horizon 0; 0+14=14 < 90 →
    // FlooredLow, window 90.
    let d = derive_window(20260518, 20260518);
    assert_eq!(d.window_days, 90);
    assert_eq!(d.clamp_event, WindowClampEvent::FlooredLow);
}

#[test]
fn horizon_386_derives_exactly_400_no_clamp() {
    // anchor 20260518; maxEnd = anchor + 386 days. 386 + 14 margin = 400 exactly
    // → STRICT `>` means NOT ClampedHigh.
    let anchor = 20260518u32;
    let max_end = julian_plus(anchor, 386);
    let d = derive_window(anchor, max_end);
    assert_eq!(d.window_days, 400);
    assert_eq!(d.clamp_event, WindowClampEvent::None);
}

#[test]
fn horizon_500_clamps_high() {
    // anchor + 500 → 500 + 14 = 514 > 400 → ClampedHigh, window 400.
    let anchor = 20260518u32;
    let max_end = julian_plus(anchor, 500);
    let d = derive_window(anchor, max_end);
    assert_eq!(d.window_days, 400);
    assert_eq!(d.clamp_event, WindowClampEvent::ClampedHigh);
}

#[test]
fn stale_feed_floors_low() {
    // maxEnd precedes the anchor → negative horizon → FlooredLow, window 90,
    // no underflow.
    let anchor = 20260518u32;
    let max_end = 20260101u32; // well before the anchor
    let d = derive_window(anchor, max_end);
    assert_eq!(d.window_days, 90);
    assert_eq!(d.clamp_event, WindowClampEvent::FlooredLow);
}

#[test]
fn empty_fold_sentinel_floors_without_panic() {
    // maxEnd == 0 sentinel (no end dates AND no ADD rows) → must floor to 90,
    // never panic / underflow.
    let d = derive_window(20260518, 0);
    assert_eq!(d.window_days, 90);
    assert_eq!(d.clamp_event, WindowClampEvent::FlooredLow);
}

/// Helper: YYYYMMDD that is `n` days after `anchor`, via the shared JDN round
/// trip (so the test's "+386" matches exactly what the producer computes).
fn julian_plus(anchor: u32, n: i64) -> u32 {
    julian_to_ymd(ymd_to_julian(anchor) + n)
}

/// Inverse of `ymd_to_julian` (Fliegel & Van Flandern). Test-only — the
/// producer never round-trips JDN→YMD, it only ever computes a difference.
fn julian_to_ymd(jdn: i64) -> u32 {
    let l = jdn + 68569;
    let n = (4 * l) / 146097;
    let l = l - (146097 * n + 3) / 4;
    let i = (4000 * (l + 1)) / 1461001;
    let l = l - (1461 * i) / 4 + 31;
    let j = (80 * l) / 2447;
    let d = l - (2447 * j) / 80;
    let l = j / 11;
    let m = j + 2 - 12 * l;
    let y = 100 * (n - 49) + i + l;
    (y as u32) * 10000 + (m as u32) * 100 + (d as u32)
}
