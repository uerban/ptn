//! Derive GTFS `transfer_type=4` (in-seat) rules from `block_id` at build time.
//!
//! Modern GTFS: `block_id` alone does NOT imply in-seat continuation; in-seat is
//! declared by `transfers.txt` transfer_type=4. Feeds using the legacy block_id
//! convention (e.g. Vilnius) omit transfers.txt, so we derive conservative type-4
//! rules: consecutive same-block trips that meet at the SAME stop_id with a small
//! layover. The (unchanged) engine then routes them via its shipped type-4 path.
//! GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
//! Design: the block id inseat derivation notes

use crate::pass1::transfers::{TransferRow, ABSENT};
use crate::pass1::TripEndpoint;
use std::collections::HashMap;

/// Max layover for a derived in-seat continuation. Calibrated on committed feeds:
/// 6G's real continuations are all <= 60 s; operational terminal layovers cluster
/// at >= 180 s (e.g. 3G airport). 120 s sits in the gap. See design spec.
pub const MAX_LAYOVER_SECS: u32 = 120;

/// One trip's identity for grouping: post-finalize trip ordinal + its endpoints +
/// block/service keys. `block_id` empty => not blockable (skipped).
#[derive(Debug)]
pub struct TripForDerivation<'a> {
    pub trip_idx: u32,
    pub block_id: &'a str,
    pub service_idx: u32,
    pub ep: TripEndpoint,
}

