//! Three small caches the poi-tile route needs — port of the `Map`s
//! embedded in Node's `createBundleFileLoader`/`createPoiTileHandler`
//! closures (`packages/backend/src/routes/poiTile.ts`).
//!
//! None of these are epoch-gated like [`crate::ops::tile_cache::TileCache`]
//! or [`crate::ops::rt_tile_membership_cache::TripMembershipCache`]: POI
//! bundles are independent of GTFS reload (a separate directory, read
//! lazily, never touched by `Generation` adoption), so there is no
//! stale-generation race to close.
//!
//! [`PoiCityTilingCache`] retains only manifest-backed active/inactive
//! resolutions, each pinned to the POI release directory it was read from, so
//! a promoted release replaces a city's resolution on its next request. An
//! active resolution carries its decoded entries, keeping the tile index and
//! the entries it points into from the same release. Callers must reject
//! unknown city ids and out-of-grid tile keys before entering either
//! singleflight map.

use crate::poi::catalog::PoiBundleLoadError;
use crate::poi::{PoiTileBounds, PoiTileIndex};
use indexmap::IndexMap;
use pt_shared::poi_bundle_wire::PoiEntry;
use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};

/// Matches Node's `ZLIB_CONCURRENCY`. The response-build admission gate
/// enforces this as a hard process-wide ceiling for JSON serialization and
/// Brotli Q11 work.
pub const POI_TILE_BUILD_CONCURRENCY: usize = 2;

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

enum FlightState<V> {
    Building,
    Ready(Result<V, Arc<PoiBundleLoadError>>),
    Aborted,
}

struct Flight<V> {
    state: Mutex<FlightState<V>>,
    ready: Condvar,
}

impl<V> Flight<V> {
    fn building() -> Self {
        Self {
            state: Mutex::new(FlightState::Building),
            ready: Condvar::new(),
        }
    }
}

struct KeyedSingleflight<V> {
    flights: Mutex<HashMap<String, Arc<Flight<V>>>>,
}

impl<V> Default for KeyedSingleflight<V> {
    fn default() -> Self {
        Self {
            flights: Mutex::new(HashMap::new()),
        }
    }
}

