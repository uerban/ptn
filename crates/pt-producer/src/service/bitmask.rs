use crate::error::Result;
use crate::pass1::ServiceAttrs;
pub use pt_core::window::WindowClampEvent;
use std::collections::HashMap;

/// 90-day service-window default retained by `Layout::compute` tests. The live
/// window comes from `derive_window` instead of this constant.
pub const SERVICE_WINDOW_DAYS: usize = 90;

/// Convert YYYYMMDD (e.g. `20260518`) to a Julian Day Number using the
/// Fliegel & Van Flandern formula. The anchor `JDN(20260518) % 7 == 0`
/// (Mon) holds for this formula, so `jdn(date) % 7` gives the weekday
/// index used by `ServiceAttrs::weekdays` (bit 0 = Mon, ..., bit 6 = Sun).
///
/// If a unit test ever drifts off Monday at day-0, the bug is here in the
/// JDN formula — not in the weekday derivation.
///
/// Public so the window derive (`derive_window`) and its tests use the same
/// civil-date function the bitmask loop uses — the horizon and the bitmask are
/// then guaranteed consistent for every date (incl. structurally-invalid GTFS
/// dates: a garbage YYYYMMDD maps to *some* JDN identically on both sides).
pub fn ymd_to_julian(yyyymmdd: u32) -> i64 {
    let y = (yyyymmdd / 10000) as i64;
    let m = ((yyyymmdd / 100) % 100) as i64;
    let d = (yyyymmdd % 100) as i64;
    let a = (14 - m) / 12;
    let yy = y + 4800 - a;
    let mm = m + 12 * a - 3;
    d + (153 * mm + 2) / 5 + 365 * yy + yy / 4 - yy / 100 + yy / 400 - 32045
}

/// Outcome of the producer-side window derive.
///
/// `window_days` is the value emitted into the `0x01 WindowMeta` region (when
/// `> 90`) AND fed to the layout stride + the bitmask loop — one value, three
/// sites (the I6 invariant). `clamp_event` maps to the counted fidelity warning
/// and `generation.json` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowDerive {
    /// Derived window length in days, already clamped to `[90, 400]`.
    pub window_days: u16,
    /// Which clamp bound (if any) the candidate hit — see `WindowClampEvent`.
    pub clamp_event: WindowClampEvent,
}

/// Derive the service-window length from the build anchor and the feed's
/// service horizon (`maxEnd`), using the SAME `pt_core::window::derive_window_days`
/// the readers decode against (the I2 single-implementation guarantee).
///
/// `feed_start_date` is the finalized build/anchor date (YYYYMMDD); `max_end_date`
/// is the latest `calendar.end_date` OR `calendar_dates` ADD date (YYYYMMDD), or
/// `0` for the empty-fold sentinel (a feed with NO end dates AND NO ADD rows).
///
/// GTFS reference for the exception rows folded into `max_end_date`:
/// https://gtfs.org/documentation/schedule/reference/#calendar_datestxt
/// (`exception_type` 1 = service ADDED — extends the horizon; 2 = REMOVED —
/// does NOT extend it; the REMOVE filtering happens in the producer's pass-1
/// fold, not here).
///
/// Empty-fold: `max_end_date == 0` ⇒ pass a horizon that always floors (`-1`),
/// so a no-horizon feed derives 90 (`FlooredLow`) without date math on the `0`
/// sentinel and without any underflow.
pub fn derive_window(feed_start_date: u32, max_end_date: u32) -> WindowDerive {
    let horizon_days: i64 = if max_end_date == 0 {
        -1 // empty-fold sentinel → candidate -1+14=13 < 90 → FlooredLow
    } else {
        ymd_to_julian(max_end_date) - ymd_to_julian(feed_start_date)
    };
    let (window_days, clamp_event) = pt_core::window::derive_window_days(horizon_days);
    WindowDerive {
        window_days,
        clamp_event,
    }
}