/// Derive type-4 rows. `existing` is the feed's parsed transfers.txt rows (used to
/// skip a derived rule that duplicates an explicit feed rule for the same trip pair).
/// Caller is responsible for the activation gate (opt-out / "union already has type-4").
pub fn derive_inseat_rules(
    trips: &[TripForDerivation<'_>],
    existing: &[TransferRow],
    max_layover: u32,
) -> Vec<TransferRow> {
    let mut feed_pairs: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    for r in existing {
        if r.from_trip_idx != ABSENT && r.to_trip_idx != ABSENT {
            feed_pairs.insert((r.from_trip_idx, r.to_trip_idx));
        }
    }
    let mut groups: HashMap<(&str, u32), Vec<usize>> = HashMap::new();
    for (i, t) in trips.iter().enumerate() {
        if t.block_id.is_empty() {
            continue;
        }
        if t.ep.first_dep_secs == u32::MAX
            || t.ep.last_arr_secs == u32::MAX
            || t.ep.first_stop_idx == u32::MAX
            || t.ep.last_stop_idx == u32::MAX
        {
            continue;
        }
        groups
            .entry((t.block_id, t.service_idx))
            .or_default()
            .push(i);
    }
    let mut out = Vec::new();
    for (_key, mut members) in groups {
        members.sort_by_key(|&i| (trips[i].ep.first_dep_secs, trips[i].trip_idx));
        for w in members.windows(2) {
            let a = &trips[w[0]];
            let b = &trips[w[1]];
            if a.ep.last_stop_idx != b.ep.first_stop_idx {
                continue;
            }
            let dep = b.ep.first_dep_secs as i64;
            let arr = a.ep.last_arr_secs as i64;
            let layover = dep - arr;
            if layover < 0 || layover > max_layover as i64 {
                continue;
            }
            if feed_pairs.contains(&(a.trip_idx, b.trip_idx)) {
                continue;
            }
            out.push(TransferRow {
                from_stop_idx: a.ep.last_stop_idx,
                to_stop_idx: b.ep.first_stop_idx,
                from_route_idx: ABSENT,
                to_route_idx: ABSENT,
                from_trip_idx: a.trip_idx,
                to_trip_idx: b.trip_idx,
                min_transfer_secs: ABSENT,
                transfer_type: 4,
            });
        }
    }
    out.sort_by_key(|r| (r.from_trip_idx, r.to_trip_idx));
    out
}

/// Build the derivation input from a finalized `Pass1Result` and run the
/// predicate, honoring the activation gate. Returns rows to append (may be
/// empty). Shared by both build flows (`build::build_ptb` for P4 publish and
/// `main::run` for the P3 `--out` path) so the merge logic + auto-disable gate
/// live in one place.
///
/// Activation gate (see the design spec at the top of this file): `Off` derives
/// nothing; `Auto` derives unless the union ALREADY declares any
/// `transfer_type==4` row of its own — a feed that curates its own in-seat
/// rules is respected verbatim, never augmented.
///
/// GTFS reference: <https://gtfs.org/documentation/schedule/reference/#transferstxt>
pub fn derive_for_build(
    p1: &crate::pass1::Pass1Result,
    existing_rows: &[TransferRow],
    mode: crate::cli::DeriveInseat,
) -> Vec<TransferRow> {
    if mode == crate::cli::DeriveInseat::Off {
        return Vec::new();
    }
    // Union-level auto-disable: respect a feed that curates its own in-seat rules.
    if existing_rows.iter().any(|r| r.transfer_type == 4) {
        return Vec::new();
    }
    let trips: Vec<TripForDerivation<'_>> = (0..p1.trips_attrs.len() as u32)
        .map(|ti| TripForDerivation {
            trip_idx: ti,
            block_id: &p1.trips_attrs[ti as usize].block_id,
            service_idx: p1.trips_attrs[ti as usize].service_idx,
            ep: p1.trip_endpoints[ti as usize],
        })
        .collect();
    derive_inseat_rules(&trips, existing_rows, MAX_LAYOVER_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pass1::TripEndpoint;
    fn ep(fs: u32, fd: u32, ls: u32, la: u32) -> TripEndpoint {
        // first_seq/last_seq don't feed the predicate (the sort key is
        // (first_dep_secs, trip_idx)), so they're fixed arbitrarily.
        TripEndpoint {
            first_seq: 1,
            first_stop_idx: fs,
            first_dep_secs: fd,
            last_seq: 9,
            last_stop_idx: ls,
            last_arr_secs: la,
        }
    }
    fn t(idx: u32, blk: &str, svc: u32, e: TripEndpoint) -> TripForDerivation<'_> {
        TripForDerivation {
            trip_idx: idx,
            block_id: blk,
            service_idx: svc,
            ep: e,
        }
    }
    #[test]
    fn emits_for_same_stop_short_layover() {
        let trips = vec![
            t(0, "B", 0, ep(2, 28920, 5, 30540)),
            t(1, "B", 0, ep(5, 30600, 9, 30960)),
        ];
        let rows = derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].from_trip_idx,
                rows[0].to_trip_idx,
                rows[0].transfer_type
            ),
            (0, 1, 4)
        );
        assert_eq!(rows[0].from_stop_idx, 5);
        assert_eq!(rows[0].to_stop_idx, 5);
    }
    #[test]
    fn skips_different_stop_join() {
        let trips = vec![
            t(0, "B", 0, ep(2, 1, 7, 100)),
            t(1, "B", 0, ep(6, 150, 9, 300)),
        ];
        assert!(derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS).is_empty());
    }
    #[test]
    fn skips_over_cap_layover() {
        let trips = vec![
            t(0, "B", 0, ep(2, 1, 5, 100)),
            t(1, "B", 0, ep(5, 100 + 121, 9, 400)),
        ];
        assert!(derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS).is_empty());
    }
    #[test]
    fn skips_negative_layover() {
        let trips = vec![
            t(0, "B", 0, ep(2, 1, 5, 200)),
            t(1, "B", 0, ep(5, 150, 9, 400)),
        ];
        assert!(derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS).is_empty());
    }
    #[test]
    fn chains_three_consecutive() {
        let trips = vec![
            t(0, "B", 0, ep(1, 0, 5, 100)),
            t(1, "B", 0, ep(5, 160, 6, 300)),
            t(2, "B", 0, ep(6, 360, 9, 500)),
        ];
        let rows = derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS);
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].from_trip_idx, rows[0].to_trip_idx), (0, 1));
        assert_eq!((rows[1].from_trip_idx, rows[1].to_trip_idx), (1, 2));
    }
    #[test]
    fn different_service_not_chained() {
        let trips = vec![
            t(0, "B", 0, ep(2, 1, 5, 100)),
            t(1, "B", 9, ep(5, 160, 9, 300)),
        ];
        assert!(derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS).is_empty());
    }
    #[test]
    fn skips_pair_already_declared_by_feed() {
        let trips = vec![
            t(0, "B", 0, ep(2, 1, 5, 100)),
            t(1, "B", 0, ep(5, 160, 9, 300)),
        ];
        let existing = vec![TransferRow {
            from_stop_idx: 5,
            to_stop_idx: 5,
            from_route_idx: ABSENT,
            to_route_idx: ABSENT,
            from_trip_idx: 0,
            to_trip_idx: 1,
            min_transfer_secs: ABSENT,
            transfer_type: 5,
        }];
        assert!(derive_inseat_rules(&trips, &existing, MAX_LAYOVER_SECS).is_empty());
    }
    #[test]
    fn skips_trip_with_unresolved_stop_sentinels() {
        // Valid times but unresolved stops (TripEndpoint default sentinel): the
        // same-stop join would spuriously match (u32::MAX == u32::MAX) and emit a
        // rule with from_stop=to_stop=0xFFFFFFFF — the grouping guard must skip it.
        let bad = TripEndpoint {
            first_seq: 1,
            first_stop_idx: u32::MAX,
            first_dep_secs: 100,
            last_seq: 9,
            last_stop_idx: u32::MAX,
            last_arr_secs: 200,
        };
        let trips = vec![t(0, "B", 0, bad), t(1, "B", 0, bad)];
        assert!(derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS).is_empty());
    }
    #[test]
    fn emits_at_zero_layover() {
        // dep == arr → layover 0; predicate is `> max_layover`, so 0 EMITS.
        let trips = vec![
            t(0, "B", 0, ep(2, 1, 5, 100)),
            t(1, "B", 0, ep(5, 100, 9, 300)),
        ];
        let rows = derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].from_trip_idx, rows[0].to_trip_idx), (0, 1));
    }
    #[test]
    fn emits_at_max_layover() {
        // layover exactly 120s; predicate is `> max_layover`, so 120 EMITS.
        let trips = vec![
            t(0, "B", 0, ep(2, 1, 5, 100)),
            t(1, "B", 0, ep(5, 100 + 120, 9, 400)),
        ];
        let rows = derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].from_trip_idx, rows[0].to_trip_idx), (0, 1));
    }
    #[test]
    fn empty_block_id_skipped() {
        let trips = vec![
            t(0, "", 0, ep(2, 1, 5, 100)),
            t(1, "", 0, ep(5, 160, 9, 300)),
        ];
        assert!(derive_inseat_rules(&trips, &[], MAX_LAYOVER_SECS).is_empty());
    }
}
