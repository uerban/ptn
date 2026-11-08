import { useCityStore } from "../stores/cityStore.ts";
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import type { Departure } from "@pt/shared";
import { REALTIME_POLL_INTERVAL_MS } from "@pt/shared/constants";
import { api } from "../services/api.ts";
import { isScheduleTileEnabled } from "../services/scheduleTileFlag.ts";
import { reportTelemetry } from "../services/errorReporter.ts";
import { backendDeparturesAllowed } from "../services/departuresPolicy.ts";
import {
  HEDGE_MS,
  DEFAULT_SCHEDULE_TILE_LIMIT,
  DEFAULT_SCHEDULE_TILE_LIMIT_WITH_LOOKAHEAD,
} from "../services/scheduleTileConstants.ts";

interface UseDeparturesResult {
  /** Always the current `stopId`'s: emptied in the render the stop changes. */
  departures: Departure[];
  loading: boolean;
  error: string | null;
  /**
   * The stop whose latest foreground fetch has finished (with departures, none,
   * or an error); `null` while the current stop's first fetch is still out, and
   * from the render in which `stopId` changes. Lets a caller start dependent
   * reads only once this stop's tile has been resolved.
   */
  settledStopId: string | null;
  refresh: () => Promise<void>;
}

interface UseDeparturesOpts {
  /** Arm the cache-miss hedge: when the tile path signals a COLD download
   *  (via `onTileDownloadStart`) and HEDGE_MS elapses before the tile settles,
   *  race a network departures call. Foreground-only; default false. The popup
   *  passes `{ hedge: true }`; ETA cards / background polls leave it off. */
  hedge?: boolean;
}