/// Build a `window_days`-day bitmask per service, anchored at `feed_start_date`.
///
/// `window_days` is the derived window from `derive_window`, not
/// the fixed `SERVICE_WINDOW_DAYS` const: the stride is `pt_core::bytes_per_service`
/// so the emitted `0x01 WindowMeta` value and the actual byte stride can never
/// disagree (the I6 invariant — the SAME `window_days` flows here, into the
/// layout, and into the `0x01` emit).
///
/// Day-`i` bit is set iff the service runs on `feed_start_date + i` days:
/// 1. weekday bit of (`feed_start_date + i`) is set in `ServiceAttrs::weekdays`,
///    AND `start_date <= date <= end_date`;
/// 2. unless overridden by `removals` (clears the bit);
/// 3. or set by `additions` (sets the bit even off-weekday).
///
/// Order matters: additions override the weekday rule, removals override
/// additions only when the addition is also in removals (an invalid input
/// — last-writer-wins by index order). The conventional GTFS interpretation
/// applies additions first, then removals.
pub fn compute_service_bitmasks(
    services: &[ServiceAttrs],
    feed_start_date: u32,
    window_days: u16,
) -> Result<Vec<Vec<u8>>> {
    let window_days = window_days as usize;
    let bytes_per_service = pt_core::bytes_per_service(window_days as u16);
    if feed_start_date == 0 {
        return Ok(services
            .iter()
            .map(|_| vec![0u8; bytes_per_service])
            .collect());
    }
    let base_jdn = ymd_to_julian(feed_start_date);
    let mut out = Vec::with_capacity(services.len());
    for s in services {
        let mut mask = vec![0u8; bytes_per_service];
        let start_jdn = if s.start_date != 0 {
            ymd_to_julian(s.start_date)
        } else {
            i64::MIN
        };
        let end_jdn = if s.end_date != 0 {
            ymd_to_julian(s.end_date)
        } else {
            i64::MAX
        };
        let add_jdns: Vec<i64> = s.additions.iter().map(|d| ymd_to_julian(*d)).collect();
        let rem_jdns: Vec<i64> = s.removals.iter().map(|d| ymd_to_julian(*d)).collect();
        for day in 0..window_days {
            let cur = base_jdn + day as i64;
            let weekday = (cur.rem_euclid(7)) as u8;
            let weekday_runs =
                (s.weekdays & (1 << weekday)) != 0 && cur >= start_jdn && cur <= end_jdn;
            let added = add_jdns.contains(&cur);
            let removed = rem_jdns.contains(&cur);
            let runs = (weekday_runs || added) && !removed;
            if runs {
                mask[day / 8] |= 1 << (day % 8);
            }
        }
        out.push(mask);
    }
    Ok(out)
}

/// Deduplicate identical per-service bitfields into a distinct POOL plus a
/// per-service index for the `0x15 ServiceBitfieldPool` / `0x16
/// ServiceToBitfield` storage.
///
/// Returns `(pool, idx, count)`:
/// - `pool` — the distinct bitfields concatenated in FIRST-SEEN order
///   (`count * S` bytes, where `S = masks[i].len()` is the common stride);
/// - `idx` — `masks.len()` u32 pool indices, one per input service, mapping
///   `idx[s]` back to the pool slice `pool[idx[s]*S .. idx[s]*S + S]`;
/// - `count` — the number of distinct bitfields (`pool.len() / S`).
///
/// Invariants (the format hinges on these — see `tests/bitmask.rs`):
/// - **Round-trip (I6):** for every `s`, `pool[idx[s]*S .. +S] == masks[s]`.
/// - **All-distinct identity (I7):** when every input is distinct, `count ==
///   N`, `idx == 0..N`, and `pool` is the input-order concatenation.
/// - **Determinism (I5):** the result is a pure function of input ORDER —
///   independent of the internal map type, because a HIT never mutates the
///   pool/order, only the LOOKUP table.
///
/// Allocation discipline: the full `S`-byte bitfield is cloned **only on a
/// FIRST-SEEN miss** (it becomes both the map key and the appended pool body).
/// A repeat (HIT) pushes the cached index with NO clone of the bitfield bytes,
/// so a feed where most services share a calendar pays one clone per *distinct*
/// bitfield, not per service.
///
/// An empty input yields `(vec![], vec![], 0)`. A lone all-zero bitfield is a
/// valid distinct entry (NOT dropped) — emptiness of the bitfield is never a
/// dedup signal.
pub fn dedup_service_bitfields(masks: &[Vec<u8>]) -> (Vec<u8>, Vec<u32>, u32) {
    let mut seen: HashMap<Vec<u8>, u32> = HashMap::with_capacity(masks.len());
    let mut pool: Vec<u8> = Vec::new();
    let mut idx: Vec<u32> = Vec::with_capacity(masks.len());
    let mut count: u32 = 0;
    for m in masks {
        if let Some(&i) = seen.get(m) {
            // HIT: reuse the existing pool slot — no clone of the S-byte body.
            idx.push(i);
        } else {
            // FIRST-SEEN: the single clone — key + appended pool body.
            let n = count;
            seen.insert(m.clone(), n);
            pool.extend_from_slice(m);
            count += 1;
            idx.push(n);
        }
    }
    (pool, idx, count)
}
