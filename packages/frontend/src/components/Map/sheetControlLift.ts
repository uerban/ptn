import type * as maplibregl from "maplibre-gl";
import { useMapObstaclesStore, type ObstacleRect } from "../../stores/mapObstaclesStore.ts";

/** Bottom sheets the bottom-right map controls ride on top of. */
export const SHEET_OBSTACLE_IDS = ["departure-sheet", "trip-sheet"] as const;

/** Space kept free above the controls (search bar, chips at the top), in px. */
const TOP_CLEARANCE = 120;

interface Box {
  top: number;
  bottom: number;
}

export interface ControlLift {
  /** padding-bottom for `.maplibregl-ctrl-bottom-right`. */
  lift: number;
  /** Hide the controls: the sheet leaves no room for them. */
  hidden: boolean;
}

/**
 * Where the bottom-right controls go while a bottom sheet is open: right on
 * top of the sheet's real edge (peek / half / full, and every frame of its
 * height transition), not a fixed mid-screen offset. When the sheet is
 * expanded so far that the control column no longer fits below the top
 * overlays, the controls hide until it shrinks again.
 */
export function controlLift(
  map: Box,
  sheets: readonly Box[],
  controlsHeight: number,
): ControlLift {
  const sheetTop = sheets.reduce((min, s) => Math.min(min, s.top), Infinity);
  if (!Number.isFinite(sheetTop) || sheetTop >= map.bottom) return { lift: 0, hidden: false };
  const lift = map.bottom - sheetTop;
  const room = sheetTop - map.top - TOP_CLEARANCE;
  return { lift, hidden: room < controlsHeight };
}

/**
 * Keeps the bottom-right controls on top of whichever bottom sheet is open,
 * fed by the sheets' `MapObstacle` rects (already tracked through
 * ResizeObserver). Unsubscribes when the map is removed.
 */
export function trackSheetControlLift(
  map: Pick<maplibregl.Map, "getContainer" | "once">,
): void {
  const container = map.getContainer();
  const corner = container.querySelector<HTMLElement>(".maplibregl-ctrl-bottom-right");
  if (!corner) return;

  const apply = (obstacles: ReadonlyMap<string, ObstacleRect>) => {
    const sheets = SHEET_OBSTACLE_IDS.flatMap((id) => {
      const rect = obstacles.get(id);
      return rect ? [rect] : [];
    });
    // Natural height of the control column, without the lift itself.
    const controlsHeight = [...corner.children].reduce(
      (sum, el) => sum + (el as HTMLElement).offsetHeight + 10,
      0,
    );
    const { lift, hidden } = controlLift(
      container.getBoundingClientRect(),
      sheets,
      controlsHeight,
    );
    corner.style.paddingBottom = lift > 0 ? `${lift}px` : "";
    corner.style.visibility = hidden ? "hidden" : "";
  };

  apply(useMapObstaclesStore.getState().obstacles);
  const unsubscribe = useMapObstaclesStore.subscribe((state, prev) => {
    if (state.obstacles !== prev.obstacles) apply(state.obstacles);
  });
  map.once("remove", unsubscribe);
}
