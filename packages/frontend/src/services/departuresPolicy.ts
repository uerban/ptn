import { getPolicy } from "../stores/privacyStore.ts";

/**
 * True when a backend GET /departures query (which reveals the EXACT tapped stop — a
 * fine-grained leak, unlike the coarse whole-cell tile) is permitted. Imperative getPolicy()
 * read BY DESIGN — called only from async fetch paths, never render. Callers re-check at
 * hedge-fire time (policy can change between fetch start and timer fire).
 */
export function backendDeparturesAllowed(): boolean {
  return getPolicy().realTimePolling !== "disabled-schedule-only";
}

/** True when a schedule tile's live overlay (the rt-tile GET) may be fetched.
 *  The schedule-only level promises no live data, so every tile read (stop
 *  popup, departure sheet, map strip) is then the timetable alone. Same
 *  imperative, fetch-path-only getPolicy() read as above. */
export function liveTileOverlayAllowed(): boolean {
  return getPolicy().realTimePolling !== "disabled-schedule-only";
}
