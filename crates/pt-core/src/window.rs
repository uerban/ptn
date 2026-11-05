//! `windowDays` derive + service-bitmask stride helpers (`no_std`-clean, pure).
//!
//! The producer emits the service bitmask over a window of `windowDays` days
//! anchored at `feedStartDate`. The window length is no longer hard-coded at a
//! fixed 90 days: it is derived from the feed's own service horizon so
//! short feeds shrink the bitmask and long-horizon feeds (e.g. a 316-day Vilnius
//! snapshot) are not truncated. The derived length is carried in the `0x01
//! WindowMeta` region (`docs/ptb-region-ids.md` §4, FROZEN registry; an absent
//! region decodes to `WINDOW_DEFAULT_DAYS`).
//!
//! Everything here is PURE INTEGER arithmetic: `derive_window_days` takes a
//! PRECOMPUTED `horizon_days` and does NO date math, so it cannot diverge from
//! whatever civil-date function the producer uses to compute the horizon (the
//! producer derives `horizon_days` from `feedStartDate`/last service day via
//! `ymd_to_julian`). There is deliberately no `days_from_civil` copy here.

use crate::{WINDOW_HARD_CEILING, WINDOW_MARGIN_DAYS, WINDOW_MIN_FLOOR};

/// Which clamp bound (if any) the derived window hit. Reported alongside the
/// window so the producer can surface a one-line diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowClampEvent {
    /// `horizon_days + margin` was inside `[MIN_FLOOR, HARD_CEILING]` (inclusive
    /// of both bounds — the comparisons are STRICT).
    None,
    /// Candidate was below `WINDOW_MIN_FLOOR`; window raised to the floor.
    FlooredLow,
    /// Candidate was above `WINDOW_HARD_CEILING`; window capped at the ceiling.
    ClampedHigh,
}

/// Derive the service-window length (in days) from a precomputed service
/// horizon, applying the safety margin then clamping into
/// `[WINDOW_MIN_FLOOR, WINDOW_HARD_CEILING]`.
///
/// `horizon_days` is an `i64` (signed) so a stale snapshot whose last service
/// day precedes the anchor — a NEGATIVE horizon — flows through without
/// underflow; it floors to `WINDOW_MIN_FLOOR`. The clamp decision is made on the
/// `i64` candidate BEFORE any narrowing cast, and the comparisons are STRICT, so
/// a candidate exactly equal to a bound reports `None` (not a clamp event).
pub fn derive_window_days(horizon_days: i64) -> (u16, WindowClampEvent) {
    let candidate: i64 = horizon_days + WINDOW_MARGIN_DAYS;
    let event = if candidate > WINDOW_HARD_CEILING as i64 {
        WindowClampEvent::ClampedHigh
    } else if candidate < WINDOW_MIN_FLOOR as i64 {
        WindowClampEvent::FlooredLow
    } else {
        WindowClampEvent::None
    };
    let window: u16 = candidate.clamp(WINDOW_MIN_FLOOR as i64, WINDOW_HARD_CEILING as i64) as u16;
    (window, event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bytes_per_service, WINDOW_DEFAULT_DAYS};

    #[test]
    fn vilnius_class_horizon_no_clamp() {
        // 316 + 14 margin = 330, inside [90, 400].
        assert_eq!(derive_window_days(316), (330, WindowClampEvent::None));
    }

    #[test]
    fn overshoot_clamps_high() {
        // 500 + 14 = 514 > 400.
        assert_eq!(
            derive_window_days(500),
            (400, WindowClampEvent::ClampedHigh)
        );
    }

    #[test]
    fn candidate_exactly_ceiling_is_not_clamped() {
        // 386 + 14 = 400 exactly → strict `>` means NOT ClampedHigh.
        // (This is the case the 400-day cross-parity fixture lands on.)
        assert_eq!(derive_window_days(386), (400, WindowClampEvent::None));
    }

    #[test]
    fn candidate_exactly_floor_is_not_floored() {
        // 76 + 14 = 90 exactly → strict `<` means NOT FlooredLow.
        assert_eq!(derive_window_days(76), (90, WindowClampEvent::None));
    }

    #[test]
    fn short_feed_floors_low() {
        // 60 + 14 = 74 < 90.
        assert_eq!(derive_window_days(60), (90, WindowClampEvent::FlooredLow));
    }

    #[test]
    fn negative_horizon_floors_without_underflow() {
        // Tricity stale snapshot: last service day precedes the anchor.
        // -8 + 14 = 6 < 90 → FlooredLow. The intermediate horizon is a real -8
        // in i64, NOT wrapped to ~4.29e9 (no u32 underflow).
        let horizon_days: i64 = -8;
        assert_eq!(horizon_days, -8);
        assert!(horizon_days < 0);
        assert_eq!(
            derive_window_days(horizon_days),
            (90, WindowClampEvent::FlooredLow)
        );
    }

    #[test]
    fn stride_matches_ceil_div_8() {
        assert_eq!(bytes_per_service(90), 12);
        assert_eq!(bytes_per_service(400), 50);
        assert_eq!(bytes_per_service(330), 42);
    }

    #[test]
    fn default_days_is_ninety() {
        assert_eq!(WINDOW_DEFAULT_DAYS, 90);
        assert_eq!(bytes_per_service(WINDOW_DEFAULT_DAYS), 12);
    }
}
