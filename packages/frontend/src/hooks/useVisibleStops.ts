import { useEffect, useMemo, useState } from "react";
import type { StopWithLines } from "@pt/shared";
import { useStopStore } from "../stores/stopStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import {useCityDataStore} from "../services/cityData.ts";
import {
  resolveActivityWindow,
  stopActivityDecidable,
  stopMaybeActive,
} from "../services/hasUpcomingDeparture.ts";
import { useBadgeActivityStore, badgeActivityContext, BADGE_ACTIVITY_HOLD_MS } from "../stores/badgeActivityStore.ts";

const FILTER_TICK_MS = 60_000;

/**
 * Urban stop visibility comes from the resident timetable; badge route sets
 * come from schedule tiles. Pending or unavailable tile activity renders names
 * and dots without speculative full-route badges. Refreshing the timetable
 * does not suspend an already valid visibility or badge verdict.
 */
export function useVisibleStops(): StopWithLines[] {
  const stops = useStopStore((s) => s.stops);
  const stopCityId = useStopStore((s) => s.cityId);
  const urbanMode = useSettingsStore((s) => s.urbanMode);
  const urbanLookaheadHours = useSettingsStore((s) => s.urbanLookaheadHours);
  const residentIndex = useGtfsDataStore((s) => s.raptorIndex);
  const residentCityId = useGtfsDataStore((s) => s.loadedCityId);
  // Feed timezone for the active city — threaded into `stopMaybeActive` so a
  // cross-tz device places "now" on the city's wall clock (and thus the
  // correct service day) rather than its own. Without it, a foreign device
  // near its local midnight filters the wrong day's stops while the results
  // list below renders the correct day — an invisible split.
  const cityId = useCityStore((s) => s.activeCity.id);
  const raptorIndex = residentCityId != null && residentCityId !== cityId ? null : residentIndex;
  const feedTz = useCityStore((s) => s.activeCity.tz);
  // Per-stop badge activity sourced from schedule tiles by
  // `useViewportBadgeActivity`. Read here so the memo re-runs when it changes.
  const activityByStop = useBadgeActivityStore((s) => s.byStop);
  const resolvedAt = useBadgeActivityStore((s) => s.resolvedAt);
  const activityContext = useBadgeActivityStore((s) => s.context);
  const generationId = useCityDataStore(s => s.active?.token.cityId === cityId ? (s.active.artifact?.generation.bundleSha256 ?? s.active.token.generationId) : null);
  const expectedContext = badgeActivityContext(cityId, urbanLookaheadHours, feedTz, generationId);

  // Minute-bucketed tick — `now` is memoized so pure re-renders don't
  // invalidate the filter. Using `Math.floor(Date.now() / 60_000)` as the
  // dep key means the filter only re-runs when we actually cross a
  // minute boundary, not on every state change.
  const [minuteBucket, setMinuteBucket] = useState(() =>
    Math.floor(Date.now() / FILTER_TICK_MS),
  );
  useEffect(() => {
    if (!urbanMode) return;
    // Refresh the bucket on mode-on so a long OFF period doesn't leave us
    // filtering against a stale `now`.
    setMinuteBucket(Math.floor(Date.now() / FILTER_TICK_MS));
    const id = setInterval(() => {
      setMinuteBucket(Math.floor(Date.now() / FILTER_TICK_MS));
    }, FILTER_TICK_MS);
    return () => clearInterval(id);
  }, [urbanMode]);

  // Stage 1 — index visibility. The expensive city-wide `stopMaybeActive`
  // pass (pattern-column reads per stop) deliberately does NOT depend on
  // `activityByStop`: the badge store's Map identity flips on every tile
  // sweep settle, and re-running this pass per settle was a full-city
  // refilter for data that can't change an index verdict. It re-runs only on
  // stop-set / index / minute-tick changes; the tile-sourced narrowing lives
  // in the cheap stage-2 memo below.
  const indexVisible = useMemo(() => {
    if (stopCityId != null && stopCityId !== cityId) return [];
    if (!urbanMode) return stops;
    if (!raptorIndex) return stops;

    const now = new Date(minuteBucket * FILTER_TICK_MS);
    // Resolve the activity window ONCE per memo run: it depends only on
    // (now, lookahead, services, feedTz), never on the stop. Resolving it
    // inside `stopMaybeActive` per stop costs an Intl formatToParts + a full
    // services-map scan each — O(stops × services) every minute tick.
    const activityWindow = resolveActivityWindow(now, urbanLookaheadHours, raptorIndex, feedTz);
    // Visibility gate. Pattern-COVERED stop (production: every served
    // stop): `stopMaybeActive` reads real pattern-column times, so its
    // verdict is authoritative — serviceless stops drop here, city-wide,
    // at every zoom, with no tile involvement. Uncovered stop (legacy
    // index / per-route wire): fail-open — keep the stop unless the index
    // positively says it has no upcoming departures AND can determine
    // that for every route.
    return stops.filter((stop) =>
      stopMaybeActive(stop.id, now, urbanLookaheadHours, raptorIndex, feedTz, activityWindow),
    );
  }, [stops, stopCityId, cityId, urbanMode, urbanLookaheadHours, raptorIndex, minuteBucket, feedTz]);

  // Stage 2 — tile-sourced badge narrowing. O(visible) Map lookups + line
  // filters; this is the only part that re-runs when the badge sweep settles.
  return useMemo(() => {
    if (!urbanMode) return indexVisible;

    const visible: StopWithLines[] = [];
    for (const stop of indexVisible) {
      const matchesContext = activityContext === null || activityContext === expectedContext;
      const age = minuteBucket * FILTER_TICK_MS - (resolvedAt.get(stop.id) ?? 0);
      const activity = matchesContext && age < BADGE_ACTIVITY_HOLD_MS
        ? activityByStop.get(stop.id)
        : undefined;

      // UNCOVERED-stop tile-authoritative serviceless hide: when the index
      // cannot decide the stop (`stopMaybeActive` fails open on the
      // structural, time-invariant "return-only for some route" property), a
      // resolved tile verdict of NO in-window routes is the only serviceless
      // signal — drop the stop entirely (dot + card), BEFORE the no-lines
      // short-circuit, so the night map doesn't flood with name-only cards.
      //
      // For a pattern-covered stop this hide is DISABLED: the index already
      // dropped provably-serviceless stops above, so an index-active stop
      // with a ready+EMPTY tile verdict is generation skew — hiding on it
      // would re-couple visibility to the viewport-transient tile sweep
      // (computed only at card zoom, evicted on pan), which is what made
      // stops blip in/out with zoom. The stop stays; badges narrow to none.
      if (
        activity &&
        activity.state === "ready" &&
        activity.routeIds.size === 0 &&
        (!raptorIndex || !stopActivityDecidable(stop.id, raptorIndex))
      ) continue;

      // Stops cached without an enriched `lines` array (e.g. nearby-stops
      // responses not yet touched by departure data) keep their identity —
      // there are no per-route badges to narrow.
      if (!stop.lines || stop.lines.length === 0) {
        visible.push(stop);
        continue;
      }

      // A pending or failed read cannot establish which routes run soon.
      // Keep the name/dot while withholding speculative badges.
      if (!activity || activity.state !== "ready") {
        visible.push({ ...stop, lines: [] });
        continue;
      }

      // "ready" (non-empty): narrow to the authoritative tile route set,
      // preserving order.
      const { routeIds } = activity;
      const filtered = stop.lines.filter((l) => routeIds.has(l.routeId));
      // Preserve identity when nothing is removed so memoized consumers don't
      // re-render.
      if (filtered.length === stop.lines.length) visible.push(stop);
      else visible.push({ ...stop, lines: filtered });
    }
    return visible;
  }, [indexVisible, urbanMode, raptorIndex, activityByStop, activityContext, expectedContext, resolvedAt, minuteBucket]);
}
