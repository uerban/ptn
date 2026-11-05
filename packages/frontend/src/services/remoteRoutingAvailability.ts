import { useEffect, useSyncExternalStore } from "react";

/**
 * Availability of the remote routing source. A cached, bounded- timeout, **fail-closed**
 * up/down signal, refreshed OFF the search hot path (probe on mount + city change + a
 * background interval, never per-search).

 *
 * v1 has a single first-party source (pt-serve), always *configured* — so this
 * is up/down only; the "operator never configured ⇒ hide" distinction and the
 * `routingProvider` enum are Phase-2 (multi-provider). The probe is a no-query,
 * not-consent-gated readiness GET. It is an OPTIMIZATION HINT: the
 * real remote→on-device fallback still fires on the actual `plan()` rejection.
 */

const PROBE_TIMEOUT_MS = 3000;
const REFRESH_INTERVAL_MS = 60_000;

// Last-known availability for the most-recently-probed city. `null` = not yet
// probed. Optimistic (true) until a probe for THE QUERIED city resolves, so the
// S1 "Search on the server" recovery affordance is never hidden on a working
// remote during the pre-probe window; fail-closed (false) once a probe errors.
let state: { cityId: string; available: boolean } | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

export function subscribeRemoteRoutingAvailable(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

/** Optimistic (true) until a probe for `cityId` has resolved; fail-closed after. */
export function getRemoteRoutingAvailableSnapshot(cityId: string): boolean {
  if (state == null || state.cityId !== cityId) return true;
  return state.available;
}

type ProbeFetch = (
  url: string,
  init: { signal: AbortSignal; cache: RequestCache },
) => Promise<{ ok: boolean; status?: number }>;

const defaultFetch: ProbeFetch = (url, init) => fetch(url, init);

/**
 * Bounded-timeout, fail-closed readiness probe of the remote routing backend.
 * Carries no query and is not consent-gated. Updates the cache +
 * notifies subscribers. `fetchImpl` is injectable for tests.
 */
export async function probeRemoteRoutingAvailability(
  cityId: string,
  fetchImpl: ProbeFetch = defaultFetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let available: boolean;
  let failure: string | null = null;
  try {
    // `no-store` keeps the HTTP cache out of a liveness answer; the service
    // worker is kept out by the /health NetworkOnly rule (sw/runtimeCaching.ts).
    const res = await fetchImpl(`/api/${cityId}/health/ready`, {
      signal: controller.signal,
      cache: "no-store",
    });
    available = res.ok;
    if (!res.ok) failure = `non-ok status ${res.status ?? "?"}`;
  } catch (err) {
    available = false;
    failure = controller.signal.aborted
      ? `timeout after ${PROBE_TIMEOUT_MS}ms`
      : `network error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
  }
  const changed = state == null || state.cityId !== cityId || state.available !== available;
  state = { cityId, available };
  if (changed) {
    // Warn ONLY on a TRANSITION (not every 60s tick) so a permanent
    // misconfiguration (wrong path ⇒ non-ok 404, CSP/CORS block) is visible and
    // distinguishable from a transient outage — without console spam.
    if (!available && failure != null) {
      console.warn(`[remoteRoutingAvailability] remote routing source marked unavailable (city=${cityId}): ${failure}`);
    }
    notify();
  }
  return available;
}

/**
 * Reactive availability of the remote routing source for `cityId`. Drives a
 * probe on mount + city change + a background interval (off the search hot path).
 */
export function useRemoteRoutingAvailable(cityId: string): boolean {
  const available = useSyncExternalStore(
    subscribeRemoteRoutingAvailable,
    () => getRemoteRoutingAvailableSnapshot(cityId),
    () => true,
  );
  useEffect(() => {
    void probeRemoteRoutingAvailability(cityId);
    const id = setInterval(() => { void probeRemoteRoutingAvailability(cityId); }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [cityId]);
  return available;
}

/** Test-only: clear module state between cases. */
export function __resetRemoteRoutingAvailabilityForTest(): void {
  state = null;
  subscribers.clear();
}
