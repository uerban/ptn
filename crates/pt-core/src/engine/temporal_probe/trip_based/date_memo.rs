//! Exact, request-local civil-date projection, not service-day inference.
//! After-midnight GTFS times retain their original service day:
//! https://gtfs.org/documentation/schedule/reference/#field-types

use core::cell::Cell;

#[derive(Clone, Copy)]
struct Entry {
    anchor: u32,
    ordinal: u32,
    date: u32,
}

/// Four fixed slots, no allocation or cross-query lifetime. Complete keys make
/// collisions and changes of feed anchor harmless: both take the original path.
#[derive(Default)]
pub(super) struct WitnessDateMemo {
    slots: [Cell<Option<Entry>>; 4],
}

impl WitnessDateMemo {
    #[inline]
    pub(super) fn date(&self, anchor: u32, ordinal: u32) -> u32 {
        self.date_with(anchor, ordinal, crate::reader::days_add)
    }

    #[inline]
    fn date_with(&self, anchor: u32, ordinal: u32, convert: impl FnOnce(u32, i64) -> u32) -> u32 {
        let slot = &self.slots[(ordinal & 3) as usize];
        if let Some(entry) = slot.get() {
            if (entry.anchor, entry.ordinal) == (anchor, ordinal) {
                return entry.date;
            }
        }
        let date = convert(anchor, ordinal as i64);
        slot.set(Some(Entry {
            anchor,
            ordinal,
            date,
        }));
        date
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_keys_hit_but_collisions_and_anchor_changes_recompute() {
        let memo = WitnessDateMemo::default();
        let calls = Cell::new(0);
        let convert = |anchor, ordinal| {
            calls.set(calls.get() + 1);
            crate::reader::days_add(anchor, ordinal)
        };
        for _ in 0..10 {
            assert_eq!(memo.date_with(20240228, 1, convert), 20240229);
        }
        assert_eq!(calls.get(), 1);
        assert_eq!(memo.date_with(20240228, 5, convert), 20240304);
        assert_eq!(memo.date_with(20240228, 1, convert), 20240229);
        assert_eq!(memo.date_with(20250228, 1, convert), 20250301);
        assert_eq!(calls.get(), 4);
        let fresh = WitnessDateMemo::default();
        assert_eq!(fresh.date_with(20250228, 1, convert), 20250301);
        assert_eq!(calls.get(), 5);
        assert_eq!(core::mem::size_of::<WitnessDateMemo>(), 64);
    }

    #[test]
    fn calendar_boundaries_and_alternating_ordinals_match_the_pure_oracle() {
        let memo = WitnessDateMemo::default();
        for anchor in [20231231, 20240228, 20240301, 20241231, 20250228, 20261024] {
            for ordinal in (0..1024)
                .chain((0..1024).rev())
                .chain([0, 4, 8, 0, 1, 5, 1])
            {
                assert_eq!(
                    memo.date(anchor, ordinal),
                    crate::reader::days_add(anchor, ordinal as i64)
                );
            }
        }
    }
}
