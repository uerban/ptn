import { canUse } from "../privacy/canUse.ts";

/** Live departures, the live tile overlay and the stop departures fallback
 * all belong to one flow. */
export const REALTIME_FLOW = "operator.realtime";

/**
 * True when a backend GET /departures query (which reveals the EXACT tapped stop — a
 * fine-grained leak, unlike the coarse whole-cell tile) is permitted. Imperative `canUse`
 * read BY DESIGN — called only from async fetch paths, never render. Callers re-check at
 * hedge-fire time (the decision can change between fetch start and timer fire).
 */
export function backendDeparturesAllowed(): boolean {
  return canUse(REALTIME_FLOW);
}

/** True when a schedule tile's live overlay (the rt-tile GET) may be fetched.
 *  Without live departures every tile read (stop popup, departure sheet, map
 *  strip) is the timetable alone. Same imperative, fetch-path-only read as
 *  above. */
export function liveTileOverlayAllowed(): boolean {
  return canUse(REALTIME_FLOW);
}