impl<V: Clone> KeyedSingleflight<V> {
    fn run(
        &self,
        key: &str,
        build: impl FnOnce() -> Result<V, PoiBundleLoadError>,
    ) -> Result<V, Arc<PoiBundleLoadError>> {
        let mut build = Some(build);
        loop {
            let (flight, is_leader) = {
                let mut flights = lock_recover(&self.flights);
                if let Some(flight) = flights.get(key) {
                    (Arc::clone(flight), false)
                } else {
                    let flight = Arc::new(Flight::building());
                    flights.insert(key.to_string(), Arc::clone(&flight));
                    (flight, true)
                }
            };

            if is_leader {
                let outcome = catch_unwind(AssertUnwindSafe(|| {
                    build.take().expect("singleflight builder is present")()
                }));
                match outcome {
                    Ok(result) => {
                        let shared = result.map_err(Arc::new);
                        {
                            let mut state = lock_recover(&flight.state);
                            *state = FlightState::Ready(shared.clone());
                            flight.ready.notify_all();
                        }
                        self.remove_flight(key, &flight);
                        return shared;
                    }
                    Err(payload) => {
                        {
                            let mut state = lock_recover(&flight.state);
                            *state = FlightState::Aborted;
                            flight.ready.notify_all();
                        }
                        self.remove_flight(key, &flight);
                        resume_unwind(payload);
                    }
                }
            }

            let mut state = lock_recover(&flight.state);
            loop {
                match &*state {
                    FlightState::Building => {
                        state = flight
                            .ready
                            .wait(state)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                    FlightState::Ready(result) => return result.clone(),
                    FlightState::Aborted => break,
                }
            }
        }
    }

    fn remove_flight(&self, key: &str, flight: &Arc<Flight<V>>) {
        let mut flights = lock_recover(&self.flights);
        let matches = flights
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, flight));
        if matches {
            flights.remove(key);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PoiCityTiling {
    Active {
        edge_km: f64,
        index: Arc<PoiTileIndex>,
        /// Decoded bundle entries the index points into. The loader caps
        /// each bundle via `ServerConfig::poi_bundle_max_decoded_bytes`, and
        /// preflight charges decoded entries against the configured memory budget.
        entries: Arc<Vec<PoiEntry>>,
        tile_bounds: PoiTileBounds,
        bundle_sha256: Arc<str>,
    },
    Inactive,
}

/// Resolved tiling status for one validated release. Preflight bounds decoded
/// entries by the configured byte budget. A namespace change drops all old
/// cache ownership; in-flight requests retain their own references.
#[derive(Default)]
pub struct PoiCityTilingCache {
    inner: Mutex<(Option<PathBuf>, HashMap<String, PoiCityTiling>)>,
    flights: KeyedSingleflight<PoiCityTiling>,
}

impl PoiCityTilingCache {
    pub fn get(&self, city_id: &str, release: &Path) -> Option<PoiCityTiling> {
        let state = lock_recover(&self.inner);
        if state.0.as_deref() != Some(release) {
            return None;
        }
        state.1.get(city_id).cloned()
    }

    pub fn set(&self, city_id: String, release: &Path, resolution: PoiCityTiling) {
        let mut state = lock_recover(&self.inner);
        if state.0.as_deref() != Some(release) {
            state.1.clear();
            state.0 = Some(release.to_path_buf());
        }
        state.1.insert(city_id, resolution);
    }

    /// Resolve one manifest-backed city from one release. Bundle decode and
    /// index construction run outside cache locks; only requests for this
    /// city and release wait on its flight.
    pub fn get_or_try_resolve(
        &self,
        city_id: &str,
        release: &Path,
        resolve: impl FnOnce() -> Result<PoiCityTiling, PoiBundleLoadError>,
    ) -> Result<PoiCityTiling, Arc<PoiBundleLoadError>> {
        if let Some(hit) = self.get(city_id, release) {
            return Ok(hit);
        }
        let flight = format!("{city_id}\0{}", release.display());
        self.flights.run(&flight, || {
            if let Some(hit) = self.get(city_id, release) {
                return Ok(hit);
            }
            // Drop an older release's entries before decoding the new ones,
            // so a promotion does not hold two decoded corpora per city.
            lock_recover(&self.inner).1.remove(city_id);
            let resolution = resolve()?;
            self.set(city_id.to_string(), release, resolution.clone());
            Ok(resolution)
        })
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        lock_recover(&self.inner).1.len()
    }
}

/// Compressed per-tile response body + ETag — port of `CachedTileResponse`
/// (`routes/poiTile.ts:63-66`).
#[derive(Clone)]
pub struct CachedPoiTileResponse {
    pub etag: String,
    pub compressed: Arc<[u8]>,
}

/// Response-cache build failure. `Busy` is deliberate load shedding: tiny_http
/// handlers are synchronous, so waiting behind an existing same-key flight
/// would let a cold burst park every public worker while one Brotli Q11 build
/// runs. Callers should map `Busy` to a retryable 503; normal build failures
/// retain the existing POI bundle-load error path.
#[derive(Debug, Clone)]
pub enum PoiTileCacheBuildError {
    Load(Arc<PoiBundleLoadError>),
    Busy,
}

impl PoiTileCacheBuildError {
    pub fn is_busy(&self) -> bool {
        matches!(self, Self::Busy)
    }
}

// Keep existing callers source-compatible while the route maps `Busy`
// explicitly. Dereferencing a busy outcome reaches only the legacy 500
// fallback; the typed variant remains available to the handler.
impl Deref for PoiTileCacheBuildError {
    type Target = PoiBundleLoadError;

    fn deref(&self) -> &Self::Target {
        static BUSY_FALLBACK: LazyLock<PoiBundleLoadError> = LazyLock::new(|| {
            PoiBundleLoadError::Config("POI tile response build capacity exhausted".to_string())
        });
        match self {
            Self::Load(error) => error,
            Self::Busy => &BUSY_FALLBACK,
        }
    }
}

#[derive(Default)]
struct ActiveResponseBuildState {
    keys: HashSet<String>,
}

struct ActiveResponseBuilds {
    state: Mutex<ActiveResponseBuildState>,
    max_concurrent: usize,
}

impl ActiveResponseBuilds {
    fn new(max_concurrent: usize) -> Self {
        Self {
            state: Mutex::new(ActiveResponseBuildState::default()),
            max_concurrent,
        }
    }

    /// Two independent shed conditions, both deliberate:
    ///
    /// - `keys.len() >= max_concurrent` — the pool is full. Admitting more
    ///   would exceed the encoder-slot ceiling the RSS guard reserves for.
    /// - `keys.contains(key)` — this key is ALREADY building. It looks like
    ///   this branch protects nothing when a slot is free, but admitting the
    ///   duplicate would spend that free slot redoing work that is already in
    ///   flight and about to be cached, starving a genuinely distinct tile of
    ///   the last slot. Shedding a duplicate costs the caller one retry; the
    ///   leader's result lands in the cache either way.
    ///
    /// Neither arm waits. A follower parked on a condvar could not be
    /// preempted: `ops::timeout` is a COOPERATIVE watchdog — it flips a flag
    /// the worker checks at safepoints, and a `Condvar::wait` has none until
    /// the leader publishes. Blocking here would make `--request-timeout-ms`
    /// unenforceable on this path and break the drain bound documented in
    /// `http::worker_pool`, which derives shutdown latency from that timeout.
    /// This is why `KeyedSingleflight` (same file) is wired to the tiling
    /// cache but NOT here: tiling resolves at most once per city per process
    /// and is decompress-bound, whereas a response build is a quality-11
    /// compress that recurs on every cold key for the life of the LRU.
    fn try_start<'a>(&'a self, key: &str) -> Option<ActiveResponseBuildGuard<'a>> {
        let mut state = lock_recover(&self.state);
        if state.keys.len() >= self.max_concurrent || state.keys.contains(key) {
            return None;
        }
        state.keys.insert(key.to_string());
        Some(ActiveResponseBuildGuard {
            builds: self,
            key: key.to_string(),
        })
    }
}