export function useDepartures(
  stopId: string | null,
  polling: boolean,
  lookAheadHours?: number,
  opts?: UseDeparturesOpts,
): UseDeparturesResult {
  const cityId = useCityStore(state => state.activeCity.id);
  const [departures, setDepartures] = useState<Departure[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settledStopId, setSettledStopId] = useState<string | null>(null);
  // Reset while rendering, not in an effect: a caller must never see the
  // previous stop's "settled", departures or error together with the new stop
  // id — not for the frame before the new read starts, and not after that
  // read fails (its catch sets only `error`, so a kept list would read as
  // the new stop's). The new stop reads as loading from its first frame, as
  // its read starts in the effect below. Background polls of the SAME stop
  // never come here and keep their list. (`prevStopId` is the stop the state
  // above belongs to: React's "adjusting state when a prop changes".)
  const [prevStopId, setPrevStopId] = useState(stopId);
  const [prevCityId, setPrevCityId] = useState(cityId);
  if (prevStopId !== stopId || prevCityId !== cityId) {
    setPrevCityId(cityId);
    setPrevStopId(stopId);
    setSettledStopId(null);
    setDepartures([]);
    setError(null);
    setLoading(stopId !== null);
  }
  const pollingRef = useRef(polling);
  pollingRef.current = polling;
  // J8/J11: latest-wins token — guards against stale out-of-order settles.
  const latestTokenRef = useRef(0);
  // Separate fg-only token so a background poll bumping `latestTokenRef` does
  // NOT prevent an in-flight foreground fetch from clearing its own loading
  // state. Background polls never touch this ref.
  const latestFgTokenRef = useRef(0);
  const hedgeWanted = opts?.hedge ?? false;
  // The pending cache-miss hedge timer, stored so the effect cleanup (and the
  // tile settle) can clear it — a stale timer firing a departures request for
  // an old stop is a fine-grained privacy leak.
  const hedgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The stop on screen. The previous stop's reads and hedge are made stale in
  // the commit that shows the new stop, in this layout effect's cleanup, not
  // only in the passive cleanup below: for a stop change that is not a
  // discrete event (a geolocation fix) React flushes passive effects in a
  // later task, and a read or hedge timer settling in between would still
  // pass the token checks — putting the old stop's list back next to the new
  // id after the render above emptied it, or asking `departures-for-stop`
  // for the old stop. A fetch or poll of a stop no longer on screen (an
  // interval or `refresh` from before the change) starts nothing.
  const shownStopRef = useRef(stopId);
  const shownCityRef = useRef(cityId);
  useLayoutEffect(() => {
    shownStopRef.current = stopId;
    shownCityRef.current = cityId;
    return () => {
      ++latestTokenRef.current;
      ++latestFgTokenRef.current;
      if (hedgeTimerRef.current) {
        clearTimeout(hedgeTimerRef.current);
        hedgeTimerRef.current = null;
      }
    };
  }, [stopId, cityId]);

  const fetchDepartures = useCallback(async (background = false) => {
    if (!stopId || stopId !== shownStopRef.current || cityId !== shownCityRef.current) return;
    // J11: bump BEFORE the first await so every path carries the current token.
    const token = ++latestTokenRef.current;
    const foreground = !background;
    // fg-only token: only bumped (and only checked) for foreground fetches.
    const fgToken = foreground ? ++latestFgTokenRef.current : 0;
    // `fresh` guards DATA writes — applies to both fg and bg fetches.
    const fresh = () => token === latestTokenRef.current && cityId === useCityStore.getState().activeCity.id;
    // `freshFg` guards LOADING/ERROR state — only foreground can own those.
    const freshFg = () => foreground && fgToken === latestFgTokenRef.current;

    if (foreground) {
      setLoading(true);
      setError(null);
    }
    // Read once per fetch so the policy is stable for the duration of this call. The gate only
    // applies inside the tile-enabled branch where the tile failed to serve data. Re-checked at
    // hedge-fire time (policy can change between start and fire).
    const allowBackend = backendDeparturesAllowed();

    // Two-entrant coordinator. The FIRST entrant (tile or hedged-legacy) to
    // settle renders and wins; the loser writes nothing to React state (the
    // tile still caches itself inside the read path). ONLY the winner clears
    // loading. `rendered` is per-call so a stale/background fetch can't win.
    let rendered = false;
    let hedgeDidFire = false;
    let tileDownloaded = false;
    const settle = (
      deps: Departure[],
      source: "tile_warm" | "tile_cold" | "hedge_legacy" | "fallback_legacy",
    ) => {
      if (!fresh() || rendered) return;
      rendered = true;
      setDepartures(deps);
      reportTelemetry("schedule_tile_served", { stopId, source, hedgeFired: hedgeDidFire });
      if (freshFg()) setLoading(false);
    };
    const clearHedge = () => {
      if (hedgeTimerRef.current) {
        clearTimeout(hedgeTimerRef.current);
        hedgeTimerRef.current = null;
      }
    };
    // "legacy" here means "the network route, as opposed to the local tile
    // path" — NOT the Node route it used to call. `api.getDepartures` targets
    // pt-serve's `departures-for-stop` since the retirement plan's step 4; the
    // name and the `hedge_legacy` / `fallback_legacy` telemetry values are kept
    // deliberately, because the rollback runbook tells operators to read the
    // `schedule_tile_served{source}` split and renaming the buckets would break
    // that series at exactly the moment it is being watched.
    const callLegacy = () =>
      api
        .getDepartures(
          stopId,
          undefined,
          lookAheadHours != null
            ? DEFAULT_SCHEDULE_TILE_LIMIT_WITH_LOOKAHEAD
            : DEFAULT_SCHEDULE_TILE_LIMIT,
          lookAheadHours,
        )
        .then((res) => res.data);

    try {
      if (isScheduleTileEnabled()) {
        // J3/G9: dynamic import keeps the Dexie/brotli read-path graph out of the
        // eager entry chunk. The factory is NOT invoked at module load time.
        const { departuresForStop } = await import("../services/scheduleTileReadPath.ts");
        if (!fresh()) return;
        // The hedge fires ONLY on a signalled cache MISS (cold download). Warm
        // opens (memo/IDB hits) never call onTileDownloadStart → never hit
        // the backend. ETA cards / background polls never arm it.
        const canHedge = foreground && hedgeWanted && allowBackend && HEDGE_MS > 0;
        const onTileDownloadStart = canHedge
          ? () => {
              tileDownloaded = true;
              if (hedgeTimerRef.current) return;
              hedgeTimerRef.current = setTimeout(() => {
                hedgeTimerRef.current = null;
                // Re-check the policy AT FIRE TIME — it can change between the
                // fetch start and the timer firing. Bail if stale or already won.
                if (!fresh() || rendered || !backendDeparturesAllowed()) return;
                hedgeDidFire = true;
                void callLegacy()
                  .then((data) => settle(data, "hedge_legacy"))
                  .catch(() => {});
              }, HEDGE_MS);
            }
          : () => {
              tileDownloaded = true;
            };
        try {
          const r = await departuresForStop(
            { stopId, now: new Date(), lookAheadHours },
            { onTileDownloadStart },
          );
          clearHedge();
          if (!fresh()) return;
          if (r.state === "ok") {
            // Tile ok (incl. zero departures) — first entrant wins.
            settle(r.departures, tileDownloaded ? "tile_cold" : "tile_warm");
            return;
          }
          // unavailable | stop_not_in_tile — fall through to api.getDepartures if allowed.
          reportTelemetry("schedule_tile_fallback", { stopId, reason: r.state });
        } catch {
          if (!fresh()) return;
          // Any throw from the tile path — fall through to api.getDepartures if allowed.
          clearHedge();
          reportTelemetry("schedule_tile_fallback", { stopId, reason: "throw" });
        }
        // If the hedge already rendered the legacy result, we're done.
        if (!fresh() || rendered) return;
        // Privacy gate: when the backend departures call is disallowed (e.g. paranoid level),
        // serve empty rather than leaking the exact stop identity.
        if (!allowBackend) {
          settle([], tileDownloaded ? "tile_cold" : "tile_warm");
          return;
        }
        settle(await callLegacy(), "fallback_legacy");
        return;
      }
      // Global-off override: always hit the backend regardless of privacy.
      settle(await callLegacy(), "fallback_legacy");
    } catch (err) {
      if (freshFg() && !rendered) {
        setError(err instanceof Error ? err.message : "Failed to fetch departures");
      }
    } finally {
      // Clear any pending hedge so it can never fire after this call settles.
      clearHedge();
      if (freshFg()) setSettledStopId(stopId);
      // Uses freshFg so a background poll bumping latestTokenRef never prevents the
      // in-flight foreground from reaching setLoading(false). Guarded by
      // `!rendered` so the winner (which already cleared loading) doesn't double-clear.
      if (freshFg() && !rendered) {
        setLoading(false);
      }
    }
  }, [stopId, cityId, lookAheadHours, hedgeWanted]);

  // Initial fetch
  useEffect(() => {
    if (!stopId) {
      setDepartures([]);
      setLoading(false);
      return;
    }
    fetchDepartures();
    // Cleanup: invalidate the call tokens AND clear any pending hedge timer so a
    // rapid stopId change (or unmount) can't fire a departures request for the old stop.
    // A stop change was already handled in the layout cleanup above; this one
    // also covers a refetch of the same stop (`lookAheadHours` or `hedge` changed).
    return () => {
      ++latestTokenRef.current;
      ++latestFgTokenRef.current;
      if (hedgeTimerRef.current) {
        clearTimeout(hedgeTimerRef.current);
        hedgeTimerRef.current = null;
      }
    };
  }, [stopId, fetchDepartures]);

  // Polling
  useEffect(() => {
    if (!stopId || !polling) return;
    const interval = setInterval(() => {
      if (pollingRef.current && navigator.onLine) fetchDepartures(true);
    }, REALTIME_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [stopId, polling, fetchDepartures]);

  // Pause/resume on visibility change
  useEffect(() => {
    if (!stopId || !polling) return;
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && pollingRef.current) {
        fetchDepartures(true);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [stopId, polling, fetchDepartures]);

  // Resume polling with immediate fetch when coming back online
  useEffect(() => {
    if (!stopId || !polling) return;

    const handleOnline = () => {
      if (pollingRef.current) fetchDepartures(true);
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [stopId, polling, fetchDepartures]);

  return { departures, loading, error, settledStopId, refresh: fetchDepartures };
}
