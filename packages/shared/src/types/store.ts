import type { TransportMode, LatLon } from "./transit.js";

/**
 * Precomputed map-label anchor: the side of a stop's dot its name label sits on.
 * Produced by the backend label-placement solver
 * (`packages/backend/src/gtfs/labelAnchors.ts`) so the renderer can place labels
 * without runtime collision search. The union order is the solver's `DIRS` index
 * basis — keep it in sync there.
 */
export type LabelAnchor =
  | "right"
  | "top-right"
  | "top"
  | "top-left"
  | "left"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

/** Line/route info cached from departure data */
export interface LineInfo {
  routeId: string;
  shortName: string;
  color?: string;
  mode: TransportMode;
  subMode?: string;
}

/** A stop enriched with cached line data */
export interface StopWithLines {
  id: string;
  name: string;
  location: LatLon;
  parentStationId?: string;
  lines?: LineInfo[];
  /** Precomputed label anchor from the backend solver; absent ⇒ renderer default. */
  labelAnchor?: LabelAnchor;
  lastSeen: number; // timestamp ms
}

/** Usage tracking for preload priority */
export interface UsageStat {
  stopId: string;
  tapCount: number;
  lastTapped: number; // timestamp ms
}