struct ActiveResponseBuildGuard<'a> {
    builds: &'a ActiveResponseBuilds,
    key: String,
}

impl Drop for ActiveResponseBuildGuard<'_> {
    fn drop(&mut self) {
        lock_recover(&self.builds.state).keys.remove(&self.key);
    }
}

#[derive(Default)]
struct PoiTileResponseCacheState {
    entries: IndexMap<String, CachedPoiTileResponse>,
    charged_bytes: u64,
}

/// Byte- and entry-bounded insertion-order LRU over full poi-tile response
/// bodies. The entry cap preserves Node's `RESPONSE_CACHE_MAX_ENTRIES = 256`
/// behavior, while the byte cap is an additional Rust resource-safety bound
/// reserved exactly by `ops::rss_guard`.
///
/// There is NO TTL: POI bundle content only changes on a fresh OSM
/// extract/deploy, not on GTFS reload, so Node never expires entries by time.
/// Cache charge includes the compressed allocation, key and ETag allocation,
/// and the fixed entry structs. IndexMap's table allocation is part of the
/// calibrated process overhead; the dominant variable allocations cannot
/// exceed `max_bytes`.
pub struct PoiTileResponseCache {
    inner: Mutex<PoiTileResponseCacheState>,
    active_builds: ActiveResponseBuilds,
    max_entries: u64,
    max_bytes: u64,
}

impl PoiTileResponseCache {
    pub fn new(max_entries: u64, max_bytes: u64) -> Self {
        Self::with_build_limit(max_entries, max_bytes, POI_TILE_BUILD_CONCURRENCY)
    }

    fn with_build_limit(max_entries: u64, max_bytes: u64, max_concurrent_builds: usize) -> Self {
        Self {
            inner: Mutex::new(PoiTileResponseCacheState::default()),
            active_builds: ActiveResponseBuilds::new(max_concurrent_builds),
            max_entries,
            max_bytes,
        }
    }

    /// Lookup + recency refresh (moves the hit to the most-recently-used
    /// end) — mirrors the handler's hit-path `delete` + `set`.
    pub fn get(&self, key: &str) -> Option<CachedPoiTileResponse> {
        let mut inner = lock_recover(&self.inner);
        let (owned_key, hit) = inner.entries.shift_remove_entry(key)?;
        let response = hit.clone();
        inner.entries.insert(owned_key, hit);
        Some(response)
    }

    /// Insert (or overwrite + bump recency), evicting least-recent entries
    /// until both configured ceilings hold. A single oversized value is
    /// served to its caller but not admitted to the cache.
    pub fn set(&self, key: String, value: CachedPoiTileResponse) -> bool {
        let mut inner = lock_recover(&self.inner);
        Self::insert_locked(&mut inner, self.max_entries, self.max_bytes, key, value)
    }

