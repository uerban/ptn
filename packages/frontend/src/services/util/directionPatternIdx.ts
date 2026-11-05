import type { RouteDirectionPattern } from "@pt/shared";
import type { RaptorIndexRoute } from "../raptorIndex.ts";

export interface FindStopIdxResult {
  idx: number;
  pattern: RouteDirectionPattern | null;
}

// Locate `stopId` in a route, falling back to per-direction patterns when
// the canonical `stopIds` does not contain it. Bidirectional routes whose
// return-direction stop_ids differ from the canonical (longest-trip)
// sequence — e.g. opposite-side-of-road siblings — only appear in
// `directionPatterns`. Callers that key off `stopIds.indexOf` alone hide
// these stops; this helper restores them. Returns `pattern: null` when the
// canonical sequence matched (the historical fast path), otherwise the
// matching pattern so callers can pick its sequence/headsign/terminal.
export function findStopIdxInRoute(
  route: Pick<RaptorIndexRoute, "stopIds" | "directionPatterns">,
  stopId: string,
): FindStopIdxResult {
  const canonical = route.stopIds.indexOf(stopId);
  if (canonical >= 0) return { idx: canonical, pattern: null };

  for (const pattern of route.directionPatterns ?? []) {
    const idx = pattern.stopIds.indexOf(stopId);
    if (idx >= 0) return { idx, pattern };
  }

  return { idx: -1, pattern: null };
}
