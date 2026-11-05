//! Byte-bounded, insertion-order LRU over immutable schedule tiles — port of
//! Node's hand-rolled `TileLruCache`
//! (`packages/backend/src/routes/scheduleTile.ts:65-109`). Tiles are
//! content-addressed by `bundleHash`, so entries can never go stale; the
//! only invalidation is the wholesale purge when the served generation
//! rolls, which also keeps the cache single-generation so retired
//! generations never linger in memory until natural eviction.
//!
//! Lives on [`crate::ops::ServerCtx`] (constructed once, generation-swap-
//! independent — same reasoning as `rt: Arc<RtState>`), NOT on `Generation`:
//! Node's cache is likewise constructed once outside the per-request
//! handler and survives across hash rolls (purged, not recreated).
//!
//! A `Mutex` (not `arc-swap`) because this needs real per-request mutation
//! (insert/evict/purge), unlike `RtState`'s immutable-snapshot-swap pattern
//! — the critical section is an `IndexMap` op, never I/O.
//!
//! ## Generation-race safety
//!
//! Gating on `bundleHash` alone (Node's approach, and this crate's original
//! design) is not safe under concurrency: a hot-reload can adopt a NEW
//! generation while an in-flight request for the OLD generation is still
//! mid-disk-read. If that stale request's `set()` lands after the newer
//! generation's roll has already purged and repopulated the cache, it
//! would insert old-generation bytes under a key the new generation also
//! uses — silently serving wrong content. Gating on [`Generation::epoch`]
//! instead (a monotonic counter, unlike the opaque, unordered content hash)
//! lets every read/write reject work from an epoch OLDER than whatever the
//! cache has already observed, without ever rolling the cache backward.
//! Every call site passes `gen.epoch`, not `gen.generation_id`.

use indexmap::IndexMap;
use std::sync::{Arc, Mutex};

/// Default cache budget. Matches Node's `DEFAULT_CACHE_MAX_BYTES`.
/// Configurable via `PT_SERVE_SCHEDULE_TILE_CACHE_MAX_BYTES` (constrained
/// deployments, e.g. the potato profile, can lower or zero it) — unlike
/// Node, which hardcodes it, pt-serve's `--max-rss-bytes` startup guard
/// must be able to reserve for this term (`ops/rss_guard.rs`), so it needs
/// to be a real config value, not a compile-time constant.
pub const DEFAULT_CACHE_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct CachedTile {
    pub bytes: Arc<[u8]>,
    pub etag: String,
}

struct Inner {
    entries: IndexMap<String, CachedTile>,
    bytes: u64,
    /// The [`Generation::epoch`] this cache's contents belong to. `None`
    /// before the first `get`/`set` call. Never moves backward — see the
    /// module-level "Generation-race safety" doc.
    epoch: Option<u64>,
}

pub struct TileCache {
    inner: Mutex<Inner>,
    max_bytes: u64,
}

impl TileCache {
    pub fn new(max_bytes: u64) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: IndexMap::new(),
                bytes: 0,
                epoch: None,
            }),
            max_bytes,
        }
    }

    /// Adopt `epoch` (purge + roll) iff it is STRICTLY NEWER than whatever
    /// the cache currently holds. A call with an epoch older than or equal
    /// to the current one is a no-op here — the caller (`get`/`set`) then
    /// separately checks `inner.epoch == Some(epoch)` to detect "this
    /// request is stale" and act accordingly (miss on read, silent drop on
    /// write) rather than serving or storing on behalf of a superseded
    /// generation.
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
        inner.bytes = 0;
    }

    /// Lookup + recency refresh (moves the hit to the most-recently-used
    /// end) — mirrors `TileLruCache.get`'s delete+re-set. Returns `None`
    /// both on a genuine cache miss AND when `epoch` is older than the
    /// generation the cache currently holds (a stale request must never
    /// read — or, via [`Self::ensure_generation_locked`], re-adopt — an
    /// older generation's state).
    pub fn get(&self, epoch: u64, key: &str) -> Option<CachedTile> {
        let mut inner = self.inner.lock().expect("tile cache mutex poisoned");
        Self::ensure_generation_locked(&mut inner, epoch);
        if inner.epoch != Some(epoch) {
            return None;
        }
        let hit = inner.entries.shift_remove(key)?;
        inner.entries.insert(key.to_string(), hit.clone());
        Some(hit)
    }

    /// Insert, evicting oldest-inserted entries until back under budget. An
    /// entry larger than the whole budget is never cached (mirrors Node's
    /// early-return). If `epoch` is older than the generation the cache
    /// currently holds, the tile is silently dropped instead of inserted —
    /// see the module-level "Generation-race safety" doc; this is the
    /// specific check that prevents a slow, superseded-generation request
    /// from corrupting the current generation's cache.
    pub fn set(&self, epoch: u64, key: String, tile: CachedTile) {
        let tile_len = tile.bytes.len() as u64;
        if tile_len > self.max_bytes {
            return;
        }
        let mut inner = self.inner.lock().expect("tile cache mutex poisoned");
        Self::ensure_generation_locked(&mut inner, epoch);
        if inner.epoch != Some(epoch) {
            return;
        }
        if let Some(prev) = inner.entries.shift_remove(&key) {
            inner.bytes -= prev.bytes.len() as u64;
        }
        inner.entries.insert(key.clone(), tile);
        inner.bytes += tile_len;
        loop {
            if inner.bytes <= self.max_bytes {
                break;
            }
            let oldest_key = match inner.entries.first() {
                Some((k, _)) => k.clone(),
                None => break,
            };
            if oldest_key == key {
                break;
            }
            if let Some(oldest) = inner.entries.shift_remove(&oldest_key) {
                inner.bytes -= oldest.bytes.len() as u64;
            }
        }
    }

    /// Test/introspection-only: current entry count + byte total.
    #[cfg(test)]
    fn stats(&self) -> (usize, u64) {
        let inner = self.inner.lock().expect("tile cache mutex poisoned");
        (inner.entries.len(), inner.bytes)
    }
}

