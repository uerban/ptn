/**
 * Whether the one-time detailed-maps question has been answered, here or in
 * setup. Public UI state in localStorage; survives reloads. Kept apart from
 * the map code so setup can write it without loading the map.
 */
export const MAP_DETAIL_ASKED_KEY = "ptn-map-detail-asked";

export function readMapDetailAsked(): boolean {
  try {
    return globalThis.localStorage?.getItem(MAP_DETAIL_ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember the answer. Storage unavailable: asked again on the next load only. */
export function markMapDetailAsked(): void {
  try {
    globalThis.localStorage?.setItem(MAP_DETAIL_ASKED_KEY, "1");
  } catch {
    // Not remembered beyond this page.
  }
}
