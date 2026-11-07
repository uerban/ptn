import { useEffect, useRef } from "react";
import type { LatLon, StopWithLines } from "@pt/shared";
import { api, HttpError } from "../services/api.ts";
import { reportError } from "../services/errorReporter.ts";
import { useStopStore } from "../stores/stopStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { canUse } from "../privacy/canUse.ts";
import { haversineDistance } from "../utils/geo.ts";

const RETRY_BACKOFFS_MS = [1_000, 4_000] as const;
const MAX_PRELOAD_ATTEMPTS = RETRY_BACKOFFS_MS.length + 1;

/** Select the closest public stop centroid without exposing the measured
 * position. The returned object is already public GTFS data and is the only
 * coordinate permitted at the `/stops/nearby` boundary. */
export function nearestStopCentroid(
  location: LatLon,
  stops: readonly StopWithLines[],
): LatLon | null {
  let nearest: LatLon | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    const distance = haversineDistance(location, stop.location);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = stop.location;
    }
  }
  return nearest;
}

/**
 * Loads the city's stop list into the local cache. The preloader is
 * mode-agnostic: it always fetches the full set regardless of urban mode.
 * Urban-mode filtering is a view-time concern — see `useVisibleStops` —
 * so the stop cache stays stable across mode toggles and the filter just
 * re-derives from locally available timetable + RT data.
 *
 * Two paths coexist:
 *   1. `loadAll` — one-shot per city: full stop list from the backend.
 *      Retried with bounded exponential backoff because `/stops/all` is
 *      multi-MB on Oslo-scale cities and a single transient stall used
 *      to leave badges stuck for the rest of the session.
 *      When every attempt fails (server down, rate-limited), it falls back to
 *      `overlayBundleStops` so the map draws from the on-device PTB bundle
 *      instead of staying empty.
 *   2. `loadNearby` — after an explicit location request (`requestId`), uses
 *      GPS locally to select the nearest cached stop centroid. Only that public
 *      centroid reaches the backend, once per request. Passive tracking updates
 *      never query the server; the full cached set already covers them. With no
 *      cached centroid, loadAll remains the sole path.
 */