impl Default for TileCache {
    fn default() -> Self {
        Self::new(DEFAULT_CACHE_MAX_BYTES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(n: usize) -> CachedTile {
        CachedTile {
            bytes: Arc::from(vec![0u8; n].into_boxed_slice()),
            etag: format!("\"etag-{n}\""),
        }
    }

    #[test]
    fn get_miss_on_empty_cache() {
        let c = TileCache::new(100);
        assert!(c.get(1, "a").is_none());
    }

    #[test]
    fn set_then_get_roundtrips() {
        let c = TileCache::new(100);
        c.set(1, "a".to_string(), tile(10));
        let hit = c.get(1, "a").expect("hit");
        assert_eq!(hit.bytes.len(), 10);
        assert_eq!(c.stats(), (1, 10));
    }

    #[test]
    fn oversized_single_entry_is_never_cached() {
        let c = TileCache::new(10);
        c.set(1, "a".to_string(), tile(11));
        assert!(c.get(1, "a").is_none());
        assert_eq!(c.stats(), (0, 0));
    }

    #[test]
    fn eviction_removes_oldest_inserted_first() {
        let c = TileCache::new(15);
        c.set(1, "a".to_string(), tile(10)); // bytes=10
        c.set(1, "b".to_string(), tile(10)); // bytes=20 > 15 -> evict "a"
        assert!(c.get(1, "a").is_none());
        assert!(c.get(1, "b").is_some());
        assert_eq!(c.stats(), (1, 10));
    }

    #[test]
    fn get_refreshes_recency_so_it_survives_eviction() {
        let c = TileCache::new(15);
        c.set(1, "a".to_string(), tile(5));
        c.set(1, "b".to_string(), tile(5));
        // touch "a" so it becomes most-recently-used
        assert!(c.get(1, "a").is_some());
        // inserting "c" pushes bytes to 20 > 15 -> evict oldest ("b", since
        // "a" was touched via get above).
        c.set(1, "c".to_string(), tile(10));
        assert!(
            c.get(1, "b").is_none(),
            "b was least-recently-used, must be evicted"
        );
        assert!(
            c.get(1, "a").is_some(),
            "a was touched via get, must survive"
        );
        assert!(c.get(1, "c").is_some());
    }

    #[test]
    fn set_on_existing_key_updates_bytes_without_double_counting() {
        let c = TileCache::new(100);
        c.set(1, "a".to_string(), tile(10));
        c.set(1, "a".to_string(), tile(20));
        assert_eq!(c.stats(), (1, 20));
    }

    #[test]
    fn newer_epoch_purges_wholesale() {
        let c = TileCache::new(100);
        c.set(1, "a".to_string(), tile(10));
        c.set(1, "b".to_string(), tile(5)); // same epoch again — no purge
        assert_eq!(c.stats(), (2, 15));
        c.set(2, "c".to_string(), tile(3)); // newer epoch — purges, then inserts
        assert_eq!(c.stats(), (1, 3));
        assert!(c.get(2, "a").is_none());
        assert!(c.get(2, "c").is_some());
    }

    #[test]
    fn default_uses_16_mib_budget() {
        let c = TileCache::default();
        c.set(1, "a".to_string(), tile(DEFAULT_CACHE_MAX_BYTES as usize));
        assert!(
            c.get(1, "a").is_some(),
            "exactly-at-budget entry is cacheable"
        );
        let c2 = TileCache::default();
        c2.set(
            1,
            "a".to_string(),
            tile(DEFAULT_CACHE_MAX_BYTES as usize + 1),
        );
        assert!(c2.get(1, "a").is_none(), "over-budget entry is rejected");
    }

    /// The race the code review flagged: generation A (epoch 1) is still
    /// mid-disk-read when generation B (epoch 2) rolls in and serves
    /// first. A's late `set` must be dropped, not overwrite B's entry.
    #[test]
    fn late_write_from_superseded_generation_is_dropped() {
        let c = TileCache::new(100);
        // A starts serving under epoch 1 (a miss adopts the epoch).
        assert!(c.get(1, "key").is_none());
        // B rolls in first and populates its own entry under epoch 2.
        c.set(2, "key".to_string(), tile(5));
        assert_eq!(c.stats(), (1, 5));
        // A's slow read finally completes and tries to cache stale bytes.
        c.set(1, "key".to_string(), tile(999));
        // B's entry must be untouched — not overwritten, not evicted.
        let hit = c
            .get(2, "key")
            .expect("B's entry survives the late A write");
        assert_eq!(hit.bytes.len(), 5, "must still be B's bytes, not A's");
    }

    /// A stale-epoch `get` must never re-adopt (roll the cache backward
    /// to) an older generation, even transiently.
    #[test]
    fn stale_epoch_get_does_not_roll_cache_backward() {
        let c = TileCache::new(100);
        c.set(2, "key".to_string(), tile(5));
        assert!(
            c.get(1, "other-key").is_none(),
            "a stale-epoch read is always a miss"
        );
        // epoch 2's entry must have survived the epoch=1 get call above.
        assert!(c.get(2, "key").is_some());
    }
}