    /// Return the cached value or build it without holding the LRU mutex.
    /// At most [`POI_TILE_BUILD_CONCURRENCY`] distinct keys build concurrently.
    /// A duplicate cold key or an exhausted build pool returns `Busy`
    /// immediately instead of blocking a public HTTP worker on a condvar.
    pub fn get_or_try_insert_with(
        &self,
        key: String,
        build: impl FnOnce() -> Result<CachedPoiTileResponse, PoiBundleLoadError>,
    ) -> Result<CachedPoiTileResponse, PoiTileCacheBuildError> {
        if let Some(hit) = self.get(&key) {
            return Ok(hit);
        }
        let _build_guard = self
            .active_builds
            .try_start(&key)
            .ok_or(PoiTileCacheBuildError::Busy)?;
        if let Some(hit) = self.get(&key) {
            return Ok(hit);
        }
        let value = build().map_err(|error| PoiTileCacheBuildError::Load(Arc::new(error)))?;
        self.set(key, value.clone());
        Ok(value)
    }

    fn insert_locked(
        inner: &mut PoiTileResponseCacheState,
        max_entries: u64,
        max_bytes: u64,
        key: String,
        value: CachedPoiTileResponse,
    ) -> bool {
        let charge = Self::entry_charge(&key, &value);
        if max_entries == 0 || charge > max_bytes {
            return false;
        }

        if let Some((previous_key, previous)) = inner.entries.shift_remove_entry(&key) {
            inner.charged_bytes = inner
                .charged_bytes
                .saturating_sub(Self::entry_charge(&previous_key, &previous));
        }
        inner.charged_bytes = inner.charged_bytes.saturating_add(charge);
        inner.entries.insert(key, value);

        while inner.entries.len() as u64 > max_entries || inner.charged_bytes > max_bytes {
            let Some((oldest_key, oldest_value)) = inner.entries.first() else {
                break;
            };
            let oldest_key = oldest_key.clone();
            let oldest_charge = Self::entry_charge(&oldest_key, oldest_value);
            inner.entries.shift_remove(&oldest_key);
            inner.charged_bytes = inner.charged_bytes.saturating_sub(oldest_charge);
        }
        true
    }

    fn entry_charge(key: &String, value: &CachedPoiTileResponse) -> u64 {
        // Arc<[u8]> owns two usize-sized strong/weak counters ahead of its data.
        let fixed = std::mem::size_of::<String>()
            .saturating_add(std::mem::size_of::<CachedPoiTileResponse>())
            .saturating_add(2 * std::mem::size_of::<usize>());
        fixed
            .saturating_add(key.capacity())
            .saturating_add(value.etag.capacity())
            .saturating_add(value.compressed.len()) as u64
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        lock_recover(&self.inner).entries.len()
    }

    #[cfg(test)]
    fn charged_bytes(&self) -> u64 {
        lock_recover(&self.inner).charged_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pt_shared::poi_tile_grid::TileAnchor;

    fn resp(n: u8) -> CachedPoiTileResponse {
        resp_with_len(n, 4)
    }

    fn resp_with_len(n: u8, len: usize) -> CachedPoiTileResponse {
        CachedPoiTileResponse {
            etag: format!("\"etag-{n}\""),
            compressed: Arc::from(vec![n; len].into_boxed_slice()),
        }
    }

    #[test]
    fn tiling_cache_stores_each_variant() {
        let c = PoiCityTilingCache::default();
        let release = Path::new("/releases/a");
        c.set("gdynia".to_string(), release, PoiCityTiling::Inactive);
        c.set(
            "vilnius".to_string(),
            release,
            PoiCityTiling::Active {
                edge_km: 12.0,
                index: Arc::new(crate::poi::PoiTileIndex::build(
                    &[],
                    12.0,
                    TileAnchor {
                        min_lat: 0.0,
                        min_lon: 0.0,
                        ref_lat: 0.0,
                    },
                )),
                entries: Arc::new(vec![]),
                tile_bounds: PoiTileBounds {
                    min_x: 0,
                    max_x: 0,
                    min_y: 0,
                    max_y: 0,
                },
                bundle_sha256: Arc::from("abc"),
            },
        );
        assert_eq!(c.get("gdynia", release), Some(PoiCityTiling::Inactive));
        assert!(matches!(
            c.get("vilnius", release),
            Some(PoiCityTiling::Active { edge_km, .. }) if edge_km == 12.0
        ));
        assert_eq!(c.get("sopot", release), None);
    }

    #[test]
    fn namespace_change_drops_removed_corpus_cache_ownership() {
        let cache = PoiCityTilingCache::default();
        cache.set(
            "removed".into(),
            Path::new("/release/a"),
            PoiCityTiling::Inactive,
        );
        cache.set(
            "added".into(),
            Path::new("/release/b"),
            PoiCityTiling::Inactive,
        );
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("removed", Path::new("/release/a")), None);
        assert_eq!(
            cache.get("added", Path::new("/release/b")),
            Some(PoiCityTiling::Inactive)
        );
    }

