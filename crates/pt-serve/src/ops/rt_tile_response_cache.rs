//! Wall-clock TTL + entry-count LRU cache over full rt-tile JSON response
//! bodies. Port of Node's `TtlLru` (`packages/backend/src/util/ttlLru.ts`),
//! as used by `packages/backend/src/routes/rtTile.ts:51-68`
//! (`maxSize: 4096, ttlMs: 10_000`).
//!
//! Deliberately NOT epoch-gated like [`crate::ops::tile_cache::TileCache`]
//! or [`crate::ops::rt_tile_membership_cache::TripMembershipCache`]: the
//! cache key already embeds the bundle hash (`<city>/<bundleHash>/<tileCoords>`),
//! so entries are self-scoping — a generation roll just means new requests
//! use a new key, and old-generation entries age out via the same TTL/LRU
//! eviction every entry is subject to. No race-safety concern of the kind
//! those two caches were built (or fixed) to close.
//!
//! No existing Rust precedent for TTL+LRU in this codebase — hand-rolled to
//! match `TtlLru`'s exact semantics (verified against that file directly):
//! `get` on an expired-but-not-yet-evicted entry deletes it and misses;
//! `get` on a live entry bumps recency WITHOUT extending its TTL; `set`
//! always stamps a fresh `now + ttl_ms` expiry, even on overwrite, and bumps
//! recency.

use indexmap::IndexMap;
use pt_shared::clock::Clock;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

#[derive(Clone)]
struct Entry {
    value: String,
    expires_at_ms: u64,
}

struct Inner {
    entries: IndexMap<String, Entry>,
}

pub struct RtTileResponseCache {
    inner: Mutex<Inner>,
    max_entries: u64,
    ttl_ms: u64,
}

