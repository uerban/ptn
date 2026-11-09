/**
 * Workbox runtimeCaching rules, exported so they can be imported by
 * vite.config.ts and unit-tested in isolation (order matters — first match
 * wins).
 *
 * Rule order:
 *   0. lazy locale + privacy chunks — CacheFirst (kept out of the precache;
 *        see precache.ts. Must stay CacheFirst or they break offline)
 *   0b. map-only chunk, worker and glyphs — CacheFirst (kept out of the
 *        precache so Text mode never downloads them)
 *   1. /version     — NetworkOnly  (deploy-skew surface)
 *   1b. /health*    — NetworkOnly  (liveness surface; a replayed 200 hides an
 *        outage for as long as the entry lives)
 *   2. /stops/      — NetworkFirst (short-lived, needs freshness)
 *   3. /departures* — NetworkFirst (short-lived, needs freshness). Covers both
 *        `departures-for-stop` (pt-serve, what the client calls) and the legacy
 *        `departures` route it replaced — the pattern is a prefix match, so the
 *        step-4 URL move in the legacy departures retirement notes needed no
 *        rule change and the cache kept working across it.
 *   4. gtfs tile endpoints — NetworkOnly (immutable IDB-cached schedule/POI
 *        tiles + must-revalidate manifest + ephemeral rt-tile must NOT be
 *        served from the cache; the \bgtfs\b anchor prevents stealing
 *        /departures-for-stop /stops /version)
 *   5. address-search endpoints — NetworkOnly (verified + stored in IDB)
 *   5a. service alerts — NetworkOnly (kept in memory only; a replayed answer
 *        would hide a failed refresh)
 *   5b. micromap artifacts — CacheFirst
 *   5c. managed OSM discovery/artifacts — NetworkOnly (verified IDB fallback)
 *   6. /api/ catch-all — NetworkFirst
 *   7. carto basemap style/sprite/glyphs — CacheFirst
 *   8. carto tiles — CacheFirst
 */
