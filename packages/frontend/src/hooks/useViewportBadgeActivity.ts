import { useEffect, useMemo, useRef } from "react";
import { activeRouteIdsFromTile } from "@pt/shared/transit";
import { ZOOM_CARDS_MIN, VIEWPORT_BUFFER } from "@pt/shared/constants";
import type { StopWithLines } from "@pt/shared";
import { useStopStore } from "../stores/stopStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import {useCityDataStore} from "../services/cityData.ts";
import {useGtfsDataStore} from "../stores/gtfsDataStore.ts";
import { useMapViewportStore, type MapViewportBounds } from "../stores/mapViewportStore.ts";
import { useBadgeActivityStore, badgeActivityContext, BADGE_ACTIVITY_HOLD_MS, type BadgeActivity } from "../stores/badgeActivityStore.ts";
import { resolveDecodedTileForStop, warmManifest, currentManifest, currentBundleHash, resolveTileCoordsForLatLon } from "../services/scheduleTileReadPath.ts";

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
  const stopCityId = useStopStore((s) => s.cityId);
  const bounds = useMapViewportStore((s) => s.bounds);
  const zoom = useMapViewportStore((s) => s.zoom);
  const cityId = useCityStore((s) => s.activeCity.id);
  const tz = useCityStore((s) => s.activeCity.tz);
  const generationId = useCityDataStore(s => s.active?.token.cityId === cityId ? (s.active.artifact?.generation.bundleSha256 ?? s.active.token.generationId) : null);
  const publicationId = useCityDataStore(s => s.active?.token.cityId === cityId ? s.active.artifact?.generation.generationId ?? null : null);
  const manifestRefreshRef = useRef<{key: string; at: number} | null>(null);
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
    if (stopCityId != null && stopCityId !== cityId) return null;
    if (!urbanMode || !bounds || zoom == null || zoom < ZOOM_CARDS_MIN) return null;
    // Sweep the SAME buffered viewport TransitMap draws cards over, so every
    // rendered card has a resolved badge entry (no border fail-open).
    const sweepBounds = bufferedBounds(bounds);
    const next = stops.filter((s) => s.location && inBounds(sweepBounds, s.location.lat, s.location.lon));
    if (next.length === 0) return null;
    const key = `${cityId}\n` + next
      .map((s) => s.id)
      .sort()
      .join("\n");
    const prev = prevInViewRef.current;
    if (prev && prev.key === key) return prev.stops;
    prevInViewRef.current = { key, stops: next };
    return next;
  }, [urbanMode, bounds, zoom, stops, stopCityId, cityId]);

  useEffect(() => {
    const context = badgeActivityContext(cityId, lookAheadHours, tz, generationId);
    useBadgeActivityStore.getState().activateContext(context);
    // Do not resolve badges against API coordinates and then invalidate those
    // same verdicts when the initial catalog arrives. Initial urban entry is
    // name-only until one owning catalog generation can qualify the sweep.
    if (!inView || !generationId) return;
    // Non-null alias so the async closures below keep the narrowing.
    const inViewStops = inView;

    // Retain nearby verdicts across small pans, with a bounded history.
    useBadgeActivityStore.getState().retainViewport(new Set(inViewStops.map((s) => s.id)));

    let cancelled = false;
    const myRun = ++runRef.current;
    const tick = () => Math.floor(Date.now() / TICK_MS);

    async function compute() {
      const started = performance.now();
      let readyCount = 0;
      let reusedCount = 0;
      const now = new Date(tick() * TICK_MS);
      // Mark stops we have NO prior entry for as loading — ONE batched write so a
      // known stop is never blanked (no blink) and we don't re-render per stop.
      const known = useBadgeActivityStore.getState().byStop;
      const loading: Array<[string, BadgeActivity]> = [];
      for (const s of inViewStops) if (!known.has(s.id)) loading.push([s.id, { state: "loading" }]);
      useBadgeActivityStore.getState().setMany(loading, context);
      useBadgeActivityStore.getState().retainViewport(new Set(inViewStops.map(s => s.id)));

      // Resolve the manifest ONCE for the whole viewport sweep, then reuse it for
      // every stop. Resolving it per stop (the old behaviour) fired one
      // `fetchManifest` per in-view stop, storming `/gtfs/manifest` to a 429.
      await warmManifest();
      if (cancelled || myRun !== runRef.current) return;
      const manifest = currentManifest();
      const bundleHash = currentBundleHash();
      const mismatchedPublication = !!publicationId && !!bundleHash && publicationId !== bundleHash;
      if (!manifest || !bundleHash || mismatchedPublication) {
        // Manifest unavailable — mark all in-view stops unavailable WITHOUT a
        // per-stop fetch (which would re-storm on the failure path).
        useBadgeActivityStore.getState().setMany(inViewStops.map((s) => [s.id, { state: "unavailable" }]), context);
        if (mismatchedPublication) {
          // pt-serve validates manifest.bundleHash against its publication ID.
          // A cached catalog must not consume verdicts from a newer timetable.
          const state = useGtfsDataStore.getState();
          const key = `${cityId}:${publicationId}:${bundleHash}`;
          const previous = manifestRefreshRef.current;
          if (!state.syncing && !state.refreshing && state.loadedCityId === cityId &&
              (!previous || previous.key !== key || Date.now() - previous.at >= TICK_MS)) {
            manifestRefreshRef.current = {key, at: Date.now()};
            void state.refresh(cityId).catch(() => {});
          }
        }
        return;
      }
      const shared = { manifest, bundleHash };

      // Group by geographic tile before resolving canonical coordinates. A
      // boundary correction still goes through the normal read path. Keeping
      // two groups active matches the decoded memo budget and avoids walking
      // an interleaved stop-ID list that repeatedly decodes evicted tiles.
      const groups = new Map<string, StopWithLines[]>();
      const qualified = useBadgeActivityStore.getState();
      for (const stop of inViewStops) {
        const previous = qualified.byStop.get(stop.id);
        const age = Date.now() - (qualified.resolvedAt.get(stop.id) ?? 0);
        if (previous?.state === "ready" && previous.windowStart === now.getTime() &&
            previous.publicationId === publicationId && age >= 0 && age < BADGE_ACTIVITY_HOLD_MS) {
          readyCount++;
          reusedCount++;
          continue;
        }
        const key = resolveTileCoordsForLatLon(manifest, stop.location.lat, stop.location.lon) ?? "unresolved";
        const group = groups.get(key) ?? [];
        group.push(stop);
        groups.set(key, group);
      }
      const queue = [...groups.values()];
      let nextGroup = 0;
      async function worker() {
        while (!cancelled && myRun === runRef.current) {
          const group = queue[nextGroup++];
          if (!group) return;
          const results: Array<[string, BadgeActivity]> = [];
          for (const stop of group) {
            if (cancelled || myRun !== runRef.current) return;
            let activity: BadgeActivity;
            try {
              const r = await resolveDecodedTileForStop(stop.id, undefined, shared);
              activity = r.state === "ok"
                ? { state: "ready", routeIds: activeRouteIdsFromTile({ tile: r.tile, stopId: stop.id, now, lookAheadHours, tz }),
                    windowStart: now.getTime(), publicationId }
                : { state: "unavailable" };
            } catch { activity = { state: "unavailable" }; }
            if (activity.state === "ready") readyCount++;
            results.push([stop.id, activity]);
          }
          if (cancelled || myRun !== runRef.current) return;
          // Publish one completed tile group without waiting for a slower
          // neighboring tile; never publish per stop.
          useBadgeActivityStore.getState().setMany(results, context);
        }
      }
      await Promise.all([worker(), worker()]);
      if (cancelled || myRun !== runRef.current) return;
      // Bounded local diagnostics distinguish qualified tile activity from
      // unchanged name-only DOM. No stop identities or coordinates are stored.
      const name = "ptn:city:badge-activity";
      performance.clearMeasures(name);
      performance.measure(name, {start: started, end: performance.now(), detail: {
        cityId, outcome: readyCount === inViewStops.length ? "complete" : "partial",
        ready: readyCount, requested: inViewStops.length, reused: reusedCount,
      }});
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
  }, [inView, lookAheadHours, tz, cityId, generationId, publicationId]);
}
