//! Opt-in scalar ordering of already resolved plain incoming records.
//! This does not merge concrete events or infer GTFS transfer permission:
//! https://gtfs.org/documentation/schedule/reference/#transferstxt
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes

use super::{IncomingTransfer, TransferKind};
use crate::engine::v2::rules::ordinary_floor;
use alloc::vec::Vec;

// Fixed before city timing. Keep small arrays on the allocation-free reference
// path; this is an experimental cutoff, not a per-query tuned parameter.
const MIN_PACKED_RECORDS: usize = 32;

/// Returns additional temporary key capacity bytes when packing was used.
/// The original output allocation stays live. No scratch survives this call.
pub(super) fn sort(out: &mut [IncomingTransfer], packed: bool, base: i64) -> Option<usize> {
    if packed {
        if let Some(bytes) = try_sort(out, base) {
            return Some(bytes);
        }
    }
    out.sort_unstable_by_key(|e| (e.source, e.kind, e.walk_secs));
    None
}

/// `base` is the query's minimum transfer, the floor of a plain record.
fn try_sort(out: &mut [IncomingTransfer], base: i64) -> Option<usize> {
    let floor = u32::try_from(ordinary_floor(None, base)?).ok()?;
    if out.len() < MIN_PACKED_RECORDS
        || out.iter().any(|e| {
            e.source > 0x7fff_ffff
                || !matches!(e.kind, TransferKind::SameStop | TransferKind::Footpath)
                || e.elapsed_secs != floor.max(e.walk_secs)
        })
    {
        // No record has been changed, including nonidentical equal-key records
        // with different elapsed time. Their original sorter remains exact.
        return None;
    }
    // 31 source bits, one kind bit and all 32 walking bits. Unsigned order is
    // exactly (source, kind, walk). The validated elapsed field is reconstructible;
    // equal keys therefore imply identical FULL records, not just numeric ties.
    let mut keys: Vec<u64> = out
        .iter()
        .map(|e| ((e.source as u64) << 33) | ((e.kind as u64) << 32) | e.walk_secs as u64)
        .collect();
    let bytes = keys.capacity().saturating_mul(core::mem::size_of::<u64>());
    keys.sort_unstable();
    for (e, key) in out.iter_mut().zip(keys) {
        let walk_secs = key as u32;
        *e = IncomingTransfer {
            source: (key >> 33) as u32,
            kind: if key & (1 << 32) == 0 {
                TransferKind::SameStop
            } else {
                TransferKind::Footpath
            },
            walk_secs,
            elapsed_secs: floor.max(walk_secs),
        };
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::consts::RAPTOR_MIN_TRANSFER_SECS;
    use alloc::vec;

    const BASE: i64 = RAPTOR_MIN_TRANSFER_SECS;

    fn record(source: u32, kind: TransferKind, walk_secs: u32) -> IncomingTransfer {
        IncomingTransfer {
            source,
            kind,
            walk_secs,
            elapsed_secs: u32::try_from(ordinary_floor(None, BASE).unwrap())
                .unwrap()
                .max(walk_secs),
        }
    }

    fn compare(mut rows: Vec<IncomingTransfer>, packed: bool) -> Option<usize> {
        let mut expected = rows.clone();
        expected.sort_unstable_by_key(|e| (e.source, e.kind, e.walk_secs));
        let bytes = sort(&mut rows, packed, BASE);
        assert_eq!(rows, expected); // Includes elapsed and complete equal-key ties.
        bytes
    }

    #[test]
    fn compact_order_is_full_record_identical_at_boundaries_and_equal_keys() {
        for n in [0, 1, 2, 31, 32, 33, 64, 257, 2048] {
            let mut rows: Vec<_> = (0..n)
                .map(|i| {
                    record(
                        if i % 3 == 0 {
                            0x7fff_ffff
                        } else {
                            (i % 8) as u32
                        },
                        if i % 2 == 0 {
                            TransferKind::Footpath
                        } else {
                            TransferKind::SameStop
                        },
                        if i % 7 == 0 { u32::MAX } else { (i % 5) as u32 },
                    )
                })
                .collect();
            for _ in 0..3 {
                assert_eq!(compare(rows.clone(), false), None);
                let bytes = compare(rows.clone(), true);
                assert_eq!(bytes.is_some(), n >= MIN_PACKED_RECORDS);
                if let Some(bytes) = bytes {
                    assert!(bytes >= n * 8);
                }
                rows.reverse();
                rows.rotate_left(n / 3);
            }
        }
    }

    #[test]
    fn compact_order_matches_reference_on_one_thousand_generated_arrays() {
        let mut seed = 0x6dc7_09a5_u32;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for _ in 0..1000 {
            let n = (next() % 512) as usize;
            let rows = (0..n)
                .map(|_| {
                    record(
                        next() & 0x7fff_ffff,
                        if next() & 1 == 0 {
                            TransferKind::SameStop
                        } else {
                            TransferKind::Footpath
                        },
                        next(),
                    )
                })
                .collect();
            assert_eq!(compare(rows, true).is_some(), n >= MIN_PACKED_RECORDS);
        }
    }

    #[test]
    fn unsupported_records_fall_back_without_partial_mutation_or_elapsed_loss() {
        let good = record(7, TransferKind::Footpath, 0);
        let mut unsupported = vec![
            record(1 << 31, TransferKind::SameStop, 0),
            record(u32::MAX, TransferKind::Footpath, u32::MAX),
        ];
        for kind in [
            TransferKind::Synthetic,
            TransferKind::Linked,
            TransferKind::InSeat,
            TransferKind::Derived,
        ] {
            unsupported.push(record(7, kind, 0));
        }
        let mut different_elapsed = good;
        different_elapsed.elapsed_secs = different_elapsed.elapsed_secs.saturating_add(1);
        unsupported.push(different_elapsed);
        for bad in unsupported {
            let mut rows = vec![good; 64];
            rows[17] = bad;
            rows[40] = record(3, TransferKind::SameStop, u32::MAX);
            let original = rows.clone();
            assert_eq!(try_sort(&mut rows, BASE), None);
            assert_eq!(rows, original);
            assert_eq!(compare(rows, true), None);
        }
    }
}