    #[test]
    fn tiling_cache_same_city_builds_once() {
        let c = PoiCityTilingCache::default();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        for _ in 0..2 {
            let result = c
                .get_or_try_resolve("vilnius", Path::new("/releases/a"), || {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(PoiCityTiling::Inactive)
                })
                .unwrap();
            assert_eq!(result, PoiCityTiling::Inactive);
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn tiling_cache_replaces_a_city_resolved_from_an_older_release() {
        let c = PoiCityTilingCache::default();
        let (old, new) = (Path::new("/releases/a"), Path::new("/releases/b"));
        c.set("vilnius".to_string(), old, PoiCityTiling::Inactive);
        assert_eq!(c.get("vilnius", new), None);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        c.get_or_try_resolve("vilnius", new, || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(PoiCityTiling::Inactive)
        })
        .unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(c.get("vilnius", old), None);
        assert_eq!(c.get("vilnius", new), Some(PoiCityTiling::Inactive));
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn response_cache_get_miss_on_empty() {
        let c = PoiTileResponseCache::new(10, u64::MAX);
        assert!(c.get("a").is_none());
    }

    #[test]
    fn response_cache_set_then_get_roundtrips() {
        let c = PoiTileResponseCache::new(10, u64::MAX);
        assert!(c.set("a".to_string(), resp(1)));
        assert_eq!(c.get("a").map(|r| r.etag), Some("\"etag-1\"".to_string()));
    }

    #[test]
    fn response_cache_evicts_oldest_inserted_over_cap() {
        let c = PoiTileResponseCache::new(2, u64::MAX);
        c.set("a".to_string(), resp(1));
        c.set("b".to_string(), resp(2));
        c.set("c".to_string(), resp(3)); // over cap -> evict "a"
        assert!(c.get("a").is_none());
        assert!(c.get("b").is_some());
        assert!(c.get("c").is_some());
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn response_cache_get_refreshes_recency_so_it_survives_eviction() {
        let c = PoiTileResponseCache::new(2, u64::MAX);
        c.set("a".to_string(), resp(1));
        c.set("b".to_string(), resp(2));
        assert!(c.get("a").is_some()); // touch "a"
        c.set("c".to_string(), resp(3)); // evicts oldest = "b"
        assert!(c.get("b").is_none());
        assert!(c.get("a").is_some());
        assert!(c.get("c").is_some());
    }

    #[test]
    fn response_cache_zero_max_entries_is_always_empty() {
        let c = PoiTileResponseCache::new(0, u64::MAX);
        assert!(!c.set("a".to_string(), resp(1)));
        assert!(c.get("a").is_none());
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn response_cache_set_on_existing_key_overwrites_and_bumps_recency() {
        let c = PoiTileResponseCache::new(2, u64::MAX);
        c.set("a".to_string(), resp(1));
        c.set("b".to_string(), resp(2));
        c.set("a".to_string(), resp(9)); // overwrite + bump "a" to MRU
        c.set("c".to_string(), resp(3)); // evicts oldest = "b"
        assert!(c.get("b").is_none());
        assert_eq!(c.get("a").map(|r| r.etag), Some("\"etag-9\"".to_string()));
    }

    #[test]
    fn response_cache_get_or_build_runs_builder_once() {
        let c = PoiTileResponseCache::new(2, u64::MAX);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let first = c
            .get_or_try_insert_with("a".to_string(), || {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(resp(1))
            })
            .unwrap();
        let second = c
            .get_or_try_insert_with("a".to_string(), || {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(resp(2))
            })
            .unwrap();
        assert_eq!(first.etag, second.etag);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn response_cache_rejects_oversized_entry_without_evicting_resident_value() {
        let resident = resp(1);
        let resident_charge = PoiTileResponseCache::entry_charge(&"a".to_string(), &resident);
        let c = PoiTileResponseCache::new(2, resident_charge);
        assert!(c.set("a".to_string(), resident));

        assert!(!c.set("b".to_string(), resp_with_len(2, 1024)));
        assert!(c.get("a").is_some());
        assert!(c.get("b").is_none());
        assert_eq!(c.len(), 1);
        assert!(c.charged_bytes() <= resident_charge);
    }

    #[test]
    fn response_cache_oversized_build_is_served_but_not_admitted() {
        let c = PoiTileResponseCache::new(2, 1);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        for _ in 0..2 {
            let response = c
                .get_or_try_insert_with("a".to_string(), || {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(resp(1))
                })
                .unwrap();
            assert_eq!(response.etag, "\"etag-1\"");
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(c.len(), 0);
        assert_eq!(c.charged_bytes(), 0);
    }

    #[test]
    fn response_cache_evicts_lru_until_under_byte_ceiling() {
        let a = resp_with_len(1, 40);
        let b = resp_with_len(2, 40);
        let charge_a = PoiTileResponseCache::entry_charge(&"a".to_string(), &a);
        let charge_b = PoiTileResponseCache::entry_charge(&"b".to_string(), &b);
        let max_bytes = charge_a + charge_b;
        let c = PoiTileResponseCache::new(10, max_bytes);

        c.set("a".to_string(), a);
        c.set("b".to_string(), b);
        assert!(c.get("a").is_some()); // "b" is now LRU
        c.set("c".to_string(), resp_with_len(3, 40));

        assert!(c.get("b").is_none());
        assert!(c.get("a").is_some());
        assert!(c.get("c").is_some());
        assert_eq!(c.len(), 2);
        assert!(c.charged_bytes() <= max_bytes);
    }

    #[test]
    fn response_cache_same_key_cold_follower_fails_fast() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{mpsc, Arc};

        let cache = Arc::new(PoiTileResponseCache::with_build_limit(2, u64::MAX, 1));
        let calls = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let leader_cache = Arc::clone(&cache);
        let leader_calls = Arc::clone(&calls);
        let leader = std::thread::spawn(move || {
            leader_cache
                .get_or_try_insert_with("same".to_string(), || {
                    leader_calls.fetch_add(1, Ordering::SeqCst);
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(resp(1))
                })
                .unwrap()
        });
        started_rx.recv().unwrap();

        let follower_cache = Arc::clone(&cache);
        let follower_calls = Arc::clone(&calls);
        let (follower_tx, follower_rx) = mpsc::channel();
        let follower = std::thread::spawn(move || {
            let result = follower_cache.get_or_try_insert_with("same".to_string(), || {
                follower_calls.fetch_add(1, Ordering::SeqCst);
                Ok(resp(2))
            });
            follower_tx.send(result).unwrap();
        });
        let follower_result = follower_rx
            .recv_timeout(std::time::Duration::from_millis(250))
            .expect("a duplicate cold request must not wait for the leader");
        assert!(matches!(follower_result, Err(PoiTileCacheBuildError::Busy)));

        release_tx.send(()).unwrap();
        follower.join().unwrap();
        let built = leader.join().unwrap();
        assert_eq!(built.etag, "\"etag-1\"");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn response_cache_caps_distinct_concurrent_builds() {
        use std::sync::{mpsc, Arc};

        let cache = Arc::new(PoiTileResponseCache::with_build_limit(3, u64::MAX, 1));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let leader_cache = Arc::clone(&cache);
        let leader = std::thread::spawn(move || {
            leader_cache
                .get_or_try_insert_with("a".to_string(), || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(resp(1))
                })
                .unwrap()
        });
        started_rx.recv().unwrap();

        assert!(matches!(
            cache.get_or_try_insert_with("b".to_string(), || Ok(resp(2))),
            Err(PoiTileCacheBuildError::Busy)
        ));

        release_tx.send(()).unwrap();
        leader.join().unwrap();
        assert!(
            cache
                .get_or_try_insert_with("b".to_string(), || Ok(resp(2)))
                .is_ok(),
            "admission must be released after the first build completes"
        );
    }
}
