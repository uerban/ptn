/**
 * Memo of walk routes per (city, profile, endpoints). The walk graph is
 * immutable for the session, so entries never expire — only an LRU cap and
 * `clearWalkRouteCache()` (data deletion) drop them. A null result ("no
 * walkable route", or "this city has no walk graph") is cached too, so the
 * map and the guidance loop do not re-ask on every render.
 *
 * A rejection (`WalkGraphUnavailableError`: the graph could not load now but
 * may later) is passed through and NOT cached, so the next call asks again.
 */
import type { LatLon } from "@pt/shared";
import type { WalkProfile, WalkRoute } from "./walkGraphClient.ts";

export interface WalkRouteSource {
  routeFor(cityId: string, from: LatLon, to: LatLon, profile: WalkProfile): Promise<WalkRoute | null>;
}

const MAX_ENTRIES = 500;
const cache = new Map<string, WalkRoute | null>();
const nullExpires = new Map<string, number>();
const inFlight = new Map<string, Promise<WalkRoute | null>>();
/** Bumped by `clearWalkRouteCache()`: an answer to a request made before the
 *  clear is returned to its caller but not stored. */
let generation = 0;
const resetListeners = new Set<() => void>();
export const walkRouteCacheRevision = (): number => generation;
export function subscribeWalkRouteCacheReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => { resetListeners.delete(listener); };
}

// 1e-5° ≈ 1 m: an itinerary's leg endpoints are stable to far better than that.
const round = (n: number) => Math.round(n * 1e5) / 1e5;

export function walkRouteKey(cityId: string, from: LatLon, to: LatLon, profile: WalkProfile): string {
  return `${cityId}|${profile}|${round(from.lat)},${round(from.lon)}|${round(to.lat)},${round(to.lon)}`;
}

/** Synchronous lookup: the route, null (known: none), or undefined (not asked
 *  yet, or the last ask failed transiently). */
export function peekWalkRoute(cityId: string, from: LatLon, to: LatLon, profile: WalkProfile): WalkRoute | null | undefined {
  const key = walkRouteKey(cityId, from, to, profile);
  if ((nullExpires.get(key) ?? Infinity) <= Date.now()) {
    cache.delete(key);
    nullExpires.delete(key);
  }
  return cache.has(key) ? (cache.get(key) ?? null) : undefined;
}

/** The cached answer, or one fetch shared by concurrent callers. Rejects
 *  (uncached) when the source rejects. */
export function getOrFetchWalkRoute(
  cityId: string,
  from: LatLon,
  to: LatLon,
  profile: WalkProfile,
  source: WalkRouteSource,
): Promise<WalkRoute | null> {
  const key = walkRouteKey(cityId, from, to, profile);
  if (peekWalkRoute(cityId, from, to, profile) !== undefined) {
    const hit = cache.get(key) ?? null;
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }
  const ongoing = inFlight.get(key);
  if (ongoing) return ongoing;
  const gen = generation;
  const promise = source
    .routeFor(cityId, from, to, profile)
    .then((route) => {
      if (gen !== generation) return route;
      cache.set(key, route);
      if (route === null) nullExpires.set(key, Date.now() + 60_000);
      else nullExpires.delete(key);
      while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
        nullExpires.delete(oldest);
      }
      return route;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export function clearWalkRouteCache(): void {
  generation++;
  cache.clear();
  nullExpires.clear();
  inFlight.clear();
  for (const listener of resetListeners) listener();
}

export function __walkRouteCacheSize(): number {
  return cache.size;
}
