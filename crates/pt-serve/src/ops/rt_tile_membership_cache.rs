//! Epoch-gated, entry-count-bounded LRU cache over decoded schedule-tile
//! trip membership — the rtTile 3b overlay route's "which trip ids touch
//! this tile" cache. Port of Node's plain `Map<string,string[]>` membership
//! cache in `packages/backend/src/routes/rtTile.ts:51-68,180-190` (capped at
//! `RT_TILE_LRU_SIZE = 4096` entries, manual FIFO eviction).
//!
//! Structurally identical to [`crate::ops::tile_cache::TileCache`]'s
//! epoch-gated race-safety design (see that module's "Generation-race
//! safety" doc for the full rationale) — gate on [`Generation::epoch`], not
//! the opaque bundle hash, forward-only, never roll the cache backward. NOT
//! generified to share code with `TileCache`: that type is reviewed and
//! shipped (3a); duplicating a small, well-understood pattern is lower risk
//! than widening its shape for one more caller. The only real difference is
//! the value type and the eviction bound (entry COUNT here, matching Node;
//! byte budget there).

use indexmap::IndexMap;
use std::sync::{Arc, Mutex};

/// Matches Node's `RT_TILE_LRU_SIZE` (`rtTile.ts:56`).
pub const DEFAULT_MAX_ENTRIES: u64 = 4096;

struct Inner {
    entries: IndexMap<String, Arc<[String]>>,
    /// See `TileCache`'s "Generation-race safety" doc — same forward-only
    /// gating, same rationale.
    epoch: Option<u64>,
}

pub struct TripMembershipCache {
    inner: Mutex<Inner>,
    max_entries: u64,
}

impl TripMembershipCache {
    pub fn new(max_entries: u64) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: IndexMap::new(),
                epoch: None,
            }),
            max_entries,
        }
    }

    fn ensure_generation_locked(inner: &mut Inner, epoch: u64) {
        let is_newer = match inner.epoch {
            None => true,
            Some(current) => epoch > current,
        };
        if !is_newer {
            return;
        }
        inner.epoch = Some(epoch);
        inner.entries.clear();
    }

    /// Lookup + recency refresh. `None` on a genuine miss AND when `epoch`
    /// is older than the generation the cache currently holds (see
    /// `TileCache::get`'s identical reasoning).
    pub fn get(&self, epoch: u64, key: &str) -> Option<Arc<[String]>> {
        let mut inner = self.inner.lock().expect("membership cache mutex poisoned");
        Self::ensure_generation_locked(&mut inner, epoch);
        if inner.epoch != Some(epoch) {
            return None;
        }
        let hit = inner.entries.shift_remove(key)?;
        inner.entries.insert(key.to_string(), Arc::clone(&hit));
        Some(hit)
    }

    /// Insert, evicting oldest-inserted entries once over the entry-count
    /// cap. A write from an epoch older than what the cache currently
    /// holds is silently dropped — same race-safety guard as `TileCache::set`.
    ///
    /// Deliberately no "never evict what was just inserted" guard here
    /// (unlike `TileCache::set`, which needs one for its byte-budget edge
    /// cases) — verified against Node's own membership-cache eviction loop
    /// (`rtTile.ts:184-188`), which has none either. `max_entries == 0`
    /// therefore evicts the just-inserted entry too, i.e. an always-empty
    /// cache — the intended "disabled" behavior for the potato profile,
    /// matching Node's real (if pathological) behavior at that config value.
    pub fn set(&self, epoch: u64, key: String, trip_ids: Arc<[String]>) {
        let mut inner = self.inner.lock().expect("membership cache mutex poisoned");
        Self::ensure_generation_locked(&mut inner, epoch);
        if inner.epoch != Some(epoch) {
            return;
        }
        inner.entries.shift_remove(&key);
        inner.entries.insert(key, trip_ids);
        while inner.entries.len() as u64 > self.max_entries {
            let Some((oldest_key, _)) = inner.entries.first() else {
                break;
            };
            let oldest_key = oldest_key.clone();
            inner.entries.shift_remove(&oldest_key);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("membership cache mutex poisoned")
            .entries
            .len()
    }
}

