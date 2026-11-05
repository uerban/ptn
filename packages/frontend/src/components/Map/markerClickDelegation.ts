// Marker-click delegation primitives.
//
// PR #171 attached a `click` listener directly to each HTML marker's
// outer `el.addEventListener(...)` — on the premise that the outer
// `.stop-marker-container` is identity-stable across the debounced
// re-render. In practice `updateMarkers`' winner-cleanup calls
// `marker.remove()` whenever a stop transiently leaves the buffered
// viewport (zoom/flyTo paths trigger this), and the per-marker
// listener disappears with `el`. Playwright sees this as
// "element was detached, retrying" in `e2e/core/stop-popup.spec.ts`;
// end users see taps that don't open the popup.
//
// The fix: a single delegated listener on the map's canvas container
// (a stable parent that survives every marker recreation), keyed by
// `data-stop-id` on each `.stop-marker-container`. Mirrors the
// approach the existing `DOT_LAYER` click handler already uses for
// the lower-zoom dot layer.

/**
 * Single source of truth for the marker container class. Used both by
 * `createStopMarkerElement` (writer side) and `findMarkerStopId`
 * (reader side / selector) so the two halves of the contract can't
 * drift via a stray rename.
 */
export const STOP_MARKER_CONTAINER_CLASS = "stop-marker-container";

/**
 * Build the outer marker element TransitMap appends to the maplibre
 * marker layer. The element carries `data-stop-id` so the delegated
 * canvas-container listener can route clicks even after `marker.remove()`
 * detaches and recreates the original instance.
 *
 * No `click` event listener is attached here on purpose — that's the
 * whole point of delegation. Adding one re-introduces PR #171's bug.
 *
 * Throws on an empty `stopId` so an upstream slipup can't silently
 * produce a marker the delegated handler then treats as untagged.
 */
export function createStopMarkerElement(stopId: string): HTMLDivElement {
  if (!stopId) {
    throw new Error("createStopMarkerElement: stopId must be non-empty");
  }
  const el = document.createElement("div");
  el.className = `${STOP_MARKER_CONTAINER_CLASS} cursor-pointer`;
  el.dataset.stopId = stopId;
  return el;
}

/**
 * Walk up from `target` to find the nearest `.stop-marker-container`
 * and return its `data-stop-id`.
 *
 * Returns `null` when the click landed outside any marker — and ALSO
 * when the click landed on a marker that's missing its tag (i.e.
 * built without `createStopMarkerElement`). The delegated handler
 * treats both cases the same: bail out silently. Keep marker creation
 * paired with this helper so an untagged marker is impossible.
 */
export function findMarkerStopId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const marker = target.closest<HTMLElement>(`.${STOP_MARKER_CONTAINER_CLASS}`);
  return marker?.dataset.stopId ?? null;
}
