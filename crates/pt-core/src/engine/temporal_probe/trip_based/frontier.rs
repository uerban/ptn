//! Representation-only lookup by concrete event ID, not physical stop or trip.
//! Distinct loop occurrences and frequency/date instances retain separate bags.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt

use alloc::{collections::BTreeMap, vec, vec::Vec};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DeadlineFrontierStorage {
    #[default]
    Tree,
    EventIndexed,
}
impl DeadlineFrontierStorage {
    pub fn name(self) -> &'static str {
        match self {
            Self::Tree => "tree",
            Self::EventIndexed => "event-indexed",
        }
    }
}

/// Retained allocation capacities, not peak heap or RSS. Tree node/header
/// allocation is unspecified, so record_capacity_bytes is None for the tree,
/// not zero. Allocator overhead and the enum's inline storage are excluded.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DeadlineFrontierStats {
    pub directory_entries: usize,
    pub directory_capacity_bytes: usize,
    pub records: usize,
    pub record_capacity_bytes: Option<usize>,
    pub retained_ids: usize,
    pub id_capacity_bytes: usize,
}

pub(super) enum Frontiers {
    Tree(BTreeMap<u32, Vec<usize>>),
    EventIndexed {
        directory: Vec<usize>,
        records: Vec<Vec<usize>>,
    },
}
impl Frontiers {
    pub fn new(storage: DeadlineFrontierStorage, events: usize) -> Self {
        match storage {
            DeadlineFrontierStorage::Tree => Self::Tree(BTreeMap::new()),
            DeadlineFrontierStorage::EventIndexed => Self::EventIndexed {
                directory: vec![usize::MAX; events],
                records: Vec::new(),
            },
        }
    }

    pub fn get(&self, event: &u32) -> Option<&Vec<usize>> {
        match self {
            Self::Tree(tree) => tree.get(event),
            Self::EventIndexed { directory, records } => {
                let slot = directory[*event as usize];
                (slot != usize::MAX).then(|| &records[slot])
            }
        }
    }

    pub fn get_or_default(&mut self, event: u32) -> &mut Vec<usize> {
        match self {
            Self::Tree(tree) => tree.entry(event).or_default(),
            Self::EventIndexed { directory, records } => {
                let slot = &mut directory[event as usize];
                if *slot == usize::MAX {
                    *slot = records.len();
                    records.push(Vec::new());
                }
                &mut records[*slot]
            }
        }
    }

    pub fn stats(&self) -> DeadlineFrontierStats {
        let mut stats = DeadlineFrontierStats::default();
        let mut add = |ids: &Vec<usize>| {
            stats.retained_ids += ids.len();
            stats.id_capacity_bytes += ids.capacity() * core::mem::size_of::<usize>();
        };
        match self {
            Self::Tree(tree) => {
                for ids in tree.values() {
                    add(ids);
                }
                stats.records = tree.len();
            }
            Self::EventIndexed { directory, records } => {
                for ids in records {
                    add(ids);
                }
                stats.records = records.len();
                stats.directory_entries = directory.len();
                stats.directory_capacity_bytes =
                    directory.capacity() * core::mem::size_of::<usize>();
                stats.record_capacity_bytes =
                    Some(records.capacity() * core::mem::size_of::<Vec<usize>>());
            }
        }
        stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_directory_charges_all_events_without_allocating_bags() {
        assert_eq!(
            DeadlineFrontierStorage::default(),
            DeadlineFrontierStorage::Tree
        );
        assert_eq!(
            Frontiers::new(DeadlineFrontierStorage::Tree, 100).stats(),
            DeadlineFrontierStats::default()
        );
        let f = Frontiers::new(DeadlineFrontierStorage::EventIndexed, 100);
        assert_eq!(
            f.stats(),
            DeadlineFrontierStats {
                directory_entries: 100,
                directory_capacity_bytes: 100 * core::mem::size_of::<usize>(),
                record_capacity_bytes: Some(0),
                ..DeadlineFrontierStats::default()
            }
        );
        assert!(f.get(&0).is_none() && f.get(&99).is_none());
        assert_eq!(
            Frontiers::new(DeadlineFrontierStorage::EventIndexed, 0)
                .stats()
                .directory_capacity_bytes,
            0
        );
    }

    #[test]
    fn first_last_and_repeated_events_keep_distinct_ordered_bags() {
        for storage in [
            DeadlineFrontierStorage::Tree,
            DeadlineFrontierStorage::EventIndexed,
        ] {
            let mut f = Frontiers::new(storage, 5);
            f.get_or_default(4).extend([3, 1, 8]);
            f.get_or_default(0).extend([8, 3]);
            f.get_or_default(4).retain(|id| *id != 1);
            f.get_or_default(4).push(9);
            assert_eq!(f.get(&4).unwrap(), &[3, 8, 9]);
            assert_eq!(f.get(&0).unwrap(), &[8, 3]);
            assert!(f.get(&1).is_none());
            let s = f.stats();
            assert_eq!((s.records, s.retained_ids), (2, 5));
            assert!(s.id_capacity_bytes >= 5 * core::mem::size_of::<usize>());
            assert_eq!(
                s.record_capacity_bytes.is_some(),
                storage == DeadlineFrontierStorage::EventIndexed
            );
        }
    }

    #[test]
    fn generated_mutations_match_the_tree_without_aliasing_or_reordering() {
        let mut tree = Frontiers::new(DeadlineFrontierStorage::Tree, 257);
        let mut indexed = Frontiers::new(DeadlineFrontierStorage::EventIndexed, 257);
        let mut random = 0x4652_4f4e_5449_4552u64;
        for i in 0..4096 {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            let event = (random % 257) as u32;
            for f in [&mut tree, &mut indexed] {
                let ids = f.get_or_default(event);
                if random.is_multiple_of(3) {
                    ids.retain(|id| id % 3 != 0);
                } else {
                    ids.push(i);
                }
            }
            for event in 0..257 {
                assert_eq!(tree.get(&event), indexed.get(&event));
            }
            let (a, b) = (tree.stats(), indexed.stats());
            assert_eq!(
                (a.records, a.retained_ids, a.id_capacity_bytes),
                (b.records, b.retained_ids, b.id_capacity_bytes)
            );
        }
    }
}
