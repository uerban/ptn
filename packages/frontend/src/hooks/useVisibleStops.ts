import { useEffect, useMemo, useState } from "react";
import type { StopWithLines } from "@pt/shared";
import { useStopStore } from "../stores/stopStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import {
  resolveActivityWindow,
  stopActivityDecidable,
  stopMaybeActive,
} from "../services/hasUpcomingDeparture.ts";
import { useBadgeActivityStore } from "../stores/badgeActivityStore.ts";

const FILTER_TICK_MS = 60_000;

/**
 * Loading-state policy for a carded stop whose tile activity hasn't resolved. "hold" → render
 * the stop with empty badges (name-only) until activity lands; "delay" → omit the stop until
 * resolved. Default "hold".
 */
const LOADING_POLICY: "hold" | "delay" = "hold";

/**
 * The list of stops to actually render on the map.
 *
 * Source of truth is `useStopStore` — the preloader keeps the full city
 * set cached there regardless of urban mode. Toggling urban mode just
 * changes how the list is derived on the render path, not what's stored.
 *
 * Behaviour:
 *   - urban mode OFF → all cached stops, untouched.
 *   - urban mode ON but the RAPTOR index isn't ready yet → all cached
 *     stops, untouched. The filter needs the timetable to answer "might
 *     this stop be active" questions; failing-open until ready is better
 *     UX than hiding everything.
 *   - urban mode ON + index ready → visibility comes from `stopMaybeActive`.
 *     For a PATTERN-COVERED stop (production per-pattern wire: every served
 *     stop — see `stopActivityDecidable`) that answer reads real
 *     pattern-column times, so it is authoritative CITY-WIDE — independent
 *     of zoom level and of which viewports the tile sweep has covered.
 *     Serviceless stops drop here at any zoom; there is no state to lose on
 *     pan/zoom (the blip regression). For an UNCOVERED stop (PatternMode.Off
 *     index, or a per-route wire's return-only stop) the answer is
 *     fail-open: a stop whose activity the index cannot determine stays
 *     visible. Each kept stop's badge lines come from the
 *     schedule-tile-sourced `badgeActivityStore` (the sheet's own engine, so
 *     badges can't diverge from the sheet):
 *       - "ready" (non-empty) → narrow `lines` to that route set (identity
 *                         preserved when nothing is removed).
 *       - "ready" (EMPTY)     → pattern-covered stop: badges narrow to none
 *                         (name-only card; the stop is index-active, so the
 *                         empty verdict is generation skew — hiding on it
 *                         would re-couple visibility to zoom). Uncovered
 *                         stop: the tile is the only serviceless authority →
 *                         hide the stop entirely (dot + card); this is what
 *                         keeps the night map from flooding with serviceless
 *                         return-only stops.
 *       - "loading"     → hold badges per `LOADING_POLICY` (default render
 *                         name-only with empty `lines`).
 *       - "unavailable" / no entry → fail open to the full `lines`.
 *
 * Ticks every minute so the visibility edge cases (a stop whose last
 * in-window trip just rolled out) refresh without user interaction.
 */
export function useVisibleStops(): StopWithLines[] {
  const stops = useStopStore((s) => s.stops);
  const urbanMode = useSettingsStore((s) => s.urbanMode);
  const urbanLookaheadHours = useSettingsStore((s) => s.urbanLookaheadHours);
  const raptorIndex = useGtfsDataStore((s) => s.raptorIndex);
  const syncing = useGtfsDataStore((s) => s.syncing);
  // Feed timezone for the active city — threaded into `stopMaybeActive` so a
  // cross-tz device places "now" on the city's wall clock (and thus the
  // correct service day) rather than its own. Without it, a foreign device
  // near its local midnight filters the wrong day's stops while the results
  // list below renders the correct day — an invisible split.
  const feedTz = useCityStore((s) => s.activeCity.tz);
  // Per-stop badge activity sourced from schedule tiles by
  // `useViewportBadgeActivity`. Read here so the memo re-runs when it changes.
  const activityByStop = useBadgeActivityStore((s) => s.byStop);

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
    if (!urbanMode) return stops;
    if (!raptorIndex || syncing) return stops;

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
  }, [stops, urbanMode, urbanLookaheadHours, raptorIndex, syncing, minuteBucket, feedTz]);

  // Stage 2 — tile-sourced badge narrowing. O(visible) Map lookups + line
  // filters; this is the only part that re-runs when the badge sweep settles.
  return useMemo(() => {
    if (!urbanMode) return indexVisible;
    if (!raptorIndex || syncing) return indexVisible;

    const visible: StopWithLines[] = [];
    for (const stop of indexVisible) {
      const activity = activityByStop.get(stop.id);

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
        !stopActivityDecidable(stop.id, raptorIndex)
      ) continue;

      // Stops cached without an enriched `lines` array (e.g. nearby-stops
      // responses not yet touched by departure data) keep their identity —
      // there are no per-route badges to narrow.
      if (!stop.lines || stop.lines.length === 0) {
        visible.push(stop);
        continue;
      }

      // No entry or explicitly unavailable → fail open to full lines.
      if (!activity || activity.state === "unavailable") {
        visible.push(stop);
        continue;
      }
      if (activity.state === "loading") {
        // Tile activity hasn't resolved yet. Default policy holds the stop
        // with empty badges (name-only) so the card doesn't blink away.
        if (LOADING_POLICY === "delay") continue;
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
  }, [indexVisible, urbanMode, raptorIndex, syncing, activityByStop]);
}