export const runtimeCaching = [
  {
    // Discovery owns its validated metadata fallback; never replay membership here.
    urlPattern: /\/api\/(?:cities|[^/]+\/(?:ready|raptor-bundle))(?:[/?#]|$)/,
    handler: "NetworkOnly" as const,
  },
  {
    urlPattern: /\/deployment-config\.js$/,
    handler: "NetworkFirst" as const,
    options: {
      cacheName: "deployment-config",
      networkTimeoutSeconds: 3,
      cacheableResponse: {statuses: [200]},
      expiration: {maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 180},
    },
  },
  {
    // Locale and privacy-namespace chunks are excluded from the precache
    // (precache.ts), so this rule is the only thing that makes them work
    // offline: first use fetches and stores the chunk, every later load —
    // online or in a tunnel — is served from CacheStorage.
    //
    // Deliberately narrow. The pattern anchors on /assets/, on the exact
    // locale codes, and on Vite's `-<hash>.js` suffix, so it cannot start
    // intercepting unrelated chunks that happen to share a prefix.
    urlPattern:
      /\/assets\/(?:(?:lt|pl|be|ru|uk|lv|et|sv|nb|fi)|privacy(?:\.[a-z]{2})?)-[A-Za-z0-9_-]+\.js$/,
    handler: "CacheFirst" as const,
    options: {
      cacheName: "i18n-chunks",
      expiration: {
        // Eleven locales plus their privacy overlays, with room for one
        // deploy's worth of superseded hashes before the LRU starts evicting.
        maxEntries: 60,
        maxAgeSeconds: 60 * 60 * 24 * 90,
      },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // Map-only assets are excluded from the precache (precache.ts) so Text
    // mode never downloads them. Choosing Map fetches them once; this rule
    // keeps them for offline use. Anchored on the exact chunk names and the
    // bundled glyph directory.
    urlPattern:
      /\/(?:assets\/(?:vendor-map|maplibre|maplibre-gl-worker)-[A-Za-z0-9_-]+\.js|glyphs\/[^/?#]+\/[^/?#]+\.pbf)$/,
    handler: "CacheFirst" as const,
    options: {
      cacheName: "map-assets",
      expiration: {
        // One deploy's map chunks, worker and glyph ranges, plus superseded hashes.
        maxEntries: 16,
        maxAgeSeconds: 60 * 60 * 24 * 90,
      },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // Build-info reflects the *current* deploy. Stale SW cache would
    // mask the very deploy-skew this feature is meant to surface.
    urlPattern: /\/api\/[^/]+\/version$/,
    handler: "NetworkOnly" as const,
  },
  {
    // Liveness/readiness probes (`/health`, `/health/ready`, `/health/live`,
    // `/health/rt`). A cached 200 answers "was the backend up when this entry
    // was written", which is the opposite of what a probe is for: under the
    // /api/ catch-all below (NetworkFirst, 1h) a real outage stayed invisible
    // to `BackendStatus` and `remoteRoutingAvailability` for the first hour,
    // because the failing fetch fell back to the last good response. Same
    // reasoning as /version above.
    //
    // The `(?:[/?#]|$)` tail keeps this off sibling paths that merely start
    // with "health".
    urlPattern: /\/api\/(?:[^/]+\/)?health(?:[/?#]|$)/,
    handler: "NetworkOnly" as const,
  },
  {
    urlPattern: /\/api\/(?:[^/]+\/)?stops\//,
    handler: "NetworkFirst" as const,
    options: {
      // Versioned so a contract change can move to a fresh cache name: the
      // new SW reads and writes only the new name, leaving any poisoned
      // entries in the old cache inert.
      cacheName: "api-stops-cache-v1",
      networkTimeoutSeconds: 5,
      // Entries name the stops the rider looked at: kept briefly and few.
      expiration: {
        maxEntries: 20,
        maxAgeSeconds: 60 * 60,
      },
    },
  },
  {
    urlPattern: /\/api\/(?:[^/]+\/)?departures/,
    handler: "NetworkFirst" as const,
    options: {
      cacheName: "api-departures-cache",
      networkTimeoutSeconds: 3,
      // Entries name the stops the rider looked at: kept briefly and few.
      expiration: {
        maxEntries: 20,
        maxAgeSeconds: 120,
      },
    },
  },
  {
    // Immutable schedule/POI tiles (IDB-cached), must-revalidate manifest, and
    // ephemeral rt-tile must never be served from the SW cache. The
    // (?:[^/]+\/)? optional city-slug segment mirrors the other /api/ rules.
    // The \b word-boundary after the alternation prevents this from matching
    // sibling paths under /gtfs/, e.g. /gtfs/shapes/shapes-x.json.
    urlPattern: /\/api\/(?:[^/]+\/)?gtfs\/(?:manifest|schedule-tile|rt-tile|poi-tile)\b/,
    handler: "NetworkOnly" as const,
  },
  {
    // Address-search bundle bytes are SHA-verified and stored in IndexedDB by
    // addressSearchLoader. The service worker must not replay stale manifest,
    // bundle, or query responses from the generic API cache.
    urlPattern: /\/api\/[^/]+\/address-search(?:[/?#]|$)/,
    handler: "NetworkOnly" as const,
  },
  {
    // Service alerts live in memory only and carry their own freshness
    // (`stale`, `fetchedAt`). Under the /api/ catch-all a failed refresh fell
    // back to an answer up to an hour old that the client then showed as
    // just checked; it must see the failure instead.
    urlPattern: /\/api\/[^/]+\/alerts(?:[/?#]|$)/,
    handler: "NetworkOnly" as const,
  },
  {
    // Offline city micromap (/micromap/<city>.micromap.br). One small,
    // deploy-immutable file per city, and the whole point of the mode is that
    // it works with no network — so it must survive a reload in a tunnel.
    // Not precached: most users need one city, not all of them.
    urlPattern: /\/micromap\/[^/]+\.micromap\.br$/,
    handler: "CacheFirst" as const,
    options: {
      cacheName: "micromap-artifacts",
      expiration: {
        maxEntries: 8,
        maxAgeSeconds: 60 * 60 * 24 * 180,
      },
      // Only the real artifact: nginx serves it as application/octet-stream
      // (micromap-static.inc). An HTML fallback or error page must not be
      // kept as the offline copy. Workbox compares the header exactly.
      cacheableResponse: {
        statuses: [200],
        headers: { "Content-Type": "application/octet-stream" },
      },
    },
  },
  {
    // Discovery must revalidate. Verified native-valid graph bytes are retained
    // explicitly in IndexedDB; SW caching must not replay a stale activation or
    // store an unvalidated candidate as the only offline graph.
    urlPattern: /\/osm\/(?:current|releases)\//,
    handler: "NetworkOnly" as const,
  },
  {
    urlPattern: /\/api\//,
    handler: "NetworkFirst" as const,
    options: {
      cacheName: "api-general-cache",
      networkTimeoutSeconds: 5,
      expiration: {
        maxEntries: 100,
        maxAgeSeconds: 3600,
      },
    },
  },
  // Carto basemap style/sprite/glyphs — small, highly cacheable.
  // Rationale: the meta map offline notes (Phase 4 SW caching).
  {
    urlPattern: /^https:\/\/basemaps\.cartocdn\.com\//,
    handler: "CacheFirst" as const,
    options: {
      cacheName: "carto-style",
      expiration: {
        maxEntries: 40,
        maxAgeSeconds: 60 * 60 * 24 * 30,
      },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  // Carto tiles (raster .png on a–d subdomains, vector .pbf on
  // tiles.basemaps.cartocdn.com). LRU-capped so a curious user
  // panning across a continent doesn't blow up IndexedDB.
  {
    urlPattern:
      /^https:\/\/(?:[a-d]|tiles)\.basemaps\.cartocdn\.com\/.*\.(?:png|pbf)$/,
    handler: "CacheFirst" as const,
    options: {
      cacheName: "carto-tiles",
      // Tiles show which areas the rider viewed; the offline map does not
      // depend on them, so they are kept for two days only.
      expiration: {
        maxEntries: 300,
        maxAgeSeconds: 60 * 60 * 24 * 2,
      },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
] satisfies {
  urlPattern: RegExp;
  handler: "NetworkOnly" | "NetworkFirst" | "CacheFirst" | "StaleWhileRevalidate";
  options?: Record<string, unknown>;
}[];