impl Default for TripMembershipCache {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_ENTRIES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(strs: &[&str]) -> Arc<[String]> {
        strs.iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .into()
    }

    #[test]
    fn get_miss_on_empty_cache() {
        let c = TripMembershipCache::new(10);
        assert!(c.get(1, "a").is_none());
    }

    #[test]
    fn set_then_get_roundtrips() {
        let c = TripMembershipCache::new(10);
        c.set(1, "a".to_string(), ids(&["T1", "T2"]));
        let hit = c.get(1, "a").expect("hit");
        assert_eq!(&*hit, &[String::from("T1"), String::from("T2")]);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn eviction_removes_oldest_inserted_first_over_entry_count_cap() {
        let c = TripMembershipCache::new(2);
        c.set(1, "a".to_string(), ids(&["T1"]));
        c.set(1, "b".to_string(), ids(&["T2"]));
        c.set(1, "c".to_string(), ids(&["T3"])); // over cap -> evict "a"
        assert!(c.get(1, "a").is_none());
        assert!(c.get(1, "b").is_some());
        assert!(c.get(1, "c").is_some());
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn get_refreshes_recency_so_it_survives_eviction() {
        let c = TripMembershipCache::new(2);
        c.set(1, "a".to_string(), ids(&["T1"]));
        c.set(1, "b".to_string(), ids(&["T2"]));
        assert!(c.get(1, "a").is_some()); // touch "a"
        c.set(1, "c".to_string(), ids(&["T3"])); // evicts oldest = "b"
        assert!(c.get(1, "b").is_none());
        assert!(c.get(1, "a").is_some());
        assert!(c.get(1, "c").is_some());
    }

    #[test]
    fn newer_epoch_purges_wholesale() {
        let c = TripMembershipCache::new(10);
        c.set(1, "a".to_string(), ids(&["T1"]));
        c.set(2, "b".to_string(), ids(&["T2"]));
        assert!(c.get(2, "a").is_none());
        assert!(c.get(2, "b").is_some());
        assert_eq!(c.len(), 1);
    }

    /// Same race class `TileCache` was fixed to close: a slow request for a
    /// superseded generation must not corrupt the newer generation's cache.
    #[test]
    fn late_write_from_superseded_generation_is_dropped() {
        let c = TripMembershipCache::new(10);
        assert!(c.get(1, "key").is_none()); // adopts epoch 1
        c.set(2, "key".to_string(), ids(&["FROM_B"])); // B rolls in first
        c.set(1, "key".to_string(), ids(&["FROM_A_STALE"])); // late A write
        let hit = c.get(2, "key").expect("B's entry survives");
        assert_eq!(&*hit, &[String::from("FROM_B")]);
    }

    #[test]
    fn stale_epoch_get_does_not_roll_cache_backward() {
        let c = TripMembershipCache::new(10);
        c.set(2, "key".to_string(), ids(&["T1"]));
        assert!(c.get(1, "other-key").is_none());
        assert!(c.get(2, "key").is_some());
    }

    /// `max_entries == 0` is the potato profile's "disable this cache"
    /// knob — must evict even the entry just inserted, ending up always
    /// empty (matches Node's real, if pathological, behavior at this
    /// config value — see the doc on `set`).
    #[test]
    fn zero_max_entries_is_always_empty() {
        let c = TripMembershipCache::new(0);
        c.set(1, "a".to_string(), ids(&["T1"]));
        assert!(c.get(1, "a").is_none());
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn default_uses_4096_entry_budget() {
        let c = TripMembershipCache::default();
        assert_eq!(c.max_entries, DEFAULT_MAX_ENTRIES);
    }
}
