import { create } from "zustand";

/** Lat/lon bounds of the current map viewport. */
export interface MapViewportBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * Grid step (degrees) the published viewport is snapped to. ~110 m N–S — small
 * enough that the snapped viewport never looks stale, large enough that a tiny
 * pan stays inside one cell. Fixed (not viewport-proportional) so the grid is
 * FP-stable: two nearby edges in the same cell map to the same integer index,
 * hence a bit-identical snapped coordinate. The slack it introduces is well
 * inside the badge sweep's VIEWPORT_BUFFER, so coverage never suffers.
 */
export const VIEWPORT_QUANTIZE_STEP_DEG = 0.001;

/**
 * Snap viewport bounds OUTWARD to the {@link VIEWPORT_QUANTIZE_STEP_DEG} grid.
 *
 * `useViewportBadgeActivity` keys its effect on the published bounds, so an
 * un-snapped viewport re-ran the whole tile sweep + activity recompute on every
 * sub-pixel `moveend` — the "recalc all the time" churn (and a fresh activity
 * Map each time, which re-derived `useVisibleStops`). Snapping makes a sub-cell
 * pan produce identical primitive deps → no effect re-run. A pan that actually
 * crosses a grid line still recomputes. Rounding is outward (north/east up,
 * south/west down) so the snapped bounds are always a superset of the real
 * viewport — coverage is never lost.
 */
export function quantizeViewportBounds(b: MapViewportBounds): MapViewportBounds {
  const step = VIEWPORT_QUANTIZE_STEP_DEG;
  return {
    north: Math.ceil(b.north / step) * step,
    south: Math.floor(b.south / step) * step,
    east: Math.ceil(b.east / step) * step,
    west: Math.floor(b.west / step) * step,
  };
}

interface MapViewportState {
  bounds: MapViewportBounds | null;
  zoom: number | null;
  setViewport: (bounds: MapViewportBounds, zoom: number) => void;
}

/** Published by TransitMap on load + moveend; read by useViewportBadgeActivity. */
export const useMapViewportStore = create<MapViewportState>()((set) => ({
  bounds: null,
  zoom: null,
  setViewport: (bounds, zoom) => set({ bounds, zoom }),
}));
