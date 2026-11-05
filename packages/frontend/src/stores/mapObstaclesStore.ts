import { create } from "zustand";
import type { ObstacleRect } from "../components/Map/cardPlacement.ts";

export type { ObstacleRect };

interface MapObstaclesState {
  /**
   * Replaced wholesale on any change. `===` identity is meaningful: a stable
   * reference means no obstacle has been added, removed, or moved.
   * Subscribers may use Map identity as their change predicate. Treated as
   * read-only — never mutate the Map directly.
   */
  obstacles: ReadonlyMap<string, ObstacleRect>;
  /** Add or replace an obstacle by id. No-op (preserves Map identity) if rect is unchanged. */
  setObstacle: (id: string, rect: ObstacleRect) => void;
  /** Remove an obstacle by id. No-op (preserves Map identity) if id is absent. */
  clearObstacle: (id: string) => void;
}

function rectsEqual(a: ObstacleRect, b: ObstacleRect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * Registry of UI-overlay rectangles that float above the map. Marker placement
 * reads this to keep stop labels out from under the search bar, FavoritesBar,
 * StepList navigation pane, popups, action sheets, etc. Coordinates are
 * page-space (window-relative) — translate to canvas-relative at consumption.
 */
export const useMapObstaclesStore = create<MapObstaclesState>((set, get) => ({
  obstacles: new Map(),
  setObstacle: (id, rect) => {
    const current = get().obstacles.get(id);
    if (current && rectsEqual(current, rect)) return;
    set((state) => {
      const next = new Map(state.obstacles);
      next.set(id, rect);
      return { obstacles: next };
    });
  },
  clearObstacle: (id) =>
    set((state) => {
      if (!state.obstacles.has(id)) return state;
      const next = new Map(state.obstacles);
      next.delete(id);
      return { obstacles: next };
    }),
}));
