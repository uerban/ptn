import type * as maplibregl from "maplibre-gl";

export const ATTRIBUTION_SEEN_STORAGE_KEY = "ptn.attributionSeen";

type AttributionMap = Pick<maplibregl.Map, "on" | "off" | "once" | "getContainer">;
type FlagStorage = Pick<Storage, "getItem" | "setItem">;

const EXPANDED_SELECTOR = ".maplibregl-ctrl-attrib.maplibregl-compact-show";

/**
 * On narrow maps (<= 640px) MapLibre switches the attribution to its compact
 * (i) form, expands it the first time it has text to show, and only collapses
 * it on the first drag, so every phone PWA launch opened with the credits
 * covering the map corner. Wide maps keep MapLibre's full inline text.
 *
 * Show it expanded on the first launch only, until the rider's first
 * interaction anywhere in the app (pan, tap a stop, label or chip, type in
 * search), and remember that so later launches start collapsed behind the (i)
 * button. Taps on the attribution itself don't count. Once collapsed, MapLibre
 * never re-expands it on its own, so the rider's own toggles are left alone.
 *
 * Storage-injected so the first-launch / later-launch paths are unit-testable
 * (the live call in `TransitMap` passes `localStorage`).
 */
export function installAttributionAutoHide(
  map: AttributionMap,
  storage: FlagStorage | undefined,
): void {
  let stopWatching: (() => void) | undefined;

  const markSeen = () => {
    try {
      storage?.setItem(ATTRIBUTION_SEEN_STORAGE_KEY, "1");
    } catch {
      // Private mode / quota: worst case the credits show once more next launch.
    }
  };

  const seenBefore = () => {
    try {
      return storage?.getItem(ATTRIBUTION_SEEN_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  };

  const onData = () => {
    const attrib = map.getContainer().querySelector(EXPANDED_SELECTOR);
    if (!attrib) return;
    map.off("styledata", onData);
    map.off("sourcedata", onData);
    map.off("resize", onData);
    if (seenBefore()) {
      attrib.classList.remove("maplibregl-compact-show");
      return;
    }
    // Capture phase on the document: stop labels, chips and sheets are DOM
    // overlays outside the map canvas, and some stop propagation.
    const doc = map.getContainer().ownerDocument;
    const onInteract = (e: Event) => {
      if (e.target instanceof Node && attrib.contains(e.target)) return;
      stopWatching?.();
      attrib.classList.remove("maplibregl-compact-show");
      markSeen();
    };
    doc.addEventListener("pointerdown", onInteract, true);
    doc.addEventListener("keydown", onInteract, true);
    stopWatching = () => {
      stopWatching = undefined;
      doc.removeEventListener("pointerdown", onInteract, true);
      doc.removeEventListener("keydown", onInteract, true);
    };
  };

  map.on("styledata", onData);
  map.on("sourcedata", onData);
  // A wide map turning narrow (rotation, window resize) expands it too.
  map.on("resize", onData);
  map.once("remove", () => stopWatching?.());
}
