import { useEffect, useState, useSyncExternalStore } from "react";
import type { LatLon } from "@pt/shared";
import { useCityStore } from "../stores/cityStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { walkGraphClient, walkProfileFor, type WalkRoute } from "../services/walkGraphClient.ts";
import {
  getOrFetchWalkRoute,
  peekWalkRoute,
  walkRouteKey,
  walkRouteCacheRevision,
  subscribeWalkRouteCacheReset,
  type WalkRouteSource,
} from "../services/walkRouteCache.ts";

/** After a transient failure (`WalkGraphUnavailableError`) the hook re-asks
 *  every `WALK_ROUTE_RETRY_MS` while mounted; the client's backoff decides
 *  when a real fetch happens (inside its window `routeFor` rejects at once,
 *  without fetching). Never on render, so an outage cannot spin. */
export const WALK_ROUTE_RETRY_MS = 15_000;

/** Walk-graph route for the active city and mobility profile.
 *  `pending` is true only while the first answer for these endpoints is
 *  outstanding; afterwards `route` is the path or null (no route / no graph /
 *  not available yet — then the straight line is drawn and the hook
 *  re-asks every `WALK_ROUTE_RETRY_MS`).
 *  With a null endpoint (no walk leg) it asks nothing and answers no route. */
export function useWalkRoute(
  from: LatLon | null,
  to: LatLon | null,
  source: WalkRouteSource = walkGraphClient,
): { route: WalkRoute | null; pending: boolean } {
  const cityId = useCityStore((s) => s.activeCity.id);
  const profile = walkProfileFor(useSettingsStore((s) => s.mobilityProfile));
  const cacheRevision = useSyncExternalStore(subscribeWalkRouteCacheReset, walkRouteCacheRevision, walkRouteCacheRevision);
  const enabled = from !== null && to !== null;
  // NaN when disabled: Object.is(NaN, NaN), so the deps stay stable.
  const fromLat = from?.lat ?? NaN;
  const fromLon = from?.lon ?? NaN;
  const toLat = to?.lat ?? NaN;
  const toLon = to?.lon ?? NaN;
  const key = enabled ? walkRouteKey(cityId, from, to, profile) + "|" + cacheRevision : "";
  const [resolved, setResolved] = useState<{ key: string; route: WalkRoute | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const f = { lat: fromLat, lon: fromLon };
    const t = { lat: toLat, lon: toLon };
    if (peekWalkRoute(cityId, f, t, profile) !== undefined) return;
    const k = walkRouteKey(cityId, f, t, profile) + "|" + cacheRevision;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    getOrFetchWalkRoute(cityId, f, t, profile, source).then(
      (route) => {
        if (!cancelled) {
          setResolved({ key: k, route });
          if (route === null) retry = setTimeout(() => setAttempt(n => n + 1), 60_000);
        }
      },
      () => {
        if (cancelled) return;
        // Keep the same state object on every outage tick: no re-render.
        setResolved((p) => (p?.key === k && p.route === null ? p : { key: k, route: null }));
        retry = setTimeout(() => setAttempt((n) => n + 1), WALK_ROUTE_RETRY_MS);
      },
    );
    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [enabled, cityId, profile, fromLat, fromLon, toLat, toLon, source, attempt, cacheRevision]);

  if (!enabled) return { route: null, pending: false };
  const cached = peekWalkRoute(cityId, from, to, profile);
  if (cached !== undefined) return { route: cached, pending: false };
  if (resolved?.key === key) return { route: resolved.route, pending: false };
  return { route: null, pending: true };
}