export function useStopPreloader(location: LatLon | null, requestId = 0) {
  const hydrated = useStopStore((s) => s.hydrated);
  const activeCityId = useCityStore((s) => s.activeCity.id);
  const cachedStops = useStopStore((s) => s.stops);
  const centroid = location ? nearestStopCentroid(location, cachedStops) : null;
  const hasCentroid = centroid !== null;
  const servedRequestRef = useRef(0);
  const allLoadedRef = useRef(false);
  const lastCityRef = useRef<string>("");

  useEffect(() => {
    if (!hydrated) {
      useStopStore.getState().hydrate();
    }
  }, [hydrated]);

  useEffect(() => {
    // Wait for the first fix after a request, then serve that request once.
    if (!location || !hydrated || !hasCentroid || requestId === 0 ||
        servedRequestRef.current === requestId) return;
    servedRequestRef.current = requestId;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Snapshot the city at request entry. A city switch during the fetch
    // OR during the awaits inside upsertStops would otherwise let city A's
    // nearby stops land in city B's store. The closure is passed to
    // upsertStops as `isStale` so the store can short-circuit between its
    // internal awaits.
    const requestCityId = activeCityId;
    const isStale = () =>
      cancelled || useCityStore.getState().activeCity.id !== requestCityId;

    // Mirrors the loadAll retry pattern: bounded backoff on transient failure
    // (including 503 during pt-serve's ~15 s self-reload window). On
    // exhaustion, silently degrade — nearby is best-effort and the map
    // already has the full stop set from loadAll; no errorReporter call.
    async function attemptNearby(attemptIdx: number): Promise<void> {
      if (isStale()) return;
      // Resolve the flow and cached stops at the request boundary. A
      // revocation after render (or between retries) must stop future egress.
      if (!canUse("operator.nearby-stop-centroid")) return;
      const centroid = nearestStopCentroid(
        location!,
        useStopStore.getState().stops,
      );
      if (!centroid) return;
      try {
        const nearby = await api.getNearbyStops(
          centroid.lat,
          centroid.lon,
          1000,
        );
        if (isStale() || nearby.data.length === 0) return;
        if (!canUse("operator.nearby-stop-centroid")) return;
        await useStopStore.getState().upsertStops(nearby.data, { isStale });
      } catch (e) {
        if (isStale()) return;
        console.debug("[preloader] nearby error:", e);
        const nextDelay = RETRY_BACKOFFS_MS[attemptIdx];
        if (nextDelay !== undefined) {
          const t = setTimeout(() => attemptNearby(attemptIdx + 1), nextDelay);
          timers.push(t);
        }
        // After the last attempt: degrade silently. The /stops/all path is
        // independent and still provides the full stop set.
      }
    }

    attemptNearby(0);
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [requestId, hasCentroid, activeCityId, hydrated]);

  // Load all stops once per city. No `withinHours` filter — the full set
  // stays cached and `useVisibleStops` handles view-time filtering using
  // the locally available timetable + RT.
  //
  // Gated on `hydrated`: hydrate's `set({ stops, hydrated: true })` is an
  // overwrite, not a merge. If loadAll's upsertStops lands first (which
  // happens with sub-ms mocked responses or warm SW caches), hydrate's
  // later resolve replaces the freshly-upserted stops with the cached
  // (potentially empty) set, leaving the map without features. Waiting
  // for hydrated ensures the overwrite has already happened before any
  // upsert merges into the post-hydrate state.
  useEffect(() => {
    if (!hydrated) return;
    if (allLoadedRef.current && lastCityRef.current === activeCityId) return;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Snapshot like loadNearby above — closes the city-switch leak window
    // for the multi-attempt loadAll path too.
    const requestCityId = activeCityId;
    const isStale = () =>
      cancelled || useCityStore.getState().activeCity.id !== requestCityId;

    // Last resort once the network path is out of attempts: draw the map from
    // the PTB bundle already on the device (db.gtfsStops + db.gtfsRoutes) —
    // the very data pt-serve builds /stops/all from. Without this the map
    // stays empty for the rest of the session on a server outage while the
    // on-device planner keeps answering trips from the same bundle. Never
    // marks `allLoadedRef`: the bundle is a floor, not a completed load, so
    // the next preloader trigger still tries the network.
    async function fallBackToBundle(): Promise<void> {
      if (isStale()) return;
      await useStopStore.getState().overlayBundleStops();
    }

    async function attempt(attemptIdx: number): Promise<void> {
      if (isStale()) return;
      try {
        // Retry attempts bypass the SW NetworkFirst cache via a query-string
        // cache-buster — without this, a poisoned `api-stops-cache-v1` entry
        // (e.g. an earlier `{data:[]}` cached during a 5s network race fallback)
        // would keep being served and every retry would observe the same empty
        // response. See `getAllStops` in services/api.ts for the mechanism.
        const all = attemptIdx > 0
          ? await api.getAllStops({ bypassCache: true })
          : await api.getAllStops();
        if (isStale()) return;
        if (all.data.length === 0) {
          // Empty data on /stops/all is treated as a transient failure rather
          // than silent success. A real city always has stops; an empty payload
          // is almost always a poisoned SW cache hit or a scheduler-not-ready
          // race that the next attempt (with cache bypass) can recover from.
          throw new Error("/stops/all returned empty data");
        }
        await useStopStore.getState().upsertStops(all.data, { isStale });
        if (isStale()) return;
        allLoadedRef.current = true;
        lastCityRef.current = activeCityId;
      } catch (e) {
        if (isStale()) return;
        // 429 short-circuit. Retrying within the backoff window guarantees
        // another 429 (rate-limit windows are minute-scale on the backend);
        // worse, on shared-NAT networks a single misbehaving user can burn
        // the whole subnet's budget. Report once with the rate-limit context
        // and stop — the next preloader trigger (city switch, page reload)
        // gets a fresh window.
        if (e instanceof HttpError && e.status === 429) {
          reportError(e, {
            context: {
              where: "useStopPreloader.loadAll.rateLimited",
              attempts: attemptIdx + 1,
              cityId: activeCityId,
            },
          });
          await fallBackToBundle();
          return;
        }
        // Schedule the next attempt inside the backoff window. After the
        // last attempt, surface a warn — the most common failure mode is
        // a stalled multi-MB fetch on weak networks; without this, badge
        // labels silently lag the live schedule view for the rest of the
        // session because the effect dep is [activeCityId] and won't
        // re-trigger until the user changes cities.
        const nextDelay = RETRY_BACKOFFS_MS[attemptIdx];
        if (nextDelay !== undefined) {
          const t = setTimeout(() => attempt(attemptIdx + 1), nextDelay);
          timers.push(t);
        } else {
          reportError(e instanceof Error ? e : new Error(String(e)), {
            context: {
              where: "useStopPreloader.loadAll",
              attempts: MAX_PRELOAD_ATTEMPTS,
              cityId: activeCityId,
            },
          });
          await fallBackToBundle();
        }
      }
    }

    attempt(0);
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [activeCityId, hydrated]);
}