fn now_ms(clock: &dyn Clock) -> u64 {
    clock
        .now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl RtTileResponseCache {
    pub fn new(max_entries: u64, ttl_ms: u64) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: IndexMap::new(),
            }),
            max_entries,
            ttl_ms,
        }
    }

    /// `None` on a genuine miss OR an expired entry (which is dropped, not
    /// left for later — matches `TtlLru.get`). A live hit bumps recency
    /// without touching its expiry.
    pub fn get(&self, clock: &dyn Clock, key: &str) -> Option<String> {
        let now = now_ms(clock);
        let mut inner = self.inner.lock().expect("response cache mutex poisoned");
        let entry = inner.entries.shift_remove(key)?;
        if entry.expires_at_ms <= now {
            return None;
        }
        inner.entries.insert(key.to_string(), entry.clone());
        Some(entry.value)
    }

    /// Insert with a fresh `now + ttl_ms` expiry (even when overwriting an
    /// existing key — matches `TtlLru.set`), evicting oldest-inserted
    /// entries once over `max_entries`.
    pub fn set(&self, clock: &dyn Clock, key: String, value: String) {
        let now = now_ms(clock);
        let mut inner = self.inner.lock().expect("response cache mutex poisoned");
        inner.entries.shift_remove(&key);
        inner.entries.insert(
            key,
            Entry {
                value,
                expires_at_ms: now + self.ttl_ms,
            },
        );
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
            .expect("response cache mutex poisoned")
            .entries
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pt_shared::clock::MockClock;
    use std::time::{Duration, SystemTime};

    fn clock_at(unix_secs: u64) -> MockClock {
        MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(unix_secs))
    }

    #[test]
    fn get_miss_on_empty_cache() {
        let c = RtTileResponseCache::new(10, 10_000);
        let clock = clock_at(0);
        assert!(c.get(&clock, "a").is_none());
    }

    #[test]
    fn set_then_get_roundtrips() {
        let c = RtTileResponseCache::new(10, 10_000);
        let clock = clock_at(1000);
        c.set(&clock, "a".to_string(), "body".to_string());
        assert_eq!(c.get(&clock, "a").as_deref(), Some("body"));
    }

    /// `max_entries == 0` is the potato profile's "disable this cache" knob
    /// — Node's own `TtlLru` doc calls this pathological (its constructor
    /// throws on `maxSize < 1`), but pt-serve deliberately allows it as a
    /// real config value rather than panicking, matching `TileCache`'s
    /// house style. Confirms it produces an always-empty cache, not a
    /// stuck-at-one-entry cache.
    #[test]
    fn zero_max_entries_is_always_empty() {
        let c = RtTileResponseCache::new(0, 10_000);
        let clock = clock_at(1000);
        c.set(&clock, "a".to_string(), "body".to_string());
        assert!(c.get(&clock, "a").is_none());
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn entry_expires_after_ttl_and_is_evicted_on_get() {
        let c = RtTileResponseCache::new(10, 10_000); // 10s TTL
        let set_clock = clock_at(1000);
        c.set(&set_clock, "a".to_string(), "body".to_string());
        // Exactly at expiry (expiresAt <= now) is already expired — matches
        // TtlLru's `<=` comparison.
        let expired_clock = clock_at(1010);
        assert!(c.get(&expired_clock, "a").is_none());
        assert_eq!(c.len(), 0, "expired entry is removed, not left behind");
    }

    #[test]
    fn entry_survives_up_to_but_not_including_ttl() {
        let c = RtTileResponseCache::new(10, 10_000);
        let set_clock = clock_at(1000);
        c.set(&set_clock, "a".to_string(), "body".to_string());
        let almost_expired = clock_at(1009);
        assert!(c.get(&almost_expired, "a").is_some());
    }

    #[test]
    fn get_does_not_extend_ttl() {
        let c = RtTileResponseCache::new(10, 10_000);
        let set_clock = clock_at(1000);
        c.set(&set_clock, "a".to_string(), "body".to_string());
        let mid_clock = clock_at(1005);
        assert!(c.get(&mid_clock, "a").is_some()); // recency bump, TTL unchanged
        let past_original_expiry = clock_at(1011);
        assert!(
            c.get(&past_original_expiry, "a").is_none(),
            "get must not have refreshed the original 1000+10=1010 expiry"
        );
    }

    #[test]
    fn set_on_existing_key_refreshes_ttl() {
        let c = RtTileResponseCache::new(10, 10_000);
        c.set(&clock_at(1000), "a".to_string(), "v1".to_string());
        c.set(&clock_at(1005), "a".to_string(), "v2".to_string()); // fresh expiry: 1005+10=1015
        let clock = clock_at(1012); // past the original 1010 expiry, before the new 1015
        assert_eq!(c.get(&clock, "a").as_deref(), Some("v2"));
    }

    #[test]
    fn eviction_removes_oldest_inserted_first_over_cap() {
        let c = RtTileResponseCache::new(2, 10_000);
        let clock = clock_at(1000);
        c.set(&clock, "a".to_string(), "1".to_string());
        c.set(&clock, "b".to_string(), "2".to_string());
        c.set(&clock, "c".to_string(), "3".to_string()); // over cap -> evict "a"
        assert!(c.get(&clock, "a").is_none());
        assert!(c.get(&clock, "b").is_some());
        assert!(c.get(&clock, "c").is_some());
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn get_refreshes_recency_so_it_survives_eviction() {
        let c = RtTileResponseCache::new(2, 10_000);
        let clock = clock_at(1000);
        c.set(&clock, "a".to_string(), "1".to_string());
        c.set(&clock, "b".to_string(), "2".to_string());
        assert!(c.get(&clock, "a").is_some()); // touch "a"
        c.set(&clock, "c".to_string(), "3".to_string()); // evicts oldest = "b"
        assert!(c.get(&clock, "b").is_none());
        assert!(c.get(&clock, "a").is_some());
        assert!(c.get(&clock, "c").is_some());
    }
}
