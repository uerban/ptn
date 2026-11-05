import type { RtRouteUpdate } from "@pt/shared";

/**
 * Producer-mode RT-grouping source — the B4 read side that lets `/api/rt/:routeId`
 * group live RT by route from the producer-built `trip-route.json` artifact
 * (`routeForTrip`) instead of `GtfsStore.getRealtimeForRoute`'s
 * `canonical.getTrip(tripId).routeId` read.
 *
 * This is the LAST `canonical`/index read in the `/api/rt` path — after this (B4),
 * producer mode reads NO `CanonicalStore` to answer `/api/rt`, the index-shed
 * prerequisite for Plan-C4.
 *
 * Enumeration vs grouping:
 *   - `getRealtimeTripUpdates()` is the store-resident, index-free RT enumeration
 *     (the C4-survivable seam — it touches only `realtimeUpdates` + the per-key
 *     generation gate, NO `canonical`). It already drops the date-scoped `|`-keys.
 *   - `routeForTrip(tripId)` is the producer-built artifact mapping a bare
 *     `tripId` to its route. An `undefined` result (a trip absent from the frozen
 *     `trip-route.json`) is SKIPPED, NOT canonical-fallen-through (B-5): a trip
 *     absent from the generation's schedule tile would not appear in the
 *     tile-sourced departures path either, so dropping it from `/api/rt` is
 *     self-consistent.
 *     Falling through to `canonical` per-key would re-introduce the index this
 *     stage sheds and flip the route back onto `canonical` on benign refresh
 *     skew.
 *

 * * Wholly-absent artifact (B1): a per-key skip is correct only for a PRESENT-but-incomplete
 * artifact. When `trip-route.json` is WHOLLY absent / unreadable / SHA-mismatched,
 * `routeForTrip` returns `undefined` for EVERY trip — so a naive per-key skip would serve
 * `{trips:[]}` for every route, a city-wide RT blackout. Instead, when `artifactPresent()` is
 * `false` we fall through to the canonical `getRealtimeForRoute` thunk (`canonicalFallback`)
 * and count a single `fallback` — mirroring how B6/`producerDepartures` degrades to `canonical`
 * on an `unavailable` source. The per-key skip is retained for the present-but-incomplete case
 * (the B-5 decision is unchanged).
 */
export interface ProducerRouteRtDeps {
  /**
   * Store-resident, index-free RT enumeration (un-grouped). Survives C4 — it
   * reads only the RT poller's `realtimeUpdates` map + the per-key generation
   * gate, with NO `canonical` reference.
   */
  getRealtimeTripUpdates: () => {
    tripId: string;
    delaySeconds: number;
    cancelled: boolean;
  }[];
  /**
   * Resolve the producer-built `trip-route.json` lookup ONCE per request (B2).
   * Returns a pure in-memory `tripId → routeId` closure (the loader's
   * `routeLookup()`), so grouping over N RT trips does at most one `current.json`
   * read, never one per trip. A returned `undefined` for a tripId ⇒ trip absent
   * from the frozen generation ⇒ skipped (NOT canonical fall-through, B-5).
   */
  resolveRouteForTrip: () => (tripId: string) => string | undefined;
  /**
   * Whether the `trip-route.json` artifact is loaded for the current generation
   * (`producerArtifacts.artifactsPresent().tripRoute`). `false` ⇒ the artifact is
   * wholly absent / unreadable / SHA-mismatched ⇒ `getRouteUpdate` falls through
   * to `canonicalFallback` (B1) instead of serving empty RT for every route.
   */
  artifactPresent: () => boolean;
  /**
   * Canonical RT-by-route thunk (`store.getRealtimeForRoute(routeId)`), called
   * ONLY when `artifactPresent()` is `false` (B1 wholly-absent fallback). This
   * re-introduces the `canonical` read for the duration the artifact is broken —
   * the explicit fail-open the spec mandates over a city-wide RT blackout. It is
   * NOT consulted on a per-key miss (the present-but-incomplete case keeps the
   * B-5 skip).
   */
  canonicalFallback: (routeId: string) => {
    tripId: string;
    delaySeconds: number;
    cancelled: boolean;
  }[];
  /**
 * Observability hook (I-3). Fired while grouping:
 * - PRESENT artifact: once per RT-enumeration
 * trip — `"served"` when the `trip-route.json` artifact resolved the trip to a route,
 * `"fallback"` when it did not (an unknown trip — skipped, B-5).
 * - WHOLLY-ABSENT artifact (B1):
 * fired ONCE per `getRouteUpdate` call as `"fallback"` (the canonical path answered the whole
 * route, not the artifact) — NOT once per trip, so the absent case can't drown the present-mode
 * per-trip cardinality. `index.ts` wires this to
 * `metricsRegistry.producerArtifactServedTotal{artifact:"trip_route"}`.
 */
  onArtifactResult?: (result: "served" | "fallback") => void;
}

export interface ProducerRouteRt {
  /**
   * Group the index-free RT enumeration by route via the `trip-route.json`
   * artifact, dropping trips the artifact doesn't know. The return shape matches
   * `RtRouteUpdate`, so the handler can `encodeRouteUpdate` it unchanged.
   */
  getRouteUpdate(routeId: string): RtRouteUpdate;
}

export function createProducerRouteRt(deps: ProducerRouteRtDeps): ProducerRouteRt {
  const {
    getRealtimeTripUpdates,
    resolveRouteForTrip,
    artifactPresent,
    canonicalFallback,
    onArtifactResult,
  } = deps;

  function getRouteUpdate(routeId: string): RtRouteUpdate {
    // B1: a wholly-absent / unreadable / SHA-mismatched `trip-route.json` would
    // resolve EVERY trip to `undefined` and serve `{trips:[]}` for every route
    // (a city-wide RT blackout). Fall through to the canonical RT-by-route path
    // and count a SINGLE `fallback` (the canonical path answered, not the
    // artifact). The per-key skip below is reserved for a present-but-incomplete
    // artifact (the B-5 refresh-skew case).
    if (!artifactPresent()) {
      onArtifactResult?.("fallback");
      return { routeId, trips: canonicalFallback(routeId), generatedAt: Date.now() };
    }

    // B2: resolve the trip→route lookup ONCE (one `current.json` read at most),
    // then run it per RT trip in memory — no per-trip I/O on the hot path.
    const routeForTrip = resolveRouteForTrip();
    const trips = getRealtimeTripUpdates().filter((u) => {
      const route = routeForTrip(u.tripId);
      // Count per-trip artifact resolution (I-3): a resolved trip is `served`, an unknown trip
      // (skipped, B-5) is `fallback`. The grouping itself is unchanged — only matching-route trips
      // are kept.
      onArtifactResult?.(route === undefined ? "fallback" : "served");
      return route === routeId;
    });
    return { routeId, trips, generatedAt: Date.now() };
  }

  return { getRouteUpdate };
}
