import { useEffect, useMemo, useRef } from "react";
import { activeRouteIdsFromTile } from "@pt/shared/transit";
import { ZOOM_CARDS_MIN, VIEWPORT_BUFFER } from "@pt/shared/constants";
import type { StopWithLines } from "@pt/shared";
import { useStopStore } from "../stores/stopStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useMapViewportStore, type MapViewportBounds } from "../stores/mapViewportStore.ts";
import { useBadgeActivityStore, type BadgeActivity } from "../stores/badgeActivityStore.ts";
import { resolveDecodedTileForStop, warmManifest, currentManifest, currentBundleHash } from "../services/scheduleTileReadPath.ts";

const TICK_MS = 60_000;

function inBounds(b: MapViewportBounds, lat: number, lon: number): boolean {
  return lat <= b.north && lat >= b.south && lon <= b.east && lon >= b.west;
}

/**
 * Expand viewport bounds by `VIEWPORT_BUFFER` on every side — the SAME buffer
 * `TransitMap.updateMarkers` uses to pre-render stop cards. The badge sweep
 * must cover at least the cards that actually get drawn, or a buffer-ring card
 * has no resolved badge entry and `useVisibleStops` fails open to its full
 * (stale) line set — the near-border false-label bug.
 */
function bufferedBounds(b: MapViewportBounds): MapViewportBounds {
  const latSpan = b.north - b.south;
  const lonSpan = b.east - b.west;
  return {
    north: b.north + latSpan * VIEWPORT_BUFFER,
    south: b.south - latSpan * VIEWPORT_BUFFER,
    east: b.east + lonSpan * VIEWPORT_BUFFER,
    west: b.west - lonSpan * VIEWPORT_BUFFER,
  };
}

/**
 * Prefetch the schedule tiles covering the current viewport and compute each
 * in-viewport stop's active route set into `badgeActivityStore`, so urban-mode
 * card badges can be sourced from the (complete) tile data rather than the
 * canonical-only RAPTOR index. Schedule-only; bounded to the viewport;
 * recomputes on viewport / minute-tick change. No-op unless urban mode is on
 * and the map is at card zoom.
 */
export function useViewportBadgeActivity(): void {
  const urbanMode = useSettingsStore((s) => s.urbanMode);
  const lookAheadHours = useSettingsStore((s) => s.urbanLookaheadHours);
  const stops = useStopStore((s) => s.stops);
  const bounds = useMapViewportStore((s) => s.bounds);
  const zoom = useMapViewportStore((s) => s.zoom);
  const tz = useCityStore((s) => s.activeCity.tz);
  const runRef = useRef(0);
  const prevInViewRef = useRef<{ key: string; stops: StopWithLines[] } | null>(null);

  // In-view set with MEMBERSHIP-STABLE identity. `stops` identity flips on
  // every `upsertStops` (departure enrichment, preloader batches) and the
  // bounds object on every pan — restarting the sweep loop each time re-ran
  // the O(total stops) filter AND the tile resolve round for a viewport whose
  // stop membership hadn't changed. Key by sorted in-view ids and return the
  // previous array when membership is unchanged, so the effect below only
  // restarts when a different set of stops needs badges. (Badge activity is
  // per-stop-id; stop object churn can't change a verdict.)
  const inView = useMemo(() => {
    if (!urbanMode || !bounds || zoom == null || zoom < ZOOM_CARDS_MIN) return null;
    // Sweep the SAME buffered viewport TransitMap draws cards over, so every
    // rendered card has a resolved badge entry (no border fail-open).
    const sweepBounds = bufferedBounds(bounds);
    const next = stops.filter((s) => s.location && inBounds(sweepBounds, s.location.lat, s.location.lon));
    if (next.length === 0) return null;
    const key = next
      .map((s) => s.id)
      .sort()
      .join("\n");
    const prev = prevInViewRef.current;
    if (prev && prev.key === key) return prev.stops;
    prevInViewRef.current = { key, stops: next };
    return next;
  }, [urbanMode, bounds, zoom, stops]);

  useEffect(() => {
    if (!inView) return;
    // Non-null alias so the async closures below keep the narrowing.
    const inViewStops = inView;

    // Bound memory to the current viewport set.
    useBadgeActivityStore.getState().evictExcept(new Set(inViewStops.map((s) => s.id)));

    let cancelled = false;
    const myRun = ++runRef.current;
    const tick = () => Math.floor(Date.now() / TICK_MS);

    async function compute() {
      const now = new Date(tick() * TICK_MS);
      // Mark stops we have NO prior entry for as loading — ONE batched write so a
      // known stop is never blanked (no blink) and we don't re-render per stop.
      const known = useBadgeActivityStore.getState().byStop;
      const loading: Array<[string, BadgeActivity]> = [];
      for (const s of inViewStops) if (!known.has(s.id)) loading.push([s.id, { state: "loading" }]);
      useBadgeActivityStore.getState().setMany(loading);

      // Resolve the manifest ONCE for the whole viewport sweep, then reuse it for
      // every stop. Resolving it per stop (the old behaviour) fired one
      // `fetchManifest` per in-view stop, storming `/gtfs/manifest` to a 429.
      await warmManifest();
      if (cancelled || myRun !== runRef.current) return;
      const manifest = currentManifest();
      const bundleHash = currentBundleHash();
      if (!manifest || !bundleHash) {
        // Manifest unavailable — mark all in-view stops unavailable WITHOUT a
        // per-stop fetch (which would re-storm on the failure path).
        useBadgeActivityStore.getState().setMany(inViewStops.map((s) => [s.id, { state: "unavailable" }]));
        return;
      }
      const shared = { manifest, bundleHash };

      // Resolve + compute each stop, then flush in ONE setMany so the viewport
      // updates atomically (one re-render, no full→reduced blink). Each per-stop
      // resolve reuses `shared`, so getDecodedTile memoizes the decode and no
      // further manifest fetch happens.
      const results: Array<[string, BadgeActivity]> = [];
      for (const s of inViewStops) {
        if (cancelled || myRun !== runRef.current) return;
        let activity: BadgeActivity;
        try {
          const r = await resolveDecodedTileForStop(s.id, undefined, shared);
          activity = r.state === "ok"
            ? { state: "ready", routeIds: activeRouteIdsFromTile({ tile: r.tile, stopId: s.id, now, lookAheadHours, tz }) }
            : { state: "unavailable" };
        } catch {
          activity = { state: "unavailable" };
        }
        results.push([s.id, activity]);
      }
      if (cancelled || myRun !== runRef.current) return;
      useBadgeActivityStore.getState().setMany(results);
    }

    // Reschedule-after-settle (NOT setInterval): a single compute() is ever in
    // flight per effect run, and the next minute-tick is scheduled only after the
    // previous round resolves. This prevents a slow initial round and a fast
    // interval round from interleaving their setMany writes (stale-result race),
    // and prevents rounds from stacking if one exceeds TICK_MS on a cold cache.
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function loop() {
      if (cancelled || myRun !== runRef.current) return;
      await compute();
      if (cancelled || myRun !== runRef.current) return;
      timer = setTimeout(() => { void loop(); }, TICK_MS);
    }
    void loop();
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [inView, lookAheadHours, tz]);
}
