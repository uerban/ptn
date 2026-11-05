import type { RaptorIndexRoute } from "./raptorIndex.ts";
import { findStopIdxInRoute } from "./util/directionPatternIdx.ts";

export interface DirectionLabel {
  /** Direction description, e.g., "toward Oliwa" */
  label: string;
  /** Route short names going in this direction */
  routeLabels: string[];
  /** Route colors for badge display */
  routeColors: (string | undefined)[];
}

/**
 * The one direction pattern that serves `stopId`, or `undefined` when the stop
 * is served by several (or the route carries no patterns).
 *
 * `findStopIdxInRoute` answers `pattern: null` whenever the stop is on the
 * route's CANONICAL sequence, which sends the caller to `trips[0]`'s headsign.
 * That is fine for a stop both directions call at, but the canonical sequence
 * is the LONGEST pattern (`aggregateDisplay`), so on a bidirectional route the
 * canonical is usually the return leg — return-only stops are ON it. The
 * caller would then label such a stop with the first trip of the merged
 * route, which is whichever direction departs earliest: typically the outbound
 * one that never stops there.
 *
 * Checking the patterns directly is what makes the label describe the service
 * the rider can actually board. Only an unambiguous answer overrides the trip
 * fallback: when both directions call at a stop there is no single correct
 * headsign, and `trips[0]` remains the established choice.
 */
function soleDirectionServing(
  route: RaptorIndexRoute,
  stopId: string,
): { headsign: string; stopIds: string[] } | undefined {
  const patterns = route.directionPatterns ?? [];
  if (patterns.length === 0) return undefined;
  const serving = patterns.filter((p) => p.stopIds.includes(stopId));
  return serving.length === 1 ? serving[0] : undefined;
}

export function resolveDirections(
  stopId: string,
  raptorIndex: { routes: RaptorIndexRoute[]; routesAtStop: Map<string, number[]> },
  stopNames: Map<string, string>,
): DirectionLabel[] {
  const routeIndices = raptorIndex.routesAtStop.get(stopId);
  if (!routeIndices || routeIndices.length === 0) {
    return [];
  }

  const grouped = new Map<string, { routeLabels: string[]; routeColors: (string | undefined)[] }>();

  for (const idx of routeIndices) {
    const route = raptorIndex.routes[idx];
    if (!route) continue;

    // Pick the direction-specific sequence/headsign when the stop is only
    // served by a return-direction pattern (return-only stop on a bidirectional
    // route). Otherwise fall through to canonical stopIds + first trip's
    // headsign for legacy and unidirectional routes.
    //
    // Branch on `pattern` rather than `pattern?.headsign || ...`: an empty
    // pattern headsign (legal in GTFS when only the terminal name is
    // populated) must NOT fall through to the first trip's headsign — the
    // first trip is typically the outbound direction, so doing so would
    // silently re-leak the outbound label at a return-only stop. An empty
    // matched-pattern headsign means "use the matched pattern's terminal",
    // which the `if (headsign)` check below routes through correctly.
    const { pattern } = findStopIdxInRoute(route, stopId);
    const serving = pattern ?? soleDirectionServing(route, stopId);
    const headsign = serving ? serving.headsign : route.trips[0]?.headsign;
    let label: string;

    if (headsign) {
      label = headsign;
    } else {
      const seq = pattern ? pattern.stopIds : route.stopIds;
      const terminalStopId = seq[seq.length - 1];
      label = stopNames.get(terminalStopId ?? "") ?? terminalStopId ?? "";
    }

    const existing = grouped.get(label);
    if (existing) {
      existing.routeLabels.push(route.shortName);
      existing.routeColors.push(route.color);
    } else {
      grouped.set(label, {
        routeLabels: [route.shortName],
        routeColors: [route.color],
      });
    }
  }

  return Array.from(grouped.entries()).map(([label, { routeLabels, routeColors }]) => ({
    label,
    routeLabels,
    routeColors,
  }));
}
