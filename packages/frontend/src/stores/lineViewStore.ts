import { create } from "zustand";
import type { LatLon } from "@pt/shared";

/** A stop along a line route, with its position */
export interface LineStop {
  id: string;
  name: string;
  location: LatLon;
}

/** A direction/pattern of a line route */
export interface LinePattern {
  directionId: number; // 0 or 1
  headsign: string;
  stops: LineStop[];
  /**
   * Best-effort GTFS `shape_id` for the representative trip of this
   * pattern. When present, `LineRouteOverlay` renders the road-following
   * polyline from `gtfsShapes`; absent → falls back to the stop-chord.
   */
  shapeId?: string;
  /**
   * GTFS `direction_id` of this pattern's trips, when they carry one; absent
   * otherwise. (`directionId` above is the pattern's place in the list, not
   * this field.) Opposite directions may share `headsign`; this tells them
   * apart: https://gtfs.org/documentation/schedule/reference/#tripstxt
   */
  gtfsDirectionId?: 0 | 1;
}

interface LineViewState {
  /** Currently displayed route ID (null = nothing shown) */
  activeRouteId: string | null;
  /** Route short name for display */
  activeRouteShortName: string | null;
  /** Route color (hex without #) */
  activeRouteColor: string | null;
  /** Current direction index (0 or 1) */
  activeDirection: number;
  /** Available patterns for the active route */
  patterns: LinePattern[];
  /** Whether the line view overlay is visible */
  isVisible: boolean;

  /** Show a line on the map with its patterns */
  showLine: (
    routeId: string,
    shortName: string,
    color: string | null,
    patterns: LinePattern[],
    initialDirection?: number,
  ) => void;
  /** Hide the line view overlay */
  hideLine: () => void;
  /** Toggle between direction 0 and 1 */
  toggleDirection: () => void;
  /** Set a specific direction */
  setDirection: (dir: number) => void;
}

export const useLineViewStore = create<LineViewState>((set, get) => ({
  activeRouteId: null,
  activeRouteShortName: null,
  activeRouteColor: null,
  activeDirection: 0,
  patterns: [],
  isVisible: false,

  showLine(routeId, shortName, color, patterns, initialDirection) {
    set({
      activeRouteId: routeId,
      activeRouteShortName: shortName,
      activeRouteColor: color,
      activeDirection: initialDirection ?? 0,
      patterns,
      isVisible: true,
    });
  },

  hideLine() {
    set({
      activeRouteId: null,
      activeRouteShortName: null,
      activeRouteColor: null,
      activeDirection: 0,
      patterns: [],
      isVisible: false,
    });
  },

  toggleDirection() {
    const { patterns, activeDirection } = get();
    if (patterns.length <= 1) return;
    set({ activeDirection: (activeDirection + 1) % patterns.length });
  },

  setDirection(dir) {
    const { patterns } = get();
    if (dir < 0 || dir >= patterns.length) return;
    set({ activeDirection: dir });
  },
}));
